import { existsSync } from "node:fs";
import { SQL } from "bun";
import { type Cluster, socketPath, startCluster } from "./cluster.ts";
import { FIXTURE_SCHEMA, type PgSchemaSource, pgSchema } from "./schema-source.ts";

/**
 * `freshDb()` for Postgres (325).
 *
 * ── What this had to beat ───────────────────────────────────────────────────────────────────────────
 *
 * SQLite's `freshDb()` is NOT free, which is the first thing worth knowing: measured on this machine it
 * costs 11.6ms per call, and the suite calls it (or `freshDbPath()`) about 1,100 times, so ~12.8s of the
 * cli suite's 81s is already database setup. That is the number a Postgres harness has to be judged
 * against -- not against zero.
 *
 * ── What was measured, on a fixture schema the same shape as the real one (73 tables) ────────────────
 *
 *   mechanism                                        per database   x1100 acquisitions
 *   ------------------------------------------------ -------------- ------------------
 *   SQLite freshDb() (today's baseline)                     11.60ms             12.76s
 *   PGlite, fresh in-memory instance + DDL                 356.70ms            392.4s
 *   PGlite, fresh instance from a dumped template           58.50ms             64.4s
 *   CREATE DATABASE .. TEMPLATE (wal_log)                  114.70ms            126.2s
 *   CREATE DATABASE .. TEMPLATE (file_copy)                 89.83ms             98.8s
 *   CREATE SCHEMA per test + DDL replay                     60.80ms             66.9s
 *   TRUNCATE every table between tests                      60.60ms             66.7s
 *   CREATE TABLE .. (LIKE .. INCLUDING ALL) per schema      63.30ms             69.6s
 *   pooled db + TRUNCATE only the DIRTIED tables (3)         2.75ms              3.03s  <-- chosen
 *   pooled db + TRUNCATE only the DIRTIED tables (0)         0.27ms              0.30s  <-- chosen
 *
 * Everything that builds a database per test lands between 60ms and 115ms, i.e. it turns 12.8s of setup
 * into 60-100s and makes the gate something nobody wants to run. The one mechanism that does not is
 * reusing a POOL of already-migrated databases and resetting only what a test actually wrote.
 *
 * Transaction-rollback isolation was also measured -- 0.5ms, the fastest of all -- and REJECTED. Bun's SQL
 * client does not nest a `begin()` inside a manually-issued `BEGIN`; it emits a real COMMIT, which commits
 * the outer transaction too (measured: after the harness's ROLLBACK, the test's rows were still there). So
 * any code under test that opens a transaction silently escapes the isolation. `ob` opens transactions all
 * over, `applyMigrations` most of all, so this would have failed quietly rather than loudly.
 *
 * ── How the reset knows what to truncate ─────────────────────────────────────────────────────────────
 *
 * `pg_stat_all_tables` counts inserts/updates/deletes per table. Its counters are throttled by up to a
 * second, so reading them straight after a write finds nothing (measured: the first reset failed); a
 * `pg_stat_force_next_flush()` first makes them exact for this backend. The direction of any residual
 * error is safe: a table over-counted is truncated needlessly, and the counters cannot under-count writes
 * this backend has committed.
 *
 * A write made by a DIFFERENT backend -- a spawned `ob` -- is flushed on that backend's exit, which the
 * harness cannot rely on having happened. So reading `.url` (the only way to hand this database to a
 * subprocess) marks the lease, and a marked lease resets by truncating EVERY table instead. A test that
 * wants no sharing at all takes `freshPgDatabase()` and gets a database of its own.
 *
 * ── One-time cost ────────────────────────────────────────────────────────────────────────────────────
 *
 *   initdb 580ms + postmaster start 42ms + template build 108ms + one pooled db per slot (~90ms each).
 *
 * All of it is LAZY: a test run that never asks for a Postgres database never starts a postmaster, so the
 * existing SQLite suite pays nothing.
 */

const POOL_SIZE = Number(process.env.OMNISLASH_TEST_PG_POOL ?? 4);
const TEMPLATE_DB = "ob_template";

interface PooledDb {
  name: string;
  sql: SQL;
  busy: boolean;
}

/**
 * How a released pooled database is emptied again.
 *
 * `stats` is 325's reset: trust this backend's statistics unless the lease was handed to a second
 * connection, and then truncate every table. Kept for the fixture schema, whose cost table above it was
 * measured against.
 *
 * `probe` is OB-2022's, for the real schema, where every test opens a store on a second connection: end
 * that connection's backends, then ask the database itself which tables hold a row and which sequences were
 * used, and empty only those. It needs no statistics, so it is exact whoever wrote.
 */
type ResetMode = "stats" | "probe";

interface SchemaPool {
  /** The pre-migrated template every database in this pool is copied from. Named after the schema's `id`. */
  templateDb: string;
  /** Every table in the schema, for the conservative reset. */
  allTables: string[];
  /** One query answering "which tables hold a row?" (probe mode). */
  probeSql: string;
  /** A fingerprint of the template's schema (SHAPE_SQL), so a reset can tell a test changed it. */
  shape: string;
  /** Tables the template already holds rows in (probe mode): kept, and checked unchanged on reset. */
  seeded: string[];
  seededCheckSql: string;
  seededExpect: string;
  /** Puts every sequence a test used back to its start, leaving the seeded tables' own alone. */
  sequenceResetSql: string;
  slots: PooledDb[];
  /** The next slot's number. Never reused: a dropped slot's name may still be held by nothing, or by a create. */
  nextSlot: number;
  reset: ResetMode;
  /** Pool databases are named `ob_test_<prefix><i>`; the fixture pool keeps 325's bare `ob_test_<i>`. */
  prefix: string;
}

interface HarnessState {
  cluster: Cluster;
  admin: SQL;
  pools: Map<string, Promise<SchemaPool>>;
  /** Pools started so far: each probe pool's prefix, taken before its first await so two never share one. */
  poolCount: number;
}

let state: HarnessState | undefined;
let starting: Promise<HarnessState> | undefined;

/** Wait for the postmaster's socket, then connect. */
async function connect(cluster: Cluster, database: string): Promise<SQL> {
  const deadline = Date.now() + 30_000;
  const sock = socketPath(cluster.socketDir);
  // Connecting before the socket exists wedges Bun's connection pool rather than throwing (measured: the
  // process hung indefinitely), so the file has to be there before the first SQL object is constructed.
  while (!existsSync(sock) && Date.now() < deadline) await Bun.sleep(10);
  let lastError: unknown;
  while (Date.now() < deadline) {
    const sql = new SQL({ adapter: "postgres", path: cluster.socketDir, database, username: "ob", max: 1 });
    try {
      await sql`SELECT 1`;
      return sql;
    } catch (err) {
      lastError = err;
      await sql.end().catch(() => {});
      await Bun.sleep(25);
    }
  }
  throw new Error(
    `could not connect to the test cluster's ${database} database: ${lastError === undefined ? "the postmaster never created its socket" : String(lastError)}\npostmaster log:\n${cluster.log().trim() || "(silent)"}`,
  );
}

async function build(): Promise<HarnessState> {
  const cluster = startCluster();
  const admin = await connect(cluster, "postgres");
  return { cluster, admin, pools: new Map(), poolCount: 0 };
}

/**
 * A fingerprint of everything a reset cannot put back: the namespaces, and in the user's namespaces every
 * relation (an index's definition, a view's), sequence option, column (type, nullability, default),
 * constraint, trigger, function (with its body) and type, and the extensions. Rows are not in it, and neither
 * are temp namespaces, which a session creates once and keeps (the reset discards their contents).
 */
const SHAPE_SQL = `WITH ns AS (SELECT oid, nspname FROM pg_namespace
                    WHERE nspname NOT IN ('pg_catalog', 'information_schema')
                      AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%')
  SELECT md5(concat_ws('/',
    (SELECT string_agg(nspname, ',' ORDER BY nspname) FROM ns),
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT format('%s.%s:%s:%s', ns.nspname, c.relname, c.relkind,
                     CASE WHEN c.relkind = 'i' THEN pg_get_indexdef(c.oid)
                          WHEN c.relkind IN ('v', 'm') THEN md5(pg_get_viewdef(c.oid)) END) AS x
         FROM pg_class c JOIN ns ON ns.oid = c.relnamespace) r),
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT format('%s:%s:%s:%s:%s:%s:%s:%s', c.relname, s.seqtypid::regtype, s.seqstart, s.seqincrement,
                     s.seqmin, s.seqmax, s.seqcache, s.seqcycle) AS x
         FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN ns ON ns.oid = c.relnamespace) r),
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT format('%s.%s:%s:%s:%s', c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
                     pg_get_expr(d.adbin, d.adrelid)) AS x
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN ns ON ns.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attnum > 0 AND NOT a.attisdropped) r),
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT format('%s:%s', co.conname, pg_get_constraintdef(co.oid)) AS x
         FROM pg_constraint co JOIN ns ON ns.oid = co.connamespace) r),
    (SELECT string_agg(t.tgname, ',' ORDER BY t.tgname) FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid JOIN ns ON ns.oid = c.relnamespace WHERE NOT t.tgisinternal),
    (SELECT string_agg(x, ',' ORDER BY x) FROM (
       SELECT format('%s(%s):%s', p.proname, pg_get_function_identity_arguments(p.oid), md5(p.prosrc)) AS x
         FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace) r),
    (SELECT string_agg(t.typname, ',' ORDER BY t.typname) FROM pg_type t JOIN ns ON ns.oid = t.typnamespace),
    (SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension))) AS shape`;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Build a schema's template, once per process; the pool's databases are copied from it on demand. */
async function buildPool(
  h: HarnessState,
  schema: PgSchemaSource,
  reset: ResetMode,
  prefix: string,
): Promise<SchemaPool> {
  // Named after the schema, so a template can never outlive the schema it was built from. The prefix goes
  // first: the cut to 60 characters can only take the end of the id, never what tells two pools apart.
  const templateDb = `${TEMPLATE_DB}_${prefix}${schema.id.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`.slice(0, 60);
  await h.admin.unsafe(`CREATE DATABASE ${templateDb}`);
  try {
    return await fillTemplate(h, schema, reset, prefix, templateDb);
  } catch (err) {
    // Not left behind: a half-built template would make the next attempt's CREATE DATABASE fail instead.
    await h.admin.unsafe(`DROP DATABASE IF EXISTS ${templateDb} WITH (FORCE)`).catch(() => {});
    throw err;
  }
}

async function fillTemplate(
  h: HarnessState,
  schema: PgSchemaSource,
  reset: ResetMode,
  prefix: string,
  templateDb: string,
): Promise<SchemaPool> {
  const tpl = await connect(h.cluster, templateDb);
  let tables: string[];
  let shape: string;
  let seeded: string[] = [];
  let seededCheckSql = "";
  let seededExpect = "";
  let sequences: { name: string; start: string }[] = [];
  try {
    await schema.apply(tpl);
    tables = ((await tpl.unsafe(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    )) as { tablename: string }[]).map((r) => r.tablename);
    shape = ((await tpl.unsafe(SHAPE_SQL)) as { shape: string }[])[0]!.shape;
    if (reset === "probe" && tables.length > 0) {
      // Tables the template already has rows in (the real schema's migration ledger) are not emptied: the
      // reset checks they still hold exactly what the template gave them, and their sequences are left alone.
      seeded = ((await tpl.unsafe(probeQuery(tables))) as { t: string }[]).map((r) => r.t);
      if (seeded.length > 0) {
        seededCheckSql = `SELECT ${seeded
          .map((t) => `(SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) FROM ${quoteIdent(t)} x)`)
          .join(" || '/' || ")} AS fingerprint`;
        seededExpect = ((await tpl.unsafe(seededCheckSql)) as { fingerprint: string }[])[0]!.fingerprint;
      }
      // Every sequence the template has not used, so a reset can put each back to exactly that state. The
      // seeded tables' own (already used here) are left alone, like their rows.
      sequences = ((await tpl.unsafe(
        `SELECT format('%I.%I', schemaname, sequencename) AS name, start_value::text AS start
           FROM pg_sequences WHERE last_value IS NULL ORDER BY 1`,
      )) as { name: string; start: string }[]);
    }
  } finally {
    await tpl.end();
  }
  // A template nobody can connect to is a template CREATE DATABASE can always copy.
  await h.admin.unsafe(`UPDATE pg_database SET datistemplate = true WHERE datname = '${templateDb}'`);
  const emptied = tables.filter((t) => !seeded.includes(t));
  return {
    templateDb,
    allTables: tables,
    probeSql: emptied.length > 0 ? probeQuery(emptied) : "",
    shape,
    seeded,
    seededCheckSql,
    seededExpect,
    sequenceResetSql: sequenceResetQuery(sequences),
    slots: [],
    nextSlot: 0,
    reset,
    prefix,
  };
}

/**
 * One statement putting back every sequence that has moved from its start. Read from each sequence's own
 * row, not `pg_sequences.last_value`: that is NULL for a sequence a test `setval(..., false)`'d to some other
 * value (the exporter does), which would then be skipped and hand the next test the wrong first id.
 */
function sequenceResetQuery(sequences: { name: string; start: string }[]): string {
  if (sequences.length === 0) return "";
  return `SELECT setval(x.s::regclass, x.st, false) FROM (${sequences
    .map(
      (q) =>
        `SELECT ${quoteLiteral(q.name)} AS s, ${q.start}::bigint AS st FROM ${q.name} WHERE is_called OR last_value <> ${q.start}`,
    )
    .join(" UNION ALL ")}) x`;
}

/** One statement naming every table that holds at least one row. */
function probeQuery(tables: string[]): string {
  return tables
    .map((t) => `SELECT ${quoteLiteral(t)} AS t WHERE EXISTS (SELECT 1 FROM ${quoteIdent(t)})`)
    .join(" UNION ALL ");
}

/** Forget the current cluster without touching it, so the next acquisition builds a fresh one. */
function invalidate(): void {
  state = undefined;
  starting = undefined;
  leased.clear();
}

async function harness(): Promise<HarnessState> {
  if (state) return state;
  starting ??= build().then((s) => {
    state = s;
    return s;
  });
  return await starting;
}

async function poolFor(h: HarnessState, schema: PgSchemaSource): Promise<SchemaPool> {
  let pool = h.pools.get(schema.id);
  if (!pool) {
    const reset: ResetMode = schema === FIXTURE_SCHEMA ? "stats" : "probe";
    h.poolCount += 1;
    pool = buildPool(h, schema, reset, reset === "stats" ? "" : `${h.poolCount}_`);
    h.pools.set(schema.id, pool);
    // A failed build is not cached: the next caller gets the real error again rather than a dead promise.
    pool.catch(() => {
      if (h.pools.get(schema.id) === pool) h.pools.delete(schema.id);
    });
  }
  return await pool;
}

/** What a SECOND connection to a test database needs: Bun's SQL client cannot parse a unix-socket URL. */
export interface PgConnectionOptions {
  adapter: "postgres";
  path: string;
  database: string;
  username: string;
}

export interface PgLease {
  /** The connection the test works through. */
  readonly sql: SQL;
  /** The database's name inside the throwaway cluster. */
  readonly name: string;
  /**
   * A libpq connection URL, for handing this database to a SUBPROCESS.
   *
   * Bun's own SQL client cannot parse a unix-socket URL in any of its three spellings (measured), so an
   * in-process second connection takes `options` instead. Both accessors mark the lease: another backend's
   * writes are not reliably visible in this one's statistics, so the reset stops trusting them and
   * truncates every table.
   */
  readonly url: string;
  readonly options: PgConnectionOptions;
  release(): Promise<void>;
}

const leased = new Set<() => Promise<void>>();

export interface FreshPgDbOptions {
  /**
   * The schema the database carries. Default: the harness's current one (`pgSchema()`, 325's fixture),
   * reset the 325 way. Pass `REAL_SCHEMA` (real-schema.ts) for the real migration chain; that pool is
   * reset by probing (see `ResetMode`), and is what `leaseRealPgDb()` there hands out.
   */
  schema?: PgSchemaSource;
}

/** A schema change a pooled database cannot undo. The slot is dropped; the cluster stays. */
class PooledSchemaChanged extends Error {}

/**
 * A Postgres database with the schema already in it, isolated from every other test.
 *
 * The `freshDb()` equivalent, and the one to reach for by default. The database is leased from a pool and
 * returned when the test ends -- `installPgTestHooks()` releases anything a test forgot -- so the cost is
 * the reset (0.3ms clean, ~2.8ms after three tables were written), not a `CREATE DATABASE`.
 *
 * Isolation is a whole Postgres DATABASE per concurrent test, not a schema and not a transaction: two
 * tests holding leases cannot query each other's rows even deliberately, because a Postgres connection
 * cannot cross a database boundary.
 *
 * Pool databases are created on demand, up to `OMNISLASH_TEST_PG_POOL` per schema: a file whose tests run one
 * at a time only ever creates one.
 */
export async function freshPgDb(opts: FreshPgDbOptions = {}): Promise<PgLease> {
  const h = await harness();
  const schema = opts.schema ?? pgSchema();
  const pool = await poolFor(h, schema);
  const deadline = Date.now() + 30_000;
  let slot: PooledDb | undefined;
  for (;;) {
    slot = pool.slots.find((p) => !p.busy);
    if (slot) break;
    if (pool.slots.length < POOL_SIZE) {
      // Claimed before the first await, so a concurrent lease cannot take the same new slot.
      const name = `ob_test_${pool.prefix}${pool.nextSlot++}`;
      const placeholder: PooledDb = { name, sql: undefined as unknown as SQL, busy: true };
      pool.slots.push(placeholder);
      try {
        await h.admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${pool.templateDb} STRATEGY file_copy`);
        placeholder.sql = await connect(h.cluster, name);
      } catch (err) {
        pool.slots.splice(pool.slots.indexOf(placeholder), 1);
        await h.admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
        throw err;
      }
      slot = placeholder;
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no free test database after 30s; raise OMNISLASH_TEST_PG_POOL (currently ${POOL_SIZE}) or release leases`,
      );
    }
    await Bun.sleep(5);
  }
  slot.busy = true;
  const taken = slot;

  let external = false;
  let released = false;
  const doRelease = async () => {
    if (released) return;
    released = true;
    try {
      if (pool.reset === "probe") await probeReset(h, pool, taken);
      else await resetDatabase(taken.sql, external ? pool.allTables : undefined);
    } catch (err) {
      if (err instanceof PooledSchemaChanged) throw err;
      // A reset can only fail because the cluster is gone -- bun's test runner kills spawned children when
      // a test times out, and it took the postmaster with it once. Drop the whole harness rather than hand
      // the next test a database that no longer exists; the next `freshPgDb()` builds a new cluster.
      invalidate();
      throw err;
    } finally {
      taken.busy = false;
      leased.delete(doRelease);
    }
  };
  leased.add(doRelease);

  return {
    sql: taken.sql,
    name: taken.name,
    get url(): string {
      external = true;
      return pgUrl(h.cluster.socketDir, taken.name);
    },
    get options(): PgConnectionOptions {
      external = true;
      return pgOptions(h.cluster.socketDir, taken.name);
    },
    release: doRelease,
  };
}

export interface FreshDatabaseOptions {
  /** Skip the shared template and leave the database EMPTY, for a test that builds its own schema. */
  empty?: boolean;
}

export interface PgDatabase {
  readonly sql: SQL;
  readonly name: string;
  readonly url: string;
  readonly options: PgConnectionOptions;
  drop(): Promise<void>;
}

/**
 * A database of this test's own, created fresh from the template (~90ms) rather than leased.
 *
 * For the handful of tests a pooled database cannot serve: several backends writing at once, a migration
 * applied to a deliberately-empty or deliberately-wrong database, anything that asserts on what a CRASH
 * left behind. Costly enough that it should stay a handful; correct enough that it is never the wrong
 * answer.
 */
export async function freshPgDatabase(opts: FreshDatabaseOptions = {}): Promise<PgDatabase> {
  const h = await harness();
  const template = opts.empty ? "template0" : (await poolFor(h, pgSchema())).templateDb;
  const name = `ob_own_${Bun.randomUUIDv7().replace(/-/g, "")}`.slice(0, 60);
  await h.admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${template} STRATEGY file_copy`);
  const sql = await connect(h.cluster, name);
  let dropped = false;
  const drop = async () => {
    if (dropped) return;
    dropped = true;
    await sql.end().catch(() => {});
    await h.admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    leased.delete(drop);
  };
  leased.add(drop);
  return {
    sql,
    name,
    url: pgUrl(h.cluster.socketDir, name),
    options: pgOptions(h.cluster.socketDir, name),
    drop,
  };
}

/** The libpq URL a subprocess connects with. The socket directory goes in the `host` query parameter. */
export function pgUrl(socketDir: string, database: string): string {
  return `postgresql://ob@/${database}?host=${encodeURIComponent(socketDir)}`;
}

/** The same connection, in the shape Bun's SQL client accepts for a unix socket. */
export function pgOptions(socketDir: string, database: string): PgConnectionOptions {
  return { adapter: "postgres", path: socketDir, database, username: "ob" };
}

/**
 * Empty a database again.
 *
 * With no `tables`, only the ones this backend's statistics say were written are truncated, which is what
 * makes the reset cost track what the test did rather than how big the schema is. With `tables`, every one
 * of them is truncated -- the conservative path, for when another backend may have written.
 */
async function resetDatabase(sql: SQL, tables?: string[]): Promise<void> {
  let targets = tables;
  if (!targets) {
    // Exact rather than up-to-a-second stale: without this the first reset finds nothing to do.
    await sql.unsafe(`SELECT pg_stat_force_next_flush()`);
    const dirty = (await sql.unsafe(
      `SELECT relname FROM pg_stat_all_tables
        WHERE schemaname = 'public' AND (n_tup_ins + n_tup_upd + n_tup_del) > 0`,
    )) as { relname: string }[];
    targets = dirty.map((r) => r.relname);
  }
  if (targets.length === 0) return;
  const list = targets.map((t) => `"${t.replace(/"/g, '""')}"`).join(", ");
  await sql.unsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  await sql.unsafe(`SELECT pg_stat_reset()`);
}

/**
 * Empty a pooled real-schema database again, exactly, whoever wrote to it (OB-2022).
 *
 * 1. End every other backend on the database and wait for each to exit. The test's store is one of them: a
 *    transaction it left open would block the reset, and its uncommitted rows roll back here.
 * 2. Refuse a database the reset cannot put back: a schema that no longer matches the template's (the reset
 *    empties tables, it cannot undo an ALTER), or a seeded table (the migration ledger) whose rows changed.
 *    The slot is dropped so the next lease gets a clean copy, and the release fails loudly, naming the fix
 *    (such a test takes its own database, `freshPgStore({ changesSchema: true })`).
 * 3. One query names the tables holding a row; empty those. Then put every used sequence back to its start,
 *    which also covers a table a test filled and emptied itself (no row left, identity moved on).
 *
 * Only tables that hold a row are touched, so the work tracks what the test wrote rather than the size of
 * the schema. They are emptied with DELETE, not TRUNCATE: TRUNCATE gives every table (and each of its
 * indexes) a new relation file, the small-write churn the gate could not afford, and it would cascade to
 * every empty table that references one. Measured on this desktop, per store test setup at load 4: DELETE
 * 10ms and 2 KiB of WAL, TRUNCATE of the dirty tables 21ms and 45 KiB, TRUNCATE of every table 52ms and
 * 225 KiB, against 255ms and 2.2 MiB for the old create, migrate and drop (see the OB-2022 PR).
 */
async function probeReset(h: HarnessState, pool: SchemaPool, slot: PooledDb): Promise<void> {
  const sql = slot.sql;
  // The lease's own connection outlives the lease: put its session back first, so a transaction, a
  // setting (search_path), a temp table or an advisory lock the test left on it reaches neither this
  // probe nor the next test. Not DISCARD ALL, which would drop the prepared statements Bun keeps for it.
  await sql.unsafe(`ROLLBACK`);
  await sql.unsafe(`RESET ALL; DISCARD TEMP; SELECT pg_advisory_unlock_all()`);
  const ended = (await sql.unsafe(
    `SELECT pg_terminate_backend(pid, 10000) AS ok, state, left(query, 80) AS query FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`,
  )) as { ok: boolean; state: string | null; query: string }[];
  // OB-1960: a backend ended mid-query belongs to a test that was still waiting on it when it timed out or
  // threw (or that never awaited it). Bun runs this release at once and lets the test's body carry on, so
  // that body's next await fails with "terminating connection due to administrator command" or
  // "Connection closed" and surfaces as an unhandled error BETWEEN tests, named for no test. Say whose it is.
  const midQuery = ended.filter((r) => r.ok && r.state === "active");
  if (midQuery.length > 0) {
    process.stderr.write(
      `pg harness: ended ${midQuery.length} backend(s) mid-query on ${slot.name} (${midQuery.map((r) => r.query).join("; ")}). ` +
        `The test that held them timed out, threw or did not await its query. ` +
        `A "terminating connection" or "Connection closed" error reported between tests next is that test's ` +
        `orphaned body, not a new failure.\n`,
    );
  }
  const shape = ((await sql.unsafe(SHAPE_SQL)) as { shape: string }[])[0]!.shape;
  const seeded = pool.seededCheckSql
    ? ((await sql.unsafe(pool.seededCheckSql)) as { fingerprint: string }[])[0]!.fingerprint
    : "";
  if (shape !== pool.shape || seeded !== pool.seededExpect) {
    pool.slots.splice(pool.slots.indexOf(slot), 1);
    await sql.end().catch(() => {});
    await h.admin.unsafe(`DROP DATABASE IF EXISTS ${slot.name} WITH (FORCE)`).catch(() => {});
    const what =
      shape !== pool.shape
        ? `changed the schema of pooled database ${slot.name} (schema fingerprint ${pool.shape} -> ${shape})`
        : `changed the rows the template seeds in pooled database ${slot.name} (${pool.seeded.join(", ")}: migration state)`;
    throw new PooledSchemaChanged(
      `a test ${what}; a test that changes the schema or migration state takes its own database: freshPgStore({ changesSchema: true }), or freshPgDatabase({ empty: true }) plus applyPgChain`,
    );
  }
  const dirty = pool.probeSql ? ((await sql.unsafe(pool.probeSql)) as { t: string }[]).map((r) => r.t) : [];
  if (dirty.length > 0) {
    // One transaction, one commit flush. `replica` skips the foreign-key triggers: every table that holds a
    // row is emptied here and the rest are empty already, so no reference survives to check.
    await sql.unsafe(
      `BEGIN; SET LOCAL session_replication_role = replica; ${dirty
        .map((t) => `DELETE FROM ${quoteIdent(t)};`)
        .join(" ")} COMMIT;`,
    );
  }
  if (pool.sequenceResetSql) await sql.unsafe(pool.sequenceResetSql);
}

/**
 * Have `releasePgLeases` run `release` too, for a resource a test opens on top of a lease (OB-1960): a
 * `Store`'s own client, which the lease's release resets the database under but never closes. Returns the
 * function that forgets it again, for the test that released the resource itself. `release` must be
 * idempotent; it runs after the leases tracked before it, so it sees the database already reset.
 */
export function trackPgRelease(release: () => Promise<void>): () => void {
  leased.add(release);
  return () => {
    leased.delete(release);
  };
}

/**
 * Release every outstanding lease. Registered as an `afterEach` by `installPgTestHooks()`. A lease whose test
 * changed the schema fails the test that left it, the same as a release the test made itself; any other
 * failure is the cluster going away, which the next lease recovers from.
 */
export async function releasePgLeases(): Promise<void> {
  let changed: unknown;
  for (const release of [...leased]) {
    await release().catch((err) => {
      if (err instanceof PooledSchemaChanged) changed ??= err;
    });
  }
  if (changed) throw changed;
}

/**
 * Stop the cluster and remove its tree. Registered as an `afterAll` by `installPgTestHooks()`; safe to
 * call when nothing ever started one.
 */
export async function stopPgHarness(): Promise<void> {
  let changed: unknown;
  await releasePgLeases().catch((err) => {
    changed = err;
  });
  const s = state;
  state = undefined;
  starting = undefined;
  if (!s) return;
  for (const pending of s.pools.values()) {
    const pool = await pending.catch(() => undefined);
    for (const p of pool?.slots ?? []) await p.sql?.end().catch(() => {});
  }
  await s.admin.end().catch(() => {});
  await s.cluster.stop();
  if (changed) throw changed;
}

/** True once a postmaster is actually running, so a test can assert the harness stayed lazy. */
export function pgHarnessStarted(): boolean {
  return state !== undefined;
}

/** For the teardown tests: where this process's cluster lives. */
export function pgClusterDir(): string | undefined {
  return state?.cluster.dir;
}

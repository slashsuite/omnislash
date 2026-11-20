// OB-2022 -- the pooled real-schema database. ~55 pg test files used to create a database per test, replay
// the whole migration chain into it and drop it again; under gate load that IO was the flake. They lease a
// pooled copy of one migrated template instead, and these tests prove the reset that makes it safe: whatever
// a test wrote, through whichever connection, the next lease of that database is indistinguishable from a
// fresh copy.
import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { openStore } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const PG_BUDGET = spawnBudget(3);

/** Every public table with its row count, and every sequence that has handed out a value. */
async function residue(sql: SQL): Promise<{ rows: Record<string, number>; usedSequences: string[]; tables: string[] }> {
  const tables = ((await sql.unsafe(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  )) as { tablename: string }[]).map((r) => r.tablename);
  const rows: Record<string, number> = {};
  for (const t of tables) {
    const [r] = (await sql.unsafe(`SELECT count(*)::int AS n FROM "${t}"`)) as { n: number }[];
    if (r!.n > 0) rows[t] = r!.n;
  }
  const usedSequences = ((await sql.unsafe(
    `SELECT sequencename FROM pg_sequences WHERE last_value IS NOT NULL ORDER BY sequencename`,
  )) as { sequencename: string }[]).map((r) => r.sequencename);
  return { rows, usedSequences, tables };
}

describe("the pooled real-schema database (OB-2022)", () => {
  test(
    "rows written through a second connection are gone on the next lease, and identities start at 1",
    async () => {
      const first = await leaseRealPgDb();
      const name = first.name;
      const oidOf = async (sql: SQL) =>
        ((await sql.unsafe(`SELECT oid::text AS oid FROM pg_database WHERE datname = current_database()`)) as {
          oid: string;
        }[])[0]!.oid;
      const oid = await oidOf(first.sql);
      // A copy of the template: the chain, plus the migration ledger `ob` records on its first open, and
      // nothing else.
      const pristine = await residue(first.sql);
      expect(Object.keys(pristine.rows)).toEqual(["__drizzle_migrations"]);
      expect(pristine.usedSequences).toEqual(["__drizzle_migrations_id_seq"]);

      // A store on a second connection, the way every moved test opens one.
      const store = await openStore({ kind: "postgres", connection: { ...(first.options as unknown as Record<string, unknown>), max: 2 } });
      const now = "2026-11-13T00:00:00Z";
      await store.q.insert(store.t.person).values([
        { real_name: "Ada", created_at: now, updated_at: now },
        { real_name: "Grace", created_at: now, updated_at: now },
      ]);
      await store.q.insert(store.t.event).values({ ts: now, source: "test", type: "created" });
      // Filled and emptied again: no row left to find, but its identity has moved on.
      const other = new SQL({ ...first.options, max: 1 });
      await other.unsafe(`INSERT INTO tag (name) VALUES ('a'), ('b'), ('c')`);
      await other.unsafe(`DELETE FROM tag`);
      // A parent and a child whose foreign key has no cascade (item.project_id -> project.id): emptied one by
      // one with the parent first, the parent's DELETE would fail.
      await other.unsafe(`INSERT INTO project (id, name, kind, created_at) VALUES ('p1', 'p1', 'code', 'x')`);
      await other.unsafe(
        `INSERT INTO item (id, type, title, status, project_id, created_at, updated_at)
         VALUES ('1', 'task', 'coffee', 'open', 'p1', 'x', 'x')`,
      );
      // A sequence set back to "not called" at another value, as the exporter leaves one: pg_sequences shows
      // it as never used, but its next value is 50.
      await other.unsafe(`SELECT setval('event_id_seq'::regclass, 50, false)`);
      // The lease's own connection, which outlives the lease: a setting and a temp table left on it.
      await first.sql.unsafe(`CREATE TEMP TABLE stage (x int)`);
      // A transaction left open, holding locks and a row the reset must not wait on or keep.
      const held = await other.reserve();
      await held.unsafe(`BEGIN`);
      await held.unsafe(`INSERT INTO person (real_name, created_at, updated_at) VALUES ('uncommitted', 'x', 'x')`);

      const dirty = await residue(first.sql);
      expect(dirty.rows.person).toBe(2);
      expect(dirty.rows.event).toBe(1);
      expect(dirty.usedSequences).toContain("tag_id_seq");

      // Last, since the probes above read public tables unqualified.
      await first.sql.unsafe(`SET search_path TO pg_catalog`);
      // The release ends the store's backends and the open transaction's itself.
      await first.release();
      await held.release().catch(() => {});
      await other.end().catch(() => {});
      await store.close().catch(() => {});

      const second = await leaseRealPgDb();
      try {
        // The database just released, reset in place: a new copy would pass whatever the reset did.
        expect(second.name).toBe(name);
        expect(await oidOf(second.sql)).toBe(oid);
        const [session] = (await second.sql.unsafe(
          `SELECT current_setting('search_path') AS path, to_regclass('pg_temp.stage') IS NULL AS no_temp`,
        )) as { path: string; no_temp: boolean }[];
        expect(session!.path).not.toBe("pg_catalog");
        expect(session!.no_temp).toBe(true);
        const after = await residue(second.sql);
        expect(after).toEqual(pristine);
        const [person] = (await second.sql.unsafe(
          `INSERT INTO person (real_name, created_at, updated_at) VALUES ('x', 'x', 'x') RETURNING id`,
        )) as { id: number }[];
        const [tag] = (await second.sql.unsafe(`INSERT INTO tag (name) VALUES ('x') RETURNING id`)) as { id: number }[];
        const [gapSeq] = (await second.sql.unsafe(`SELECT nextval('event_id_seq')::int AS id`)) as { id: number }[];
        expect(person!.id).toBe(1);
        expect(tag!.id).toBe(1);
        expect(gapSeq!.id).toBe(1);
      } finally {
        await second.release();
      }
    },
    PG_BUDGET,
  );

  test(
    "a test that changes the schema fails its release, and the next lease gets a clean copy",
    async () => {
      const first = await leaseRealPgDb();
      await first.sql.unsafe(`CREATE TABLE stray (id int)`);
      // A change no relation count would see: one new column on an existing table.
      const second = await leaseRealPgDb();
      await second.sql.unsafe(`ALTER TABLE person ADD COLUMN stray text`);
      let columnReason = "";
      try {
        await second.release();
      } catch (err) {
        columnReason = (err as Error).message;
      }
      expect(columnReason).toContain("changed the schema");
      // Nor would a sequence's options: the reset puts the value back, not the step.
      const third = await leaseRealPgDb();
      await third.sql.unsafe(`ALTER SEQUENCE tag_id_seq INCREMENT BY 5`);
      let sequenceReason = "";
      try {
        await third.release();
      } catch (err) {
        sequenceReason = (err as Error).message;
      }
      expect(sequenceReason).toContain("changed the schema");
      let reason = "";
      try {
        await first.release();
      } catch (err) {
        reason = (err as Error).message;
      }
      expect(reason).toContain("changed the schema");
      expect(reason).toContain("changesSchema");

      const next = await leaseRealPgDb();
      try {
        const [row] = (await next.sql.unsafe(
          `SELECT to_regclass('public.stray') IS NULL AS gone,
                  NOT EXISTS (SELECT 1 FROM information_schema.columns
                               WHERE table_name = 'person' AND column_name = 'stray') AS column_gone`,
        )) as { gone: boolean; column_gone: boolean }[];
        expect(row!.gone).toBe(true);
        expect(row!.column_gone).toBe(true);
      } finally {
        await next.release();
      }
    },
    PG_BUDGET,
  );

  test(
    "a test that changes the migration ledger fails its release too",
    async () => {
      const first = await leaseRealPgDb();
      await first.sql.unsafe(`DELETE FROM __drizzle_migrations WHERE id = (SELECT max(id) FROM __drizzle_migrations)`);
      let reason = "";
      try {
        await first.release();
      } catch (err) {
        reason = (err as Error).message;
      }
      expect(reason).toContain("migration state");

      const next = await leaseRealPgDb();
      try {
        const [row] = (await next.sql.unsafe(`SELECT count(*)::int AS n FROM __drizzle_migrations`)) as { n: number }[];
        expect(row!.n).toBeGreaterThan(0);
        const fresh = await leaseRealPgDb();
        try {
          const [ref] = (await fresh.sql.unsafe(`SELECT count(*)::int AS n FROM __drizzle_migrations`)) as { n: number }[];
          expect(row!.n).toBe(ref!.n);
        } finally {
          await fresh.release();
        }
      } finally {
        await next.release();
      }
    },
    PG_BUDGET,
  );
});

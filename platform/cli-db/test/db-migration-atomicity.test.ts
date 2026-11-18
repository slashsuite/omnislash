import { describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  applyMigrations,
  type Migration,
  MigrationError,
  MIGRATIONS_FOLDER,
  openDb,
  readMigrations,
} from "../../../apps/cli/src/db.ts";
import { freshDbPath, spawnBudget } from "../../../apps/cli/test/helpers.ts";

// ob 223: a half-recorded migration must never be a permanent break.
//
// On 2026-08-16 the live tracker was unopenable for six minutes: 0026's `credential_check` table
// existed and was empty while 0026 was NOT in __drizzle_migrations, so every `ob` re-ran 0026, hit
// "table already exists", retried it six times as though it were contention, and reported the whole
// migration file instead of the cause. Everything below is that failure, made into assertions.

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function journal(): JournalEntry[] {
  return (JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: JournalEntry[] })
    .entries;
}

function entryFor(tag: string): JournalEntry {
  const found = journal().find((e) => e.tag === tag);
  if (!found) throw new Error(`no journal entry for ${tag}`);
  return found;
}

const LAST = journal()[journal().length - 1]!;

/** Forget every migration from `tag` onwards, so those become outstanding again. (Since OB-1913 a
 *  forgotten MIDDLE one is outstanding too: "applied" is decided per migration, not by MAX(created_at).) */
function forgetFrom(db: Database, tag: string): void {
  db.query(`DELETE FROM __drizzle_migrations WHERE created_at >= ?`).run(entryFor(tag).when);
}

function recorded(db: Database, tag: string): boolean {
  return db.query(`SELECT 1 FROM __drizzle_migrations WHERE created_at = ?`).get(entryFor(tag).when) != null;
}

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

describe("migration atomicity + repair (223)", () => {
  // THE REGRESSION. This is the live database's exact state on 2026-08-16, and against the code
  // before this ticket openDb throws "after 6 attempts (concurrent access)" here rather than opening.
  test("a migration whose objects are present but which is not recorded is repaired, not fatal", () => {
    const path = freshDbPath();
    const built = openDb(path, { create: true });
    expect(hasTable(built, "credential_check")).toBe(true);
    forgetFrom(built, LAST.tag); // the objects stay; only the bookkeeping goes
    expect(recorded(built, LAST.tag)).toBe(false);
    built.close();

    const reopened = openDb(path);
    expect(hasTable(reopened, "credential_check")).toBe(true);
    expect(recorded(reopened, LAST.tag)).toBe(true); // repaired: recorded without re-running
    reopened.close();

    // and it stays repaired: the next open is an ordinary no-op, not a second repair
    const again = openDb(path);
    expect((again.query("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(journal().length);
    again.close();
  });

  test("the repair leaves the data in the already-present objects untouched", () => {
    const path = freshDbPath();
    const db = openDb(path, { create: true });
    db.query("INSERT INTO credential_check(name, checked_at, ok, detail) VALUES('gmail','2026-08-16T00:00:00.000Z',1,'fine')").run();
    forgetFrom(db, LAST.tag);
    db.close();

    const reopened = openDb(path);
    expect((reopened.query("SELECT detail FROM credential_check WHERE name='gmail'").get() as { detail: string }).detail).toBe("fine");
    reopened.close();
  });

  // Fresh-database creation is the other race, and it used to be survived by RETRYING the loser's
  // "already exists". Under an exclusive lock the loser never sees one.
  test("concurrent openers creating the same fresh database produce one whole schema", async () => {
    const path = freshDbPath();
    const dbModule = join(import.meta.dir, "..", "..", "..", "apps", "cli", "src", "db.ts");
    const script = `
      import { openDb } from ${JSON.stringify(dbModule)};
      const db = openDb(${JSON.stringify(path)}, { create: true });
      db.close();
      console.log("OK");
    `;
    const runners = Array.from({ length: 4 }, () =>
      Bun.spawn(["bun", "-e", script], { env: { ...process.env, OMNISLASH_DB_CREATE: "1" }, stdout: "pipe", stderr: "pipe" }),
    );
    const outcomes = await Promise.all(runners.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
    for (const o of outcomes) expect(o).toEqual({ code: 0, err: "" });

    const after = new Database(path);
    expect((after.query("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(journal().length);
    expect(hasTable(after, "item")).toBe(true);
    expect(hasTable(after, "credential_check")).toBe(true);
    after.close();
  }, spawnBudget(4));
});

// OB-1913: applied means recorded, per migration, not "the newest recorded row is at least as new".
// Fixture chains go straight to applyMigrations on a fresh handle (the test seam); openDb keeps reading
// the real journal.

function fixture(tag: string, when: number, sql: string): Migration {
  return {
    tag,
    when,
    hash: createHash("sha256").update(sql).digest("hex"),
    statements: sql.split("--> statement-breakpoint"),
  };
}

function bookkeep(db: Database, m: Migration): void {
  db.exec(`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
  db.query(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`).run(m.hash, m.when);
}

function isFixtureRecorded(db: Database, m: Migration): boolean {
  return db.query(`SELECT 1 FROM "__drizzle_migrations" WHERE created_at = ?`).get(m.when) != null;
}

/** Run `body` with console.error captured, returning every line it printed. */
function stderrOf(body: () => void): string[] {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    body();
    return spy.mock.calls.map((c) => c.map(String).join(" "));
  } finally {
    spy.mockRestore();
  }
}

describe("migrations are applied by their own row, not by the newest timestamp (OB-1913)", () => {
  test("a migration with no row of its own while a later one is recorded is applied, and says so", () => {
    const a = fixture("0001_fixture_gap", 1000, "CREATE TABLE gap_a (x INTEGER)");
    const b = fixture("0002_fixture_later", 2000, "CREATE TABLE gap_b (x INTEGER)");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE gap_b (x INTEGER)");
    bookkeep(db, b); // the old rule: newest (2000) >= 1000, so 0001 was skipped forever
    const lines = stderrOf(() => applyMigrations(db, [a, b]));
    expect(hasTable(db, "gap_a")).toBe(true);
    expect(isFixtureRecorded(db, a)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("0001_fixture_gap");
    expect(lines[0]).not.toContain("repaired");
    db.close();
  });

  test("a gap that is also an orphan prints only the repair note", () => {
    const a = fixture("0001_fixture_gap_orphan", 1000, "CREATE TABLE gap_o (x INTEGER)");
    const b = fixture("0002_fixture_later", 2000, "CREATE TABLE gap_o_b (x INTEGER)");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE gap_o (x INTEGER)");
    db.exec("CREATE TABLE gap_o_b (x INTEGER)");
    bookkeep(db, b);
    const lines = stderrOf(() => applyMigrations(db, [a, b]));
    expect(isFixtureRecorded(db, a)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("repaired migration 0001_fixture_gap_orphan");
    db.close();
  });

  test("a row matching the migration's hash under another when counts as applied", () => {
    const a = fixture("0001_fixture_hash", 1000, "CREATE TABLE hash_a (x INTEGER)");
    const db = new Database(":memory:");
    bookkeep(db, { ...a, when: 999 });
    const lines = stderrOf(() => applyMigrations(db, [a]));
    expect(hasTable(db, "hash_a")).toBe(false);
    expect(lines).toEqual([]);
    db.close();
  });

  test("an orphan whose tag is in REPLAY_DATA_ON_REPAIR gets its backfill run before it is recorded", () => {
    const m = fixture("0037_per_project_refs", 1000, "CREATE TABLE replay_t (x INTEGER)\n--> statement-breakpoint\nUPDATE replay_t SET x = 1");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE replay_t (x INTEGER)");
    db.exec("INSERT INTO replay_t VALUES (0)");
    const lines = stderrOf(() => applyMigrations(db, [m]));
    expect(db.query("SELECT x FROM replay_t").get()).toEqual({ x: 1 });
    expect(isFixtureRecorded(db, m)).toBe(true);
    expect(lines.join("\n")).toContain("repaired migration 0037_per_project_refs");
    db.close();
  });

  test("an orphan with an unguarded data statement is refused by tag, and the database is unchanged", () => {
    const m = fixture("0001_fixture_backfill", 1000, "CREATE TABLE unguarded_t (x INTEGER)\n--> statement-breakpoint\nUPDATE unguarded_t SET x = 1");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE unguarded_t (x INTEGER)");
    db.exec("INSERT INTO unguarded_t VALUES (0)");
    let thrown: unknown;
    const lines = stderrOf(() => {
      try {
        applyMigrations(db, [m]);
      } catch (err) {
        thrown = err;
      }
    });
    expect(thrown).toBeInstanceOf(MigrationError);
    expect((thrown as MigrationError).tag).toBe("0001_fixture_backfill");
    expect((thrown as Error).message).toContain("backfill is not known safe to re-run");
    expect(db.query("SELECT x FROM unguarded_t").get()).toEqual({ x: 0 });
    expect(isFixtureRecorded(db, m)).toBe(false);
    expect(lines).toEqual([]);
    db.close();
  });

  test("a data-only migration applies normally and is recorded", () => {
    const m = fixture("0001_fixture_data_only", 1000, "INSERT INTO data_t VALUES (5)");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE data_t (x INTEGER)");
    const lines = stderrOf(() => applyMigrations(db, [m]));
    expect(db.query("SELECT x FROM data_t").all()).toEqual([{ x: 5 }]);
    expect(isFixtureRecorded(db, m)).toBe(true);
    expect(lines).toEqual([]);
    db.close();
  });

  test("the legacy-adoption shape (only 0000 recorded, v18 tables present) applies 0001 onward with no repair note", () => {
    const path = freshDbPath();
    const chain = readMigrations();
    const legacy = new Database(path, { create: true });
    applyMigrations(legacy, chain.slice(0, 1));
    legacy.close();
    let db: Database | undefined;
    const lines = stderrOf(() => {
      db = openDb(path);
    });
    expect(lines).toEqual([]);
    expect((db!.query("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n).toBe(journal().length);
    expect((db!.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(18);
    db!.close();
  });

  test("an open with nothing to do takes no write lock", () => {
    const path = freshDbPath();
    const built = openDb(path, { create: true });
    expect((built.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(18);
    built.close();

    const writer = new Database(path);
    writer.exec("BEGIN IMMEDIATE;");
    try {
      const started = Date.now();
      const db = openDb(path);
      expect(Date.now() - started).toBeLessThan(1000);
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(18);
      db.close();
    } finally {
      writer.exec("ROLLBACK;");
      writer.close();
    }
  }, 15_000);
});

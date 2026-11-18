// ob 337: the two-live-stores guard.
//
// apps/cli is only partly ported to the store seam, so the question this file answers is not "does the
// port work" but "is a PARTIAL port safe to cut over". It is safe exactly when an unported path REFUSES
// under OMNISLASH_STORE=postgres instead of quietly opening the SQLite file and writing to it -- two live
// stores being the one migration failure that cannot be fixed forward.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../apps/cli/src/db.ts";
import { resolveStoreKind, STORE_ENV } from "../../../apps/cli/src/db/store-kind.ts";
import { openStore } from "../../../apps/cli/src/db/store.ts";
import {
  isPostgresServable,
  replicaUnderPostgresMessage,
  unusableSqliteHandle,
} from "../../../apps/cli/src/db/servable.ts";

const dirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-337-"));
  dirs.push(dir);
  return join(dir, "omnislash.sqlite");
}

afterEach(() => {
  // 337j: back to sqlite, NOT unset -- unset is now postgres, and a leaked default would send every
  // later test file in this process at the live cluster.
  process.env[STORE_ENV] = "sqlite";
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ob 337 two-live-stores guard", () => {
  // 337j: POSTGRES is now the default, so the guard's own default-case test inverts. An unset variable
  // used to mean "open the file"; it now means "the file is a fossil, refuse". The suite reaches this
  // with OMNISLASH_STORE=sqlite from preload.ts, so the unset case is asserted by deleting it here.
  test("postgres is the default, so an unset variable refuses the file rather than opening it", () => {
    const before = process.env[STORE_ENV];
    try {
      delete process.env[STORE_ENV];
      expect(resolveStoreKind()).toBe("postgres");
      const path = tempDbPath();
      expect(() => openDb(path, { create: true })).toThrow(/not ported to the store seam/);
      expect(existsSync(path)).toBe(false);
    } finally {
      if (before === undefined) delete process.env[STORE_ENV];
      else process.env[STORE_ENV] = before;
    }
  });

  test("an explicit OMNISLASH_STORE=sqlite still opens the file, and the guard is untouched by it", () => {
    process.env[STORE_ENV] = "sqlite";
    const path = tempDbPath();
    const db = openDb(path, { create: true });
    expect(db).toBeDefined();
    db.close();
  });

  test("openDb REFUSES under OMNISLASH_STORE=postgres, and never creates the file", () => {
    process.env[STORE_ENV] = "postgres";
    const path = tempDbPath();
    expect(() => openDb(path, { create: true })).toThrow(/not ported to the store seam/);
    // The file must not exist: a guard that fires after the handle is open has already written a WAL and
    // run the migrations, which is the very thing being prevented.
    expect(existsSync(path)).toBe(false);
  });

  test("the refusal names the command and the way back", () => {
    process.env[STORE_ENV] = "postgres";
    const path = tempDbPath();
    let message = "";
    try {
      openDb(path, { create: true, what: "'ob next'" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("'ob next'");
    expect(message).toContain("TWO LIVE STORES");
    expect(message).toContain(`${STORE_ENV}=sqlite`);
    expect(message).toContain(path);
  });

  test("deliberateSqlite is the escape hatch for callers that mean the file itself", () => {
    process.env[STORE_ENV] = "postgres";
    const path = tempDbPath();
    const db = openDb(path, { create: true, deliberateSqlite: true });
    expect(db).toBeDefined();
    db.close();
  });

  test("openStore({ kind: 'sqlite' }) still works while the env says postgres", async () => {
    // The migration tooling's case: ob 323's exporter reads the SQLite source to copy it INTO Postgres,
    // and it must be able to do that on a machine already configured for postgres.
    process.env[STORE_ENV] = "postgres";
    const path = tempDbPath();
    const store = await openStore({ kind: "sqlite", path, create: true });
    expect(store.kind).toBe("sqlite");
    expect(store.sqlite).not.toBeNull();
    await store.close();
  });
});

// --- pass 2: the refusal NARROWS, and what it narrows to ---------------------
//
// Pass 1's guard refused every command, which was correct and useless: nothing was servable. Pass 2
// ports config/project/tracker-link and wires cli.ts to open the STORE for an explicit list. The whole
// safety property now rests on that list being right, so these are the tests that hold it honest: a
// name on it must be genuinely ported, everything else must still refuse, and the stand-in handle a
// servable command carries must be unusable rather than quietly real.
describe("ob 337 pass 2: which commands are servable from Postgres", () => {
  test("the list is explicit and small, and the commands known NOT to be ported are absent", () => {
    expect(isPostgresServable("next")).toBe(true);
    expect(isPostgresServable("wiki")).toBe(true); // OB-2006
    expect(isPostgresServable("show")).toBe(true);
    expect(isPostgresServable("list")).toBe(true);
    expect(isPostgresServable("config")).toBe(true);
    expect(isPostgresServable("project")).toBe(true);
    expect(isPostgresServable("focus")).toBe(true);
    expect(isPostgresServable("add")).toBe(true);
    expect(isPostgresServable("close")).toBe(true);
    // 337 pass 4: the item-adjacent writes and search.
    expect(isPostgresServable("note")).toBe(true);
    expect(isPostgresServable("tag")).toBe(true);
    expect(isPostgresServable("untag")).toBe(true);
    expect(isPostgresServable("link")).toBe(true);
    // `ob search` runs a DIFFERENT query on each engine on purpose (fts5 MATCH vs ob 322's tsquery
    // against the generated search_vec column), which is exactly why it is listed rather than assumed.
    expect(isPostgresServable("search")).toBe(true);
    expect(isPostgresServable("log")).toBe(true);
    // pass 6: the reporting reads.
    expect(isPostgresServable("status")).toBe(true);
    expect(isPostgresServable("report")).toBe(true);
    expect(isPostgresServable("metrics")).toBe(true);
    // pass 7: the work loop, `ob brief`, and the three entity
    // readers that turned out to be ported already.
    expect(isPostgresServable("edit")).toBe(true);
    expect(isPostgresServable("rm")).toBe(true);
    expect(isPostgresServable("state")).toBe(true);
    expect(isPostgresServable("triage")).toBe(true);
    expect(isPostgresServable("brief")).toBe(true);
    expect(isPostgresServable("decision")).toBe(true);
    expect(isPostgresServable("learning")).toBe(true);
    expect(isPostgresServable("roadmap")).toBe(true);

    // `issue`'s reconcile/drift half fetches the issue list through git on this machine.
    expect(isPostgresServable("issue")).toBe(false);
    expect(isPostgresServable("")).toBe(false);
    // 456: remaining DATA commands.
    for (const cmd of [
      "person",
      "whois",
      "review-miss",
      "audit",
      "cursor",
      "test-user",
      "sync",
    ]) {
      expect(isPostgresServable(cmd), cmd).toBe(true);
    }
  });

  // branch K: the DASHBOARD pair. `web` is the one whose absence was already visible -- the dashboard
  // has been down since the cutover because `ob web` refused -- and `alerts` is the CLI half of the same
  // surface, whose count rides the dashboard's own snapshot.
  test("the dashboard pair is servable (branch K)", () => {
    expect(isPostgresServable("web")).toBe(true);
    expect(isPostgresServable("alerts")).toBe(true);
  });

  // pass 6: the fleet pair. `daemon` is servable by CONSTRUCTION rather than by porting -- cmdDaemon
  // renders launchd plists and shells out to launchctl, and touches no database at all -- and `jobs`
  // reads job_run plus three settings through the store.
  test("pass 6 adds the fleet commands", () => {
    expect(isPostgresServable("daemon")).toBe(true);
    expect(isPostgresServable("jobs")).toBe(true);
    // the backup pair: the ob 326 precondition, now pg_dump rather than VACUUM INTO.
    expect(isPostgresServable("backup")).toBe(true);
    expect(isPostgresServable("db")).toBe(true);
  });

  // pass 3: the coordination core -- what makes a cut-over tracker WORKABLE rather than merely readable.
  test("pass 3 adds the coordination commands", () => {
    expect(isPostgresServable("lease")).toBe(true);
    expect(isPostgresServable("agent")).toBe(true);
    expect(isPostgresServable("agents")).toBe(true);
  });

  // pass 5: `ob spinoff`, which is what makes it USABLE -- it is how every builder is launched. It was
  // held off the list for two passes because its launcher routing, bundle probe and --repo
  // lookup read config through the synchronous sqlite-only setting(); each now has an async `...For`
  // form beside it, sharing one pure decision function with the sync one.
  test("pass 5 adds spinoff", () => {
    expect(isPostgresServable("spinoff")).toBe(true);
  });

  test("the openDb refusal now NAMES what is servable, so a human is told the way forward", () => {
    process.env[STORE_ENV] = "postgres";
    const path = tempDbPath();
    let message = "";
    try {
      openDb(path, { what: "'ob spinoff'" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("'ob spinoff'");
    expect(message).toContain("these ARE servable from Postgres today");
    expect(message).toContain("next");
    expect(message).toContain("show");
    // Still the one thing that must never be lost: the way back.
    expect(message).toContain(`${STORE_ENV}=sqlite`);
    expect(existsSync(path)).toBe(false);
  });

  test("a replica-served read refuses too: the replica is a SQLite copy with no Postgres form", () => {
    const message = replicaUnderPostgresMessage("'ob next'", "ob@10.0.0.30");
    expect(message).toContain("'ob next'");
    expect(message).toContain("ob@10.0.0.30");
    expect(message).toContain("refusing");
    expect(message).toContain(`${STORE_ENV}=sqlite`);
  });

  test("the stand-in handle throws on any use, and says which command reached it", () => {
    const db = unusableSqliteHandle("'ob next'");
    expect(() => (db as unknown as { query: unknown }).query).toThrow(/'ob next'/);
    expect(() => (db as unknown as { exec: unknown }).exec).toThrow(new RegExp(STORE_ENV));
    expect(() => (db as unknown as { prepare: unknown }).prepare).toThrow(/not ported/);
  });

  test("the stand-in handle still closes, because cli.ts closes it in a finally that must not fail", () => {
    const db = unusableSqliteHandle("'ob next'");
    expect(() => db.close()).not.toThrow();
  });

  test("asStore does not mistake the stand-in for a Store", () => {
    // `asStore` tells the two apart with `"kind" in db`. A proxy that threw on the membership test, or
    // answered true, would send a raw handle down the store branch and produce a store over nothing.
    const db = unusableSqliteHandle("'ob next'");
    expect("kind" in (db as unknown as Record<string, unknown>)).toBe(false);
  });
});

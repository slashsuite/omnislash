import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { openDb } from "../src/db.ts";
import { run, type RunDeps } from "../src/cli.ts";

export function freshDbPath(): string {
  return join(tmpdir(), `ob-test-${randomUUID()}.sqlite`);
}

export function freshDb() {
  return openDb(freshDbPath());
}

let migratedTemplate: string | null = null;

/**
 * OB-2023: a fresh, already-migrated SQLite file at `path`, copied from one template this process migrates
 * once. `openDb` on it finds nothing outstanding and returns in about 1ms, where a fresh path runs the whole
 * migration chain (about 40ms idle, measured, and many times that at load 15), so a test that needs several
 * throwaway databases stops paying that chain for each. The template is checkpointed before the copy: a
 * closed handle leaves the schema in its `-wal`, and a copy of the main file alone is an empty database.
 */
export function migratedDbPath(path: string = freshDbPath()): string {
  if (migratedTemplate === null) {
    const template = freshDbPath();
    const db = openDb(template);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    migratedTemplate = template;
  }
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(migratedTemplate, path);
  return path;
}

/** A real temp directory that looks like a git repo (a `.git` marker dir), for tests that need
 *  `--repo` to resolve as an existing local checkout (#61) without shelling out to real git. Named
 *  `<tmp>/ob-repo-<random>/omnislash` so it reads as ob's own repo (OB-1992): every other repo is a clean
 *  repo, with a title-slug branch and no ob in its PR, and the tests that want that use `fakeCleanRepoDir`. */
export function fakeRepoDir(): string {
  return fakeCleanRepoDir("omnislash");
}

/** `fakeRepoDir`, but a clean repo by default (OB-1992): `<tmp>/ob-repo-<random>/widgets`. */
export function fakeCleanRepoDir(name = "widgets"): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ob-repo-")), name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

// ── Tests that touch the world: subprocesses and shared machine state (#155) ─────────────────────────
//
// bun's default per-test budget is 5000ms, which is generous for an in-process test and far too tight for
// one that spawns. Five tests failed under parallel-builder load in a single night for that reason alone
// (#148, #152, #155), and this repo is worked with several builders at once, so a quiet machine is the
// exception rather than the rule. The convention these helpers exist to support:
//
//   1. A test that SPAWNS declares it, with `}, spawnBudget(n));` naming how many processes it starts.
//      The cost is then visible in the test rather than discovered as a timeout under load.
//   2. A test that only needs the code path, not the process, injects the seam instead of spawning, and
//      pins that it spawns nothing with `countSpawns`.
//   3. A test that waits on another process's side effect polls with `until` rather than sleeping, and
//      treats a transient failure as not-yet-true.
//   4. A test that reaches a LAUNCHER seams the spawn with `__setAgentSpawn`, and one
//      that asserts the per-variant DEFAULTS reads them through `withDefaultInbox` (#157).

/** Wall-clock a spawn is worth on a busy machine. Measured: bun cold start reached ~4s at load avg 30. */
const PER_SPAWN_MS = 5_000;

/**
 * The per-test timeout for a test that starts `spawns` subprocesses: bun's own 5000ms for the assertions,
 * plus a busy-machine allowance per process. Pass it as bun's per-test timeout (`}, spawnBudget(2));`) so
 * the process cost is declared where the test is written rather than tuned as a magic number after a
 * timeout. Prefer injecting a seam over raising this: a budget makes a spawn affordable, not free.
 */
export function spawnBudget(spawns: number): number {
  return 5_000 + spawns * PER_SPAWN_MS;
}

/**
 * Poll for a condition within a bounded budget. A predicate that THROWS counts as not-yet-true and is
 * retried, because reads that spawn a process fail transiently under parallel load and one such failure
 * used to abort a whole test long before its budget ran out (#148). If the budget expires the last error is
 * rethrown, so a genuinely broken command still fails with its own reason rather than a parse error.
 */
export async function until(predicate: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let lastError: unknown;
  for (;;) {
    try {
      if (predicate()) return true;
      lastError = undefined;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() >= deadline) break;
    await Bun.sleep(200);
  }
  if (lastError !== undefined) throw lastError;
  return false;
}

/**
 * A `ps -A -o pid=,comm=` table for the process probe (#121): one row per `comm` in `running`,
 * plus this test process's own pid, which the probe REQUIRES to be there before it will conclude anything
 * (a table that cannot find the asker cannot be reasoned from). Pass `{ sawSelf: false }` to build the
 * could-not-tell case on purpose.
 *
 * `running` takes exec patterns, since the probe suffix-matches argv[0].
 */
export function psTable(running: string[] = [], opts: { sawSelf?: boolean } = {}): string {
  const rows = running.map((comm, i) => `${90_000 + i} ${comm}`);
  rows.unshift("    1 /sbin/launchd");
  if (opts.sawSelf !== false) rows.push(`${process.pid} ${process.execPath}`);
  return `${rows.join("\n")}\n`;
}

/**
 * A `sh` stub for the process probe: answers the `ps` read with a table listing `running` and
 * lets every other shell-out succeed. The single place tests say "this is what is up", so a change to how
 * the probe reads the process table does not have to be mirrored in twenty stubs.
 */
export function psSh(running: string[] = [], opts: { sawSelf?: boolean } = {}) {
  return (cmd: string[]) =>
    cmd[0] === "ps"
      ? { ok: true, err: "", out: psTable(running, opts) }
      : { ok: true, err: "", out: "" };
}

/**
 * Run `fn` and report every subprocess it started, so a test can PIN that a path which injects its seams
 * spawns nothing. This is the regression pin for #155: the panel-turn tests injected the model runner and
 * still paid two real bun startups per test, because the fail-closed egress guard's self-test ran for
 * real, and that only surfaced as a 5002ms timeout once the machine was busy.
 */
export async function countSpawns<T>(fn: () => Promise<T>): Promise<{ result: T; spawned: string[] }> {
  const spawned: string[] = [];
  const realSpawn = Bun.spawn;
  const realSpawnSync = Bun.spawnSync;
  const note = (args: unknown): void => {
    const cmd = Array.isArray(args) ? args : ((args as { cmd?: unknown } | null)?.cmd ?? args);
    spawned.push(Array.isArray(cmd) ? cmd.map(String).join(" ") : String(cmd));
  };
  (Bun as { spawn: unknown }).spawn = (...args: unknown[]) => {
    note(args[0]);
    return (realSpawn as (...a: unknown[]) => unknown)(...args);
  };
  (Bun as { spawnSync: unknown }).spawnSync = (...args: unknown[]) => {
    note(args[0]);
    return (realSpawnSync as (...a: unknown[]) => unknown)(...args);
  };
  try {
    return { result: await fn(), spawned };
  } finally {
    (Bun as { spawn: unknown }).spawn = realSpawn;
    (Bun as { spawnSync: unknown }).spawnSync = realSpawnSync;
  }
}

export interface CliResult {
  code: number;
  out: string;
  err: string;
}

export async function runCli(dbPath: string, args: string[], deps: RunDeps = {}): Promise<CliResult> {
  const prevDb = process.env.OMNISLASH_DB;
  process.env.OMNISLASH_DB = dbPath;
  // The e2e suite runs in-process from the repo (which has a `wayfinder/` dir), so `ob status` would
  // otherwise reach out to GitHub for the frontier (221). Disable it for every command-path test — the
  // frontier reader is unit-tested separately via an injected fetcher.
  const prevFrontier = process.env.OMNISLASH_DISABLE_FRONTIER;
  process.env.OMNISLASH_DISABLE_FRONTIER = "1";
  const origLog = console.log;
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  (process.stderr.write as unknown) = (chunk: string) => {
    err += chunk;
    return true;
  };
  try {
    const code = await run(args, deps);
    return { code, out, err };
  } finally {
    console.log = origLog;
    (process.stderr.write as unknown) = origErr;
    if (prevDb === undefined) delete process.env.OMNISLASH_DB;
    else process.env.OMNISLASH_DB = prevDb;
    if (prevFrontier === undefined) delete process.env.OMNISLASH_DISABLE_FRONTIER;
    else process.env.OMNISLASH_DISABLE_FRONTIER = prevFrontier;
  }
}

/**
 * OB-2255: put `itemId` (when given) in project `omnislash` of team `omnislash`, so a handoff note for a row serving that
 * item routes to the team's thread. The team and the project are made once; an item id that is not an item is
 * made one, with that id, so a row that records it resolves. Plain SQL: this is fixture state, not app code.
 */
export function omnislashTeamFor(db: ReturnType<typeof openDb>, itemId?: string): void {
  const at = "2026-11-17T00:00:00Z";
  db.query("INSERT INTO project_group (name, created_at) VALUES ('omnislash', ?) ON CONFLICT DO NOTHING").run(at);
  db.query("INSERT INTO project (id, name, kind, created_at, group_name) VALUES ('omnislash', 'omnislash', 'side', ?, 'omnislash') ON CONFLICT DO NOTHING").run(at);
  if (itemId === undefined) return;
  db.query("INSERT INTO item (id, type, title, status, created_at, updated_at) VALUES (?, 'task', ?, 'open', ?, ?) ON CONFLICT DO NOTHING").run(itemId, `item ${itemId}`, at, at);
  db.query("UPDATE item SET project_id = 'omnislash' WHERE id = ?").run(itemId);
}

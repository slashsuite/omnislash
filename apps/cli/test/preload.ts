import { Database } from "bun:sqlite";
import { afterAll, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepNxTmp } from "./nx-tmp-sweep.ts";
import { installPgTestHooks } from "./pg/hooks.ts";
import { assertSeamsReal } from "../src/test-seams.ts";
import { SCRATCH_DIR_NAME, SHM_DIR, scratchParent } from "./scratch-root.ts";

/**
 * Bun test preload for the cli suite (see `apps/cli/bunfig.toml` and the repo-root `bunfig.toml` ->
 * `[test] preload`). Bun runs this BEFORE any test module loads, which is the only place that can redirect
 * state a module resolves at import time -- and, more importantly, the only place that covers a test nobody
 * has written yet.
 *
 * It exists because the suite kept reaching state that belongs to the MACHINE rather than the run. Two
 * incidents, one file:
 *
 * 152: the suite allocates ~99 throwaway paths via `tmpdir()` -- temp SQLite DBs, fixture repos, fake app
 * bundles -- and almost none are removed. They land in the developer's SHARED `$TMPDIR`, which macOS never
 * prunes while the machine stays up, so they accumulate across every run: the directory was measured at
 * 806,596 entries, 806,503 of them this suite's leftovers (~260k leaked DB triples).
 *
 * 157: one `spinoff drain` CLI test seamed its shell-outs but not the launcher's own write, so a real
 * launch request -- brief `"b"` -- reached the live inbox a running interactive app was watching, which
 * consumed it exactly as designed and spawned a real Claude Code session on a one-character prompt, on
 * every gate run, spending real money in the app being worked in.
 *
 * Per-site seams cannot close either class: they protect the sites someone remembered. Redirecting the
 * process once here re-points every caller -- test files, the modules under test, and any subprocess
 * spawned with `{...process.env}` -- so a test that reaches for `tmpdir()` or the launcher inherits the
 * isolation. Allocation at the call sites is unchanged; cleanup lives in one place. The individual launcher
 * sites are seamed too, so the suite stays safe when this preload is bypassed.
 *
 * `??=` for the acme vars so an explicitly-set value still wins: the guard suite spawns a real `ob` with
 * its own `OMNISLASH_DB`, and individual tests legitimately point `XDG_DATA_HOME` at their own fixtures.
 * `TMPDIR` is a plain assignment: an inherited one is the shared directory this exists to get out of.
 *
 * `OMNISLASH_KEEP_TEST_TMP=1` keeps the scratch root for post-mortem inspection.
 */

/**
 * One shared parent, a directory per run inside it. The parent is resolved from the ORIGINAL `tmpdir()`,
 * before `TMPDIR` is redirected below, so every run agrees on where it lives.
 */
const sharedTmp = tmpdir();

/**
 * OB-2024: the scratch goes on tmpfs (`/dev/shm`) when the machine has a usable one, because on a disk
 * filesystem a write to a throwaway SQLite page can wait seconds for the kernel's background writeback of
 * that page (see `scratch-root.ts`). The run's own directory is made inside the `try`, so a `/dev/shm`
 * this process cannot write (another user's `ob-cli-test` among them) falls back to the shared tmp.
 */
const shmScratchRoot = join(SHM_DIR, SCRATCH_DIR_NAME);
const legacyScratchRoot = join(sharedTmp, SCRATCH_DIR_NAME);
function makeScratch(): string {
  const runId = randomUUID();
  const preferred = join(scratchParent(sharedTmp), SCRATCH_DIR_NAME, runId);
  try {
    mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch {
    const fallback = join(legacyScratchRoot, runId);
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}
const scratch = makeScratch();

/**
 * Sweep the trees that earlier runs could not remove themselves.
 *
 * The `afterAll` below is the normal cleanup and it does fire -- measured: registered from a preload it
 * runs EXACTLY ONCE after the last test file, on a green run, a red run and a single-file run, and it is
 * not a per-file hook (which would delete the root mid-run). What it cannot survive is the process being
 * killed: under `kill -9` -- and so under a CI/harness timeout or a ctrl-C -- nothing after the preload
 * runs and the tree leaks. `process.on("exit")` and `beforeExit` are no help either; neither fires under
 * bun's test runner at all (measured: a preload registering both printed nothing).
 *
 * So: `afterAll` for the common case, this sweep for the killed one. The grace period keeps a CONCURRENT
 * builder's live run out of it -- this repo is worked with several at once, and their run directories are
 * siblings under the same parent.
 */
const GRACE_MS = 2 * 60 * 60 * 1000;
if (process.env.OMNISLASH_KEEP_TEST_TMP !== "1") {
  // Both locations every time: a run that fell back still sweeps a killed tmpfs run's tree, and the reverse.
  for (const root of [shmScratchRoot, legacyScratchRoot]) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue; // a location this machine never used
    }
    for (const entry of entries) {
      const path = join(root, entry);
      try {
        if (Date.now() - statSync(path).mtimeMs > GRACE_MS) rmSync(path, { recursive: true, force: true });
      } catch {
        // a sibling run removing the same entry, or one that vanished mid-sweep: not this run's problem
      }
    }
  }
}

/**
 * The leak that is not the suite's (1373): a killed Nx daemon leaves ~72MB of `nx@latest` in
 * `<tmp>/tmp-<pid>-*`. `NX_USE_LOCAL=true` in the repos still on Nx stops new ones (acme runs moon, OB-2033); this clears the old ones from the shared tmp,
 * not the scratch, so it runs on every gate whether or not the suite itself leaked anything. `/tmp` is swept
 * as well as `$TMPDIR`: a daemon started by T3 or a service has no `$TMPDIR` and writes to `/tmp`, while a
 * shell here points `$TMPDIR` at `~/.cache/tmp`.
 */
if (process.env.OMNISLASH_KEEP_TEST_TMP !== "1") {
  for (const root of new Set([sharedTmp, "/tmp"])) sweepNxTmp(root);
}

/**
 * The shared `$TMPDIR` (152). This one assignment re-points all ~99 `tmpdir()` call sites, and everything
 * the vars below name is then inside the same tree, so one removal cleans the lot.
 */
process.env.TMPDIR = scratch;

/**
 * The XDG data root every derived cache resolves from: the central DB default (`resolveDbPath`), the HA
 * recorder cache, the whatsapp media + avatar caches. None of these is a test's to own.
 */
process.env.XDG_DATA_HOME ??= join(scratch, "data");

/**
 * The machine's models file (OB-1969). A developer's real `~/.config/ob/models.jsonc` would change which
 * model a launch picks and so break any test that launches. Point it at a path that does not exist; a test
 * of the file itself sets its own `OB_MODELS_FILE` and restores this one.
 */
process.env.OB_MODELS_FILE = join(scratch, "no-models-file.jsonc");

/**
 * OB-2173: a review-leg.ts a test spawns would otherwise start `ob review readers --json` to read the
 * review_readers setting. No test's leg is the owner's choice, so the read is skipped (a unit test injects its own).
 */
process.env.OB_REVIEW_READERS_SKIP = "1";

/**
 * OB-2234: `ob lease run cpu:...` goes through the TaskSlash daemon when it answers. A test's run must never
 * submit a job to this desktop's real daemon, so the path is off; a test of it points this at a fake client.
 */
process.env.OB_LEASE_RUN_TASKSLASH = "0";

/**
 * OS-108: `ob next` and every spinoff dispatch read the weekly Claude usage from T3's cache. A test must not
 * read this desktop's real one (at 95% it would refuse every dispatch in the suite, and a CI runner without
 * one would print "usage unknown" into every command's stderr), so the suite gets a fresh, low-usage cache.
 * A test of the line points `OB_USAGE_T3_CACHE` at its own fixture.
 */
const usageCache = join(scratch, "claudeAgent.json");
writeFileSync(
  usageCache,
  JSON.stringify({
    usageLimits: {
      // A day ahead, so the cache never reads as an hour stale during a long run.
      checkedAt: new Date(Date.now() + 86_400_000).toISOString(),
      windows: [{ id: "seven_day", usedPercent: 10, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), windowDurationMins: 10080 }],
    },
  }),
);
process.env.OB_USAGE_T3_CACHE = usageCache;

/** The central DB, in case something resolves it before `XDG_DATA_HOME` is consulted. */
process.env.OMNISLASH_DB ??= join(scratch, `acme-${randomUUID()}.db`);
// OB-2141: `spinoff cleanup` and reconcile read merged pull requests from GitHub. No test reaches the
// network, so the read reports itself disabled unless a test injects its own (`__setMergedPrRead`).
process.env.OB_GITHUB_PR_READ ??= "off";

/**
 * The ENGINE (337j). Postgres became the built-in default when the cutover finished, so a suite that
 * inherits the default would open a connection to the owner's live cluster -- the one rule this repo's
 * tests do not get to break. Declaring it here rather than per-file covers the test nobody has written
 * yet, which is the whole argument of this file.
 *
 * `??=` so the ob 325 Postgres harness can still set `postgres` for its own tests: those address a
 * throwaway cluster the harness itself starts on a unix socket, never a live one.
 */
process.env.OMNISLASH_STORE ??= "sqlite";

/** The GitHub org whose remotes infer a project (project.ts). Test fixtures use `owner`. */
process.env.OB_GITHUB_OWNER ??= "owner";

/**
 * The creation opt-in (198). `openDb` refuses to create a database that nobody asked for, and the suite
 * asks for one about a hundred times a run. Wired here rather than at the call sites for the same reason
 * as everything else in this file: it also covers the test nobody has written yet. `??=` so the guard's
 * own tests can unset it and spawn an `ob` that meets the refusal.
 */
process.env.OMNISLASH_DB_CREATE ??= "1";

/**
 * No fsync for throwaway databases (1658). SQLite's default `synchronous=FULL` makes every write an fsync;
 * the suite's databases are temp files that are deleted at the end of the run, so durability buys nothing
 * and the fsync latency of whatever disk `$TMPDIR` landed on becomes a test's runtime. Measured on a btrfs
 * `$HOME`: 4ms per fsync against 0.01ms on tmpfs, which put `job-health-218`'s 200-row replay at 8s
 * (past bun's 5s budget). `??=` so an outer environment can still set another mode.
 */
process.env.OMNISLASH_DB_SYNCHRONOUS ??= "OFF";

/**
 * The same rule for every other SQLite handle the suite opens (OB-1894). `openDb` reads the variable above,
 * but a raw `new Database(path)` (a test's own fixture, a legacy-shape DB, a module under test that opens
 * a file directly) still ran at `synchronous=FULL`. Measured on the desktop runner's btrfs `$TMPDIR` under
 * a parallel gate: nine CREATE statements on a fresh file took 3.4s median and 5.2s worst, against 1.4ms
 * with `OFF`, which is how `pg-export-323`'s fixture alone reached bun's 5s budget and went red as a
 * timeout. Patching the prototype rather than each site covers the handle nobody has written yet, as
 * everything else in this file does: the first statement on a handle sets its mode, once. A handle that
 * cannot take the pragma (closed, or opened mid-transaction by another connection) keeps SQLite's default.
 * Subprocesses are not affected: a spawned `ob` opens through `openDb` and inherits the variable.
 */
const testSynchronous = process.env.OMNISLASH_DB_SYNCHRONOUS;
if (testSynchronous && /^(OFF|NORMAL|FULL|EXTRA)$/i.test(testSynchronous)) {
  const proto = Database.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  const run = proto.run!;
  const tuned = new WeakSet<object>();
  for (const name of ["run", "exec", "prepare", "query", "transaction"] as const) {
    const original = proto[name]!;
    proto[name] = function (this: object, ...args: unknown[]) {
      if (!tuned.has(this)) {
        tuned.add(this);
        try {
          run.call(this, `PRAGMA synchronous = ${testSynchronous}`);
        } catch {
          // keep SQLite's default; the statement the caller asked for still runs and reports its own error
        }
      }
      return original.apply(this, args);
    };
  }
}

/**
 * The API client's configuration (353). `ob` becomes an API client the moment a base url resolves, and one
 * of the two places it resolves from is a file in the developer's HOME. A machine that has been cut over
 * would otherwise flip the whole suite onto HTTP -- against the owner's live API -- without a single test
 * asking for it. Pointed at paths inside this run's scratch, which do not exist, so the suite is a
 * non-client unless a test says otherwise (the API tests inject their base and transport explicitly).
 */
process.env.OMNISLASH_API_URL_FILE ??= join(scratch, "no-such-api-url");
process.env.OB_API_TOKEN_FILE ??= join(scratch, "no-such-api-token");
// The env var outranks the file, so an inherited one would route the WHOLE suite over HTTP at a live host.
// Deleted rather than defaulted: a test that wants API mode injects its own base and transport.
delete process.env.OMNISLASH_API;

/**
 * The T3 credential (1589). `ob spinoff <ref>` now opens its T3 thread in the same invocation, so a test that
 * enqueues without installing a fake seam (`__setT3Seam`) would otherwise read the developer's real credential
 * and open a real thread on the live T3. Pointed at a file that does not exist, so such a launch fails with the
 * credential's own named refusal instead.
 */
process.env.OB_T3_CREDENTIAL_FILE ??= join(scratch, "no-such-t3-credential");

/**
 * The thread a T3 agent shell runs in (OB-2153). `ob lease run` and `lease acquire --wait` retitle that thread while
 * they wait, so a suite run from a builder's own T3 shell would otherwise rename the builder's real thread every
 * time a lease test waits. Deleted: a test that wants the retitle sets its own id and a fake seam.
 */
delete process.env.T3CODE_THREAD_ID;

/**
 * The Postgres harness's own lifecycle (325): the stale-cluster sweep, a per-test lease release and the
 * postmaster shutdown. Registered here for the same reason as everything else in this file -- it is the
 * one scope that covers every test file, including the ones nobody has written yet. It starts nothing:
 * the cluster is built on the first `freshPgDb()` and a run that never asks for one never pays for it.
 */
installPgTestHooks();

/**
 * The seam guard (OB-2150). bun runs a project's test files in one process, so a module seam (`__setSh`,
 * `__setT3Seam`, ...) one test leaves stubbed is what every later test and file gets; OB-2145 saw a lost
 * restore in t3-dispatch.test.ts fail 9 tests in spinoff.test.ts. Measured on bun 1.4.2: an `afterEach`
 * registered here runs after EVERY test of every file, after that file's own `afterEach` hooks, and a throw in
 * it fails that test. So a stub still installed at this point was leaked by the test that just ran: the seam
 * is reset (the next test starts real) and that test fails, naming the seam. Every seam must be defined with
 * `defineSeam` (`apps/cli/src/test-seams.ts`), or this guard cannot see it.
 */
afterEach(() => {
  assertSeamsReal();
});

afterAll(() => {
  if (process.env.OMNISLASH_KEEP_TEST_TMP === "1") return;
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * The owner's GitHub settings ship empty (settings.ts). The suite's fixtures are an `owner` org with an
 * `owner/acme` tracker repo, so the defaults the tests read are set here, once, rather than per test.
 */
const { DEFAULTS } = await import("../src/settings.ts");
DEFAULTS.github_login = "owner";
DEFAULTS.wayfinder_repo = "owner/acme";
DEFAULTS.backup_repo = "owner/acme";

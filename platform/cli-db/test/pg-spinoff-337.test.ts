// ob 337 pass 5: `ob spinoff` itself on BOTH engines.
//
// pg-coord-337 proved the spinoff QUEUE (enqueue/claim/stamp/land/reclaim). This is the other half, and
// it is the half that kept `spinoff` off the servable list for two passes: everything the command reads
// that is NOT a queue row. The launcher routing, the `--repo` slug lookup, the
// ticket's tags were all reads through settings.ts's synchronous sqlite-only
// `setting()`, so a drain under Postgres would have taken its queue from one engine and its decisions
// from the other -- which is not a wrong number on a screen, it is an agent launched in the wrong place.
//
// Each of those reads now has an async `...For` form beside the synchronous one, and the pair shares ONE
// pure decision function. That sharing is the claim this file tests: the same settings, written through
// each engine, must produce the same launcher and the same tags -- and then the same
// DRAIN, run end to end with the shell and T3 seams injected so no real git and no real agent is
// touched.
//
// The four documented differences all have somewhere to bite:
//   - count()/sum() arrive from Postgres as STRINGS. Drain `active` is a number either way, so its TYPE
//     is asserted.
//   - json columns are text. `spinoff_launcher_by_repo` and `repo_checkouts` are
//     JSON stored in a plain config TEXT column on both engines, so they are parsed by ob rather than by
//     a driver -- asserted by round-tripping all three through the parse.
//   - ORDER BY puts NULLs FIRST on Postgres, LAST on SQLite. The drain walks pending rows `asc(id)` and
//     lists them `desc(id)`, both on the PK (NOT NULL), so both orders are compared rather than assumed.
//
// It uses the ob 325 harness: a real local cluster over a unix socket, no network and no live database.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3, type FakeT3Install } from "../../../apps/cli/test/fake-t3.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { addTags, createItem } from "../../../apps/cli/src/items.ts";
import { registerAgent } from "../../cli-coord/src/agent.ts";
import {
  __setSh,
  drainSpinoffs,
  enqueueSpinoff,
  launchNotReadyFor,
  listSpinoffs,
  resolveRepoFor,
  rowLauncherNameFor,
  rowRepoPathFor,
  selectLauncherNameFor,
  spinoffTicketTagsFor,
  type SpinoffRow,
} from "../../cli-coord/src/commands/spinoff.ts";

const PG_BUDGET = spawnBudget(3);

const dirs: string[] = [];
const restores: Array<() => void> = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What each engine's pass writes into instead of a real agent or a real git call. */
interface Captured {
  t3: FakeT3Install;
}

/** Where each fake T3 launch was bound, and whether it carried the row's brief (1589: t3 is the only launcher). */
function launchedInto(captured: Captured, briefs: readonly string[]): Array<{ worktree: string | null; brief: string | null }> {
  return captured.t3.launches.map((l) => {
    const ws = l.workspaceStrategy;
    return {
      worktree: ws && "worktreePath" in ws ? ws.worktreePath : null,
      brief: briefs.find((b) => (l.message ?? "").includes(b)) ?? null,
    };
  });
}

/** The machine-shaped facts a drain reads: a checkout and its worktrees. */
interface Machine {
  repo: string;
  worktrees: Record<string, string>;
}

/**
 * One realistic pass over everything `ob spinoff` reads that is not a queue row, ending in a real drain.
 * Returns plain JSON-able values so a mismatch between the engines reads as a diff.
 */
async function exercise(store: Store, machine: Machine, captured: Captured): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // --- the settings the whole path turns on, written through THIS engine ---------------------------
  await setConfig(store, "spinoff_launcher", "t3");
  await setConfig(store, "spinoff_launcher_by_repo", JSON.stringify({ acme: "t3", broken: "nonsense" }));
  await setConfig(store, "repo_checkouts", JSON.stringify({ "owner/acme": machine.repo }));

  // --- launcher routing (spinoff_launcher + spinoff_launcher_by_repo) ------------------------------
  out.launcherGlobal = await selectLauncherNameFor(store);
  out.launcherByRepo = await selectLauncherNameFor(store, machine.repo); // basename `acme`
  out.launcherByRepoSlug = await selectLauncherNameFor(store, "owner/acme");
  out.launcherUnknownEntry = await selectLauncherNameFor(store, "/dev/broken"); // warns, falls back
  out.launcherRowWins = await rowLauncherNameFor(store, { repo: machine.repo, launcher: "t3" });
  out.launcherRowGarbageFallsBack = await rowLauncherNameFor(store, { repo: machine.repo, launcher: "warp" });

  // --- the `--repo` slug lookup (repo_checkouts), also JSON-in-text --------------------------------
  out.resolveBySlug = await resolveRepoFor(store, "owner/acme");
  out.resolveByPath = await resolveRepoFor(store, machine.repo);
  out.rowRepoAbsolute = await rowRepoPathFor(store, machine.repo);
  out.rowRepoSlug = await rowRepoPathFor(store, "owner/acme");
  // Tolerant by design: an unresolvable slug comes back untouched so git fails naming it, rather than
  // one bad row aborting a whole reconcile sweep.
  out.rowRepoUnresolvable = await rowRepoPathFor(store, "no-such-repo-anywhere");

  // --- the ticket's tags, which ride on a launch --------------------------------------------------
  const plainItem = await createItem(store, { title: "port the spinoff command", type: "task" });
  await addTags(store, plainItem, ["postgres", "cutover"]);
  const taggedItem = await createItem(store, { title: "another piece of work", type: "task" });
  await addTags(store, taggedItem, ["dashboard", "cutover"]);
  out.itemIds = [plainItem, taggedItem]; // the id generator must agree too
  out.tagsPlain = await spinoffTicketTagsFor(store, plainItem);
  out.tagsTargeting = await spinoffTicketTagsFor(store, taggedItem);
  out.tagsUnknownRef = await spinoffTicketTagsFor(store, "no-such-item"); // never throws: [] instead

  // --- the launcher-not-ready seam: always ready now, identical on both engines (ob 1109) ---------
  const retiredRow: SpinoffRow = {
    id: -1,
    ticket_ref: taggedItem,
    repo: machine.repo,
    branch: "build-93",
    worktree: machine.worktrees["build-93"]!,
    mode: "agent",
    brief: "rebuild it",
    status: "pending",
    error: null,
    agent_id: null,
    request_at: "2026-08-18T00:00:00.000Z",
    launched_at: null,
    input_tokens: null,
    output_tokens: null,
    cache_creation_tokens: null,
    cache_read_tokens: null,
    total_tokens: null,
    base_sha: null,
    reported_at: null,
    launcher: "warp",
    launch_attempts: null,
    session_id: null,
    engine: null,
    t3_thread_id: null,
    t3_run_id: null,
    item_id: null,
    tier: null,
    model: null,
    effort: null,
    verdict: null,
    verdict_reason: null,
    gate_line: null,
  };
  // A row recorded under a retired launcher is a warning, not a wait: nothing defers any more.
  out.notReadyRetired = await launchNotReadyFor(store, retiredRow);

  // --- THE DRAIN, end to end -----------------------------------------------------------------------
  // Two pending rows in ONE repo: both launch (ob 767: agent count is not a limiter). Both are
  // `t3` by their own recorded launcher (#135).
  const first = await enqueueSpinoff(store, {
    ticketRef: "337",
    repo: machine.repo,
    branch: "build-337a",
    worktree: machine.worktrees["build-337a"],
    mode: "agent",
    brief: "the first pending row",
    launcher: "t3",
  });
  const second = await enqueueSpinoff(store, {
    ticketRef: "338",
    repo: machine.repo,
    branch: "build-338a",
    worktree: machine.worktrees["build-338a"],
    mode: "agent",
    brief: "the second pending row",
    launcher: "t3",
  });
  out.queuedIds = [first.row.id, second.row.id];
  // asc(id) for the drain's FIFO walk and desc(id) for the list, both on the PK: compared, not assumed.
  out.pendingOrder = (await listSpinoffs(store, "pending")).map((r) => r.ticket_ref);

  const drained = await drainSpinoffs(store);
  out.drained = {
    launched: drained.launched,
    failed: drained.failed,
    blocked: drained.blocked,
    not_ready: drained.not_ready,
    reclaimed: drained.reclaimed,
    db_failures: drained.db_failures,
    remote_error: drained.remote_error,
    remaining_pending: drained.remaining_pending,
    active: drained.active,
  };
  out.drainedActiveType = typeof drained.active;
  out.spawned = launchedInto(captured, ["the first pending row", "the second pending row"]);
  out.rowsAfterDrain = (await listSpinoffs(store)).map((r) => [r.ticket_ref, r.status, r.launcher, r.base_sha]);

  // A second drain launches nothing: the queue is empty, not because a cap held a row back.
  const again = await drainSpinoffs(store);
  out.secondDrain = { launched: again.launched, remaining_pending: again.remaining_pending, active: again.active };
  out.spawnedAll = launchedInto(captured, []).map((l) => l.worktree);

  // A team role row (architect-*) is excluded from `active`, on either engine.
  await registerAgent(store, { id: "architect-acme", status: "planning", ttlS: 900 });
  const fourth = await drainSpinoffs(store);
  out.architectNotCounted = fourth.active;

  return out;
}

describe("ob spinoff agrees across the two engines (337 pass 5)", () => {
  test(
    "the launcher routing, the probe, the slug lookup, the tags and a whole drain are identical on Postgres and on SQLite",
    async () => {
      const lease = await leaseRealPgDb();
      const dir = tempDir("ob337-spinoff-");
      const repo = join(dir, "acme");
      mkdirSync(join(repo, ".git"), { recursive: true });
      const worktrees: Record<string, string> = {};
      for (const branch of ["build-337a", "build-338a", "build-93"]) {
        const path = join(dir, `acme.${branch}`);
        mkdirSync(path, { recursive: true });
        worktrees[branch] = path;
      }
      // The bundle is NOT on disk and NOT in the fake process table: that is the #118 "nothing is up"
      // state retained for the launcher-not-ready seam, which no longer defers (ob 1109).
      const machine: Machine = { repo, worktrees };

      const captured: Captured = { t3: installFakeT3([repo]) };
      restores.push(captured.t3.restore);
      const resetT3 = (): void => {
        captured.t3.launches.length = 0;
        captured.t3.threads.length = 0; // a thread left over from the other engine would be ADOPTED, not launched
      };
      restores.push(
        __setSh((cmd) => {
          if (cmd[0] === "ps") return { ok: true, err: "", out: `${process.pid} /bin/ob\n` };
          if (cmd.includes("merge-base")) return { ok: true, err: "", out: "base0000\n" };
          if (cmd.includes("worktree")) return { ok: true, err: "", out: "" };
          return { ok: true, err: "", out: "" };
        }),
      );

      const previousCreate = process.env.OMNISLASH_DB_CREATE;
      process.env.OMNISLASH_DB_CREATE = "1";
      let pg: Store | undefined;
      let sqlite: Store | undefined;
      try {
        pg = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        sqlite = await openStore({ kind: "sqlite", path: join(dir, "omnislash.sqlite"), create: true });
        expect(pg.kind).toBe("postgres");
        expect(pg.sqlite).toBeNull();

        resetT3();
        const fromPg = await exercise(pg, machine, captured);
        resetT3();
        const fromSqlite = await exercise(sqlite, machine, captured);

        // Key by key, so a failure names the value that moved rather than "two big objects differ".
        for (const key of Object.keys(fromSqlite)) {
          expect({ [key]: fromPg[key] }).toEqual({ [key]: fromSqlite[key] });
        }

        // Absolute anchors, so a bug that broke BOTH engines identically still fails here.
        expect(fromSqlite.launcherGlobal).toBe("t3");
        expect(fromSqlite.launcherByRepo).toBe("t3"); // the per-repo entry wins (#83)
        expect(fromSqlite.launcherByRepoSlug).toBe("t3"); // matched on the last path segment
        expect(fromSqlite.launcherUnknownEntry).toBe("t3"); // unknown entry -> warn + global
        expect(fromSqlite.launcherRowWins).toBe("t3"); // the row outranks config (#135)
        expect(fromSqlite.launcherRowGarbageFallsBack).toBe("t3"); // retired/unknown -> fall back
        expect(fromSqlite.resolveBySlug).toBe(repo);
        expect(fromSqlite.rowRepoSlug).toBe(repo);
        expect(fromSqlite.rowRepoUnresolvable).toBe("no-such-repo-anywhere");
        expect(fromSqlite.tagsPlain).toEqual(["cutover", "postgres"]); // asc(tag.name), both engines
        expect(fromSqlite.tagsTargeting).toEqual(["cutover", "dashboard"]);
        expect(fromSqlite.tagsUnknownRef).toEqual([]);
        expect(fromSqlite.notReadyRetired).toBeNull(); // nothing defers any more (ob 1109)
        expect(fromSqlite.pendingOrder).toEqual(["338", "337"]); // desc(id) on the PK
        expect(fromSqlite.drained).toEqual({
          launched: ["337", "338"], // asc(id): FIFO, both launch (ob 767)
          failed: [],
          blocked: [],
          not_ready: [],
          reclaimed: [],
          db_failures: [],
          remote_error: null,
          remaining_pending: 0,
          active: 2,
        });
        expect(fromSqlite.drainedActiveType).toBe("number");
        expect(fromSqlite.spawned).toEqual([
          { worktree: worktrees["build-337a"]!, brief: "the first pending row" },
          { worktree: worktrees["build-338a"]!, brief: "the second pending row" },
        ]);
        expect(fromSqlite.rowsAfterDrain).toEqual([
          ["338", "launched", "t3", "base0000"],
          ["337", "launched", "t3", "base0000"],
        ]);
        expect(fromSqlite.secondDrain).toEqual({ launched: [], remaining_pending: 0, active: 2 });
        expect(fromSqlite.architectNotCounted).toBe(2); // architect-* excluded from active
      } finally {
        await pg?.close();
        await sqlite?.close();
        await lease.release();
        if (previousCreate === undefined) delete process.env.OMNISLASH_DB_CREATE;
        else process.env.OMNISLASH_DB_CREATE = previousCreate;
      }
    },
    PG_BUDGET,
  );
});

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, freshDbPath, psTable, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { getConfig, setConfig } from "../../../apps/cli/src/config.ts";
import { storeConfigIo, teamRoleModelFrom } from "../../../apps/cli/src/model-routes-io.ts";
import { T3Error, T3_THREAD_STATUSES, type T3Capabilities, type T3LaunchInput, type T3LaunchResult, type T3Project, type T3SendInput, type T3Thread, type T3ThreadListResult, type T3ThreadRead } from "../../../apps/cli/src/t3/client.ts";
import {
  T3_DEFAULT_RUNTIME_MODE,
  T3_LAUNCHER,
  __setT3Seam,
  builderThreadTitle,
  clientRequestIdFor,
  ensureTeamThread,
  frontmatterField,
  liveRunReason,
  DEFAULT_TIER_MODELS,
  launchT3Spinoff,
  modelSelectionFor,
  parseTierModels,
  isTeamRoleTitle,
  titleWithNeedsYou,
  rowTier,
  clearTeamNeedsHuman,
  mirrorT3Runs,
  reconcileT3Runs,
  runtimeModeForTicket,
  settleT3ThreadsForTicket,
  splitTierModel,
  storeAgentRegistry,
  t3RunStatus,
  t3ProjectFor,
  t3WorktreeHold,
  ticketFilePath,
  unjoinedSettleWarning,
  worktreeRepoOf,
  type T3Seam,
} from "../../../apps/cli/src/t3/dispatch.ts";
import { recentCreditHits, rowProfiles } from "../../../apps/cli/src/models-credit.ts";
import { FAKE_EFFORT_OPTIONS } from "../../../apps/cli/test/fake-t3.ts";
import { renderTeamThread } from "../../../apps/cli/src/commands/t3-team.ts";
import { teamThreadTitle } from "../../../apps/cli/src/team.ts";
import { shellWords } from "../../../apps/cli/src/remote.ts";
import { doneAgent, getAgent, isAgentStatus, registerAgent } from "../src/agent.ts";
import { createItem, editItem } from "../../../apps/cli/src/items.ts";
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { PRIORITY_URGENT } from "../../../apps/cli/src/priority.ts";
import { opusHighRefusal, refuseOpusHighTrial, refuseRaisedOpusHigh, withOpusHighNote } from "../../../apps/cli/src/t3/dispatch.ts";
import { itemDispatchRefs } from "../src/spinoff-item.ts";
import {
  __setSh,
  __shIsReal,
  cleanupWorktrees,
  drainSpinoffs,
  enqueueSpinoff,
  launchNotReadyIn,
  launchRowIn,
  listSpinoffs,
  localSpinoffSteps,
  reclaimSpinoffs,
  relaunchCreditFailures,
  stampArgv,
  type SpinoffRow,
  type SpinoffLaunchConfig,
} from "../src/commands/spinoff.ts";

// ---------------------------------------------------------------------------
// A fake T3: enough of the surface to drive the whole dispatch path in-process,
// with no server, no credential and no network.
// ---------------------------------------------------------------------------

const PROJECT_ID = "proj-omnislash";

interface FakeThread extends T3Thread {
  pendingRequestCount: number;
}

interface FakeT3 {
  seam: T3Seam;
  threads: FakeThread[];
  launches: T3LaunchInput[];
  calls: { launch: number; list: number; read: number; pin: number; unpin: number; rename: number; settle: number; send: number };
  /** Threads ob pinned, in order (OB-2255: every team thread is pinned). */
  pinned: string[];
  /** Threads ob asked T3 to turn auto-settle off for, in order (OB-1845). */
  autoSettleOff: string[];
  failAutoSettle: boolean;
  /** Every message ob delivered into a thread, in order: what the readying note and the land reply assert on. */
  sends: T3SendInput[];
  failSettle: boolean;
  failSend: boolean;
  /** Every `search` the capabilities call was given (OB-1815): the short default list sends none. */
  searches: string[];
}

const CLAUDE_EFFORT_OPTION = FAKE_EFFORT_OPTIONS[0]!; // OB-1815: Claude's `effort` list, T3's own `ultrathink` among the values

function fakeT3(
  opts: {
    repoPath: string;
    threads?: FakeThread[];
    defaultModel?: boolean;
    catalog?: string[];
    /** model id → the options it lists (OB-1815). A model absent here lists none. */
    options?: Record<string, Array<{ id: string; values: string[]; default?: string }>>;
    /** Model ids T3's short list leaves out and only a `search` for the id finds (OB-1815). */
    omitted?: Record<string, { providerInstanceId: string; options?: Array<{ id: string; values: string[]; default?: string }> }>;
    /** Extra providers appended to the default fakeT3 capabilities for a specific test. */
    extraProviders?: T3Capabilities["providers"];
  } = { repoPath: "/r/repo" },
): FakeT3 {
  const searches: string[] = [];
  const threads: FakeThread[] = opts.threads ?? [];
  const calls = { launch: 0, list: 0, read: 0, pin: 0, unpin: 0, rename: 0, settle: 0, send: 0 };
  const launches: T3LaunchInput[] = [];
  const sends: T3SendInput[] = [];
  const project: T3Project = {
    id: PROJECT_ID,
    title: "omnislash",
    workspaceRoot: opts.repoPath,
    // The live omnislash shape: the project default is Opus on the Claude instance (1480 swaps the MODEL by tier).
    defaultModelSelection: opts.defaultModel === false ? null : { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    deletedAt: null,
  };
  const capabilities: T3Capabilities = {
    runtimeMode: "full-access",
    providers: [
      { providerInstanceId: "opencode", displayName: "OpenCode", models: [{ id: "opencode-go/deepseek-v4.1-flash", ...(opts.options?.["opencode-go/deepseek-v4.1-flash"] ? { options: opts.options["opencode-go/deepseek-v4.1-flash"] } : {}) }], constraints: [] },
      ...(opts.extraProviders ?? []),
      {
        providerInstanceId: "claudeAgent",
        displayName: "Claude",
        models: [...(opts.catalog ?? ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])].map((id) => ({ id, ...(opts.options?.[id] ? { options: opts.options[id] } : {}) })),
        constraints: [],
      },
    ],
  };
  const fake: FakeT3 = {
    threads,
    launches,
    calls,
    sends,
    searches,
    failSettle: false,
    failSend: false,
    autoSettleOff: [],
    pinned: [],
    failAutoSettle: false,
    seam: {
      interrupt: async () => {},
      projects: async () => [project],
      capabilities: async (search?: string) => {
        if (search === undefined) return capabilities;
        searches.push(search);
        const hit = opts.omitted?.[search];
        if (!hit) return { ...capabilities, providers: capabilities.providers.map((p) => ({ ...p, models: [] })) };
        return {
          ...capabilities,
          providers: capabilities.providers.map((p) => ({
            ...p,
            models: p.providerInstanceId === hit.providerInstanceId ? [{ id: search, ...(hit.options ? { options: hit.options } : {}) }] : [],
          })),
        };
      },
      list: async (o): Promise<T3ThreadListResult> => {
        calls.list++;
        const filtered = threads
          .filter((t) => (o.settled === false ? !t.settled : true))
          .filter((t) => (o.titleContains ? t.title.includes(o.titleContains) : true));
        return { projectId: o.projectId ?? PROJECT_ID, threads: filtered.map((t) => ({ threadId: t.threadId, projectId: t.projectId, title: t.title, status: t.status, latestRunId: t.latestRunId, providerInstanceId: t.providerInstanceId, model: t.model, settled: t.settled, parentThreadId: null })), nextCursor: null };
      },
      read: async (threadId): Promise<T3ThreadRead> => {
        calls.read++;
        const t = threads.find((x) => x.threadId === threadId);
        if (!t) throw new T3Error("refused", `t3_thread_read: thread ${threadId} not found`, "re-read the tree");
        return { thread: t, recentRuns: [], items: [], nextPosition: 0, hasMore: false };
      },
      launch: async (input): Promise<T3LaunchResult> => {
        calls.launch++;
        launches.push(input);
        const n = threads.length + 1;
        const t: FakeThread = {
          threadId: `t3-${n}`,
          projectId: PROJECT_ID,
          title: input.title,
          status: input.message ? "running" : "idle",
          worktreePath: input.workspaceStrategy && "worktreePath" in input.workspaceStrategy ? input.workspaceStrategy.worktreePath : null,
          branch: input.workspaceStrategy && "branch" in input.workspaceStrategy ? (input.workspaceStrategy.branch ?? null) : null,
          settled: false,
          archived: false,
          model: input.modelSelection.model,
          providerInstanceId: input.modelSelection.instanceId,
          activeRunId: input.message ? `run-${n}` : null,
          latestRunId: input.message ? `run-${n}` : null,
          pendingRequestCount: 0,
        };
        threads.push(t);
        return { threadId: t.threadId, projectId: PROJECT_ID, modelSelection: input.modelSelection, runId: t.activeRunId, status: t.status };
      },
      pin: async (id) => {
        calls.pin++;
        fake.pinned.push(id);
      },
      unpin: async () => {
        calls.unpin++;
      },
      disableAutoSettle: async (threadId) => {
        fake.autoSettleOff.push(threadId);
        if (fake.failAutoSettle) throw new T3Error("refused", "T3 refused the command: route gone");
      },
      rename: async (threadId, title) => {
        calls.rename++;
        const t = threads.find((x) => x.threadId === threadId);
        if (t) t.title = title;
      },
      settle: async (threadId) => {
        calls.settle++;
        if (fake.failSettle) throw new T3Error("refused", "t3_thread_organize: unavailable");
        const t = threads.find((x) => x.threadId === threadId);
        if (!t) throw new T3Error("refused", `t3_thread_organize: thread ${threadId} not found`);
        t.settled = true;
      },
      send: async (input) => {
        calls.send++;
        sends.push(input);
        if (fake.failSend) throw new T3Error("refused", "t3_thread_send: unavailable", "retry, then check `ob t3 doctor`");
        if (!threads.some((x) => x.threadId === input.threadId)) {
          throw new T3Error("refused", `t3_thread_send: thread ${input.threadId} not found`);
        }
      },
      wait: async () => ({ runId: null, status: "idle", timedOut: false }),
      // 1205: nothing is HELD by this fake's threads, so a close finds no readying note to withdraw.
      queue: async () => ({ items: [], complete: true }),
      queueCancel: async () => {},
    },
  };
  return fake;
}

function threadOf(over: Partial<FakeThread> = {}): FakeThread {
  return {
    threadId: "t3-9",
    projectId: PROJECT_ID,
    title: "1120",
    status: "running",
    worktreePath: null,
    branch: null,
    settled: false,
    archived: false,
    model: "claude-sonnet-5-5", // the default tier's model, so an adoption is a same-model retry
    providerInstanceId: "claudeAgent",
    activeRunId: "run-9",
    latestRunId: "run-9",
    pendingRequestCount: 0,
    ...over,
  };
}

/** A temp dir that looks like a git checkout (`--repo` resolution needs the `.git` marker). */
function fakeRepo(): string {
  // Named omnislash (OB-1992): any other repo is a clean repo, whose branch is a title slug.
  const dir = join(mkdtempSync(join(tmpdir(), "ob-t3-repo-")), "omnislash");
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

const tempDirs: string[] = [];
function trackedRepo(): string {
  const dir = fakeRepo();
  tempDirs.push(dir);
  return dir;
}
function trackedDir(path: string): string {
  mkdirSync(path, { recursive: true });
  tempDirs.push(path);
  return path;
}

let restoreSeam: (() => void) | null = null;
let restoreSh: (() => void) | null = null;

afterEach(() => {
  restoreSeam?.();
  restoreSeam = null;
  restoreSh?.();
  restoreSh = null;
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/**
 * Install `fn` as the shell runner for this test (OB-2145). An earlier stub in the same test is undone first:
 * overwriting `restoreSh` without calling it lost the first stub's restore, so `afterEach` put the FIRST stub
 * back instead of the real runner, and every later test file in the process (bun runs them in directory order)
 * got `{ ok: true }` from a `git worktree add` that never ran.
 */
function setSh(fn: Parameters<typeof __setSh>[0]): void {
  restoreSh?.();
  restoreSh = __setSh(fn);
}

/** Install `seam` as the fake T3 for this test (OB-2150): the same lost-restore fix as `setSh`, for `__setT3Seam`. */
function setT3Seam(seam: Parameters<typeof __setT3Seam>[0]): void {
  restoreSeam?.();
  restoreSeam = __setT3Seam(seam);
}

/** Everything a launch reads off git, stubbed: nothing here forks a real `git`. */
function stubGit(): void {
  setSh(() => ({ ok: true, err: "", out: "" }));
}

// ---------------------------------------------------------------------------

describe("t3 dispatch — pure resolution (1120)", () => {
  test("the retry key is derived from the row id and never changes", () => {
    expect(clientRequestIdFor(1120)).toBe("ob-spinoff-1120");
    expect(clientRequestIdFor(1120)).toBe(clientRequestIdFor(1120));
  });

  test("ob titles a builder thread `<ticket> · <name>`, where the name is the ticket's own ob title (1143)", () => {
    // the ref stays FIRST and is the identity; the name is what the ticket calls itself
    expect(builderThreadTitle("1120", "1120", "See T3 from ob (read surface)")).toBe("1120 · See T3 from ob (read surface)");
    // a title that repeats the ref drops the repeat: the number is already in front of it
    expect(builderThreadTitle("1143", "1143", "1143: spinoff threads wear the ticket's name")).toBe("1143 · spinoff threads wear the ticket's name");
    expect(builderThreadTitle("1143", "1143", "1143 threads wear a name")).toBe("1143 · threads wear a name");
    // whitespace collapses to ONE line -- an ob title can carry a newline
    expect(builderThreadTitle("1143", "1143", "  two\nlines\there  ")).toBe("1143 · two lines here");
    // a ref that only PREFIXES the title is not the ref: '11431' is a different ticket
    expect(builderThreadTitle("1143", "1143", "11431 is not this ticket")).toBe("1143 · 11431 is not this ticket");
  });

  test("a team title is `<icon> <display name> · <role>`, falling back to the name (OB-2255)", () => {
    expect(teamThreadTitle({ name: "slash", icon: "⚔️", display_name: "Slash" }, "architect")).toBe("⚔️ Slash · architect");
    expect(teamThreadTitle({ name: "slash", icon: null, display_name: "Slash" }, "sentinel")).toBe("Slash · sentinel");
    expect(teamThreadTitle({ name: "slash", icon: null, display_name: null }, "muse")).toBe("slash · muse");
    // an icon with no display name still leads, in front of the name
    expect(teamThreadTitle({ name: "hackcove", icon: "🏴‍☠️", display_name: "  " }, "architect")).toBe("🏴‍☠️ hackcove · architect");
    // the needs-you marker goes in front of the icon and comes off again
    const title = teamThreadTitle({ name: "slash", icon: "⚔️", display_name: "Slash" }, "architect");
    const marked = titleWithNeedsYou(title, "needs-human");
    expect(marked).toBe("🙋 ⚔️ Slash · architect");
    expect(titleWithNeedsYou(marked, "working")).toBe("⚔️ Slash · architect");
    expect(titleWithNeedsYou(marked, "needs-human")).toBe(marked);
  });

  test("team threads are matched by the exact ` · <role>` suffix, never a builder title or the retired planner (OB-2255)", () => {
    for (const t of ["⚔️ Slash · architect", "slash · sentinel", "🙋 🚌 OmniSlash · muse"]) expect(isTeamRoleTitle(t)).toBe(true);
    for (const t of [
      builderThreadTitle("OB-2255", "ob-2255", "teams under ob t3"),
      builderThreadTitle("OB-12", "ob-12", "architect"),
      builderThreadTitle("OB-12", "ob-12", "split the · architect"),
      "omnislash · planner", // the retired role is not a team thread
      "omnislash · architects",
    ]) expect(isTeamRoleTitle(t)).toBe(false);
  });

  test("the title's fallbacks, in order: the branch, then the number alone (1143)", () => {
    // FALLBACK 1: no title at all -> the pre-1143 `<ticket> · <branch>` (a named branch still says something)
    expect(builderThreadTitle("1120", "t3-dispatch", null)).toBe("1120 · t3-dispatch");
    expect(builderThreadTitle("1120", "t3-dispatch", "")).toBe("1120 · t3-dispatch");
    expect(builderThreadTitle("1120", "t3-dispatch", "   ")).toBe("1120 · t3-dispatch");
    // FALLBACK 2: nothing usable -> the ticket alone (branch IS the ticket, the common case)
    expect(builderThreadTitle("1120", "1120")).toBe("1120");
    // a title that IS only the ref is nothing usable: the number would otherwise appear twice
    expect(builderThreadTitle("1120", "1120", "1120")).toBe("1120");
    expect(builderThreadTitle("1120", "1120", "1120:")).toBe("1120");
    expect(builderThreadTitle("1120", "1120", "#1120 ")).toBe("1120");
    // a very long title is cut to one sidebar line, with an ellipsis
    expect(builderThreadTitle("1120", "1120", "y".repeat(200))).toBe(`1120 · ${"y".repeat(59)}…`);
    // exactly at the cut: unchanged; one past it: cut
    expect(builderThreadTitle("1120", "1120", "z".repeat(60))).toBe(`1120 · ${"z".repeat(60)}`);
    expect(builderThreadTitle("1120", "1120", "z".repeat(61))).toBe(`1120 · ${"z".repeat(59)}…`);
  });

  test("a repo's project is matched by its checkout, and a deleted project never matches", () => {
    const repo = trackedRepo();
    const live: T3Project = { id: "a", title: "omnislash", workspaceRoot: repo, deletedAt: null };
    const gone: T3Project = { id: "b", title: "omnislash", workspaceRoot: "/r/other", deletedAt: "2026-01-01" };
    expect(t3ProjectFor([gone, live], repo)?.id).toBe("a");
    expect(t3ProjectFor([live], "/r/nowhere")).toBeNull();
    // a worktree beside the checkout resolves to the checkout's project (the project IS the repo)
    const wt = trackedDir(`${repo}.1120`);
    writeFileSync(join(wt, ".git"), "gitdir: somewhere\n");
    expect(worktreeRepoOf(wt)).toBe(repo);
    expect(t3ProjectFor([live], wt)?.id).toBe("a");
    // a directory that merely LOOKS like a worktree (no checkout beside it) is not one
    expect(worktreeRepoOf("/r/omnislash.1120")).toBeNull();
    expect(worktreeRepoOf(repo)).toBeNull(); // no dot: the repo itself
  });

  test("a linked worktree NOT beside its repo (T3's ~/.t3/worktrees/<repo>/t3-<id>) resolves through git's commondir (1414)", () => {
    const repo = trackedRepo();
    const live: T3Project = { id: "a", title: "omnislash", workspaceRoot: repo, deletedAt: null };
    // What `git worktree add` writes: the worktree's `.git` FILE → <repo>/.git/worktrees/<name>, whose
    // `commondir` points back at the repo's `.git`.
    const gitdir = join(repo, ".git", "worktrees", "t3-a5991f8d");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    const wt = trackedDir(mkdtempSync(join(tmpdir(), "ob-t3-wt-")) + "/t3-a5991f8d");
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
    expect(worktreeRepoOf(wt)).toBe(repo);
    expect(t3ProjectFor([live], wt)?.id).toBe("a");
    // a `.git` file git did not write (no commondir behind it) is not a worktree
    const stray = trackedDir(mkdtempSync(join(tmpdir(), "ob-t3-stray-")) + "/t3-x");
    writeFileSync(join(stray, ".git"), "gitdir: /nowhere\n");
    expect(worktreeRepoOf(stray)).toBeNull();
  });

  test("the model is the project's own default, and every way of not having one is a named refusal", () => {
    const caps: T3Capabilities = {
      runtimeMode: "full-access",
      providers: [
        { providerInstanceId: "codex", displayName: "Codex", models: [], constraints: ["Codex CLI is not authenticated."] },
        { providerInstanceId: "opencode", displayName: "OpenCode", models: [{ id: "m" }], constraints: [] },
      ],
    };
    const withDefault = (instanceId: string, model: string): T3Project => ({ id: "p", title: "omnislash", workspaceRoot: "/r", defaultModelSelection: { instanceId, model }, deletedAt: null });
    expect(modelSelectionFor(withDefault("opencode", "m"), caps)).toEqual({ selection: { instanceId: "opencode", model: "m" }, error: null });
    // no default at all: refuse rather than pick whatever is first in the catalog
    expect(modelSelectionFor({ id: "p", title: "omnislash", workspaceRoot: "/r", defaultModelSelection: null, deletedAt: null }, caps).error).toContain("no default model");
    // a provider T3 reports as unusable: refuse naming ITS constraint
    expect(modelSelectionFor(withDefault("codex", "x"), caps).error).toContain("not authenticated");
    // a provider that is not advertised at all
    expect(modelSelectionFor(withDefault("pi", "x"), caps).error).toContain("does not advertise");
  });

  test("runtimeMode comes from the ticket's frontmatter, defaults to full-access, and warns on junk", () => {
    expect(frontmatterField("---\nexec: spinoff\nruntimeMode: auto\n---\nbody", "runtimeMode")).toBe("auto");
    expect(frontmatterField("no frontmatter", "runtimeMode")).toBeNull();
    expect(runtimeModeForTicket("/r/nowhere", "1120")).toBe(T3_DEFAULT_RUNTIME_MODE);

    const repo = trackedRepo();
    mkdirSync(join(repo, "wayfinder", "tickets"), { recursive: true });
    writeFileSync(join(repo, "wayfinder", "tickets", "1120-t3-dispatch.md"), "---\nid: 1120\nruntimeMode: auto\n---\n");
    expect(ticketFilePath(repo, "1120")).toBe(join(repo, "wayfinder", "tickets", "1120-t3-dispatch.md"));
    expect(runtimeModeForTicket(repo, "1120")).toBe("auto");
    writeFileSync(join(repo, "wayfinder", "tickets", "1120-t3-dispatch.md"), "---\nid: 1120\nruntimeMode: turbo\n---\n");
    expect(runtimeModeForTicket(repo, "1120")).toBe(T3_DEFAULT_RUNTIME_MODE);
  });

  test("an unreadable tickets directory is a FAULT, not 'no ticket file' (1162)", () => {
    const repo = trackedRepo();
    // absence: no wayfinder/ at all -> null, the fallback every caller has
    expect(ticketFilePath(repo, "1120")).toBeNull();
    // a directory that EXISTS and cannot be read is reported, not read as absence: silently treating it
    // as "no file" downgrades a composed brief to a pointer (and a runtimeMode to the default)
    const tickets = join(repo, "wayfinder", "tickets");
    mkdirSync(tickets, { recursive: true });
    chmodSync(tickets, 0o000);
    try {
      expect(() => ticketFilePath(repo, "1120")).toThrow();
    } finally {
      chmodSync(tickets, 0o700);
    }
  });

  test("the mirror writes T3's own word into `run`, `waiting` for a pending question, null for a status it does not know", () => {
    expect(t3RunStatus({ status: "running" })).toBe("running");
    expect(t3RunStatus({ status: "completed" })).toBe("completed");
    expect(t3RunStatus({ status: "failed" })).toBe("failed");
    expect(t3RunStatus({ status: "running", pendingRequestCount: 1 })).toBe("waiting");
    expect(t3RunStatus({ status: "teleporting" })).toBeNull();
  });

  test("no T3 thread word is an ob agent STATUS any more: the two vocabularies have a field each (1189)", () => {
    for (const s of T3_THREAD_STATUSES) expect([s, isAgentStatus(s)]).toEqual([s, false]);
  });

  test("a live run blocks its worktree; a settled, archived or finished one does not", () => {
    expect(liveRunReason(threadOf())).toContain("live run");
    expect(liveRunReason(threadOf({ status: "waiting", activeRunId: null }))).toContain("is waiting");
    expect(liveRunReason(threadOf({ status: "completed", activeRunId: null }))).toBeNull();
    expect(liveRunReason(threadOf({ status: "idle", activeRunId: null }))).toBeNull();
    expect(liveRunReason(threadOf({ settled: true, activeRunId: null }))).toBeNull();
    expect(liveRunReason(threadOf({ archived: true, activeRunId: null }))).toBeNull();
    // `settled` is organisational, not a statement that the run ended: a settled thread whose run is
    // still in flight still blocks (its worktree is not free because the human tidied the sidebar).
    expect(liveRunReason(threadOf({ settled: true }))).toContain("live run");
  });

  test("the API-client drain runs a t3 row HERE: nothing is deferred (1120)", () => {
    const cfg: SpinoffLaunchConfig = { repoCheckouts: {}, launcher: "t3", launcherByRepo: {}, engine: "claude" };
    const t3Row = { repo: "/r", launcher: "t3" } as SpinoffRow;
    // The machine running a client drain IS the machine with T3 (the map's split), so a t3 row is ready
    // here. Deferring it would leave the row pending forever on the one machine that can launch it.
    expect(launchNotReadyIn(cfg, t3Row, [])).toBeNull();
  });

  test("the API-client drain's t3 launch opens a thread here, named from the wire, and hands the ids back (1120/1143)", async () => {
    const repo = trackedRepo();
    const worktree = trackedDir(`${repo}.1120`);
    const fake = fakeT3({ repoPath: repo });
    setT3Seam(fake.seam);
    const cfg: SpinoffLaunchConfig = { repoCheckouts: { omnislash: repo }, launcher: "t3", launcherByRepo: {}, engine: "claude" };
    const row = { id: 7, ticket_ref: "1120", repo: "omnislash", branch: "1120", worktree, brief: "do it", status: "launching", launcher: "t3", launch_attempts: 0 } as unknown as SpinoffRow;

    // 1143: a CLIENT drain has no store of its own, so the name arrives on the launchable row.
    const effect = await launchRowIn(cfg, T3_LAUNCHER, row, "See T3 from ob (read surface)");
    expect(effect.t3ThreadId).toBe("t3-1");
    expect(effect.t3RunId).toBe("run-1");
    expect(fake.launches[0]!.title).toBe("1120 · See T3 from ob (read surface)");
    expect(fake.launches[0]!.clientRequestId).toBe(clientRequestIdFor(7));
    // the thread is bound to the row's worktree, resolved through the config's checkout map
    expect(fake.launches[0]!.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: worktree, branch: "1120" });
    // no name on the wire -> the old fallback, never a broken title
    fake.threads.length = 0;
    await launchRowIn(cfg, T3_LAUNCHER, row, null);
    expect(fake.launches[1]!.title).toBe("1120");
  });
});

describe("t3 dispatch — launch + idempotent retry (1120)", () => {
  test("a t3 row launches a thread bound to its ob worktree, and the stamp records the ids", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const worktree = trackedDir(`${repo}.1120`);
    stubGit();
    const fake = fakeT3({ repoPath: repo });
    setT3Seam(fake.seam);
    const { row } = await enqueueSpinoff(db, { ticketRef: "1120", repo, branch: "1120", mode: "interactive", brief: "do the thing", launcher: "t3" });

    const res = await drainSpinoffs(db);
    expect(res.launched).toEqual(["1120"]);
    expect(res.failed).toEqual([]);

    const after = (await listSpinoffs(db))[0]!;
    expect(after.status).toBe("launched");
    expect(after.launcher).toBe(T3_LAUNCHER);
    expect(after.t3_thread_id).toBe("t3-1");
    expect(after.t3_run_id).toBe("run-1");

    expect(fake.launches).toHaveLength(1);
    const launch = fake.launches[0]!;
    // no ob item "1120" exists in this db, so the name falls back: branch IS the ref -> the number alone
    expect(launch.title).toBe("1120");
    expect(launch.message).toBe("do the thing");
    expect(launch.projectId).toBe(PROJECT_ID);
    expect(launch.runtimeMode).toBe(T3_DEFAULT_RUNTIME_MODE);
    expect(launch.workspaceStrategy).toEqual({ type: "existing_worktree", worktreePath: worktree, branch: "1120" });
    expect(launch.clientRequestId).toBe(clientRequestIdFor(row.id));

    // the agent row is registered against the thread id, under `launcher t3`
    const agent = await getAgent(db, "1120");
    expect(agent?.launcher).toBe(T3_LAUNCHER);
    expect(agent?.session_id).toBe("t3-1");
  });

  test("a real dispatch names the thread after the ticket's own ob title (1143)", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    stubGit();
    const fake = fakeT3({ repoPath: repo });
    setT3Seam(fake.seam);
    // THE NAME LIVES IN OB: the row's ticket is an ob item, and its title is what the sidebar should read.
    const ticketRef = await createItem(db, { type: "task", title: "Spinoff threads wear the ticket's name" });
    const branch = `${ticketRef}-names`;
    trackedDir(`${repo}.${branch}`);
    await enqueueSpinoff(db, { ticketRef, repo, branch, mode: "interactive", brief: "do the thing", launcher: "t3" });

    const res = await drainSpinoffs(db);
    expect(res.failed).toEqual([]);
    expect(fake.launches).toHaveLength(1);
    // The row carries the item's ref (1949), and the title leads with it.
    expect(fake.launches[0]!.title).toBe(`OB-1 · Spinoff threads wear the ticket's name`);
    // the ref is FIRST and stays the identity: the title is never parsed back into a ticket
    expect(fake.launches[0]!.title.startsWith(`OB-1 · `)).toBe(true);
  });

  test("a drain that dies between launch and stamp, then re-runs, leaves EXACTLY ONE thread", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    trackedDir(`${repo}.1120`);
    stubGit();
    const fake = fakeT3({ repoPath: repo });
    setT3Seam(fake.seam);
    await enqueueSpinoff(db, { ticketRef: "1120", repo, branch: "1120", mode: "interactive", brief: "do the thing", launcher: "t3" });

    // PASS 1: the launch happens, the database half does not (the drain "dies" between the two).
    const dyingSteps = { ...localSpinoffSteps(db), stamp: async () => "the server went away" };
    const first = await drainSpinoffs(db, "", {}, dyingSteps);
    expect(first.db_failures).toHaveLength(1);
    expect(fake.threads).toHaveLength(1);
    expect(fake.calls.launch).toBe(1);
    expect((await listSpinoffs(db))[0]!.status).toBe("launching");

    // The claim lapses (the TTL is what makes the reaper safe rather than racy), and reclaim re-queues it.
    db.query("UPDATE lease SET heartbeat_at = '2020-01-01T00:00:00.000Z' WHERE resource LIKE 'spinoff:%'").run();
    const reclaimed = await reclaimSpinoffs(db);
    expect(reclaimed).toEqual([{ id: 1, ticket: "1120", status: "pending", attempts: 1 }]);

    // PASS 2: the retry ADOPTS the thread pass 1 opened instead of opening a second one.
    const second = await drainSpinoffs(db);
    expect(second.launched).toEqual(["1120"]);
    expect(fake.calls.launch).toBe(1); // still one launch, ever
    expect(fake.threads).toHaveLength(1); // and exactly one thread exists

    const after = (await listSpinoffs(db))[0]!;
    expect(after.status).toBe("launched");
    expect(after.t3_thread_id).toBe("t3-1"); // the SAME thread pass 1 created
    expect(after.t3_run_id).toBe("run-1");
  });

  test("a machine with no T3 project, or no default model, fails the row with the remedy in the message", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    trackedDir(`${repo}.1120`);
    stubGit();
    const fake = fakeT3({ repoPath: "/r/somewhere-else" });
    setT3Seam(fake.seam);
    await enqueueSpinoff(db, { ticketRef: "1120", repo, branch: "1120", mode: "interactive", brief: "x", launcher: "t3" });
    const res = await drainSpinoffs(db);
    expect(res.failed[0]?.error).toContain("no T3 project is registered");
    expect(res.failed[0]?.error).toContain("t3 project add");
    expect(fake.calls.launch).toBe(0);
    expect((await listSpinoffs(db))[0]!.status).toBe("failed");

    const db2 = freshDb();
    const fake2 = fakeT3({ repoPath: repo, defaultModel: false });
    setT3Seam(fake2.seam);
    await enqueueSpinoff(db2, { ticketRef: "1120", repo, branch: "1120", mode: "interactive", brief: "x", launcher: "t3" });
    const res2 = await drainSpinoffs(db2);
    expect(res2.failed[0]?.error).toContain("no default model");
    expect(res2.failed[0]?.error).toContain("Project settings");
  });
});

describe("t3 dispatch — reconcile mirrors T3's run state (1120)", () => {
  async function launchedT3Row(db: ReturnType<typeof freshDb>, threadId: string): Promise<void> {
    await enqueueSpinoff(db, { ticketRef: "1120", repo: "/r/repo", branch: "1120", mode: "interactive", brief: "x", launcher: "t3" });
    db.query("UPDATE spinoff SET status = 'launched', launcher = 't3', agent_id = '1120', t3_thread_id = ? WHERE id = 1").run(threadId);
    await registerAgent(db, { id: "1120", ticket: "1120", branch: "1120", status: "working", launcher: "t3", sessionId: threadId, ttlS: 900 });
  }

  test("a live run is mirrored verbatim into `run`, and a pending question reads as `waiting`", async () => {
    const db = freshDb();
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-9", status: "running" })] });
    setT3Seam(fake.seam);
    await launchedT3Row(db, "t3-9");
    expect((await reconcileT3Runs(db)).mirrored).toEqual([{ ticket: "1120", threadId: "t3-9", status: "running" }]);
    expect((await getAgent(db, "1120"))?.run).toBe("running");
    expect((await getAgent(db, "1120"))?.status).toBe("working"); // the mirror never touches ob's word

    // ... and the agent's OWN register writes `status` without touching `run`: one writer per field (1189).
    await registerAgent(db, { id: "1120", status: "needs-human", ttlS: 900 });
    const both = await getAgent(db, "1120");
    expect(both?.status).toBe("needs-human");
    expect(both?.run).toBe("running");

    fake.threads[0]!.pendingRequestCount = 1;
    await reconcileT3Runs(db);
    expect((await getAgent(db, "1120"))?.run).toBe("waiting");

    fake.threads[0]!.pendingRequestCount = 0;
    fake.threads[0]!.status = "completed";
    fake.threads[0]!.activeRunId = null;
    await reconcileT3Runs(db);
    expect((await getAgent(db, "1120"))?.run).toBe("completed");
  });

  test("a status this build does not know is reported and written nowhere", async () => {
    const db = freshDb();
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-9", status: "teleporting" })] });
    setT3Seam(fake.seam);
    await launchedT3Row(db, "t3-9");
    const res = await reconcileT3Runs(db);
    expect(res.mirrored).toEqual([]);
    expect(res.skipped[0]?.reason).toContain("unknown thread status");
    const row = await getAgent(db, "1120");
    expect(row?.run).toBeNull(); // untouched
    expect(row?.status).toBe("working"); // and so is the agent's own word
  });

  test("a settled thread is still mirrored, and the spinoff QUEUE status is never touched", async () => {
    const db = freshDb();
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-9", status: "completed", activeRunId: null, settled: true })] });
    setT3Seam(fake.seam);
    await launchedT3Row(db, "t3-9");
    await reconcileT3Runs(db);
    expect((await getAgent(db, "1120"))?.run).toBe("completed");
    expect((await listSpinoffs(db))[0]!.status).toBe("launched"); // queue state is ob's, and unchanged
  });

  // OB-1923: the mirror's write is update-only, and liveness follows the run.
  test("a deleted agent gets no row back and is a named skip (store path)", async () => {
    const db = freshDb();
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-9", status: "running" })] });
    setT3Seam(fake.seam);
    await launchedT3Row(db, "t3-9");
    db.query("DELETE FROM agent WHERE id = '1120'").run();
    const res = await reconcileT3Runs(db);
    expect(res.mirrored).toEqual([]);
    expect(res.skipped).toEqual([{ ticket: "1120", reason: "no agent row '1120': the mirror never creates one" }]);
    expect(await getAgent(db, "1120")).toBeNull();
  });

  test("an active run moves heartbeat_at and a completed run does not (store path)", async () => {
    const db = freshDb();
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-9", status: "running" })] });
    setT3Seam(fake.seam);
    await launchedT3Row(db, "t3-9");
    const OLD = "2020-01-01T00:00:00.000Z";
    db.query("UPDATE agent SET heartbeat_at = ? WHERE id = '1120'").run(OLD);
    await reconcileT3Runs(db);
    expect((await getAgent(db, "1120"))?.heartbeat_at).not.toBe(OLD);

    db.query("UPDATE agent SET heartbeat_at = ? WHERE id = '1120'").run(OLD);
    fake.threads[0]!.status = "completed";
    fake.threads[0]!.activeRunId = null;
    await reconcileT3Runs(db);
    const row = await getAgent(db, "1120");
    expect(row?.run).toBe("completed");
    expect(row?.heartbeat_at).toBe(OLD);
  });

  test("a handed-off (ready-for-gate) t3 row is mirrored, a merged one is not read (store path)", async () => {
    const db = freshDb();
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-9", status: "running" })] });
    setT3Seam(fake.seam);
    await launchedT3Row(db, "t3-9");
    db.query("UPDATE spinoff SET status = 'ready-for-gate' WHERE id = 1").run();
    expect((await reconcileT3Runs(db)).mirrored).toEqual([{ ticket: "1120", threadId: "t3-9", status: "running" }]);
    expect((await getAgent(db, "1120"))?.run).toBe("running");
    expect((await listSpinoffs(db))[0]!.status).toBe("ready-for-gate"); // the row's own status is untouched

    db.query("UPDATE spinoff SET status = 'merged' WHERE id = 1").run();
    fake.threads[0]!.status = "completed";
    expect(await reconcileT3Runs(db)).toEqual({ mirrored: [], skipped: [] });
    expect((await getAgent(db, "1120"))?.run).toBe("running");
  });

  test("a refused run write is a named per-row skip, never a thrown sweep (OB-1923)", async () => {
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-9", status: "running" })] });
    const res = await mirrorT3Runs(
      [{ ticket: "1120", agentId: "1120", threadId: "t3-9" }],
      {
        read: async () => null,
        register: async () => {},
        setRun: async () => {
          throw new Error("'action' must be one of register|heartbeat|done");
        },
      },
      fake.seam,
    );
    expect(res.mirrored).toEqual([]);
    expect(res.skipped).toEqual([{ ticket: "1120", reason: "run not written for '1120': 'action' must be one of register|heartbeat|done" }]);
  });

  test("a machine with no t3 rows never reaches for a credential", async () => {
    const db = freshDb();
    // no seam override: the real seam would try to read ~/.omnislash/t3-mcp-credential.json
    expect(await reconcileT3Runs(db)).toEqual({ mirrored: [], skipped: [] });
    expect(await settleT3ThreadsForTicket(db, "1120")).toEqual([]);
    expect(await t3WorktreeHold(db, "/r/repo.1120")).toBeNull();
  });

  test("an unreachable T3 is REPORTED per row, never thrown: the queue sweep still runs", async () => {
    const db = freshDb();
    setT3Seam({
      ...fakeT3({ repoPath: "/r/repo" }).seam,
      read: async () => {
        throw new T3Error("unreachable", "T3 server not reachable at http://127.0.0.1:3773", "is T3 running?");
      },
    });
    await launchedT3Row(db, "t3-9");
    const res = await reconcileT3Runs(db);
    expect(res.mirrored).toEqual([]);
    expect(res.skipped[0]?.reason).toContain("unreadable");
    expect((await listSpinoffs(db))[0]!.status).toBe("launched");
  });
});

describe("t3 dispatch: a team thread's needs-human clears on the owner's next message (OB-1710)", () => {
  const STAMPED = "2026-10-30T10:00:00.000Z";
  const BEFORE = "2026-10-30T09:59:00.000Z";
  const AFTER = "2026-10-30T10:05:00.000Z";
  type Item = NonNullable<T3ThreadRead["items"]>[number];

  function message(over: Partial<Item> & { updatedAt: string }): Item {
    return { type: "user_message", createdBy: "user", creationSource: "web", ...over } as Item;
  }

  /** The fake T3 with a timeline on each thread: `read` honours `afterPosition`, as the real client does. */
  function withItems(fake: FakeT3, items: Item[]): T3Seam {
    return {
      ...fake.seam,
      read: async (threadId, o) => {
        const base = await fake.seam.read(threadId);
        const from = o?.afterPosition ?? 0;
        return { ...base, thread: { ...base.thread, itemCount: items.length }, items: items.slice(from, from + (o?.limit ?? 1)) };
      },
    };
  }

  async function roleRow(db: ReturnType<typeof freshDb>, id: string, status: string): Promise<void> {
    await registerAgent(db, { id, worktree: "/r/repo", status, launcher: "t3", sessionId: "t3-p", ttlS: 900 });
    db.query("UPDATE agent SET heartbeat_at = ? WHERE id = ?").run(STAMPED, id);
  }

  function setup(items: Item[]): { fake: FakeT3; seam: T3Seam } {
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-p", title: "🙋 omnislash · architect", status: "running" })] });
    return { fake, seam: withItems(fake, items) };
  }

  test("the architect row goes back to planning and the title loses its marker when he messaged after the stamp", async () => {
    const db = freshDb();
    const { fake, seam } = setup([message({ updatedAt: BEFORE }), message({ updatedAt: AFTER })]);
    await roleRow(db, "architect-omnislash", "needs-human");
    const res = await reconcileT3Runs(db, seam);
    expect(res.skipped).toEqual([]);
    const row = await getAgent(db, "architect-omnislash");
    expect(row?.status).toBe("planning");
    expect(row?.ttl_s).toBe(900); // the architect's own lease is not rewritten
    expect(fake.threads[0]!.title).toBe("omnislash · architect");
  });

  test("a builder's needs-human stays: only a team role row is cleared", async () => {
    const db = freshDb();
    const { fake, seam } = setup([message({ updatedAt: AFTER })]);
    await roleRow(db, "ob-1710", "needs-human");
    const res = await clearTeamNeedsHuman([(await getAgent(db, "ob-1710"))!], storeAgentRegistry(db), seam);
    expect(res).toEqual({ cleared: [], skipped: [] });
    expect((await getAgent(db, "ob-1710"))?.status).toBe("needs-human");
    expect(fake.threads[0]!.title).toBe("🙋 omnislash · architect");
  });

  test("a run that was not his message does not clear: a queued ob note, a scheduled watchdog, his message from before the stamp", async () => {
    for (const items of [
      [message({ updatedAt: AFTER, createdBy: "agent", creationSource: "mcp" })], // handoff/landed note
      [message({ updatedAt: AFTER, createdBy: "user", creationSource: "scheduled-task" })], // watchdog
      [message({ updatedAt: BEFORE })], // the message that started the stamping run
      [{ type: "assistant_message", createdBy: "agent", updatedAt: AFTER } as Item],
    ]) {
      const db = freshDb();
      const { fake, seam } = setup(items);
      await roleRow(db, "architect-omnislash", "needs-human");
      await reconcileT3Runs(db, seam);
      expect((await getAgent(db, "architect-omnislash"))?.status).toBe("needs-human");
      expect(fake.threads[0]!.title).toBe("🙋 omnislash · architect");
    }
  });

  test("an architect row that is not needs-human is left alone, and T3 is not even read", async () => {
    const db = freshDb();
    const { fake, seam } = setup([message({ updatedAt: AFTER })]);
    await roleRow(db, "architect-omnislash", "working");
    const before = fake.calls.read;
    await reconcileT3Runs(db, seam);
    expect((await getAgent(db, "architect-omnislash"))?.status).toBe("working");
    expect(fake.calls.read).toBe(before);
    expect(fake.calls.rename).toBe(0);
  });

  test("an unreadable architect thread is reported and the row keeps its status", async () => {
    const db = freshDb();
    const { seam } = setup([]);
    await roleRow(db, "architect-omnislash", "needs-human");
    const res = await reconcileT3Runs(db, { ...seam, read: async () => { throw new T3Error("unreachable", "T3 down"); } });
    expect(res.skipped[0]?.reason).toContain("unreadable");
    expect((await getAgent(db, "architect-omnislash"))?.status).toBe("needs-human");
  });
});

describe("t3 dispatch — settle on close, and the cleanup guard (1120)", () => {
  test("settling a ticket's threads settles each one, and reports a failure without throwing", async () => {
    const db = freshDb();
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-1" }), threadOf({ threadId: "t3-2" })] });
    setT3Seam(fake.seam);
    await enqueueSpinoff(db, { ticketRef: "1120", repo: "/r/repo", branch: "1120", mode: "interactive", brief: "x", launcher: "t3" });
    db.query("UPDATE spinoff SET status = 'launched', launcher = 't3', t3_thread_id = 't3-1' WHERE id = 1").run();
    // A second live row is written directly: the enqueue would reuse the first one.
    db.query("INSERT INTO spinoff (ticket_ref, repo, branch, worktree, mode, brief, status, request_at, launcher, t3_thread_id) SELECT ticket_ref, repo, branch, worktree, mode, brief, 'launched', request_at, 't3', 't3-2' FROM spinoff WHERE id = 1").run();

    const outcomes = await settleT3ThreadsForTicket(db, "1120");
    expect(outcomes.map((o) => [o.threadId, o.settled])).toEqual([["t3-1", true], ["t3-2", true]]);
    expect(fake.calls.settle).toBe(2);
    expect(fake.threads.every((t) => t.settled)).toBe(true);

    fake.failSettle = true;
    const failed = await settleT3ThreadsForTicket(db, "1120");
    expect(failed.map((o) => o.settled)).toEqual([false, false]);
    expect(failed[0]?.error).toContain("unavailable");
  });

  // -------------------------------------------------------------------------
  // 1163 — the row is joined to the closed ITEM, not to a string that happens
  // to match across two namespaces.
  // -------------------------------------------------------------------------

  /** Item 1134, whose record names the wayfinder ticket 1124 it mirrors — row 591's real shape. */
  function chartedMirror(db: ReturnType<typeof freshDb>) {
    const ts = "2026-10-17T20:00:00.000Z";
    db.query(
      "INSERT INTO item (id, type, title, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    ).run("1134", "task", "T3 integration P1", "wayfinder/tickets/1124-t3-read-surface.md — the read half", "open", ts, ts);
  }

  test("a hand-charted ticket settles the thread of the row dispatched under its WAYFINDER ref", async () => {
    const db = freshDb();
    chartedMirror(db);
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-1124" })] });
    setT3Seam(fake.seam);
    // Row 591's shape: dispatched as 1124, so `ticket_ref` is the wayfinder number and `item_id` is NULL
    // (queued before the identity column existed). Item 1134's record names that very ref.
    await enqueueSpinoff(db, { ticketRef: "1124", repo: "/r/repo", branch: "1124", mode: "interactive", brief: "x", launcher: "t3" });
    db.query("UPDATE spinoff SET status = 'launched', t3_thread_id = 't3-1124', item_id = NULL WHERE id = 1").run();

    const outcomes = await settleT3ThreadsForTicket(db, "1134");
    expect(outcomes.map((o) => [o.threadId, o.settled])).toEqual([["t3-1124", true]]);
    expect(fake.threads[0]!.settled).toBe(true);
    // What joined them: the closed item's own record names the ref the row carries. The OLD rule (the item
    // id compared to `ticket_ref` as strings) found nothing here, which is the bug this pins.
    expect(itemDispatchRefs({ id: "1134", body: "wayfinder/tickets/1124-t3-read-surface.md — the read half" })).toEqual([
      "1134",
      "1124",
    ]);
  });

  test("a row that RECORDS its item settles by that identity alone, whatever it was dispatched as", async () => {
    const db = freshDb();
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-1" })] });
    setT3Seam(fake.seam);
    await enqueueSpinoff(db, { ticketRef: "1124", repo: "/r/repo", branch: "1124", mode: "interactive", brief: "x", launcher: "t3" });
    db.query("UPDATE spinoff SET status = 'launched', t3_thread_id = 't3-1', item_id = '1134', ticket_ref = '1124' WHERE id = 1").run();

    const outcomes = await settleT3ThreadsForTicket(db, "1134");
    expect(outcomes.map((o) => o.threadId)).toEqual(["t3-1"]);
  });

  test("enqueue records the ob item a ref serves, and NULL when it serves none", async () => {
    const db = freshDb();
    chartedMirror(db);
    const ts = "2026-10-17T20:00:00.000Z";
    db.query("INSERT INTO item (id, type, title, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(
      "1142", "task", "The stamp route", null, "open", ts, ts,
    );
    // a hand-charted ticket dispatched by its wayfinder number: the mirror's id is what gets recorded
    const wayfinder = await enqueueSpinoff(db, { ticketRef: "1124", repo: "/r/repo", branch: "1124", mode: "interactive", brief: "x" });
    expect(wayfinder.row.item_id).toBe("1134");
    // the `ob add` numbering: the ref IS the item
    const byId = await enqueueSpinoff(db, { ticketRef: "1142", repo: "/r/repo", branch: "1142", mode: "interactive", brief: "x" });
    expect(byId.row.item_id).toBe("1142");
    // a ref the tracker does not hold records no identity rather than a guess
    const pinned = await enqueueSpinoff(db, { ticketRef: "CUE-9894", repo: "/r/repo", branch: "cue-9894", mode: "interactive", brief: "x" });
    expect(pinned.row.item_id).toBeNull();
  });

  test("a close that joins nothing SAYS so, when the ticket's record shows it was dispatched", async () => {
    const db = freshDb();
    chartedMirror(db);
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-other" })] });
    setT3Seam(fake.seam);
    // A thread exists on this machine (so silence would read as "nothing to settle"), but no row serves
    // item 1134: the old failure was this exact shape reporting nothing at all.
    await enqueueSpinoff(db, { ticketRef: "9999", repo: "/r/repo", branch: "9999", mode: "interactive", brief: "x", launcher: "t3" });
    db.query("UPDATE spinoff SET status = 'launched', t3_thread_id = 't3-other' WHERE id = 1").run();

    expect(await settleT3ThreadsForTicket(db, "1134")).toEqual([]);
    const line = await unjoinedSettleWarning(db, "1134");
    expect(line).toContain("1134");
    expect(line).toContain('"1124"');
    expect(line).toContain("settled nothing");
  });

  test("silence stays the right answer for a machine that never launched, and for a plain ticket", async () => {
    const db = freshDb();
    chartedMirror(db);
    // no thread anywhere: a fleet that never used the launcher hears nothing
    expect(await unjoinedSettleWarning(db, "1134")).toBeNull();
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-other" })] });
    setT3Seam(fake.seam);
    await enqueueSpinoff(db, { ticketRef: "9999", repo: "/r/repo", branch: "9999", mode: "interactive", brief: "x", launcher: "t3" });
    db.query("UPDATE spinoff SET status = 'launched', t3_thread_id = 't3-other' WHERE id = 1").run();
    // a plain `ob add` ticket's ref IS its id, so a miss means it was never dispatched — no line.
    const ts = "2026-10-17T20:00:00.000Z";
    db.query("INSERT INTO item (id, type, title, body, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(
      "1142", "task", "The stamp route", "no ticket path here", "open", ts, ts,
    );
    expect(await unjoinedSettleWarning(db, "1142")).toBeNull();
  });

  test("a close that could not READ the item says that, rather than reporting nothing", async () => {
    const db = freshDb();
    const fake = fakeT3({ repoPath: "/r/repo", threads: [threadOf({ threadId: "t3-other" })] });
    setT3Seam(fake.seam);
    await enqueueSpinoff(db, { ticketRef: "9999", repo: "/r/repo", branch: "9999", mode: "interactive", brief: "x", launcher: "t3" });
    db.query("UPDATE spinoff SET status = 'launched', t3_thread_id = 't3-other' WHERE id = 1").run();
    // The item read cannot answer (the table is gone): a FAILED join must not read as "no row serves it",
    // because only the second of those means there was nothing to join.
    db.exec("DROP TABLE item");
    const line = await unjoinedSettleWarning(db, "1134");
    expect(line).toContain("could not be joined");
    expect(line).toContain("1134");
  });

  test("a worktree whose thread is mid-run is refused; settling the thread releases it", async () => {
    const db = freshDb();
    const repo = "/r/repo";
    const wt = `${repo}.1120`;
    const fake = fakeT3({ repoPath: repo, threads: [threadOf({ threadId: "t3-1", worktreePath: wt, status: "running" })] });
    setT3Seam(fake.seam);
    await enqueueSpinoff(db, { ticketRef: "1120", repo, branch: "1120", mode: "interactive", brief: "x", launcher: "t3", worktree: wt });
    db.query("UPDATE spinoff SET status = 'launched', launcher = 't3', t3_thread_id = 't3-1' WHERE id = 1").run();

    expect(await t3WorktreeHold(db, wt)).toContain("live run");
    expect(await t3WorktreeHold(db, `${repo}.other`)).toBeNull(); // another worktree is none of its business

    fake.threads[0]!.settled = true;
    fake.threads[0]!.activeRunId = null;
    expect(await t3WorktreeHold(db, wt)).toBeNull();
  });

  test("`spinoff cleanup` skips the live thread's worktree, even with --force, and removes it once settled", async () => {
    const db = freshDb();
    const repo = "/r/repo";
    const wt = `${repo}.1120`;
    const fake = fakeT3({ repoPath: repo, threads: [threadOf({ threadId: "t3-1", worktreePath: wt, status: "running" })] });
    setT3Seam(fake.seam);
    await enqueueSpinoff(db, { ticketRef: "1120", repo, branch: "1120", mode: "interactive", brief: "x", launcher: "t3", worktree: wt });
    // OB-2159: a live row (building) is now skipped by its own guard before T3 is asked, so the row here is
    // landed: the thread guard is what holds a landed row's checkout while its thread is still mid-run.
    db.query("UPDATE spinoff SET status = 'merged', launcher = 't3', t3_thread_id = 't3-1' WHERE id = 1").run();

    const mutations: string[][] = [];
    setSh((cmd) => {
      if (cmd[0] === "ps") return { ok: true, err: "", out: psTable() };
      if (cmd.includes("status") && cmd.includes("--porcelain")) return { ok: true, err: "", out: "" };
      if (cmd.includes("worktree") && cmd.includes("list")) return { ok: true, err: "", out: `worktree ${repo}\nHEAD x\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD y\nbranch refs/heads/1120` };
      if (cmd.includes("branch") && cmd.includes("--merged")) return { ok: true, err: "", out: "main\n1120" };
      if (cmd.includes("for-each-ref")) return { ok: true, err: "", out: "main\n1120" };
      if (cmd.includes("rev-parse") && cmd.includes("refs/remotes/origin/main^{commit}")) return { ok: true, err: "", out: "" }; // (1760) mainRefFor: no origin/main, local main
      mutations.push(cmd);
      return { ok: true, err: "", out: "" };
    });

    const forced = await cleanupWorktrees(db, { repo, force: true });
    expect(forced.skipped.find((e) => e.path === wt)?.reason).toContain("live run");
    expect(forced.removed.some((e) => e.path === wt)).toBe(false);
    expect(mutations).toHaveLength(0);

    // The run ends and T3 settles the thread: now nothing holds the worktree (git state still decides).
    fake.threads[0]!.settled = true;
    fake.threads[0]!.status = "completed";
    fake.threads[0]!.activeRunId = null;
    const after = await cleanupWorktrees(db, { repo });
    expect(after.removed.some((e) => e.path === wt)).toBe(true);
    expect(mutations.some((m) => m.includes("worktree") && m.includes("remove"))).toBe(true);
  });
});

describe("t3 dispatch: a team role thread (1120, OB-2255)", () => {
  const OMNISLASH = { name: "omnislash", icon: null, display_name: null };
  test("`ob t3 architect` twice yields ONE thread; a settled architect is replaced", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const fake = fakeT3({ repoPath: repo });
    setT3Seam(fake.seam);

    const first = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo });
    expect(first.created).toBe(true);
    expect(fake.threads).toHaveLength(1);
    expect(fake.threads[0]!.title).toBe("omnislash · architect");
    // the launch seeds the role, orient-only
    expect(fake.launches[0]!.message!.split("\n")[0]).toBe("/ob-architect");
    expect(fake.launches[0]!.message).toContain("ob t3 team show omnislash");
    expect(fake.pinned).toEqual([first.threadId]);
    expect(fake.launches[0]!.workspaceStrategy).toEqual({ type: "root" });

    const second = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo });
    expect(second.created).toBe(false);
    expect(second.threadId).toBe(first.threadId);
    expect(second.message).toContain("already live");
    expect(fake.threads).toHaveLength(1);
    expect(fake.calls.launch).toBe(1);
    // OB-2255: every team thread is pinned, and a re-run pins it again (idempotent in T3)
    expect(fake.pinned).toEqual([first.threadId, first.threadId]);
    expect(fake.calls.unpin).toBe(0);

    // the thread id is on the registry row, which is what makes the second call idempotent
    const agent = await getAgent(db, "architect-omnislash");
    expect(agent?.launcher).toBe(T3_LAUNCHER);
    expect(agent?.session_id).toBe(first.threadId);

    // settled → it has left the active list, so an architect the human can see is created again
    fake.threads[0]!.settled = true;
    const third = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo });
    expect(third.created).toBe(true);
    expect(fake.threads).toHaveLength(2);
    expect((await getAgent(db, "architect-omnislash"))?.session_id).toBe(third.threadId);
  });

  test("an architect whose recorded thread T3 no longer knows is replaced, not refused forever", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const fake = fakeT3({ repoPath: repo });
    setT3Seam(fake.seam);
    await registerAgent(db, { id: "architect-omnislash", status: "planning", launcher: T3_LAUNCHER, sessionId: "t3-gone", ttlS: 900 });
    const outcome = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo });
    expect(outcome.created).toBe(true);
    expect(outcome.threadId).not.toBe("t3-gone");
  });

  test("a PRE-1120 architect row (a session id that is not a thread) does not get asked of T3 (1120)", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const fake = fakeT3({ repoPath: repo });
    const read = fake.seam.read;
    const readIds: string[] = [];
    fake.seam.read = (id, o) => (readIds.push(id), read(id, o));
    setT3Seam(fake.seam);
    // The terminal architect's row carried an opencode `ses_…` session under `launcher` unset/opencode.
    await registerAgent(db, { id: "architect-omnislash", status: "planning", sessionId: "ses_notathread", ttlS: 900 });
    const outcome = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo });
    expect(outcome.created).toBe(true);
    // never asked T3 about a session id that is not a thread; the one read is OB-2128's check of the new one
    expect(readIds).toEqual([outcome.threadId]);
    expect((await getAgent(db, "architect-omnislash"))?.session_id).toBe(outcome.threadId);
  });

  test("an architect creation that never recorded its id REFUSES instead of opening a second thread (1120)", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const fake = fakeT3({ repoPath: repo });
    setT3Seam(fake.seam);
    // The marker the command writes before it launches: launcher `t3`, no thread id yet (1189 dropped the
    // `launching` status — the absence of a session id IS the marker). This is what a crashed/API-blipped
    // creation leaves behind, and a legacy row that still holds `launching` refuses the same way.
    await registerAgent(db, { id: "architect-omnislash", worktree: repo, status: "planning", launcher: T3_LAUNCHER, ttlS: 900 });
    await expect(ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo })).rejects.toThrow(/never recorded its id/);
    expect(fake.calls.launch).toBe(0); // nothing was created while that intent is unresolved
    expect(fake.threads).toHaveLength(0);

    // Clearing the row is the documented remedy, and then it creates one.
    await doneAgent(db, "architect-omnislash");
    const outcome = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo });
    expect(outcome.created).toBe(true);
    expect(fake.threads).toHaveLength(1);
  });

  test("a HAND-registered architect row is not mistaken for a half-finished creation (1120)", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const fake = fakeT3({ repoPath: repo });
    setT3Seam(fake.seam);
    // `ob agent register --id architect-omnislash --status planning` is the documented manual registration and
    // carries no thread id either; it must not wedge the command.
    await registerAgent(db, { id: "architect-omnislash", status: "planning", ttlS: 900 });
    const outcome = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo });
    expect(outcome.created).toBe(true);
    expect(fake.threads).toHaveLength(1);
  });

  test("a new architect has auto-settle off, and a re-run asks again and still says so (OB-1845)", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const fake = fakeT3({ repoPath: repo });
    setT3Seam(fake.seam);

    const first = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo });
    expect(first).toMatchObject({ created: true, autoSettleOff: true, autoSettleWarning: null });
    expect(fake.autoSettleOff).toEqual([first.threadId]);
    expect(renderTeamThread(first, null)).toContain("auto-settle off");

    const second = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo });
    expect(second).toMatchObject({ created: false, autoSettleOff: true, autoSettleWarning: null });
    expect(fake.autoSettleOff).toEqual([first.threadId, first.threadId]);
    expect(renderTeamThread(second, null)).toContain("auto-settle off");
  });

  test("a T3 refusal leaves the title standing and names the thread and the sidebar fix (OB-1845)", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const fake = fakeT3({ repoPath: repo, threads: [threadOf({ threadId: "t3-p", title: "Old title", status: "idle" })] });
    fake.failAutoSettle = true;
    setT3Seam(fake.seam);
    await registerAgent(db, { id: "architect-omnislash", status: "planning", launcher: T3_LAUNCHER, sessionId: "t3-p", ttlS: 900 });

    const outcome = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo });
    expect(fake.threads[0]!.title).toBe("omnislash · architect");
    expect(outcome.autoSettleOff).toBe(false);
    expect(outcome.autoSettleWarning).toContain("t3-p");
    expect(outcome.autoSettleWarning).toContain("route gone");
    expect(outcome.autoSettleWarning).toContain("Auto-settle behavior, Disabled");
    const rendered = renderTeamThread(outcome, null);
    expect(rendered).toContain("auto-settle NOT off");
    expect(rendered).not.toContain("auto-settle off");
  });

  test("a live architect T3 titled something else is retitled `<slug> · architect`, idempotently (1414)", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const fake = fakeT3({ repoPath: repo, threads: [threadOf({ threadId: "t3-p", title: "Wire OB Architect Into a Repo", status: "idle" })] });
    setT3Seam(fake.seam);
    await registerAgent(db, { id: "architect-omnislash", status: "planning", launcher: T3_LAUNCHER, sessionId: "t3-p", ttlS: 900 });

    const first = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo });
    expect(first.created).toBe(false);
    expect(first.message).toContain("omnislash architect already live");
    expect(first.message).toContain("retitled 'omnislash · architect'");
    expect(fake.threads[0]!.title).toBe("omnislash · architect");

    const second = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo });
    expect(second.message).not.toContain("retitled");
    expect(fake.calls.rename).toBe(1);
    expect(fake.calls.launch).toBe(0);
  });

  test("the project's icon and display name title the architect, and a re-run retitles the retired planner title (OB-2116, OB-2255)", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const fake = fakeT3({ repoPath: repo, threads: [threadOf({ threadId: "t3-p", title: "pixelslash · planner", status: "idle" })] });
    setT3Seam(fake.seam);
    await registerAgent(db, { id: "architect-pixelslash", status: "planning", launcher: T3_LAUNCHER, sessionId: "t3-p", ttlS: 900 });
    const label = { icon: "🖼️", display_name: "PixelSlash" };
    const first = await ensureTeamThread(storeAgentRegistry(db), { team: { name: "pixelslash", ...label }, role: "architect", members: ["pixelslash"], repoPath: repo });
    expect(first.message).toContain("retitled '🖼️ PixelSlash · architect'");
    expect(first.title).toBe("🖼️ PixelSlash · architect");
    expect(fake.threads[0]!.title).toBe("🖼️ PixelSlash · architect");
    const second = await ensureTeamThread(storeAgentRegistry(db), { team: { name: "pixelslash", ...label }, role: "architect", members: ["pixelslash"], repoPath: repo });
    expect(second.message).not.toContain("retitled");
    expect(fake.calls.rename).toBe(1);
  });

  test("--thread ADOPTS the caller's live thread: recorded, pinned, retitled; then plain calls say already live (1414)", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const fake = fakeT3({ repoPath: repo, threads: [threadOf({ threadId: "t3-me", title: "Architect", status: "running" })] });
    setT3Seam(fake.seam);

    const adopted = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo, adoptThreadId: "t3-me" });
    expect(adopted.created).toBe(false);
    expect(adopted.threadId).toBe("t3-me");
    expect(adopted.message).toContain("omnislash architect adopted");
    expect(fake.autoSettleOff).toEqual(["t3-me"]); // OB-1845: how a live architect gets repaired
    expect(fake.calls.launch).toBe(0);
    expect(fake.calls.send).toBe(0); // 1458: an adopted thread is never seeded
    // OB-2255: an adopted team thread is pinned
    expect(fake.pinned).toEqual(["t3-me"]);
    expect(fake.calls.unpin).toBe(0);
    expect(fake.threads[0]!.title).toBe("omnislash · architect");
    const agent = await getAgent(db, "architect-omnislash");
    expect(agent?.launcher).toBe(T3_LAUNCHER);
    expect(agent?.session_id).toBe("t3-me");
    expect(agent?.status).toBe("planning");

    // the acceptance line: a plain call (and a repeated adopt of the same id) is the idempotent no-op
    for (const adoptThreadId of [undefined, "t3-me"]) {
      const again = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo, adoptThreadId });
      expect(again.message).toMatch(/^omnislash architect already live: architect-omnislash → t3-me .*nothing created$/);
    }
    expect(fake.calls.rename).toBe(1);
  });

  test("--thread refuses a thread that is not live, and refuses to unseat a DIFFERENT live architect (1414)", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const fake = fakeT3({
      repoPath: repo,
      threads: [threadOf({ threadId: "t3-old", title: "omnislash · architect", status: "idle" }), threadOf({ threadId: "t3-done", settled: true })],
    });
    setT3Seam(fake.seam);
    await expect(ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo, adoptThreadId: "t3-done" })).rejects.toThrow(/not a live T3 thread/);
    await expect(ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo, adoptThreadId: "t3-nope" })).rejects.toThrow(/not a live T3 thread/);
    expect(await getAgent(db, "architect-omnislash")).toBeNull();

    await registerAgent(db, { id: "architect-omnislash", status: "planning", launcher: T3_LAUNCHER, sessionId: "t3-old", ttlS: 900 });
    fake.threads.push(threadOf({ threadId: "t3-new", title: "x", status: "idle" }));
    await expect(ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo, adoptThreadId: "t3-new" })).rejects.toThrow(/already live in thread t3-old/);
    expect((await getAgent(db, "architect-omnislash"))?.session_id).toBe("t3-old");

    // once the old architect is settled, the adopt goes through
    fake.threads[0]!.settled = true;
    const adopted = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo, adoptThreadId: "t3-new" });
    expect(adopted.threadId).toBe("t3-new");
    expect((await getAgent(db, "architect-omnislash"))?.session_id).toBe("t3-new");
    expect(fake.calls.launch).toBe(0);
  });

  test("no project / no default model refuse the architect by name, creating nothing", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const fake = fakeT3({ repoPath: "/r/elsewhere" });
    setT3Seam(fake.seam);
    await expect(ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo })).rejects.toThrow(/no T3 project is registered/);

    const db2 = freshDb();
    const fake2 = fakeT3({ repoPath: repo, defaultModel: false });
    setT3Seam(fake2.seam);
    await expect(ensureTeamThread(storeAgentRegistry(db2), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo })).rejects.toThrow(/no default model/);
    expect(fake2.calls.launch).toBe(0);
  });

  test("OS-145: `ob models use claude` changes the server's active, and a role thread opens on that profile's role.architect", async () => {
    const repo = trackedRepo();
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const antigravityProvider = [{ providerInstanceId: "antigravity", displayName: "Antigravity", models: [{ id: "gemini-4-neon" }], constraints: [] }];
    expect((await runCli(dbPath, ["models", "set", "role.architect", "antigravity:gemini-4-neon", "--profile", "neon"])).code).toBe(0);
    expect((await runCli(dbPath, ["models", "set", "role.architect", "claudeAgent:claude-sonnet-5-5", "--profile", "claude"])).code).toBe(0);
    expect((await runCli(dbPath, ["models", "use", "neon"])).code).toBe(0);
    const used = await runCli(dbPath, ["models", "use", "claude"]);
    expect(used.code).toBe(0);
    expect(used.out).toContain("active profile: claude on the server (was neon)");
    expect(JSON.parse((await getConfig(db, "model_routes"))!).active).toBe("claude");

    const fake = fakeT3({ repoPath: repo, extraProviders: antigravityProvider });
    setT3Seam(fake.seam);
    const roleModel = await teamRoleModelFrom(storeConfigIo(db), "architect");
    expect(roleModel).toBe("claudeAgent:claude-sonnet-5-5");
    const out = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo, roleModel });
    expect(out.created).toBe(true);
    expect(fake.launches[0]!.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-5-5" });
    db.close();
  });

  test("OS-129: opens on the active profile's builder.complex model and falls back to the project default when unusable", async () => {
    const saved = process.env.OB_MODELS_FILE;
    const dir = trackedDir(mkdtempSync(join(tmpdir(), "ob-team-models-")));
    try {
      const repo = trackedRepo();
      const modelsPath = join(dir, "models.jsonc");
      writeFileSync(
        modelsPath,
        JSON.stringify({
          active: "antigravity",
          profiles: { antigravity: { builder: { complex: "antigravity:gemini-4-neon" } } },
        }),
      );
      process.env.OB_MODELS_FILE = modelsPath;

      // Opens on antigravity:gemini-4-neon even when the project default is Claude or absent
      const antigravityProvider = [{ providerInstanceId: "antigravity", displayName: "Antigravity", models: [{ id: "gemini-4-neon" }], constraints: [] }];
      for (const defaultModel of [true, false]) {
        const db = freshDb();
        const fake = fakeT3({ repoPath: repo, defaultModel, extraProviders: antigravityProvider });
        setT3Seam(fake.seam);
        const roleModel = await teamRoleModelFrom(null, "muse"); // role.* follows builder.complex (OS-145)
        const out = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "muse", members: ["omnislash"], repoPath: repo, roleModel });
        expect(out.created).toBe(true);
        expect(fake.launches[0]!.modelSelection).toEqual({ instanceId: "antigravity", model: "gemini-4-neon" });
      }

      // With no usable models file, keeps the project default
      process.env.OB_MODELS_FILE = join(dir, "missing.jsonc");
      const db = freshDb();
      const fake = fakeT3({ repoPath: repo, extraProviders: antigravityProvider });
      setT3Seam(fake.seam);
      const roleModel = await teamRoleModelFrom(null, "architect");
      expect(roleModel).toBeUndefined();
      const out = await ensureTeamThread(storeAgentRegistry(db), { team: OMNISLASH, role: "architect", members: ["omnislash"], repoPath: repo, roleModel });
      expect(out.created).toBe(true);
      expect(fake.launches[0]!.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
    } finally {
      if (saved === undefined) delete process.env.OB_MODELS_FILE;
      else process.env.OB_MODELS_FILE = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// 1480: the complexity tier picks the builder's model
// ---------------------------------------------------------------------------

describe("spinoff tier → model (1480)", () => {
  /**
   * Enqueue through the real CLI (`spinoff queue`, so the drain's failure list carries the reason), then
   * drain, with T3 and git faked. Returns the launch and the row.
   */
  async function dispatch(tierArgs: string[], opts: { catalog?: string[]; tierModels?: string } = {}) {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const repo = trackedRepo();
    trackedDir(`${repo}.999`);
    stubGit();
    const fake = fakeT3({ repoPath: repo, catalog: opts.catalog });
    setT3Seam(fake.seam);
    if (opts.tierModels !== undefined) await setConfig(db, "spinoff_tier_models", opts.tierModels);
    const queued = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "999", "--repo", repo, "--launcher", "t3", "--brief", "do it", ...tierArgs]);
    const drained = queued.code === 0 ? await drainSpinoffs(db) : null;
    const row = (await listSpinoffs(db))[0] ?? null;
    return { db, dbPath, fake, queued, drained, row };
  }

  test("--tier simple launches on Haiku, medium on Sonnet, complex on Opus — on the project's own instance", async () => {
    for (const [tier, model] of [["simple", "claude-haiku-5-5"], ["medium", "claude-sonnet-5-5"], ["complex", "claude-opus-5-5"]] as const) {
      const { fake, queued, drained, row, db } = await dispatch(["--tier", tier]);
      expect(queued.code).toBe(0);
      expect(queued.out).toContain(`tier: ${tier}`);
      expect(queued.out).not.toContain("(default)");
      expect(drained!.failed).toEqual([]);
      expect(fake.launches).toHaveLength(1);
      expect(fake.launches[0]!.modelSelection).toEqual({ instanceId: "claudeAgent", model });
      expect(row!.tier).toBe(tier);
      expect(row!.model).toBe(model); // stamped with the model actually used
      db.close();
      restoreSeam?.();
      restoreSh?.();
    }
  });

  test("no --tier → medium (Sonnet), and the queue line says it was the default", async () => {
    const { fake, queued, row, dbPath, db } = await dispatch([]);
    expect(queued.out).toContain("tier: medium (default)");
    expect(fake.launches[0]!.modelSelection.model).toBe("claude-sonnet-5-5");
    expect(row!.tier).toBe("medium");
    expect(row!.model).toBe("claude-sonnet-5-5");
    // `ob spinoff show` prints both
    const shown = await runCli(dbPath, ["spinoff", "show", String(row!.id)]);
    expect(shown.out).toContain("tier:      medium");
    expect(shown.out).toContain("model:     claude-sonnet-5-5");
    // list and gateable carry them too
    expect((await runCli(dbPath, ["spinoff", "list"])).out).toContain("\tmedium\tclaude-sonnet-5-5\t");
    db.close();
  });

  test("an unknown tier is a named usage refusal, and nothing is queued", async () => {
    const { queued, row, db } = await dispatch(["--tier", "huge"]);
    expect(queued.code).not.toBe(0);
    expect(queued.err).toContain("'huge' is not a tier");
    expect(queued.err).toContain("complex|medium|simple");
    expect(row).toBeNull();
    db.close();
  });

  test("a tier model the T3 catalog does not list is a NAMED refusal, never a fallback to the project default", async () => {
    const { fake, drained, row, db } = await dispatch(["--tier", "simple"], { catalog: ["claude-opus-5-5", "claude-sonnet-5-5"] });
    expect(fake.launches).toHaveLength(0);
    expect(drained!.failed).toHaveLength(1);
    expect(drained!.failed[0]!.error).toContain("does not list model 'claude-haiku-5-5'");
    expect(drained!.failed[0]!.error).toContain("tier simple");
    expect(drained!.failed[0]!.error).toContain("spinoff_tier_models");
    expect(row!.status).toBe("failed");
    expect(row!.model).toBeNull();
    db.close();
  });

  test("spinoff_tier_models overrides one tier and keeps the rest; a malformed map is a named refusal", async () => {
    const over = await dispatch(["--tier", "simple"], { tierModels: '{"simple":"claude-sonnet-5-5"}' });
    expect(over.fake.launches[0]!.modelSelection.model).toBe("claude-sonnet-5-5");
    over.db.close();
    restoreSeam?.();
    restoreSh?.();

    const bad = await dispatch(["--tier", "simple"], { tierModels: '{"tiny":"x"}' });
    expect(bad.fake.launches).toHaveLength(0);
    expect(bad.drained!.failed[0]!.error).toContain("'tiny', which is not a tier");
    bad.db.close();

    expect(parseTierModels("").models).toEqual({ ...DEFAULT_TIER_MODELS });
    expect(parseTierModels("{not json").error).toContain("not JSON");
    expect(parseTierModels('{"medium":7}').error).toContain("model id string");
  });

  test("re-dispatching a PENDING row with a tier re-rates it; without one it keeps its rating", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const first = await enqueueSpinoff(db, { ticketRef: "999", repo, branch: "999", mode: "interactive", brief: "b", tier: "simple" });
    expect(first.row.tier).toBe("simple");
    const raised = await enqueueSpinoff(db, { ticketRef: "999", repo, branch: "999", mode: "interactive", brief: "b", tier: "complex" });
    expect(raised.deduped).toBe(true);
    expect(raised.row.tier).toBe("complex");
    const kept = await enqueueSpinoff(db, { ticketRef: "999", repo, branch: "999", mode: "interactive", brief: "b" });
    expect(kept.row.tier).toBe("complex");
    expect((await listSpinoffs(db))[0]!.tier).toBe("complex");
  });

  test("a relaunch at a RAISED tier never adopts the stalled thread on the old model: it names the thread to settle", async () => {
    const repo = trackedRepo();
    const worktree = trackedDir(`${repo}.999`);
    const stalled = threadOf({ threadId: "t3-haiku", title: "999", worktreePath: worktree, model: "claude-haiku-5-5" });
    const fake = fakeT3({ repoPath: repo, threads: [stalled] });
    const row = { id: 5, ticket_ref: "999", repo, branch: "999", worktree, brief: "b", tier: "complex" };
    await expect(launchT3Spinoff(fake.seam, row, repo)).rejects.toThrow(/t3-haiku on claude-haiku-5-5.*tier complex \(claude-opus-5-5\).*settle that thread/);
    expect(fake.launches).toHaveLength(0);

    // once the old thread is settled, the same row launches fresh on Opus
    stalled.settled = true;
    const out = await launchT3Spinoff(fake.seam, row, repo);
    expect(out.adopted).toBe(false);
    expect(out.model).toBe("claude-opus-5-5");
    expect(fake.launches[0]!.modelSelection.model).toBe("claude-opus-5-5");

    // a same-model retry still ADOPTS (the 1120 idempotence is untouched)
    const again = await launchT3Spinoff(fake.seam, row, repo);
    expect(again.adopted).toBe(true);
    expect(again.model).toBe("claude-opus-5-5");
    expect(fake.launches).toHaveLength(1);
  });

  test("a row with no tier (queued before 0034) launches as medium; a recorded non-tier is refused by name", () => {
    expect(rowTier(null)).toBe("medium");
    expect(rowTier(undefined)).toBe("medium");
    expect(rowTier("simple")).toBe("simple");
    expect(() => rowTier("opus")).toThrow(/'opus' is not a tier/);
  });

  test("modelSelectionFor swaps only the model: the instance is the project's, and the catalog is checked", () => {
    const project: T3Project = { id: "p", title: "omnislash", workspaceRoot: "/r", defaultModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, deletedAt: null };
    const caps: T3Capabilities = {
      runtimeMode: "full-access",
      providers: [{ providerInstanceId: "claudeAgent", displayName: "Claude", models: [{ id: "claude-opus-5-5" }, { id: "claude-haiku-5-5" }], constraints: [] }],
    };
    expect(modelSelectionFor(project, caps, "claude-haiku-5-5").selection).toEqual({ instanceId: "claudeAgent", model: "claude-haiku-5-5" });
    expect(modelSelectionFor(project, caps, "claude-sonnet-5-5").error).toContain("does not list model 'claude-sonnet-5-5'");
    // no tier model → the project's own default, exactly as before (the architect thread's path)
    expect(modelSelectionFor(project, caps).selection?.model).toBe("claude-opus-5-5");
  });

  // 1549: a tier may name its provider — `<provider>:<model>` — to reach a model the project's own instance lacks
  const DEEPSEEK = "opencode-go/deepseek-v4.1-flash";
  const QUALIFIED = `opencode:${DEEPSEEK}`;

  test("splitTierModel: a bare id has no provider; the FIRST colon splits; an empty half is malformed", () => {
    expect(splitTierModel("claude-haiku-5-5")).toEqual({ providerInstanceId: null, model: "claude-haiku-5-5" });
    expect(splitTierModel(QUALIFIED)).toEqual({ providerInstanceId: "opencode", model: DEEPSEEK });
    expect(splitTierModel("a:b:c")).toEqual({ providerInstanceId: "a", model: "b:c" });
    expect(splitTierModel(":x")).toBeNull();
    expect(splitTierModel("x:")).toBeNull();
  });

  test("parseTierModels accepts a qualified value and names an empty provider or model", () => {
    expect(parseTierModels(`{"simple":"${QUALIFIED}"}`).models.simple).toBe(QUALIFIED);
    expect(parseTierModels('{"simple":":x"}').error).toContain("has an empty provider");
    expect(parseTierModels('{"simple":"opencode:"}').error).toContain("spinoff_tier_models.simple");
    expect(parseTierModels('{"simple":"opencode:"}').error).toContain("has an empty model");
  });

  test("a qualified tier model launches on THAT provider, and the row stamps the qualified id", async () => {
    const { fake, drained, row, dbPath, db } = await dispatch(["--tier", "simple"], { tierModels: `{"simple":"${QUALIFIED}"}` });
    expect(drained!.failed).toEqual([]);
    expect(fake.launches).toHaveLength(1);
    expect(fake.launches[0]!.modelSelection).toEqual({ instanceId: "opencode", model: DEEPSEEK });
    expect(row!.model).toBe(QUALIFIED);
    const shown = await runCli(dbPath, ["spinoff", "show", String(row!.id)]);
    expect(shown.out).toContain(`model:     ${QUALIFIED}`);
    db.close();
  });

  test("a bare tier model still means the project's own provider, with the bare id stamped", async () => {
    const { fake, row, db } = await dispatch(["--tier", "simple"], { tierModels: '{"simple":"claude-sonnet-5-5"}' });
    expect(fake.launches[0]!.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-5-5" });
    expect(row!.model).toBe("claude-sonnet-5-5");
    db.close();
  });

  test("an unknown provider or an unlisted model on a known provider is a NAMED refusal that points at spinoff_tier_models", async () => {
    const noProvider = await dispatch(["--tier", "simple"], { tierModels: '{"simple":"nowhere:some-model"}' });
    expect(noProvider.fake.launches).toHaveLength(0);
    expect(noProvider.drained!.failed[0]!.error).toContain("does not advertise the provider instance 'nowhere'");
    expect(noProvider.drained!.failed[0]!.error).toContain("spinoff_tier_models.simple");
    expect(noProvider.row!.model).toBeNull();
    noProvider.db.close();
    restoreSeam?.();
    restoreSh?.();

    const noModel = await dispatch(["--tier", "simple"], { tierModels: '{"simple":"opencode:opencode-go/nope"}' });
    expect(noModel.fake.launches).toHaveLength(0);
    expect(noModel.drained!.failed[0]!.error).toContain("does not list model 'opencode-go/nope' on provider 'opencode'");
    expect(noModel.drained!.failed[0]!.error).toContain("spinoff_tier_models.simple");
    noModel.db.close();
  });

  test("modelSelectionFor with a named provider: no project default needed, a constrained provider is refused", () => {
    const noDefault: T3Project = { id: "p", title: "omnislash", workspaceRoot: "/r", defaultModelSelection: null, deletedAt: null };
    const caps = (constraints: string[]): T3Capabilities => ({
      runtimeMode: "full-access",
      providers: [{ providerInstanceId: "opencode", displayName: "OpenCode", models: [{ id: DEEPSEEK }], constraints }],
    });
    expect(modelSelectionFor(noDefault, caps([]), QUALIFIED)).toEqual({
      selection: { instanceId: "opencode", model: DEEPSEEK },
      error: null,
      stamp: QUALIFIED,
    });
    // a bare id still needs the project's default to say which provider
    expect(modelSelectionFor(noDefault, caps([]), DEEPSEEK).error).toContain("no default model");
    const refused = modelSelectionFor(noDefault, caps(["not signed in"]), QUALIFIED);
    expect(refused.selection).toBeNull();
    expect(refused.error).toContain("'opencode' unusable: not signed in");
    expect(refused.tierConfig).toBe(true);
  });

  test("a retry whose existing thread sits on the OTHER provider is refused; on the same provider it adopts with the qualified stamp", async () => {
    const repo = trackedRepo();
    const worktree = trackedDir(`${repo}.999`);
    const row = { id: 6, ticket_ref: "999", repo, branch: "999", worktree, brief: "b", tier: "simple" };
    const tierModels = { ...DEFAULT_TIER_MODELS, simple: QUALIFIED };

    const onClaude = threadOf({ threadId: "t3-claude", title: "999", worktreePath: worktree, model: DEEPSEEK, providerInstanceId: "claudeAgent" });
    const blocked = fakeT3({ repoPath: repo, threads: [onClaude] });
    await expect(launchT3Spinoff(blocked.seam, row, repo, undefined, tierModels)).rejects.toThrow(/t3-claude on claudeAgent:opencode-go\/deepseek-v4\.1-flash.*tier simple.*settle that thread/);
    expect(blocked.launches).toHaveLength(0);

    const onOpencode = threadOf({ threadId: "t3-ds", title: "999", worktreePath: worktree, model: DEEPSEEK, providerInstanceId: "opencode" });
    const same = fakeT3({ repoPath: repo, threads: [onOpencode] });
    const out = await launchT3Spinoff(same.seam, row, repo, undefined, tierModels);
    expect(out.adopted).toBe(true);
    expect(out.model).toBe(QUALIFIED);
    expect(same.launches).toHaveLength(0);
  });
});

describe("spinoff --effort (OB-1815)", () => {
  const SONNET = "claude-sonnet-5-5";
  const HAIKU = "claude-haiku-5-5";
  const DEEPSEEK_ID = "opencode-go/deepseek-v4.1-flash";
  const claudeOptions = { [SONNET]: [CLAUDE_EFFORT_OPTION] };

  type DispatchOpts = Omit<NonNullable<Parameters<typeof fakeT3>[0]>, "repoPath"> & { tierModels?: string; full?: boolean };

  /**
   * Run `ob spinoff` through the real CLI with T3 and git faked. `queue` (the default) only queues, so the
   * drain launches it; `full: true` is the whole `ob spinoff <ref>` an architect runs, which is where
   * `--effort` is checked BEFORE any row is queued.
   */
  async function dispatch(args: string[], opts: DispatchOpts = {}) {
    const { tierModels, full, ...t3opts } = opts;
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const repo = trackedRepo();
    trackedDir(`${repo}.999`);
    stubGit();
    const fake = fakeT3({ repoPath: repo, ...t3opts });
    setT3Seam(fake.seam);
    if (tierModels !== undefined) await setConfig(db, "spinoff_tier_models", tierModels);
    const verb = full ? [] : ["queue"];
    const queued = await runCli(dbPath, ["spinoff", ...verb, "--no-check", "a test fixture", "999", "--repo", repo, "--launcher", "t3", "--brief", "do it", ...args]);
    const drained = queued.code === 0 && !full ? await drainSpinoffs(db) : null;
    const row = (await listSpinoffs(db))[0] ?? null;
    return { db, dbPath, fake, queued, drained, row };
  }

  test("--effort high sends modelSelection.options and `show` prints the level", async () => {
    const { fake, queued, drained, row, dbPath, db } = await dispatch(["--tier", "medium", "--effort", "high"], { options: claudeOptions });
    expect(queued.code).toBe(0);
    expect(queued.out).toContain("effort: high");
    expect(drained!.failed).toEqual([]);
    expect(fake.launches[0]!.modelSelection).toEqual({ instanceId: "claudeAgent", model: SONNET, options: [{ id: "effort", value: "high" }] });
    expect(row!.effort).toBe("high");
    expect((await runCli(dbPath, ["spinoff", "show", String(row!.id)])).out).toContain("effort:    high");
    db.close();
  });

  test("no --effort sends no options, and `show` says what the model defaults to", async () => {
    const { fake, row, dbPath, db } = await dispatch([], { options: claudeOptions });
    expect(fake.launches[0]!.modelSelection).toEqual({ instanceId: "claudeAgent", model: SONNET });
    expect("options" in fake.launches[0]!.modelSelection).toBe(false);
    expect(row!.effort).toBe("default (high)");
    expect((await runCli(dbPath, ["spinoff", "show", String(row!.id)])).out).toContain("effort:    default (high)");
    db.close();
    restoreSeam?.();
    restoreSh?.();

    // a model that lists no default says so, rather than guessing one
    const none = await dispatch([], { options: { [SONNET]: [{ id: "effort", values: ["low", "high"] }] } });
    expect(none.row!.effort).toBe("default (none listed)");
    expect((await runCli(none.dbPath, ["spinoff", "show", String(none.row!.id)])).out).toContain("effort:    default (none listed)");
    none.db.close();
  });

  test("an OpenCode model takes its level as `variant`", async () => {
    const { fake, row, db } = await dispatch(["--tier", "simple", "--effort", "medium"], {
      tierModels: `{"simple":"opencode:${DEEPSEEK_ID}"}`,
      options: { [DEEPSEEK_ID]: [{ id: "variant", values: ["low", "medium", "high"], default: "low" }] },
    });
    expect(fake.launches[0]!.modelSelection).toEqual({ instanceId: "opencode", model: DEEPSEEK_ID, options: [{ id: "variant", value: "medium" }] });
    expect(row!.effort).toBe("medium");
    db.close();
  });

  test("--effort max on a model that does not list it refuses by name, and leaves no pending row", async () => {
    const { fake, queued, row, db } = await dispatch(["--tier", "medium", "--effort", "max"], { options: claudeOptions, full: true });
    expect(queued.code).not.toBe(0);
    expect(queued.err).toContain(`model '${SONNET}' does not list effort 'max'`);
    expect(queued.err).toContain("it lists low, medium, high, xhigh");
    expect(queued.err).not.toContain("ultrathink"); // a level the flag would refuse is not offered
    expect(queued.err).toContain("Nothing was queued");
    expect(row).toBeNull();
    expect(fake.launches).toHaveLength(0);
    db.close();
  });

  test("a model that lists no effort option at all refuses the flag by name", async () => {
    const { queued, row, db } = await dispatch(["--tier", "medium", "--effort", "high"], { full: true });
    expect(queued.code).not.toBe(0);
    expect(queued.err).toContain(`model '${SONNET}' lists no effort or variant option`);
    expect(row).toBeNull();
    db.close();
  });

  test("--effort ultrathink is refused at the flag, before T3 is asked", async () => {
    const { fake, queued, row, db } = await dispatch(["--effort", "ultrathink"], { options: claudeOptions });
    expect(queued.code).not.toBe(0);
    expect(queued.err).toContain("'ultrathink' is not an effort level");
    expect(queued.err).toContain("low|medium|high|xhigh|max");
    expect(row).toBeNull();
    expect(fake.searches).toEqual([]);
    db.close();
  });

  test("a model missing from T3's short list is found by a `search` call, not refused", async () => {
    const { fake, queued, drained, row, db } = await dispatch(["--tier", "simple", "--effort", "low"], {
      catalog: ["claude-opus-5-5", SONNET],
      omitted: { [HAIKU]: { providerInstanceId: "claudeAgent", options: [CLAUDE_EFFORT_OPTION] } },
    });
    expect(queued.code).toBe(0);
    expect(fake.searches).toContain(HAIKU);
    expect(drained!.failed).toEqual([]);
    expect(fake.launches[0]!.modelSelection).toEqual({ instanceId: "claudeAgent", model: HAIKU, options: [{ id: "effort", value: "low" }] });
    expect(row!.effort).toBe("low");
    db.close();
  });

  test("a model the search does not find is still the named 1480 refusal", async () => {
    const { fake, drained, db } = await dispatch(["--tier", "simple"], { catalog: ["claude-opus-5-5", SONNET] });
    expect(fake.searches).toContain(HAIKU);
    expect(fake.launches).toHaveLength(0);
    expect(drained!.failed[0]!.error).toContain(`does not list model '${HAIKU}'`);
    db.close();
  });

  test("a short list that already carries the model is never searched", async () => {
    const { fake, db } = await dispatch(["--tier", "medium"], { options: claudeOptions });
    expect(fake.searches).toEqual([]);
    db.close();
  });

  test("re-dispatching a PENDING row with --effort re-rates it; without one it keeps the rating", async () => {
    const db = freshDb();
    const repo = trackedRepo();
    const first = await enqueueSpinoff(db, { ticketRef: "999", repo, branch: "999", mode: "interactive", brief: "b", effort: "low" });
    expect(first.row.effort).toBe("low");
    const raised = await enqueueSpinoff(db, { ticketRef: "999", repo, branch: "999", mode: "interactive", brief: "b", effort: "xhigh" });
    expect(raised.deduped).toBe(true);
    expect(raised.row.effort).toBe("xhigh");
    const kept = await enqueueSpinoff(db, { ticketRef: "999", repo, branch: "999", mode: "interactive", brief: "b" });
    expect(kept.row.effort).toBe("xhigh");
    expect((await listSpinoffs(db))[0]!.effort).toBe("xhigh");
  });

  test("the recovery command a failed stamp prints survives a shell: `default (high)` is one word", () => {
    const line = shellWords(stampArgv({ id: 7, outcome: "launched", effort: "default (high)" }));
    expect(line).toContain("--effort 'default (high)'");
    expect(shellWords(["spinoff", "stamp", "--id", "7"])).toBe("spinoff stamp --id 7");
  });

  test("an adopted thread keeps its own effort: the stamp says so, never the level the row asked for, and nothing is relaunched", async () => {
    const repo = trackedRepo();
    const worktree = trackedDir(`${repo}.999`);
    const row = { id: 7, ticket_ref: "999", repo, branch: "999", worktree, brief: "b", tier: "medium", effort: "high" };
    const existing = threadOf({ threadId: "t3-old", title: "999", worktreePath: worktree, model: SONNET, providerInstanceId: "claudeAgent" });
    const fake = fakeT3({ repoPath: repo, threads: [existing], options: claudeOptions });
    const out = await launchT3Spinoff(fake.seam, row, repo);
    expect(out.adopted).toBe(true);
    expect(fake.launches).toHaveLength(0);
    expect(out.effort).toBe("default (adopted thread's own)");
  });
});

// ---------------------------------------------------------------------------
// OB-2107: Opus above its default effort only on the owner's explicit ask (--opus-high)
// ---------------------------------------------------------------------------

describe("spinoff --effort high on Opus needs --opus-high (OB-2107)", () => {
  const OPUS = "claude-opus-5-5";
  const HAIKU = "claude-haiku-5-5";
  const opusOptions = { [OPUS]: [CLAUDE_EFFORT_OPTION], [HAIKU]: [CLAUDE_EFFORT_OPTION] };
  // medium runs Opus on this machine, as `ob models show` says it does since OB-2106
  const OPUS_MEDIUM = `{"medium":"claudeAgent:${OPUS}"}`;

  /** The whole `ob spinoff <ref>` an architect runs, on a real item so the trail and the priority are real. */
  async function dispatchItem(args: string[], priority?: number, sub: string[] = []) {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const ref = await createItem(db, { type: "task", title: "an Opus build" });
    if (priority !== undefined) await editItem(db, ref, { priority });
    const repo = trackedRepo();
    const worktree = trackedDir(`${repo}.opus-build`);
    stubGit();
    const fake = fakeT3({ repoPath: repo, options: opusOptions });
    setT3Seam(fake.seam);
    await setConfig(db, "spinoff_tier_models", OPUS_MEDIUM);
    const r = await runCli(dbPath, ["spinoff", ...sub, "--no-check", "a test fixture", ref, "--repo", repo, "--worktree", worktree, "--launcher", "t3", "--brief", "do it", ...args]);
    const row = (await listSpinoffs(db))[0] ?? null;
    const trail = await decisionsForItem(db, ref);
    return { db, dbPath, fake, r, row, trail };
  }

  test.each([["high"], ["xhigh"], ["max"]] as const)("--tier medium --effort %s on Opus is refused by name, nothing queued", async (effort) => {
    const { db, fake, r, row } = await dispatchItem(["--tier", "medium", "--effort", effort]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("--opus-high");
    expect(r.err).toContain(`--effort ${effort}`);
    expect(r.err).toContain("Nothing was queued");
    expect(row).toBeNull();
    expect(fake.launches).toHaveLength(0);
    db.close();
  });

  test("an urgent ticket runs on complex (Opus) whatever --tier says, so --effort high is refused there too", async () => {
    const { db, r, row } = await dispatchItem(["--tier", "simple", "--effort", "high"], PRIORITY_URGENT);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("tier complex runs claude-opus-5-5");
    expect(row).toBeNull();
    db.close();
  });

  test("--opus-high '<his ask>' lets it through, and the quote is on the dispatch's trail note", async () => {
    const { db, fake, r, row, trail } = await dispatchItem(["--tier", "medium", "--effort", "high", "--opus-high", "run this one on high", "--note", "tier medium: a rename"]);
    expect(r.err).not.toContain("--opus-high");
    expect(r.code).toBe(0);
    expect(row!.effort).toBe("high");
    expect(fake.launches[0]!.modelSelection).toEqual({ instanceId: "claudeAgent", model: OPUS, options: [{ id: "effort", value: "high" }] });
    expect(trail.find((d) => d.to === "queued")?.note).toBe(`opus-high on the owner's ask: "run this one on high"; tier medium: a rename`);
    db.close();
  });

  test("--effort high on the simple (Haiku) tier is still accepted, no --opus-high needed", async () => {
    const { db, r, row } = await dispatchItem(["--tier", "simple", "--effort", "high"]);
    expect(r.code).toBe(0);
    expect(row!.effort).toBe("high");
    db.close();
  });

  test("`spinoff queue` runs the check too: refused without --opus-high, queued with it", async () => {
    const refused = await dispatchItem(["--tier", "medium", "--effort", "high"], undefined, ["queue"]);
    expect(refused.r.code).not.toBe(0);
    expect(refused.r.err).toContain("--opus-high");
    expect(refused.row).toBeNull();
    refused.db.close();
    const asked = await dispatchItem(["--tier", "medium", "--effort", "high", "--opus-high", "queue it high"], undefined, ["queue"]);
    expect(asked.r.code).toBe(0);
    expect(asked.row!.effort).toBe("high");
    expect(asked.trail.find((d) => d.to === "queued")?.note).toBe(`opus-high on the owner's ask: "queue it high"`);
    asked.db.close();
  });

  test("re-rating a pending row onto Opus keeps its effort, so a re-dispatch with no --effort is checked too", async () => {
    const first = await dispatchItem(["--tier", "simple", "--effort", "high"], undefined, ["queue"]);
    expect(first.r.code).toBe(0);
    expect(first.row!.tier).toBe("simple");
    const { db, row } = first;
    const again = (args: string[]) =>
      runCli(first.dbPath, ["spinoff", "queue", "--no-check", "a test fixture", row!.ticket_ref, "--repo", row!.repo, "--worktree", row!.worktree, "--launcher", "t3", "--brief", "do it", ...args]);
    const refused = await again(["--tier", "medium"]);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain("--opus-high");
    expect((await listSpinoffs(db))[0]!.tier).toBe("simple"); // left as it was
    const asked = await again(["--tier", "medium", "--opus-high", "re-rate it on high"]);
    expect(asked.code).toBe(0);
    const rerated = (await listSpinoffs(db))[0]!;
    expect(rerated.tier).toBe("medium");
    expect(rerated.effort).toBe("high");
    db.close();
  });

  test("a launch the urgent rule raised to Opus refuses an effort queued above its default", () => {
    const models = { complex: `claudeAgent:${OPUS}`, medium: `claudeAgent:${OPUS}`, simple: `claudeAgent:${HAIKU}` } as const;
    const raised = { ticket_ref: "OB-1", tier: "complex", effort: "high" };
    expect(() => refuseRaisedOpusHigh(raised, models, "simple")).toThrow(/urgent.*--opus-high/);
    expect(() => refuseRaisedOpusHigh(raised, models, null)).not.toThrow(); // not raised: checked at dispatch
    expect(() => refuseRaisedOpusHigh({ ...raised, effort: null }, models, "simple")).not.toThrow();
    expect(() => refuseRaisedOpusHigh({ ...raised, effort: "medium" }, models, "simple")).not.toThrow();
  });

  test("a model trial with an Opus leg on high needs --opus-high before a pair opens", () => {
    const plan = { a: { model: `claudeAgent:${OPUS}`, effort: "high" }, b: { model: `claudeAgent:${HAIKU}`, effort: "high" } };
    expect(() => refuseOpusHighTrial(plan, "medium", undefined)).toThrow(/model trial.*--opus-high/);
    expect(refuseOpusHighTrial(plan, "medium", "trial it high")).toBe(plan);
    expect(refuseOpusHighTrial({ ...plan, a: { model: OPUS, effort: null } }, "medium", undefined)).not.toBeNull();
    expect(refuseOpusHighTrial(null, "medium", undefined)).toBeNull();
  });

  test("the pure check: only Opus, only high and above, and an empty quote is no ask", () => {
    expect(opusHighRefusal(OPUS, "complex", "high", undefined)).toContain("--opus-high");
    expect(opusHighRefusal(`claudeAgent:${OPUS}`, "medium", "max", "  ")).toContain("--opus-high");
    expect(opusHighRefusal(OPUS, "complex", "medium", undefined)).toBeNull();
    expect(opusHighRefusal(OPUS, "complex", undefined, undefined)).toBeNull();
    expect(opusHighRefusal(HAIKU, "simple", "max", undefined)).toBeNull();
    expect(opusHighRefusal(OPUS, "complex", "xhigh", "he asked")).toBeNull();
    expect(withOpusHighNote(undefined, "go high")).toBe(`opus-high on the owner's ask: "go high"`);
    expect(withOpusHighNote("why", undefined)).toBe("why");
  });
});

// ---------------------------------------------------------------------------
// OB-1969: the machine's models file picks the builder model
// ---------------------------------------------------------------------------

describe("models file → builder model (OB-1969)", () => {
  const PROFILES = `// two accounts
{
  "active": "claude", // the first
  "profiles": {
    "claude": { "builder": { "simple": "claudeAgent:claude-haiku-5-5" } },
    "other":  { "builder": { "simple": "claudeAgent:claude-sonnet-5-5", "complex": "claudeAgent:claude-sonnet-5-5" } }
  }
}
`;
  let savedEnv: string | undefined;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OB_MODELS_FILE;
    else process.env.OB_MODELS_FILE = savedEnv;
  });

  function modelsFile(text: string | null): string {
    savedEnv = process.env.OB_MODELS_FILE;
    const dir = mkdtempSync(join(tmpdir(), "ob-models-"));
    const path = join(dir, "models.jsonc");
    if (text !== null) writeFileSync(path, text);
    process.env.OB_MODELS_FILE = path;
    return path;
  }

  async function dispatch(tier: string, opts: { catalog?: string[]; tierModels?: string; routes?: string } = {}) {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const repo = trackedRepo();
    trackedDir(`${repo}.999`);
    stubGit();
    const fake = fakeT3({ repoPath: repo, catalog: opts.catalog });
    setT3Seam(fake.seam);
    if (opts.tierModels !== undefined) await setConfig(db, "spinoff_tier_models", opts.tierModels);
    if (opts.routes !== undefined) await setConfig(db, "model_routes", opts.routes);
    const queued = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "999", "--repo", repo, "--launcher", "t3", "--brief", "do it", "--tier", tier]);
    const drained = queued.code === 0 ? await drainSpinoffs(db) : null;
    const row = (await listSpinoffs(db))[0] ?? null;
    return { db, fake, queued, drained, row, dbPath };
  }

  test("with a file, `ob models use X` then --tier simple launches on profile X's simple model, stamped on the row", async () => {
    const path = modelsFile(PROFILES);
    const before = await dispatch("simple");
    expect(before.fake.launches[0]!.modelSelection.model).toBe("claude-haiku-5-5");
    before.db.close();
    restoreSeam?.();
    restoreSh?.();

    // OS-145: `use` writes the server's active profile; a local `active` would win on this machine, so the
    // file here drops its own and the server's pick is the one in force.
    writeFileSync(path, readFileSync(path, "utf8").replace(/"active": "claude", \/\/ the first\n/, ""));
    const server = freshDbPath();
    const used = await runCli(server, ["models", "use", "other"]);
    expect(used.code).toBe(0);
    expect(readFileSync(path, "utf8")).not.toContain('"active"');
    const stored = openDb(server);
    expect(JSON.parse((await getConfig(stored, "model_routes"))!).active).toBe("other");

    const { fake, drained, row, db, dbPath } = await dispatch("simple", { routes: (await getConfig(stored, "model_routes"))! });
    stored.close();
    expect(drained!.failed).toEqual([]);
    expect(fake.launches[0]!.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-5-5" });
    expect(row!.model).toBe("claudeAgent:claude-sonnet-5-5"); // a provider-qualified tier is stamped qualified (1549)
    expect((await runCli(dbPath, ["spinoff", "show", String(row!.id)])).out).toContain("model:     claudeAgent:claude-sonnet-5-5");
    db.close();
  });

  test("the file wins over spinoff_tier_models for the tiers it names; a tier it leaves out keeps the setting", async () => {
    modelsFile(PROFILES); // active claude: names simple only
    const named = await dispatch("simple", { tierModels: '{"simple":"claude-opus-5-5","medium":"claude-haiku-5-5"}' });
    expect(named.fake.launches[0]!.modelSelection.model).toBe("claude-haiku-5-5");
    named.db.close();
    restoreSeam?.();
    restoreSh?.();
    const left = await dispatch("medium", { tierModels: '{"medium":"claude-haiku-5-5"}' });
    expect(left.fake.launches[0]!.modelSelection.model).toBe("claude-haiku-5-5");
    left.db.close();
  });

  test("a file that does not parse refuses the launch by name, never a fallback", async () => {
    const path = modelsFile("{ not json");
    const { fake, drained, row, db } = await dispatch("simple");
    expect(fake.launches).toHaveLength(0);
    expect(drained!.failed[0]!.error).toContain(path);
    expect(drained!.failed[0]!.error).toContain("not valid JSON");
    expect(row!.status).toBe("failed");
    db.close();
  });

  test("a model T3 does not list, taken from the file, is refused and the hint names the file", async () => {
    modelsFile(PROFILES);
    const { fake, drained, db } = await dispatch("simple", { catalog: ["claude-opus-5-5", "claude-sonnet-5-5"] });
    expect(fake.launches).toHaveLength(0);
    const err = drained!.failed[0]!.error;
    expect(err).toContain("does not list model 'claude-haiku-5-5'");
    expect(err).toContain("builder.simple in the active profile of the models file");
    db.close();
  });
});

// ---------------------------------------------------------------------------
// OB-1970: an out-of-credits account moves the launch to the next models profile
// ---------------------------------------------------------------------------

describe("credit error → next models profile (OB-1970)", () => {
  // `claude` builds medium on Sonnet, `other` on Haiku, `third` on Opus: the model says which profile ran.
  const PROFILES = `{
  "active": "claude",
  "fallback": ["claude", "other", "third"],
  "profiles": {
    "claude": { "builder": { "medium": "claudeAgent:claude-sonnet-5-5" } },
    "other":  { "builder": { "medium": "claudeAgent:claude-haiku-5-5" } },
    "third":  { "builder": { "medium": "claudeAgent:claude-opus-5-5" } }
  }
}
`;
  const CREDIT = () => new T3Error("refused", "Claude: Your credit balance is too low to access the API", undefined, "orchestration_error");

  let savedEnv: string | undefined;
  let stderr = "";
  let restoreStderr: (() => void) | null = null;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OB_MODELS_FILE;
    else process.env.OB_MODELS_FILE = savedEnv;
    restoreStderr?.();
    restoreStderr = null;
  });

  function modelsFile(text: string): string {
    savedEnv = process.env.OB_MODELS_FILE;
    const dir = trackedDir(mkdtempSync(join(tmpdir(), "ob-models-")));
    const path = join(dir, "models.jsonc");
    writeFileSync(path, text);
    process.env.OB_MODELS_FILE = path;
    return path;
  }

  function captureStderr(): void {
    stderr = "";
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stderr.write;
    restoreStderr = () => {
      process.stderr.write = write;
    };
  }

  /** Dispatch ticket 999 at medium; `refuse(model)` decides whether T3 refuses a launch on that model. */
  async function dispatch(refuse: (model: string) => Error | null) {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const repo = trackedRepo();
    trackedDir(`${repo}.999`);
    stubGit();
    const fake = fakeT3({ repoPath: repo });
    const attempts: string[] = [];
    const launch = fake.seam.launch;
    fake.seam = {
      ...fake.seam,
      launch: async (input) => {
        attempts.push(input.modelSelection.model);
        const err = refuse(input.modelSelection.model);
        if (err) throw err;
        return launch(input);
      },
    };
    setT3Seam(fake.seam);
    const queued = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", "999", "--repo", repo, "--launcher", "t3", "--brief", "do it", "--tier", "medium"]);
    expect(queued.code).toBe(0);
    captureStderr();
    const drained = await drainSpinoffs(db);
    restoreStderr?.();
    restoreStderr = null;
    const row = (await listSpinoffs(db))[0]!;
    return { db, dbPath, fake, attempts, drained, row };
  }

  test("a credit error on profile A relaunches on B, prints the named line and stamps B", async () => {
    modelsFile(PROFILES);
    const { db, fake, attempts, drained, row } = await dispatch((m) => (m === "claude-sonnet-5-5" ? CREDIT() : null));
    expect(attempts).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(drained.failed).toEqual([]);
    expect(fake.launches).toHaveLength(1);
    expect(row.status).toBe("launched");
    expect(row.model).toBe("claudeAgent:claude-haiku-5-5 (profile other)");
    expect(stderr).toContain("999: claudeAgent:claude-sonnet-5-5 (profile claude) out of credits, relaunched on claudeAgent:claude-haiku-5-5 (profile other)");
    expect(recentCreditHits()).toHaveProperty("claude");
    expect(rowProfiles(row.id)).toEqual(["claude|claudeAgent:claude-sonnet-5-5", "other|claudeAgent:claude-haiku-5-5"]);
    expect(stderr).toContain("route builder.medium: claudeAgent:claude-sonnet-5-5 -> claudeAgent:claude-haiku-5-5 (quota)");
    db.close();
  });

  test("OS-145: a quota move writes `route <name>: <from> -> <to> (quota)` on the ticket's Decisions trail; a non-quota error does not move", async () => {
    modelsFile(PROFILES);
    for (const [refuse, moved] of [
      [CREDIT, true],
      [() => new T3Error("refused", "overloaded", undefined, "orchestration_error"), false],
    ] as const) {
      const dbPath = freshDbPath();
      const db = openDb(dbPath);
      const ref = await createItem(db, { type: "task", title: "a routed build" });
      const repo = trackedRepo();
      const worktree = trackedDir(`${repo}.routed`);
      stubGit();
      const fake = fakeT3({ repoPath: repo });
      const launch = fake.seam.launch;
      setT3Seam({ ...fake.seam, launch: async (i) => (i.modelSelection.model === "claude-sonnet-5-5" ? Promise.reject(refuse()) : launch(i)) });
      const queued = await runCli(dbPath, ["spinoff", "queue", "--no-check", "a test fixture", ref, "--repo", repo, "--worktree", worktree, "--launcher", "t3", "--brief", "do it", "--tier", "medium"]);
      expect(queued.code).toBe(0);
      captureStderr();
      await drainSpinoffs(db);
      restoreStderr?.();
      restoreStderr = null;
      const notes = (await decisionsForItem(db, ref)).map((d) => d.note ?? "");
      const line = "route builder.medium: claudeAgent:claude-sonnet-5-5 -> claudeAgent:claude-haiku-5-5 (quota)";
      if (moved) {
        expect(notes).toContain(line);
        expect(fake.launches.map((l) => l.modelSelection.model)).toEqual(["claude-haiku-5-5"]);
      } else {
        expect(notes.some((n) => n.startsWith("route "))).toBe(false);
        expect(fake.launches).toHaveLength(0);
        expect((await listSpinoffs(db))[0]!.status).toBe("failed");
      }
      db.close();
      restoreSeam?.();
      restoreSh?.();
    }
  });

  test("a non-credit error never falls back: a rate limit or an outage fails the row on profile A", async () => {
    for (const err of [
      new T3Error("refused", "rate limit exceeded, retry in 30s", undefined, "rate_limit_error"),
      new T3Error("unreachable", "T3 down"),
      new T3Error("refused", "overloaded", undefined, "orchestration_error"),
    ]) {
      modelsFile(PROFILES);
      const { db, attempts, drained, row } = await dispatch((m) => (m === "claude-sonnet-5-5" ? err : null));
      expect(attempts).toEqual(["claude-sonnet-5-5"]);
      expect(row.status).toBe("failed");
      expect(drained.failed[0]!.error).toContain(err.message);
      expect(drained.failed[0]!.error).not.toContain("out of credits");
      expect(recentCreditHits()).toEqual({});
      db.close();
      restoreSeam?.();
      restoreSh?.();
    }
  });

  test("every profile out of credits fails the row by name, listing each profile tried", async () => {
    modelsFile(PROFILES);
    const { db, attempts, drained, row } = await dispatch(() => CREDIT());
    expect(attempts).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"]);
    expect(row.status).toBe("failed");
    const error = drained.failed[0]!.error;
    expect(error).toStartWith("blocked: every model on route builder.medium is out of credits for 999: tried claudeAgent:claude-sonnet-5-5 (profile claude) (");
    expect(error).toContain("; claudeAgent:claude-haiku-5-5 (profile other) (");
    expect(error).toContain("; claudeAgent:claude-opus-5-5 (profile third) (");
    expect(Object.keys(recentCreditHits()).sort()).toEqual(["claude", "other", "third"]);
    db.close();
  });

  test("no models file: a credit error fails the row exactly as before, no fallback", async () => {
    savedEnv = process.env.OB_MODELS_FILE;
    process.env.OB_MODELS_FILE = join(trackedDir(mkdtempSync(join(tmpdir(), "ob-models-"))), "absent.jsonc");
    const { db, attempts, row } = await dispatch(() => CREDIT());
    expect(attempts).toHaveLength(1);
    expect(row.status).toBe("failed");
    db.close();
  });

  /** A launched row whose first turn the mirror then reads as `failed` with `items` on its timeline. */
  async function failedFirstTurn(items: T3ThreadRead["items"], runs = 1) {
    modelsFile(PROFILES);
    const out = await dispatch(() => null);
    const thread = out.fake.threads[0]!;
    thread.status = "failed";
    thread.activeRunId = null;
    const read = out.fake.seam.read;
    out.fake.seam = {
      ...out.fake.seam,
      read: async (threadId, o) => {
        const base = await read(threadId, o);
        if (threadId !== thread.threadId) return base;
        return { ...base, items, recentRuns: Array.from({ length: runs }, (_, i) => ({ runId: `run-x${i}`, status: "failed" })) };
      },
    };
    setT3Seam(out.fake.seam);
    return out;
  }
  const creditItem = { position: 1, type: "error", status: "failed", title: "Provider error", text: "Claude: credit balance is too low" };

  test("a first turn that ends on a credit error is settled and relaunched on the next profile by the mirror", async () => {
    const { db, fake, row } = await failedFirstTurn([creditItem]);
    const mirror = await reconcileT3Runs(db);
    expect(mirror.mirrored.find((m) => m.threadId === "t3-1")?.status).toBe("failed");
    captureStderr();
    await relaunchCreditFailures(db, mirror.mirrored);
    expect(fake.threads[0]!.settled).toBe(true);
    expect(fake.launches).toHaveLength(2);
    expect(fake.launches[1]!.modelSelection.model).toBe("claude-haiku-5-5");
    const after = (await listSpinoffs(db)).find((r) => r.id === row.id)!;
    expect(after.status).toBe("launched");
    expect(after.t3_thread_id).toBe("t3-2");
    expect(after.model).toBe("claudeAgent:claude-haiku-5-5 (profile other)");
    expect(stderr).toContain("999: claudeAgent:claude-sonnet-5-5 (profile claude) out of credits, relaunched on claudeAgent:claude-haiku-5-5 (profile other)");
    db.close();
  });

  test("the mirror leaves a non-credit failure, or a failure after the first turn, alone", async () => {
    for (const [items, runs] of [
      [[{ ...creditItem, text: "Tool call failed: ENOENT" }], 1],
      [[creditItem], 2],
    ] as const) {
      const { db, fake, row } = await failedFirstTurn([...items], runs);
      const mirror = await reconcileT3Runs(db);
      await relaunchCreditFailures(db, mirror.mirrored);
      expect(fake.calls.settle).toBe(0);
      expect(fake.launches).toHaveLength(1);
      expect((await listSpinoffs(db)).find((r) => r.id === row.id)!.t3_thread_id).toBe("t3-1");
      db.close();
      restoreSeam?.();
      restoreSh?.();
    }
  });

  test("the mirror fails the row by name once its relaunch runs out of profiles", async () => {
    const { db, fake, row } = await failedFirstTurn([creditItem]);
    const launch = fake.seam.launch;
    setT3Seam({ ...fake.seam, launch: async (i) => (i.modelSelection.model === "claude-sonnet-5-5" ? launch(i) : Promise.reject(CREDIT())) });
    captureStderr();
    await relaunchCreditFailures(db, (await reconcileT3Runs(db)).mirrored);
    const after = (await listSpinoffs(db)).find((r) => r.id === row.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).toContain("blocked: every model on route builder.medium is out of credits for 999: tried claudeAgent:claude-sonnet-5-5 (profile claude) (first turn: message:");
    expect(after.error).toContain("(profile other) (");
    expect(after.error).toContain("(profile third) (");
    db.close();
  });
});

// Last in the file on purpose (OB-2145): bun runs every test file of a project in ONE process, in directory
// order, so a stub this file leaves installed is what the next file's real `git` calls get.
describe("t3 dispatch leaves the shell runner as it found it (OB-2145)", () => {
  test("after every test above, the real runner is installed", () => {
    expect(__shIsReal()).toBe(true);
  });
});

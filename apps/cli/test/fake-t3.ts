import { T3Error, type T3LaunchInput, type T3SendInput, type T3Thread } from "../src/t3/client.ts";
import { __setT3Seam, type T3Seam } from "../src/t3/dispatch.ts";

/**
 * A fake T3 for the tests that ENQUEUE a spinoff (1589). Since ob 1589 `ob spinoff <ref>` opens its T3
 * thread in the same invocation, so every such test needs a seam or it meets the preload's missing
 * credential. This is the smallest surface the launch path touches: one project per repo named, a Claude
 * catalog for the tier models, and threads that exist once launched. The richer fake in
 * `platform/cli-coord/test/t3-dispatch.test.ts` stays where the T3 behaviour itself is under test.
 */
export interface FakeT3Install {
  /** Every launch ob asked for, in order. */
  launches: T3LaunchInput[];
  /** Every thread id `pin` was called with (OB-2255: every team thread bind pins). */
  pinned: string[];
  /** Every thread id `unpin` was called with (OB-2255: a team role removed). */
  unpinned: string[];
  /** Every rename, in order. */
  renamed: Array<{ threadId: string; title: string }>;
  /** Every thread id `disableAutoSettle` was called with (OB-1845). */
  autoSettleOff: string[];
  threads: T3Thread[];
  /** Every send, in order (OS-56: a delivery into a role's run). */
  sends: T3SendInput[];
  /** Every thread id `interrupt` was called with (OS-259: a conflict's loser is stopped before it is told to wait). */
  interrupts: string[];
  restore: () => void;
}

/** What a fake model lists for effort (OB-1815): Claude's `effort`, T3's own `ultrathink` among the values. */
export const FAKE_EFFORT_OPTIONS = [{ id: "effort", values: ["low", "medium", "high", "xhigh", "ultrathink"], default: "high" }];

/**
 * `modelOptions` (OB-1815) gives named models the options they list; a model absent from it lists none, so a
 * test that never names `--effort` meets exactly the catalog it always did. `extraProviders` (OB-1991) adds
 * providers beside Claude, such as an OpenCode instance whose models list `variant`.
 */
export function installFakeT3(
  repoPaths: readonly string[],
  onLaunch?: (input: T3LaunchInput) => void,
  modelOptions: Record<string, Array<{ id: string; values: string[]; default?: string }>> = {},
  extraProviders: ReadonlyArray<{ providerInstanceId: string; displayName: string; models: Array<{ id: string; options?: Array<{ id: string; values: string[]; default?: string }> }> }> = [],
): FakeT3Install {
  const launches: T3LaunchInput[] = [];
  const pinned: string[] = [];
  const unpinned: string[] = [];
  const renamed: Array<{ threadId: string; title: string }> = [];
  const autoSettleOff: string[] = [];
  const threads: T3Thread[] = [];
  const sends: T3SendInput[] = [];
  const interrupts: string[] = [];
  const projects = repoPaths.map((workspaceRoot, i) => ({
    id: `proj-${i}`,
    title: `repo-${i}`,
    workspaceRoot,
    defaultModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    deletedAt: null,
  }));
  const seam: T3Seam = {
    interrupt: async (threadId) => {
      interrupts.push(threadId);
    },
    projects: async () => projects,
    capabilities: async () => ({
      runtimeMode: "full-access",
      providers: [
        {
          providerInstanceId: "claudeAgent",
          displayName: "Claude",
          models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map((id) => ({ id, ...(modelOptions[id] ? { options: modelOptions[id] } : {}) })),
          constraints: [],
        },
        ...extraProviders.map((p) => ({ ...p, constraints: [] })),
      ],
    }),
    list: async (o) => ({
      projectId: o.projectId ?? "proj-0",
      threads: threads
        .filter((t) => (o.settled === false ? !t.settled : true))
        .filter((t) => (o.titleContains ? t.title.includes(o.titleContains) : true))
        .map((t) => ({
          threadId: t.threadId,
          projectId: t.projectId,
          title: t.title,
          status: t.status,
          latestRunId: t.latestRunId,
          providerInstanceId: t.providerInstanceId,
          model: t.model,
          settled: t.settled,
          parentThreadId: null,
        })),
      nextCursor: null,
    }),
    read: async (threadId) => {
      const thread = threads.find((t) => t.threadId === threadId);
      if (!thread) throw new T3Error("refused", `t3_thread_read: thread ${threadId} not found`);
      return { thread, recentRuns: [], items: [], nextPosition: 0, hasMore: false };
    },
    launch: async (input) => {
      launches.push(input);
      onLaunch?.(input);
      const n = threads.length + 1;
      const ws = input.workspaceStrategy;
      const thread: T3Thread = {
        threadId: `t3-${n}`,
        projectId: input.projectId ?? "proj-0",
        title: input.title,
        status: "running",
        worktreePath: ws && "worktreePath" in ws ? ws.worktreePath : null,
        branch: ws && "branch" in ws ? (ws.branch ?? null) : null,
        settled: false,
        archived: false,
        model: input.modelSelection.model,
        providerInstanceId: input.modelSelection.instanceId,
        activeRunId: `run-${n}`,
        latestRunId: `run-${n}`,
      };
      threads.push(thread);
      return {
        threadId: thread.threadId,
        projectId: thread.projectId,
        modelSelection: input.modelSelection,
        runId: thread.activeRunId,
        status: thread.status,
      };
    },
    rename: async (threadId, title) => {
      renamed.push({ threadId, title });
      const t = threads.find((x) => x.threadId === threadId);
      if (t) t.title = title;
    },
    settle: async (threadId) => {
      const t = threads.find((x) => x.threadId === threadId);
      if (t) t.settled = true;
    },
    send: async (input) => {
      sends.push(input);
    },
    wait: async () => ({ runId: null, status: "idle", timedOut: false }),
    queue: async () => ({ items: [], complete: true }),
    pin: async (threadId) => {
      pinned.push(threadId);
    },
    unpin: async (threadId) => {
      unpinned.push(threadId);
    },
    disableAutoSettle: async (threadId) => {
      autoSettleOff.push(threadId);
    },
    queueCancel: async () => {},
  };
  const restore = __setT3Seam(seam);
  return { launches, pinned, unpinned, renamed, autoSettleOff, threads, sends, interrupts, restore };
}

import { afterEach, describe, expect, test } from "bun:test";
import { freshDbPath, runCli } from "./helpers.ts";
import { T3Error, type T3Project, type T3Thread, type T3ThreadListResult, type T3ThreadRead } from "../src/t3/client.ts";
import { __setT3Seam, type T3Seam } from "../src/t3/dispatch.ts";
import {
  __setT3RowSource,
  buildT3Tree,
  indexT3Rows,
  joinThreadsToRows,
  looksLikeThreadId,
  needsYouReason,
  projectViews,
  readT3Projects,
  readT3Seam,
  readT3Thread,
  readT3Threads,
  readT3View,
  renderT3Projects,
  renderT3ThreadLine,
  renderT3ThreadsBlock,
  renderT3Tree,
  threadIdForTicket,
  threadLink,
  threadNeedsYou,
  threadObLabel,
  unreadT3View,
  type T3ReadView,
  type T3SpinoffRow,
  type T3ThreadView,
} from "../src/t3/read.ts";
import { healthNotReadReason, renderT3Open, renderT3Status, t3HealthOk, type T3DoctorReport } from "../src/commands/t3.ts";

// ob 1124 — the ob ← T3 read surface. Offline by construction: every T3 call is a fake seam and every ob
// row is an injected row source, so the suite needs no server, no credential and no database.

const PROJECT: T3Project = {
  id: "proj-acme",
  title: "acme",
  workspaceRoot: "/home/owner/dev/acme",
  repositoryIdentity: { canonicalKey: "github.com/owner/acme", displayName: "owner/acme" },
  defaultModelSelection: { instanceId: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
  scripts: [{ name: "test", command: "bun test" }],
  deletedAt: null,
};

function thread(over: Partial<T3Thread> & { threadId: string }): T3Thread {
  return {
    projectId: PROJECT.id,
    title: over.threadId,
    status: "completed",
    worktreePath: null,
    branch: null,
    settled: false,
    archived: false,
    model: "m",
    providerInstanceId: "opencode",
    activeRunId: null,
    latestRunId: null,
    pendingRequestCount: 0,
    parentThreadId: null,
    relationshipToParent: null,
    updatedAt: "2026-10-17T10:00:00.000Z",
    ...over,
  };
}

interface FakeSeam {
  seam: T3Seam;
  reads: string[];
  lists: Array<{ projectId?: string | undefined; includeSubagents?: boolean | undefined }>;
}

function fakeSeam(
  threads: T3Thread[],
  opts: { failList?: string; failRead?: string[]; failReadHard?: boolean; failProjects?: string; projects?: T3Project[] } = {},
): FakeSeam {
  const reads: string[] = [];
  const lists: Array<{ projectId?: string | undefined; includeSubagents?: boolean | undefined }> = [];
  const projects = opts.projects ?? [PROJECT];
  return {
    reads,
    lists,
    seam: {
      interrupt: async () => {},
      projects: async () => {
        if (opts.failProjects) throw new T3Error("unreachable", opts.failProjects, "is T3 running? `t3 serve`");
        return projects;
      },
      capabilities: async () => ({ runtimeMode: "full-access", providers: [] }),
      list: async (o): Promise<T3ThreadListResult> => {
        lists.push({ projectId: o.projectId, includeSubagents: o.includeSubagents });
        if (opts.failList) throw new T3Error("unreachable", opts.failList, "start T3");
        const inProject = threads.filter((t) => t.projectId === o.projectId);
        const included = o.includeSubagents === false ? inProject.filter((t) => t.parentThreadId === null) : inProject;
        return {
          projectId: o.projectId ?? PROJECT.id,
          threads: included.map((t) => ({
            threadId: t.threadId,
            title: t.title,
            status: t.status,
            latestRunId: t.latestRunId,
            providerInstanceId: t.providerInstanceId,
            model: t.model,
            settled: t.settled,
            parentThreadId: t.parentThreadId ?? null,
            relationshipToParent: t.relationshipToParent ?? null,
            ...(t.updatedAt !== undefined && { updatedAt: t.updatedAt }),
          })),
          nextCursor: null,
        };
      },
      read: async (threadId): Promise<T3ThreadRead> => {
        reads.push(threadId);
        if (opts.failReadHard) {
          throw new T3Error("credential_rejected", "T3 rejected the MCP credential (401 invalid_mcp_credential)", "run `ob t3 login` to re-mint it");
        }
        if (opts.failRead?.includes(threadId)) {
          throw new T3Error("refused", `t3_thread_read: Thread ${threadId} is no longer available.`, "the thread was deleted or the id is stale; re-read the tree", "thread_not_found");
        }
        const t = threads.find((x) => x.threadId === threadId);
        if (!t) throw new T3Error("refused", `thread ${threadId} not found`);
        return { thread: t, recentRuns: [], items: [], nextPosition: 0, hasMore: false };
      },
      launch: async () => {
        throw new Error("the read surface never launches");
      },
      rename: async () => {},
      settle: async () => undefined,
      send: async () => {
        throw new Error("the read surface never sends");
      },
      queue: async () => {
        throw new Error("the read surface never reads the queue");
      },
      pin: async () => {},
      unpin: async () => {},
      disableAutoSettle: async () => {},
      queueCancel: async () => {
        throw new Error("the read surface never withdraws from the queue");
      },
      wait: async () => ({ runId: null, status: "idle", timedOut: false }),
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

// ---------------------------------------------------------------------------
// The join: T3 thread ids onto ob's rows
// ---------------------------------------------------------------------------

describe("indexT3Rows (1124)", () => {
  const builder: T3SpinoffRow = {
    id: 590,
    ticket_ref: "1120",
    branch: "1120",
    worktree: "/home/owner/dev/acme.1120",
    agent_id: "1120",
    t3_thread_id: "mcp:e765b84e",
    status: "launched",
  };

  test("a spinoff row with a thread id joins as a builder, named by its ticket", () => {
    const index = indexT3Rows({ spinoffs: [builder, { ...builder, id: 591, t3_thread_id: null }], agents: [] });
    expect([...index.keys()]).toEqual(["mcp:e765b84e"]);
    expect(index.get("mcp:e765b84e")).toEqual({
      threadId: "mcp:e765b84e",
      kind: "builder",
      ticket: "1120",
      itemId: null,
      branch: "1120",
      worktree: "/home/owner/dev/acme.1120",
      rowId: 590,
      agentId: "1120",
    });
  });

  test("a team role thread joins by its agent row's session id, never by a title", () => {
    const index = indexT3Rows({
      spinoffs: [],
      agents: [{ id: "architect-acme", ticket: null, branch: "main", worktree: "/home/owner/dev/acme", launcher: "t3", session_id: "mcp:69465d72" }],
    });
    expect(index.get("mcp:69465d72")).toMatchObject({ kind: "architect", ticket: null, agentId: "architect-acme", rowId: null });
  });

  test("a builder's OWN agent row does not overwrite the spinoff row's account of the thread", () => {
    const index = indexT3Rows({
      spinoffs: [builder],
      agents: [
        // the launcher registers the builder under its branch, with the thread in session_id
        { id: "1120", ticket: "1120", branch: "1120", worktree: builder.worktree, launcher: "t3", session_id: "mcp:e765b84e" },
        // a legacy row under another launcher is not a thread id at all
        { id: "architect-acme", ticket: null, branch: "main", worktree: "/r", launcher: "headless", session_id: "ses_not-a-thread" },
      ],
    });
    expect(index.get("mcp:e765b84e")).toMatchObject({ kind: "builder", ticket: "1120", rowId: 590 });
    expect(index.has("ses_not-a-thread")).toBe(false);
  });
});

describe("threadIdForTicket (1124)", () => {
  const rows: T3SpinoffRow[] = [
    { id: 1, ticket_ref: "1120", branch: "1120", worktree: "/w", agent_id: "1120", t3_thread_id: null, status: "merged" },
    { id: 2, ticket_ref: "1120", branch: "1120-retry", worktree: "/w2", agent_id: "1120", t3_thread_id: "mcp:older", status: "merged" },
    { id: 3, ticket_ref: "1120", branch: "1120-again", worktree: "/w3", agent_id: "1120", t3_thread_id: "mcp:newer", status: "launched" },
  ];

  test("newest row with a thread wins, and a leading # is tolerated", () => {
    expect(threadIdForTicket(rows, "1120")?.threadId).toBe("mcp:newer");
    expect(threadIdForTicket(rows, "#1120")?.threadId).toBe("mcp:newer");
  });

  test("a branch matches too, and a row with no thread is skipped", () => {
    expect(threadIdForTicket(rows, "1120-retry")?.threadId).toBe("mcp:older");
    expect(threadIdForTicket([rows[0]!], "1120")).toBeNull();
    expect(threadIdForTicket(rows, "")).toBeNull();
  });

  test("a thread id is told apart from a ticket ref", () => {
    expect(looksLikeThreadId("mcp:e765b84e-ab24-4bcf-acff-3763c9da6599")).toBe(true);
    expect(looksLikeThreadId("1ef11a3b-0892-40df-b3d0-8235fbd5a035")).toBe(true);
    expect(looksLikeThreadId("1120")).toBe(false);
    expect(looksLikeThreadId("#35")).toBe(false);
  });

  test("T3's own link shape, verbatim", () => {
    expect(threadLink("mcp:e765b84e")).toBe("t3-thread://v1/mcp:e765b84e");
  });
});

// ---------------------------------------------------------------------------
// Reading the threads
// ---------------------------------------------------------------------------

describe("readT3Threads (1124)", () => {
  const threads = [
    thread({ threadId: "t-old", updatedAt: "2026-10-17T09:00:00.000Z", status: "completed", settled: true }),
    thread({ threadId: "t-new", updatedAt: "2026-10-17T11:00:00.000Z", status: "running", worktreePath: "/home/owner/dev/acme.1124", branch: "1124", pendingRequestCount: 0 }),
    thread({ threadId: "t-sub", updatedAt: "2026-10-17T10:30:00.000Z", status: "completed", parentThreadId: "t-new", relationshipToParent: "subagent" }),
  ];

  test("newest first, detailed from the READ (worktree, branch, pending count)", async () => {
    const fake = fakeSeam(threads);
    const read = await readT3Threads(fake.seam);
    expect(read.threads.map((t) => t.threadId)).toEqual(["t-new", "t-old"]);
    expect(read.threads[0]).toMatchObject({
      project: "acme",
      status: "running",
      worktreePath: "/home/owner/dev/acme.1124",
      branch: "1124",
      pendingRequestCount: 0,
      link: "t3-thread://v1/t-new",
    });
    expect(fake.reads).toEqual(["t-old", "t-new"]);
  });

  test("subagents are excluded by default and included on request", async () => {
    const without = await readT3Threads(fakeSeam(threads).seam);
    expect(without.threads.map((t) => t.threadId)).not.toContain("t-sub");
    const with_ = await readT3Threads(fakeSeam(threads).seam, { includeSubagents: true });
    expect(with_.threads.map((t) => t.threadId)).toContain("t-sub");
  });

  test("a thread that T3 reports as GONE is named and still listed from its summary", async () => {
    const read = await readT3Threads(fakeSeam(threads, { failRead: ["t-new"] }).seam);
    expect(read.unreadable).toEqual([{ threadId: "t-new", reason: "t3_thread_read: Thread t-new is no longer available." }]);
    expect(read.threads.find((t) => t.threadId === "t-new")).toMatchObject({ status: "running", worktreePath: null, branch: null });
  });

  test("any OTHER detail failure is RETHROWN — never a short, successful list", async () => {
    await expect(readT3Threads(fakeSeam(threads, { failReadHard: true }).seam)).rejects.toThrow(/rejected the MCP credential/);
  });

  test("a failing LIST is the transport's to report — never an empty successful list", async () => {
    await expect(readT3Threads(fakeSeam(threads, { failList: "T3 server not reachable" }).seam)).rejects.toThrow(/not reachable/);
  });

  test("a deleted project is not read", async () => {
    const fake = fakeSeam(threads, { projects: [PROJECT, { ...PROJECT, id: "gone", title: "gone", deletedAt: "2026-10-17T00:00:00.000Z" }] });
    const read = await readT3Threads(fake.seam);
    expect(read.projects.map((p) => p.id)).toEqual([PROJECT.id]);
    expect(fake.lists.map((l) => l.projectId)).toEqual([PROJECT.id]);
  });
});

describe("needs you (1124, interim rule)", () => {
  test("a pending question or a waiting run needs the human", () => {
    expect(threadNeedsYou({ pendingRequestCount: 2, status: "running" })).toBe(true);
    expect(threadNeedsYou({ pendingRequestCount: 0, status: "waiting" })).toBe(true);
    expect(threadNeedsYou({ pendingRequestCount: 0, status: "running" })).toBe(false);
    expect(needsYouReason({ pendingRequestCount: 1, status: "running" })).toBe("1 pending question");
    expect(needsYouReason({ pendingRequestCount: 3, status: "waiting" })).toBe("3 pending questions");
    expect(needsYouReason({ pendingRequestCount: 0, status: "waiting" })).toBe("waiting on the human");
    expect(needsYouReason({ pendingRequestCount: 0, status: "completed" })).toBeNull();
  });
});

describe("readT3View (1124)", () => {
  const source = {
    spinoffs: async (): Promise<T3SpinoffRow[]> => [
      { id: 9, ticket_ref: "1124", branch: "1124", worktree: "/home/owner/dev/acme.1124", agent_id: "1124", t3_thread_id: "t-new", status: "launched" },
    ],
    agents: async () => [],
  };

  test("joins the ob ticket onto the thread and lists the ones needing the human", async () => {
    const threads = [thread({ threadId: "t-new", status: "running", pendingRequestCount: 1 })];
    const block = await readT3View(source, {}, fakeSeam(threads).seam);
    expect(block.error).toBeNull();
    expect(block.threads[0]!.ob).toMatchObject({ kind: "builder", ticket: "1124" });
    expect(block.needsYou.map((t) => t.threadId)).toEqual(["t-new"]);
    const lines = renderT3ThreadsBlock(block);
    expect(lines.join("\n")).toContain("needs you");
    expect(lines.join("\n")).toContain("1 pending question");
  });

  test("the needs-you section disappears when the question is settled — no second command", async () => {
    const block = await readT3View(source, {}, fakeSeam([thread({ threadId: "t-new", status: "running", pendingRequestCount: 0 })]).seam);
    expect(block.needsYou).toEqual([]);
    expect(renderT3ThreadsBlock(block).join("\n")).not.toContain("needs you");
  });

  test("T3 down is ONE line, never a thrown status report", async () => {
    const block = await readT3View(source, {}, fakeSeam([], { failList: "T3 server not reachable at http://127.0.0.1:9" }).seam);
    expect(block.error).toContain("not reachable");
    expect(block.threads).toEqual([]);
    const lines = renderT3ThreadsBlock(block);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("could not read T3");
    expect(lines[0]).toContain("ob t3 doctor");
  });

  test("a credential rejected MID-read is the same ONE line, not a short list", async () => {
    const block = await readT3View(source, {}, fakeSeam([thread({ threadId: "t-new" })], { failReadHard: true }).seam);
    expect(block.threads).toEqual([]);
    expect(block.error).toContain("rejected the MCP credential");
    expect(renderT3ThreadsBlock(block)[0]).toContain("could not read T3");
  });

  test("a CONNECT failure is one line naming the remedy too — the block decorates it like the commands", async () => {
    // No credential file: `T3Client.connected()` refuses before any network call, so this is offline.
    const prev = process.env.OB_T3_CREDENTIAL_FILE;
    process.env.OB_T3_CREDENTIAL_FILE = "/tmp/opencode/definitely-not-a-credential.json";
    cleanups.push(() => {
      if (prev === undefined) delete process.env.OB_T3_CREDENTIAL_FILE;
      else process.env.OB_T3_CREDENTIAL_FILE = prev;
    });
    const block = await readT3View(source);
    expect(block.error).toContain("ob t3 doctor");
    expect(block.error).toContain("ob t3 login");
    expect(renderT3ThreadsBlock(block)).toHaveLength(1);
  });

  test("an unreadable ob JOIN never hides the threads T3 answered with", async () => {    const deadRows = {
      spinoffs: async () => {
        throw new Error("the ob API is down");
      },
      agents: async () => [],
    };
    const block = await readT3View(deadRows, {}, fakeSeam([thread({ threadId: "t-new", status: "running" })]).seam);
    expect(block.error).toBeNull();
    expect(block.rowsError).toContain("the ob API is down");
    expect(block.threads.map((t) => t.threadId)).toEqual(["t-new"]);
    expect(block.threads[0]!.ob).toBeNull();
    const lines = renderT3ThreadsBlock(block).join("\n");
    expect(lines).toContain("the ob rows could not be read — the ob API is down");
    expect(lines).toContain("t-new");
    expect(lines).not.toContain("could not read T3 —");
  });

  test("a BUG in ob is not reported as a T3 outage — only the seam's own failures are tolerated", async () => {
    const buggy: T3Seam = {
      ...fakeSeam([]).seam,
      list: async () => {
        throw new TypeError("listThreads is not a function");
      },
    };
    await expect(readT3View(source, {}, buggy)).rejects.toThrow(/is not a function/);
  });

  test("`t3 tree -q` keeps stdout id-only and puts an unreadable ob join on STDERR", async () => {
    cleanups.push(__setT3Seam(fakeSeam([thread({ threadId: "t-new", status: "running" })]).seam));
    cleanups.push(
      __setT3RowSource({
        spinoffs: async () => {
          throw new Error("the ob API is down");
        },
        agents: async () => [],
      }),
    );
    const r = await runCli(freshDbPath(), ["t3", "tree", "-q"]);
    expect(r.out.trim()).toBe("t-new");
    expect(r.err).toContain("the ob rows could not be read — the ob API is down");
    expect(r.code).toBe(1);
  });

  test("`t3 tree -q` prints the ONE reason when T3 itself could not be read", async () => {
    cleanups.push(__setT3Seam(fakeSeam([], { failList: "T3 server not reachable at http://127.0.0.1:9" }).seam));
    const r = await runCli(freshDbPath(), ["t3", "tree", "-q"]);
    expect(r.out.trim()).toContain("not reachable");
    expect(r.out.trim().split("\n")).toHaveLength(1);
    expect(r.code).toBe(1);
  });
});

describe("thread lines (1124)", () => {
  test("a joined builder line names its ticket; an unattributed thread says so", () => {
    const t: T3ThreadView = {
      threadId: "mcp:x",
      projectId: PROJECT.id,
      project: "acme",
      title: "1120 · T3 dispatch (P2)",
      status: "completed",
      settled: true,
      pendingRequestCount: 0,
      worktreePath: "/home/owner/dev/acme.1120",
      branch: "1120",
      parentThreadId: null,
      relationshipToParent: null,
      updatedAt: null,
      ob: { threadId: "mcp:x", kind: "builder", ticket: "1120", itemId: null, branch: "1120", worktree: "/w", rowId: 1, agentId: "1120" },
      link: "t3-thread://v1/mcp:x",
    };
    expect(renderT3ThreadLine(t)).toBe("  mcp:x  completed (settled)  1120  branch 1120  /home/owner/dev/acme.1120");
    expect(renderT3ThreadLine({ ...t, ob: null })).toContain("  -  branch 1120");
    expect(renderT3ThreadLine({ ...t, ob: null, pendingRequestCount: 2 })).toContain("pending 2");
  });

  // 1163: the label is the ob ITEM the row serves, not the ref it was dispatched with. For a hand-charted
  // ticket those differ (row 591: ref "1124", item 1134), and the number a human can act on is the item.
  test("a thread is labelled with the item its row records, falling back to the dispatch ref", () => {
    const base = { threadId: "mcp:x", kind: "builder" as const, branch: "1124", worktree: "/w", rowId: 591, agentId: "1124" };
    expect(threadObLabel({ ob: { ...base, ticket: "1124", itemId: "1134" } })).toBe("1134");
    expect(threadObLabel({ ob: { ...base, ticket: "1124", itemId: null } })).toBe("1124");
  });

  test("`t3 open` resolves a ticket by the item the row records, before the ref or the branch", () => {
    const rows: T3SpinoffRow[] = [
      { id: 591, ticket_ref: "1124", item_id: "1134", branch: "1124", worktree: "/w", agent_id: "1124", t3_thread_id: "mcp:row591", status: "merged" },
    ];
    expect(threadIdForTicket(rows, "1134")?.threadId).toBe("mcp:row591");
    expect(threadIdForTicket(rows, "1124")?.threadId).toBe("mcp:row591");
    expect(threadIdForTicket(rows, "9999")).toBeNull();
  });

  test("joinThreadsToRows attaches the row and leaves an unknown thread unattributed", () => {
    const joined = joinThreadsToRows(
      [
        { threadId: "known" } as T3ThreadView,
        { threadId: "unknown" } as T3ThreadView,
      ],
      indexT3Rows({
        spinoffs: [{ id: 1, ticket_ref: "9", branch: "9", worktree: "/w", agent_id: null, t3_thread_id: "known", status: "launched" }],
        agents: [],
      }),
    );
    expect(joined[0]!.ob).toMatchObject({ ticket: "9" });
    expect(joined[1]!.ob).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// projects + tree
// ---------------------------------------------------------------------------

describe("t3 projects (1124)", () => {
  test("read live: repo identity, default model and script count", () => {
    const rows = projectViews([PROJECT, { ...PROJECT, id: "gone", title: "gone", deletedAt: "2026-10-17T00:00:00.000Z" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: PROJECT.id,
      title: "acme",
      workspaceRoot: "/home/owner/dev/acme",
      repo: "owner/acme",
      defaultModel: { instanceId: "opencode", model: "opencode-go/deepseek-v4.1-flash" },
      scripts: 1,
    });
  });

  test("a project with no default model says a launch would refuse", () => {
    const text = renderT3Projects(projectViews([{ ...PROJECT, defaultModelSelection: null, repositoryIdentity: null, scripts: [] }]));
    expect(text).toContain("no default model");
    expect(text).toContain("scripts    0");
  });
});

describe("t3 tree (1124)", () => {
  const threads: T3ThreadView[] = [
    { threadId: "architect", projectId: PROJECT.id, project: "acme", title: "acme · architect", status: "running", settled: false, pendingRequestCount: 0, worktreePath: null, branch: null, parentThreadId: null, relationshipToParent: null, updatedAt: null, ob: { threadId: "architect", kind: "architect", ticket: null, itemId: null, branch: null, worktree: null, rowId: null, agentId: "architect-acme" }, link: "l" },
    { threadId: "builder", projectId: PROJECT.id, project: "acme", title: "1124", status: "running", settled: false, pendingRequestCount: 0, worktreePath: "/w", branch: "1124", parentThreadId: null, relationshipToParent: null, updatedAt: null, ob: { threadId: "builder", kind: "builder", ticket: "1124", itemId: "1124", branch: "1124", worktree: "/w", rowId: 1, agentId: "1124" }, link: "l" },
    { threadId: "sub", projectId: PROJECT.id, project: "acme", title: "review", status: "completed", settled: false, pendingRequestCount: 0, worktreePath: null, branch: null, parentThreadId: "builder", relationshipToParent: "subagent", updatedAt: null, ob: null, link: "l" },
  ];

  test("roots are top-level threads; a delegated child nests under its parent", () => {
    const [project] = buildT3Tree([PROJECT], threads);
    expect(project!.roots.map((n) => n.threadId)).toEqual(["architect", "builder"]);
    expect(project!.roots[1]!.children.map((n) => n.threadId)).toEqual(["sub"]);
  });

  test("a parent outside the set (a subagent's parent, hidden by default) is a root, never dropped", () => {
    const [project] = buildT3Tree([PROJECT], [threads[2]!]);
    expect(project!.roots.map((n) => n.threadId)).toEqual(["sub"]);
  });

  test("each node names its ticket, its architect id, or is marked unattributed", () => {
    const text = renderT3Tree(buildT3Tree([PROJECT], threads));
    expect(text).toContain("architect-acme");
    expect(text).toContain("[architect]");
    expect(text).toContain("1124  builder");
    expect(text).toContain("review (subagent)");
    expect(text).toContain("[unattributed]");
  });

  test("the human tree carries the SAME diagnostics the json does", () => {
    const text = renderT3Tree(buildT3Tree([PROJECT], threads), {
      unreadable: [{ threadId: "t-gone", reason: "not found" }],
      truncated: 1,
      rowsError: "the ob API is down",
    });
    expect(text).toContain("the ob rows could not be read — the ob API is down");
    expect(text).toContain("could not read thread t-gone — not found");
    expect(text).toContain("1 project(s) hold more threads than one page");
    // ...and an empty tree still says so rather than printing a bare header.
    expect(renderT3Tree([])).toContain("(no threads)");
  });
});

// ---------------------------------------------------------------------------
// the command renderers
// ---------------------------------------------------------------------------

function doctor(over: Partial<T3DoctorReport> = {}): T3DoctorReport {
  return {
    baseUrl: "http://127.0.0.1:3773",
    credentialPath: "/home/owner/.omnislash/t3-mcp-credential.json",
    stages: [
      { stage: "server", ok: true, detail: "T3 Code responding" },
      { stage: "credential", ok: true, detail: "present, 29d left" },
      { stage: "version", ok: true, detail: "T3 Code 0.1.0" },
    ],
    version: "0.1.0",
    channel: "release",
    pinnedBuild: "0.1.1-preview",
    pinnedChannel: "preview",
    versionDrift: true,
    projects: [],
    providers: [],
    tools: 83,
    expiresAt: null,
    ok: true,
    ...over,
  };
}

describe("renderT3Status (1124)", () => {
  /** A read view with sane defaults, so each test says only what it is about. */
  const view = (over: Partial<T3ReadView> = {}): T3ReadView => ({
    projects: [PROJECT],
    threads: [],
    needsYou: [],
    unreadable: [],
    truncated: 0,
    error: null,
    rowsError: null,
    ...over,
  });

  test("the health stages doctor computed, then the threads, newest first", () => {
    const text = renderT3Status({ doctor: doctor(), view: view({ threads: [thread({ threadId: "t-new", status: "running" }) as unknown as T3ThreadView] }) }, "human");
    expect(text).toContain("T3 Code status");
    expect(text).toContain("server        ok");
    expect(text).toContain("threads       1");
    expect(text).toContain("t-new");
  });

  test("a failed health stage prints the stages and says the threads were NOT read", () => {
    const bad = doctor({
      stages: [
        { stage: "server", ok: false, detail: "not reachable", remedy: "start T3 (`t3 serve`)" },
        { stage: "credential", ok: true, detail: "present" },
      ],
      ok: false,
    });
    expect(t3HealthOk(bad)).toBe(false);
    // The reason the command passes is built from the FAILED STAGE, so -q prints something actionable.
    expect(healthNotReadReason(bad)).toContain("start T3 (`t3 serve`)");
    const report = { doctor: bad, view: unreadT3View(healthNotReadReason(bad)) };
    const text = renderT3Status(report, "human");
    expect(text).toContain("FAILED");
    expect(text).toContain("→ start T3");
    expect(text).toContain("threads       not read");
    expect(text).toContain("fix the failed stage above");
    expect(text).not.toContain("(none)");
    // -q must not go SILENT on an unhealthy transport: it prints the reason the threads are missing.
    expect(renderT3Status(report, "quiet")).toContain("start T3 (`t3 serve`)");
    // ...and the json report still round-trips, with the health verdict in it.
    const parsed = JSON.parse(renderT3Status(report, "json")) as { doctor: { ok: boolean }; error: string };
    expect(parsed.doctor.ok).toBe(false);
    expect(parsed.error).toContain("start T3 (`t3 serve`)");
  });

  test("a read that failed AFTER the stages passed is not a successful empty list", () => {
    const report = { doctor: doctor(), view: unreadT3View("T3 rejected the MCP credential — run `ob t3 login` to re-mint it") };
    const text = renderT3Status(report, "human");
    expect(text).toContain("threads       not read");
    expect(text).toContain("ob t3 login");
    expect(renderT3Status(report, "quiet")).toContain("ob t3 login");
    expect(renderT3Status(report, "json")).toContain("re-mint");
  });

  test("the needs-you line names the thread and why, and --json round-trips the report", () => {
    const t = thread({ threadId: "t-q", status: "running", pendingRequestCount: 1 }) as unknown as T3ThreadView;
    const report = { doctor: doctor(), view: view({ threads: [t], needsYou: [t] }) };
    expect(renderT3Status(report, "human")).toContain("needs you");
    const parsed = JSON.parse(renderT3Status(report, "json")) as { needs_you: string[]; threads: Array<{ threadId: string }> };
    expect(parsed.needs_you).toEqual(["t-q"]);
    expect(parsed.threads[0]!.threadId).toBe("t-q");
    expect(renderT3Status(report, "quiet")).toBe("t-q");
  });

  test("an unreadable thread and a truncated page are named, never silently dropped", () => {
    const text = renderT3Status(
      { doctor: doctor(), view: view({ unreadable: [{ threadId: "t-gone", reason: "not found" }], truncated: 2 }) },
      "human",
    );
    expect(text).toContain("could not read thread t-gone");
    expect(text).toContain("2 project(s) hold more threads");
  });

  test("an unreadable ob JOIN is its own line and never hides the threads T3 answered with", () => {
    const t = thread({ threadId: "t-1", status: "running" }) as unknown as T3ThreadView;
    const text = renderT3Status({ doctor: doctor(), view: view({ threads: [t], rowsError: "the ob API is down" }) }, "human");
    expect(text).toContain("the ob rows could not be read — the ob API is down");
    expect(text).toContain("t-1");
    expect(text).not.toContain("could not read T3 —");
  });
});

describe("renderT3Open (1124)", () => {
  const outcome = { ticket: "1120", threadId: "mcp:e765b84e", title: "1120 · T3 dispatch (P2)", status: "completed", settled: true, link: "t3-thread://v1/mcp:e765b84e" };

  test("the link is printed verbatim, unwrapped", () => {
    expect(renderT3Open(outcome, "human")).toContain("t3-thread://v1/mcp:e765b84e");
    expect(renderT3Open(outcome, "human")).not.toContain("](");
    expect(renderT3Open(outcome, "quiet")).toBe("t3-thread://v1/mcp:e765b84e");
    expect(JSON.parse(renderT3Open(outcome, "json")).link).toBe("t3-thread://v1/mcp:e765b84e");
  });
});

// ---------------------------------------------------------------------------
// the command path (in-process, no server)
// ---------------------------------------------------------------------------

describe("ob t3 open (1124)", () => {
  test("a ticket with no stamped thread exits 1 naming the remedy", async () => {
    const r = await runCli(freshDbPath(), ["t3", "open", "1120"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no T3 thread is stamped for '1120'");
    expect(r.err).toContain("ob spinoff list");
  });

  test("no argument is a usage error", async () => {
    const r = await runCli(freshDbPath(), ["t3", "open"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("t3 open requires");
  });

  test("a stamped ticket prints T3's link for its thread", async () => {
    const fake = fakeSeam([thread({ threadId: "mcp:e765b84e", title: "1120 · T3 dispatch (P2)" })]);
    cleanups.push(__setT3Seam(fake.seam));
    cleanups.push(
      __setT3RowSource({
        spinoffs: async () => [{ id: 590, ticket_ref: "1120", branch: "1120", worktree: "/w", agent_id: "1120", t3_thread_id: "mcp:e765b84e", status: "merged" }],
        agents: async () => [],
      }),
    );
    const r = await runCli(freshDbPath(), ["t3", "open", "1120"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("t3-thread://v1/mcp:e765b84e");
    expect(fake.reads).toEqual(["mcp:e765b84e"]);
  });

  test("a raw thread id is taken as-is and READ (a stale id fails loudly)", async () => {
    cleanups.push(__setT3Seam(fakeSeam([]).seam));
    const r = await runCli(freshDbPath(), ["t3", "open", "mcp:nope"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("mcp:nope");
  });

  test("T3 unreachable fails with the remedy rather than printing a dead link", async () => {
    const failing: T3Seam = { ...fakeSeam([]).seam, read: async () => { throw new T3Error("unreachable", "T3 server not reachable at http://127.0.0.1:9", "is T3 running? `t3 serve`"); } };
    cleanups.push(__setT3Seam(failing));
    const r = await runCli(freshDbPath(), ["t3", "open", "mcp:x"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not reachable");
    expect(r.out).toBe("");
  });
});

describe("ob t3 subcommand surface (1124)", () => {
  test("an unknown subcommand names every one it does know", async () => {
    const r = await runCli(freshDbPath(), ["t3", "nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("doctor, login, team, architect, sentinel, muse, broadcast, status, projects, tree, open");
  });

  test("`t3 projects` reads live and prints the project table", async () => {
    cleanups.push(__setT3Seam(fakeSeam([]).seam));
    const r = await runCli(freshDbPath(), ["t3", "projects"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("acme");
    expect(r.out).toContain("owner/acme");
    expect(r.out).toContain("opencode-go/deepseek-v4.1-flash");
  });

  test("`t3 projects` with T3 unreachable exits 1 and names the remedy — never an empty successful list", async () => {
    const dead: T3Seam = {
      ...fakeSeam([]).seam,
      projects: async () => {
        throw new T3Error("unreachable", "T3 server not reachable at http://127.0.0.1:9", "is T3 running? `t3 serve`");
      },
    };
    cleanups.push(__setT3Seam(dead));
    const r = await runCli(freshDbPath(), ["t3", "projects"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("not reachable");
    expect(r.out).toBe("");
  });

  test("a transport failure names `ob t3 doctor` / `ob t3 login` in the message", async () => {
    // No credential file at all: `T3Client.connected()` refuses before any network call.
    const prev = process.env.OB_T3_CREDENTIAL_FILE;
    process.env.OB_T3_CREDENTIAL_FILE = "/tmp/opencode/definitely-not-a-credential.json";
    cleanups.push(() => {
      if (prev === undefined) delete process.env.OB_T3_CREDENTIAL_FILE;
      else process.env.OB_T3_CREDENTIAL_FILE = prev;
    });
    await expect(readT3Seam()).rejects.toThrow(/ob t3 doctor/);
    await expect(readT3Seam()).rejects.toThrow(/ob t3 login/);
  });

  test("a MID-READ transport failure carries the remedy too — not just the connect step", async () => {
    // The seam connects, then the operation fails: this is the case `readT3Seam` alone cannot decorate.
    await expect(readT3Projects(fakeSeam([], { failProjects: "T3 server not reachable at http://127.0.0.1:9" }).seam)).rejects.toThrow(
      /not reachable.*ob t3 doctor/s,
    );
    await expect(readT3Thread(fakeSeam([], { failReadHard: true }).seam, "t-1")).rejects.toThrow(/ob t3 login/);
  });

  test("a REFUSAL keeps its own remedy — the transport pointer is not appended to it", async () => {
    await expect(readT3Thread(fakeSeam([], { failRead: ["t-1"] }).seam, "t-1")).rejects.toThrow(/deleted or the id is stale/);
    try {
      await readT3Thread(fakeSeam([], { failRead: ["t-1"] }).seam, "t-1");
      throw new Error("expected a rejection");
    } catch (err) {
      expect((err as Error).message).not.toContain("ob t3 doctor");
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { T3Thread } from "../src/t3/client.ts";
import { renderSettleSweep, settleSweep, type SweepReport, type SweepRows } from "../src/t3/settle-sweep.ts";
import type { T3AgentRow, T3SpinoffRow } from "../src/t3/read.ts";
import { installFakeT3, type FakeT3Install } from "./fake-t3.ts";

// OS-288: `ob t3 settle-sweep` on the fake T3 seam. One case per keep rule, plus the settle and the dry run.
// No live T3, no network, no database: the ob rows are handed in as the store would read them.

const NOW = Date.parse("2026-11-27T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

let fake: FakeT3Install | null = null;
afterEach(() => {
  fake?.restore();
  fake = null;
});

function thread(id: string, over: Partial<T3Thread> = {}): T3Thread {
  return {
    threadId: id,
    projectId: "proj-0",
    title: id,
    status: "idle",
    worktreePath: null,
    branch: null,
    settled: false,
    archived: false,
    model: "claude-opus-5-5",
    providerInstanceId: "claudeAgent",
    activeRunId: null,
    latestRunId: null,
    pendingRequestCount: 0,
    updatedAt: ago(120),
    ...over,
  };
}

function spinoff(id: number, threadId: string, status: string, over: Partial<T3SpinoffRow> = {}): T3SpinoffRow {
  return { id, ticket_ref: `OS-${id}`, branch: `os-${id}`, worktree: `/r/os-${id}`, agent_id: `os-${id}`, t3_thread_id: threadId, status, ...over };
}

function agent(id: string, sessionId: string): T3AgentRow {
  return { id, ticket: null, branch: null, worktree: null, launcher: "t3", session_id: sessionId };
}

const NO_ROWS: SweepRows = { spinoffs: [], agents: [], leases: [] };

function world(threads: T3Thread[]): FakeT3Install {
  fake = installFakeT3(["/r/omnislash"]);
  fake.threads.push(...threads);
  return fake;
}

async function sweep(f: FakeT3Install, rows: SweepRows = NO_ROWS, dryRun = false): Promise<SweepReport> {
  return settleSweep({ seam: f.seam, rows, dryRun, nowMs: NOW });
}

function rowOf(r: SweepReport, id: string) {
  const row = r.rows.find((x) => x.threadId === id);
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

function settledIds(f: FakeT3Install): string[] {
  return f.threads.filter((t) => t.settled).map((t) => t.threadId);
}

describe("settle-sweep keeps a thread a rule names (OS-288)", () => {
  test("role: a thread on an architect, sentinel or muse agent row", async () => {
    const f = world([thread("arch"), thread("sent"), thread("muse")]);
    const rows: SweepRows = { ...NO_ROWS, agents: [agent("architect-slash", "arch"), agent("sentinel-personal", "sent"), agent("muse-slash", "muse")] };
    const r = await sweep(f, rows);
    for (const id of ["arch", "sent", "muse"]) expect(rowOf(r, id)).toMatchObject({ action: "kept", rule: "role" });
    expect(rowOf(r, "arch").reason).toBe("role thread (architect-slash)");
    expect(settledIds(f)).toEqual([]);
  });

  test("role: a thread titled as a team role thread with no agent row", async () => {
    const f = world([thread("t", { title: "⚔️ Slash · sentinel" })]);
    expect(rowOf(await sweep(f), "t")).toMatchObject({ action: "kept", rule: "role" });
    expect(settledIds(f)).toEqual([]);
  });

  test("row: a builder whose spinoff row is building, handed-off or gating", async () => {
    const f = world([thread("b1"), thread("b2")]);
    const rows: SweepRows = { ...NO_ROWS, spinoffs: [spinoff(1, "b1", "launched"), spinoff(2, "b2", "ready-for-gate")] };
    const r = await sweep(f, rows);
    expect(rowOf(r, "b1")).toMatchObject({ action: "kept", rule: "row", reason: "spinoff #1 OS-1 is building" });
    expect(rowOf(r, "b2")).toMatchObject({ action: "kept", rule: "row" });
    expect(settledIds(f)).toEqual([]);
  });

  test("lease: a builder whose ticket is still leased to it, though its row is over", async () => {
    const f = world([thread("b")]);
    const rows: SweepRows = { ...NO_ROWS, spinoffs: [spinoff(3, "b", "failed")], leases: [{ resource: "ticket:os-3", holder: "os-3", expired: false }] };
    expect(rowOf(await sweep(f, rows), "b")).toMatchObject({ action: "kept", rule: "lease", reason: "ticket:os-3 is still leased to os-3" });
    expect(settledIds(f)).toEqual([]);
  });

  test("lease: leg b's `ticket:<ref>-b`, and a clean-repo builder holding it under its ref, keep the thread", async () => {
    const f = world([thread("leg"), thread("clean")]);
    const rows: SweepRows = {
      ...NO_ROWS,
      spinoffs: [
        spinoff(6, "leg", "failed", { trial_leg: "b", agent_id: "os-6-b", branch: "os-6-b" }),
        spinoff(7, "clean", "failed", { agent_id: null, branch: "fix-the-upload" }),
      ],
      leases: [
        { resource: "ticket:os-6-b", holder: "os-6-b", expired: false },
        { resource: "ticket:os-7", holder: "os-7", expired: false },
      ],
    };
    const r = await sweep(f, rows);
    expect(rowOf(r, "leg")).toMatchObject({ action: "kept", rule: "lease", reason: "ticket:os-6-b is still leased to os-6-b" });
    expect(rowOf(r, "clean")).toMatchObject({ action: "kept", rule: "lease" });
    expect(settledIds(f)).toEqual([]);
  });

  test("lease: an expired lease, or one another holder has, keeps nothing", async () => {
    const f = world([thread("b"), thread("c")]);
    const rows: SweepRows = {
      ...NO_ROWS,
      spinoffs: [spinoff(4, "b", "merged"), spinoff(5, "c", "merged")],
      leases: [
        { resource: "ticket:os-4", holder: "os-4", expired: true },
        { resource: "ticket:os-5", holder: "architect-slash", expired: false },
      ],
    };
    const r = await sweep(f, rows);
    expect(rowOf(r, "b")).toMatchObject({ action: "settled", reason: "idle; spinoff #4 OS-4 is landed" });
    expect(rowOf(r, "c").action).toBe("settled");
  });

  test("run: a thread with a run in progress", async () => {
    const f = world([thread("t", { status: "running", activeRunId: "run-1" })]);
    expect(rowOf(await sweep(f), "t")).toMatchObject({ action: "kept", rule: "run" });
    expect(settledIds(f)).toEqual([]);
  });

  test("pending: a pending question or approval, or a run waiting on the human", async () => {
    const f = world([thread("q", { pendingRequestCount: 1 }), thread("w", { status: "waiting" })]);
    const r = await sweep(f);
    expect(rowOf(r, "q")).toMatchObject({ action: "kept", rule: "pending", reason: "1 pending request" });
    expect(rowOf(r, "w")).toMatchObject({ action: "kept", rule: "pending" });
    expect(settledIds(f)).toEqual([]);
  });

  test("queue: a thread holding queued messages", async () => {
    const f = world([thread("t")]);
    f.queued.set("t", [{ queuedRunId: "q1", text: "land reply", truncated: false }]);
    expect(rowOf(await sweep(f), "t")).toMatchObject({ action: "kept", rule: "queue", reason: "1 queued message" });
    expect(settledIds(f)).toEqual([]);
  });

  test("recent: a thread Jacobus wrote in within the last 30 minutes", async () => {
    const f = world([thread("t", { updatedAt: ago(5) })]);
    f.messages.set("t", [
      { position: 0, type: "message", status: "completed", createdBy: "user", updatedAt: ago(90) },
      { position: 21, type: "message", status: "completed", createdBy: "user", updatedAt: ago(10) },
      { position: 22, type: "message", status: "completed", createdBy: "agent", updatedAt: ago(5) },
    ]);
    expect(rowOf(await sweep(f), "t")).toMatchObject({ action: "kept", rule: "recent", reason: "you wrote 10 min ago" });
    expect(settledIds(f)).toEqual([]);
  });

  test("recent: his message is found past the first page of the messages view", async () => {
    const f = world([thread("t", { updatedAt: ago(1) })]);
    const items = Array.from({ length: 150 }, (_, i) => ({ position: i * 3, type: "message", status: "completed", createdBy: "agent", updatedAt: ago(60) }));
    items[140] = { ...items[140]!, createdBy: "user", updatedAt: ago(2) };
    f.messages.set("t", items);
    expect(rowOf(await sweep(f), "t")).toMatchObject({ action: "kept", rule: "recent" });
  });
});

describe("settle-sweep reads only the tail of a long thread's messages (OS-288)", () => {
  function longThread(f: FakeT3Install, userAt: { position: number; min: number }) {
    const items = Array.from({ length: 1000 }, (_, i) => ({ position: i, type: "message", status: "completed", createdBy: "agent", updatedAt: ago(i < 900 ? 60 : 3) }));
    items[userAt.position] = { ...items[userAt.position]!, createdBy: "user", updatedAt: ago(userAt.min) };
    f.messages.set("t", items);
    const starts: Array<number | undefined> = [];
    const read = f.seam.read;
    f.seam.read = async (id, o) => {
      if (o?.view === "messages" && starts.length === 0) starts.push(o.afterPosition);
      return read(id, o);
    };
    return starts;
  }

  test("a tail window that reaches back past the cutoff is enough: his recent message is found, the start never read", async () => {
    const f = world([thread("t", { updatedAt: ago(1), itemCount: 1000 })]);
    const starts = longThread(f, { position: 950, min: 2 });
    expect(rowOf(await sweep(f), "t")).toMatchObject({ action: "kept", rule: "recent" });
    expect(starts).toEqual([700]);
  });

  test("a window still newer than the cutoff widens until it reaches past it, so his message before the window is found", async () => {
    const f = world([thread("t", { updatedAt: ago(1), itemCount: 1000 })]);
    f.messages.set("t", Array.from({ length: 1000 }, (_, i) => ({ position: i, type: "message", status: "completed", createdBy: i === 10 ? "user" : "agent", updatedAt: ago(i < 10 ? 60 : i === 10 ? 20 : 3) })));
    expect(rowOf(await sweep(f), "t")).toMatchObject({ action: "kept", rule: "recent", reason: "you wrote 20 min ago" });
  });
});

describe("settle-sweep settles what no rule keeps (OS-288)", () => {
  test("an idle thread with no ob row, and one whose last word from him is over 30 minutes old, are settled", async () => {
    const f = world([thread("idle"), thread("old", { updatedAt: ago(2) })]);
    f.messages.set("old", [
      { position: 0, type: "message", status: "completed", createdBy: "user", updatedAt: ago(45) },
      { position: 1, type: "message", status: "completed", createdBy: "agent", updatedAt: ago(2) },
    ]);
    const r = await sweep(f);
    expect(rowOf(r, "idle")).toMatchObject({ action: "settled", rule: null, reason: "idle; no ob row" });
    expect(rowOf(r, "old").action).toBe("settled");
    expect(settledIds(f).sort()).toEqual(["idle", "old"]);
    expect(r).toMatchObject({ dryRun: false, settled: 2, kept: 0, failed: 0 });
  });

  test("a dry run settles nothing and prints each thread it would settle with its reason, and each kept one with its rule", async () => {
    const f = world([thread("idle", { title: "Verify PR 12" }), thread("busy", { title: "OS-9 · build", status: "running", activeRunId: "r" })]);
    const r = await sweep(f, NO_ROWS, true);
    expect(settledIds(f)).toEqual([]);
    expect(r).toMatchObject({ dryRun: true, wouldSettle: 1, kept: 1, settled: 0 });
    const text = renderSettleSweep(r);
    expect(text).toContain("(dry run): 1 would settle, 1 kept, 0 failed");
    expect(text).toContain("would settle repo-0 · Verify PR 12  idle  idle; no ob row");
    expect(text).toMatch(/kept\s+repo-0 · OS-9 · build  busy  \[run\] a run is in progress/);
  });

  test("a thread T3 will not read is a failed row and the sweep goes on", async () => {
    const f = world([thread("gone"), thread("idle")]);
    const read = f.seam.read;
    f.seam.read = async (id, o) => {
      if (id === "gone") throw new (await import("../src/t3/client.ts")).T3Error("refused", "t3_thread_read: thread gone not found");
      return read(id, o);
    };
    const r = await sweep(f);
    expect(rowOf(r, "gone")).toMatchObject({ action: "failed" });
    expect(rowOf(r, "idle").action).toBe("settled");
    expect(r.failed).toBe(1);
  });
});

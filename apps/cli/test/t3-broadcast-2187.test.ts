import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { T3Error, type T3Project, type T3SendInput, type T3Thread } from "../src/t3/client.ts";
import type { T3Seam } from "../src/t3/dispatch.ts";
import { broadcast, broadcastRequestId, framedBroadcast, renderBroadcast } from "../src/t3/broadcast.ts";
import { broadcastInput, emitBroadcast } from "../src/commands/t3.ts";

// OB-2187, OB-2255: `ob t3 broadcast architects|threads`, on a fake T3 seam. No live T3, no network.

function thread(id: string, over: Partial<T3Thread> = {}): T3Thread {
  return {
    threadId: id,
    projectId: "p1",
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
    parentThreadId: null,
    ...over,
  };
}

interface World {
  seam: T3Seam;
  /** Messages T3 actually delivered (deduped on clientRequestId, as T3 does). */
  delivered: T3SendInput[];
  sends: T3SendInput[];
  lists: Array<{ projectId?: string; cursor?: number }>;
  failSendFor: Set<string>;
  unreachable: boolean;
  /** read throws a timeout for these threads. */
  slowReadFor: Set<string>;
  /** read is refused with a code other than thread_not_found for these threads. */
  refuseReadFor: Set<string>;
  readOpts: Array<{ afterPosition?: number; limit?: number } | undefined>;
}

function world(threads: T3Thread[], opts: { pageSize?: number } = {}): World {
  const byId = new Map(threads.map((t) => [t.threadId, t]));
  const projects: T3Project[] = [
    { id: "p1", title: "acme", workspaceRoot: "/r/acme" },
    { id: "p2", title: "hackcove", workspaceRoot: "/r/hackcove" },
  ];
  const seenRequests = new Set<string>();
  const w: World = { delivered: [], sends: [], lists: [], failSendFor: new Set(), unreachable: false, slowReadFor: new Set(), refuseReadFor: new Set(), readOpts: [], seam: undefined as unknown as T3Seam };
  const pageSize = opts.pageSize ?? 100;
  const notImplemented = async (): Promise<never> => {
    throw new Error("not used by broadcast");
  };
  w.seam = {
    projects: async () => {
      if (w.unreachable) throw new T3Error("unreachable", "T3 is not running");
      return projects;
    },
    capabilities: notImplemented,
    list: async (o) => {
      w.lists.push({ projectId: o.projectId, cursor: o.cursor });
      // T3 filters settled and subagents server side; the archived field is not on a list row.
      const all = threads.filter((t) => t.projectId === o.projectId && !t.settled && (o.includeSubagents !== false || !t.parentThreadId));
      const start = o.cursor ?? 0;
      const page = all.slice(start, start + Math.min(pageSize, o.limit ?? pageSize));
      const next = start + page.length < all.length ? start + page.length : null;
      return {
        projectId: o.projectId ?? "",
        threads: page.map((t) => ({ threadId: t.threadId, projectId: t.projectId, title: t.title, status: t.status, latestRunId: null, providerInstanceId: "claudeAgent", model: t.model, settled: t.settled, parentThreadId: t.parentThreadId ?? null })),
        nextCursor: next,
      };
    },
    read: async (id, o) => {
      w.readOpts.push(o);
      if (w.slowReadFor.has(id)) throw new T3Error("unreachable", "The operation was aborted.");
      const t = byId.get(id);
      if (w.refuseReadFor.has(id)) throw new T3Error("refused", "t3_thread_read: unavailable", undefined, "unavailable");
      if (!t) throw new T3Error("refused", `thread ${id} not found`, undefined, "thread_not_found");
      return { thread: t, recentRuns: [], items: [], nextPosition: 0, hasMore: false };
    },
    launch: notImplemented,
    pin: notImplemented,
    unpin: notImplemented,
    disableAutoSettle: notImplemented,
    rename: notImplemented,
    settle: notImplemented,
    interrupt: notImplemented,
    send: async (input) => {
      w.sends.push(input);
      if (w.failSendFor.has(input.threadId)) throw new T3Error("refused", "t3_thread_send: thread is busy");
      if (input.clientRequestId && seenRequests.has(input.clientRequestId)) return;
      if (input.clientRequestId) seenRequests.add(input.clientRequestId);
      w.delivered.push(input);
    },
    queue: notImplemented,
    queueCancel: notImplemented,
    wait: notImplemented,
  };
  return w;
}

const ARCHITECTS = [
  thread("om-arch", { title: "🚌 OmniSlash · architect" }),
  thread("hc-arch", { projectId: "p2", title: "⏳🌐 · 🏴‍☠️ Hack Cove · architect", status: "running" }),
  thread("old-arch", { title: "Old · architect", settled: true }),
  thread("arch-arch", { projectId: "p2", title: "Archived · architect", archived: true }),
];
/** OB-2255: the architect audience is the `architect-*` rows, and nothing else. */
const ARCHITECT_ROWS = [
  { id: "architect-acme", launcher: "t3", session_id: "om-arch" },
  { id: "architect-hackcove", launcher: "t3", session_id: "hc-arch" },
  { id: "architect-old", launcher: "t3", session_id: "old-arch" },
  { id: "architect-archived", launcher: "t3", session_id: "arch-arch" },
];
const BUILDERS = [
  thread("ob-1", { title: "OB-1 · a builder" }),
  thread("ob-2", { projectId: "p2", title: "HC-2 · ends in planner · architect" }),
  thread("child", { title: "child · architect", parentThreadId: "om-arch" }),
  thread("done", { title: "OB-3 · settled", settled: true }),
];

describe("ob t3 broadcast architects (OB-2187, OB-2255)", () => {
  test("only architect-* rows' live threads; a title that ends in · architect, a sentinel and a muse are not reached (OB-2255 Done when 6)", async () => {
    const w = world([
      ...ARCHITECTS,
      ...BUILDERS,
      thread("s-thread", { title: "🔪 Slash · sentinel" }),
      thread("m-thread", { title: "🔪 Slash · muse" }),
      thread("titled-only", { title: "Stray · architect" }),
      thread("reg-arch", { title: "Cue · architect", projectId: "p3" }),
    ]);
    const r = await broadcast({
      audience: "architects",
      text: "hello",
      self: "om-arch",
      seam: w.seam,
      rows: [
        ...ARCHITECT_ROWS,
        { id: "architect-cue", launcher: "t3", session_id: "reg-arch" },
        { id: "architect-gone", launcher: "t3", session_id: "gone-thread" },
        { id: "architect-oc", launcher: "opencode", session_id: "ses_1" },
        { id: "sentinel-slash", launcher: "t3", session_id: "s-thread" },
        { id: "muse-slash", launcher: "t3", session_id: "m-thread" },
        { id: "planner-acme", launcher: "t3", session_id: "titled-only" },
      ],
    });
    const sent = r.rows.filter((x) => x.action === "sent").map((x) => x.threadId).sort();
    expect(sent).toEqual(["hc-arch", "reg-arch"]);
    const skipped = Object.fromEntries(r.rows.filter((x) => x.action === "skipped").map((x) => [x.threadId, x.reason]));
    expect(skipped["om-arch"]).toBe("the caller's own thread");
    expect(skipped["gone-thread"]).toContain("T3 cannot find this thread (recorded on architect-gone)");
    expect(Object.keys(skipped).sort()).toEqual(["gone-thread", "om-arch"]);
    expect(w.delivered.map((d) => d.threadId).sort()).toEqual(["hc-arch", "reg-arch"]);
    for (const d of w.delivered) {
      expect(d.mode).toBe("queue");
      expect(d.message).toBe("Broadcast from 🚌 OmniSlash · architect to all active architects:\n\nhello");
    }
  });

  test("with no architect rows nothing is sent, whatever the titles say", async () => {
    const w = world([...ARCHITECTS, ...BUILDERS]);
    const r = await broadcast({ audience: "architects", text: "x", self: null, seam: w.seam, rows: [] });
    expect(w.sends).toHaveLength(0);
    expect(r.recipients).toBe(0);
  });

  test("running the same broadcast twice delivers it once per thread", async () => {
    const w = world([...ARCHITECTS, ...BUILDERS]);
    await broadcast({ audience: "architects", rows: ARCHITECT_ROWS, text: "once", self: null, seam: w.seam });
    await broadcast({ audience: "architects", rows: ARCHITECT_ROWS, text: "once", self: null, seam: w.seam });
    expect(w.sends).toHaveLength(4);
    expect(w.delivered.map((d) => d.threadId).sort()).toEqual(["hc-arch", "om-arch"]);
    expect(new Set(w.sends.map((s) => s.clientRequestId)).size).toBe(2);
  });

  test("the request id is the message's sha256 (12 hex) and the thread; two senders of one text stay two", async () => {
    expect(broadcastRequestId("hi", "t1")).toMatch(/^broadcast:[0-9a-f]{12}:t1$/);
    expect(broadcastRequestId("hi", "t1")).not.toBe(broadcastRequestId("hi!", "t1"));
    const w = world([...ARCHITECTS, ...BUILDERS]);
    await broadcast({ audience: "architects", rows: ARCHITECT_ROWS, text: "same", self: "ob-1", seam: w.seam });
    await broadcast({ audience: "architects", rows: ARCHITECT_ROWS, text: "same", self: "ob-2", seam: w.seam });
    expect(w.delivered).toHaveLength(4);
  });

  test("the text is sent exactly as given", async () => {
    const w = world([...ARCHITECTS]);
    await broadcast({ audience: "architects", rows: ARCHITECT_ROWS, text: "  line one\n\n  indented\n", self: null, seam: w.seam });
    expect(w.delivered[0]!.message).toBe("Broadcast from ob to all active architects:\n\n  line one\n\n  indented\n");
  });

  test("a caller T3 does not list (a subagent) is still named as sender, read from past the end", async () => {
    const w = world([...ARCHITECTS, thread("sub", { title: "OB-9 · a child", parentThreadId: "om-arch" })]);
    await broadcast({ audience: "architects", rows: ARCHITECT_ROWS, text: "x", self: "sub", seam: w.seam });
    expect(w.delivered[0]!.message.split("\n")[0]).toBe("Broadcast from OB-9 · a child to all active architects:");
    expect(w.readOpts.every((o) => (o?.afterPosition ?? 0) >= 1_000_000)).toBe(true);
  });

  test("outside T3 the sender is ob, and lease markers never reach the sender line", () => {
    expect(framedBroadcast("threads", null, "x")).toBe("Broadcast from ob to all active threads:\n\nx");
    expect(framedBroadcast("architects", "⏳🌐 · 🙋 🛍️ acme-shop · architect", "x").split("\n")[0]).toBe("Broadcast from 🛍️ acme-shop · architect to all active architects:");
  });
});

describe("ob t3 broadcast threads (OB-2187)", () => {
  test("every active top-level thread in every project, paged past one page; archived, settled and subagents out", async () => {
    const many = Array.from({ length: 7 }, (_, i) => thread(`b-${i}`, { title: `OB-${10 + i} · builder` }));
    const w = world([...ARCHITECTS, ...BUILDERS, ...many], { pageSize: 3 });
    const r = await broadcast({ audience: "threads", text: "all", self: "ob-1", seam: w.seam });
    const sent = r.rows.filter((x) => x.action === "sent").map((x) => x.threadId).sort();
    expect(sent).toEqual(["b-0", "b-1", "b-2", "b-3", "b-4", "b-5", "b-6", "hc-arch", "ob-2", "om-arch"]);
    expect(r.rows.find((x) => x.threadId === "ob-1")?.reason).toBe("the caller's own thread");
    expect(w.lists.filter((l) => l.projectId === "p1").length).toBeGreaterThan(1);
    expect(w.delivered[0]!.message.startsWith("Broadcast from OB-1 · a builder to all active threads:")).toBe(true);
  });

  test("a dry run lists the recipients and sends nothing", async () => {
    const w = world([...ARCHITECTS, ...BUILDERS]);
    const r = await broadcast({ audience: "threads", text: "x", self: null, dryRun: true, seam: w.seam });
    expect(w.sends).toHaveLength(0);
    expect(r.rows.every((x) => x.action === "would-send")).toBe(true);
    expect(r.rows).toHaveLength(4);
    expect(r).toMatchObject({ recipients: 4, sent: 0 });
    expect(renderBroadcast(r)).toContain("4 active threads would receive it, 0 skipped, 0 failed; nothing was sent");
  });

  test("one failed send is named, the rest are still sent, and the report counts it", async () => {
    const w = world([...ARCHITECTS, ...BUILDERS]);
    w.failSendFor.add("ob-2");
    const r = await broadcast({ audience: "threads", text: "x", self: null, seam: w.seam });
    const failed = r.rows.filter((x) => x.action === "failed");
    expect(failed.map((x) => x.threadId)).toEqual(["ob-2"]);
    expect(failed[0]!.reason).toContain("thread is busy");
    expect(w.delivered.map((d) => d.threadId).sort()).toEqual(["hc-arch", "ob-1", "om-arch"]);
    expect(r.failed).toBe(1);
    expect(renderBroadcast(r)).toContain("FAILED    HC-2 · ends in planner · architect");
    const ctx: { mode: "human"; exit?: number } = { mode: "human" };
    emitBroadcast(ctx, r);
    expect(ctx.exit).toBe(1);
  });

  test("a read refused for any reason but thread_not_found is a failure, not a skip", async () => {
    const w = world([...ARCHITECTS]);
    w.refuseReadFor.add("hc-arch");
    const r = await broadcast({ audience: "architects", rows: ARCHITECT_ROWS, text: "x", self: null, seam: w.seam });
    expect(r.rows.find((x) => x.threadId === "hc-arch")).toMatchObject({ action: "failed" });
    expect(r.failed).toBe(1);
  });

  test("a read that times out fails that thread by name, the rest are sent, and no read walks the timeline", async () => {
    const w = world([...ARCHITECTS, ...BUILDERS]);
    w.slowReadFor.add("om-arch");
    const r = await broadcast({ audience: "architects", rows: ARCHITECT_ROWS, text: "x", self: null, seam: w.seam });
    expect(r.rows.find((x) => x.threadId === "om-arch")).toMatchObject({ action: "failed", title: "🚌 OmniSlash · architect", project: "acme" });
    expect(r.rows.find((x) => x.threadId === "om-arch")!.reason).toContain("aborted");
    expect(w.delivered.map((d) => d.threadId)).toEqual(["hc-arch"]);
    expect(r.failed).toBe(1);
    // A read from the start makes T3 walk a long architect's whole timeline; every read starts past the end.
    expect(w.readOpts.every((o) => (o?.afterPosition ?? 0) >= 1_000_000)).toBe(true);
  });

  test("a deleted project is not read, and a cursor that does not advance stops by name", async () => {
    const w = world([...ARCHITECTS, ...BUILDERS]);
    const projects = await w.seam.projects();
    w.seam.projects = async () => [...projects, { id: "gone", title: "gone", workspaceRoot: "/r/gone", deletedAt: "2026-11-01T00:00:00Z" }];
    await broadcast({ audience: "threads", text: "x", self: null, dryRun: true, seam: w.seam });
    expect(w.lists.some((l) => l.projectId === "gone")).toBe(false);
    w.seam.list = async () => ({ projectId: "p1", threads: [{ threadId: "a", title: "a", status: "idle", latestRunId: null, providerInstanceId: "c", model: "m", settled: false, parentThreadId: null }], nextCursor: 1 });
    await expect(broadcast({ audience: "threads", text: "x", self: null, dryRun: true, seam: w.seam })).rejects.toThrow("cannot be read to the end");
  });

  test("an unreachable T3 fails before any send", async () => {
    const w = world([...ARCHITECTS]);
    w.unreachable = true;
    await expect(broadcast({ audience: "threads", text: "x", self: null, seam: w.seam })).rejects.toThrow("T3 is not running");
    expect(w.sends).toHaveLength(0);
  });
});

describe("the broadcast arguments (OB-2187)", () => {
  test("the audience is required, the message is the rest of the arguments, an empty one refuses", () => {
    expect(() => broadcastInput(["broadcast"], {})).toThrow("requires an audience");
    expect(() => broadcastInput(["broadcast", "everyone", "x"], {})).toThrow("requires an audience");
    expect(() => broadcastInput(["broadcast", "architects", "  "], {})).toThrow("empty message");
    expect(broadcastInput(["broadcast", "threads", "hello", "there"], {})).toEqual({ audience: "threads", text: "hello there" });
  });

  test("--message-file reads the text, and refuses beside an inline message", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-broadcast-"));
    try {
      const f = join(dir, "m.txt");
      writeFileSync(f, "from a file\n");
      expect(broadcastInput(["broadcast", "architects"], { "message-file": f })).toEqual({ audience: "architects", text: "from a file\n" });
      expect(() => broadcastInput(["broadcast", "architects", "x"], { "message-file": f })).toThrow("not both");
      expect(() => broadcastInput(["broadcast", "architects"], { "message-file": join(dir, "missing.txt") })).toThrow("cannot read --message-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The queue read, at the transport (ob 1205).
//
// `dropQueuedReadyNotes` decides whether a readying note is still held by reading `t3_queue` (list), and the
// one thing that read may never do is pass a PARTIAL scan off as a complete one: T3 documents the tool as a
// live OFFSET page, so following a cursor across pages against a queue that other turns are draining can
// step over an item and still run out of cursor. These tests drive the real `T3Client` — the same code the
// command path uses — through a fake fetch, which is the only place that paging behaviour lives.
import { describe, expect, test } from "bun:test";
import { T3Client, type FetchLike } from "../src/t3/client.ts";

const BASE = "https://t3.example.test";
const CREDENTIAL = {
  version: 1 as const,
  baseUrl: BASE,
  accessToken: "t",
  tokenType: "Bearer",
  access: "full-access",
  scopes: [],
  issuedAt: "2026-10-18T00:00:00.000Z",
  expiresAt: "2027-10-18T00:00:00.000Z",
};

interface Call {
  name: string;
  args: Record<string, unknown>;
}

/**
 * A fake T3 MCP endpoint. `pages` are the answers `t3_queue` (`action: "list"`) gives, in order: the first call gets
 * `pages[0]`, the second `pages[1]`, and so on — so a two-page queue is expressed directly.
 */
function fakeT3(pages: Array<{ items: Array<{ queuedRunId: string; text: string; truncated: boolean }>; nextCursor: number | null }>) {
  const calls: Call[] = [];
  let served = 0;
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as {
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const json = (payload: unknown, headers: Record<string, string> = {}): Response =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (body.method === "initialize") {
      return json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "0.1.0" } } }, { "mcp-session-id": "s-1" });
    }
    if (body.method === "notifications/initialized") return json({});
    if (body.method === "tools/call") {
      calls.push({ name: body.params?.name ?? "", args: body.params?.arguments ?? {} });
      if (body.params?.name !== "t3_queue" || body.params?.arguments?.action !== "list") throw new Error(`unexpected tool ${body.params?.name} at ${url}`);
      const page = pages[Math.min(served, pages.length - 1)]!;
      served++;
      return json({ jsonrpc: "2.0", id: 2, result: { structuredContent: page } });
    }
    throw new Error(`unexpected MCP request to ${url}: ${body.method}`);
  };
  return { fetchImpl, calls, servedPages: () => served };
}

function client(fetchImpl: FetchLike): T3Client {
  return new T3Client({ baseUrl: BASE, credential: CREDENTIAL, fetchImpl });
}

const note = (ticket: string, runId: string) => ({ queuedRunId: runId, text: `ready for the gate: ${ticket}\n  ticket:    ${ticket}\n`, truncated: false });

describe("T3Client.queue (1205)", () => {
  test("one page holding the whole queue is a COMPLETE read", async () => {
    const fake = fakeT3([{ items: [note("1205", "run:1"), note("1210", "run:2")], nextCursor: null }]);
    const read = await client(fake.fetchImpl).queue("t-1");
    expect(read.complete).toBe(true);
    expect(read.items.map((m) => m.queuedRunId)).toEqual(["run:1", "run:2"]);
    expect(fake.servedPages()).toBe(1);
  });

  test("an EMPTY queue is complete too — that is the ordinary land", async () => {
    const fake = fakeT3([{ items: [], nextCursor: null }]);
    const read = await client(fake.fetchImpl).queue("t-1");
    expect(read).toEqual({ items: [], complete: true });
    expect(fake.servedPages()).toBe(1);
  });

  test("a queue needing a SECOND page is read on, but is never claimed as complete", async () => {
    // The offsets a later page is computed against can have shifted (something else drained the queue), so
    // the scan may have stepped over an item — even though the final cursor is null. That is "partial".
    const fake = fakeT3([
      { items: [note("1205", "run:1")], nextCursor: 50 },
      { items: [], nextCursor: null },
    ]);
    const read = await client(fake.fetchImpl).queue("t-1");
    expect(read.items.map((m) => m.queuedRunId)).toEqual(["run:1"]);
    expect(read.complete).toBe(false);
    expect(fake.servedPages()).toBe(2);
    // The cursor is passed back: the second call asks for the page after the first.
    expect(fake.calls[1]!.args.cursor).toBe(50);
    // ...and the FIRST page carries NO cursor KEY at all (1264). T3's schema is `cursor?: number`, so a
    // `cursor: null` is an invalid argument and the whole call is refused before a page is read — which is
    // what a first page sent as `cursor: null` did live. Absent, never null.
    expect("cursor" in fake.calls[0]!.args).toBe(false);
  });

  test("pages are walked in order and a match on a later page is still returned", async () => {
    const fake = fakeT3([
      { items: [note("1210", "run:other")], nextCursor: 50 },
      { items: [note("1205", "run:mine")], nextCursor: null },
    ]);
    const read = await client(fake.fetchImpl).queue("t-1");
    expect(read.items.map((m) => m.queuedRunId)).toEqual(["run:other", "run:mine"]);
    expect(read.complete).toBe(false);
  });
});

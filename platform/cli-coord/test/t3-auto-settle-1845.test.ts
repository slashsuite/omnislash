// OB-1845: the seam behind an architect's auto-settle opt-out. Fake fetch and fake socket, no live network;
// the Exit frames are the ones T3 0.1.7 answered with when this route was proven live.
import { describe, expect, test } from "bun:test";
import { T3Error, turnAutoSettleOff, type T3CommandSocket, type T3OrchestrationDeps } from "../../../apps/cli/src/t3/client.ts";

const BEARER = "bearer-must-not-leak";
const TICKET = "ticket-must-not-leak";
const THREAD = "mcp:abc/1";
const SET_AT = "2026-11-06T10:39:21.950Z";

const SUCCESS = { _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: { sequence: 1176140 } } };
const REFUSED = {
  _tag: "Exit",
  requestId: "1",
  exit: {
    _tag: "Failure",
    cause: [{ _tag: "Fail", error: { _tag: "OrchestrationV2DispatchCommandError", commandType: "thread.auto-settle.set", message: `No orchestration projection exists for thread ${THREAD}.` } }],
  },
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function harness(opts: {
  /** What each bounded read answers, in order; the last one repeats. */
  reads?: Array<string | null>;
  readStatus?: number;
  /** What the socket does once it receives the command. */
  answer?: (socket: FakeSocket) => void;
}) {
  const reads = [...(opts.reads ?? [null, SET_AT])];
  const requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const sockets: FakeSocket[] = [];
  const fetchImpl: NonNullable<T3OrchestrationDeps["fetchImpl"]> = async (input, init) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith("/api/auth/websocket-ticket/rpc")) {
      return json(200, { ticket: TICKET, expiresAt: "later" });
    }
    if (opts.readStatus) return json(opts.readStatus, { reason: "thread_not_found" });
    const at = reads.length > 1 ? reads.shift()! : reads[0]!;
    return json(200, { projection: { thread: at ? { autoSettleDisabledAt: at } : {} } });
  };
  const deps: T3OrchestrationDeps = {
    baseUrl: "http://t3.test:3773/",
    env: {},
    timeoutMs: 50,
    fetchImpl,
    issueSessionBearer: () => BEARER,
    openSocket: (url) => {
      const socket = new FakeSocket(url, opts.answer ?? ((s) => s.reply(SUCCESS)));
      sockets.push(socket);
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
  };
  return { deps, requests, sockets };
}

class FakeSocket implements T3CommandSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Array<Record<string, any>> = [];
  closed = 0;
  constructor(
    readonly url: string,
    private readonly answer: (socket: FakeSocket) => void,
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
    this.answer(this);
  }
  reply(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  close() {
    this.closed++;
  }
}

async function failure(run: Promise<unknown>): Promise<T3Error> {
  const err = await run.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(T3Error);
  const text = `${err.message} ${err.remedy ?? ""}`;
  expect(text).not.toContain(BEARER);
  expect(text).not.toContain(TICKET);
  return err;
}

describe("turnAutoSettleOff (OB-1845)", () => {
  test("sends the one command over a ticketed socket and returns what T3's read says", async () => {
    const h = harness({});
    expect(await turnAutoSettleOff(THREAD, h.deps)).toBe(SET_AT);

    expect(h.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET http://t3.test:3773/api/orchestration/threads/mcp%3Aabc%2F1/bounded",
      "POST http://t3.test:3773/api/auth/websocket-ticket/rpc",
      "GET http://t3.test:3773/api/orchestration/threads/mcp%3Aabc%2F1/bounded",
    ]);
    for (const r of h.requests) {
      expect(r.headers.authorization).toBe(`Bearer ${BEARER}`);
      expect(r.headers["x-t3-orchestration-protocol"]).toBe("2");
    }
    const socket = h.sockets[0]!;
    expect(socket.url).toBe(`ws://t3.test:3773/ws?wsTicket=${TICKET}&orchestrationProtocol=2`);
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({ _tag: "Request", id: "1", tag: "orchestration.dispatchCommand", headers: [] });
    expect(socket.sent[0]!.payload).toMatchObject({ type: "thread.auto-settle.set", threadId: THREAD, enabled: false });
    expect(socket.sent[0]!.payload.commandId).toBeString();
    expect(socket.closed).toBe(1);
  });

  test("a thread that already has it off sends no command: a re-run changes nothing", async () => {
    const h = harness({ reads: [SET_AT] });
    expect(await turnAutoSettleOff(THREAD, h.deps)).toBe(SET_AT);
    expect(h.requests).toHaveLength(1);
    expect(h.sockets).toHaveLength(0);
  });

  test("T3's refusal surfaces its own message, and the socket is closed", async () => {
    const h = harness({ answer: (s) => s.reply(REFUSED) });
    const err = await failure(turnAutoSettleOff(THREAD, h.deps));
    expect(err.message).toContain(`No orchestration projection exists for thread ${THREAD}.`);
    expect(h.sockets[0]!.closed).toBe(1);
  });

  test("an accepted command the read does not show is not reported as done", async () => {
    const h = harness({ reads: [null] });
    const err = await failure(turnAutoSettleOff(THREAD, h.deps));
    expect(err.message).toContain("still shows auto-settle on");
  });

  test("a thread T3 does not know is refused before any ticket is asked for", async () => {
    const h = harness({ readStatus: 404 });
    const err = await failure(turnAutoSettleOff(THREAD, h.deps));
    expect(err.message).toContain("thread_not_found");
    expect(h.requests).toHaveLength(1);
  });

  test("a socket that closes, errors or stays silent fails without quoting its URL", async () => {
    for (const answer of [(s: FakeSocket) => s.onclose?.(), (s: FakeSocket) => s.onerror?.(), () => {}]) {
      const h = harness({ answer });
      await failure(turnAutoSettleOff(THREAD, h.deps));
      expect(h.sockets[0]!.closed).toBe(1);
    }
  });

  test("frames that are not this command's Exit are ignored", async () => {
    const h = harness({
      answer: (s) => {
        s.onmessage?.({ data: "not json" });
        s.reply({ _tag: "Pong" });
        s.reply({ ...REFUSED, requestId: "2" });
        s.reply(SUCCESS);
      },
    });
    expect(await turnAutoSettleOff(THREAD, h.deps)).toBe(SET_AT);
  });

  test("a socket that cannot open does not repeat the runtime's message, which can hold the ticket", async () => {
    const h = harness({});
    h.deps.openSocket = (url) => {
      throw new Error(`bad url ${url}`);
    };
    await failure(turnAutoSettleOff(THREAD, h.deps));
  });

});

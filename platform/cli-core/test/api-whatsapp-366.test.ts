// ob 366 -- `ob whatsapp search` / `ob whatsapp recent` over the API. Read-only: the messages live in
// Postgres. OB-1809 served the rest (api-whatsapp-1809.test.ts); only `bridge` still refuses by name.
//
// The CLIENT half runs against a STUBBED transport (no network, no token file, no database), following
// api-client-353's seam. The SERVER half runs against a REAL store through the ob 325 harness -- a local
// cluster on a unix socket, no network and no live database.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import { API_ROUTED_COMMANDS, LOCAL_ONLY_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import { renderCommandHelp } from "../../../apps/cli/src/cli.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import type { WhatsappHit } from "../../cli-whatsapp/src/ingest/whatsapp.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";
const README = readFileSync(join(import.meta.dir, "../../../apps/cli/README.md"), "utf8");

interface Stub {
  transport: ApiTransport;
  calls: ApiRequest[];
}

function stub(answers: Record<string, unknown>): Stub {
  const calls: ApiRequest[] = [];
  const transport: ApiTransport = async (req) => {
    calls.push(req);
    const path = req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]!;
    const key = `${req.method} ${path}`;
    if (!(key in answers)) {
      return {
        status: 404,
        body: JSON.stringify({ error: { code: "unknown_endpoint", message: `no stub for ${key}` } }),
      };
    }
    return { status: 200, body: JSON.stringify(answers[key]) };
  };
  return { transport, calls };
}

function api(s: Stub) {
  return { api: { base: BASE, token: TOKEN, transport: s.transport } };
}

function hit(over: Partial<WhatsappHit> = {}): WhatsappHit {
  return {
    id: "w1",
    chat_jid: "27000000003@s.whatsapp.net",
    chat_name: "DPD",
    sender_jid: "27000000003@s.whatsapp.net",
    content: "your parcel is out for delivery",
    ts: "2026-08-20T10:00:00.000Z",
    is_from_me: 0,
    person_id: null,
    media_type: null,
    quoted_message_id: null,
    transcript: null,
    status: null,
    media_desc: null,
    ...over,
  };
}

describe("routing (366)", () => {
  test("`whatsapp` is ROUTED, has a client handler, and is not local-only", () => {
    expect(API_ROUTED_COMMANDS.has("whatsapp")).toBe(true);
    expect(LOCAL_ONLY_COMMANDS.has("whatsapp")).toBe(false);
    expect(typeof API_HANDLERS.whatsapp).toBe("function");
  });
});

describe("docs/HELP mention the split (366)", () => {
  test("HELP names the served half and that refusals name this machine", () => {
    const help = renderCommandHelp("whatsapp");
    expect(help).toContain("search");
    expect(help).toContain("recent");
    expect(help).toContain("Served over the API");
    expect(help).toContain("API host");
  });

  test("README names the endpoints", () => {
    expect(README).toContain("/api/ob/whatsapp/search");
    expect(README).toContain("/api/ob/whatsapp/recent");
  });
});

describe("`ob whatsapp search|recent` over a stub transport (366)", () => {
  test("`whatsapp search <query>` GETs /whatsapp/search?q= and renders ts\\tchat\\twho\\ttext", async () => {
    const s = stub({ "GET /whatsapp/search": { hits: [hit()] } });
    const r = await runCli(freshDbPath(), ["whatsapp", "search", "DPD"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("2026-08-20T10:00:00.000Z\tDPD\t27000000003@s.whatsapp.net\tyour parcel is out for delivery");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.method).toBe("GET");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/whatsapp/search?q=DPD`);
  });

  test("a from-me hit renders who as 'me', and a missing chat_name falls back to chat_jid", async () => {
    const s = stub({
      "GET /whatsapp/search": {
        hits: [
          hit({ is_from_me: 1, content: "thanks" }),
          hit({ id: "w2", chat_name: null, content: "ok" }),
        ],
      },
    });
    const r = await runCli(freshDbPath(), ["whatsapp", "search", "x"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("\tDPD\tme\tthanks");
    expect(r.out).toContain("\t27000000003@s.whatsapp.net\t27000000003@s.whatsapp.net\tok");
  });

  test("search --json prints the SAME array the local command prints", async () => {
    const row = hit({ content: "hi" });
    const s = stub({ "GET /whatsapp/search": { hits: [row] } });
    const r = await runCli(freshDbPath(), ["whatsapp", "search", "hi", "--json"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([row]);
  });

  test("search without a query is a usage error BEFORE any request", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["whatsapp", "search"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("whatsapp search requires a <query>");
    expect(s.calls).toEqual([]);
  });

  test("`whatsapp recent` GETs /whatsapp/recent and renders the same shape", async () => {
    const s = stub({ "GET /whatsapp/recent": { hits: [hit()] } });
    const r = await runCli(freshDbPath(), ["whatsapp", "recent"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("2026-08-20T10:00:00.000Z\tDPD\t27000000003@s.whatsapp.net\tyour parcel is out for delivery");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/whatsapp/recent`);
  });

  test("recent --limit and --since travel as query params", async () => {
    const s = stub({ "GET /whatsapp/recent": { hits: [] } });
    const r = await runCli(freshDbPath(), ["whatsapp", "recent", "--limit", "5", "--since", "2026-08-01"], api(s));
    expect(r.code).toBe(0);
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/whatsapp/recent?limit=5&since=2026-08-01`);
  });

  test("an empty recent prints the local command's empty line", async () => {
    const s = stub({ "GET /whatsapp/recent": { hits: [] } });
    const r = await runCli(freshDbPath(), ["whatsapp", "recent"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("no whatsapp messages");
  });

  test("recent --quiet prints ids one per line", async () => {
    const s = stub({ "GET /whatsapp/recent": { hits: [hit(), hit({ id: "w2" })] } });
    const r = await runCli(freshDbPath(), ["whatsapp", "recent", "--quiet"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("w1\nw2");
  });

  test("recent --json prints the SAME array the local command prints", async () => {
    const row = hit();
    const s = stub({ "GET /whatsapp/recent": { hits: [row] } });
    const r = await runCli(freshDbPath(), ["whatsapp", "recent", "--json"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([row]);
  });

  test("recent --limit 0 is a usage error BEFORE any request", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["whatsapp", "recent", "--limit", "0"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("whatsapp recent --limit must be a positive number");
    expect(s.calls).toEqual([]);
  });

  test("an unknown sub is a usage error and does not call the API", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["whatsapp", "frobnicate"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown subcommand 'ob whatsapp frobnicate'");
    expect(s.calls).toEqual([]);
  });

  test("bridge run, start and stop refuse by name, as the server's own process, and do not call the API", async () => {
    for (const action of ["run", "start", "stop"]) {
      const s = stub({});
      const r = await runCli(freshDbPath(), ["whatsapp", "bridge", action], api(s));
      expect(r.code).toBe(2);
      expect(r.err).toContain(`'ob whatsapp bridge ${action}' is refused`);
      expect(s.calls).toEqual([]);
    }
  });
});

// --- server half: a real store, reads of what was written --------------------------------------------

const TOKEN_S = "a-test-bearer-token-that-is-long-enough";

function url(path: string): string {
  return `http://api-host.local${OB_API_PREFIX}${path}`;
}

interface ServerCtx {
  store: Store;
  call: (path: string, opts?: { method?: string; body?: unknown }) => Promise<{ status: number; body: any }>;
}

async function insertWa(
  store: Store,
  m: { id: string; content: string; ts: string; chat_name?: string; is_from_me?: number },
): Promise<void> {
  await store.q.insert(store.t.whatsappMessage).values({
    id: m.id,
    chat_jid: "27000000003@s.whatsapp.net",
    chat_name: m.chat_name ?? "DPD",
    sender_jid: "27000000003@s.whatsapp.net",
    content: m.content,
    ts: m.ts,
    is_from_me: m.is_from_me ?? 0,
    created_at: m.ts,
  });
}

async function withApi(fn: (ctx: ServerCtx) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({
    kind: "postgres",
    connection: lease.options as unknown as Record<string, unknown>,
  });
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN_S, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const call = async (path: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> => {
    const res = await api(
      new Request(url(path), {
        method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
        headers: {
          authorization: `Bearer ${TOKEN_S}`,
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
  };
  try {
    await fn({ store, call });
  } finally {
    await store.close();
    await lease.release();
  }
}

describe("GET /whatsapp/recent (366)", () => {
  test("an empty store is an empty list", async () => {
    await withApi(async ({ call }) => {
      const res = await call("/whatsapp/recent");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ hits: [] });
    });
  });

  test("returns the most-recent messages, newest first, honouring limit and since", async () => {
    await withApi(async ({ store, call }) => {
      await insertWa(store, { id: "old", content: "older", ts: "2026-08-01T10:00:00.000Z" });
      await insertWa(store, { id: "mid", content: "middle", ts: "2026-08-10T10:00:00.000Z" });
      await insertWa(store, { id: "new", content: "newest", ts: "2026-08-20T10:00:00.000Z" });
      const all = await call("/whatsapp/recent");
      expect(all.status).toBe(200);
      expect(all.body.hits.map((h: { id: string }) => h.id)).toEqual(["new", "mid", "old"]);
      const limited = await call("/whatsapp/recent?limit=2");
      expect(limited.body.hits.map((h: { id: string }) => h.id)).toEqual(["new", "mid"]);
      const since = await call("/whatsapp/recent?since=2026-08-10T00:00:00.000Z");
      expect(since.body.hits.map((h: { id: string }) => h.id)).toEqual(["new", "mid"]);
    });
  });

  test("a non-positive limit is a named 400", async () => {
    await withApi(async ({ call }) => {
      const res = await call("/whatsapp/recent?limit=0");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
      expect(res.body.error.message).toContain("'limit' must be a positive integer");
    });
  });
});

describe("GET /whatsapp/search (366)", () => {
  test("missing q is a named 400", async () => {
    await withApi(async ({ call }) => {
      const res = await call("/whatsapp/search");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
      expect(res.body.error.message).toContain("'q' is required");
    });
  });

  test("finds ingested content by word, and a miss is an empty list", async () => {
    await withApi(async ({ store, call }) => {
      await insertWa(store, { id: "dpd", content: "DPD delivery tomorrow", ts: "2026-08-20T10:00:00.000Z" });
      await insertWa(store, { id: "other", content: "lunch plans", ts: "2026-08-20T11:00:00.000Z" });
      const found = await call("/whatsapp/search?q=DPD");
      expect(found.status).toBe(200);
      expect(found.body.hits.map((h: { id: string }) => h.id)).toEqual(["dpd"]);
      expect(found.body.hits[0]!.content).toBe("DPD delivery tomorrow");
      const miss = await call("/whatsapp/search?q=unicorns");
      expect(miss.status).toBe(200);
      expect(miss.body.hits).toEqual([]);
    });
  });
});

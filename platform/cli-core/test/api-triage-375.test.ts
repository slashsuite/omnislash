// ob 375 -- `ob triage` over the API, transport only. The local command's exact surface, mirrored: the
// inbox listing (count line, `id<TAB>title` with `·from <origin_repo>` and `- <note>`), clear (flag off,
// item open), reject (flag off, item DONE), and the two usage errors.
//
// The CLIENT half runs against a STUBBED transport (no network, no token file, no database), following
// api-client-353's seam. The SERVER half runs against a REAL store through the ob 325 harness -- a local
// cluster on a unix socket, no network and no live database -- and asserts the SIDE EFFECT read back
// through other endpoints, not the status codes (352's bar).
import { describe, expect, test } from "bun:test";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import { API_ROUTED_COMMANDS, LOCAL_ONLY_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import { freshDbPath, runCli, spawnBudget } from "../../../apps/cli/test/helpers.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";
const BUDGET = spawnBudget(4);

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

/** One triage row exactly as the endpoint serves it. */
function triageRow(over: Record<string, unknown> = {}) {
  return {
    id: "12",
    title: "ship the triage inbox",
    origin_repo: "cue-frontend",
    note: "handed over by the cue architect",
    ...over,
  };
}

describe("routing (375)", () => {
  test("`triage` is ROUTED, has a client handler, and is not local-only", () => {
    expect(API_ROUTED_COMMANDS.has("triage")).toBe(true);
    expect(LOCAL_ONLY_COMMANDS.has("triage")).toBe(false);
    expect(typeof API_HANDLERS.triage).toBe("function");
  });
});

describe("`ob triage` over a stub transport (375)", () => {
  test("bare `ob triage` renders exactly what the local command renders: count line, id<TAB>title, ·from, - note", async () => {
    const s = stub({ "GET /triage": { items: [triageRow()] } });
    const r = await runCli(freshDbPath(), ["triage"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Triage inbox: 1 item(s) awaiting triage");
    expect(r.out).toContain("  12\tship the triage inbox  ·from cue-frontend\t- handed over by the cue architect");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/triage`);
  });

  test("a row without an origin repo or note prints without either part, and a long body arrives pre-truncated", async () => {
    const s = stub({
      "GET /triage": {
        items: [
          triageRow({ origin_repo: null, note: "" }),
          triageRow({ id: "13", title: "long one", origin_repo: null, note: "123456789012345678901234567890123456789012345678901234567890..." }),
        ],
      },
    });
    const r = await runCli(freshDbPath(), ["triage"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("  12\tship the triage inbox");
    expect(r.out).not.toContain("·from");
    expect(r.out).toContain("\t- 123456789012345678901234567890123456789012345678901234567890...");
  });

  test("an empty inbox prints the local command's empty line", async () => {
    const s = stub({ "GET /triage": { items: [] } });
    const r = await runCli(freshDbPath(), ["triage"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("Triage inbox is empty.");
  });

  test("--quiet prints ids one per line", async () => {
    const s = stub({ "GET /triage": { items: [triageRow(), triageRow({ id: "13" })] } });
    const r = await runCli(freshDbPath(), ["triage", "--quiet"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("12\n13");
  });

  test("--json prints the SAME mapping the local command prints", async () => {
    const s = stub({ "GET /triage": { items: [triageRow({ note: "hi" })] } });
    const r = await runCli(freshDbPath(), ["triage", "--json"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([{ id: "12", title: "ship the triage inbox", origin_repo: "cue-frontend", note: "hi" }]);
  });

  test("`triage clear <id>` POSTs to /triage/:id/clear and emits the id", async () => {
    const s = stub({ "POST /triage/42/clear": { id: "42", status: "open" } });
    const r = await runCli(freshDbPath(), ["triage", "clear", "42"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("42");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.method).toBe("POST");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/triage/42/clear`);
  });

  test("`triage reject <id>` POSTs to /triage/:id/reject -- the client NEVER closes", async () => {
    const s = stub({ "POST /triage/42/reject": { id: "42", status: "done" } });
    const r = await runCli(freshDbPath(), ["triage", "reject", "42"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("42");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/triage/42/reject`);
    // The reject is the only write; what follows are the T3 settle's spinoff reads (OB-1928), never a close.
    expect(s.calls.slice(1).every((c) => c.url.includes("/spinoffs"))).toBe(true);
    expect(s.calls.some((c) => c.url.includes("/close"))).toBe(false);
  });

  test("`triage clear|reject` without an <id> is a usage error BEFORE any request", async () => {
    for (const sub of ["clear", "reject"]) {
      const s = stub({});
      const r = await runCli(freshDbPath(), ["triage", sub], api(s));
      expect(r.code).toBe(2);
      expect(r.err).toContain(`triage ${sub} requires an <id>`);
      expect(s.calls).toEqual([]);
    }
  });

  test("an unknown subcommand is a usage error BEFORE any request", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["triage", "frobnicate"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown triage subcommand 'frobnicate'");
    expect(s.calls).toEqual([]);
  });
});

// --- server half: a real store, side effects read back through other endpoints -----------------------

const TOKEN_S = "a-test-bearer-token-that-is-long-enough";

function url(path: string): string {
  return `http://api-host.local${OB_API_PREFIX}${path}`;
}

interface ServerCtx {
  store: Store;
  call: (path: string, opts?: { method?: string; body?: unknown }) => Promise<{ status: number; body: any }>;
  makeTriage: (title: string, extra?: Record<string, unknown>) => Promise<string>;
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
  const makeTriage = async (title: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const created = await call("/items", { body: { type: "task", title, triage: true, ...extra } });
    expect(created.status).toBe(201);
    return created.body.id as string;
  };
  try {
    await fn({ store, call, makeTriage });
  } finally {
    await store.close();
    await lease.release();
  }
}

describe("GET /triage (375)", () => {
  test("an empty inbox is an empty list", async () => {
    await withApi(async ({ call }) => {
      const res = await call("/triage");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [] });
    });
  });

  test("lists exactly the triage-flagged items, newest first, with the rendered snippet", async () => {
    await withApi(async ({ call, makeTriage }) => {
      const older = await makeTriage("older one", { origin_repo: "cue-frontend", body: "a short note" });
      const newer = await makeTriage("newer one", {
        origin_repo: "cue-frontend",
        body: "1234567890".repeat(8), // 80 chars -> truncated to 57 + '...'
      });
      const res = await call("/triage");
      expect(res.status).toBe(200);
      // Newest first: the second-created item leads, even if created_at ties (id breaks the tie).
      expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([newer, older]);
      const [row] = res.body.items as Array<{ id: string; origin_repo: string; note: string }>;
      expect(row.origin_repo).toBe("cue-frontend");
      expect(row.note).toBe("1234567890".repeat(5) + "1234567...");
      const olderRow = res.body.items[1] as { note: string };
      expect(olderRow.note).toBe("a short note");
    });
  });

  test("an item that is NOT triage-flagged is not listed", async () => {
    await withApi(async ({ call }) => {
      const created = await call("/items", { body: { type: "task", title: "not flagged" } });
      expect(created.status).toBe(201);
      const res = await call("/triage");
      expect(res.body.items).toEqual([]);
    });
  });
});

describe("POST /triage/:id/clear and /reject (375)", () => {
  test("clear drops the inbox flag and KEEPS the item open", async () => {
    await withApi(async ({ call, makeTriage }) => {
      const id = await makeTriage("clear me");
      const res = await call(`/triage/${id}/clear`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ id, ref: expect.stringMatching(/^OB-\d+$/), status: "open" });
      // Read the side effect back through OTHER endpoints: gone from the inbox, still open in items.
      const inbox = await call("/triage");
      expect(inbox.body.items.map((i: { id: string }) => i.id)).not.toContain(id);
      const item = await call(`/items/${id}`);
      expect(item.body.item.status).toBe("open");
    });
  });

  test("reject drops the flag AND sets the item 'done' -- the whole close, server-side", async () => {
    await withApi(async ({ call, makeTriage }) => {
      const id = await makeTriage("reject me");
      const res = await call(`/triage/${id}/reject`, { method: "POST" });
      expect(res.status).toBe(200);
      // OB-1928: reject is a close, so it answers the close's shape (issue fields, `issue_error` on drift).
      expect(res.body).toMatchObject({ id, ref: expect.stringMatching(/^OB-\d+$/), status: "done", skipped: "no-link", issue_error: null });
      const inbox = await call("/triage");
      expect(inbox.body.items.map((i: { id: string }) => i.id)).not.toContain(id);
      const item = await call(`/items/${id}`);
      expect(item.body.item.status).toBe("done");
    });
  });

  test("an unknown id is a named 404 for both verbs, and nothing is written", async () => {
    await withApi(async ({ call }) => {
      for (const verb of ["clear", "reject"]) {
        const res = await call(`/triage/nope/${verb}`, { method: "POST" });
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("not_found");
        expect(res.body.error.message).toContain("no item 'nope'");
      }
      const inbox = await call("/triage");
      expect(inbox.body.items).toEqual([]);
    });
  });
});
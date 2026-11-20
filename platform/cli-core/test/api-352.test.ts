// ob 352: the ob API server, end to end over a REAL Postgres store (the ob 325 harness -- a local
// cluster on a unix socket, no network and no live database).
//
// The bar these tests are written to: assert the SIDE EFFECT read back, not the status code. A 200 from
// `POST /items/:id/close` proves the route matched and nothing else; what has to be true is that the item
// is `done` when the next reader asks. Every mutation below writes through one endpoint and reads back
// through another, which is also the only way to catch the class of bug an HTTP boundary specialises in:
// a handler that returns a plausible object having written nothing.
//
// The engine is Postgres deliberately, because that is what the API host fronts and because three of the four
// traps this repo has paid for are Postgres-shaped: count() arrives as a STRING, booleans arrive as 0/1,
// and `ORDER BY ... DESC` puts NULLs FIRST. `triage_count` is asserted by TYPE for the first of those.
import { eq } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { createObApi, isObApiPath } from "../../../apps/cli/src/api/server.ts";
import { loadApiToken, tokenMatches } from "../../../apps/cli/src/api/token.ts";
import { OB_API_LOCAL_ONLY, OB_API_PREFIX, describeRoutes, type ObApiErrorBody } from "../../../apps/cli/src/api/contract.ts";

// Plain code-unit order of the string form, what a bare sort() gives.
const byCodeUnit = (x: string | null, y: string | null) => (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0);

const TOKEN = "a-test-bearer-token-that-is-long-enough";
const OTHER_TOKEN = "a-different-bearer-token-of-similar-size";
const BUDGET = spawnBudget(4);

function url(path: string): string {
  return `http://api-host.local${OB_API_PREFIX}${path}`;
}

interface Call {
  method?: string;
  body?: unknown;
  /** Omit for the good token; pass null for NO Authorization header at all. */
  token?: string | null;
}

interface ApiCtx {
  store: Store;
  /** The handler under test, called with a real Request rather than over a socket. */
  api: (req: Request) => Promise<Response>;
  call(path: string, opts?: Call): Promise<{ status: number; body: any }>;
  /** Create an item through the API and return its id -- the fixture the mutation tests start from. */
  makeItem(title: string, extra?: Record<string, unknown>): Promise<string>;
  raw(path: string, init: RequestInit): Promise<Response>;
  /** Take the token away (or put it back) to exercise the disabled path against a live store. */
  setToken(value: string | null, message?: string | null): void;
}

/**
 * One API over one real Postgres database, torn down afterwards.
 *
 * A database PER TEST rather than one for the file: the harness releases every lease after each test
 * (`installPgTestHooks`), so a database opened in `beforeAll` is dropped out from under the second test.
 * That is the harness working as designed -- isolation is a whole database -- and the cost is paid here
 * rather than worked around.
 */
async function withApi(fn: (ctx: ApiCtx) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({
    kind: "postgres",
    connection: lease.options as unknown as Record<string, unknown>,
  });
  let tokenValue: string | null = TOKEN;
  let tokenMessage: string | null = null;
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: tokenValue, path: "/nowhere/.ob_api_token", reason: null, message: tokenMessage }),
  });
  const raw = async (path: string, init: RequestInit): Promise<Response> => api(new Request(url(path), init));
  const call = async (path: string, opts: Call = {}): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {};
    const token = opts.token === undefined ? TOKEN : opts.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await raw(path, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers,
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
  };
  const makeItem = async (title: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const created = await call("/items", { body: { type: "task", title, ...extra } });
    expect(created.status).toBe(201);
    expect(typeof created.body.id).toBe("string");
    return created.body.id as string;
  };
  try {
    await fn({
      store,
      api,
      call,
      makeItem,
      raw,
      setToken: (value, message = null) => {
        tokenValue = value;
        tokenMessage = message;
      },
    });
  } finally {
    await store.close();
    await lease.release();
  }
}

describe("the ob API refuses before it does anything (352, map D5)", () => {
  test(
    "a request with NO token and one with the WRONG token are indistinguishable, and neither echoes it",
    async () => {
      await withApi(async ({ call, raw }) => {
        const missing = await call("/next", { token: null });
        const wrong = await call("/next", { token: OTHER_TOKEN });
        expect(missing.status).toBe(401);
        expect(wrong.status).toBe(401);
        // Byte for byte the same. Telling the two apart tells an attacker whether a guess had the right
        // shape, and no legitimate client benefits from the distinction.
        expect(missing.body).toEqual(wrong.body);
        expect((missing.body as ObApiErrorBody).error.code).toBe("unauthorized");

        const res = await raw("/next", { headers: { authorization: `Bearer ${OTHER_TOKEN}` } });
        const text = await res.text();
        expect(text).not.toContain(TOKEN); // the real token is never in a response
        expect(text).not.toContain(OTHER_TOKEN); // nor is the one that was presented
        expect(res.headers.get("www-authenticate")).toBe('Bearer realm="ob"'); // the scheme, and nothing else
      });
    },
    BUDGET,
  );

  test(
    "a malformed Authorization header is a 401, not a crash and not a pass",
    async () => {
      await withApi(async ({ raw }) => {
        for (const header of ["", "Bearer", `Basic ${TOKEN}`, "Bearer ", `Token ${TOKEN}`]) {
          const res = await raw("/next", { headers: header ? { authorization: header } : {} });
          expect({ header, status: res.status }).toEqual({ header, status: 401 });
        }
      });
    },
    BUDGET,
  );

  test(
    "with no token configured the API is DISABLED (503), not open",
    async () => {
      await withApi(async ({ call, setToken }) => {
        setToken(null, "no API token file at /nowhere/.ob_api_token, so the ob API is disabled");
        // Even WITH a plausible token, and even on a route that exists and would have answered.
        const res = await call("/next");
        expect(res.status).toBe(503);
        expect((res.body as ObApiErrorBody).error.code).toBe("api_disabled");
        // The reason names the PATH so an operator can fix it, and there is no token to leak.
        expect((res.body as ObApiErrorBody).error.message).toContain("/nowhere/.ob_api_token");
      });
    },
    BUDGET,
  );

  test(
    "an unknown endpoint, and a served path with the wrong METHOD, refuse by name and list what is served",
    async () => {
      await withApi(async ({ call }) => {
        // The rejected `POST /rpc/<command>` shape (map D1) is not quietly a 404 page: it is told what
        // this API does serve, so a client that drifted finds out from the server.
        const rpc = await call("/rpc/close", { body: { argv: ["close", "1"] } });
        expect(rpc.status).toBe(404);
        expect((rpc.body as ObApiErrorBody).error.code).toBe("unknown_endpoint");
        expect((rpc.body as ObApiErrorBody).error.served).toEqual(describeRoutes());

        const wrongMethod = await call("/next", { method: "DELETE" });
        expect(wrongMethod.status).toBe(404);
        expect((wrongMethod.body as ObApiErrorBody).error.code).toBe("unknown_endpoint");

        // A malformed percent-escape is a 400 in OUR error shape. decodeURIComponent throws on it, and
        // a throw that escaped the handler would come back as a bare host 500 with no code in it.
        const malformed = await call("/leases/%");
        expect(malformed.status).toBe(400);
        expect((malformed.body as ObApiErrorBody).error.code).toBe("invalid_request");

        // A LOCAL-ONLY command (map D3) refuses by name WITH ITS REASON, so a client that routed one
        // here is told it asked the wrong machine rather than that it typed the path wrong.
        for (const [command, reason] of Object.entries(OB_API_LOCAL_ONLY)) {
          const res = await call(`/${command}`);
          expect({ command, status: res.status }).toEqual({ command, status: 404 });
          const message = (res.body as ObApiErrorBody).error.message;
          expect({ command, named: message.includes(command) }).toEqual({ command, named: true });
          expect({ command, reasoned: message.includes(reason) }).toEqual({ command, reasoned: true });
        }
      });
    },
    BUDGET,
  );

  test("isObApiPath claims the prefix and nothing else", () => {
    expect(isObApiPath("/api/ob")).toBe(true);
    expect(isObApiPath("/api/ob/next")).toBe(true);
    expect(isObApiPath("/api/obscure")).toBe(false);
    expect(isObApiPath("/api/journal")).toBe(false); // the realtime sidecar's, not ours
    expect(isObApiPath("/")).toBe(false);
  });
});

describe("the token file itself (352, map D5)", () => {
  test("a 600 file loads; a group-readable one is REFUSED and an absent one disables", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-api-token-"));
    try {
      const good = join(dir, "good");
      writeFileSync(good, `${TOKEN}\n`);
      chmodSync(good, 0o600);
      const loaded = loadApiToken(good);
      expect(loaded.token).toBe(TOKEN); // trimmed of the trailing newline
      expect(loaded.reason).toBeNull();

      const loose = join(dir, "loose");
      writeFileSync(loose, TOKEN);
      chmodSync(loose, 0o644);
      const refused = loadApiToken(loose);
      expect(refused.token).toBeNull();
      expect(refused.reason).toBe("permissions");
      // The complaint names the path and the mode, and never the secret it declined to use.
      expect(refused.message).toContain(loose);
      expect(refused.message).not.toContain(TOKEN);

      const empty = join(dir, "empty");
      writeFileSync(empty, "   \n");
      chmodSync(empty, 0o600);
      expect(loadApiToken(empty).reason).toBe("empty");

      const absent = loadApiToken(join(dir, "nothing-here"));
      expect(absent.token).toBeNull();
      expect(absent.reason).toBe("absent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tokenMatches is false for every near miss, and never throws on a length difference", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(tokenMatches("", TOKEN)).toBe(false);
    expect(tokenMatches(null, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, null)).toBe(false);
  });
});

describe("the working loop over the API (352)", () => {
  test(
    "create -> read back -> note -> tag -> state -> close -> reopen, every step verified by a READ",
    async () => {
      await withApi(async ({ call, makeItem }) => {
        const id = await makeItem("api build", { priority: "high", tags: ["gate", "api"], body: "first line" });

        // --- GET /items/:id: the side effect of the create, read through a DIFFERENT endpoint --------
        const shown = await call(`/items/${id}`);
        expect(shown.status).toBe(200);
        expect(shown.body.item.title).toBe("api build");
        expect(shown.body.item.effective_priority).toBe("high");
        expect([...shown.body.item.tags].sort(byCodeUnit)).toEqual(["api", "gate"]);

        // --- POST /items/:id/notes: the appended note is in the BODY afterwards ----------------------
        const noted = await call(`/items/${id}/notes`, { body: { text: "a second thought" } });
        expect(noted.status).toBe(200);
        expect(noted.body.body).toContain("a second thought");
        expect(noted.body.body).toContain("first line"); // appended, not replaced
        expect((await call(`/items/${id}`)).body.item.body).toBe(noted.body.body);

        // --- POST /items/:id/tags: add and remove, and the response is the READ-BACK -----------------
        const tagged = await call(`/items/${id}/tags`, { body: { add: ["shipped"], remove: ["gate"] } });
        expect([...tagged.body.tags].sort(byCodeUnit)).toEqual(["api", "shipped"]);
        expect([...(await call(`/items/${id}`)).body.item.tags].sort(byCodeUnit)).toEqual(["api", "shipped"]);

        // --- POST /items/:id/state ------------------------------------------------------------------
        const started = await call(`/items/${id}/state`, { body: { action: "start" } });
        expect(started.body.status).toBe("in_progress");
        expect((await call(`/items/${id}`)).body.item.status).toBe("in_progress");

        // --- POST /items/:id/close: the local move AND the GitHub half, reported together ------------
        const closed = await call(`/items/${id}/close`, { body: {} });
        expect(closed.status).toBe(200);
        expect(closed.body.status).toBe("done");
        expect(closed.body.issue).toBeNull();
        expect(closed.body.skipped).toBe("no-link"); // nothing was attempted, and it SAYS so
        expect(closed.body.issue_error).toBeNull();
        const afterClose = await call(`/items/${id}`);
        expect(afterClose.body.item.status).toBe("done");
        expect(afterClose.body.item.closed_at).not.toBeNull();

        // --- POST /items/:id/reopen -----------------------------------------------------------------
        const reopened = await call(`/items/${id}/reopen`, { body: {} });
        expect(reopened.body.status).not.toBe("done");
        expect((await call(`/items/${id}`)).body.item.closed_at).toBeNull();
      });
    },
    BUDGET,
  );

  test(
    "block carries a reason, unblock clears it, and each is visible to the next reader",
    async () => {
      await withApi(async ({ call, makeItem }) => {
        const id = await makeItem("blocked work");

        const noReason = await call(`/items/${id}/state`, { body: { action: "block" } });
        expect(noReason.status).toBe(400);
        expect((noReason.body as ObApiErrorBody).error.code).toBe("invalid_request");
        // A refused block writes NOTHING -- the item is exactly as it was.
        expect((await call(`/items/${id}`)).body.item.status).not.toBe("blocked");

        const blocked = await call(`/items/${id}/state`, {
          body: { action: "block", reason: "waiting on the tunnel", owner: "alex-example" },
        });
        expect(blocked.body.status).toBe("blocked");
        const shown = await call(`/items/${id}`);
        expect(shown.body.item.block_reason).toBe("waiting on the tunnel");
        expect(shown.body.item.block_owner).toBe("alex-example");

        const unblocked = await call(`/items/${id}/state`, { body: { action: "unblock" } });
        expect(unblocked.body.status).toBe("open");
        expect((await call(`/items/${id}`)).body.item.block_reason).toBeNull();

        // Unblocking something that is not blocked is a REFUSAL, not a no-op that reads like success.
        const again = await call(`/items/${id}/state`, { body: { action: "unblock" } });
        expect(again.status).toBe(409);
        expect((again.body as ObApiErrorBody).error.code).toBe("refused");
      });
    },
    BUDGET,
  );

  test(
    "the generic state verb REFUSES 'done' by name, and the item is left open",
    async () => {
      await withApi(async ({ call, makeItem }) => {
        const id = await makeItem("must not half-close");
        const res = await call(`/items/${id}/state`, { body: { action: "set", status: "done" } });
        expect(res.status).toBe(409);
        const message = (res.body as ObApiErrorBody).error.message;
        expect(message).toContain("linked GitHub issue");
        expect(message).toContain(`/items/${id}/close`);
        // The whole point: the refusal happened INSTEAD of the move, not after it.
        const after = await call(`/items/${id}`);
        expect(after.body.item.status).not.toBe("done");
        expect(after.body.item.closed_at).toBeNull();
      });
    },
    BUDGET,
  );

  test(
    "an unknown item is a 404 on every path that names one",
    async () => {
      await withApi(async ({ call }) => {
        const cases: Array<[string, Record<string, unknown> | undefined]> = [
          ["/items/999999", undefined],
          ["/items/999999/close", {}],
          ["/items/999999/reopen", {}],
          ["/items/999999/state", { action: "start" }],
          ["/items/999999/notes", { text: "x" }],
          ["/items/999999/tags", { add: ["x"] }],
        ];
        for (const [path, body] of cases) {
          const res = await call(path, body === undefined ? {} : { body });
          expect({ path, status: res.status }).toEqual({ path, status: 404 });
          expect({ path, code: (res.body as ObApiErrorBody).error.code }).toEqual({ path, code: "not_found" });
        }
      });
    },
    BUDGET,
  );

  test(
    "GET /next is the worklist, its order is stable, and its triage count is a NUMBER",
    async () => {
      await withApi(async ({ call, makeItem }) => {
        const low = await makeItem("low priority thing", { priority: "low" });
        const urgent = await makeItem("urgent thing", { priority: "urgent" });

        const res = await call("/next");
        expect(res.status).toBe(200);
        const ids = (res.body.items as Array<{ id: string }>).map((i) => i.id);
        expect(ids).toContain(urgent);
        expect(ids).toContain(low);
        expect(ids.indexOf(urgent)).toBeLessThan(ids.indexOf(low));
        // count() arrives from Postgres as a STRING; "0" is truthy and "0" > 0 is false, so this is
        // asserted by TYPE and not only by value.
        expect(typeof res.body.triage_count).toBe("number");

        // Stable: the same call twice returns the same sequence. Two items created in the same
        // millisecond tie on updated_at, and an unbroken tie is where Postgres and SQLite diverge.
        const again = await call("/next");
        expect((again.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual(ids);
      });
    },
    BUDGET,
  );

  test(
    "GET /items filters and caps, and refuses a query it cannot honour rather than ignoring it",
    async () => {
      await withApi(async ({ call, makeItem }) => {
        const id = await makeItem("filterable", { tags: ["filter-me"], priority: "medium" });
        await makeItem("not filterable");

        const byTag = await call("/items?tag=filter-me");
        expect((byTag.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([id]);

        const byPriority = await call("/items?priority=medium&tag=filter-me");
        expect((byPriority.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([id]);

        const capped = await call("/items?open=true&limit=1");
        expect((capped.body.items as unknown[]).length).toBe(1);

        // A priority nobody has still returns a narrow list, not everything.
        const none = await call("/items?tag=filter-me&priority=urgent");
        expect(none.body.items).toEqual([]);

        // A garbage value is a 400 naming the field. Silently dropping an unparseable filter would hand
        // back the WHOLE tracker in answer to a narrow question: the wrong answer that looks right.
        for (const q of ["priority=enormous", "limit=-1", "limit=x", "by=whatever", "open=maybe"]) {
          const res = await call(`/items?${q}`);
          expect({ q, status: res.status }).toEqual({ q, status: 400 });
        }
      });
    },
    BUDGET,
  );

  test(
    "GET /search finds what was written through the API, and refuses an empty query",
    async () => {
      await withApi(async ({ call, makeItem }) => {
        const id = await makeItem("cloudflare tunnel plumbing");
        const found = await call("/search?q=cloudflare");
        expect(found.status).toBe(200);
        expect((found.body.items as Array<{ id: string }>).map((i) => i.id)).toContain(id);
        expect(found.body.query).toBe("cloudflare");

        const empty = await call("/search");
        expect(empty.status).toBe(400);
        expect((empty.body as ObApiErrorBody).error.code).toBe("invalid_request");
      });
    },
    BUDGET,
  );

  test(
    "GET /status is the rollup, and GET /health names the engine actually being fronted",
    async () => {
      await withApi(async ({ call }) => {
        const res = await call("/status");
        expect(res.status).toBe(200);
        const rollup = res.body.status;
        for (const key of ["agents", "needs_review", "in_flight_prs", "blocked", "focus", "journal"]) {
          expect({ key, isArray: Array.isArray(rollup[key]) }).toEqual({ key, isArray: true });
        }
        expect((await call("/health")).body).toEqual({ ok: true, store: "postgres" });
      });
    },
    BUDGET,
  );

  test(
    "a bad body is refused by field, and the store is untouched",
    async () => {
      await withApi(async ({ call, raw }) => {
        const before = ((await call("/items?open=true")).body.items as unknown[]).length;
        const bodies: Array<Record<string, unknown>> = [
          { title: "no type" },
          { type: "task" },
          { type: "task", title: "" },
          { type: "task", title: "x", tags: "not-an-array" },
          // Boolean("1") and Boolean("0") are BOTH true, so a coerced boolean would file an item into
          // triage on the strength of a string. This is the trap asserted, not reasoned about.
          { type: "task", title: "x", triage: "1" },
          { type: "task", title: "x", priority: "enormous" },
          { type: "nonsense", title: "x" },
          // item.status is free TEXT in the schema, so an unvalidated value would be stored happily and
          // then match no filter, no vocabulary and no transition.
          { type: "task", title: "x", status: "nearly-done" },
        ];
        for (const body of bodies) {
          const res = await call("/items", { body });
          expect({ body, status: res.status }).toEqual({ body, status: 400 });
        }
        expect(((await call("/items?open=true")).body.items as unknown[]).length).toBe(before);

        const notJson = await raw("/items", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: "{ not json",
        });
        expect(notJson.status).toBe(400);
      });
    },
    BUDGET,
  );
});

describe("coordination over the API (352)", () => {
  test(
    "registering an agent CLAIMS its ticket, refuses a second session, and done releases it",
    async () => {
      await withApi(async ({ call, makeItem }) => {
        const ticket = await makeItem("a ticket two sessions want");

        const first = await call("/agents", {
          body: { action: "register", id: "builder-a", ticket, status: "working", branch: "build-a", ttl_s: 600 },
        });
        expect(first.status).toBe(200);
        expect(first.body.agent.id).toBe("builder-a");
        expect(first.body.ticket_lease).toBe(`ticket:${ticket}`);

        // The claim is REAL: a different endpoint sees the lease.
        const held = await call("/leases");
        const row = (held.body.leases as Array<{ resource: string; holder: string; expired: boolean }>).find(
          (l) => l.resource === `ticket:${ticket}`,
        );
        expect(row?.holder).toBe("builder-a");
        // Postgres stores booleans as 0/1 integers; `expired` must arrive as a real boolean.
        expect(typeof row?.expired).toBe("boolean");
        expect(row?.expired).toBe(false);

        // A SECOND session on the same ticket is refused, and the refusal names the holder.
        const second = await call("/agents", { body: { action: "register", id: "builder-b", ticket, ttl_s: 600 } });
        expect(second.status).toBe(409);
        expect((second.body as ObApiErrorBody).error.message).toContain("builder-a");
        // and nothing was written for it
        expect((await call("/agents")).body.agents.map((a: { id: string }) => a.id)).not.toContain("builder-b");

        // Re-registering as the SAME agent is the heartbeat form and keeps the same lease and ticket.
        const refresh = await call("/agents", {
          body: { action: "register", id: "builder-a", status: "readying", ttl_s: 600 },
        });
        expect(refresh.body.agent.status).toBe("readying");
        expect(refresh.body.agent.ticket).toBe(ticket);
        expect(refresh.body.ticket_lease).toBe(`ticket:${ticket}`);

        // A heartbeat on an agent that does not exist is a 404, not a silent create.
        const ghost = await call("/agents", { body: { action: "heartbeat", id: "builder-ghost" } });
        expect(ghost.status).toBe(404);
        expect((await call("/agents")).body.agents.map((a: { id: string }) => a.id)).not.toContain("builder-ghost");

        // done clears the row AND frees the ticket, so the next session can take it.
        const done = await call("/agents", { body: { action: "done", id: "builder-a" } });
        expect(done.body.found).toBe(true);
        expect(done.body.released).toContain(`ticket:${ticket}`);
        expect((await call("/leases")).body.leases.map((l: { resource: string }) => l.resource)).not.toContain(
          `ticket:${ticket}`,
        );
        const now = await call("/agents", { body: { action: "register", id: "builder-b", ticket, ttl_s: 600 } });
        expect(now.status).toBe(200);
        expect(now.body.ticket_lease).toBe(`ticket:${ticket}`);
      });
    },
    BUDGET,
  );

  test(
    "a register's `status` and the mirror's `run` are separate fields, one writer each (1189)",
    async () => {
      await withApi(async ({ call }) => {
        // An agent registering itself: no status means the agent's OWN default word.
        const self = await call("/agents", { body: { action: "register", id: "builder-self", ttl_s: 600 } });
        expect(self.body.agent.status).toBe("working");
        expect(self.body.agent.run).toBeNull();

        // The agent's word, then the mirror's run: each lands in its OWN field, and neither writer touches
        // the other's — this is the whole point of the split.
        await call("/agents", { body: { action: "register", id: "builder-self", status: "needs-human", ttl_s: 600 } });
        const mirrored = await call("/agents", {
          body: { action: "register", id: "builder-self", run: "running", launcher: "t3", ttl_s: 600 },
        });
        expect(mirrored.body.agent.status).toBe("needs-human"); // the mirror never touches ob's word
        expect(mirrored.body.agent.run).toBe("running");

        // A run-only register that finds NO row recreates it with NO workflow word at all — the launcher and
        // the mirror claim none, and the store-backed path answers the same way.
        const recreated = await call("/agents", {
          body: { action: "register", id: "builder-mirror-only", run: "completed", launcher: "t3", ttl_s: 600 },
        });
        expect(recreated.body.agent.status).toBeNull();
        expect(recreated.body.agent.run).toBe("completed");
      });
    },
    BUDGET,
  );

  test(
    "set-run writes `run` on an existing row only, and moves the heartbeat only while the run is active (OB-1923)",
    async () => {
      await withApi(async ({ call, store }) => {
        // No row: found false, and no row is created.
        const ghost = await call("/agents", { body: { action: "set-run", id: "builder-ghost", run: "running" } });
        expect(ghost.status).toBe(200);
        expect(ghost.body.found).toBe(false);
        expect(ghost.body.agent).toBeNull();
        expect((await call("/agents?all=1")).body.agents.map((a: { id: string }) => a.id)).not.toContain("builder-ghost");

        // `run` is required for this action.
        expect((await call("/agents", { body: { action: "set-run", id: "builder-ghost" } })).status).toBe(400);

        await call("/agents", { body: { action: "register", id: "builder-r", status: "working", ttl_s: 600 } });
        const OLD = "2020-01-01T00:00:00.000Z";
        const age = () => store.q.update(store.t.agent).set({ heartbeat_at: OLD }).where(eq(store.t.agent.id, "builder-r"));

        await age();
        const active = await call("/agents", { body: { action: "set-run", id: "builder-r", run: "running" } });
        expect(active.body.found).toBe(true);
        expect(active.body.agent.run).toBe("running");
        expect(active.body.agent.status).toBe("working");
        expect(active.body.agent.heartbeat_at).not.toBe(OLD);

        await age();
        const finished = await call("/agents", { body: { action: "set-run", id: "builder-r", run: "completed" } });
        expect(finished.body.agent.run).toBe("completed");
        expect(finished.body.agent.heartbeat_at).toBe(OLD);
      });
    },
    BUDGET,
  );

  test(
    "leases acquire, refuse a live foreign holder, heartbeat only what is held, and release",
    async () => {
      await withApi(async ({ call }) => {
        const resource = "worktree:/tmp/some-checkout";
        const encoded = encodeURIComponent(resource);

        const got = await call("/leases", { body: { resource, holder: "architect-acme", ttl_s: 1800 } });
        // The decision fields, not the whole body: `recorded` (352b) rides along and carries a timestamp,
        // so pinning the object exactly would make this test fail on an additive change rather than on a
        // behavioural one. The recorded row has its own test.
        expect({ resource: got.body.resource, ok: got.body.ok, holder: got.body.holder }).toEqual({
          resource,
          ok: true,
          holder: "architect-acme",
        });

        const denied = await call("/leases", { body: { resource, holder: "architect-other", ttl_s: 1800 } });
        // ok:false with the LIVE holder named -- the refusal IS the primitive, not an error status.
        expect({ resource: denied.body.resource, ok: denied.body.ok, holder: denied.body.holder }).toEqual({
          resource,
          ok: false,
          holder: "architect-acme",
        });

        // A heartbeat REFRESHES a hold and refuses to CREATE one.
        const beat = await call("/leases", {
          body: { resource, holder: "architect-acme", ttl_s: 1800, heartbeat: true },
        });
        expect(beat.body.ok).toBe(true);
        const beatUnheld = await call("/leases", {
          body: { resource: "worktree:/tmp/never-taken", holder: "architect-acme", ttl_s: 1800, heartbeat: true },
        });
        expect(beatUnheld.body.ok).toBe(false);
        expect((await call("/leases")).body.leases.map((l: { resource: string }) => l.resource)).not.toContain(
          "worktree:/tmp/never-taken",
        );

        // A release by the WRONG holder does nothing, and says so.
        const wrong = await call(`/leases/${encoded}?holder=architect-other`, { method: "DELETE" });
        expect(wrong.body.released).toBe(false);
        expect((await call("/leases")).body.leases.map((l: { resource: string }) => l.resource)).toContain(resource);

        const right = await call(`/leases/${encoded}?holder=architect-acme`, { method: "DELETE" });
        expect(right.body.released).toBe(true);
        expect((await call("/leases")).body.leases.map((l: { resource: string }) => l.resource)).not.toContain(
          resource,
        );

        // A release with no holder at all is refused rather than defaulting to something.
        expect((await call(`/leases/${encoded}`, { method: "DELETE" })).status).toBe(400);
      });
    },
    BUDGET,
  );
});

describe("the coordination endpoints phase B needed (352b)", () => {
  test(
    "the lease responses carry `recorded`, so a refusal can say WHO holds it",
    async () => {
      await withApi(async ({ call }) => {
        const resource = "worktree:/tmp/recorded-checkout";
        const encoded = encodeURIComponent(resource);

        const got = await call("/leases", { body: { resource, holder: "architect-acme", ttl_s: 1800 } });
        expect(got.body.ok).toBe(true);
        expect(got.body.recorded.holder).toBe("architect-acme");
        // Postgres stores booleans as 0/1 integers; this must arrive as a real boolean or the client's
        // `if (recorded.expired)` reads 0 as false and 1 as true purely by luck.
        expect(typeof got.body.recorded.expired).toBe("boolean");
        expect(got.body.recorded.expired).toBe(false);

        // A REFUSED acquire names the live holder in `recorded`, not the caller.
        const denied = await call("/leases", { body: { resource, holder: "architect-other", ttl_s: 1800 } });
        expect(denied.body.ok).toBe(false);
        expect(denied.body.recorded.holder).toBe("architect-acme");

        // A refused HEARTBEAT is the case #75 was written for: without `recorded` the client can only say
        // it beat nothing, which reads like a bug and sends people to --force.
        const beat = await call("/leases", {
          body: { resource, holder: "architect-other", ttl_s: 1800, heartbeat: true },
        });
        expect(beat.body.ok).toBe(false);
        expect(beat.body.recorded.holder).toBe("architect-acme");

        // A refused RELEASE, same.
        const wrong = await call(`/leases/${encoded}?holder=architect-other`, { method: "DELETE" });
        expect(wrong.body.released).toBe(false);
        expect(wrong.body.recorded.holder).toBe("architect-acme");

        // A SUCCESSFUL release deletes the row, so reporting a hold would be a lie in the one direction
        // that matters: it would read as still being somebody's.
        const right = await call(`/leases/${encoded}?holder=architect-acme`, { method: "DELETE" });
        expect(right.body.released).toBe(true);
        expect(right.body.recorded).toBeNull();
        // and it really is gone
        expect((await call("/leases")).body.leases.map((l: { resource: string }) => l.resource)).not.toContain(resource);

        // Heartbeating a lease nobody holds creates nothing and names nobody.
        const untaken = await call("/leases", {
          body: { resource: "worktree:/tmp/untaken", holder: "architect-acme", ttl_s: 1800, heartbeat: true },
        });
        expect(untaken.body.ok).toBe(false);
        expect(untaken.body.recorded).toBeNull();
      });
    },
    BUDGET,
  );

  test(
    "GET /agents/active answers StayAwake, and its count is a NUMBER",
    async () => {
      await withApi(async ({ call }) => {
        const quiet = await call("/agents/active");
        expect(quiet.status).toBe(200);
        expect(quiet.body).toEqual({ active: false, count: 0, within_min: 20 });
        // count() arrives from Postgres as a STRING. `"0" > 0` is false and `Boolean("0")` is true, so
        // this is the field that decides whether a laptop sleeps mid-build, and it is asserted by TYPE.
        expect(typeof quiet.body.count).toBe("number");
        expect(typeof quiet.body.active).toBe("boolean");

        await call("/agents", { body: { action: "register", id: "builder-awake", status: "working", ttl_s: 900 } });
        const busy = await call("/agents/active");
        expect(busy.body).toEqual({ active: true, count: 1, within_min: 20 });
        expect(typeof busy.body.count).toBe("number");

        // The window is honoured and echoed back, so a client never has to assume which one was used.
        expect((await call("/agents/active?within_min=5")).body).toEqual({ active: true, count: 1, within_min: 5 });

        // A window that cannot mean anything is refused rather than falling back to the default, which
        // would answer a question nobody asked.
        for (const q of ["within_min=0", "within_min=-5", "within_min=soon"]) {
          const res = await call(`/agents/active?${q}`);
          expect({ q, status: res.status }).toEqual({ q, status: 400 });
        }

        expect((await call("/agents/active", { token: null })).status).toBe(401);
      });
    },
    BUDGET,
  );
});

describe("the config table over the API (server is the source of truth)", () => {
  test(
    "set writes through one endpoint and reads back through another; a missing key reads null",
    async () => {
      await withApi(async ({ call }) => {
        const before = await call("/config?key=spinoff_engine");
        expect(before.status).toBe(200);
        expect(before.body).toEqual({ config: [{ key: "spinoff_engine", value: null }] });

        const set = await call("/config", { body: { key: "spinoff_engine", value: "opencode" } });
        expect(set.status).toBe(200);
        expect(set.body).toEqual({ key: "spinoff_engine", value: "opencode" });

        const after = await call("/config?key=spinoff_engine");
        expect(after.body.config[0].value).toBe("opencode");

        // list carries the key too, so `ob config` renders it as a line.
        const listed = await call("/config");
        const row = listed.body.config.find((r: { key: string }) => r.key === "spinoff_engine");
        expect(row.value).toBe("opencode");
      });
    },
    BUDGET,
  );
});

describe("the ob<->issue pairs over the API (169)", () => {
  test(
    "link writes a pair, list reads it back, unlink clears it",
    async () => {
      await withApi(async ({ call, makeItem }) => {
        const id = await makeItem("pair me with gh#166");

        const link = await call("/issues/link", { body: { item_id: id, number: 166 } });
        expect(link.status).toBe(200);
        // A bare number resolves to wayfinder_repo, and the url is the canonical form the CLI renders.
        expect(link.body).toEqual({
          id,
          issue: 166,
          repo: "owner/acme",
          url: "https://github.com/owner/acme/issues/166",
        });

        // The pair is a STORED row, read back through the list endpoint -- not an echo.
        const listed = await call("/issues");
        expect(listed.status).toBe(200);
        expect(listed.body.issues).toEqual([
          { id, status: "open", title: "pair me with gh#166", issue: 166, repo: "owner/acme" },
        ]);

        const unlink = await call("/issues/unlink", { body: { item_id: id } });
        expect(unlink.status).toBe(200);
        expect(unlink.body).toEqual({
          id,
          kind: "issue",
          issue: 166,
          linear_id: null,
          url: "https://github.com/owner/acme/issues/166",
        });

        const after = await call("/issues");
        expect(after.body.issues).toEqual([]);
      });
    },
    BUDGET,
  );

  test(
    "an issue already paired with a DIFFERENT item refuses (409), naming the holder",
    async () => {
      await withApi(async ({ call, makeItem }) => {
        const first = await makeItem("already linked");
        const second = await makeItem("wants the same issue");

        const ok = await call("/issues/link", { body: { item_id: first, number: 166 } });
        expect(ok.status).toBe(200);

        const clash = await call("/issues/link", { body: { item_id: second, number: 166 } });
        expect(clash.status).toBe(409);
        expect(clash.body.error.code).toBe("refused");
        expect(clash.body.error.message).toContain(`already linked to ob ${first}`);

        // The refused link wrote nothing: the pair still names the FIRST item.
        const listed = await call("/issues");
        expect(listed.body.issues.map((i: { id: string }) => i.id)).toEqual([first]);
      });
    },
    BUDGET,
  );

  test(
    "a missing item is a 404, and unlink on a bare item clears nothing",
    async () => {
      await withApi(async ({ call, makeItem }) => {
        const missing = await call("/issues/link", { body: { item_id: "nope", number: 2 } });
        expect(missing.status).toBe(404);

        const id = await makeItem("no reference yet");
        const unlink = await call("/issues/unlink", { body: { item_id: id } });
        expect(unlink.status).toBe(200);
        expect(unlink.body).toEqual({ id, kind: null, issue: null, linear_id: null, url: null });
      });
    },
    BUDGET,
  );
});

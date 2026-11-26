// ob 415 -- `ob gmail` / `ob cal` / `ob agenda` over the API. Store reads plus sync ON THE HOST
// using secret `google`. `ob google auth` is SPLIT (420): loopback RUNS here, persist via secret API.
//
// The CLIENT half runs against a STUBBED transport (no network, no token file, no database), following
// api-client-353's seam. The SERVER half runs against a REAL store through the ob 325 harness -- a local
// cluster on a unix socket, no network and no live database. Sync injects a fake GoogleClient so it
// never hits Google.
import { describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { saDayBounds } from "../../cli-sources/src/sa-time.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import { API_ROUTED_COMMANDS, LOCAL_ONLY_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import { renderCommandHelp, renderSubcommandHelp } from "../../../apps/cli/src/cli.ts";
import { freshDbPath, runCli, spawnBudget } from "../../../apps/cli/test/helpers.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import type { EmailHit } from "../../cli-sources/src/ingest/gmail.ts";
import type { AgendaRow } from "../../cli-sources/src/ingest/calendar.ts";
import type {
  CalendarListResponse,
  GmailHistoryResponse,
  GmailListResponse,
  GmailMessage,
  GoogleClient,
} from "../../cli-sources/src/google.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";
const README = cliDocs();
const PG_BUDGET = spawnBudget(2);

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

function hit(over: Partial<EmailHit> = {}): EmailHit {
  return {
    id: "m1",
    from_addr: "alice@example.com",
    subject: "Quarterly planning",
    ts: "2026-08-20T10:00:00.000Z",
    snippet: "Let's align",
    person_id: null,
    ...over,
  };
}

function event(over: Partial<AgendaRow> = {}): AgendaRow {
  return {
    id: "e1",
    calendar_id: "primary",
    summary: "Standup",
    start_ts: "2026-08-24T09:30:00.000Z",
    end_ts: "2026-08-24T09:45:00.000Z",
    all_day: 0,
    person_id: null,
    ...over,
  };
}

class FakeGoogleClient implements GoogleClient {
  listCalls = 0;
  calCalls = 0;
  gmailListMessages(): Promise<GmailListResponse> {
    this.listCalls++;
    return Promise.resolve({});
  }
  gmailGetMessage(id: string): Promise<GmailMessage> {
    throw new Error(`fixture missing message ${id}`);
  }
  gmailHistoryList(): Promise<GmailHistoryResponse> {
    return Promise.resolve({ historyId: "0" });
  }
  gmailGetProfile(): Promise<{ historyId?: string }> {
    return Promise.resolve({ historyId: "4242" });
  }
  calendarListEvents(): Promise<CalendarListResponse> {
    this.calCalls++;
    return Promise.resolve({ items: [] });
  }
}

describe("routing (415)", () => {
  test("`gmail` `cal` `agenda` `google` are ROUTED, have client handlers, and are not local-only", () => {
    for (const cmd of ["gmail", "cal", "agenda", "google"] as const) {
      expect(API_ROUTED_COMMANDS.has(cmd)).toBe(true);
      expect(LOCAL_ONLY_COMMANDS.has(cmd)).toBe(false);
      expect(typeof API_HANDLERS[cmd]).toBe("function");
    }
  });
});

describe("docs/HELP mention the split (415)", () => {
  test("HELP names the served half and that google auth is THIS machine, not the API host", () => {
    const gmailHelp = renderCommandHelp("gmail");
    const googleAuthHelp = renderSubcommandHelp("google", "auth");
    expect(gmailHelp).toContain("gmail list");
    expect(gmailHelp).toContain("gmail search");
    expect(gmailHelp).toContain("Served over the API");
    expect(googleAuthHelp).toContain("this machine");
    expect(googleAuthHelp).toContain("Split over API");
  });

  test("README names the endpoints", () => {
    expect(README).toContain("/api/ob/gmail/search");
    expect(README).toContain("/api/ob/gmail/list");
    expect(README).toContain("/api/ob/gmail/sync");
    expect(README).toContain("/api/ob/cal/agenda");
    expect(README).toContain("/api/ob/cal/sync");
  });
});

describe("`ob gmail` over a stub transport (415)", () => {
  test("`gmail search <query>` GETs /gmail/search?q= and renders id\\tts\\tfrom\\tsubject", async () => {
    const s = stub({ "GET /gmail/search": { hits: [hit()] } });
    const r = await runCli(freshDbPath(), ["gmail", "search", "Quarterly"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("m1\t2026-08-20T10:00:00.000Z\talice@example.com\tQuarterly planning");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.method).toBe("GET");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/gmail/search?q=Quarterly`);
  });

  test("a missing from_addr falls back to '-', a missing subject to '(no subject)'", async () => {
    const s = stub({
      "GET /gmail/search": { hits: [hit({ from_addr: null, subject: null })] },
    });
    const r = await runCli(freshDbPath(), ["gmail", "search", "x"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("m1\t2026-08-20T10:00:00.000Z\t-\t(no subject)");
  });

  test("search --json prints the SAME array the local command prints", async () => {
    const row = hit({ subject: "hi" });
    const s = stub({ "GET /gmail/search": { hits: [row] } });
    const r = await runCli(freshDbPath(), ["gmail", "search", "hi", "--json"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([row]);
  });

  test("search without a query is a usage error BEFORE any request", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["gmail", "search"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("gmail search requires a <query>");
    expect(s.calls).toEqual([]);
  });

  test("`gmail list` GETs /gmail/list and renders the same shape", async () => {
    const s = stub({ "GET /gmail/list": { hits: [hit()] } });
    const r = await runCli(freshDbPath(), ["gmail", "list"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("m1\t2026-08-20T10:00:00.000Z\talice@example.com\tQuarterly planning");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/gmail/list`);
  });

  test("list --limit and --since travel as query params", async () => {
    const s = stub({ "GET /gmail/list": { hits: [] } });
    const r = await runCli(freshDbPath(), ["gmail", "list", "--limit", "5", "--since", "2026-08-01"], api(s));
    expect(r.code).toBe(0);
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/gmail/list?limit=5&since=2026-08-01`);
  });

  test("`gmail sync` POSTs /gmail/sync and renders the local line", async () => {
    const s = stub({
      "POST /gmail/sync": { messages: 3, skipped: 1, ingested: 2, cursor: "9001" },
    });
    const r = await runCli(freshDbPath(), ["gmail", "sync", "--backfill", "--max", "10"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("gmail sync — 3 fetched, 1 skipped, 2 new (cursor 9001)");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.method).toBe("POST");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/gmail/sync`);
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ backfill: true, max: 10 });
  });

  test("sync --json prints the SAME object the local command prints", async () => {
    const body = { messages: 0, skipped: 0, ingested: 0, cursor: null };
    const s = stub({ "POST /gmail/sync": body });
    const r = await runCli(freshDbPath(), ["gmail", "sync", "--json"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(body);
  });

  test("an unknown sub refuses by name and does not call the API", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["gmail", "frobnicate"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown gmail subcommand 'frobnicate'");
    expect(s.calls).toEqual([]);
  });
});

describe("`ob cal` / `ob agenda` over a stub transport (415)", () => {
  test("`cal agenda` GETs /cal/agenda and renders time\\tsummary", async () => {
    const s = stub({ "GET /cal/agenda": { events: [event()] } });
    const r = await runCli(freshDbPath(), ["cal", "agenda"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("11:30\tStandup");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/cal/agenda`);
  });

  test("bare `ob cal` and `ob agenda` hit the same endpoint", async () => {
    for (const args of [["cal"], ["agenda"]]) {
      const s = stub({ "GET /cal/agenda": { events: [event()] } });
      const r = await runCli(freshDbPath(), args, api(s));
      expect(r.code).toBe(0);
      expect(r.out).toContain("11:30\tStandup");
      expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/cal/agenda`);
    }
  });

  test("an all-day event renders 'all-day', a missing title '(no title)'", async () => {
    const s = stub({
      "GET /cal/agenda": { events: [event({ all_day: 1, summary: null, start_ts: "2026-08-24" })] },
    });
    const r = await runCli(freshDbPath(), ["agenda"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("all-day\t(no title)");
  });

  test("an empty agenda prints the local command's empty line", async () => {
    const s = stub({ "GET /cal/agenda": { events: [] } });
    const r = await runCli(freshDbPath(), ["agenda"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("no events today");
  });

  test("agenda --json prints the SAME array the local command prints", async () => {
    const row = event();
    const s = stub({ "GET /cal/agenda": { events: [row] } });
    const r = await runCli(freshDbPath(), ["agenda", "--json"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([row]);
  });

  test("`cal sync` POSTs /cal/sync and renders the local line", async () => {
    const s = stub({
      "POST /cal/sync": { events: 4, ingested: 2, calendars: ["primary", "work"] },
    });
    const r = await runCli(freshDbPath(), ["cal", "sync", "--since", "2026-08-01"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("cal sync — 4 events, 2 new across primary, work");
    expect(s.calls[0]!.method).toBe("POST");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/cal/sync`);
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ since: "2026-08-01" });
  });

  test("an unknown cal sub refuses by name and does not call the API", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["cal", "frobnicate"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown cal subcommand 'frobnicate'");
    expect(s.calls).toEqual([]);
  });
});

// --- server half: a real store, reads of what was written; sync uses a fake Google client -------------

const TOKEN_S = "a-test-bearer-token-that-is-long-enough";

function url(path: string): string {
  return `http://api-host.local${OB_API_PREFIX}${path}`;
}

interface ServerCtx {
  store: Store;
  google: FakeGoogleClient;
  call: (path: string, opts?: { method?: string; body?: unknown }) => Promise<{ status: number; body: any }>;
}

async function insertEmail(
  store: Store,
  m: { id: string; subject: string; from_addr?: string; ts: string; body?: string },
): Promise<void> {
  await store.q.insert(store.t.emailMessage).values({
    id: m.id,
    from_addr: m.from_addr ?? "alice@example.com",
    subject: m.subject,
    body: m.body ?? m.subject,
    ts: m.ts,
    snippet: m.subject,
  });
}

async function insertCal(
  store: Store,
  e: { id: string; summary: string; start_ts: string; all_day?: number },
): Promise<void> {
  await store.q.insert(store.t.calendarEvent).values({
    id: e.id,
    calendar_id: "primary",
    summary: e.summary,
    start_ts: e.start_ts,
    all_day: e.all_day ?? 0,
  });
}

async function withApi(fn: (ctx: ServerCtx) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({
    kind: "postgres",
    connection: lease.options as unknown as Record<string, unknown>,
  });
  const google = new FakeGoogleClient();
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN_S, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    google,
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
    await fn({ store, google, call });
  } finally {
    await store.close();
    await lease.release();
  }
}

describe("GET /gmail/list (415)", () => {
  test("an empty store is an empty list", async () => {
    await withApi(async ({ call }) => {
      const res = await call("/gmail/list");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ hits: [] });
    });
  }, PG_BUDGET);

  test("returns the most-recent messages, newest first, honouring limit and since", async () => {
    await withApi(async ({ store, call }) => {
      await insertEmail(store, { id: "old", subject: "older", ts: "2026-08-01T10:00:00.000Z" });
      await insertEmail(store, { id: "mid", subject: "middle", ts: "2026-08-10T10:00:00.000Z" });
      await insertEmail(store, { id: "new", subject: "newest", ts: "2026-08-20T10:00:00.000Z" });
      const all = await call("/gmail/list");
      expect(all.status).toBe(200);
      expect(all.body.hits.map((h: { id: string }) => h.id)).toEqual(["new", "mid", "old"]);
      const limited = await call("/gmail/list?limit=2");
      expect(limited.body.hits.map((h: { id: string }) => h.id)).toEqual(["new", "mid"]);
      const since = await call("/gmail/list?since=2026-08-10T00:00:00.000Z");
      expect(since.body.hits.map((h: { id: string }) => h.id)).toEqual(["new", "mid"]);
    });
  }, PG_BUDGET);

  test("a non-positive limit is a named 400", async () => {
    await withApi(async ({ call }) => {
      const res = await call("/gmail/list?limit=0");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
      expect(res.body.error.message).toContain("'limit' must be a positive integer");
    });
  }, PG_BUDGET);
});

describe("GET /gmail/search (415)", () => {
  test("missing q is a named 400", async () => {
    await withApi(async ({ call }) => {
      const res = await call("/gmail/search");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
      expect(res.body.error.message).toContain("'q' is required");
    });
  }, PG_BUDGET);

  test("finds ingested content by word, and a miss is an empty list", async () => {
    await withApi(async ({ store, call }) => {
      await insertEmail(store, {
        id: "q",
        subject: "Quarterly planning",
        body: "align on the roadmap",
        ts: "2026-08-20T10:00:00.000Z",
      });
      await insertEmail(store, { id: "other", subject: "lunch plans", ts: "2026-08-20T11:00:00.000Z" });
      const found = await call("/gmail/search?q=Quarterly");
      expect(found.status).toBe(200);
      expect(found.body.hits.map((h: { id: string }) => h.id)).toEqual(["q"]);
      expect(found.body.hits[0]!.subject).toBe("Quarterly planning");
      const miss = await call("/gmail/search?q=unicorns");
      expect(miss.status).toBe(200);
      expect(miss.body.hits).toEqual([]);
    });
  }, PG_BUDGET);
});

describe("GET /cal/agenda (415)", () => {
  test("an empty store is an empty list", async () => {
    await withApi(async ({ call }) => {
      const res = await call("/cal/agenda");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ events: [] });
    });
  }, PG_BUDGET);

  test("returns today's events and skips other days", async () => {
    await withApi(async ({ store, call }) => {
      setSystemTime(new Date("2026-11-05T23:00:00.000Z"));
      try {
        const day = saDayBounds(new Date()).to.slice(0, 10);
        await insertCal(store, { id: "today", summary: "Standup", start_ts: `${day}T09:30:00.000Z` });
        await insertCal(store, { id: "old", summary: "Yesterday", start_ts: "2020-01-01T09:30:00.000Z" });
        const res = await call("/cal/agenda");
        expect(res.status).toBe(200);
        expect(res.body.events.map((e: { id: string }) => e.id)).toEqual(["today"]);
        expect(res.body.events[0]!.summary).toBe("Standup");
      } finally {
        setSystemTime();
      }
    });
  }, PG_BUDGET);
});

describe("POST /gmail/sync and /cal/sync use the injected Google client (415)", () => {
  test("gmail sync never hits Google and returns the ingest result", async () => {
    await withApi(async ({ call, google }) => {
      const res = await call("/gmail/sync", { method: "POST", body: {} });
      expect(res.status).toBe(200);
      // An empty first backfill is complete, so it stores the profile historyId (OB-1914).
      expect(res.body).toEqual({ messages: 0, skipped: 0, ingested: 0, cursor: "4242" });
      expect(google.listCalls).toBe(1);
    });
  }, PG_BUDGET);

  test("cal sync never hits Google and returns the ingest result", async () => {
    await withApi(async ({ call, google }) => {
      const res = await call("/cal/sync", { method: "POST", body: {} });
      expect(res.status).toBe(200);
      expect(res.body.events).toBe(0);
      expect(res.body.ingested).toBe(0);
      expect(res.body.calendars).toEqual(["primary"]);
      expect(google.calCalls).toBe(1);
    });
  }, PG_BUDGET);

  test("a non-positive max is a named 400 and does not call Google", async () => {
    await withApi(async ({ call, google }) => {
      const res = await call("/gmail/sync", { method: "POST", body: { max: 0 } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("invalid_request");
      expect(google.listCalls).toBe(0);
    });
  }, PG_BUDGET);
});

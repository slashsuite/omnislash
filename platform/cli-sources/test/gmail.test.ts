import { describe, expect, spyOn, test } from "bun:test";
import { freshPgStore, type PgStoreLease } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { addPersonFor } from "../../../apps/cli/src/commands/person.ts";
import { eventsBetweenFor } from "../../../apps/cli/src/events.ts";
import { GmailProfileHistoryError, searchEmail, syncGmail } from "../src/ingest/gmail.ts";
import { getCursorFor } from "../../../apps/cli/src/settings.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";
import {
  GoogleHttpError,
  type CalendarListResponse,
  type GmailHistoryResponse,
  type GmailListResponse,
  type GmailMessage,
  type GoogleClient,
} from "../src/google.ts";

/** The profile historyId every fake reports: a backfill that completes stores it as the cursor (OB-1914). */
const PROFILE_H = "5000";
const profile = (): Promise<{ historyId?: string }> => Promise.resolve({ historyId: PROFILE_H });
/** A pinned clock, so the absolute backfill window is exact. */
const NOW_MS = Date.UTC(2026, 10, 11, 12, 0, 0);
const NOW_S = Math.floor(NOW_MS / 1000);
const now = (): number => NOW_MS;
const afterDays = (days: number, at = NOW_S): string => `after:${at - days * 86_400}`;

// FIXTURE-only Google client. Never touches the network — this is the injection seam the connectors
// expose so tests run entirely against canned Gmail API JSON.
class FakeGmailClient implements GoogleClient {
  listCall = 0;
  historyCall = 0;
  getCalls: string[] = [];
  listOpts: Array<{ q?: string; pageToken?: string; maxResults?: number }> = [];
  profileCalls = 0;
  profileHistoryId = PROFILE_H;
  constructor(
    private listPages: GmailListResponse[],
    private historyPages: GmailHistoryResponse[],
    private messages: Record<string, GmailMessage>,
  ) {}
  gmailListMessages(opts: { q?: string; pageToken?: string; maxResults?: number }): Promise<GmailListResponse> {
    this.listOpts.push(opts);
    return Promise.resolve(this.listPages[this.listCall++] ?? {});
  }
  gmailGetMessage(id: string): Promise<GmailMessage> {
    this.getCalls.push(id);
    const m = this.messages[id];
    if (!m) throw new Error(`fixture missing message ${id}`);
    return Promise.resolve(m);
  }
  gmailHistoryList(): Promise<GmailHistoryResponse> {
    return Promise.resolve(this.historyPages[this.historyCall++] ?? { historyId: "0" });
  }
  gmailGetProfile(): Promise<{ historyId?: string }> {
    this.profileCalls++;
    return Promise.resolve({ historyId: this.profileHistoryId });
  }
  calendarListEvents(): Promise<CalendarListResponse> {
    throw new Error("not used in gmail tests");
  }
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");

function msg(over: Partial<GmailMessage> & { id: string }): GmailMessage {
  return {
    threadId: `thread-${over.id}`,
    labelIds: ["INBOX"],
    snippet: "snippet…",
    internalDate: "1752796800000", // 2025-07-18 (fixed)
    historyId: "1000",
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "From", value: "Someone <someone@example.com>" },
        { name: "To", value: "me@myself.com" },
        { name: "Subject", value: "Subject" },
      ],
      parts: [{ mimeType: "text/plain", body: { data: b64("body") } }],
    },
    ...over,
  };
}

const M1 = msg({
  id: "m1",
  historyId: "1000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Alice Example <alice@example.com>" },
      { name: "To", value: "me@myself.com, team@example.com" },
      { name: "Subject", value: "Quarterly planning sync" },
    ],
    parts: [{ mimeType: "text/plain", body: { data: b64("Let's align on the Q3 roadmap next week.") } }],
  },
});
const M2 = msg({
  id: "m2",
  historyId: "1001",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "bob@nowhere.com" },
      { name: "To", value: "me@myself.com" },
      { name: "Subject", value: "Lunch tomorrow?" },
    ],
    body: { data: b64("Want to grab lunch?") },
  },
});

const M3 = msg({
  id: "m3",
  historyId: "1002",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "carol@nowhere.com" },
      { name: "To", value: "me@myself.com" },
      { name: "Subject", value: "Third message" },
    ],
    body: { data: b64("hello three") },
  },
});

const PG_BUDGET = spawnBudget(2);

async function seedAlice(lease: PgStoreLease): Promise<number> {
  return (await addPersonFor(lease.store, "Alice Example", { email: "alice@example.com" })).id;
}

async function count(lease: PgStoreLease, table: string): Promise<number> {
  const rows = (await lease.sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`)) as Array<{
    n: number;
  }>;
  return rows[0]!.n;
}

describe("gmail connector (126)", () => {
  test("first sync ingests via messages.list, maps sender→person, mirrors events, FTS finds it", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const aliceId = await seedAlice(lease);
    const client = new FakeGmailClient(
      [{ messages: [{ id: "m1" }, { id: "m2" }] }],
      [],
      { m1: M1, m2: M2 },
    );

    const res = await syncGmail(db, {}, client);
    expect(res.messages).toBe(2);
    expect(res.ingested).toBe(2);
    expect(res.cursor).toBe(PROFILE_H); // the profile historyId read at backfill start (OB-1914)
    expect(client.profileCalls).toBe(1);

    // rows landed
    const rows = (await lease.sql.unsafe(
      "SELECT id, from_addr, subject, person_id FROM email_message ORDER BY id",
    )) as {
      id: string;
      from_addr: string;
      subject: string;
      person_id: number | null;
    }[];
    expect(rows).toHaveLength(2);
    // sender→person mapping (only alice is registered)
    expect(rows.find((r) => r.id === "m1")!.person_id).toBe(aliceId);
    expect(rows.find((r) => r.id === "m1")!.from_addr).toBe("alice@example.com");
    expect(rows.find((r) => r.id === "m2")!.person_id).toBeNull();

    // event mirror
    const events = await eventsBetweenFor(db, { source: "gmail" });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "email")).toBe(true);

    // ob 322's tsvector search over subject + body (search_vec is GENERATED, so nothing maintains it)
    expect((await searchEmail(db, "roadmap")).map((h) => h.id)).toEqual(["m1"]); // body match
    expect((await searchEmail(db, "Quarterly")).map((h) => h.id)).toEqual(["m1"]); // subject match
    expect((await searchEmail(db, "lunch")).map((h) => h.id)).toEqual(["m2"]);
    await lease.release();
  }, PG_BUDGET);

  test("re-sync polls history.list from the cursor, dedups (no dupes) and advances the cursor", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await seedAlice(lease);
    const client = new FakeGmailClient(
      [{ messages: [{ id: "m1" }, { id: "m2" }] }],
      // history reports m1 again (already ingested) + a newer historyId
      [{ history: [{ messagesAdded: [{ message: { id: "m1" } }] }], historyId: "5050" }],
      { m1: M1, m2: M2 },
    );

    await syncGmail(db, {}, client); // first run — list path
    const res2 = await syncGmail(db, {}, client); // second run — history path

    expect(res2.ingested).toBe(0); // dedup: m1 already present
    expect(res2.cursor).toBe("5050"); // cursor advanced
    expect(await count(lease, "email_message")).toBe(2);
    // The search index is a GENERATED column on the row itself now, so "is it indexed" is asked of the
    // search rather than of a shadow table's row count -- there is no shadow table left to fall behind.
    expect((await searchEmail(db, "roadmap")).map((h) => h.id)).toEqual(["m1"]);
    expect(await eventsBetweenFor(db, { source: "gmail" })).toHaveLength(2); // no duplicate events
    await lease.release();
  });
});

describe("gmail backfill bounding (140)", () => {
  test("first backfill defaults to a recent window (30 days, as an absolute after:)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new FakeGmailClient([{ messages: [{ id: "m1" }] }], [], { m1: M1 });
    await syncGmail(db, { now }, client);
    expect(client.listOpts[0]?.q).toBe(afterDays(30));
    await lease.release();
  }, PG_BUDGET);

  test("--days sets after:<now - n days>", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new FakeGmailClient([{ messages: [{ id: "m1" }] }], [], { m1: M1 });
    await syncGmail(db, { days: 7, now }, client);
    expect(client.listOpts[0]?.q).toBe(afterDays(7));
    await lease.release();
  }, PG_BUDGET);

  test("--query is a raw Gmail query that overrides the window", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new FakeGmailClient([{ messages: [{ id: "m1" }] }], [], { m1: M1 });
    await syncGmail(db, { query: "from:alice@example.com", days: 7, now }, client);
    expect(client.listOpts[0]?.q).toBe("from:alice@example.com");
    await lease.release();
  }, PG_BUDGET);

  test("--since (-Nd) maps to an absolute after:<seconds>, a date maps to after:<date>", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const c1 = new FakeGmailClient([{ messages: [] }], [], {});
    await syncGmail(db, { since: "-14d", now }, c1);
    expect(c1.listOpts[0]?.q).toBe(afterDays(14));

    const c2 = new FakeGmailClient([{ messages: [] }], [], {});
    await syncGmail(db, { since: "2026-01-15", backfill: true, now }, c2);
    expect(c2.listOpts[0]?.q).toBe("after:2026/01/15");
    await lease.release();
  }, PG_BUDGET);

  test("--max caps messages fetched, stops paging early, and a re-run resumes the BACKFILL with before:", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new FakeGmailClient(
      // one page of three ids (the fake would serve a 2nd page if asked); cap should stop before that.
      // The resume run lists the same-second neighbours again (before: is the oldest second + 1).
      [
        { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }], nextPageToken: "P2" },
        { messages: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] },
      ],
      [],
      { m1: M1, m2: M2, m3: M3 },
    );

    const res = await syncGmail(db, { max: 2, now }, client);
    expect(res.messages).toBe(2); // fetched exactly 2
    expect(res.ingested).toBe(2);
    expect(client.getCalls).toEqual(["m1", "m2"]); // m3 never fetched
    expect(client.listCall).toBe(1); // did NOT page the whole mailbox before stopping
    expect(res.cursor).toBeNull(); // a capped backfill does NOT write the history cursor
    const before = Math.floor(Number(M2.internalDate) / 1000) + 1;
    expect(JSON.parse((await getCursorFor(db, "gmail_backfill"))!)).toEqual({ h: PROFILE_H, q: afterDays(30), before });
    expect(await count(lease, "email_message")).toBe(2);

    // re-run (plain): the backfill resumes below the oldest fetched second and finishes the window
    const res2 = await syncGmail(db, { now }, client);
    expect(client.listOpts[1]?.q).toBe(`(${afterDays(30)}) before:${before}`);
    expect(client.historyCall).toBe(0);
    expect(client.getCalls).toEqual(["m1", "m2", "m3"]); // m1/m2 are stored, so not fetched again
    expect(res2.ingested).toBe(1);
    expect(res2.cursor).toBe(PROFILE_H);
    expect(await getCursorFor(db, "gmail_backfill")).toBe("");
    expect(client.profileCalls).toBe(1); // never re-read at completion
    expect(await count(lease, "email_message")).toBe(3);
    await lease.release();
  }, PG_BUDGET);

  test("messages ingest incrementally as pages are fetched (not all ids collected first)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const order: string[] = [];
    const rowCount = (): Promise<number> => count(lease, "email_message");
    const client: GoogleClient = {
      gmailListMessages: (opts) => {
        order.push(`list:${opts.pageToken ?? "p1"}`);
        return Promise.resolve(
          opts.pageToken ? { messages: [{ id: "m2" }] } : { messages: [{ id: "m1" }], nextPageToken: "P2" },
        );
      },
      gmailGetMessage: async (id) => {
        order.push(`get:${id}@rows=${await rowCount()}`);
        return id === "m1" ? M1 : M2;
      },
      gmailHistoryList: () => Promise.reject(new Error("n/a")),
      gmailGetProfile: profile,
      calendarListEvents: () => Promise.reject(new Error("n/a")),
    };

    await syncGmail(db, {}, client);
    // page 1 → fetch+ingest m1 (0 rows before) → page 2 → fetch m2 (m1 already landed) → ingest
    expect(order).toEqual(["list:p1", "get:m1@rows=0", "list:P2", "get:m2@rows=1"]);
    await lease.release();
  });
});

describe("gmail gone-message skip (177)", () => {
  test("404 on one message is skipped, later messages ingest, cursor advances", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client: GoogleClient = {
      gmailListMessages: () => Promise.resolve({ messages: [{ id: "gone" }, { id: "m1" }] }),
      gmailGetMessage: (id) => {
        if (id === "gone") {
          return Promise.reject(
            new GoogleHttpError(404, "https://gmail.googleapis.com/gmail/v1/users/me/messages/gone?format=full"),
          );
        }
        return Promise.resolve(M1);
      },
      gmailHistoryList: () => Promise.reject(new Error("n/a")),
      gmailGetProfile: profile,
      calendarListEvents: () => Promise.reject(new Error("n/a")),
    };

    const res = await syncGmail(db, {}, client);
    expect(res.messages).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.ingested).toBe(1);
    expect(res.cursor).toBe(PROFILE_H);
    expect(await count(lease, "email_message")).toBe(1);
    await lease.release();
  }, PG_BUDGET);

  test("403 on one message is skipped the same way", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client: GoogleClient = {
      gmailListMessages: () => Promise.resolve({ messages: [{ id: "denied" }, { id: "m1" }] }),
      gmailGetMessage: (id) => {
        if (id === "denied") {
          return Promise.reject(new GoogleHttpError(403, "https://example/messages/denied"));
        }
        return Promise.resolve(M1);
      },
      gmailHistoryList: () => Promise.reject(new Error("n/a")),
      gmailGetProfile: profile,
      calendarListEvents: () => Promise.reject(new Error("n/a")),
    };

    const res = await syncGmail(db, {}, client);
    expect(res.skipped).toBe(1);
    expect(res.ingested).toBe(1);
    expect(res.cursor).toBe(PROFILE_H);
    await lease.release();
  }, PG_BUDGET);

  test("history path: skip a gone id, ingest the next, advance to the page historyId", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new FakeGmailClient(
      [{ messages: [{ id: "m1" }] }],
      [
        {
          history: [{ messagesAdded: [{ message: { id: "gone" } }, { message: { id: "m2" } }] }],
          historyId: "5200",
        },
      ],
      { m1: M1, m2: M2 },
    );
    const origGet = client.gmailGetMessage.bind(client);
    client.gmailGetMessage = (id) => {
      if (id === "gone") return Promise.reject(new GoogleHttpError(404, `https://example/messages/${id}`));
      return origGet(id);
    };

    await syncGmail(db, {}, client);
    const res2 = await syncGmail(db, {}, client);
    expect(res2.skipped).toBe(1);
    expect(res2.ingested).toBe(1);
    expect(res2.cursor).toBe("5200");
    expect(await count(lease, "email_message")).toBe(2);
    await lease.release();
  }, PG_BUDGET);

  test("401 aborts the run and does not advance the cursor", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client: GoogleClient = {
      gmailListMessages: () => Promise.resolve({ messages: [{ id: "m1" }, { id: "m2" }] }),
      gmailGetMessage: (id) => {
        if (id === "m2") return Promise.reject(new GoogleHttpError(401, "https://example/messages/m2"));
        return Promise.resolve(M1);
      },
      gmailHistoryList: () => Promise.reject(new Error("n/a")),
      gmailGetProfile: profile,
      calendarListEvents: () => Promise.reject(new Error("n/a")),
    };

    await expect(syncGmail(db, {}, client)).rejects.toBeInstanceOf(GoogleHttpError);
    expect(await count(lease, "email_message")).toBe(1); // m1 landed before the abort
    expect(await getCursorFor(db, "gmail_history")).toBeNull();
    expect(await getCursorFor(db, "gmail_backfill")).toBeNull(); // an aborted backfill writes nothing
    await lease.release();
  }, PG_BUDGET);

  test("429 quota aborts; a network error aborts", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const quota: GoogleClient = {
      gmailListMessages: () => Promise.resolve({ messages: [{ id: "m1" }] }),
      gmailGetMessage: () => Promise.reject(new GoogleHttpError(429, "https://example/messages/m1")),
      gmailHistoryList: () => Promise.reject(new Error("n/a")),
      gmailGetProfile: profile,
      calendarListEvents: () => Promise.reject(new Error("n/a")),
    };
    await expect(syncGmail(db, {}, quota)).rejects.toMatchObject({ status: 429 });
    expect(await getCursorFor(db, "gmail_history")).toBeNull();

    const net: GoogleClient = {
      gmailListMessages: () => Promise.resolve({ messages: [{ id: "m1" }] }),
      gmailGetMessage: () => Promise.reject(new TypeError("Unable to connect")),
      gmailHistoryList: () => Promise.reject(new Error("n/a")),
      gmailGetProfile: profile,
      calendarListEvents: () => Promise.reject(new Error("n/a")),
    };
    await expect(syncGmail(db, {}, net)).rejects.toThrow(/Unable to connect/);
    expect(await getCursorFor(db, "gmail_history")).toBeNull();
    await lease.release();
  }, PG_BUDGET);

  test("a timeout AppError aborts (session-bad, not a skip)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client: GoogleClient = {
      gmailListMessages: () => Promise.resolve({ messages: [{ id: "m1" }] }),
      gmailGetMessage: () =>
        Promise.reject(new AppError("Google API request timed out after 30000ms for https://example/messages/m1")),
      gmailHistoryList: () => Promise.reject(new Error("n/a")),
      gmailGetProfile: profile,
      calendarListEvents: () => Promise.reject(new Error("n/a")),
    };
    await expect(syncGmail(db, {}, client)).rejects.toThrow(/timed out/);
    expect(await getCursorFor(db, "gmail_history")).toBeNull();
    await lease.release();
  }, PG_BUDGET);

  test("history.list 404 (expired historyId) falls back to bounded backfill", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const primed = new FakeGmailClient([{ messages: [{ id: "m1" }] }], [], { m1: M1 });
    await syncGmail(db, {}, primed);
    expect(await getCursorFor(db, "gmail_history")).toBe(PROFILE_H);

    let historyCalls = 0;
    let listCalls = 0;
    const client: GoogleClient = {
      gmailHistoryList: () => {
        historyCalls++;
        return Promise.reject(
          new GoogleHttpError(404, "https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=1000"),
        );
      },
      gmailListMessages: () => {
        listCalls++;
        return Promise.resolve({ messages: [{ id: "m2" }] });
      },
      gmailGetMessage: (id) => Promise.resolve(id === "m2" ? M2 : M1),
      gmailGetProfile: () => Promise.resolve({ historyId: "6000" }),
      calendarListEvents: () => Promise.reject(new Error("n/a")),
    };

    const res = await syncGmail(db, {}, client);
    expect(historyCalls).toBe(1);
    expect(listCalls).toBe(1);
    expect(res.ingested).toBe(1);
    expect(res.cursor).toBe("6000"); // the fallback backfill's own profile historyId
    expect(await count(lease, "email_message")).toBe(2);
    await lease.release();
  }, PG_BUDGET);

  test("401 on history.list still aborts and does not fall back", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const primed = new FakeGmailClient([{ messages: [{ id: "m1" }] }], [], { m1: M1 });
    await syncGmail(db, {}, primed);

    let listed = false;
    const client: GoogleClient = {
      gmailHistoryList: () =>
        Promise.reject(new GoogleHttpError(401, "https://gmail.googleapis.com/gmail/v1/users/me/history")),
      gmailListMessages: () => {
        listed = true;
        return Promise.resolve({ messages: [{ id: "m2" }] });
      },
      gmailGetMessage: () => Promise.reject(new Error("n/a")),
      gmailGetProfile: profile,
      calendarListEvents: () => Promise.reject(new Error("n/a")),
    };

    await expect(syncGmail(db, {}, client)).rejects.toMatchObject({ status: 401 });
    expect(listed).toBe(false);
    expect(await getCursorFor(db, "gmail_history")).toBe(PROFILE_H);
    await lease.release();
  }, PG_BUDGET);
});

// A window of mail served the way Gmail does: newest first, and honouring `before:<seconds>` so a resumed
// backfill only sees what is older than its bound. Records every list `q` and every profile read.
class WindowGmailClient implements GoogleClient {
  qs: string[] = [];
  getCalls: string[] = [];
  historyCalls = 0;
  profileCalls = 0;
  profileHistoryId = PROFILE_H;
  constructor(
    private mail: GmailMessage[],
    private gone: Set<string> = new Set(),
  ) {}
  gmailListMessages(opts: { q?: string }): Promise<GmailListResponse> {
    this.qs.push(opts.q ?? "");
    const bound = opts.q?.match(/before:(\d+)/);
    const ids = [...this.mail]
      .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
      .filter((m) => !bound || Number(m.internalDate) / 1000 < Number(bound[1]))
      .map((m) => ({ id: m.id }));
    return Promise.resolve({ messages: ids });
  }
  gmailGetMessage(id: string): Promise<GmailMessage> {
    this.getCalls.push(id);
    if (this.gone.has(id)) return Promise.reject(new GoogleHttpError(404, `https://example/messages/${id}`));
    const m = this.mail.find((x) => x.id === id);
    return m ? Promise.resolve(m) : Promise.reject(new Error(`fixture missing message ${id}`));
  }
  gmailHistoryList(): Promise<GmailHistoryResponse> {
    this.historyCalls++;
    return Promise.resolve({ historyId: this.profileHistoryId });
  }
  gmailGetProfile(): Promise<{ historyId?: string }> {
    this.profileCalls++;
    return Promise.resolve({ historyId: this.profileHistoryId });
  }
  calendarListEvents(): Promise<CalendarListResponse> {
    throw new Error("not used in gmail tests");
  }
}

/** n messages one hour apart, w1 the newest; each one's whole second, for the `before:` bounds. */
function windowMail(n: number): { mail: GmailMessage[]; sec: (i: number) => number } {
  const ms = (i: number): number => NOW_MS - i * 3_600_000;
  const mail = Array.from({ length: n }, (_, k) => msg({ id: `w${k + 1}`, internalDate: String(ms(k + 1)) }));
  return { mail, sec: (i) => Math.floor(ms(i) / 1000) };
}

describe("gmail capped backfill resumes the same window (OB-1914)", () => {
  test("a 5-message window with max 2 is fully ingested over three plain runs", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const { mail, sec } = windowMail(5);
    const client = new WindowGmailClient(mail);
    const q = afterDays(30);

    const r1 = await syncGmail(db, { max: 2, now }, client);
    expect(r1.cursor).toBeNull();
    const r2 = await syncGmail(db, { max: 2, now }, client);
    expect(r2.cursor).toBeNull();
    const r3 = await syncGmail(db, { max: 2, now }, client);

    expect(client.qs).toEqual([q, `(${q}) before:${sec(2) + 1}`, `(${q}) before:${sec(4) + 1}`]);
    expect([r1.messages, r2.messages, r3.messages]).toEqual([2, 2, 1]);
    expect(await count(lease, "email_message")).toBe(5);
    expect(await getCursorFor(db, "gmail_backfill")).toBe("");
    expect(await getCursorFor(db, "gmail_history")).toBe(PROFILE_H);
    expect(r3.cursor).toBe(PROFILE_H);
    expect(client.profileCalls).toBe(1);
    expect(client.historyCalls).toBe(0);
    await lease.release();
  }, PG_BUDGET);

  test("a 4-message window with max 2 completes on run 2 because the list ran out", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const { mail } = windowMail(4);
    const client = new WindowGmailClient(mail);

    await syncGmail(db, { max: 2, now }, client);
    const r2 = await syncGmail(db, { max: 2, now }, client);
    expect(r2.messages).toBe(2);
    expect(r2.cursor).toBe(PROFILE_H);
    expect(await getCursorFor(db, "gmail_backfill")).toBe("");
    expect(await count(lease, "email_message")).toBe(4);

    // the next plain run polls history, not a third backfill
    await syncGmail(db, { max: 2, now }, client);
    expect(client.qs).toHaveLength(2);
    expect(client.historyCalls).toBe(1);
    await lease.release();
  }, PG_BUDGET);

  test("a --days 90 backfill resumed by plain runs keeps the same after: bound while the clock moves", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const { mail } = windowMail(5);
    const client = new WindowGmailClient(mail);
    let t = NOW_MS;
    const clock = (): number => t;

    await syncGmail(db, { days: 90, max: 2, now: clock }, client);
    t += 3 * 86_400_000; // days later, the scheduled plain run (no --days) resumes
    await syncGmail(db, { max: 2, now: clock }, client);
    t += 86_400_000;
    await syncGmail(db, { days: 7, max: 2, now: clock }, client); // a stray window does not reset it

    const bound = afterDays(90);
    expect(client.qs).toHaveLength(3);
    expect(client.qs[0]).toBe(bound);
    for (const q of client.qs.slice(1)) expect(q.startsWith(`(${bound}) before:`)).toBe(true);
    expect(await count(lease, "email_message")).toBe(5);
    await lease.release();
  }, PG_BUDGET);

  test("an empty window stores the profile historyId, and the next run polls history", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new WindowGmailClient([]);

    const r1 = await syncGmail(db, { now }, client);
    expect(r1.cursor).toBe(PROFILE_H);
    expect(await getCursorFor(db, "gmail_history")).toBe(PROFILE_H);

    await syncGmail(db, { now }, client);
    expect(client.qs).toHaveLength(1);
    expect(client.historyCalls).toBe(1);
    await lease.release();
  }, PG_BUDGET);

  test("--backfill over a stored resume point reads the profile again and starts a new window", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const { mail, sec } = windowMail(5);
    const client = new WindowGmailClient(mail);

    await syncGmail(db, { max: 2, now }, client);
    expect(JSON.parse((await getCursorFor(db, "gmail_backfill"))!).before).toBe(sec(2) + 1);

    client.profileHistoryId = "7000";
    const later = NOW_MS + 86_400_000;
    await syncGmail(db, { backfill: true, days: 7, max: 2, now: () => later }, client);
    const newQ = afterDays(7, Math.floor(later / 1000));
    expect(client.profileCalls).toBe(2);
    expect(client.qs[1]).toBe(newQ); // fresh: no before:, the new window
    // w1/w2 are stored, so the new run fetches w3/w4 and caps with the NEW h and q
    expect(JSON.parse((await getCursorFor(db, "gmail_backfill"))!)).toEqual({ h: "7000", q: newQ, before: sec(4) + 1 });
    await lease.release();
  }, PG_BUDGET);

  test("a profile with no historyId aborts before listing and writes no cursor", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new WindowGmailClient(windowMail(2).mail);
    client.profileHistoryId = undefined as unknown as string;

    await expect(syncGmail(db, { now }, client)).rejects.toBeInstanceOf(GmailProfileHistoryError);
    expect(client.qs).toHaveLength(0);
    expect(await getCursorFor(db, "gmail_history")).toBeNull();
    expect(await getCursorFor(db, "gmail_backfill")).toBeNull();
    await lease.release();
  }, PG_BUDGET);

  test("a resumed range whose ids are all 404 completes instead of re-listing them", async () => {
    // Under the fetch-count cap a run whose ids are all 404 lists out, so it cannot itself be capped:
    // the remaining range completes and stores H rather than re-listing the same gone ids forever.
    const lease = await freshPgStore();
    const db = lease.store;
    const { mail, sec } = windowMail(4);
    const client = new WindowGmailClient(mail, new Set(["w3", "w4"]));

    const r1 = await syncGmail(db, { max: 2, now }, client);
    expect(r1.cursor).toBeNull();
    const point = await getCursorFor(db, "gmail_backfill");
    expect(JSON.parse(point!).before).toBe(sec(2) + 1);

    const r2 = await syncGmail(db, { max: 2, now }, client);
    expect(r2.messages).toBe(0);
    expect(r2.skipped).toBe(2);
    expect(r2.cursor).toBe(PROFILE_H);
    expect(await getCursorFor(db, "gmail_backfill")).toBe("");
    await lease.release();
  }, PG_BUDGET);
});

// OB-1949: a history mailbox served the way Gmail does. `history.list` returns only the records whose `id`
// is past `startHistoryId` (a record with no id cannot be filtered, so it is served on every call), split
// into the fixed pages given, each page reporting the mailbox head as its `historyId`. `pageToken` is the
// index of the next served page. Records every `startHistoryId` a run started from and every GET.
interface Rec {
  id?: string;
  adds: string[];
}
class HistoryGmailClient implements GoogleClient {
  starts: string[] = [];
  getCalls: string[] = [];
  constructor(
    private pages: Rec[][],
    private head: string,
    private mail: Record<string, GmailMessage>,
    private backfillIds: string[] = [],
  ) {}
  gmailListMessages(): Promise<GmailListResponse> {
    return Promise.resolve({ messages: this.backfillIds.map((id) => ({ id })) });
  }
  gmailGetMessage(id: string): Promise<GmailMessage> {
    this.getCalls.push(id);
    const m = this.mail[id];
    return m ? Promise.resolve(m) : Promise.reject(new Error(`fixture missing message ${id}`));
  }
  gmailHistoryList(opts: { startHistoryId: string; pageToken?: string }): Promise<GmailHistoryResponse> {
    if (!opts.pageToken) this.starts.push(opts.startHistoryId);
    const keep = (r: Rec): boolean => r.id === undefined || Number(r.id) > Number(opts.startHistoryId);
    const served = this.pages.map((p) => p.filter(keep)).filter((p) => p.length > 0);
    const i = opts.pageToken ? Number(opts.pageToken) : 0;
    return Promise.resolve({
      history: (served[i] ?? []).map((r) => ({
        ...(r.id !== undefined ? { id: r.id } : {}),
        messagesAdded: r.adds.map((id) => ({ message: { id } })),
      })),
      historyId: this.head,
      ...(i + 1 < served.length ? { nextPageToken: String(i + 1) } : {}),
    });
  }
  gmailGetProfile(): Promise<{ historyId?: string }> {
    return Promise.resolve({ historyId: PROFILE_H });
  }
  calendarListEvents(): Promise<CalendarListResponse> {
    throw new Error("not used in gmail tests");
  }
}

/** Mail keyed by id; `historyId` defaults low so it never decides anything unless a test sets it. */
const mailOf = (...ids: Array<string | [string, string]>): Record<string, GmailMessage> =>
  Object.fromEntries(
    ids.map((x) => {
      const [id, historyId] = typeof x === "string" ? [x, "1000"] : x;
      return [id, msg({ id, historyId })];
    }),
  );

/** Prime the history cursor at PROFILE_H with a backfill of `client.backfillIds`, then forget its GETs. */
async function primeHistory(db: PgStoreLease["store"], client: HistoryGmailClient): Promise<void> {
  await syncGmail(db, { now }, client);
  expect(await getCursorFor(db, "gmail_history")).toBe(PROFILE_H);
  client.getCalls = [];
}

/** Capture stderr lines written by `warn` while `fn` runs. */
async function captureWarn<T>(fn: () => Promise<T>): Promise<{ out: T; lines: string[] }> {
  const lines: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  });
  try {
    return { out: await fn(), lines };
  } finally {
    spy.mockRestore();
  }
}

describe("gmail capped history run resumes from the last finished record (OB-1949)", () => {
  test("a pulled message's later historyId does not move the cursor past an unprocessed record", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    // a's own historyId (5300) is a later label change, past R2 (5200) which this run never reaches
    const client = new HistoryGmailClient(
      [[{ id: "5100", adds: ["a"] }, { id: "5200", adds: ["b"] }]],
      "5400",
      mailOf(["a", "5300"], "b"),
    );
    await primeHistory(db, client);

    const r1 = await syncGmail(db, { max: 1 }, client);
    expect(r1.cursor).toBe("5100");
    const r2 = await syncGmail(db, { max: 1 }, client);
    expect(client.starts).toEqual([PROFILE_H, "5100"]);
    expect(client.getCalls).toEqual(["a", "b"]);
    expect(r2.ingested).toBe(1);
    expect(r2.cursor).toBe("5400");
    expect(await count(lease, "email_message")).toBe(2);
    await lease.release();
  }, PG_BUDGET);

  test("a record bigger than --max is re-listed and finished by the next run", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new HistoryGmailClient(
      [[{ id: "5100", adds: [] }, { id: "5200", adds: ["b", "c", "d"] }]],
      "5300",
      mailOf("b", "c", "d"),
    );
    await primeHistory(db, client);

    const r1 = await syncGmail(db, { max: 2 }, client);
    expect(client.getCalls).toEqual(["b", "c"]);
    expect(r1.cursor).toBe("5100");
    const r2 = await syncGmail(db, { max: 2 }, client);
    expect(client.starts).toEqual([PROFILE_H, "5100"]);
    expect(client.getCalls).toEqual(["b", "c", "d"]); // run 2 GETs only the third
    expect(r2.cursor).toBe("5300");
    expect(await count(lease, "email_message")).toBe(3);
    await lease.release();
  }, PG_BUDGET);

  test("part way through the first record keeps the cursor and does not warn", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new HistoryGmailClient([[{ id: "5100", adds: ["a", "b"] }]], "5200", mailOf("a", "b"));
    await primeHistory(db, client);

    const { out, lines } = await captureWarn(() => syncGmail(db, { max: 1 }, client));
    expect(out.cursor).toBe(PROFILE_H);
    expect(lines).toEqual([]);
    await lease.release();
  }, PG_BUDGET);

  test("the cap landing exactly on the last record of the last page is complete", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new HistoryGmailClient(
      [[{ id: "5100", adds: ["a"] }], [{ id: "5200", adds: ["b"] }]],
      "5300",
      mailOf("a", "b"),
    );
    await primeHistory(db, client);

    const r1 = await syncGmail(db, { max: 2 }, client);
    expect(client.getCalls).toEqual(["a", "b"]);
    expect(r1.cursor).toBe("5300");
    await lease.release();
  }, PG_BUDGET);

  test("a finished record with no id after an id-bearing one keeps the id-bearing cursor", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new HistoryGmailClient(
      [[{ id: "5100", adds: ["a"] }, { adds: ["b"] }, { id: "5300", adds: ["c"] }]],
      "5400",
      mailOf("a", "b", "c"),
    );
    await primeHistory(db, client);

    const { out, lines } = await captureWarn(() => syncGmail(db, { max: 2 }, client));
    expect(client.getCalls).toEqual(["a", "b"]);
    expect(out.cursor).toBe("5100");
    expect(lines).toEqual([]);
    await lease.release();
  }, PG_BUDGET);

  test("the walk stops at the first refused GET and never visits the records after it", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new HistoryGmailClient(
      [[{ id: "5100", adds: ["a"] }, { id: "5200", adds: ["b"] }, { id: "5300", adds: ["s1"] }]],
      "5400",
      mailOf("a", "b", "s1"),
      ["s1"], // stored by the priming backfill
    );
    await primeHistory(db, client);

    const r1 = await syncGmail(db, { max: 1 }, client);
    expect(client.getCalls).toEqual(["a"]);
    expect(r1.cursor).toBe("5100");
    const r2 = await syncGmail(db, { max: 1 }, client);
    expect(client.starts).toEqual([PROFILE_H, "5100"]);
    expect(client.getCalls).toEqual(["a", "b"]); // s1 is stored: no GET in either run
    expect(r2.cursor).toBe("5400");
    expect(await count(lease, "email_message")).toBe(3);
    await lease.release();
  }, PG_BUDGET);

  test("records without ids keep the cursor, warn once, and the next run still progresses", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new HistoryGmailClient([[{ adds: ["a"] }, { adds: ["b"] }]], "5300", mailOf("a", "b"));
    await primeHistory(db, client);

    const { out, lines } = await captureWarn(() => syncGmail(db, { max: 1 }, client));
    expect(out.cursor).toBe(PROFILE_H);
    expect(await getCursorFor(db, "gmail_history")).toBe(PROFILE_H);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(PROFILE_H);

    const r2 = await syncGmail(db, { max: 1 }, client);
    expect(client.starts).toEqual([PROFILE_H, PROFILE_H]);
    expect(client.getCalls).toEqual(["a", "b"]); // a is stored, so run 2 spends its one GET on b
    expect(r2.cursor).toBe("5300");
    await lease.release();
  }, PG_BUDGET);

  test("a two-page capped run stores the last finished record id, never a page historyId", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new HistoryGmailClient(
      [[{ id: "5100", adds: ["a"] }], [{ id: "5200", adds: ["b"] }, { id: "5300", adds: ["c"] }]],
      "5400",
      mailOf("a", "b", "c"),
    );
    await primeHistory(db, client);

    const r1 = await syncGmail(db, { max: 2 }, client);
    expect(client.getCalls).toEqual(["a", "b"]);
    expect(r1.cursor).toBe("5200");
    const r2 = await syncGmail(db, { max: 2 }, client);
    expect(client.starts).toEqual([PROFILE_H, "5200"]);
    expect(client.getCalls).toEqual(["a", "b", "c"]);
    expect(r2.cursor).toBe("5400");
    await lease.release();
  }, PG_BUDGET);

  test("a stored id met in history mode costs no GET", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new HistoryGmailClient(
      [[{ id: "5100", adds: ["s1", "a"] }]],
      "5200",
      mailOf("s1", "a"),
      ["s1"],
    );
    await primeHistory(db, client);

    const r = await syncGmail(db, {}, client);
    expect(client.getCalls).toEqual(["a"]);
    expect(r.messages).toBe(1);
    expect(r.cursor).toBe("5200");
    await lease.release();
  }, PG_BUDGET);
});

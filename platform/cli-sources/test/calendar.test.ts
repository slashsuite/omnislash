import { describe, expect, test } from "bun:test";
import { freshPgStore, type PgStoreLease } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { addPersonFor } from "../../../apps/cli/src/commands/person.ts";
import { eventsBetweenFor } from "../../../apps/cli/src/events.ts";
import { agendaToday, syncCalendar } from "../src/ingest/calendar.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import {
  type CalendarEventResource,
  type CalendarListResponse,
  type GmailHistoryResponse,
  type GmailListResponse,
  type GmailMessage,
  type GoogleClient,
  SyncTokenExpiredError,
} from "../src/google.ts";

// FIXTURE-only client. Returns one canned events.list page (with a nextSyncToken) regardless of args,
// so it is reusable across sync calls. Never hits the network.
class FakeCalendarClient implements GoogleClient {
  calls = 0;
  opts: Array<{ calendarId: string; syncToken?: string; pageToken?: string; timeMin?: string }> = [];
  constructor(private resp: CalendarListResponse) {}
  calendarListEvents(o: {
    calendarId: string;
    syncToken?: string;
    pageToken?: string;
    timeMin?: string;
  }): Promise<CalendarListResponse> {
    this.calls++;
    this.opts.push(o);
    return Promise.resolve(this.resp);
  }
  gmailListMessages(): Promise<GmailListResponse> {
    throw new Error("not used in calendar tests");
  }
  gmailGetMessage(): Promise<GmailMessage> {
    throw new Error("not used in calendar tests");
  }
  gmailHistoryList(): Promise<GmailHistoryResponse> {
    throw new Error("not used in calendar tests");
  }
  gmailGetProfile(): Promise<{ historyId?: string }> {
    throw new Error("not used in calendar tests");
  }
}

const EVENTS: CalendarEventResource[] = [
  {
    id: "a1",
    status: "confirmed",
    summary: "1:1 with Alice",
    start: { dateTime: "2026-07-18T15:00:00Z" },
    end: { dateTime: "2026-07-18T15:30:00Z" },
    attendees: [
      { email: "me@myself.com", self: true },
      { email: "alice@example.com", responseStatus: "accepted" },
    ],
    updated: "2026-07-10T00:00:00Z",
  },
  // a recurring event expanded (singleEvents=true) into two dated instances
  {
    id: "standup_20260718",
    summary: "Daily standup",
    start: { dateTime: "2026-07-18T09:00:00Z" },
    end: { dateTime: "2026-07-18T09:15:00Z" },
    recurringEventId: "standup",
  },
  {
    id: "standup_20260719",
    summary: "Daily standup",
    start: { dateTime: "2026-07-19T09:00:00Z" },
    end: { dateTime: "2026-07-19T09:15:00Z" },
    recurringEventId: "standup",
  },
  // an all-day event
  {
    id: "holiday",
    summary: "Company holiday",
    start: { date: "2026-07-18" },
    end: { date: "2026-07-19" },
  },
];

/** A client that answers DIFFERENTLY per calendar - the shape a per-calendar cap test needs. */
class PerCalendarClient extends FakeCalendarClient {
  constructor(private byCalendar: Record<string, CalendarListResponse>) {
    super({ items: [] });
  }
  override calendarListEvents(o: {
    calendarId: string;
    syncToken?: string;
    pageToken?: string;
    timeMin?: string;
  }): Promise<CalendarListResponse> {
    this.calls++;
    this.opts.push(o);
    return Promise.resolve(this.byCalendar[o.calendarId] ?? { items: [] });
  }
}

const PG_BUDGET = spawnBudget(2);

async function seedAlice(lease: PgStoreLease): Promise<number> {
  return (await addPersonFor(lease.store, "Alice Example", { email: "alice@example.com" })).id;
}

/** One row count, straight off the connection -- the assertions that used to be `db.query(...)`. */
async function count(lease: PgStoreLease, table: string, where = ""): Promise<number> {
  const rows = (await lease.sql.unsafe(
    `SELECT count(*)::int AS n FROM ${table} ${where}`,
  )) as Array<{ n: number }>;
  return rows[0]!.n;
}

async function cursor(lease: PgStoreLease, key: string): Promise<string | null> {
  const rows = (await lease.sql.unsafe(
    `SELECT value FROM skill_cursor WHERE key = '${key}'`,
  )) as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}

describe("calendar connector (127)", () => {
  test("first sync ingests events (recurrences expanded), maps attendee→person, mirrors cadence events", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const aliceId = await seedAlice(lease);
    const client = new FakeCalendarClient({ items: EVENTS, nextSyncToken: "SYNC1" });

    const res = await syncCalendar(db, {}, client);
    expect(res.events).toBe(4);
    expect(res.ingested).toBe(4);
    expect(await count(lease, "calendar_event")).toBe(4);

    // recurring instances land as separate rows carrying recurring_event_id
    const standups = (await lease.sql.unsafe(
      "SELECT id, recurring_event_id FROM calendar_event WHERE recurring_event_id = 'standup' ORDER BY id",
    )) as { id: string; recurring_event_id: string }[];
    expect(standups.map((r) => r.id)).toEqual(["standup_20260718", "standup_20260719"]);

    // attendee→person (self excluded); all-day flag set
    const a1 = (
      (await lease.sql.unsafe("SELECT person_id, all_day FROM calendar_event WHERE id = 'a1'")) as {
        person_id: number | null;
        all_day: number;
      }[]
    )[0]!;
    expect(a1.person_id).toBe(aliceId);
    expect(a1.all_day).toBe(0);
    expect(
      (
        (await lease.sql.unsafe("SELECT all_day FROM calendar_event WHERE id = 'holiday'")) as {
          all_day: number;
        }[]
      )[0]!.all_day,
    ).toBe(1);

    // cadence: an event mirrored per calendar event, with the person on the mapped one
    const evs = await eventsBetweenFor(db, { source: "gcal" });
    expect(evs).toHaveLength(4);
    expect(evs.every((e) => e.type === "event")).toBe(true);
    expect(evs.some((e) => e.actor === "Alice Example")).toBe(true);

    // syncToken cursor persisted per calendar
    expect(await cursor(lease, "gcal_synctoken:primary")).toBe("SYNC1");
    await lease.release();
  }, PG_BUDGET);

  test("re-sync dedups on (calendar_id, id) — updates in place, no new rows", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await seedAlice(lease);
    const client = new FakeCalendarClient({ items: EVENTS, nextSyncToken: "SYNC1" });

    await syncCalendar(db, {}, client);
    const res2 = await syncCalendar(db, {}, client);

    expect(res2.ingested).toBe(0);
    expect(await count(lease, "calendar_event")).toBe(4);
    expect(await eventsBetweenFor(db, { source: "gcal" })).toHaveLength(4); // recordEventFor idempotent
    await lease.release();
  }, PG_BUDGET);

  test("today's agenda returns only today's events, sorted by start", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new FakeCalendarClient({ items: EVENTS, nextSyncToken: "SYNC1" });
    await syncCalendar(db, {}, client);
    const rows = await agendaToday(db, new Date("2026-07-18T12:00:00Z"));
    // a1 (15:00), standup_20260718 (09:00), holiday (all-day) — NOT standup_20260719
    expect(rows.map((r) => r.id)).toEqual(["holiday", "standup_20260718", "a1"]);
    await lease.release();
  }, PG_BUDGET);

  // #47 — the Today home's getAgenda server fn wraps agendaToday with no new logic. This grounds that
  // read path against a directly-seeded temp DB (no sync): today's timed + all-day events are returned,
  // sorted by start; a tomorrow event is excluded.
  test("agendaToday over a directly-seeded db returns today's events, all-day first, sorted by start", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await db.q.insert(db.t.calendarEvent).values([
      { id: "t-late", calendar_id: "primary", summary: "Late meeting", start_ts: "2026-07-18T16:00:00Z", all_day: 0 },
      { id: "t-early", calendar_id: "primary", summary: "Early meeting", start_ts: "2026-07-18T09:00:00Z", all_day: 0 },
      { id: "t-allday", calendar_id: "primary", summary: "Public holiday", start_ts: "2026-07-18", all_day: 1 },
      { id: "t-tomorrow", calendar_id: "primary", summary: "Tomorrow", start_ts: "2026-07-19T09:00:00Z", all_day: 0 },
    ]);
    const rows = await agendaToday(db, new Date("2026-07-18T12:00:00Z"));
    // all-day (bare date sorts before ISO datetimes for the same day), then 09:00, then 16:00; tomorrow excluded.
    expect(rows.map((r) => r.id)).toEqual(["t-allday", "t-early", "t-late"]);
    expect(rows.map((r) => r.summary)).toEqual(["Public holiday", "Early meeting", "Late meeting"]);
    await lease.release();
  }, PG_BUDGET);

  // OB-1787: "today" is the South African day. SA is UTC+2, so 22:00Z-00:00Z is already tomorrow there.
  test("agendaToday uses the South African day: a 23:00Z event belongs to the next SA day", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await db.q.insert(db.t.calendarEvent).values([
      { id: "prev-evening", calendar_id: "primary", summary: "21:59Z = 23:59 SA, 5 Nov", start_ts: "2026-11-05T21:59:00.000Z", all_day: 0 },
      { id: "just-after-midnight", calendar_id: "primary", summary: "22:00Z = 00:00 SA, 6 Nov", start_ts: "2026-11-05T22:00:00.000Z", all_day: 0 },
      { id: "late-night", calendar_id: "primary", summary: "23:00Z = 01:00 SA, 6 Nov", start_ts: "2026-11-05T23:00:00.000Z", all_day: 0 },
      { id: "morning", calendar_id: "primary", summary: "08:00Z = 10:00 SA, 6 Nov", start_ts: "2026-11-06T08:00:00.000Z", all_day: 0 },
      { id: "allday-6", calendar_id: "primary", summary: "all-day 6 Nov", start_ts: "2026-11-06", all_day: 1 },
      { id: "allday-5", calendar_id: "primary", summary: "all-day 5 Nov", start_ts: "2026-11-05", all_day: 1 },
      { id: "allday-7", calendar_id: "primary", summary: "all-day 7 Nov", start_ts: "2026-11-07", all_day: 1 },
      { id: "next-night", calendar_id: "primary", summary: "22:00Z 6 Nov = 7 Nov SA", start_ts: "2026-11-06T22:00:00.000Z", all_day: 0 },
    ]);
    // 6 Nov 00:30 SA is still 5 Nov in UTC: the old UTC day would have answered 5 Nov.
    const rows = await agendaToday(db, new Date("2026-11-05T22:30:00Z"));
    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(["just-after-midnight", "late-night", "morning", "allday-6"]));
    await lease.release();
  }, PG_BUDGET);

  test("a 410 GONE on an incremental sync triggers a clean full resync", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await seedAlice(lease);
    // seed a stored syncToken so the next sync goes incremental
    const primed = new FakeCalendarClient({ items: EVENTS, nextSyncToken: "SYNC1" });
    await syncCalendar(db, {}, primed);

    // a client that 410s when a syncToken is supplied, but succeeds on the token-less retry
    let sawToken = false;
    const client: GoogleClient = {
      calendarListEvents: (opts) => {
        if (opts.syncToken) {
          sawToken = true;
          return Promise.reject(new SyncTokenExpiredError("410 GONE"));
        }
        return Promise.resolve({ items: EVENTS, nextSyncToken: "SYNC2" });
      },
      gmailListMessages: () => Promise.reject(new Error("n/a")),
      gmailGetMessage: () => Promise.reject(new Error("n/a")),
      gmailHistoryList: () => Promise.reject(new Error("n/a")),
      gmailGetProfile: () => Promise.reject(new Error("n/a")),
    };

    const res = await syncCalendar(db, {}, client);
    expect(sawToken).toBe(true); // it tried the incremental path first
    expect(res.events).toBe(4); // then resynced fully
    expect(await cursor(lease, "gcal_synctoken:primary")).toBe("SYNC2");
    await lease.release();
  });
});

describe("calendar backfill bounding (140)", () => {
  test("first full sync is bounded to a recent window (timeMin ≈ now − 30d)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new FakeCalendarClient({ items: EVENTS, nextSyncToken: "SYNC1" });
    await syncCalendar(db, {}, client);
    const timeMin = client.opts[0]?.timeMin;
    expect(timeMin).toBeTruthy();
    const ageDays = (Date.now() - new Date(timeMin!).getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(29);
    expect(ageDays).toBeLessThan(31);
    await lease.release();
  }, PG_BUDGET);

  test("--since sets timeMin for the full sync", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new FakeCalendarClient({ items: EVENTS, nextSyncToken: "SYNC1" });
    await syncCalendar(db, { since: "2026-01-15" }, client);
    expect(client.opts[0]?.timeMin).toBe(new Date("2026-01-15").toISOString());
    await lease.release();
  }, PG_BUDGET);

  test("--max caps events processed and withholds the syncToken so the next run resumes", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const client = new FakeCalendarClient({ items: EVENTS, nextSyncToken: "SYNC1" });
    const res = await syncCalendar(db, { max: 2 }, client);
    expect(res.events).toBe(2);
    expect(res.ingested).toBe(2);
    expect(await count(lease, "calendar_event")).toBe(2);
    // capped → syncToken NOT persisted, so a re-run re-fetches the un-processed tail
    expect(await cursor(lease, "gcal_synctoken:primary")).toBeNull();
    await lease.release();
  });
});

// ── the cap is PER CALENDAR (1936) ───────────────────────────────────────────────────────────────────
// `<seen>` and `capped` used to be shared across the calendar loop: once one calendar hit `--max`, the
// loop broke and every calendar after it was skipped for the whole run, with no syncToken saved either.

describe("calendar cap per calendar (1936)", () => {
  test("a capped first calendar does not stop the second, which still fetches and saves its syncToken", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await setConfig(db, "google_calendar_ids", "primary,work");
    // primary has four events (it will cap at 2); work has one (it finishes).
    const client = new PerCalendarClient({
      primary: { items: EVENTS, nextSyncToken: "SYNC1" },
      work: { items: [EVENTS[0]!], nextSyncToken: "WORK1" },
    });

    await syncCalendar(db, { max: 2 }, client);

    // Two calls: one for each calendar. Before the fix the loop broke after the first.
    expect(client.opts.map((o) => o.calendarId)).toEqual(["primary", "work"]);
    // primary processed its cap of 2, work its single event: all three rows landed.
    expect(await count(lease, "calendar_event")).toBe(3);
    // The capped calendar withholds ONLY its own token; the one that finished saves its token.
    expect(await cursor(lease, "gcal_synctoken:primary")).toBeNull();
    expect(await cursor(lease, "gcal_synctoken:work")).toBe("WORK1");
    await lease.release();
  }, PG_BUDGET);
});

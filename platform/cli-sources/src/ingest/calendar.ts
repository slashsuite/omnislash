import { and, asc, eq, gte, lt } from "drizzle-orm";
import { saDayBounds } from "../sa-time.ts";
import { recordEventFor } from "../../../../apps/cli/src/events.ts";
import { getCursorFor, normalizeSince, setCursorFor, settingFor } from "../../../../apps/cli/src/settings.ts";
import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { googleInvalidGrantRecorder } from "../../../../apps/cli/src/credentials.ts";
import { resolvePersonFor, type PersonRow } from "../../../../apps/cli/src/commands/person.ts";
import {
  type CalendarEventResource,
  type GoogleClient,
  getGoogleToken,
  HttpGoogleClient,
  SyncTokenExpiredError,
} from "../google.ts";

const cursorKey = (calendarId: string): string => `gcal_synctoken:${calendarId}`;

/** First-run/backfill default: only events from the recent window forward, so we don't pull all history. */
export const DEFAULT_CALENDAR_WINDOW_DAYS = 30;
/** Hard cap on events processed per run (quota safety-net) when `--max` is not given. */
export const DEFAULT_MAX_EVENTS = 500;

/** Resolve the `timeMin` bound for a full sync: explicit --timeMin, then --since, else the default window. */
export function resolveCalendarTimeMin(opts: { timeMin?: string | undefined; since?: string | undefined }, now = new Date()): string {
  if (opts.timeMin) return opts.timeMin;
  if (opts.since) return normalizeSince(opts.since);
  return new Date(now.getTime() - DEFAULT_CALENDAR_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
}

// --- pure, unit-testable helpers -------------------------------------------

/** Resolve an event's start: dateTime (timed) → ISO; date (all-day) → the date; else null. */
export function eventStart(ev: CalendarEventResource): { ts: string | null; allDay: boolean } {
  if (ev.start?.dateTime) return { ts: new Date(ev.start.dateTime).toISOString(), allDay: false };
  if (ev.start?.date) return { ts: ev.start.date, allDay: true };
  return { ts: null, allDay: false };
}

function eventEnd(ev: CalendarEventResource): string | null {
  if (ev.end?.dateTime) return new Date(ev.end.dateTime).toISOString();
  if (ev.end?.date) return ev.end.date;
  return null;
}

/** First attendee (excluding self) that resolves to a known person — the cadence link. */
export async function attendeePerson(
  store: Store,
  ev: CalendarEventResource,
): Promise<PersonRow | null> {
  for (const a of ev.attendees ?? []) {
    if (a.self) continue;
    if (!a.email) continue;
    const p = await resolvePersonFor(store, a.email);
    if (p) return p;
  }
  return null;
}

/**
 * The row one Calendar event writes. PURE, and shared by the insert and the on-conflict update below, so
 * the two can never disagree about what an event's columns are.
 *
 * `all_day` is a plain `integer` column, NOT a drizzle `{ mode: "boolean" }` one, so the 0/1 written here
 * is the literal stored value and `store.bool` has nothing to encode -- checked in db/pg/schema.ts rather
 * than assumed, because a boolean handed to an int4 column is a Postgres type error, not a wrong answer.
 * `attendees`, `recurrence` and `raw` are plain `text` for the same reason, so JSON.stringify IS the
 * encoding and `store.json` would double-encode them.
 */
function calendarEventRow(
  calendarId: string,
  ev: CalendarEventResource,
  ts: string | null,
  end: string | null,
  allDay: boolean,
  personId: number | null,
) {
  return {
    id: ev.id,
    calendar_id: calendarId,
    summary: ev.summary ?? null,
    start_ts: ts,
    end_ts: end,
    all_day: allDay ? 1 : 0,
    attendees: JSON.stringify(ev.attendees ?? []),
    recurring_event_id: ev.recurringEventId ?? null,
    recurrence: ev.recurrence ? JSON.stringify(ev.recurrence) : null,
    status: ev.status ?? null,
    person_id: personId,
    updated_ts: ev.updated ?? null,
    raw: JSON.stringify(ev),
  };
}

// --- ingestion --------------------------------------------------------------

/** Upsert one Calendar event (keyed on (calendar_id, id)) + mirror an `event` for cadence.
 *  Returns true when a NEW row was inserted, false when it updated an existing row. */
export async function ingestEvent(
  store: Store,
  calendarId: string,
  ev: CalendarEventResource,
): Promise<boolean> {
  const { ts, allDay } = eventStart(ev);
  const end = eventEnd(ev);
  const person = await attendeePerson(store, ev);
  const values = calendarEventRow(calendarId, ev, ts, end, allDay, person?.id ?? null);

  return store.txn("record the calendar event", async (tx) => {
    // A retried transaction starts from nothing, so the flag is computed inside the body rather than
    // carried in from outside it (317).
    const existing = (await tx.q
      .select({ id: tx.t.calendarEvent.id })
      .from(tx.t.calendarEvent)
      .where(
        and(eq(tx.t.calendarEvent.calendar_id, calendarId), eq(tx.t.calendarEvent.id, ev.id)),
      )
      .limit(1)) as Array<{ id: string }>;
    const inserted = existing.length === 0;
    await tx.q
      .insert(tx.t.calendarEvent)
      .values(values)
      .onConflictDoUpdate({
        target: [tx.t.calendarEvent.calendar_id, tx.t.calendarEvent.id],
        set: {
          summary: values.summary,
          start_ts: values.start_ts,
          end_ts: values.end_ts,
          all_day: values.all_day,
          attendees: values.attendees,
          recurring_event_id: values.recurring_event_id,
          recurrence: values.recurrence,
          status: values.status,
          person_id: values.person_id,
          updated_ts: values.updated_ts,
          raw: values.raw,
        },
      });
    // Cadence signal (122): a calendar event mapped to a person is a real contact-touch. recordEventFor
    // is idempotent per (source,type,ts,payload), so re-syncing the same event does not duplicate it.
    if (ts) {
      await recordEventFor(tx, {
        ts,
        source: "gcal",
        type: "event",
        actor: person?.real_name ?? null,
        payload: {
          id: ev.id,
          calendar_id: calendarId,
          summary: ev.summary ?? null,
          person_id: person?.id ?? null,
        },
      });
    }
    return inserted;
  });
}

async function buildClient(store: Store): Promise<GoogleClient> {
  // Store-first (falls back to the legacy token file); throws a clean AppError when neither is present.
  const { token, persist } = await getGoogleToken(store);
  return new HttpGoogleClient(token, persist, { onInvalidGrant: googleInvalidGrantRecorder(store) });
}

export interface CalendarSyncResult {
  events: number; // events seen this run
  ingested: number; // NEW rows landed (post-dedup)
  calendars: string[];
}

export interface CalendarSyncOpts {
  backfill?: boolean | undefined;
  /** Absolute lower bound for a full sync (ISO). Overrides --since and the default window. */
  timeMin?: string | undefined;
  /** Bound the full sync from a `--since` instant (ISO / YYYY-MM-DD / "-Nd"). */
  since?: string | undefined;
  /** Hard cap on events processed per CALENDAR in this run (default DEFAULT_MAX_EVENTS, 1936). */
  max?: number | undefined;
}

/**
 * Sync Google Calendar into calendar_event. Polls events.list per configured calendar, incrementally
 * from a stored syncToken (full resync on first run or on a 410 GONE). A full sync is BOUNDED to a recent
 * window (default: events from the last 30d forward, overridable via --since/--timeMin) rather than all
 * history. `--max` caps events processed PER CALENDAR, and a calendar that hits it withholds its own
 * syncToken so its next run resumes; the remaining calendars are still synced (1936). singleEvents expands
 * recurrences into dated instances. Dedups on (calendar_id, id). The Google client is injectable
 * (fixtures in tests → never hits the network).
 */
export async function syncCalendar(
  store: Store,
  opts: CalendarSyncOpts = {},
  client?: GoogleClient,
): Promise<CalendarSyncResult> {
  const c = client ?? (await buildClient(store));
  const calendarIds = (await settingFor(store, "google_calendar_ids"))
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const max = opts.max && opts.max > 0 ? opts.max : DEFAULT_MAX_EVENTS;
  const timeMin = resolveCalendarTimeMin(opts);

  let seen = 0;
  let ingested = 0;
  for (const calendarId of calendarIds) {
    // The cap is PER CALENDAR (1936). `seen` and `capped` used to be shared across the loop, so once one
    // calendar hit `--max`, every calendar after it was skipped for the whole run and none of their new
    // events landed. A capped calendar withholds only its OWN syncToken, and the loop carries on.
    let calendarSeen = 0;
    let capped = false;
    const key = cursorKey(calendarId);
    let syncToken = opts.backfill ? undefined : ((await getCursorFor(store, key)) ?? undefined);
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;

    outer: do {
      let resp;
      try {
        resp = await c.calendarListEvents({ calendarId, syncToken, pageToken, timeMin });
      } catch (err) {
        if (err instanceof SyncTokenExpiredError) {
          // stale token — restart this calendar with a full (bounded) resync
          syncToken = undefined;
          pageToken = undefined;
          nextSyncToken = undefined;
          resp = await c.calendarListEvents({ calendarId, timeMin });
        } else {
          throw err;
        }
      }
      for (const ev of resp.items ?? []) {
        if (!ev.id) continue;
        if (calendarSeen >= max) {
          capped = true;
          break outer;
        }
        calendarSeen++;
        seen++;
        if (await ingestEvent(store, calendarId, ev)) ingested++;
      }
      pageToken = resp.nextPageToken;
      if (resp.nextSyncToken) nextSyncToken = resp.nextSyncToken;
    } while (pageToken);

    // Withhold THIS calendar's syncToken when it is the one that capped, so its own next run re-fetches
    // the un-processed tail. A calendar that finished is saved whatever the others did.
    if (nextSyncToken && !capped) await setCursorFor(store, key, nextSyncToken);
  }

  return { events: seen, ingested, calendars: calendarIds };
}

// --- read side --------------------------------------------------------------

export interface AgendaRow {
  id: string;
  calendar_id: string;
  summary: string | null;
  start_ts: string | null;
  end_ts: string | null;
  all_day: number | null;
  person_id: number | null;
}

/**
 * Events whose start falls within [from, to) (ISO bounds), ascending by start.
 *
 * ORDER BY ON A NULLABLE COLUMN, and why it is safe here. `start_ts` IS nullable, which is exactly the
 * shape where Postgres sorts NULLs FIRST -- but the WHERE bounds it with `>= from` AND `< to`, and a NULL
 * satisfies neither comparison, so no null-start row can reach the sort at all. `id` breaks ties so two
 * events starting in the same minute do not swap places between runs.
 */
export async function agenda(store: Store, from: string, to: string): Promise<AgendaRow[]> {
  return (await store.q
    .select({
      id: store.t.calendarEvent.id,
      calendar_id: store.t.calendarEvent.calendar_id,
      summary: store.t.calendarEvent.summary,
      start_ts: store.t.calendarEvent.start_ts,
      end_ts: store.t.calendarEvent.end_ts,
      all_day: store.t.calendarEvent.all_day,
      person_id: store.t.calendarEvent.person_id,
    })
    .from(store.t.calendarEvent)
    .where(and(gte(store.t.calendarEvent.start_ts, from), lt(store.t.calendarEvent.start_ts, to)))
    .orderBy(asc(store.t.calendarEvent.start_ts), asc(store.t.calendarEvent.id))) as AgendaRow[];
}

/** Today's agenda (the South African calendar day of `now`: a 23:00Z event belongs to the next day). The
 *  bounds catch both timed events (stored as full UTC ISO) and all-day events (stored as a bare
 *  YYYY-MM-DD) via lexical ordering. */
export async function agendaToday(store: Store, now = new Date()): Promise<AgendaRow[]> {
  const { from, to } = saDayBounds(now);
  return agenda(store, from, to);
}

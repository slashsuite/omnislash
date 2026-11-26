import { and, desc, eq, gte, lte } from "drizzle-orm";
import { recordEventFor } from "../../../../apps/cli/src/events.ts";
import { getCursorFor, setCursorFor } from "../../../../apps/cli/src/settings.ts";
import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { googleInvalidGrantRecorder } from "../../../../apps/cli/src/credentials.ts";
import { resolvePersonFor } from "../../../../apps/cli/src/commands/person.ts";
import { warn } from "../../../../apps/cli/src/output.ts";
import { AppError } from "../../../../apps/cli/src/errors.ts";
import {
  type GmailMessage,
  type GmailMessagePart,
  type GoogleClient,
  getGoogleToken,
  HttpGoogleClient,
  isExpiredGmailHistory,
  isGoneGoogleMessage,
} from "../google.ts";

/** The history-poll cursor: a Gmail historyId. */
const GMAIL_CURSOR = "gmail_history";
/**
 * OB-1914: the resume point of a capped backfill, JSON `{ h, q, before? }` (see `BackfillPoint`). `""`
 * means none: settings has no delete, so "cleared" is an empty value, and empty reads as absent.
 */
const GMAIL_BACKFILL_CURSOR = "gmail_backfill";

/** First-run/backfill default: only the recent window, so we don't paginate the whole mailbox. */
export const DEFAULT_BACKFILL_WINDOW_DAYS = 30;
export const DEFAULT_BACKFILL_QUERY = `newer_than:${DEFAULT_BACKFILL_WINDOW_DAYS}d`;
/** Hard cap on messages fetched per run (quota safety-net) when `--max` is not given. */
export const DEFAULT_MAX_MESSAGES = 500;

/** Convert a `--since` value (ISO, YYYY-MM-DD, or "-Nd") into a Gmail search clause. */
export function sinceToGmailQuery(since: string): string {
  const rel = since.match(/^-(\d+)d$/);
  if (rel) return `newer_than:${rel[1]}d`;
  const d = new Date(since);
  if (!Number.isNaN(d.getTime())) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `after:${y}/${m}/${day}`;
  }
  return since; // unrecognized → pass through as a raw Gmail query
}

const DAY_SECONDS = 86_400;

/** Resolve the backfill list query: raw --query wins, then --days, then --since, else the default window. */
export function resolveBackfillQuery(opts: { query?: string | undefined; days?: number | undefined; since?: string | undefined }): string {
  if (opts.query) return opts.query;
  if (typeof opts.days === "number" && Number.isFinite(opts.days) && opts.days > 0) return `newer_than:${opts.days}d`;
  if (opts.since) return sinceToGmailQuery(opts.since);
  return DEFAULT_BACKFILL_QUERY;
}

/**
 * OB-1914: the backfill window made ABSOLUTE, so a backfill resumed days later covers the same mail. A
 * `newer_than:Nd` window (the default, `--days`, or a relative `--since`) becomes `after:<unix seconds>`
 * computed from `nowMs`. A raw `--query` is kept exactly as given; an absolute `--since` is already
 * `after:YYYY/MM/DD`.
 */
export function resolveAbsoluteBackfillQuery(
  opts: { query?: string | undefined; days?: number | undefined; since?: string | undefined },
  nowMs: number,
): string {
  const q = resolveBackfillQuery(opts);
  if (opts.query) return q;
  const rel = q.match(/^newer_than:(\d+)d$/);
  if (!rel) return q;
  return `after:${Math.floor(nowMs / 1000) - Number(rel[1]) * DAY_SECONDS}`;
}

// --- pure, unit-testable helpers -------------------------------------------

/** Case-insensitive header lookup on a Gmail payload. */
export function header(payload: GmailMessagePart | undefined, name: string): string | null {
  for (const h of payload?.headers ?? []) {
    if (h.name.toLowerCase() === name.toLowerCase()) return h.value;
  }
  return null;
}

/** Extract the bare email address from a `Name <addr@x>` (or plain) From/To header. */
export function parseAddr(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/);
  const addr = ((m ? m[1] : raw) ?? "").trim().toLowerCase();
  return addr.length > 0 ? addr : null;
}

function decodePart(data: string | undefined): string {
  if (!data) return "";
  try {
    return Buffer.from(data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

/** Best-effort plain-text body: prefer text/plain, else text/html, else the top-level body. */
export function decodeBody(payload: GmailMessagePart | undefined): string {
  if (!payload) return "";
  const walk = (part: GmailMessagePart, want: string): string | null => {
    if (part.mimeType === want && part.body?.data) return decodePart(part.body.data);
    for (const sub of part.parts ?? []) {
      const hit = walk(sub, want);
      if (hit) return hit;
    }
    return null;
  };
  return walk(payload, "text/plain") ?? walk(payload, "text/html") ?? decodePart(payload.body?.data);
}

/** Gmail internalDate (epoch millis string) → ISO-8601. */
export function internalDateToIso(internalDate: string | undefined): string {
  const ms = Number(internalDate);
  if (!Number.isFinite(ms) || ms <= 0) return new Date(0).toISOString();
  return new Date(ms).toISOString();
}

// --- ingestion --------------------------------------------------------------

/**
 * Everything one Gmail message contributes to its row, derived from the API payload alone. PURE, and
 * kept out of the write so the columns are computed once whichever engine is underneath.
 */
export function emailFields(msg: GmailMessage): {
  fromAddr: string | null;
  subject: string;
  toAddrs: string[];
  body: string;
  ts: string;
} {
  const fromAddr = parseAddr(header(msg.payload, "From"));
  const subject = header(msg.payload, "Subject") ?? "";
  const toAddrs = (header(msg.payload, "To") ?? "")
    .split(",")
    .map((s) => parseAddr(s))
    .filter((a): a is string => a != null);
  return { fromAddr, subject, toAddrs, body: decodeBody(msg.payload), ts: internalDateToIso(msg.internalDate) };
}

/** Insert one Gmail message (+ FTS + event mirror). Idempotent on the message id.
 *  Returns true when a NEW row was inserted, false when it already existed. */
export async function ingestMessage(store: Store, msg: GmailMessage): Promise<boolean> {
  const fields = emailFields(msg);
  const person = fields.fromAddr ? await resolvePersonFor(store, fields.fromAddr) : null;

  return store.txn("record the email", async (tx) => {
    // A retried transaction starts from nothing, so the flag is decided inside the body (317).
    const existing = (await tx.q
      .select({ id: tx.t.emailMessage.id })
      .from(tx.t.emailMessage)
      .where(eq(tx.t.emailMessage.id, msg.id))
      .limit(1)) as Array<{ id: string }>;
    if (existing.length > 0) return false;
    await tx.q.insert(tx.t.emailMessage).values({
      id: msg.id,
      thread_id: msg.threadId ?? null,
      from_addr: fields.fromAddr,
      to_addr: JSON.stringify(fields.toAddrs),
      subject: fields.subject,
      snippet: msg.snippet ?? null,
      body: fields.body,
      ts: fields.ts,
      labels: JSON.stringify(msg.labelIds ?? []),
      person_id: person?.id ?? null,
      raw: JSON.stringify(msg),
    });
    // NO FTS MAINTENANCE HERE, and that is the point rather than an omission. The old sqlite path had to
    // hand-write an `email_fts` shadow row on every insert because fts5 virtual tables have no triggers
    // in this repo. Postgres has no shadow table: ob 322 declared `search_vec` GENERATED ALWAYS ... STORED
    // on email_message, so the insert above already recomputed the index. A row can no longer be stored
    // and left unsearchable, which was a real failure mode of the hand-maintained form.
    await recordEventFor(tx, {
      ts: fields.ts,
      source: "gmail",
      type: "email",
      actor: fields.fromAddr,
      payload: {
        id: msg.id,
        thread_id: msg.threadId ?? null,
        subject: fields.subject,
        from: fields.fromAddr,
        person_id: person?.id ?? null,
      },
    });
    return true;
  });
}

async function buildClient(store: Store): Promise<GoogleClient> {
  // Store-first (falls back to the legacy token file); throws a clean AppError when neither is present.
  const { token, persist } = await getGoogleToken(store);
  return new HttpGoogleClient(token, persist, { onInvalidGrant: googleInvalidGrantRecorder(store) });
}

export interface GmailSyncResult {
  messages: number; // messages fetched this run
  skipped: number; // 404/403 on an individual GET — gone, counted so a mass-skip is visible
  ingested: number; // NEW rows landed (post-dedup)
  cursor: string | null; // GMAIL_CURSOR (the historyId) after the run
}

export interface GmailSyncOpts {
  backfill?: boolean | undefined;
  /** Raw Gmail search query — overrides the recent-window default. */
  query?: string | undefined;
  /** Bound the backfill to the last <days> days. */
  days?: number | undefined;
  /** Bound the backfill from a `--since` instant (ISO / YYYY-MM-DD / "-Nd"). */
  since?: string | undefined;
  /** Hard cap on messages fetched this run (default DEFAULT_MAX_MESSAGES). */
  max?: number | undefined;
  /** Clock seam (epoch ms) for the absolute backfill window; tests pin it. */
  now?: (() => number) | undefined;
}

/** A capped backfill's resume point. `h` is the profile historyId read when the backfill started. */
export interface BackfillPoint {
  h: string;
  q: string;
  /** Unix seconds: the next run lists `(<q>) before:<before>`. Absent: nothing fetched yet, list `(<q>)`. */
  before?: number;
}

/** The profile gave no historyId, so a backfill cannot know where the history poll should start. */
export class GmailProfileHistoryError extends AppError {
  constructor() {
    super("gmail: users/me/profile returned no historyId; backfill not started");
  }
}

function parseBackfillPoint(raw: string | null): BackfillPoint | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<BackfillPoint>;
    if (typeof p.h !== "string" || !p.h || typeof p.q !== "string") return null;
    return { h: p.h, q: p.q, ...(typeof p.before === "number" ? { before: p.before } : {}) };
  } catch {
    return null;
  }
}

async function isStored(store: Store, id: string): Promise<boolean> {
  const rows = (await store.q
    .select({ id: store.t.emailMessage.id })
    .from(store.t.emailMessage)
    .where(eq(store.t.emailMessage.id, id))
    .limit(1)) as Array<{ id: string }>;
  return rows.length > 0;
}

/**
 * Sync Gmail into email_message. The mode, in order:
 *  1. `--backfill`: a FRESH backfill.
 *  2. a stored backfill resume point (GMAIL_BACKFILL_CURSOR): RESUME that backfill, whatever window
 *     this run carries (the scheduled job runs a plain `ob gmail sync`).
 *  3. a stored historyId (GMAIL_CURSOR): poll history.list from it. A 404 there (expired) goes to a
 *     fresh backfill. A complete poll moves the cursor to the page historyId (the head); a capped one to
 *     the id of the last history record it finished, so the next run re-lists the rest (OB-1949).
 *  4. neither: a fresh backfill.
 *
 * A fresh backfill reads the profile historyId H FIRST (so mail arriving mid-backfill is after H), makes
 * the window absolute (`newer_than:Nd` → `after:<seconds>`; a raw --query is kept), then lists newest
 * first and ingests as pages arrive. A run that lists out the window is COMPLETE: it writes H to
 * GMAIL_CURSOR, then clears the resume point (that order, so a crash between leaves a resume that
 * completes again). An empty window is complete too. A run that stops at `--max` with ids left is
 * CAPPED: it stores `{ h, q, before: <oldest fetched second> + 1 }` and leaves GMAIL_CURSOR alone, so
 * the next run lists `(<q>) before:<n>` and carries on down the window (+1 re-lists a same-second
 * neighbour; an id already stored is skipped without a GET or a count). A thrown error writes nothing,
 * so the next run repeats this one.
 *
 * Known limits: a second holding more than `max` messages is re-listed on each run, but the stored
 * ones are skipped without counting, so it is still walked `max` new messages per run. A backfill
 * that outlives Gmail's history retention (about a week) leaves H expired; the history 404 fallback then
 * starts a fresh backfill, which is the right outcome. Two concurrent runs (the CLI and the API handler,
 * 415) can race on the cursors; there is no lock, and the worst case is a repeated range, which the
 * id dedup absorbs. Dedups on the message id. The Google client is injectable (fixtures in tests).
 */
export async function syncGmail(
  store: Store,
  opts: GmailSyncOpts = {},
  client?: GoogleClient,
): Promise<GmailSyncResult> {
  const c = client ?? (await buildClient(store));
  const cursor = await getCursorFor(store, GMAIL_CURSOR);
  const resume = opts.backfill ? null : parseBackfillPoint(await getCursorFor(store, GMAIL_BACKFILL_CURSOR));
  const max = opts.max && opts.max > 0 ? opts.max : DEFAULT_MAX_MESSAGES;
  const now = opts.now ?? Date.now;

  let newCursor = cursor;
  let ingested = 0;
  let fetched = 0;
  let skipped = 0;
  let capped = false;
  let maxHistoryId = newCursor ? Number(newCursor) : 0;
  let oldestMs = Number.POSITIVE_INFINITY; // oldest internalDate fetched (backfill resume bound)
  const seen = new Set<string>(); // dedupe ids within this run (a message can recur across history pages)

  // Fetch + ingest one message id, honoring the per-run cap. Returns false only when the cap refuses a GET
  // (sets `capped`). An id already stored (or seen this run) is skipped with no GET and no count, so the
  // cap is hit only when an id is LEFT unpulled: a list that runs out exactly at `max` reads as complete.
  // A 404/403 on the GET is a vanished id (deleted between list and fetch): log, count as skipped, keep
  // going. Session-bad errors (401, 429, timeout, network) still abort.
  const pull = async (id: string): Promise<boolean> => {
    if (seen.has(id)) return true;
    if (await isStored(store, id)) {
      seen.add(id);
      return true;
    }
    if (fetched >= max) {
      capped = true;
      return false;
    }
    seen.add(id);
    let msg: GmailMessage;
    try {
      msg = await c.gmailGetMessage(id);
    } catch (err) {
      if (isGoneGoogleMessage(err)) {
        skipped++;
        warn(`gmail: skipped ${id} (${(err as Error).message})`);
        return true;
      }
      throw err;
    }
    fetched++;
    if (await ingestMessage(store, msg)) ingested++;
    const ms = Number(msg.internalDate);
    if (Number.isFinite(ms) && ms > 0 && ms < oldestMs) oldestMs = ms;
    return true;
  };

  // One backfill run, fresh (`point` null) or resumed. Writes its own cursors at the end.
  const runBackfill = async (point: BackfillPoint | null) => {
    let h: string;
    let q: string;
    if (point) {
      ({ h, q } = point);
    } else {
      const profile = await c.gmailGetProfile();
      if (!profile.historyId) throw new GmailProfileHistoryError();
      h = profile.historyId;
      q = resolveAbsoluteBackfillQuery(opts, now());
    }
    const prevBefore = point?.before;
    const listQ = point ? (prevBefore !== undefined ? `(${q}) before:${prevBefore}` : `(${q})`) : q;
    let pageToken: string | undefined;
    outer: do {
      const resp = await c.gmailListMessages({ q: listQ, pageToken });
      for (const m of resp.messages ?? []) {
        if (!(await pull(m.id))) break outer;
      }
      pageToken = resp.nextPageToken;
    } while (pageToken);

    if (!capped) {
      await setCursorFor(store, GMAIL_CURSOR, h);
      await setCursorFor(store, GMAIL_BACKFILL_CURSOR, "");
      newCursor = h;
      return;
    }
    // No dated message fetched (the cap counts successful GETs, so this needs messages with no usable
    // internalDate): keep the previous bound so the next run lists the same range rather than losing it.
    const before = Number.isFinite(oldestMs) ? Math.floor(oldestMs / 1000) + 1 : prevBefore;
    const next: BackfillPoint = { h, q, ...(before !== undefined ? { before } : {}) };
    await setCursorFor(store, GMAIL_BACKFILL_CURSOR, JSON.stringify(next));
  };

  if (opts.backfill || resume || !cursor) {
    await runBackfill(resume);
    return { messages: fetched, skipped, ingested, cursor: newCursor };
  }

  // OB-1949: walk the history records in order. A record is FINISHED once every id it added was pulled,
  // skipped as stored/seen, or skipped as gone. The walk stops at the first refused GET, so the finished
  // records are a contiguous prefix and a capped run's cursor (the last finished record's own id) never
  // passes unprocessed work. A message's historyId is its LATEST change, so it is never used as a cursor.
  let lastFinishedId: string | null = null;
  let finishedAny = false;
  try {
    let pageToken: string | undefined;
    outer: do {
      const resp = await c.gmailHistoryList({ startHistoryId: cursor, pageToken });
      for (const h of resp.history ?? []) {
        for (const a of h.messagesAdded ?? []) {
          if (!(await pull(a.message.id))) break outer;
        }
        finishedAny = true;
        if (h.id) lastFinishedId = h.id;
      }
      // The page historyId is the mailbox head: only a COMPLETE run may fast-forward to it.
      const hid = Number(resp.historyId);
      if (Number.isFinite(hid) && hid > maxHistoryId) maxHistoryId = hid;
      pageToken = resp.nextPageToken;
    } while (pageToken);
  } catch (err) {
    if (!isExpiredGmailHistory(err)) throw err;
    warn(`gmail: history cursor ${cursor} expired; falling back to bounded backfill`);
    await runBackfill(null);
    return { messages: fetched, skipped, ingested, cursor: newCursor };
  }

  if (!capped) {
    if (maxHistoryId > 0) newCursor = String(maxHistoryId);
  } else if (lastFinishedId) {
    newCursor = lastFinishedId;
  } else if (finishedAny) {
    // Real Gmail records carry ids; without one the next run re-walks from the same cursor, which still
    // progresses because stored ids cost no GET.
    warn(`gmail: capped history run finished records with no id; cursor stays at ${cursor}`);
  }
  if (newCursor) await setCursorFor(store, GMAIL_CURSOR, newCursor);

  return { messages: fetched, skipped, ingested, cursor: newCursor };
}

// --- read side --------------------------------------------------------------

export interface EmailHit {
  id: string;
  from_addr: string | null;
  subject: string | null;
  ts: string | null;
  snippet: string | null;
  person_id: number | null;
}

// --- the read side (337) ------------------------------------------------------------------------------
//
// ORDER BY ON A NULLABLE COLUMN, checked rather than assumed. Both queries order by `ts` DESC, and `ts`
// IS nullable -- exactly the shape where Postgres sorts NULLs FIRST. It cannot bite here: the ONE writer
// of this table is `ingestMessage` above, whose `ts` comes from `internalDateToIso`, which returns the
// epoch instant for a missing or unparseable internalDate and never null. So there is no null-ts row to
// sort. `id` (the Gmail message id, the primary key) breaks ties so two messages sharing a millisecond do
// not swap places between runs.

const EMAIL_HIT_COLS = (t: Store["t"]) => ({
  id: t.emailMessage.id,
  from_addr: t.emailMessage.from_addr,
  subject: t.emailMessage.subject,
  ts: t.emailMessage.ts,
  snippet: t.emailMessage.snippet,
  person_id: t.emailMessage.person_id,
});

/**
 * Search ingested email (subject + body).
 *
 * ob 322's translator against the `search_vec` tsvector column, with the pg_trgm substring clause running
 * ONLY when the word match found nothing -- so a loose substring hit can never displace or reorder a real
 * word hit. This finds MORE than the fts5 form it replaces and loses nothing (measured over 29 queries):
 * tsvector stems, keeps an email address or a file path together as
 * one lexeme where fts5's unicode61 split it on punctuation, and drops stopwords.
 */
export async function searchEmail(store: Store, query: string, limit = 20): Promise<EmailHit[]> {
  const { emailSearch, runSearch } = await import("../../../../apps/cli/src/db/pg/search.ts");
  return runSearch(emailSearch(query), (where) =>
    store.q
      .select(EMAIL_HIT_COLS(store.t))
      .from(store.t.emailMessage)
      .where(where)
      .orderBy(desc(store.t.emailMessage.ts), desc(store.t.emailMessage.id))
      .limit(limit),
  ) as Promise<EmailHit[]>;
}

/** Recent ingested email (most recent first), optionally within a [since, until] window. */
export async function recentEmail(
  store: Store,
  opts: { since?: string | undefined; until?: string | undefined; limit?: number | undefined } = {},
): Promise<EmailHit[]> {
  const conds = [];
  if (opts.since) conds.push(gte(store.t.emailMessage.ts, opts.since));
  if (opts.until) conds.push(lte(store.t.emailMessage.ts, opts.until));
  return (await store.q
    .select(EMAIL_HIT_COLS(store.t))
    .from(store.t.emailMessage)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(store.t.emailMessage.ts), desc(store.t.emailMessage.id))
    .limit(opts.limit ?? 20)) as EmailHit[];
}

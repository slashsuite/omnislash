import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, desc, eq, gte, inArray, lt, lte, max, sql } from "drizzle-orm";
import { recordEventFor } from "../../../../apps/cli/src/events.ts";
import { getCursorFor, setCursorFor, normalizeSince, settingFor } from "../../../../apps/cli/src/settings.ts";
import { nowIso } from "../../../../apps/cli/src/db.ts";
import { readBool, type Store } from "../../../../apps/cli/src/db/store.ts";
import { listPersonsFor, resolvePersonFor } from "../../../../apps/cli/src/commands/person.ts";
import { expandHome } from "../../../../apps/cli/src/net.ts";
import { AppError } from "../../../../apps/cli/src/errors.ts";

// ── WhatsApp (personal) read-only ingest (099/100) ───────────────────────────────────────────────
// ob reads the Go bridge's messages.db READ-ONLY (new Database(path, { readonly: true })) and NEVER
// writes it — this ticket is INBOUND only (sending is a later ticket). Messages are pulled since the
// cursor, deduped on (chat_jid, id), the sender jid is enriched to a person (exact whatsapp_jid match;
// @lid privacy ids are stored as-is and simply stay unmapped for v1), whatsapp_fts is hand-maintained
// (no triggers), and each new row is mirrored into event(source='whatsapp'). The pull is BOUNDED
// (--since/--days lower bound) and CAPPED (--max, default 2000) so a huge history can't ingest
// unbounded in one run; ordered oldest-first so a capped run resumes from the cursor next time.

const CURSOR_KEY = "whatsapp_since";

/** Default hard cap on messages ingested per run (ticket-140 lesson: never ingest unbounded). */
export const DEFAULT_MAX_MESSAGES = 2000;

/**
 * How far back each sync re-reads outbound receipts from the bridge (1936). The cursor select only walks
 * FORWARD by message timestamp, so a receipt that lands after the cursor moved past its message is
 * invisible to it; this sweep gives those rows a second, bounded chance. 48 hours is far longer than
 * WhatsApp takes to deliver a read receipt, and short enough that the sweep stays two index reads.
 */
const RECEIPT_SWEEP_HOURS = 48;

/**
 * Receipt ranks (1936). WhatsApp advances a receipt `sent` -> `delivered` -> `read` -> `played`, and the
 * bridge writes exactly those words; anything else ranks 0 and never wins, so it is never stored over a
 * real receipt. The old upsert wrote whatever it saw, so a re-read `delivered` after a `read` moved the
 * status BACKWARDS and lost the tick. Only forward now.
 */
const RECEIPT_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, played: 4 };

/**
 * Does a bridge receipt ADVANCE a stored status (1936)? Only an OUTBOUND message has a receipt at all: an
 * inbound row never takes one, so it keeps NULL. On an outbound row a stored NULL ranks as `sent` (NULL has
 * always meant that there, and the two shapes are the same fact), and a receipt of equal or lower rank, or
 * an unrecognised one, does not write. Pure.
 */
function receiptAdvances(
  stored: string | null | undefined,
  isFromMe: boolean,
  next: string | null | undefined,
): boolean {
  if (!isFromMe) return false;
  const storedRank = RECEIPT_RANK[stored ?? ""] ?? RECEIPT_RANK.sent!;
  return (RECEIPT_RANK[next ?? ""] ?? 0) > storedRank;
}

/** One row from the bridge messages table (joined to chats for the chat name). */
interface BridgeRow {
  id: string;
  chat_jid: string;
  chat_name: string | null;
  sender_jid: string | null;
  content: string | null;
  timestamp: string | number | null;
  is_from_me: number | null;
  media_type: string | null;
  quoted_message_id: string | null;
  // Bridge delivery/read receipt (186a: delivered | read | played; NULL = sent, for is_from_me). Read
  // DEFENSIVELY — a pre-186a bridge has no `messages.status` column, so the SELECT projects NULL there.
  status?: string | null;
  // Bridge `messages.filename`. For a REACTION stanza (media_type="reaction") the bridge stores the
  // reacted-to message id HERE, not in quoted_message_id (which it leaves NULL) — see the whatsapp-mcp
  // bridge's reaction persist path. We read it to recover the reaction's target (#50). Read DEFENSIVELY
  // (a bridge/fixture without the column projects NULL) — for non-reaction rows it's the media filename,
  // which we don't otherwise persist.
  filename?: string | null;
}

/** Bridge `timestamp` → ISO-8601. Tolerates RFC3339/datetime strings and epoch seconds/millis ints. */
export function normalizeTs(raw: string | number | null | undefined): string {
  if (raw == null || raw === "") return nowIso();
  if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      // < 1e12 ⇒ epoch seconds; otherwise epoch millis
      return new Date(n < 1e12 ? n * 1000 : n).toISOString();
    }
  }
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString();
}

/** Open the bridge DB READ-ONLY. Clean AppError when the file is absent (bridge not stood up). */
async function openBridge(store: Store): Promise<Database> {
  const path = await settingFor(store, "whatsapp_db_path");
  const resolved = expandHome(path);
  if (!existsSync(resolved)) {
    throw new AppError(
      `cannot read WhatsApp bridge DB at ${path} (set config whatsapp_db_path, and run the bridge so it creates messages.db)`,
    );
  }
  return new Database(resolved, { readonly: true });
}

/**
 * Upsert one bridge message, deduped on (chat_jid, id). Returns whether a NEW row landed. Only on a new
 * row do we maintain whatsapp_fts (by hand, via the row's implicit rowid — no triggers) and mirror an
 * `event` (source='whatsapp'). The sender is enriched to a person_id when their whatsapp_jid is
 * registered (enrichment only — an unmapped sender, incl. @lid, still lands with person_id NULL).
 */
async function ingestMessage(
  tx: Store,
  r: BridgeRow,
  lidMap: Map<string, string>,
): Promise<boolean> {
  // ── the CHAT jid is canonicalized too, not just the sender (312) ──────────────────────────────
  // The sender has been canonicalized since 164, but the chat jid was stored raw — and the dedupe key is
  // (chat_jid, id), so the SAME message arriving under a contact's `@lid` chat and under their
  // `<phone>@s.whatsapp.net` chat landed as TWO rows. A store paired fresh on 2026-08-17 showed exactly
  // that: one bridge id under both `70000000000001@lid` and `27000000014@s.whatsapp.net`, doubling every
  // message in the feed, doubling any AI draft context, and splitting per-chat prefs (hide / favorite /
  // ai-off) across two chats that are one conversation.
  //
  // Canonicalizing here fixes it at the identity level rather than filtering downstream: one conversation
  // is one chat_jid, so the existing (chat_jid, id) key does the dedupe by itself. An unmapped `@lid`
  // (no row in the bridge's lid map) is left alone — the same graceful degradation canonicalJid has always
  // had, and a wrong fold would be far worse than a duplicate.
  const chatJid = canonicalJid(r.chat_jid, lidMap);
  // A folded `@lid` chat carries the LID DIGITS as its chat_name, which is not a name. Storing it would
  // mean a LID copy arriving first labels the conversation `70000000000001` and the update path (which
  // only ever touches `status`) never corrects it. Null lets the normal contacts-name resolution answer.
  const chatName = chatJid !== r.chat_jid && r.chat_name === jidLocalPart(r.chat_jid) ? null : r.chat_name;

  const existing = (await tx.q
    .select({
      id: tx.t.whatsappMessage.id,
      status: tx.t.whatsappMessage.status,
      is_from_me: tx.t.whatsappMessage.is_from_me,
    })
    .from(tx.t.whatsappMessage)
    .where(and(eq(tx.t.whatsappMessage.chat_jid, chatJid), eq(tx.t.whatsappMessage.id, r.id)))
    .limit(1)) as Array<{ id: string; status: string | null; is_from_me: number | null }>;
  if (existing.length > 0) {
    // Not a new row — but the delivery/read status advances AFTER first ingest (sent→delivered→read),
    // so refresh it when the bridge now reports a FORWARD move (1936). It used to write whatever the
    // bridge said, so a re-read `delivered` after a `read` moved the status backwards and lost the tick.
    // A NULL status (sent / inbound / pre-186a bridge) leaves the stored value untouched.
    const stored = existing[0]!;
    if (receiptAdvances(stored.status, readBool(stored.is_from_me), r.status)) {
      await tx.q
        .update(tx.t.whatsappMessage)
        .set({ status: r.status })
        .where(and(eq(tx.t.whatsappMessage.chat_jid, chatJid), eq(tx.t.whatsappMessage.id, r.id)));
    }
    return false;
  }

  const isoTs = normalizeTs(r.timestamp);
  // Enrich to a person via the CANONICAL sender jid (an `@lid` sender maps to the same person as their
  // phone-jid, 164). The raw sender_jid is still stored as-is — canonicalization is enrichment-only.
  const senderForPerson = r.sender_jid ? canonicalJid(r.sender_jid, lidMap) : null;
  const person = senderForPerson ? await resolvePersonFor(tx, senderForPerson) : null;
  // `is_from_me` is a plain `integer` column, not a drizzle `{ mode: "boolean" }` one, so this 0/1 is the
  // literal stored value. It is READ back through readBool everywhere, never by truthiness: the bridge
  // row's own `is_from_me` arrives from bun:sqlite as a number, but the column is read back out of
  // Postgres and `Boolean("0")` is true where `Boolean(0)` is false.
  const isFromMe = readBool(r.is_from_me) ? 1 : 0;
  // #50: a reaction (media_type="reaction") reacts TO a message — the bridge puts that target id in
  // `filename`, leaving quoted_message_id NULL. Reuse the existing quoted_message_id column as the
  // reaction's target reference (no schema change) so the thread view can pin the reaction onto its
  // target instead of rendering it as a standalone row. Non-reaction rows keep the real quoted id.
  const quotedMessageId =
    r.media_type === "reaction" && r.filename ? r.filename : (r.quoted_message_id ?? null);

  await tx.q.insert(tx.t.whatsappMessage).values({
    id: r.id,
    chat_jid: chatJid,
    chat_name: chatName ?? null,
    sender_jid: r.sender_jid ?? null,
    content: r.content ?? null,
    ts: isoTs,
    is_from_me: isFromMe,
    media_type: r.media_type ?? null,
    quoted_message_id: quotedMessageId,
    person_id: person?.id ?? null,
    raw: JSON.stringify(r),
    // 1936: a fresh outbound message is `sent` even when the bridge leaves its status NULL (it does until
    // a receipt arrives), so NULL keeps its single meaning — inbound, or a row from before 186a. An
    // INBOUND row stores NULL whatever the bridge says: a receipt is a fact about a message we sent, and a
    // stray value there would make NULL mean two things again. Existing NULL outbound rows are NOT
    // backfilled: nothing reads NULL as anything but `sent`, and the sweep upgrades them on the next
    // receipt anyway.
    status: isFromMe ? (r.status ?? "sent") : null,
    created_at: nowIso(),
  });

  // NO FTS MAINTENANCE, and that is the point rather than an omission. The old path hand-wrote a
  // `whatsapp_fts` shadow row keyed by the message's implicit rowid, because fts5 virtual tables have no
  // triggers in this repo — a fragile join that had to resolve the rowid by (chat_jid, id) right after
  // the insert. ob 322 declared `search_vec` GENERATED ALWAYS ... STORED on whatsapp_message, so the
  // insert above already recomputed the index. A message can no longer be stored and left unsearchable.

  await recordEventFor(tx, {
    ts: isoTs,
    source: "whatsapp",
    type: isFromMe ? "sent" : "message",
    actor: r.sender_jid,
    payload: {
      chat_jid: chatJid,
      chat_name: chatName ?? null,
      id: r.id,
      is_from_me: isFromMe,
      media_type: r.media_type ?? null,
      person_id: person?.id ?? null,
    },
  });
  return true;
}

export interface WhatsappSyncResult {
  messages: number; // rows read from the bridge this run
  ingested: number; // NEW rows landed (post-dedup)
  events: number; // new events mirrored (== ingested)
  capped: boolean; // hit the --max cap (more history remains; re-run to continue)
  cursor: string | null; // advanced cursor (max bridge timestamp processed)
  /** `@lid` duplicate rows folded onto their canonical chat this run (312). Zero on a healthy store. */
  folded: number;
}

/** What one fold pass did. Both halves are reported because they are different repairs (312). */
export interface LidFoldResult {
  /** `@lid` rows deleted because the canonical chat already held that exact message id. */
  removed: number;
  /** `@lid` rows re-keyed onto the canonical chat because no twin existed there. */
  rekeyed: number;
}

/**
 * Fold `@lid` chat rows onto their canonical `<phone>@s.whatsapp.net` chat (312).
 *
 * Canonicalizing at ingest stops NEW duplicates, but it cannot undo the ones already stored, and those do
 * not age out: they sit in the feed forever, doubling a conversation. So a fold pass runs with each sync —
 * it touches ONLY rows whose chat_jid ends in `@lid` and whose lid resolves in the bridge's map, so on a
 * healthy store it is a single indexed lookup that finds nothing.
 *
 * Two different repairs, and the distinction matters. When the canonical chat ALREADY holds that message
 * id, the `@lid` row is a true duplicate and is deleted (with its hand-maintained FTS entry, since there
 * are no triggers in this repo). When it does not, the `@lid` row is the ONLY copy of that message and is
 * re-keyed instead — deleting it would lose a message, and its rowid does not change, so its FTS entry
 * stays valid.
 *
 * Unmapped `@lid` chats are left completely alone: a wrong fold merges two people's conversations, which
 * is far worse than a duplicate row.
 */
export async function foldLidChats(
  store: Store,
  lidMap: Map<string, string>,
): Promise<LidFoldResult> {
  const out: LidFoldResult = { removed: 0, rekeyed: 0 };
  if (lidMap.size === 0) return out;

  // `LIKE '%@lid'` rather than a builder helper so the predicate reads exactly as the index sees it.
  const lidRows = (await store.q
    .select({ chat_jid: store.t.whatsappMessage.chat_jid, id: store.t.whatsappMessage.id })
    .from(store.t.whatsappMessage)
    .where(sql`${store.t.whatsappMessage.chat_jid} LIKE '%@lid'`)) as Array<{
    chat_jid: string;
    id: string;
  }>;
  if (lidRows.length === 0) return out;

  for (const row of lidRows) {
    const canon = canonicalJid(row.chat_jid, lidMap);
    if (canon === row.chat_jid) continue; // unmapped @lid: leave it exactly as it is
    const twin = (await store.q
      .select({ id: store.t.whatsappMessage.id })
      .from(store.t.whatsappMessage)
      .where(and(eq(store.t.whatsappMessage.chat_jid, canon), eq(store.t.whatsappMessage.id, row.id)))
      .limit(1)) as Array<{ id: string }>;
    await store.txn("replace the whatsapp message", async (tx) => {
      if (twin.length > 0) {
        // A true duplicate: delete it. The old sqlite path had to delete a hand-maintained `whatsapp_fts`
        // shadow row first, by rowid, before the row it pointed at disappeared. There is no shadow row
        // now -- search_vec is GENERATED on the row itself and goes with it -- so the ordering hazard
        // that made this the fiddliest part of 312 is simply gone.
        await tx.q
          .delete(tx.t.whatsappMessage)
          .where(
            and(
              eq(tx.t.whatsappMessage.chat_jid, row.chat_jid),
              eq(tx.t.whatsappMessage.id, row.id),
            ),
          );
        out.removed += 1;
      } else {
        // The only copy: move it. chat_name goes too when it is just the LID digits — that is an id, not a
        // name, and leaving it would label the merged conversation with it.
        await tx.q
          .update(tx.t.whatsappMessage)
          .set({
            chat_jid: canon,
            chat_name: sql`CASE WHEN chat_name = ${jidLocalPart(row.chat_jid)} THEN NULL ELSE chat_name END`,
          })
          .where(
            and(
              eq(tx.t.whatsappMessage.chat_jid, row.chat_jid),
              eq(tx.t.whatsappMessage.id, row.id),
            ),
          );
        out.rekeyed += 1;
      }
    });
  }
  return out;
}

export interface WhatsappSyncOpts {
  /** Bridge handle override (tests inject a fixture DB; runtime opens whatsapp_db_path read-only). */
  bridge?: Database | undefined;
  /** Ignore the cursor and pull from the start (still bounded by --max). */
  backfill?: boolean | undefined;
  /** Lower bound from a `--since` instant (ISO / YYYY-MM-DD / "-Nd"). Overrides the cursor. */
  since?: string | undefined;
  /** Lower bound as "the last N days". Overrides the cursor. */
  days?: number | undefined;
  /** Hard cap on messages ingested this run (default DEFAULT_MAX_MESSAGES). */
  max?: number | undefined;
  /**
   * Contacts DB override (the bridge's whatsapp.db) for the lid↔pn map used to canonicalize `@lid`
   * senders before person-enrichment (164). Tests inject a fixture; at runtime (no injected bridge) the
   * configured whatsapp.db is read. When a fixture bridge is injected without this, canonicalization is
   * skipped (empty map) so ingest tests stay hermetic and never touch a real DB.
   */
  contacts?: Database | undefined;
}

/** Resolve the effective lower bound (bridge timestamp compare): --since > --days > cursor (unless backfill). */
async function resolveLowerBound(store: Store, opts: WhatsappSyncOpts): Promise<string | null> {
  if (opts.since) return normalizeSince(opts.since);
  if (typeof opts.days === "number" && Number.isFinite(opts.days) && opts.days > 0) {
    return new Date(Date.now() - opts.days * 24 * 3600 * 1000).toISOString();
  }
  if (opts.backfill) return null;
  return getCursorFor(store, CURSOR_KEY);
}

/**
 * Ingest WhatsApp messages from the read-only bridge DB into whatsapp_message (+FTS + event mirror).
 * Bounded (--since/--days) and capped (--max); ordered oldest-first so a capped run advances the cursor
 * and the next run resumes. Idempotent on (chat_jid, id). The bridge handle is injectable (tests pass a
 * fixture DB and never touch a real bridge); at runtime it is opened read-only from whatsapp_db_path.
 */
export async function syncWhatsapp(
  store: Store,
  opts: WhatsappSyncOpts = {},
): Promise<WhatsappSyncResult> {
  const bridge = opts.bridge ?? (await openBridge(store));
  const ownsBridge = !opts.bridge;
  const max = opts.max && opts.max > 0 ? opts.max : DEFAULT_MAX_MESSAGES;
  const cursor = await getCursorFor(store, CURSOR_KEY);
  const lowerBound = await resolveLowerBound(store, opts);
  // lid↔pn map for `@lid` sender canonicalization (164). An injected `contacts` handle wins; else — only
  // on the runtime path (we opened the real bridge) — read the configured whatsapp.db. An injected bridge
  // without `contacts` keeps ingest tests hermetic (empty map ⇒ `@lid` senders stay unmapped, as before).
  const lidMap = opts.contacts
    ? await loadLidMap(store, { contacts: opts.contacts })
    : ownsBridge
      ? await loadLidMap(store)
      : new Map<string, string>();

  try {
    // 186a added `messages.status` to the bridge — but existing sync fixtures + any pre-186a bridge DB
    // have no such column, so read it DEFENSIVELY: project the real column only when it exists, else
    // NULL, so the SELECT never references a missing column and old bridges keep working.
    const bridgeCols = bridge.query("PRAGMA table_info(messages)").all() as { name: string }[];
    const bridgeHasStatus = bridgeCols.some((c) => c.name === "status");
    const statusSelect = bridgeHasStatus ? "m.status AS status" : "NULL AS status";
    // #50: the reacted-to message id lives in the bridge's `filename` column for reaction rows. Project
    // it DEFENSIVELY (a bridge/fixture without the column → NULL) so ingest can recover reaction targets.
    const bridgeHasFilename = bridgeCols.some((c) => c.name === "filename");
    const filenameSelect = bridgeHasFilename ? "m.filename AS filename" : "NULL AS filename";

    const params: (string | number)[] = [];
    let where = "";
    if (lowerBound) {
      where = "WHERE m.timestamp > ?";
      params.push(lowerBound);
    }
    params.push(max);

    const rows = bridge
      .query(
        `SELECT m.id AS id, m.chat_jid AS chat_jid, c.name AS chat_name, m.sender AS sender_jid,
                m.content AS content, m.timestamp AS timestamp, m.is_from_me AS is_from_me,
                m.media_type AS media_type, m.quoted_message_id AS quoted_message_id, ${statusSelect}, ${filenameSelect}
         FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         ${where}
         ORDER BY m.timestamp ASC
         LIMIT ?`,
      )
      .all(...params) as BridgeRow[];

    let ingested = 0;
    let maxTs = cursor;
    for (const r of rows) {
      const landed = await store.txn("record the whatsapp message", (tx) =>
        ingestMessage(tx, r, lidMap),
      );
      if (landed) ingested++;
      const ts = r.timestamp == null ? null : String(r.timestamp);
      // 1936: the high-water mark is the LATEST INSTANT, not the largest string. Bridge timestamps are
      // RFC3339 text, and text order is not time order across offsets (`2026-07-10T11:00:00+02:00` is
      // 09:00Z but sorts AFTER `2026-07-10T09:30:00Z`), so a string compare could stop the cursor short
      // and strand messages behind it. The RAW bridge value is still what gets stored: the SQL compare at
      // the select uses the bridge's own format, so the cursor must stay in it.
      if (ts && bridgeTsLaterThan(ts, maxTs)) maxTs = ts;
    }

    if (maxTs && maxTs !== cursor) await setCursorFor(store, CURSOR_KEY, maxTs);

    // Repair any `@lid` duplicates already stored (312). After the pass above, no NEW ones can appear;
    // this is what clears the ones that landed before the fix, and it is a no-op on a healthy store.
    const fold = await foldLidChats(store, lidMap);

    // 1936: the forward-only select above can never see a receipt that arrived after the cursor moved
    // past its message. Re-read the last 48h of outbound receipts and advance the rows already stored.
    // Bounded by time rather than by the cursor on purpose: it must NOT insert and must NOT move the
    // cursor, and it runs AFTER the fold so a pre-312 `@lid` row is found under its canonical key.
    if (bridgeHasStatus) await sweepReceipts(store, bridge, lidMap);

    return {
      messages: rows.length,
      ingested,
      events: ingested,
      capped: rows.length >= max,
      cursor: maxTs,
      folded: fold.removed + fold.rekeyed,
    };
  } finally {
    if (ownsBridge) bridge.close();
  }
}

/**
 * Sweep the bridge's outbound receipts for the last `RECEIPT_SWEEP_HOURS` and advance any row already
 * stored (1936). The cursor select walks forward by timestamp, so once the cursor passes a message the
 * receipt that arrives for it later is never re-read — which is why receipts "rarely" reached a stored
 * row. This pass never inserts (a receipt for a message we never stored is not ours to create) and never
 * moves the cursor; it only applies the same forward-only rule as `ingestMessage`.
 *
 * The lower bound is written in the bridge's own optional-fraction RFC3339 shape (the same `toISOString()`
 * that `--since`/`--days` pass through `resolveLowerBound`), so the string compare against the bridge's
 * own `messages.timestamp` column stays meaningful. A bridge without the 186a `status` column is skipped
 * by the caller.
 */
async function sweepReceipts(
  store: Store,
  bridge: Database,
  lidMap: Map<string, string>,
): Promise<void> {
  const since = new Date(Date.now() - RECEIPT_SWEEP_HOURS * 3600 * 1000).toISOString();
  // Every column here is already read by the forward select above (the caller only runs this when the
  // bridge HAS `status`), so there is no schema to defend against: a failure here is a real failure and
  // must surface. A quiet window costs one query and nothing else.
  const rows = bridge
    .query(
      `SELECT m.id AS id, m.chat_jid AS chat_jid, m.status AS status
       FROM messages m
       WHERE m.is_from_me = 1 AND m.status IS NOT NULL AND m.timestamp >= ?
       ORDER BY m.timestamp ASC`,
    )
    .all(since) as Array<{ id: string; chat_jid: string; status: string | null }>;
  if (rows.length === 0) return;

  // ONE read for the whole window rather than a lookup per receipt, and it goes through
  // `idx_whatsapp_message_ts`: filtering on the id list would scan, because no index leads with `id`
  // (the unique one is `(chat_jid, id)`). `ts` is stored `toISOString()`, the same shape as `since`.
  const storedRows = (await store.q
    .select({
      id: store.t.whatsappMessage.id,
      chat_jid: store.t.whatsappMessage.chat_jid,
      status: store.t.whatsappMessage.status,
      is_from_me: store.t.whatsappMessage.is_from_me,
    })
    .from(store.t.whatsappMessage)
    .where(
      and(
        eq(store.t.whatsappMessage.is_from_me, 1),
        gte(store.t.whatsappMessage.ts, since),
      ),
    )) as Array<{
    id: string;
    chat_jid: string;
    status: string | null;
    is_from_me: number | null;
  }>;
  const key = (chatJid: string, id: string) => `${chatJid}\u0000${id}`;
  const stored = new Map(storedRows.map((r) => [key(r.chat_jid, r.id), r]));

  for (const r of rows) {
    const chatJid = canonicalJid(r.chat_jid, lidMap);
    const found = stored.get(key(chatJid, r.id));
    if (!found) continue; // never insert: a stored row is the only thing a receipt may touch
    if (!receiptAdvances(found.status, readBool(found.is_from_me), r.status)) continue;
    await store.q
      .update(store.t.whatsappMessage)
      .set({ status: r.status })
      .where(and(eq(store.t.whatsappMessage.chat_jid, chatJid), eq(store.t.whatsappMessage.id, r.id)));
  }
}

/** How far a bridge row's timestamp may sit from the send instant and still be the message we just sent. */
const SENT_PICKUP_WINDOW_MS = 5000;

/**
 * Bridge `timestamp` → epoch millis, or null when it is absent or unparseable. Deliberately does NOT fall
 * back to "now" the way normalizeTs does: for the send-time pickup an unreadable timestamp must never
 * masquerade as "just sent" and drag in the wrong row. Pure.
 */
function bridgeTsMs(raw: string | number | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  const ms = Date.parse(String(raw));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Is `candidate` a LATER instant than `current` (1936)? Both are bridge timestamps; a value that does not
 * parse never replaces one that does, and when nothing is stored yet any parsed value wins. Pure.
 */
function bridgeTsLaterThan(candidate: string, current: string | null): boolean {
  const cMs = bridgeTsMs(candidate);
  if (cMs == null) return false;
  const curMs = current == null ? null : bridgeTsMs(current);
  if (curMs == null) return true;
  return cMs > curMs;
}

export interface JustSentOpts {
  /** The chat the message went to. Canonicalized here, so an `@lid` target still matches the stored row. */
  chatJid: string;
  /** The exact body that was sent — matched against the bridge row's content. */
  content: string;
  /** ob 1683: the `media_type` the bridge stores for a sent attachment (`image` | `document`); narrows the match. */
  mediaType?: string | undefined;
  /** `Date.now()` captured around the send; the centre of the match window. */
  sentAt: number;
  /** Bridge handle override (tests inject a fixture; runtime opens whatsapp_db_path read-only). */
  bridge?: Database | undefined;
  /** Contacts DB override (tests inject a fixture; runtime derives whatsapp_contacts_db_path). */
  contacts?: Database | undefined;
}

/**
 * Pick up the row the bridge has JUST written for a message ob sent, and ingest it exactly as sync would
 * (#120). The bridge's `POST /api/send` response carries no message id, but the bridge persists the
 * message into its own messages.db (with the real id) BEFORE it answers — so a read-only read straight
 * after a successful send recovers the TRUE bridge id, and the row ob stores carries the same
 * (chat_jid, id) the 60s sync will later see. It reuses `ingestMessage`, so the row, its FTS entry and its
 * event mirror are exactly what sync writes; the unique index then makes that later sync a no-op rather
 * than a duplicate, and because the id never changes it collapses onto the same bubble under the
 * dashboard's id-keyed thread merge.
 *
 * THE SAFETY VALVE: the match is deliberately narrow — the resolved chat jid, `is_from_me = 1`, an exact
 * content match, and a bridge timestamp within a few seconds of the send. When that is AMBIGUOUS (two
 * identical messages to the same chat inside the window) or finds NOTHING (bridge DB absent/unreadable,
 * clock skew, an unexpected timestamp format), it inserts NOTHING and returns null instead of guessing.
 * The 60s sync then backfills the row exactly as it does today, so the worst case is the delay we already
 * have — never a wrong id, never a second bubble. Never throws: a send must not fail over the pickup.
 *
 * Returns the bridge message id when a row was picked up, else null.
 */
export async function ingestJustSentMessage(
  store: Store,
  opts: JustSentOpts,
): Promise<string | null> {
  const ownsBridge = !opts.bridge;
  let bridge: Database | null = null;
  try {
    bridge = opts.bridge ?? (await openBridge(store));
    const lidMap = opts.contacts
      ? await loadLidMap(store, { contacts: opts.contacts })
      : ownsBridge
        ? await loadLidMap(store)
        : new Map<string, string>();
    // The bridge stores an outbound message under the PHONE jid (its resolveUserJID maps `@lid` → pn and
    // leaves groups/phone-jids untouched), so match on the canonical jid or an `@lid` target never matches.
    const target = canonicalJid(opts.chatJid, lidMap);

    // Same defensive projection as syncWhatsapp: a pre-186a bridge has no `status`, and `filename` (the
    // reaction target, #50) may be absent too — project NULL rather than reference a missing column.
    const bridgeCols = bridge.query("PRAGMA table_info(messages)").all() as { name: string }[];
    const statusSelect = bridgeCols.some((c) => c.name === "status")
      ? "m.status AS status"
      : "NULL AS status";
    const filenameSelect = bridgeCols.some((c) => c.name === "filename")
      ? "m.filename AS filename"
      : "NULL AS filename";

    const candidates = bridge
      .query(
        `SELECT m.id AS id, m.chat_jid AS chat_jid, c.name AS chat_name, m.sender AS sender_jid,
                m.content AS content, m.timestamp AS timestamp, m.is_from_me AS is_from_me,
                m.media_type AS media_type, m.quoted_message_id AS quoted_message_id, ${statusSelect}, ${filenameSelect}
         FROM messages m
         LEFT JOIN chats c ON c.jid = m.chat_jid
         WHERE m.chat_jid = ? AND m.is_from_me = 1 AND COALESCE(m.content, '') = ?
           ${opts.mediaType ? "AND m.media_type = ?" : ""}
         ORDER BY m.timestamp DESC
         LIMIT 3`,
      )
      .all(target, opts.content, ...(opts.mediaType ? [opts.mediaType] : [])) as BridgeRow[];

    const inWindow = candidates.filter((r) => {
      const ms = bridgeTsMs(r.timestamp);
      return ms != null && Math.abs(ms - opts.sentAt) <= SENT_PICKUP_WINDOW_MS;
    });
    // 0 = not found, >1 = ambiguous. Either way insert nothing and let the 60s sync backfill it.
    if (inWindow.length !== 1) return null;

    const row = inWindow[0]!;
    await store.txn("record the whatsapp message", (tx) => ingestMessage(tx, row, lidMap));
    return row.id;
  } catch {
    return null; // the pickup is best-effort: an unreadable bridge degrades to today's sync-only behaviour
  } finally {
    if (bridge && ownsBridge) bridge.close();
  }
}

// ── read side ────────────────────────────────────────────────────────────────────────────────────

export interface WhatsappHit {
  id: string;
  chat_jid: string;
  chat_name: string | null;
  sender_jid: string | null;
  content: string | null;
  ts: string | null;
  is_from_me: number | null;
  person_id: number | null;
  media_type: string | null;
  quoted_message_id: string | null; // reply target; for a reaction (media_type="reaction") the reacted-to id (#50)
  transcript: string | null;
  status: string | null; // bridge receipt (186b): sent | delivered | read | played; NULL = inbound or pre-1936
  media_desc: string | null; // cached vision description of an image (198b); null until described
}

const HIT_COLUMNS = (t: Store["t"]) =>
  ({
    id: t.whatsappMessage.id,
    chat_jid: t.whatsappMessage.chat_jid,
    chat_name: t.whatsappMessage.chat_name,
    sender_jid: t.whatsappMessage.sender_jid,
    content: t.whatsappMessage.content,
    ts: t.whatsappMessage.ts,
    is_from_me: t.whatsappMessage.is_from_me,
    person_id: t.whatsappMessage.person_id,
    media_type: t.whatsappMessage.media_type,
    quoted_message_id: t.whatsappMessage.quoted_message_id,
    transcript: t.whatsappMessage.transcript,
    status: t.whatsappMessage.status,
    media_desc: t.whatsappMessage.media_desc,
  }) as const;

/**
 * Search ingested WhatsApp message content.
 *
 * ob 322's translator against the `search_vec` tsvector column, with the pg_trgm substring clause running
 * only when the word match found nothing. 336: the haystack is content + transcript + media_desc, so a
 * voice note or an image description is searchable the same way typed text is.
 *
 * `ts` is NOT NULL on this table, so the DESC ordering has no nullable column for Postgres to sort NULLS
 * FIRST; `id` breaks ties.
 */
export async function searchWhatsapp(
  store: Store,
  query: string,
  limit = 20,
): Promise<WhatsappHit[]> {
  const { whatsappSearch, runSearch } = await import("../../../../apps/cli/src/db/pg/search.ts");
  return runSearch(whatsappSearch(query), (where) =>
    store.q
      .select(HIT_COLUMNS(store.t))
      .from(store.t.whatsappMessage)
      .where(where)
      .orderBy(desc(store.t.whatsappMessage.ts), desc(store.t.whatsappMessage.id))
      .limit(limit),
  ) as Promise<WhatsappHit[]>;
}

/**
 * One rendered thread message (168): a WhatsappHit plus a resolved author `sender` label and a compact
 * `preview`. `sender` is "you" for outbound, else the resolved person / whatsmeow-contact name, else the
 * chat name, else a shortened jid — never a raw phone number. `chat_jid` carries the CANONICAL jid.
 */
export interface ThreadItem extends WhatsappHit {
  /** Author label: "you" (outbound) → resolved name → chat_name → shortened jid. */
  sender: string;
  /** Truncated single-line preview of the content (null for media / empty bodies). */
  preview: string | null;
}

export interface ThreadForChatOpts {
  /** Max messages returned (the most-recent window). Defaults to 20. */
  limit?: number;
  /** Paging cursor (193): return only messages STRICTLY OLDER than this ts (keyset "load earlier"). */
  before?: string;
  /** Contacts DB override (tests inject a fixture; runtime derives whatsapp_contacts_db_path). */
  contacts?: Database;
}

/** A single page of a chat thread (193): the batch (oldest → newest) plus whether older messages remain. */
export interface ThreadPage {
  items: ThreadItem[];
  /** True when messages older than the oldest returned still exist — the "load earlier" button stays. */
  hasMore: boolean;
}

/** Collapse window: identical copies of one message under a phone-jid + its `@lid` land within ~1s (174). */
const THREAD_DEDUP_WINDOW_MS = 1000;

/**
 * Neutral label for a group message with no attributable sender — an empty sender, or a `sender_jid`
 * that is the GROUP's own jid (196). Rendered instead of the raw group id, which is not a person.
 */
const GROUP_UNKNOWN_SENDER = "unknown";

/** Normalize a body for dup comparison: trim + collapse internal whitespace runs to a single space. Pure. */
function normalizeForDedup(content: string | null): string {
  return (content ?? "").trim().replace(/\s+/g, " ");
}

/**
 * Dedupe the phone-jid + `@lid` copies WhatsApp logs of the SAME message within a unified thread (174).
 * Two rows collapse only when they share `is_from_me`, fall within ~1s of each other, AND are the same
 * message — either the same bridge `id` (covers media with empty bodies) or the same NON-EMPTY normalized
 * `content`. The survivor is the preferred copy: one whose sender resolves to a real name, then the
 * phone-jid over the `@lid`. Genuinely-distinct messages (different content/id, or > ~1s apart) are never
 * collapsed. Survivors keep their input order. Pure aside from the injected name-resolution probe.
 */
function dedupeThreadRows(
  rows: WhatsappHit[],
  senderResolvesName: (m: WhatsappHit) => boolean,
): WhatsappHit[] {
  const isLid = (m: WhatsappHit) =>
    (m.sender_jid ?? "").endsWith("@lid") || m.chat_jid.endsWith("@lid");
  // Prefer a name-resolved sender (2), then the phone-jid over the @lid copy (1).
  const score = (m: WhatsappHit) => (senderResolvesName(m) ? 2 : 0) + (isLid(m) ? 0 : 1);

  const kept: WhatsappHit[] = [];
  for (const r of rows) {
    const rMs = Date.parse(r.ts ?? "");
    const rNorm = normalizeForDedup(r.content);
    const idx = kept.findIndex((k) => {
      if (k.is_from_me !== r.is_from_me) return false;
      const kMs = Date.parse(k.ts ?? "");
      const within =
        Number.isNaN(rMs) || Number.isNaN(kMs)
          ? (k.ts ?? "") === (r.ts ?? "") // unparseable ts → require an exact string match
          : Math.abs(kMs - rMs) <= THREAD_DEDUP_WINDOW_MS;
      if (!within) return false;
      return k.id === r.id || (rNorm !== "" && rNorm === normalizeForDedup(k.content));
    });
    if (idx === -1) kept.push(r);
    else if (score(r) > score(kept[idx]!)) kept[idx] = r; // swap in the preferred copy, keep its slot
  }
  return kept;
}

/**
 * The recent thread for a single chat, ordered OLDEST → NEWEST (chronological, ready to render as a
 * transcript). Fetches the most-recent `limit` rows then reverses, so a long history stays bounded.
 * Backs BOTH the Claude-suggested-reply context (104) and the dashboard thread panel (168).
 *
 * The `chatJid` is CANONICALIZED (164): an `@lid` privacy-id chat and its `<phone>@s.whatsapp.net` chat
 * are unified — every raw chat_jid that canonicalizes to the same target is pulled into one thread, and
 * every returned row carries the canonical `chat_jid`. Each row also carries a resolved `sender` label
 * ("you" for outbound, else the person/contact/chat name) and a compact `preview`. An unknown chat (no
 * matching messages) returns []. Names resolve read-only from the person registry + whatsmeow contacts;
 * an absent contacts DB degrades gracefully (chat_name / shortened jid), never a crash.
 *
 * 193: a `before` cursor pages UPWARD — the returned batch is the newest `limit` messages STRICTLY older
 * than `before` (the oldest currently-loaded message's ts), and `hasMore` reports whether even-older
 * messages remain so the "load earlier" button can stay. Omitting `before` returns the most-recent window.
 */
export async function threadPageForChat(
  store: Store,
  chatJid: string,
  opts: ThreadForChatOpts = {},
): Promise<ThreadPage> {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 20;

  // One shared read-only handle to the bridge's whatsapp.db → the lid↔pn map + contact names (both
  // graceful when absent). Opened once; an injected handle (tests) is left open for the caller.
  const injectedContacts = opts.contacts;
  const handle = injectedContacts ?? (await openContactsDb(store));
  const lidMap = handle ? await loadLidMap(store, { contacts: handle }) : new Map<string, string>();
  const contactNames = handle
    ? await loadContactNames(store, { contacts: handle })
    : new Map<string, string>();
  if (handle && !injectedContacts) handle.close();

  // The canonical target. Collect every RAW chat_jid that canonicalizes to it (so an @lid chat and its
  // phone-jid chat are one unified thread), excluding non-conversation jids (Status / broadcast, 175 —
  // so a `@broadcast` target also yields no thread). Then read the most-recent rows across all of them.
  const target = canonicalJid(chatJid, lidMap);
  const distinct = (await store.q
    .selectDistinct({ chat_jid: store.t.whatsappMessage.chat_jid })
    .from(store.t.whatsappMessage)) as { chat_jid: string }[];
  const rawJids = distinct
    .map((d) => d.chat_jid)
    .filter((j) => isConversationJid(j) && canonicalJid(j, lidMap) === target);
  if (rawJids.length === 0) return { items: [], hasMore: false };

  // Over-fetch the window (2×limit) so identical phone-jid + `@lid` copies of the same message (174) can
  // be deduped down to one BEFORE the `limit` slice — a message duplicated at most once per jid pair is
  // fully absorbed by the 2× headroom while the read stays bounded. 193: when paging up, only rows
  // strictly older than the `before` cursor are in scope.
  const inScope = opts.before
    ? and(
        inArray(store.t.whatsappMessage.chat_jid, rawJids),
        lt(store.t.whatsappMessage.ts, opts.before),
      )
    : inArray(store.t.whatsappMessage.chat_jid, rawJids);
  // `ts` is NOT NULL on this table, so this DESC ordering has no nullable column for Postgres to sort
  // NULLS FIRST; `id` breaks ties so the 2x over-fetch window is stable between runs.
  const rows = (await store.q
    .select(HIT_COLUMNS(store.t))
    .from(store.t.whatsappMessage)
    .where(inScope)
    .orderBy(desc(store.t.whatsappMessage.ts), desc(store.t.whatsappMessage.id))
    .limit(limit * 2)) as WhatsappHit[];

  // Name sources: the person registry (by id, and by canonical whatsapp_jid) + whatsmeow contacts.
  const persons = await listPersonsFor(store);
  const nameById = new Map(persons.map((p) => [p.id, p.real_name]));
  const nameByJid = new Map(
    persons.filter((p) => p.whatsapp_jid).map((p) => [p.whatsapp_jid as string, p.real_name]),
  );

  /** True when a row's (inbound) sender resolves to a real person/contact name — not a jid fallback. */
  const senderResolvesName = (m: WhatsappHit): boolean => {
    if (m.person_id != null && nameById.has(m.person_id)) return true;
    const canonSender = m.sender_jid ? canonicalJid(m.sender_jid, lidMap) : null;
    if (canonSender) {
      if (nameByJid.get(canonSender)?.trim()) return true;
      if (contactNames.get(canonSender)?.trim()) return true;
    }
    return false;
  };

  const deduped = dedupeThreadRows(rows, senderResolvesName);
  deduped.reverse(); // rows arrive newest-first; slice keeps the newest, then oldest → newest for render
  const windowed = deduped.slice(-limit);

  // Resolve EACH message's author from its OWN sender_jid (192). In a group (`@g.us`) the per-message
  // sender_jid is the PARTICIPANT (≠ chat_jid), so this labels every message with its actual sender —
  // person real_name → registered whatsapp_jid → whatsmeow contact/pushname → shortened sender jid. The
  // crucial group fix: NEVER fall back to `chat_name` for a group, because there chat_name is the GROUP
  // name (not the sender) — an unresolved participant shows their short jid instead. 1:1 chats keep the
  // chat_name fallback (there chat_name IS the single contact).
  const senderLabel = (m: WhatsappHit): string => {
    if (readBool(m.is_from_me)) return "you";
    if (m.person_id != null && nameById.has(m.person_id)) return nameById.get(m.person_id)!;
    const canonSender = m.sender_jid ? canonicalJid(m.sender_jid, lidMap) : null;
    if (canonSender) {
      const byJid = nameByJid.get(canonSender);
      if (byJid?.trim()) return byJid.trim();
      const contact = contactNames.get(canonSender);
      if (contact?.trim()) return contact.trim();
    }
    if (m.chat_jid.endsWith("@g.us")) {
      // 196: a group message whose sender is empty, or is the GROUP's OWN jid (the bridge logs the group
      // id as the sender for some system/older rows), is UNATTRIBUTABLE — never render the raw group id as
      // a person. Compare on the local part (shortJid) so it matches whether or not the group suffix is
      // present. Otherwise fall back to the participant's short jid (an unmapped @lid stays a person id).
      if (!m.sender_jid || shortJid(m.sender_jid) === shortJid(m.chat_jid)) return GROUP_UNKNOWN_SENDER;
      return shortJid(m.sender_jid);
    }
    return m.chat_name?.trim() || shortJid(m.sender_jid ?? m.chat_jid);
  };

  // hasMore (193): does even one message older than the oldest returned still exist? A cheap keyset
  // existence probe (LIMIT 1), scoped to the same unified raw jids — false once the history is exhausted,
  // so the "load earlier" button hides. An empty window (nothing older than `before`) reports false.
  const oldestTs = windowed[0]?.ts ?? null;
  const older =
    oldestTs == null
      ? []
      : ((await store.q
          .select({ id: store.t.whatsappMessage.id })
          .from(store.t.whatsappMessage)
          .where(
            and(
              inArray(store.t.whatsappMessage.chat_jid, rawJids),
              lt(store.t.whatsappMessage.ts, oldestTs),
            ),
          )
          .limit(1)) as Array<{ id: string }>);
  const hasMore = older.length > 0;

  const items = windowed.map((m) => ({
    ...m,
    chat_jid: target, // every row carries the canonical jid (Reply / media proxy target)
    sender: senderLabel(m),
    preview: messagePreview(m.content),
  }));
  return { items, hasMore };
}

/**
 * Backward-compatible view over {@link threadPageForChat}: just the batch (oldest → newest), dropping the
 * paging metadata. Backs the Claude-suggested-reply context (104), which needs only the messages.
 */
export async function threadForChat(
  store: Store,
  chatJid: string,
  opts: ThreadForChatOpts = {},
): Promise<ThreadItem[]> {
  return (await threadPageForChat(store, chatJid, opts)).items;
}

/** Most-recent ingested WhatsApp messages (optionally within a [since, until] window). */
export async function recentWhatsapp(
  store: Store,
  opts: { since?: string | undefined; until?: string | undefined; limit?: number | undefined } = {},
): Promise<WhatsappHit[]> {
  const conds = [];
  if (opts.since) conds.push(gte(store.t.whatsappMessage.ts, opts.since));
  if (opts.until) conds.push(lte(store.t.whatsappMessage.ts, opts.until));
  return (await store.q
    .select(HIT_COLUMNS(store.t))
    .from(store.t.whatsappMessage)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(store.t.whatsappMessage.ts), desc(store.t.whatsappMessage.id))
    .limit(opts.limit ?? 20)) as WhatsappHit[];
}

// ── chat-list (156): latest-per-chat + resolved contact names ──────────────────────────────────────
// The dashboard's WhatsApp surface is a chat-list (one row per chat, WhatsApp-home style), not a flat
// message stream. Names are resolved read-only from TWO sources: our own `person` registry (a mapped
// whatsapp_jid → real_name) and, as the big win, the bridge's OWN `whatsapp.db` contacts table
// (`whatsmeow_contacts`, sibling of messages.db) — 350+ contacts already carry a push/full name there,
// so no manual mapping is needed. Both reads are READ-ONLY + WAL-safe (mirror the messages.db read);
// the contacts DB being absent/locked/schema-less degrades gracefully to chat_name/jid — never a crash.

const PREVIEW_MAX = 200;

/** Truncate a message body to a compact single-value preview. Pure. */
export function messagePreview(content: string | null): string | null {
  if (content == null) return null;
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (trimmed.length <= PREVIEW_MAX) return trimmed;
  return trimmed.slice(0, PREVIEW_MAX - 1).trimEnd() + "…";
}

/** The chat/local part of a jid ("2782…@s.whatsapp.net" → "2782…"). A last-resort label. Pure. */
export function shortJid(jid: string): string {
  return jid.split("@")[0] || jid;
}

/**
 * The BARE local part of a jid — the phone/id before any `:device` suffix AND the `@server`
 * ("27…:12@s.whatsapp.net" → "27…"). Used to compare an account's own jid (which may carry a device
 * suffix) against a plain chat jid. Pure.
 */
export function jidLocalPart(jid: string): string {
  const local = jid.split("@")[0] ?? jid;
  return local.split(":")[0] ?? local;
}

/**
 * Is this jid a real conversation (175)? WhatsApp Status (`status@broadcast`) and broadcast lists are
 * logged as chats but aren't conversations — any jid ending in `@broadcast` is excluded from the feed +
 * thread view (read-side only; the rows stay ingested). Groups (`@g.us`), phone-jids
 * (`@s.whatsapp.net`) and privacy ids (`@lid`) are all real conversations. Pure.
 */
export function isConversationJid(jid: string): boolean {
  return !jid.endsWith("@broadcast");
}

/** One `whatsmeow_contacts` row (the bridge's own address book, sibling of messages.db). */
interface WhatsmeowContact {
  their_jid: string;
  first_name: string | null;
  full_name: string | null;
  push_name: string | null;
  business_name: string | null;
}

/** Pick the best whatsmeow contact name: full_name → push_name → business_name → first_name. Pure. */
function pickContactName(c: WhatsmeowContact): string | null {
  return (
    c.full_name?.trim() ||
    c.push_name?.trim() ||
    c.business_name?.trim() ||
    c.first_name?.trim() ||
    null
  );
}

/** Resolve the contacts DB path: the explicit config, else the `whatsapp.db` sibling of whatsapp_db_path. */
async function contactsDbPath(store: Store): Promise<string> {
  const explicit = (await settingFor(store, "whatsapp_contacts_db_path")).trim();
  if (explicit) return expandHome(explicit);
  const msgPath = expandHome(await settingFor(store, "whatsapp_db_path"));
  return join(dirname(msgPath), "whatsapp.db");
}

/** Open the bridge's `whatsapp.db` (contacts + lid map) READ-ONLY. Returns null if absent/unopenable. */
async function openContactsDb(store: Store): Promise<Database | null> {
  const path = await contactsDbPath(store);
  if (!existsSync(path)) return null; // bridge contacts DB not present → caller degrades gracefully
  try {
    return new Database(path, { readonly: true });
  } catch {
    return null;
  }
}

/**
 * Build a `their_jid → display name` map from the bridge's `whatsmeow_contacts` table, READ-ONLY. The
 * handle is injectable (tests pass a fixture; runtime opens whatsapp_contacts_db_path read-only). If the
 * DB is absent, unopenable, or missing the table, returns an empty/partial map — never throws (name
 * resolution then falls back to chat_name/jid).
 */
export async function loadContactNames(
  store: Store,
  opts: { contacts?: Database } = {},
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const injected = opts.contacts;
  const handle = injected ?? (await openContactsDb(store));
  if (!handle) return map; // bridge contacts DB not present → graceful empty map
  try {
    const rows = handle
      .query(
        `SELECT their_jid, first_name, full_name, push_name, business_name FROM whatsmeow_contacts`,
      )
      .all() as WhatsmeowContact[];
    for (const r of rows) {
      const name = pickContactName(r);
      if (r.their_jid && name) map.set(r.their_jid, name);
    }
  } catch {
    // table absent / unreadable → keep whatever we have (possibly empty); never crash
  } finally {
    if (!injected) handle.close();
  }
  return map;
}

/** One `whatsmeow_lid_map` row — the bridge's LID (privacy id) ↔ phone-number index (164). */
interface WhatsmeowLidRow {
  lid: string | null;
  pn: string | null;
}

/**
 * Build a `lid → phone-number` map (both stored as bare local parts) from the bridge's
 * `whatsmeow_lid_map` table, READ-ONLY. Same graceful contract as loadContactNames: an absent DB, an
 * unopenable handle, or a missing table yields an empty map — never throws. Values are normalised to the
 * local part (any `@…` server suffix stripped) so canonicalJid can rebuild the phone-jid regardless of
 * whether the bridge stores bare numbers or full jids.
 */
export async function loadLidMap(
  store: Store,
  opts: { contacts?: Database } = {},
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const injected = opts.contacts;
  const handle = injected ?? (await openContactsDb(store));
  if (!handle) return map;
  try {
    const rows = handle.query(`SELECT lid, pn FROM whatsmeow_lid_map`).all() as WhatsmeowLidRow[];
    for (const r of rows) {
      if (!r.lid || !r.pn) continue;
      const lidLocal = String(r.lid).split("@")[0];
      const pnLocal = String(r.pn).split("@")[0];
      if (lidLocal && pnLocal) map.set(lidLocal, pnLocal);
    }
  } catch {
    // table absent / unreadable → empty map; @lid jids simply stay uncanonicalized (as before 164)
  } finally {
    if (!injected) handle.close();
  }
  return map;
}

/**
 * Canonicalize a jid so a contact's `<lid>@lid` privacy-id and their `<phone>@s.whatsapp.net` jid resolve
 * to the SAME key. For a `@lid` jid, look up its local part in the lid map → if found, return
 * `<pn>@s.whatsapp.net`; otherwise (unmapped @lid, or any non-@lid jid) return the jid unchanged. Pure.
 */
export function canonicalJid(chatJid: string, lidMap: Map<string, string>): string {
  if (!chatJid.endsWith("@lid")) return chatJid;
  const lidLocal = chatJid.slice(0, -"@lid".length);
  const pn = lidMap.get(lidLocal);
  return pn ? `${pn}@s.whatsapp.net` : chatJid;
}

/**
 * The account owner's OWN jid local part(s) — read from the bridge's `whatsmeow_contacts.our_jid` column
 * (every contact row records which account it belongs to). This is how ob knows "my own number" WITHOUT a
 * hand-set config: the Note-to-Self chat (chat_jid == the owner's own jid) is dropped from the journal by
 * matching its canonical jid against this set (see isSelfChat). READ-ONLY, injectable (tests pass a
 * fixture), and GRACEFUL — an absent/unreadable contacts DB, or a bridge with no such table/column,
 * yields an EMPTY set (nothing is treated as self), never a throw. Values are normalised to the bare local
 * part (jidLocalPart) so an owner device-jid (`27…:12@s.whatsapp.net`) still matches the Note-to-Self chat
 * jid (`27…@s.whatsapp.net`).
 */
export async function loadOwnJids(
  store: Store,
  opts: { contacts?: Database } = {},
): Promise<Set<string>> {
  const out = new Set<string>();
  const injected = opts.contacts;
  const handle = injected ?? (await openContactsDb(store));
  if (!handle) return out;
  try {
    const rows = handle
      .query(`SELECT DISTINCT our_jid FROM whatsmeow_contacts`)
      .all() as { our_jid: string | null }[];
    for (const r of rows) {
      const local = r.our_jid ? jidLocalPart(r.our_jid) : "";
      if (local) out.add(local);
    }
  } catch {
    // table/column absent or unreadable → empty set; nothing is treated as self (graceful)
  } finally {
    if (!injected) handle.close();
  }
  return out;
}

/**
 * Is this chat the account owner's own Note-to-Self chat (205)? True ONLY when it is a 1:1 (never a group)
 * whose CANONICAL jid's local part is one of the owner's own jids (loadOwnJids). An empty owner set (the
 * owner couldn't be identified — no contacts DB) yields false, so nothing is dropped when we don't know.
 * Because it matches ONLY the chat whose id IS my own number, a real 1:1 where I merely sent unanswered
 * messages (that partner's jid, never mine) is NEVER mistaken for Note-to-Self. Pure.
 */
export function isSelfChat(
  chatJid: string,
  lidMap: Map<string, string>,
  ownJids: Set<string>,
): boolean {
  if (chatJid.endsWith("@g.us")) return false;
  if (ownJids.size === 0) return false;
  return ownJids.has(jidLocalPart(canonicalJid(chatJid, lidMap)));
}

/**
 * Resolve a chat's display label. Order: person.real_name → whatsmeow contact (full/push/business/first,
 * already collapsed into `contactName`) → messages.db chat_name → shortened jid. Groups (`@g.us`) prefer
 * their chat_name (the group name). Pure.
 */
export function resolveChatName(a: {
  chatJid: string;
  chatName: string | null;
  personName: string | null;
  contactName: string | null;
}): string {
  const isGroup = a.chatJid.endsWith("@g.us");
  if (isGroup) return a.chatName?.trim() || shortJid(a.chatJid);
  return (
    a.personName?.trim() ||
    a.contactName?.trim() ||
    a.chatName?.trim() ||
    shortJid(a.chatJid)
  );
}

/** One chat-list row (the latest message per chat, with the resolved display name). */
export interface WhatsappChatItem {
  chat_jid: string;
  name: string; // resolved display name (person > whatsmeow contact > chat_name > jid)
  preview: string | null; // truncated last-message preview (null for media / empty bodies)
  ts: string | null; // last-message timestamp
  is_from_me: number; // 1 when the last message was outbound (from me), else 0
  person_id: number | null; // the chat partner's person id (1:1 chats), else null
  id: string; // the latest message's bridge id — the media proxy / transcribe key (with chat_jid)
  media_type: string | null; // "image" | "sticker" | "audio" | "reaction" | ... when the latest message is media (158/162)
  media_desc: string | null; // cached vision description of an image (198b), when the latest message is an image; else null
  transcript: string | null; // a voice note's stored transcript (158), when transcribed; else null
  status: string | null; // latest message's receipt (186b): sent | delivered | read | played; NULL = inbound or pre-1936
  hidden: boolean; // per-chat pref (169): this chat is hidden from the feed (only present when includeHidden)
  ai_disabled: boolean; // per-chat pref (169): AI-suggested replies are disabled for this chat
  favorite: boolean; // per-chat pref (190a): this chat is a favourite — the feed shows favourites-first
}

export interface LatestPerChatOpts {
  /** Max chats returned (newest-active first). */
  limit?: number | undefined;
  /** Contacts DB override (tests inject a fixture; runtime derives whatsapp_contacts_db_path). */
  contacts?: Database | undefined;
  /** Include chats marked hidden (169). Default false — hidden chats are excluded from the feed. */
  includeHidden?: boolean | undefined;
}

/**
 * The most-recent ingested message PER `chat_jid` (one row per chat), newest chat first, bounded by
 * `limit`. Each row carries the resolved chat name (see resolveChatName) + preview + ts + is_from_me.
 * Names come from the `person` registry (partner jid → real_name) and the bridge's whatsmeow contacts.
 */
export async function latestPerChat(
  store: Store,
  opts: LatestPerChatOpts = {},
): Promise<WhatsappChatItem[]> {
  const limit = opts.limit ?? 50;

  // Latest ts per RAW chat_jid, then join back to the row carrying that ts (one row per stored chat_jid).
  // We merge raw chats to their canonical jid AFTER this read (164), so the `limit` is applied post-merge
  // — the collapse never shrinks the list below `limit` while distinct chats remain.
  // `max(ts)` over a TEXT column, so it comes back as text on both drivers and needs no readNumber --
  // that coercion is for numeric aggregates, and getting it wrong the other way (Number() on an ISO
  // string) would produce NaN rather than a wrong-looking number.
  const latest = store.q
    .select({
      chat_jid: store.t.whatsappMessage.chat_jid,
      mts: max(store.t.whatsappMessage.ts).as("mts"),
    })
    .from(store.t.whatsappMessage)
    .groupBy(store.t.whatsappMessage.chat_jid)
    .as("latest");

  const rows = (await store.q
    .select(HIT_COLUMNS(store.t))
    .from(store.t.whatsappMessage)
    .innerJoin(
      latest,
      and(
        eq(store.t.whatsappMessage.chat_jid, latest.chat_jid),
        eq(store.t.whatsappMessage.ts, latest.mts),
      ),
    )
    .orderBy(desc(store.t.whatsappMessage.ts), desc(store.t.whatsappMessage.id))) as WhatsappHit[];

  // One shared read-only handle to the bridge's whatsapp.db → contact names + the lid↔pn map (both
  // graceful when absent). Opened once here; the injected handle (tests) is left open for the caller.
  const injectedContacts = opts.contacts;
  const handle = injectedContacts ?? (await openContactsDb(store));
  const contactNames = handle
    ? await loadContactNames(store, { contacts: handle })
    : new Map<string, string>();
  const lidMap = handle ? await loadLidMap(store, { contacts: handle }) : new Map<string, string>();
  if (handle && !injectedContacts) handle.close();

  // Name source: the partner's registered person, looked up by the CANONICAL jid.
  const personByJid = new Map(
    (await listPersonsFor(store))
      .filter((p) => p.whatsapp_jid)
      .map((p) => [p.whatsapp_jid as string, p]),
  );

  // Merge raw chats that canonicalize to the same jid (an `@lid` row + its `<phone>@s.whatsapp.net` row)
  // into ONE canonical chat, keeping the newest message across both. Rows arrive newest-first, so the
  // first row seen for a canonical jid is already its latest — but compare ts explicitly to be safe.
  const byCanonical = new Map<string, WhatsappHit>();
  for (const r of rows) {
    if (!isConversationJid(r.chat_jid)) continue; // drop Status / broadcast from the feed (175)
    const canon = canonicalJid(r.chat_jid, lidMap);
    const prev = byCanonical.get(canon);
    if (!prev || (r.ts ?? "") > (prev.ts ?? "")) {
      byCanonical.set(canon, { ...r, chat_jid: canon }); // carry the canonical jid (Reply → phone-jid)
    }
  }

  // Per-chat prefs (169): keyed by the CANONICAL jid, so lookup is by the merged chat's canonical key.
  // A hidden chat is dropped from the feed BEFORE the `limit` slice (so hiding never shrinks the visible
  // list below `limit` while other chats remain), unless includeHidden is set (the "show hidden" toggle).
  // hidden / ai_disabled / favorite are plain `integer` flag columns. They are decoded through readBool
  // rather than left as raw values and tested with `!!`: a driver that hands an integer back as a string
  // makes `!!"0"` TRUE, which would silently hide nothing and favourite everything.
  const prefRows = (await store.q
    .select({
      chat_jid: store.t.whatsappChatPref.chat_jid,
      hidden: store.t.whatsappChatPref.hidden,
      ai_disabled: store.t.whatsappChatPref.ai_disabled,
      favorite: store.t.whatsappChatPref.favorite,
    })
    .from(store.t.whatsappChatPref)) as Array<{
    chat_jid: string;
    hidden: number | boolean | null;
    ai_disabled: number | boolean | null;
    favorite: number | boolean | null;
  }>;
  const prefByJid = new Map(
    prefRows.map((p) => [
      p.chat_jid,
      {
        chat_jid: p.chat_jid,
        hidden: readBool(p.hidden),
        ai_disabled: readBool(p.ai_disabled),
        favorite: readBool(p.favorite),
      },
    ]),
  );

  const sorted = [...byCanonical.values()].sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
  const visible = opts.includeHidden
    ? sorted
    : sorted.filter((r) => !prefByJid.get(r.chat_jid)?.hidden);
  const merged = visible.slice(0, limit);

  const out: WhatsappChatItem[] = [];
  for (const r of merged) {
    const isGroup = r.chat_jid.endsWith("@g.us");
    const partner = isGroup ? null : (personByJid.get(r.chat_jid) ?? null);
    const name = resolveChatName({
      chatJid: r.chat_jid,
      chatName: r.chat_name,
      personName: partner?.real_name ?? null,
      contactName: contactNames.get(r.chat_jid) ?? null,
    });
    const pref = prefByJid.get(r.chat_jid);
    out.push({
      chat_jid: r.chat_jid,
      name,
      preview: messagePreview(r.content),
      ts: r.ts,
      is_from_me: readBool(r.is_from_me) ? 1 : 0,
      person_id: partner?.id ?? null,
      id: r.id,
      media_type: r.media_type ?? null,
      media_desc: r.media_desc ?? null,
      transcript: r.transcript ?? null,
      status: r.status ?? null,
      hidden: pref?.hidden ?? false,
      ai_disabled: pref?.ai_disabled ?? false,
      favorite: pref?.favorite ?? false,
    });
  }
  return out;
}

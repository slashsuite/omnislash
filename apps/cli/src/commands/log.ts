import type { Database } from "bun:sqlite";
import { itemArg, type Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print } from "../output.ts";
import { recordEventFor, eventsBetweenFor, parsePayload, nowIso, type EventRow } from "../events.ts";
import { getCursorFor } from "../settings.ts";
import type { Store } from "../db/store.ts";

// Standup journal (038): the ⚪ Comments / Pitchforks / Suggestions / Recommendations /
// Recognition field, captured through `ob log` as source=journal events on the event table.

export const JOURNAL_SOURCE = "journal";
export const JOURNAL_TYPES = ["kudos", "suggestion", "comment"] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];

// kudos first (recognition — the report-readable one), then suggestion, then comment.
const TYPE_ORDER: Record<JournalType, number> = { kudos: 0, suggestion: 1, comment: 2 };

export interface JournalEntry {
  ts: string;
  type: JournalType;
  text: string;
  about: string | null;
  itemId: string | null;
}

export function isJournalType(s: string): s is JournalType {
  return (JOURNAL_TYPES as readonly string[]).includes(s);
}

/**
 * Record a journal entry as a source=journal event. `about` is stored raw (resolved at read).
 *
 * 337: takes `Database | Store` and awaits, so `ob log` is servable from Postgres. The `await` on
 * recordEventFor is load-bearing rather than stylistic -- a discarded promise here typechecks, exits 0
 * and writes nothing, which is exactly how pass 1 silently broke `ob tag`.
 */
export async function logEntry(
  db: Database | Store,
  entry: { type: JournalType; text: string; about?: string | null; itemId?: string | null; ts?: string },
): Promise<JournalEntry> {
  const ts = entry.ts ?? nowIso();
  await recordEventFor(db, {
    ts,
    source: JOURNAL_SOURCE,
    type: entry.type,
    itemId: entry.itemId ?? null,
    payload: { text: entry.text, about: entry.about ?? null },
  });
  return { ts, type: entry.type, text: entry.text, about: entry.about ?? null, itemId: entry.itemId ?? null };
}

function shapeJournal(rows: EventRow[], type?: JournalType): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const r of rows) {
    if (!r.type || !isJournalType(r.type)) continue;
    if (type && r.type !== type) continue;
    const p = parsePayload<{ text?: string; about?: string | null }>(r);
    out.push({ ts: r.ts, type: r.type, text: p.text ?? "", about: p.about ?? null, itemId: r.item_id });
  }
  return out;
}

export async function listJournal(
  db: Database | Store,
  opts: { since?: string; until?: string; type?: JournalType } = {},
): Promise<JournalEntry[]> {
  const rows = await eventsBetweenFor(db, { source: JOURNAL_SOURCE, since: opts.since, until: opts.until });
  return shapeJournal(rows, opts.type);
}

/** kudos → suggestion → comment; stable within a type (eventsBetweenFor is ORDER BY ts, id). Pure. */
export function renderJournalList(entries: JournalEntry[]): string {
  if (entries.length === 0) return "(no journal entries)";
  return entries.map((e) => `[${e.type}] ${e.text}${e.about ? ` — about ${e.about}` : ""}`).join("\n");
}

export function renderJournalCapture(entry: JournalEntry): string {
  return `logged ${entry.type}: ${entry.text}${entry.about ? ` (about ${entry.about})` : ""}`;
}

export function orderJournal(entries: JournalEntry[]): JournalEntry[] {
  return [...entries].sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
}

function flag(ctx: Ctx, key: string): string | undefined {
  const v = (ctx.flags as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

export async function cmdLog(ctx: Ctx): Promise<void> {
  const first = ctx.args[0];

  if (first === "list") {
    const typeFlag = flag(ctx, "type");
    if (typeFlag && !isJournalType(typeFlag)) {
      throw new UsageError(`--type must be one of ${JOURNAL_TYPES.join("|")}`);
    }
    const since = flag(ctx, "since") ?? (await getCursorFor(ctx.store ?? ctx.db, "standup_last")) ?? undefined;
    const entries = orderJournal(
      await listJournal(ctx.store ?? ctx.db, { since, type: typeFlag as JournalType | undefined }),
    );
    if (ctx.mode === "json") {
      print(JSON.stringify(entries, null, 2));
    } else if (ctx.mode === "quiet") {
      print(entries.map((e) => e.text).join("\n"));
    } else {
      print(renderJournalList(entries));
    }
    return;
  }

  // capture: ob log <type> "<text>" [--about <handle>] [--item <id>]
  if (!first) throw new UsageError(`log requires a type (${JOURNAL_TYPES.join("|")}) or 'list'`);
  if (!isJournalType(first)) {
    throw new UsageError(`log type must be one of ${JOURNAL_TYPES.join("|")} (got '${first}')`);
  }
  const text = ctx.args.slice(1).join(" ");
  if (text.length === 0) throw new UsageError(`log ${first} requires a "<text>"`);
  const entry = await logEntry(ctx.store ?? ctx.db, {
    type: first,
    text,
    about: flag(ctx, "about"),
    // A ref or alias (`OB-12`, 1949) is stored as the legacy id the event row keys on.
    itemId: await itemArg(ctx, flag(ctx, "item")),
  });
  if (ctx.mode === "json") print(JSON.stringify(entry));
  else if (ctx.mode !== "quiet") print(renderJournalCapture(entry));
}

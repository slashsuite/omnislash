import type { Database } from "bun:sqlite";
import { eventsForItemFor, nowIso, parsePayload, recordEventFor } from "./events.ts";
import type { Store } from "./db/store.ts";
import type { Ctx } from "./ctx.ts";
import { priorityName } from "./priority.ts";

// The decision trail (ob 1515): every status change can carry a note saying WHY, and every status change
// leaves a record whether or not it did. A record is one `event` row (source "ob", type "transition")
// keyed to the item, so it needs no new table, works on both engines, and `ob show` reads it back with
// the same call that already feeds its activity block. `ob note` appends free text to the item body;
// that has no actor, no from -> to and no way to be listed on its own, which is what a decision needs.

export const DECISION_SOURCE = "ob";
export const DECISION_TYPE = "transition";
/**
 * OS-26: a change to an item's stored priority, on the same trail. Its own type, so every reader that filters
 * on `transition` (lastBlockedFrom, the spinoff-check scans) never sees one; `decisionsForItem` reads both.
 */
export const PRIORITY_CHANGE_TYPE = "priority_change";

/** What a caller passes to a transition to say who moved it and why. Every field is optional. */
export interface DecisionOpts {
  /** Why. Optional everywhere; a blank string is the same as none. */
  note?: string | null;
  /** `--holder`, an agent id, or omitted for a human at the keyboard. */
  actor?: string | null;
  /** The spinoff row id when the transition is a spinoff row's, so the trail links back to it. */
  spinoffRow?: number | null;
  /** Facts merged into the event payload (OB-1825's verdict inputs). `from`, `to` and `note` always win. */
  extra?: Record<string, unknown>;
}

export interface Decision {
  /** `transition` (a status move) or `priority` (OS-26: from and to are priority names). */
  kind: "transition" | "priority";
  ts: string;
  who: string;
  from: string;
  to: string;
  note: string | null;
  spinoff_row: number | null;
}

export const HUMAN_ACTOR = "human";

/** Trim a note; blank means "no note". */
export function cleanNote(note: string | null | undefined): string | null {
  const t = typeof note === "string" ? note.trim() : "";
  return t === "" ? null : t;
}

/** Record one transition. A transition with no note is still recorded: from -> to, no text. */
export async function recordDecision(
  db: Database | Store,
  itemId: string,
  from: string,
  to: string,
  opts: DecisionOpts = {},
): Promise<void> {
  const note = cleanNote(opts.note);
  const payload: Record<string, unknown> = { ...opts.extra, from, to };
  if (note) payload.note = note;
  if (opts.spinoffRow != null) payload.spinoff_row = opts.spinoffRow;
  await recordEventFor(db, {
    ts: nowIso(),
    source: DECISION_SOURCE,
    type: DECISION_TYPE,
    itemId,
    actor: cleanNote(opts.actor) ?? HUMAN_ACTOR,
    payload,
  });
}

/**
 * OS-26: record a change of an item's stored priority, `from` -> `to` as priority names (`none` for unset).
 * The caller only calls it when the value differs. Takes the caller's transaction handle, so the event and the
 * update commit together.
 */
export async function recordPriorityChange(
  db: Database | Store,
  itemId: string,
  from: number | null,
  to: number | null,
  opts: DecisionOpts = {},
): Promise<void> {
  const note = cleanNote(opts.note);
  // Unset and `none` (0) both print as `none`; between the two, unset is named `unset` so the line is not `none → none`.
  const name = (p: number | null, other: number | null) => (p === null && other === 0 ? "unset" : priorityName(p));
  const payload: Record<string, unknown> = { ...opts.extra, from: name(from, to), to: name(to, from) };
  if (note) payload.note = note;
  await recordEventFor(db, {
    ts: nowIso(),
    source: DECISION_SOURCE,
    type: PRIORITY_CHANGE_TYPE,
    itemId,
    actor: cleanNote(opts.actor) ?? HUMAN_ACTOR,
    payload,
  });
}

/** An item's decisions (status moves and priority changes), newest first. Filtered in the store, so a busy item's noise cannot hide one. */
export async function decisionsForItem(db: Database | Store, id: string, limit = 50): Promise<Decision[]> {
  const rows = await eventsForItemFor(db, id, limit, { source: DECISION_SOURCE, types: [DECISION_TYPE, PRIORITY_CHANGE_TYPE] });
  return rows.map((r) => {
    const p = parsePayload<{ from?: string; to?: string; note?: string; spinoff_row?: number }>(r);
    return {
      kind: r.type === PRIORITY_CHANGE_TYPE ? ("priority" as const) : ("transition" as const),
      ts: r.ts,
      who: r.actor ?? HUMAN_ACTOR,
      from: p.from ?? "?",
      to: p.to ?? "?",
      note: p.note ?? null,
      spinoff_row: typeof p.spinoff_row === "number" ? p.spinoff_row : null,
    };
  });
}

/** One line per decision: `when · who · from → to · note` (the row id rides along when there is one). */
export function renderDecision(d: Decision): string {
  const row = d.spinoff_row != null ? ` (row ${d.spinoff_row})` : "";
  const what = d.kind === "priority" ? `priority ${d.from} → ${d.to}` : `${d.from} → ${d.to}`;
  return `${d.ts} · ${d.who} · ${what}${row}${d.note ? ` · ${d.note}` : ""}`;
}

/** The note and actor a command was given: `--note`/`-m`, and `--holder` (else a human at the keyboard). */
export function decisionOptsOf(ctx: Ctx, extra: DecisionOpts = {}): DecisionOpts {
  return { note: ctx.flags.note, actor: ctx.flags.holder, ...extra };
}

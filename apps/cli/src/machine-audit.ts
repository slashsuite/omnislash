import { and, asc, eq, gte } from "drizzle-orm";
import { itemMachineFor } from "../../../platform/state-machine/src/item.ts";
import { spinoffMachine } from "../../../platform/state-machine/src/spinoff.ts";
import { readJson, type Store } from "./db/store.ts";
import { MACHINE_SHADOW_SOURCE, MACHINE_WOULD_REFUSE } from "./machine-shadow.ts";

/**
 * `ob machine audit` (OS-170, spike OS-167 section 5 step 3). Read-only: three lists an architect reads
 * before the machines start refusing moves. Every state comes from the machines themselves
 * (`machine.config.states`), never from a copy here.
 */

/** The spinoff states a row can sit in for days while nothing moves it; the stale list reads only these. */
export const STALE_SPINOFF_STATES = ["launching", "launched"] as const;
export const DEFAULT_STALE_DAYS = 7;
export const DEFAULT_SINCE_DAYS = 7;

export interface UnresolvableItem {
  ref: string;
  machine: string;
  status: string;
}

export interface SpinoffAuditRow {
  /** `#<row id>`. */
  row: string;
  ticket: string;
  status: string;
}

export interface StaleSpinoffRow extends SpinoffAuditRow {
  /** When the row last moved as far as the store can tell: `launched_at`, else `request_at`. */
  updated: string;
}

export interface WouldRefuseGroup {
  machine: string;
  from: string;
  event: string;
  today: string;
  count: number;
  /** The newest event's subject: the item id, or `#<row id>` for a spinoff row. */
  example: string;
}

export interface MachineAudit {
  unresolvable: { count: number; items: UnresolvableItem[]; spinoffs: SpinoffAuditRow[] };
  stale: { count: number; staleDays: number; rows: StaleSpinoffRow[] };
  wouldRefuse: { count: number; since: string; groups: WouldRefuseGroup[] };
}

export interface MachineAuditOptions {
  /** ISO lower bound for the would-refuse events; default DEFAULT_SINCE_DAYS before `now`. */
  since?: string;
  staleDays?: number;
  now?: Date;
}

function statesOf(machine: { config: { states?: object } }): Set<string> {
  return new Set(Object.keys(machine.config.states ?? {}));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `--since`: a date or an ISO time, normalised to the ISO form the event `ts` column holds. */
export function parseAuditSince(value: string): string | null {
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** `--stale-days`: a whole number of days, 0 or more. */
export function parseStaleDays(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

export async function machineAudit(store: Store, opts: MachineAuditOptions = {}): Promise<MachineAudit> {
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const since = opts.since ?? new Date(now.getTime() - DEFAULT_SINCE_DAYS * DAY_MS).toISOString();
  const { q, t } = store;

  // 1. Unresolvable items: the status is not a state of the item's machine.
  const items = await q
    .select({ id: t.item.id, ref: t.item.ref, type: t.item.type, status: t.item.status, kind: t.project.kind })
    .from(t.item)
    .leftJoin(t.project, eq(t.item.project_id, t.project.id))
    .orderBy(asc(t.item.id));
  const unresolvableItems: UnresolvableItem[] = [];
  for (const it of items) {
    const machine = itemMachineFor(it.type, it.kind ?? null);
    if (!statesOf(machine).has(it.status)) unresolvableItems.push({ ref: it.ref ?? it.id, machine: machine.id, status: it.status });
  }

  // 1b and 2. Spinoff rows: a status the spinoff machine lacks, and the long-running ones nothing has moved.
  const spinoffStates = statesOf(spinoffMachine);
  const rows = await q
    .select({
      id: t.spinoff.id,
      ticket: t.spinoff.ticket_ref,
      status: t.spinoff.status,
      request_at: t.spinoff.request_at,
      launched_at: t.spinoff.launched_at,
    })
    .from(t.spinoff)
    .orderBy(asc(t.spinoff.id));
  const unresolvableSpinoffs: SpinoffAuditRow[] = [];
  const stale: StaleSpinoffRow[] = [];
  const cutoff = now.getTime() - staleDays * DAY_MS;
  for (const r of rows) {
    const base = { row: `#${r.id}`, ticket: r.ticket, status: r.status };
    if (!spinoffStates.has(r.status)) {
      unresolvableSpinoffs.push(base);
      continue;
    }
    if (!(STALE_SPINOFF_STATES as readonly string[]).includes(r.status)) continue;
    const updated = r.launched_at ?? r.request_at;
    const at = Date.parse(updated);
    if (!Number.isNaN(at) && at < cutoff) stale.push({ ...base, updated });
  }
  stale.sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated));

  // 3. Would-refuse events from the shadow check, grouped by machine, from, event and today's answer.
  const events = await q
    .select({ ts: t.event.ts, item_id: t.event.item_id, payload: t.event.payload })
    .from(t.event)
    .where(and(eq(t.event.source, MACHINE_SHADOW_SOURCE), eq(t.event.type, MACHINE_WOULD_REFUSE), gte(t.event.ts, since)))
    .orderBy(asc(t.event.ts), asc(t.event.id));
  const groups = new Map<string, WouldRefuseGroup>();
  for (const e of events) {
    let p: Record<string, unknown>;
    try {
      const parsed: unknown = readJson<unknown>(e.payload ?? "{}");
      p = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      p = {};
    }
    const str = (v: unknown): string => (v === null || v === undefined ? "?" : String(v));
    const machine = str(p.machine);
    const from = str(p.from);
    const event = str(p.event);
    const today = str(p.today);
    const example = p.rowId !== undefined && p.rowId !== null ? `#${str(p.rowId)}` : str(e.item_id ?? p.id);
    const key = JSON.stringify([machine, from, event, today]);
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      g.example = example; // ordered oldest first, so the last one seen is the newest
    } else groups.set(key, { machine, from, event, today, count: 1, example });
  }
  const grouped = [...groups.values()].sort(
    (a, b) => b.count - a.count || a.machine.localeCompare(b.machine) || a.from.localeCompare(b.from) || a.event.localeCompare(b.event),
  );

  return {
    unresolvable: {
      count: unresolvableItems.length + unresolvableSpinoffs.length,
      items: unresolvableItems,
      spinoffs: unresolvableSpinoffs,
    },
    stale: { count: stale.length, staleDays, rows: stale },
    wouldRefuse: { count: events.length, since, groups: grouped },
  };
}

/** The human form: each section a count line, then its rows, tab-separated. */
export function renderMachineAudit(a: MachineAudit): string {
  const out: string[] = [];
  out.push(`unresolvable: ${a.unresolvable.count}`);
  for (const r of a.unresolvable.items) out.push(`  ${r.ref}\t${r.machine}\t${r.status}`);
  for (const r of a.unresolvable.spinoffs) out.push(`  ${r.row}\t${r.ticket}\tspinoff\t${r.status}`);
  out.push(`stale (launching/launched, not moved for ${a.stale.staleDays}+ days): ${a.stale.count}`);
  for (const r of a.stale.rows) out.push(`  ${r.row}\t${r.ticket}\t${r.status}\t${r.updated}`);
  out.push(`would refuse (since ${a.wouldRefuse.since}): ${a.wouldRefuse.count}`);
  for (const g of a.wouldRefuse.groups) {
    out.push(`  ${g.count}\t${g.machine}\t${g.from}\t${g.event}\ttoday ${g.today}\tnewest ${g.example}`);
  }
  return out.join("\n");
}

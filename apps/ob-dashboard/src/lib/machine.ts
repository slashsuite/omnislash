// OS-165: the Machine page's pure half. Which in-flight spinoff rows there are, and which state of the role
// machine (docs/role-state-machine.json, drawn by RoleMachine) each one sits in. Imports only types, so the xstate
// machine in platform/state-machine stays out of the client bundle. Nothing here reads a file or the store.
import type { SpinoffState } from "../../../../platform/state-machine/src/spinoff.ts";

/** The spinoff row fields this page reads. `phase` is step 8 (OS-183): reviewing, pr_ci, gating, … */
export interface MachineRowInput {
  id: number;
  ticket_ref: string;
  item_id?: string | null;
  status: string;
  /** A model trial runs one row per leg (a, b) on the same ticket: each leg is in flight on its own. */
  trial_leg?: string | null;
  /** Why a `failed` row failed; `abandoned: …` marks a retired row, a spike's close starts `spike:`. */
  error?: string | null;
  phase?: string | null;
}

/** An item a row serves: whether it is still open decides whether its row is still in flight. */
export interface MachineItem {
  id: string;
  ref: string | null;
  title: string;
  closed: boolean;
}

/** One in-flight row, placed: its ref and title, and the role state id it sits in. */
export interface MachineRow {
  id: number;
  ref: string;
  title: string;
  state: string;
}

export interface MachineView {
  rows: MachineRow[];
  stamp: string;
}

/**
 * Where a row with no phase and no builder signal sits, per stored status. Typed over SpinoffState, so a state added
 * to SPINOFF_EDGES does not compile until it has a place here (the drift guard the page asks for).
 */
export const BASE_PLACEMENT: Readonly<Record<SpinoffState, string>> = {
  pending: "queued",
  launching: "launching",
  launched: "building",
  "ready-for-gate": "handed_off",
  merged: "closed",
  failed: "failed",
};

/** The phases (OS-183) that are role states of their own in the machine, so a phase names its state. */
export const PHASE_STATES: readonly string[] = ["reviewing", "pr_ci", "gating", "updating_pr", "owner_merge_call"];

/** The prefix a spike's failed close writes (platform/cli-coord/src/spinoff-spike.ts `spikeEndError`). */
const SPIKE_END = "spike:";

/**
 * The role state a row is in. Pure.
 *
 * - A spike (tagged `spike`) runs its own row: pending, launching and launched are all the spike's build (it never
 *   reaches ready-for-gate), and a failed one that ended as a spike is spike_closed.
 * - A phase, when the row has one the machine knows, names the state (handed-off rows: gating, owner_merge_call;
 *   launched rows: reviewing, pr_ci, updating_pr).
 * - A launched row with no phase reads its builder's own status: needs-human and blocked stand out, readying is the
 *   gate (reviewing), anything else is building.
 * - Otherwise the stored status places it (BASE_PLACEMENT).
 *
 * The stored verdict is not read here: a sendback leaves it on the row, so it would place a row sent back to building
 * on a human state it no longer waits on. The phase and the builder's status are what move with the work.
 */
export function placeRow(input: {
  status: string;
  phase: string | null;
  builderStatus: string | null;
  spike: boolean;
  error: string | null;
}): string {
  const { status, phase, builderStatus, spike, error } = input;
  if (spike && (status === "pending" || status === "launching" || status === "launched")) return "spike";
  if (spike && status === "failed" && (error ?? "").startsWith(SPIKE_END)) return "spike_closed";
  if ((status === "launched" || status === "ready-for-gate") && phase && PHASE_STATES.includes(phase)) return phase;
  if (status === "launched") {
    if (builderStatus === "needs-human") return "needs_human";
    if (builderStatus === "blocked") return "blocked";
    if (builderStatus === "readying") return "reviewing";
    return "building";
  }
  return BASE_PLACEMENT[status as SpinoffState] ?? "failed";
}

/** A row's own phase field, when its store has the column. Pure. */
export function phaseOf(row: { phase?: unknown }): string | null {
  return typeof row.phase === "string" && row.phase ? row.phase : null;
}

/** The terminal state the machine never leaves on its own: a landed row is done, not in flight. */
const LANDED = "merged";

/** The error a retired row carries (`ob spinoff abandon`, the losing leg of a model trial): history, not a failure. */
const ABANDONED = "abandoned:";

/**
 * The rows in flight: the newest dispatch of each ticket whose item is still open, unless it has landed. A dispatch
 * is one row, or one row per leg for a model trial (legs a and b run at once on the same ticket). Older rows of the
 * same ticket and retired rows are history, as are rows of closed tickets. Pure.
 */
export function inFlight<R extends MachineRowInput>(rows: readonly R[], items: readonly MachineItem[]): { row: R; item: MachineItem | null }[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const byRef = new Map(items.flatMap((i) => (i.ref ? [[i.ref, i] as const] : [])));
  const itemOf = (r: R) => (r.item_id && byId.get(r.item_id)) || byRef.get(r.ticket_ref) || null;
  const tickets = new Map<string, R[]>();
  for (const r of rows) {
    if (r.status === "failed" && (r.error ?? "").startsWith(ABANDONED)) continue;
    const item = itemOf(r);
    const key = item ? `item:${item.id}` : `ref:${r.ticket_ref}`;
    tickets.set(key, [...(tickets.get(key) ?? []), r]);
  }
  const out: { row: R; item: MachineItem | null }[] = [];
  for (const group of tickets.values()) {
    const newest = group.reduce((a, b) => (b.id > a.id ? b : a));
    // A trial's newest dispatch is the newest row of each leg; anything else is a single row.
    const legs = new Map<string, R>();
    if (newest.trial_leg) {
      for (const r of group) if (r.trial_leg && (!legs.get(r.trial_leg) || r.id > legs.get(r.trial_leg)!.id)) legs.set(r.trial_leg, r);
    } else legs.set("", newest);
    for (const r of legs.values()) {
      if (r.status === LANDED) continue;
      const item = itemOf(r);
      if (item?.closed) continue;
      out.push({ row: r, item });
    }
  }
  return out.sort((a, b) => b.row.id - a.row.id);
}

/**
 * What the live snapshot says about the rows this page draws: every row's status and phase, every agent's status and
 * the items stamp (a ticket closed or retitled). The server stamps its read with this and the page re-reads when a
 * push's stamp differs, so a handoff, a sendback, a builder stamping needs-human or an `ob close` moves the view
 * without a reload. Pure.
 */
export function machineStamp(
  spinoffs: readonly { id: number; status: string; phase?: unknown }[],
  agents: readonly { id: string; status?: string | null }[],
  items: string,
): string {
  const rows = spinoffs.map((s) => `${s.id}:${s.status}:${phaseOf(s) ?? ""}`).sort();
  const who = agents.map((a) => `${a.id}:${a.status ?? ""}`).sort();
  return fnv1a(`${rows.join(",")}|${who.join(",")}|${items}`);
}

/** 32-bit FNV-1a as hex: the stamp is compared, never read, and the full text runs to tens of kilobytes. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

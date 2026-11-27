// OS-165: the Machine page's pure half. Which in-flight spinoff rows there are, and which state of the role
// machine (platform/state-machine, drawn by RoleMachine) each one sits in. OS-241: the open tickets with no row in
// flight sit in the planning states. Nothing here reads a file or the store.
import { ROW_STATE } from "../../../../platform/state-machine/src/role.ts";
import { SPINOFF_PHASES } from "../../../../platform/state-machine/src/spinoff-phase.ts";
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

/** One ticket, placed: its ref and title, and the role state id it sits in. */
export interface MachineRow {
  /** The spinoff row's id, or null for an open ticket with no row in flight (OS-241). */
  id: number | null;
  /** The item, for the drawer that opens it. */
  itemId: string;
  /** The dot's id: the ticket ref, or `<ref>-b` for leg b of a model trial, so the two legs never share one. */
  ref: string;
  title: string;
  state: string;
}

export interface MachineView {
  rows: MachineRow[];
  stamp: string;
}

/** Where a row with no phase and no builder signal sits, per stored status: the role machine's `ROW_STATE` (OS-230). */
export const BASE_PLACEMENT: Readonly<Record<SpinoffState, string>> = ROW_STATE;

/** The phases (OS-183) that are role states of their own in the machine, so a phase names its state. */
export const PHASE_STATES: readonly string[] = SPINOFF_PHASES;

/** The prefix a spike's failed close writes (platform/cli-coord/src/spinoff-spike.ts `spikeEndError`). */
const SPIKE_END = "spike:";

/**
 * The role state a row is in. Pure.
 *
 * - A spike (tagged `spike`) runs its own row: pending, launching and launched are all the spike's build (it never
 *   reaches ready-for-gate). A spike that has ended is history, not in flight (inFlight, OS-261).
 * - A launched row whose builder is needs-human or blocked is on the owner's call, whatever its phase.
 * - A handed-off row whose verdict is needs-human waits on the owner's merge call, a human state, even though the
 *   handoff stamped phase `gating`. The verdict is read only for handed-off rows: a sendback moves the row back to
 *   launched and leaves the old verdict on it, so on a launched row it would place work on a human state it no longer
 *   waits on.
 * - A phase, when the row has one the machine knows, names the state (handed-off rows: gating, owner_merge_call;
 *   launched rows: reviewing, pr_ci, updating_pr).
 * - A launched row with no phase is the gate (reviewing) while its builder is readying, else building.
 * - Otherwise the stored status places it (BASE_PLACEMENT).
 */
export function placeRow(input: {
  status: string;
  phase: string | null;
  builderStatus: string | null;
  spike: boolean;
  /** The row's verdict, `State: needs-human - …` as rowVerdictState reads it, or null. */
  verdict?: string | null;
}): string {
  const { status, phase, builderStatus, spike, verdict } = input;
  if (spike && (status === "pending" || status === "launching" || status === "launched")) return "spike";
  if (status === "launched" && (builderStatus === "needs-human" || builderStatus === "blocked")) return "owner_call";
  if (status === "ready-for-gate" && isNeedsHuman(verdict)) return "owner_merge_call";
  if ((status === "launched" || status === "ready-for-gate") && phase && PHASE_STATES.includes(phase)) return phase;
  if (status === "launched") return builderStatus === "readying" ? "reviewing" : "building";
  return BASE_PLACEMENT[status as SpinoffState] ?? "failed";
}

/** Whether a verdict (`State: needs-human - …`, or the bare word) is needs-human. Pure. */
export function isNeedsHuman(verdict: string | null | undefined): boolean {
  return /^(?:State:\s+)?needs-human(?![\w-])/.test((verdict ?? "").trim());
}

/** A row's own phase field, when its store has the column. Pure. */
export function phaseOf(row: { phase?: unknown }): string | null {
  return typeof row.phase === "string" && row.phase ? row.phase : null;
}

/** The tag that puts an undispatched ticket on the owner's planning call (OS-241). */
export const OWNER_PLAN_TAG = "needs-jacobus";
/** The tag that parks a raw idea (skills/ob-muse: `ob tag idea`). */
export const IDEA_TAG = "idea";
/** The check verdict that sends a checked ticket back to drilling (role machine: checking -> drilling on no-go). */
const NO_GO = "no-go";

/**
 * OS-241: the planning state of an open ticket with no row in flight. Pure.
 *
 * - Tagged needs-jacobus: the planning call only the owner can make.
 * - Tagged idea: a parked idea.
 * - A check on its current body that did not say no-go (go, waiting to be dispatched, or an older verdict still to
 *   resolve): the blind check.
 * - A no-go, or a `## Drilled` section with no check on its current body (none yet, or one on an older body): drilling.
 * - Otherwise (no `## Drilled` section, no check): the backlog (OS-260).
 */
export function placeOpen(input: { tags: readonly string[]; check: string | null; drilled: boolean }): string {
  if (input.tags.includes(OWNER_PLAN_TAG)) return "owner_plan_call";
  if (input.tags.includes(IDEA_TAG)) return "parked_idea";
  if (input.check && input.check !== NO_GO) return "checking";
  if (input.drilled || input.check === NO_GO) return "drilling";
  return "backlog";
}

/** The terminal state the machine never leaves on its own: a landed row is done, not in flight. */
const LANDED = "merged";

/** The error a retired row carries (`ob spinoff abandon`, the losing leg of a model trial): history, not a failure. */
const ABANDONED = "abandoned:";

/**
 * The rows in flight: the newest dispatch of each ticket whose item is still open, unless it has landed. A dispatch
 * is one row, or one row per leg for a model trial (legs a and b run at once on the same ticket). Older rows of the
 * same ticket and retired rows are history, as are rows of closed tickets and rows that name no ticket. Pure.
 */
export function inFlight<R extends MachineRowInput>(rows: readonly R[], items: readonly MachineItem[]): { row: R; item: MachineItem }[] {
  const out: { row: R; item: MachineItem }[] = [];
  for (const { item, legs } of newestDispatches(rows, items)) {
    for (const r of legs) {
      // A retired newest row retires its ticket's dispatch: an older row behind it is history, not back in flight. So
      // does a spike that has ended (OS-261): it is written only once its ticket is done, so a reopened spike ticket is
      // back on its planning state, not drawn as shipped or as the architect's.
      const ended = r.status === "failed" && ((r.error ?? "").startsWith(ABANDONED) || (r.error ?? "").startsWith(SPIKE_END));
      if (r.status === LANDED || ended) continue;
      // No ticket at all: a mis-dispatch whose ref is a CLI verb (`status`, `abandon`) or a scratch id (`9999999`).
      if (!item || item.closed) continue;
      out.push({ row: r, item });
    }
  }
  return out.sort((a, b) => b.row.id - a.row.id);
}

/**
 * OS-241: the tickets whose newest dispatch (any leg of a trial) has merged. A land does not close its ticket, so until
 * `ob close` runs it is still open, and it is not back in planning. Pure.
 */
export function landed<R extends MachineRowInput>(rows: readonly R[], items: readonly MachineItem[]): Set<string> {
  const out = new Set<string>();
  for (const { item, legs } of newestDispatches(rows, items)) if (item && legs.some((r) => r.status === LANDED)) out.add(item.id);
  return out;
}

/** Each ticket's newest dispatch: its newest row, or the newest row of each leg for a model trial, with its item. */
function newestDispatches<R extends MachineRowInput>(rows: readonly R[], items: readonly MachineItem[]): { item: MachineItem | null; legs: R[] }[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const byRef = new Map(items.flatMap((i) => (i.ref ? [[i.ref, i] as const] : [])));
  const itemOf = (r: R) => (r.item_id && byId.get(r.item_id)) || byRef.get(r.ticket_ref) || null;
  const tickets = new Map<string, { item: MachineItem | null; rows: R[] }>();
  for (const r of rows) {
    const item = itemOf(r);
    const key = item ? `item:${item.id}` : `ref:${r.ticket_ref}`;
    const got = tickets.get(key) ?? { item, rows: [] };
    got.rows.push(r);
    tickets.set(key, got);
  }
  return [...tickets.values()].map(({ item, rows: group }) => {
    const newest = group.reduce((a, b) => (b.id > a.id ? b : a));
    // A trial's newest dispatch is the newest row of each leg; anything else is a single row.
    const legs = new Map<string, R>();
    if (newest.trial_leg) {
      for (const r of group) if (r.trial_leg && (!legs.get(r.trial_leg) || r.id > legs.get(r.trial_leg)!.id)) legs.set(r.trial_leg, r);
    } else legs.set("", newest);
    return { item, legs: [...legs.values()] };
  });
}

/**
 * What the live snapshot says about the tickets this page draws: every row's status and phase, every agent's status,
 * the items stamp (a ticket opened, closed, retitled, tagged or reordered) and the decisions stamp (an `ob spinoff
 * check` recorded, which moves a ticket between drilling and the blind check, OS-241). The server stamps its read with this and the page re-reads when a
 * push's stamp differs, so a handoff, a sendback, a builder stamping needs-human or an `ob close` moves the view
 * without a reload. Pure.
 */
export function machineStamp(
  spinoffs: readonly { id: number; status: string; phase?: unknown; verdict?: string | null }[],
  agents: readonly { id: string; status?: string | null }[],
  items: string,
  decisions: string,
): string {
  const rows = spinoffs.map((s) => `${s.id}:${s.status}:${phaseOf(s) ?? ""}:${s.verdict ?? ""}`).sort();
  const who = agents.map((a) => `${a.id}:${a.status ?? ""}`).sort();
  return fnv1a(`${rows.join(",")}|${who.join(",")}|${items}|${decisions}`);
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

import { setup } from "xstate";
import { SPINOFF_EDGES, type SpinoffEvent, type SpinoffState } from "./spinoff.ts";

/**
 * OS-183 (spike OS-167 section 5 step 8): the role phase a spinoff row is in, a sub-state of its status. It is
 * stored in `spinoff.phase` and is null outside `launched` and `ready-for-gate`.
 *
 *   launched:        reviewing (skeptical review running) · pr_ci (PR open, CI running) · updating_pr (sent back)
 *   ready-for-gate:  gating (the sentinel gates the PR) · owner_merge_call (waiting on the owner's merge call)
 *
 * A phase moves by its own event, and only to a phase of the row's status: a `review` on a handed-off row is
 * refused by the machine. Re-entering the phase a row is already in is allowed (a second review round).
 */
export const SPINOFF_PHASES = ["reviewing", "pr_ci", "gating", "updating_pr", "owner_merge_call"] as const;
export type SpinoffPhase = (typeof SPINOFF_PHASES)[number];
export type SpinoffPhaseEvent = "review" | "open_pr" | "gate" | "update_pr" | "merge_call";

/** The one event that enters each phase. */
export const PHASE_EVENT: Readonly<Record<SpinoffPhase, SpinoffPhaseEvent>> = {
  reviewing: "review",
  pr_ci: "open_pr",
  gating: "gate",
  updating_pr: "update_pr",
  owner_merge_call: "merge_call",
};

/** The phases each status may hold. A status not listed holds none (its phase is null). */
export const PHASES_BY_STATUS: Readonly<Partial<Record<SpinoffState, readonly SpinoffPhase[]>>> = {
  launched: ["reviewing", "pr_ci", "updating_pr"],
  "ready-for-gate": ["gating", "owner_merge_call"],
};

/**
 * The phase a status move leaves the row in: `handoff` starts the gate, `sendback` starts the PR update,
 * `stamp` (a launched row's session re-stamp) keeps the phase, and every other move clears it.
 * test/spinoff-phase.test.ts checks every edge lands on a phase its target status may hold.
 */
export const PHASE_ON_MOVE: Readonly<Record<Exclude<SpinoffEvent, "stamp">, SpinoffPhase | null>> = {
  claim: null,
  retry: null,
  fail: null,
  handoff: "gating",
  sendback: "updating_pr",
  land: null,
  reopen: null,
};

/** True when `s` is one of the five phase words. */
export function isSpinoffPhase(s: string): s is SpinoffPhase {
  return (SPINOFF_PHASES as readonly string[]).includes(s);
}

/** The phase machine's state for a stored (status, phase) pair: `launched`, or `launched/reviewing`. */
export function phaseStateOf(status: string, phase: string | null | undefined): string {
  return phase ? `${status}/${phase}` : status;
}

/** The phase half of a phase machine state (`launched/pr_ci` → `pr_ci`), or null for a bare status. */
export function phaseOfState(state: string): SpinoffPhase | null {
  const phase = state.split("/")[1];
  return phase && isSpinoffPhase(phase) ? phase : null;
}

/**
 * The phase machine. Its states are every status, plus `<status>/<phase>` for each phase that status holds;
 * from a status or any of its phases, a phase event moves to that phase when the status holds it. A status
 * with no phases has no moves here: status moves are the spinoff machine's (spinoff.ts).
 */
export const spinoffPhaseMachine = setup({ types: { events: {} as { type: SpinoffPhaseEvent } } }).createMachine({
  id: "spinoff-phase",
  initial: "pending",
  states: Object.fromEntries(
    (Object.keys(SPINOFF_EDGES) as SpinoffState[]).flatMap((status) => {
      const phases = PHASES_BY_STATUS[status] ?? [];
      const on = Object.fromEntries(phases.map((p) => [PHASE_EVENT[p], { target: `#spinoff-phase.${phaseStateOf(status, p)}` }]));
      return [status, ...phases.map((p) => phaseStateOf(status, p))].map((state) => [state, { on }]);
    }),
  ),
});

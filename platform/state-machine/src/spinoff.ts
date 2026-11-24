import { setup } from "xstate";

/**
 * The spinoff row machine (OS-168), the one definition of a spinoff row's moves: since OS-173 `moveSpinoff`
 * (platform/cli-coord/src/commands/spinoff.ts) moves a row only by one of these events, through `applyMove`.
 * Its events name the move, so the row's trail records the event rather than a bare target. Each edge has
 * exactly one event, and each event exactly one target; test/parity.test.ts pins every pair.
 *
 * No self-move rule here: `launched → launched` is a real edge (`stamp`, the 384 session-id re-stamp), and
 * every other self-move is refused.
 */
export type SpinoffState = "pending" | "launching" | "launched" | "ready-for-gate" | "merged" | "failed";
export type SpinoffEvent = "claim" | "stamp" | "retry" | "fail" | "handoff" | "sendback" | "land" | "reopen";

/** Every edge, from → event → target. The explicit map the brief asks for; the machine is built from it. */
export const SPINOFF_EDGES: Readonly<Record<SpinoffState, Readonly<Partial<Record<SpinoffEvent, SpinoffState>>>>> = {
  pending: { claim: "launching", fail: "failed" },
  launching: { stamp: "launched", retry: "pending", fail: "failed" },
  launched: { stamp: "launched", handoff: "ready-for-gate", land: "merged", retry: "pending", fail: "failed" },
  "ready-for-gate": { sendback: "launched", land: "merged", fail: "failed" },
  merged: { reopen: "launched" },
  failed: {},
};

export const spinoffMachine = setup({ types: { events: {} as { type: SpinoffEvent } } }).createMachine({
  id: "spinoff",
  initial: "pending",
  states: Object.fromEntries(
    Object.entries(SPINOFF_EDGES).map(([from, edges]) => [
      from,
      { on: Object.fromEntries(Object.entries(edges).map(([event, to]) => [event, { target: to }])) },
    ]),
  ),
});

/**
 * OS-173: the target-only view of `SPINOFF_EDGES` (from → the states its events lead to), generated, never kept
 * by hand. Readers that only ask "can a row in X reach Y" (tests, docs) use it; writers move by event.
 */
export const SPINOFF_TRANSITIONS = Object.fromEntries(
  Object.entries(SPINOFF_EDGES).map(([from, edges]) => [from, [...new Set(Object.values(edges))]]),
) as unknown as Readonly<Record<SpinoffState, readonly SpinoffState[]>>;

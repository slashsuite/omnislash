import { setup } from "xstate";

/**
 * The spinoff row machine (OS-168), matching `SPINOFF_TRANSITIONS` in platform/cli-coord/src/commands/spinoff.ts.
 * Its events name the move, so a trail can record the event rather than a bare target. Each edge of the
 * table has exactly one event; test/parity.test.ts checks every pair against the table both ways.
 *
 * No self-move rule here: `launched → launched` is a real edge (`stamp`, the 384 session-id re-stamp), and
 * every other self-move is refused, as `moveSpinoff` refuses it.
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
 * The event of the edge `from → to`, or null when the table has none (OS-169: the reverse lookup the shadow
 * check and `SpinoffTransitionRefused` use). `from` is the stored status, free text, or null for a missing row.
 */
export function spinoffEventFor(from: string | null, to: string): SpinoffEvent | null {
  if (from === null || !Object.hasOwn(SPINOFF_EDGES, from)) return null;
  const edges = SPINOFF_EDGES[from as SpinoffState];
  for (const [event, target] of Object.entries(edges)) if (target === to) return event as SpinoffEvent;
  return null;
}

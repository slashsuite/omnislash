import { describe, expect, test } from "vitest";
import { decide } from "../src/decide.ts";
import { SPINOFF_EDGES, type SpinoffEvent, type SpinoffState } from "../src/spinoff.ts";
import {
  PHASE_EVENT,
  PHASE_ON_MOVE,
  PHASES_BY_STATUS,
  SPINOFF_PHASES,
  phaseOfState,
  phaseStateOf,
  spinoffPhaseMachine,
} from "../src/spinoff-phase.ts";

// OS-183: the phase sub-machine. Pinned written out, as parity.test.ts pins the status edges.
const PINNED: Record<string, string[]> = {
  launched: ["reviewing", "pr_ci", "updating_pr"],
  "ready-for-gate": ["gating", "owner_merge_call"],
};

const STATUSES = Object.keys(SPINOFF_EDGES) as SpinoffState[];

describe("the spinoff phase machine", () => {
  test("each status holds exactly the pinned phases", () => {
    for (const status of STATUSES) expect([...(PHASES_BY_STATUS[status] ?? [])]).toEqual(PINNED[status] ?? []);
  });

  test("a phase event is allowed exactly when the row's status holds that phase, from the bare status or any of its phases", () => {
    for (const status of STATUSES) {
      const held = PINNED[status] ?? [];
      for (const from of [null, ...held]) {
        for (const phase of SPINOFF_PHASES) {
          const d = decide(spinoffPhaseMachine, phaseStateOf(status, from), PHASE_EVENT[phase]);
          if (held.includes(phase)) {
            expect(d).toEqual({ ok: true, to: `${status}/${phase}` });
            expect(phaseOfState(d.ok ? d.to : "")).toBe(phase);
          } else expect(d.ok).toBe(false);
        }
      }
    }
  });

  test("every status move leaves a phase its target status may hold", () => {
    for (const [from, edges] of Object.entries(SPINOFF_EDGES) as [SpinoffState, Partial<Record<SpinoffEvent, SpinoffState>>][]) {
      for (const [event, to] of Object.entries(edges) as [SpinoffEvent, SpinoffState][]) {
        const before: (string | null)[] = [null, ...(PINNED[from] ?? [])];
        for (const phase of before) {
          const after = event === "stamp" ? phase : PHASE_ON_MOVE[event];
          if (after !== null) expect(PINNED[to] ?? [], `${from} --${event}--> ${to} with phase ${phase}`).toContain(after);
        }
      }
    }
  });
});

import { describe, expect, test } from "vitest";
import { canTransition, type Kind, statusVocab, VALID_TYPES } from "../../../apps/cli/src/status.ts";
import { SPINOFF_STATUSES, SPINOFF_TRANSITIONS } from "../../cli-coord/src/commands/spinoff.ts";
import { decide } from "../src/decide.ts";
import { itemMachineFor, moveEvent } from "../src/item.ts";
import { SPINOFF_EDGES, spinoffMachine } from "../src/spinoff.ts";

// OS-168: every from-to pair of every table, checked both ways against today's tables (the spike's appendix
// test 1). Adding or removing an edge on either side, or a state, fails here.

const KINDS: (Kind | null)[] = [null, "side", "home", "admin", "learning"];
const ALL_STATUSES = [...new Set(VALID_TYPES.flatMap((type) => KINDS.flatMap((kind) => statusVocab(type, kind))))];

describe("item machines match canTransition", () => {
  for (const type of VALID_TYPES) {
    for (const kind of KINDS) {
      test(`${type} / ${kind ?? "no kind"}`, () => {
        const machine = itemMachineFor(type, kind);
        const vocab = statusVocab(type, kind);
        expect(Object.keys(machine.states).toSorted()).toEqual([...vocab].toSorted());
        for (const from of vocab) {
          for (const to of ALL_STATUSES) {
            const d = decide(machine, from, moveEvent(to));
            const allowed = canTransition(from, to, type, kind);
            expect(d.ok, `${type}/${kind}: ${from} -> ${to}`).toBe(allowed);
            if (d.ok) expect(d.to).toBe(to);
            else expect(d.why).toBe("machine");
          }
        }
      });
    }
  }

  test("a stored status the machine does not know is refused, not thrown", () => {
    const d = decide(itemMachineFor("task", null), "qa", moveEvent("done"));
    expect(d).toMatchObject({ ok: false, why: "machine", from: "qa" });
  });
});

describe("spinoff machine matches SPINOFF_TRANSITIONS", () => {
  // Read off the definition, not kept by hand, so an edge under a new event name is still checked.
  const EVENTS = [...new Set(Object.values(SPINOFF_EDGES).flatMap((edges) => Object.keys(edges)))];

  test("the same states, and the eight named events", () => {
    expect(EVENTS.toSorted()).toEqual(
      ["claim", "stamp", "retry", "fail", "handoff", "sendback", "land", "reopen"].toSorted(),
    );
    expect(Object.keys(spinoffMachine.states).toSorted()).toEqual([...SPINOFF_STATUSES].toSorted());
    expect(Object.keys(SPINOFF_EDGES).toSorted()).toEqual([...SPINOFF_STATUSES].toSorted());
  });

  test("every pair both ways, with exactly one event per edge", () => {
    for (const from of SPINOFF_STATUSES) {
      for (const to of SPINOFF_STATUSES) {
        const events = EVENTS.filter((event) => {
          const d = decide(spinoffMachine, from, event);
          return d.ok && d.to === to;
        });
        const allowed = SPINOFF_TRANSITIONS[from].includes(to);
        expect(events.length, `${from} -> ${to}: ${events.join(", ")}`).toBe(allowed ? 1 : 0);
      }
    }
  });

  test("the named edges", () => {
    expect(decide(spinoffMachine, "launching", "retry")).toEqual({ ok: true, to: "pending" });
    expect(decide(spinoffMachine, "launched", "stamp")).toEqual({ ok: true, to: "launched" });
    for (const from of ["pending", "launching", "launched", "ready-for-gate"]) {
      expect(decide(spinoffMachine, from, "fail")).toEqual({ ok: true, to: "failed" });
    }
    expect(decide(spinoffMachine, "failed", "reopen")).toMatchObject({ ok: false, why: "machine" });
  });
});

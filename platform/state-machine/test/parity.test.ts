import { describe, expect, test } from "vitest";
import { type Kind, statusVocab, VALID_TYPES } from "../../../apps/cli/src/status.ts";
import { SPINOFF_STATUSES, SPINOFF_TRANSITIONS as CLI_COORD_TRANSITIONS } from "../../cli-coord/src/commands/spinoff.ts";
import { decide } from "../src/decide.ts";
import { itemMachineFor, moveEvent } from "../src/item.ts";
import { SPINOFF_EDGES, SPINOFF_TRANSITIONS, spinoffMachine } from "../src/spinoff.ts";

// OS-172: the item machines are the one definition of the item lifecycle, so this pins each one's from-to
// pairs, written out once here (the tables apps/cli/src/status.ts held before OS-172). Adding or removing an edge or a
// state in item.ts fails here, so an edge change is a reviewed diff. Each machine's states must also be its
// type's vocabulary in status.ts.

const TASK = {
  open: ["in_progress", "ready", "blocked", "done"],
  in_progress: ["ready", "blocked", "done", "open"],
  ready: ["merged", "in_progress", "blocked", "done"],
  merged: ["done", "blocked", "open"],
  blocked: ["open", "in_progress", "ready", "done"],
  done: ["open"],
};

const EDGES: Record<string, Record<string, string[]>> = {
  task: TASK,
  linear_ref: {
    open: ["in_progress", "ready", "blocked", "done"],
    in_progress: ["ready", "blocked", "done", "open"],
    ready: ["merged", "in_progress", "blocked", "qa_ready", "done"],
    merged: ["qa_ready", "done", "blocked"],
    qa_ready: ["qa", "blocked", "done"],
    qa: ["qa_rework", "done", "blocked"],
    qa_rework: ["in_progress", "ready", "qa", "blocked", "done"],
    blocked: ["open", "in_progress", "ready", "done"],
    done: ["open"],
  },
  roadmap: { active: ["archived"], archived: ["active"] },
  decision: { draft: ["accepted", "superseded"], accepted: ["superseded"], superseded: [] },
  learning: { todo: ["in_progress", "done"], in_progress: ["done", "todo"], done: ["todo", "in_progress"] },
  reference: { active: [] },
};

const KINDS: (Kind | null)[] = [null, "side", "home", "admin", "learning"];
const ALL_STATUSES = [...new Set(VALID_TYPES.flatMap((type) => KINDS.flatMap((kind) => statusVocab(type, kind))))];

describe("item machines have exactly the pinned edges", () => {
  test("every item type has a pinned edge list", () => {
    expect(Object.keys(EDGES).toSorted()).toEqual([...VALID_TYPES].toSorted());
  });

  for (const type of VALID_TYPES) {
    for (const kind of KINDS) {
      test(`${type} / ${kind ?? "no kind"}`, () => {
        const machine = itemMachineFor(type, kind);
        const edges = EDGES[type]!;
        const vocab = statusVocab(type, kind);
        expect(Object.keys(machine.states).toSorted()).toEqual([...vocab].toSorted());
        expect(Object.keys(edges).toSorted()).toEqual([...vocab].toSorted());
        for (const from of vocab) {
          for (const to of ALL_STATUSES) {
            const d = decide(machine, from, moveEvent(to));
            // A self-move is an allowed no-op on every state.
            const allowed = from === to || edges[from]!.includes(to);
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

// OS-173: the machine is the spinoff lifecycle's one definition, and SPINOFF_TRANSITIONS is generated from it.
// So the edges are pinned here, written out, as the ticket and the spike name them: adding, removing or
// renaming an edge fails here, and the generated table must say the same thing.
const PINNED_SPINOFF_EDGES: Record<string, Record<string, string>> = {
  pending: { claim: "launching", fail: "failed" },
  launching: { stamp: "launched", retry: "pending", fail: "failed" },
  launched: { stamp: "launched", handoff: "ready-for-gate", land: "merged", retry: "pending", fail: "failed" },
  "ready-for-gate": { sendback: "launched", land: "merged", fail: "failed" },
  merged: { reopen: "launched" },
  failed: {},
};

describe("spinoff machine is the one definition (OS-173)", () => {
  const EVENTS = [...new Set(Object.values(PINNED_SPINOFF_EDGES).flatMap((edges) => Object.keys(edges)))];

  test("the same states as the spinoff table's vocabulary, and the eight named events", () => {
    expect(EVENTS.toSorted()).toEqual(["claim", "stamp", "retry", "fail", "handoff", "sendback", "land", "reopen"].toSorted());
    expect(Object.keys(spinoffMachine.states).toSorted()).toEqual([...SPINOFF_STATUSES].toSorted());
    expect(SPINOFF_EDGES).toEqual(PINNED_SPINOFF_EDGES);
  });

  test("every state and event both ways against the pinned edges", () => {
    for (const from of SPINOFF_STATUSES) {
      for (const event of EVENTS) {
        const d = decide(spinoffMachine, from, event);
        const to = PINNED_SPINOFF_EDGES[from]![event];
        if (to) expect(d, `${from} --${event}-->`).toEqual({ ok: true, to });
        else expect(d, `${from} --${event}-->`).toMatchObject({ ok: false, why: "machine" });
      }
    }
  });

  test("SPINOFF_TRANSITIONS is the view: each state's distinct targets, nothing more", () => {
    for (const from of SPINOFF_STATUSES) {
      expect([...SPINOFF_TRANSITIONS[from]].toSorted(), from).toEqual([...new Set(Object.values(PINNED_SPINOFF_EDGES[from]!))].toSorted());
    }
    // cli-coord re-exports the same view, not a table of its own.
    expect(CLI_COORD_TRANSITIONS).toBe(SPINOFF_TRANSITIONS);
  });
});

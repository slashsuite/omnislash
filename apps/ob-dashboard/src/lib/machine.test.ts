import { describe, expect, it } from "bun:test";
import machine from "../../../../docs/role-state-machine.json" with { type: "json" };
import { SPINOFF_EDGES } from "../../../../platform/state-machine/src/spinoff.ts";
import { SPINOFF_PHASES } from "../../../../platform/state-machine/src/spinoff-phase.ts";
import { BASE_PLACEMENT, inFlight, isNeedsHuman, machineStamp, PHASE_STATES, placeRow, type MachineItem } from "./machine.ts";
import { roleDefinition } from "./role-machine.ts";

// OS-165: the Machine page's placement of in-flight spinoff rows on the role machine, and its live stamp.

const ROLE_STATES = new Set(machine.states.map((s) => s.id));
const base = { phase: null, builderStatus: null, spike: false, error: null } as const;

describe("placeRow (OS-165, section 7 of the role machine doc)", () => {
  it("has a base placement for every SPINOFF_EDGES state, and each one exists in the machine", () => {
    expect(Object.keys(BASE_PLACEMENT).sort()).toEqual(Object.keys(SPINOFF_EDGES).sort());
    for (const state of Object.values(BASE_PLACEMENT)) expect(ROLE_STATES.has(state)).toBe(true);
  });

  it("names the phases the store keeps as the role states they are", () => {
    expect([...PHASE_STATES].sort()).toEqual([...SPINOFF_PHASES].sort());
    for (const phase of PHASE_STATES) expect(ROLE_STATES.has(phase)).toBe(true);
  });

  it("places a queued, launching, handed-off, failed and landed row by its stored status", () => {
    expect(placeRow({ ...base, status: "pending" })).toBe("queued");
    expect(placeRow({ ...base, status: "launching" })).toBe("launching");
    expect(placeRow({ ...base, status: "ready-for-gate" })).toBe("handed_off");
    expect(placeRow({ ...base, status: "failed" })).toBe("failed");
    expect(placeRow({ ...base, status: "merged" })).toBe("closed");
  });

  it("reads a launched row's builder: needs-human and blocked stand out, readying is the gate, else building", () => {
    expect(placeRow({ ...base, status: "launched", builderStatus: "needs-human" })).toBe("needs_human");
    expect(placeRow({ ...base, status: "launched", builderStatus: "blocked" })).toBe("blocked");
    expect(placeRow({ ...base, status: "launched", builderStatus: "readying" })).toBe("reviewing");
    expect(placeRow({ ...base, status: "launched", builderStatus: "working" })).toBe("building");
    expect(placeRow({ ...base, status: "launched" })).toBe("building");
  });

  it("names the state from the row's phase when it has one", () => {
    expect(placeRow({ ...base, status: "launched", phase: "pr_ci" })).toBe("pr_ci");
    expect(placeRow({ ...base, status: "launched", phase: "reviewing", builderStatus: "working" })).toBe("reviewing");
    expect(placeRow({ ...base, status: "ready-for-gate", phase: "gating" })).toBe("gating");
    expect(placeRow({ ...base, status: "ready-for-gate", phase: "owner_merge_call" })).toBe("owner_merge_call");
  });

  it("draws a spike's build on the spike state, and a spike that ended on spike_closed", () => {
    for (const status of ["pending", "launching", "launched"]) expect(placeRow({ ...base, status, spike: true })).toBe("spike");
    expect(placeRow({ ...base, status: "failed", spike: true, error: "spike: answered" })).toBe("spike_closed");
    expect(placeRow({ ...base, status: "failed", spike: true, error: "launch refused" })).toBe("failed");
  });

  it("puts a handed-off row whose verdict is needs-human on the owner's merge call, a human state", () => {
    const human = new Set(roleDefinition().states.filter((s) => s.kind === "human").map((s) => s.id));
    for (const verdict of ["State: needs-human - is the wording right?", "needs-human"]) {
      const state = placeRow({ ...base, status: "ready-for-gate", verdict });
      expect(state).toBe("owner_merge_call");
      expect(human.has(state)).toBe(true);
    }
    expect(placeRow({ ...base, status: "ready-for-gate", verdict: "State: landable" })).toBe("handed_off");
    expect(isNeedsHuman("State: needs-humane")).toBe(false);
  });

  it("lets neither the handoff's gating phase nor a launched row's phase hide a person's turn", () => {
    expect(placeRow({ ...base, status: "ready-for-gate", phase: "gating", verdict: "State: needs-human - x" })).toBe("owner_merge_call");
    expect(placeRow({ ...base, status: "launched", phase: "pr_ci", builderStatus: "needs-human" })).toBe("needs_human");
    expect(placeRow({ ...base, status: "launched", phase: "updating_pr", builderStatus: "blocked" })).toBe("blocked");
  });

  it("does not let a stale verdict hold a sent-back row: a launched row ignores the verdict", () => {
    // A sendback leaves `verdict: needs-human` on the row and moves it back to launched with no phase.
    expect(placeRow({ ...base, status: "launched", builderStatus: "working", verdict: "State: needs-human - x" })).toBe("building");
  });
});

describe("inFlight (OS-165)", () => {
  const item = (over: Partial<MachineItem> & { id: string }): MachineItem => ({ ref: null, title: "t", closed: false, ...over });
  const row = (over: Partial<{ id: number; ticket_ref: string; item_id: string | null; status: string; error: string | null; trial_leg: string | null }> & { id: number }) => ({
    ticket_ref: "OS-1",
    item_id: "i1",
    status: "pending",
    error: null,
    trial_leg: null,
    ...over,
  });
  const items = [item({ id: "i1", ref: "OS-1" }), item({ id: "i2", ref: "OS-2", closed: true })];

  it("keeps the newest row of each open ticket, and drops landed, retired and closed-ticket rows", () => {
    const rows = [
      row({ id: 1, status: "failed" }),
      row({ id: 2, status: "launched" }),
      row({ id: 3, ticket_ref: "OS-2", item_id: "i2", status: "launched" }),
      row({ id: 4, ticket_ref: "OS-3", item_id: null, status: "merged" }),
      row({ id: 5, ticket_ref: "OS-4", item_id: null, status: "failed", error: "abandoned: lost the trial" }),
    ];
    expect(inFlight(rows, items).map((r) => r.row.id)).toEqual([2]);
  });

  it("leaves out a row that names no ticket: a CLI verb or a scratch id in its ref", () => {
    const rows = ["status", "abandon", "9999999", "1268"].map((ticket_ref, n) => row({ id: 10 + n, ticket_ref, item_id: null, status: "failed", error: "mis-dispatch" }));
    expect(inFlight(rows, items)).toEqual([]);
  });

  it("does not bring an older row back when the newest one was abandoned", () => {
    const rows = [row({ id: 1, status: "failed", error: "launch refused" }), row({ id: 2, status: "failed", error: "abandoned: retired" })];
    expect(inFlight(rows, items)).toEqual([]);
  });

  it("keeps one row per leg of a model trial", () => {
    const rows = [row({ id: 1, status: "launched", trial_leg: "a" }), row({ id: 2, status: "launched", trial_leg: "b" })];
    expect(inFlight(rows, items).map((r) => r.row.id)).toEqual([2, 1]);
  });
});

describe("machineStamp (OS-165)", () => {
  const spinoffs = [{ id: 1, status: "pending" }];
  const agents = [{ id: "os-1", status: "working" }];

  it("changes when a row moves, a builder changes status or a ticket changes, and not otherwise", () => {
    const before = machineStamp(spinoffs, agents, "s1");
    expect(machineStamp([{ id: 1, status: "launching" }], agents, "s1")).not.toBe(before);
    expect(machineStamp(spinoffs, [{ id: "os-1", status: "needs-human" }], "s1")).not.toBe(before);
    expect(machineStamp(spinoffs, agents, "s2")).not.toBe(before);
    expect(machineStamp([{ id: 1, status: "pending", verdict: "State: needs-human - x" }], agents, "s1")).not.toBe(before);
    expect(machineStamp(spinoffs, agents, "s1")).toBe(before);
  });
});

// OS-214: the role and spinoff xstate machines as StateMachine definitions, through fromXState. OS-261: the role
// machine as persona swimlanes.
import { describe, expect, it } from "bun:test";
import { ROLE_TRANSITIONS, ROLES, STAGES } from "../../../../platform/state-machine/src/role.ts";
import { roleDefinition, roleLanes, spinoffDefinition } from "./role-machine.ts";

describe("roleDefinition (fromXState over roleMachine)", () => {
  const { states, transitions } = roleDefinition();
  const byId = new Map(states.map((s) => [s.id, s]));

  it("owns each state by its role", () => {
    expect(byId.get("drilling")?.owner).toBe("architect");
    expect(byId.get("queued")?.owner).toBe("system");
    expect(byId.get("backlog")?.owner).toBe("system");
  });

  it("marks human states human and keeps the failed end failed", () => {
    expect(byId.get("owner_plan_call")?.kind).toBe("human");
    expect(byId.get("owner_call")?.kind).toBe("human");
    expect(byId.get("failed")?.kind).toBe("failed");
    expect(byId.get("closed")?.kind).toBe("terminal");
  });

  it("gives every arrow the actor role.ts names for its move (OS-237)", () => {
    expect(transitions).toHaveLength(ROLE_TRANSITIONS.length);
    for (const t of ROLE_TRANSITIONS) {
      expect(transitions.find((d) => d.from === t.from && d.to === t.to && d.event === t.label)?.actor).toBe(t.actor);
    }
  });
});

describe("roleLanes (OS-261)", () => {
  const { lanes, stages, states, cell } = roleLanes();
  const byId = new Map(states.map((s) => [s.id, s]));

  it("has one lane per persona and five stages, in order", () => {
    expect(lanes).toEqual(ROLES);
    expect(stages).toEqual(STAGES);
    expect(stages).toEqual(["idea", "plan", "build", "ship", "done"]);
  });

  it("puts the owner in every stage he decides in", () => {
    expect(cell("owner", "idea").map((s) => s.id)).toEqual(["confirm_complete"]);
    expect(cell("owner", "plan").map((s) => s.id)).toEqual(["owner_plan_call"]);
    expect(cell("owner", "build").map((s) => s.id)).toEqual(["owner_call"]);
    expect(cell("owner", "ship").map((s) => s.id)).toEqual(["owner_merge_call"]);
  });

  it("lists each state's moves with the target's label and the persona that makes it", () => {
    expect(byId.get("checking")?.moves).toEqual([
      { to: "queued", toLabel: "Waiting for a builder", label: "brief passes, dispatch", actor: "architect" },
      { to: "drilling", toLabel: "Architect shapes the ticket", label: "gaps found, revise", actor: "reviewer" },
    ]);
    expect(byId.get("exploring")?.kind).toBe("initial");
    expect(byId.get("closed")?.moves).toEqual([]);
  });
});

describe("spinoffDefinition (fromXState over spinoffMachine)", () => {
  it("draws every spinoff state, with its moves as arrows", () => {
    const { states, transitions } = spinoffDefinition();
    expect(states.map((s) => s.id)).toEqual(expect.arrayContaining(["pending", "launching", "launched", "ready-for-gate", "merged", "failed"]));
    expect(transitions.some((t) => t.from === "pending" && t.event === "claim")).toBe(true);
  });
});

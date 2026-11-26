// OS-214: the role and spinoff xstate machines as StateMachine definitions, through fromXState.
import { describe, expect, it } from "bun:test";
import { ROLE_TRANSITIONS } from "../../../../platform/state-machine/src/role.ts";
import { ROLE_TONES, roleDefinition, spinoffDefinition } from "./role-machine.ts";

describe("roleDefinition (fromXState over roleMachine)", () => {
  const { states, transitions } = roleDefinition();
  const byId = new Map(states.map((s) => [s.id, s]));

  it("owns each state by its role", () => {
    expect(byId.get("drilling")?.owner).toBe("architect");
    expect(byId.get("queued")?.owner).toBe("system");
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
    // A move whose actor is not its from-state's owner: the muse files the ticket from the owner's state.
    expect(transitions.find((d) => d.from === "confirm_complete" && d.to === "drilling")?.actor).toBe("muse");
  });

  it("pins the owner to his own colour (OS-237)", () => {
    expect(ROLE_TONES.owner).toBe("cat2");
  });

  it("names each arrow by its short label", () => {
    expect(transitions.some((t) => t.from === "spike" && t.to === "closed" && t.event === "spike closed")).toBe(true);
  });
});

describe("spinoffDefinition (fromXState over spinoffMachine)", () => {
  it("draws every spinoff state, with its moves as arrows", () => {
    const { states, transitions } = spinoffDefinition();
    expect(states.map((s) => s.id)).toEqual(expect.arrayContaining(["pending", "launching", "launched", "ready-for-gate", "merged", "failed"]));
    expect(transitions.some((t) => t.from === "pending" && t.event === "claim")).toBe(true);
  });
});

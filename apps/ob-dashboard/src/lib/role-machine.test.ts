// OS-214: the role and spinoff xstate machines as StateMachine definitions, through fromXState.
import { describe, expect, it } from "bun:test";
import { roleDefinition, spinoffDefinition } from "./role-machine.ts";

describe("roleDefinition (fromXState over roleMachine)", () => {
  const { states, transitions } = roleDefinition();
  const byId = new Map(states.map((s) => [s.id, s]));

  it("owns each state by its role", () => {
    expect(byId.get("ticketed")?.owner).toBe("architect");
    expect(byId.get("queued")?.owner).toBe("system");
  });

  it("marks human states human and keeps the failed end failed", () => {
    expect(byId.get("idea")?.kind).toBe("human");
    expect(byId.get("needs_human")?.kind).toBe("human");
    expect(byId.get("failed")?.kind).toBe("failed");
    expect(byId.get("closed")?.kind).toBe("terminal");
  });

  it("names each arrow by its short label", () => {
    expect(transitions.some((t) => t.from === "spike" && t.to === "spike_closed" && t.event === "spike closed")).toBe(true);
  });
});

describe("spinoffDefinition (fromXState over spinoffMachine)", () => {
  it("draws every spinoff state, with its moves as arrows", () => {
    const { states, transitions } = spinoffDefinition();
    expect(states.map((s) => s.id)).toEqual(expect.arrayContaining(["pending", "launching", "launched", "ready-for-gate", "merged", "failed"]));
    expect(transitions.some((t) => t.from === "pending" && t.event === "claim")).toBe(true);
  });
});

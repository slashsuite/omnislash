// Component tests (happy-dom). Named *.vitest.tsx so the repo-root `bun test` never matches them; `vitest run` includes them (vite.config.ts).
// @vitest-environment happy-dom
// OS-187: every state of the role machine JSON is drawn, and a ticket shows in the state it names.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import machine from "../../../../docs/role-state-machine.json" with { type: "json" };
import { RoleMachine } from "../components/RoleMachine.tsx";
import { roleDefinition } from "../lib/role-machine.ts";

afterEach(cleanup);

describe("RoleMachine (OS-187)", () => {
  it("draws every state in the JSON, by its label", () => {
    render(<RoleMachine machine={machine} tickets={[]} />);
    const drawn = screen.getByRole("group", { name: "Role state machine" });
    expect(machine.states.length).toBeGreaterThan(0);
    // Exact and case-sensitive: "Idea" must not pass on "Parked idea (tag idea)", nor "Spike closed" on the
    // "spike closed" arrow. No arrow label equals a state label, so a match here is the state's own box.
    for (const s of machine.states) expect(within(drawn).getAllByText(s.label).length).toBeGreaterThan(0);
  });

  it("puts a ticket's dot in its state", () => {
    render(<RoleMachine machine={machine} tickets={[{ ref: "OS-170", title: "Empty state", state: "needs_human" }]} />);
    // The dot is named after the box it sits in, so a wrong state (or the "Not in any state" box) fails here.
    expect(screen.getByRole("img", { name: "OS-170 Empty state, in Needs human (verdict)" })).toBeTruthy();
  });

  it("maps human states to human, the failed end to failed and the other ends to terminal", () => {
    const kinds = new Map(roleDefinition(machine).states.map((s) => [s.id, s.kind]));
    expect(kinds.get("needs_human")).toBe("human");
    expect(kinds.get("failed")).toBe("failed");
    expect(kinds.get("closed")).toBe("terminal");
    expect(kinds.get("building")).toBe("normal");
  });
});

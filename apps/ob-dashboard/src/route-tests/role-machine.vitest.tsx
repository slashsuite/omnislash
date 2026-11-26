// Component tests (happy-dom). Named *.vitest.tsx so the repo-root `bun test` never matches them; `vitest run` includes them (vite.config.ts).
// @vitest-environment happy-dom
// OS-187: every state of the role machine JSON is drawn, and a ticket shows in the state it names.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RoleMachine } from "../components/RoleMachine.tsx";
import { roleDefinition } from "../lib/role-machine.ts";

const states = roleDefinition().states;

afterEach(cleanup);

describe("RoleMachine (OS-187)", () => {
  it("draws every state in the JSON, by its label", () => {
    render(<RoleMachine tickets={[]} />);
    const drawn = screen.getByRole("group", { name: "Role state machine" });
    expect(states.length).toBeGreaterThan(0);
    // Exact and case-sensitive: "Closed (ticket done)" must not pass on the "spike closed"
    // arrow. No arrow label equals a state label, so a match here is the state's own box.
    for (const s of states) expect(within(drawn).getAllByText(s.label).length).toBeGreaterThan(0);
  });

  it("puts a ticket's dot in its state", () => {
    render(<RoleMachine tickets={[{ ref: "OS-170", title: "Empty state", state: "owner_call" }]} />);
    // The dot is named after the box it sits in, so a wrong state (or the "Not in any state" box) fails here.
    expect(screen.getByRole("img", { name: "OS-170 Empty state, in Owner's call (verdict blocked or needs-human)" })).toBeTruthy();
  });

  it("keys every role in the legend, the owner on his own pinned colour (OS-237)", () => {
    render(<RoleMachine tickets={[]} />);
    const legend = screen.getByRole("list", { name: "Role state machine: roles" });
    const swatch = (role: string) => within(legend).getByText(role).previousElementSibling?.className ?? "";
    expect(swatch("owner")).toContain("text-orange-600");
    const roles = within(legend).getAllByRole("listitem").map((li) => li.textContent);
    expect(roles).toEqual(expect.arrayContaining(["owner", "muse", "architect", "builder", "reviewer", "sentinel", "system"]));
  });

  it("maps human states to human, the failed end to failed and the other ends to terminal", () => {
    const kinds = new Map(states.map((s) => [s.id, s.kind]));
    expect(kinds.get("owner_call")).toBe("human");
    expect(kinds.get("failed")).toBe("failed");
    expect(kinds.get("closed")).toBe("terminal");
    expect(kinds.get("building")).toBe("normal");
  });
});

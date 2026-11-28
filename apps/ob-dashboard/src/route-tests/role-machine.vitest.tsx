// Component tests (happy-dom). Named *.vitest.tsx so the repo-root `bun test` never matches them; `vitest run` includes them (vite.config.ts).
// @vitest-environment happy-dom
// OS-187, OS-308: the role machine as uislash's StateMachine graph (the Machine page): every state is drawn by its
// persona-named label, every move is an arrow, and a ticket's dot sits in the state it names.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RoleMachine } from "../components/RoleMachine.tsx";
import { roleDefinition } from "../lib/role-machine.ts";

const { states, transitions } = roleDefinition();

afterEach(cleanup);

describe("RoleMachine (OS-187, OS-308)", () => {
  it("draws all 21 states, by their persona-named labels", () => {
    render(<RoleMachine tickets={[]} />);
    const drawn = screen.getByRole("group", { name: "Role state machine" });
    expect(states).toHaveLength(21);
    // Exact and case-sensitive. No arrow label equals a state label, so a match here is the state's own box.
    for (const s of states) expect(within(drawn).getAllByText(s.label).length, s.id).toBeGreaterThan(0);
  });

  it("draws an arrow for every move, named by its plain move label", () => {
    render(<RoleMachine tickets={[]} />);
    const drawn = screen.getByRole("group", { name: "Role state machine" });
    expect(transitions.length).toBeGreaterThan(0);
    for (const t of transitions) expect(within(drawn).getAllByText(t.event!).length, `${t.from}->${t.to}`).toBeGreaterThan(0);
  });

  it("puts a ticket's dot in its state", () => {
    render(<RoleMachine tickets={[{ ref: "OS-170", title: "Empty state", state: "owner_call" }]} />);
    // The dot is named after the box it sits in, so a wrong state (or the "Not in any state" box) fails here.
    expect(screen.getByRole("img", { name: "OS-170 Empty state, in Owner answers the builder" })).toBeTruthy();
  });

  it("keys every persona in the legend, the owner on his own pinned colour", () => {
    render(<RoleMachine tickets={[]} />);
    const legend = screen.getByRole("list", { name: "Role state machine: roles" });
    const swatch = (role: string) => within(legend).getByText(role).previousElementSibling?.className ?? "";
    expect(swatch("owner")).toContain("text-orange-600");
    expect(swatch("builder")).toContain("text-pink-600");
    const roles = within(legend).getAllByRole("listitem").map((li) => li.textContent);
    expect(roles).toEqual(expect.arrayContaining(["owner", "muse", "architect", "builder", "reviewer", "sentinel", "system"]));
  });
});

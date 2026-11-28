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
    // The drawn box's own label (ui-react keys it `l:<id>`), not the visually hidden list that also names every state.
    for (const s of states) expect(drawn.querySelector(`[data-measure="l:${s.id}"]`)?.textContent, s.id).toBe(s.label);
  });

  it("draws an arrow for every move, named by its plain move label", () => {
    render(<RoleMachine tickets={[]} />);
    const drawn = screen.getByRole("group", { name: "Role state machine" });
    expect(transitions.length).toBeGreaterThan(0);
    // The arrow labels drawn on the graph (ui-react keys each `e:<index>`), not the hidden list's.
    const arrows = [...drawn.querySelectorAll('[data-measure^="e:"]')].map((el) => el.textContent);
    for (const t of transitions) expect(arrows, `${t.from}->${t.to}`).toContain(t.event);
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

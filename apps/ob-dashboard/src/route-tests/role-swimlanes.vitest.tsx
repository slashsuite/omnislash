// Component tests (happy-dom). Named *.vitest.tsx so the repo-root `bun test` never matches them; `vitest run` includes them (vite.config.ts).
// @vitest-environment happy-dom
// OS-261, OS-308: the role machine as persona swimlanes (the Overview page): every state under its stage and in its
// persona's lane, with its moves in plain words, and a ticket on the state it names.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoleSwimlanes } from "../components/RoleSwimlanes.tsx";
import { roleLanes } from "../lib/role-machine.ts";

const { states } = roleLanes();

afterEach(cleanup);

const card = (label: string) => screen.getByRole("region", { name: label });

describe("RoleSwimlanes (OS-261)", () => {
  it("draws every state once, by its label, in its stage", () => {
    render(<RoleSwimlanes tickets={[]} />);
    const drawn = screen.getByRole("figure", { name: "Persona swimlanes" });
    expect(states).toHaveLength(21);
    for (const s of states) {
      expect(within(drawn).getAllByRole("region", { name: s.label })).toHaveLength(1);
      const stage = screen.getByRole("group", { name: `${s.stage[0]!.toUpperCase()}${s.stage.slice(1)} stage` });
      expect(within(stage).getByRole("region", { name: s.label }), s.id).toBeTruthy();
    }
    for (const name of ["Idea", "Plan", "Build", "Ship", "Done"]) expect(screen.getByRole("heading", { name })).toBeTruthy();
  });

  it("lists each state's moves in plain words, with the persona that makes each", () => {
    render(<RoleSwimlanes tickets={[]} />);
    const moves = within(card("Architect shapes the ticket")).getByRole("list", { name: "Moves from Architect shapes the ticket" });
    expect(moves.textContent).toContain("send for brief check, by the architect, → Reviewer checks the brief for gaps");
    const back = within(card("Reviewer checks the brief for gaps")).getByRole("list", { name: /^Moves from/ });
    expect(back.textContent).toContain("gaps found, revise, by the reviewer, → Architect shapes the ticket");
    // The two ends have no moves.
    expect(within(card("Shipped")).queryByRole("list", { name: /^Moves from/ })).toBeNull();
    expect(within(card("Architect called it off, or it failed to start")).queryByRole("list", { name: /^Moves from/ })).toBeNull();
  });

  it("puts a ticket on its state with a live count, and opens it or its state's list on a click", () => {
    const onOpenState = vi.fn();
    const onOpenTicket = vi.fn();
    const tickets = [
      { ref: "OS-170", title: "Empty state", state: "owner_call" },
      ...Array.from({ length: 8 }, (_, i) => ({ ref: `OS-${300 + i}`, title: `Backlog ${i}`, state: "backlog" })),
    ];
    render(<RoleSwimlanes tickets={tickets} onOpenState={onOpenState} onOpenTicket={onOpenTicket} />);
    const owner = card("Owner answers the builder");
    expect(within(owner).getByLabelText("1 ticket")).toBeTruthy();
    fireEvent.click(within(owner).getByRole("button", { name: "OS-170 Empty state, in Owner answers the builder" }));
    expect(onOpenTicket).toHaveBeenCalledWith("OS-170");
    const backlog = card("Waiting for the architect");
    expect(within(backlog).getByLabelText("8 tickets")).toBeTruthy();
    expect(within(backlog).getAllByRole("button", { name: /, in Waiting for the architect$/ })).toHaveLength(6);
    fireEvent.click(within(backlog).getByRole("button", { name: "2 more in Waiting for the architect" }));
    expect(onOpenState).toHaveBeenCalledWith("backlog");
    fireEvent.click(within(owner).getByRole("button", { name: "List the tickets in Owner answers the builder" }));
    expect(onOpenState).toHaveBeenCalledWith("owner_call");
    // An empty state has no list to open.
    expect(within(card("Builder builds")).getByLabelText("0 tickets")).toBeTruthy();
    expect(within(card("Builder builds")).queryByRole("button", { name: /^List the tickets/ })).toBeNull();
  });

});

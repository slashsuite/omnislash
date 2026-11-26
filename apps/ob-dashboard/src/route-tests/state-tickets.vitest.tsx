// Component tests (happy-dom). Named *.vitest.tsx so the repo-root `bun test` never matches them; `vitest run` includes them (vite.config.ts).
// @vitest-environment happy-dom
// OS-241: every state's tickets are listed by ref and title under its count, and each opens the item drawer.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateTickets } from "../components/StateTickets.tsx";
import type { MachineRow } from "../lib/machine.ts";
import { roleDefinition } from "../lib/role-machine.ts";

const states = roleDefinition().states;
const tickets: MachineRow[] = [
  { id: null, itemId: "i1", ref: "OS-1", title: "First open", state: "drilling" },
  { id: null, itemId: "i2", ref: "OS-2", title: "Second open", state: "drilling" },
  { id: null, itemId: "i3", ref: "OS-3", title: "Owner decides", state: "owner_plan_call" },
  { id: 7, itemId: "i4", ref: "OS-4", title: "Being built", state: "building" },
];

afterEach(cleanup);

describe("StateTickets (OS-241)", () => {
  it("lists each state that holds tickets with its count, and every ticket by ref and title once opened", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<StateTickets states={states} tickets={tickets} open={new Set()} onToggle={onToggle} onOpenTicket={() => {}} />);
    const drilling = screen.getByRole("button", { name: /^Architect shapes the ticket/ });
    expect(drilling.textContent).toContain("2");
    expect(screen.getByRole("button", { name: /^Owner answers a planning question/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Builder builds/ })).toBeTruthy();
    // A state with no tickets gets no list.
    expect(screen.queryByRole("button", { name: /^Reviewer cold-reads the brief/ })).toBeNull();
    fireEvent.click(drilling);
    expect(onToggle).toHaveBeenCalledWith("drilling", true);

    const onOpenTicket = vi.fn();
    rerender(<StateTickets states={states} tickets={tickets} open={new Set(["drilling"])} onToggle={onToggle} onOpenTicket={onOpenTicket} />);
    expect(screen.getByRole("button", { name: "OS-1 First open" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OS-2 Second open" }));
    expect(onOpenTicket).toHaveBeenCalledWith("i2");
    // The other states stay closed.
    expect(screen.queryByRole("button", { name: "OS-3 Owner decides" })).toBeNull();
  });
});

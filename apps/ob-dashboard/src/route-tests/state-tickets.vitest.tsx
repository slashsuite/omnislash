// Component tests (happy-dom). Named *.vitest.tsx so the repo-root `bun test` never matches them; `vitest run` includes them (vite.config.ts).
// @vitest-environment happy-dom
// OS-241: every state's tickets are listed by ref and title under its count, each opens the item drawer, and a
// click in a state's box of the diagram names that state.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boxOfClick, StateTickets } from "../components/StateTickets.tsx";
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
    const drilling = screen.getByRole("button", { name: /Drilling/ });
    expect(drilling.textContent).toContain("2");
    expect(screen.getByRole("button", { name: /Planning call only the owner can make/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Building/ })).toBeTruthy();
    // A state with no tickets gets no list.
    expect(screen.queryByRole("button", { name: /Blind check/ })).toBeNull();
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

describe("boxOfClick (OS-241)", () => {
  it("names the state whose box was clicked, and nothing for a click on a button inside it or outside any box", () => {
    const box = document.createElement("div");
    box.setAttribute("data-measure", "n:checking");
    box.innerHTML = "<span>label</span><button>dot</button>";
    document.body.append(box);
    expect(boxOfClick(box.querySelector("span"))).toBe("checking");
    expect(boxOfClick(box.querySelector("button"))).toBeNull();
    expect(boxOfClick(document.body)).toBeNull();
    box.remove();
  });

  it("names the state of a uniform box, whose frame carries no key and holds its label's (OS-260)", () => {
    const frame = document.createElement("div");
    frame.innerHTML = '<div data-measure="l:backlog">Backlog</div><div data-measure="c:backlog"><i>dots</i><button>dot</button></div>';
    document.body.append(frame);
    expect(boxOfClick(frame)).toBe("backlog");
    expect(boxOfClick(frame.querySelector('[data-measure="l:backlog"]'))).toBe("backlog");
    expect(boxOfClick(frame.querySelector("i"))).toBe("backlog");
    expect(boxOfClick(frame.querySelector("button"))).toBeNull();
    frame.remove();
  });
});

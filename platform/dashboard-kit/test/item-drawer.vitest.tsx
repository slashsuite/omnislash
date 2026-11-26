// Component tests (happy-dom). Named *.vitest.tsx so `bun test` never matches them; `vitest run` includes them (vitest.config.ts).
// @vitest-environment happy-dom
// OB-1939: the item drawer shows nothing of the previous item while the next loads, offers only the
// buttons the server accepts, and ignores a transition result that arrives after a switch.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// OB-2204: the drawer takes its three server functions as props, so these are plain stubs, not a module mock.
import { ItemDrawer } from "../src/components/ItemDrawer.tsx";
import type { ItemDetail } from "../src/lib/types.ts";

const getItem = vi.fn();
const transitionItem = vi.fn();
const setTodayRank = vi.fn();
const fns = { getItem, transitionItem, setTodayRank };

function detail(over: Partial<ItemDetail>): ItemDetail {
  return {
    id: "1",
    type: "task",
    title: "an item",
    status: "open",
    priority: null,
    effective_priority: "p2",
    today_rank: null,
    project: null,
    kind: null,
    block_reason: null,
    block_owner: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    closed_at: null,
    body: null,
    tags: [],
    links: [],
    linear: null,
    detail: null,
    events: [],
    prs: [],
    valid_next: [],
    ...over,
  };
}

const byId: Record<string, ItemDetail> = {};
beforeEach(() => {
  for (const k of Object.keys(byId)) delete byId[k];
  getItem.mockReset();
  transitionItem.mockReset();
  setTodayRank.mockReset();
  getItem.mockImplementation(async ({ data }: { data: { id: string } }) => byId[data.id]);
});
afterEach(cleanup);

// The drawer's own icon close button has no text; the action buttons are the ones with a visible label.
const names = () => screen.queryAllByRole("button").map((b) => b.textContent ?? "").filter((t) => t !== "");
const btn = (n: string) => screen.getAllByRole("button").find((b) => b.textContent === n)!;
const has = (n: string) => screen.queryAllByRole("button").some((b) => b.textContent === n);

async function open(id: string) {
  const view = render(<ItemDrawer itemId={id} onClose={() => {}} {...fns} />);
  await screen.findByText(byId[id]!.title);
  return view;
}

describe("switching items", () => {
  it("shows no A title or buttons while B loads, then B's", async () => {
    byId.A = detail({ id: "A", title: "Item A", status: "open", valid_next: ["in_progress"] });
    byId.B = detail({ id: "B", title: "Item B", status: "ready", valid_next: ["done"] });
    const view = await open("A");
    expect(has("Start")).toBe(true);

    let resolveB!: (d: ItemDetail) => void;
    getItem.mockImplementationOnce(() => new Promise<ItemDetail>((r) => (resolveB = r)));
    view.rerender(<ItemDrawer itemId="B" onClose={() => {}} {...fns} />);

    expect(screen.queryByText("Item A")).toBeNull();
    expect(has("Start")).toBe(false);
    expect(screen.getByText("Loading…")).toBeTruthy();

    await act(async () => resolveB(byId.B!));
    expect(await screen.findByText("Item B")).toBeTruthy();
    expect(has("Close")).toBe(true);
    expect(has("Start")).toBe(false);
  });

  it("a transition on A that resolves after the switch does not replace B", async () => {
    byId.A = detail({ id: "A", title: "Item A", status: "open", valid_next: ["in_progress"] });
    byId.B = detail({ id: "B", title: "Item B", status: "ready", valid_next: ["done"] });
    let resolveA!: (d: ItemDetail) => void;
    transitionItem.mockImplementation(() => new Promise<ItemDetail>((r) => (resolveA = r)));
    const view = await open("A");
    await act(async () => void fireEvent.click(btn("Start")));

    view.rerender(<ItemDrawer itemId="B" onClose={() => {}} {...fns} />);
    expect(await screen.findByText("Item B")).toBeTruthy();

    await act(async () => resolveA(detail({ id: "A", title: "Item A", status: "in_progress", valid_next: ["ready"] })));
    expect(screen.getByText("Item B")).toBeTruthy();
    expect(screen.queryByText("Item A")).toBeNull();
    expect(has("Close")).toBe(true);
    expect(has("Ready")).toBe(false);
  });
});

describe("button sets", () => {
  it("a done item shows Reopen, sent as reopen", async () => {
    byId.D = detail({ id: "D", title: "Done one", status: "done", valid_next: ["open"] });
    transitionItem.mockResolvedValue(byId.D);
    await open("D");
    expect(names()).toEqual(["Reopen", "Add to Today"]);
    await act(async () => void fireEvent.click(btn("Reopen")));
    expect(transitionItem).toHaveBeenCalledWith({ data: { id: "D", action: "reopen" } });
  });

  it("an in_progress item shows no Reopen, and Back to open moves to open", async () => {
    byId.X = detail({ id: "X", title: "Mid", status: "in_progress", valid_next: ["open", "done"] });
    transitionItem.mockResolvedValue(byId.X);
    await open("X");
    expect(has("Reopen")).toBe(false);
    await act(async () => void fireEvent.click(btn("Back to open")));
    expect(transitionItem).toHaveBeenCalledWith({ data: { id: "X", action: "move", to: "open" } });
  });

  it("a blocked item shows Unblock first and no Reopen", async () => {
    byId.K = detail({
      id: "K",
      title: "Stuck",
      status: "blocked",
      block_reason: "waiting",
      valid_next: ["open", "in_progress", "ready", "done"],
    });
    transitionItem.mockResolvedValue(byId.K);
    await open("K");
    expect(names()).toEqual(["Unblock", "Back to open", "Start", "Ready", "Close", "Add to Today"]);
    await act(async () => void fireEvent.click(btn("Unblock")));
    expect(transitionItem).toHaveBeenCalledWith({ data: { id: "K", action: "unblock" } });
    await act(async () => void fireEvent.click(btn("Start")));
    expect(transitionItem).toHaveBeenCalledWith({ data: { id: "K", action: "start" } });
  });

  it("a linear_ref at qa_ready shows QA and sends a move to qa", async () => {
    byId.L = detail({ id: "L", type: "linear_ref", title: "Linear", status: "qa_ready", valid_next: ["qa", "blocked", "done"] });
    transitionItem.mockResolvedValue(byId.L);
    await open("L");
    expect(has("QA")).toBe(true);
    expect(has("Block…")).toBe(true);
    await act(async () => void fireEvent.click(btn("QA")));
    expect(transitionItem).toHaveBeenCalledWith({ data: { id: "L", action: "move", to: "qa" } });
  });

  it("merged, qa_ready and an unknown status get a button too", async () => {
    byId.M = detail({ id: "M", title: "Ready one", status: "ready", valid_next: ["merged", "qa_ready", "weird"] });
    transitionItem.mockResolvedValue(byId.M);
    await open("M");
    expect(names().slice(0, 3)).toEqual(["Merged", "QA ready", "weird"]);
    await act(async () => void fireEvent.click(btn("weird")));
    expect(transitionItem).toHaveBeenCalledWith({ data: { id: "M", action: "move", to: "weird" } });
  });
});

describe("start, close and rank go through the passed functions", () => {
  it("Start sends start, Close sends close, Add to Today sends the rank", async () => {
    byId.S = detail({ id: "S", title: "Do it", status: "open", valid_next: ["in_progress", "done"] });
    transitionItem.mockImplementation(async ({ data }: { data: { action: string } }) =>
      detail({ id: "S", title: "Do it", status: data.action === "start" ? "in_progress" : "done", valid_next: ["done"] }),
    );
    setTodayRank.mockResolvedValue(detail({ id: "S", title: "Do it", status: "done", today_rank: 3 }));
    await open("S");

    await act(async () => void fireEvent.click(btn("Start")));
    expect(transitionItem).toHaveBeenLastCalledWith({ data: { id: "S", action: "start" } });
    expect(await screen.findByText("in_progress")).toBeTruthy();

    await act(async () => void fireEvent.click(btn("Close")));
    expect(transitionItem).toHaveBeenLastCalledWith({ data: { id: "S", action: "close" } });

    fireEvent.change(screen.getByLabelText("today rank"), { target: { value: "3" } });
    await act(async () => void fireEvent.click(btn("Add to Today")));
    expect(setTodayRank).toHaveBeenCalledWith({ data: { id: "S", rank: 3 } });
    expect(await screen.findByText("rank 3")).toBeTruthy();
  });
});

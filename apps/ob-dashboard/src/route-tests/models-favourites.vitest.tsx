// Route component tests (happy-dom). Named *.vitest.tsx so the repo-root `bun test` never matches them; `vitest run` includes them (vite.config.ts).
// @vitest-environment happy-dom
// OS-240: every model on the Models page is a dropdown of the T3 favourites the server sends, a chain is built by
// adding, reordering and removing rows, a stored model that is not a favourite still shows (marked), and a save
// writes the provider-prefixed ids.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveModels = vi.hoisted(() => vi.fn());
vi.mock("../server/models.ts", () => ({ getModels: vi.fn(), saveModels }));
vi.mock("@tanstack/react-router", async (orig) => ({ ...(await orig<typeof import("@tanstack/react-router")>()), useNavigate: () => vi.fn() }));

import { Route } from "../routes/models.tsx";
import type { ModelsPage, ModelsView } from "../server/models.ts";

const Models = Route.options.component as (() => React.ReactElement) & { preload?: () => Promise<void> };
await Models.preload?.();

const FAVOURITES = ["claudeAgent:claude-opus-5-5", "antigravity:gemini-4-neon", "claudeAgent:claude-sonnet-5-5"];

function view(): ModelsView {
  return {
    file: { path: "/host/models.jsonc", present: false },
    active: { name: "claude", source: "server" } as ModelsView["active"],
    order: ["claude"],
    profiles: ["claude"],
    profile: "claude",
    routes: [
      { route: "job.nightly", chain: ["claude-opus-5-5"], effort: null, source: "server", label: "server", server: { chain: ["claude-opus-5-5"], effort: null } },
      { route: "checker", chain: ["claude-haiku-5-5"], effort: null, source: "default", label: "default", server: null },
    ],
    builder: { bands: [{ from: 1, to: 10, chain: ["claudeAgent:claude-opus-5-5"], effort: null, source: "server" }], local: false },
    review: { source: "server", value: { readers: { opus: { model: "claude-opus-5-5" } }, tiers: [{ from: 1, to: 10, legs: ["opus"] }] }, local: {} } as ModelsView["review"],
    efforts: ["low", "high"],
  };
}

function show(favourites: string[] | null) {
  const page: ModelsPage = { view: view(), notes: [], credit: null, favourites: favourites && { models: favourites, synced_at: "2026-11-26T08:00:00.000Z" } };
  vi.spyOn(Route, "useLoaderData").mockReturnValue(page as never);
  return render(<Models />);
}

const route = (name: string) => screen.getByRole("article", { name });
const options = (el: HTMLElement) => [...(el as HTMLSelectElement).options].map((o) => o.textContent);

beforeEach(() => {
  saveModels.mockReset();
  saveModels.mockImplementation(async () => ({ ok: true, view: view() }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the model dropdowns (OS-240)", () => {
  it("offer the favourites from the server, and keep a stored model that is not one, marked", () => {
    show(FAVOURITES);
    const first = within(route("job.nightly")).getByRole("combobox", { name: "Model 1 for job.nightly" });
    expect((first as HTMLSelectElement).value).toBe("claude-opus-5-5");
    expect(options(first)).toEqual(["claude-opus-5-5 (not a favourite)", ...FAVOURITES]);
    const builder = screen.getByRole("combobox", { name: "Model 1 for builder row 1" });
    expect(options(builder)).toEqual(FAVOURITES);
    const reader = screen.getByRole("combobox", { name: "Model for reader opus" });
    expect(options(reader)).toEqual(["claude-opus-5-5 (not a favourite)", ...FAVOURITES]);
    expect(screen.getByText(/Models are picked from your 3 T3 favourites/)).toBeTruthy();
  });

  it("build a chain by rows and save it as provider-prefixed ids", async () => {
    show(FAVOURITES);
    const r = within(route("job.nightly"));
    fireEvent.change(r.getByRole("combobox", { name: "Model 1 for job.nightly" }), { target: { value: "claudeAgent:claude-sonnet-5-5" } });
    fireEvent.click(r.getByRole("button", { name: "Add a model to job.nightly" }));
    expect((r.getByRole("combobox", { name: "Model 2 for job.nightly" }) as HTMLSelectElement).value).toBe("claudeAgent:claude-opus-5-5");
    fireEvent.click(r.getByRole("button", { name: "Add a model to job.nightly" }));
    fireEvent.click(r.getByRole("button", { name: "Move model 3 for job.nightly up" }));
    fireEvent.click(r.getByRole("button", { name: "Remove model 1 for job.nightly" }));
    await act(async () => {
      fireEvent.click(r.getByRole("button", { name: "Save job.nightly" }));
    });
    expect(saveModels).toHaveBeenCalledWith({ data: { op: "setRoute", profile: "claude", route: "job.nightly", chain: "antigravity:gemini-4-neon, claudeAgent:claude-opus-5-5" } });
  });

  it("save a reader and a builder range with the picked provider-prefixed model", async () => {
    show(FAVOURITES);
    fireEvent.change(screen.getByRole("combobox", { name: "Model for reader opus" }), { target: { value: "claudeAgent:claude-opus-5-5" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save reader opus" }));
    });
    expect(saveModels).toHaveBeenLastCalledWith({ data: { op: "readerAdd", profile: "claude", leg: "opus", model: "claudeAgent:claude-opus-5-5" } });

    fireEvent.click(screen.getByRole("button", { name: "Add a model to builder row 1" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save builder ranges" }));
    });
    expect(saveModels).toHaveBeenLastCalledWith({
      data: { op: "builderRanges", profile: "claude", ranges: [{ from: 1, to: 10, chain: "claudeAgent:claude-opus-5-5, antigravity:gemini-4-neon" }] },
    });
  });

  it("say how to sync when the server has no favourites, and still show what is stored", () => {
    show(null);
    expect(screen.getByText("No T3 favourite models synced yet")).toBeTruthy();
    const first = screen.getByRole("combobox", { name: "Model 1 for job.nightly" });
    expect(options(first)).toEqual(["claude-opus-5-5 (not a favourite)"]);
    expect((screen.getByRole("button", { name: "Add a model to job.nightly" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

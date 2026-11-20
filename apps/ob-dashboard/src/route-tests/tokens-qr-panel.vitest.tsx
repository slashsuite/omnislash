// Route component tests (happy-dom). Named *.vitest.tsx so the repo-root `bun test` never matches them; `vitest run` includes them (vite.config.ts).
// @vitest-environment happy-dom
// OB-1942: the pairing panel's poll stops while the tab is hidden, a slow read cannot overwrite the newer
// one that replaced it, and the Start outcome line goes away when the panel moves on.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWhatsappQr = vi.hoisted(() => vi.fn());
const startWhatsappPairing = vi.hoisted(() => vi.fn());
vi.mock("../server/tokens.ts", () => ({
  getCredentials: vi.fn(),
  getWhatsappQr,
  startWhatsappPairing,
  checkCredential: vi.fn(),
  setCredential: vi.fn(),
}));

import { Route } from "../routes/tokens.tsx";
import type { WhatsappQrView } from "../lib/whatsappQr.ts";

// `Tokens` is not exported (an extra export stops the router code-splitting the route), so it is reached
// through the route and preloaded once. Module scope, not a `beforeAll` (OB-2066): the first load of the
// split chunk is a cold Vite transform of this route file plus its module evaluation, which scales with
// machine load and outran vitest's 10 s ceiling on hooks at load 93. A test module's own import has none.
const Tokens = Route.options.component as (() => React.ReactElement) & { preload?: () => Promise<void> };
await Tokens.preload?.();

function view(state: WhatsappQrView["state"], over: Partial<WhatsappQrView> = {}): WhatsappQrView {
  return {
    state,
    image: state === "live" ? "data:image/png;base64,AAA" : null,
    emitted_at: null,
    age_s: state === "live" ? 3 : null,
    detail: "",
    insecure_mode: false,
    path: "/store/qr.json",
    ...over,
  };
}

const LIVE = "Scan this now";
const EXPIRED = "This code has expired";
const PAIRED = "Paired";

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Show the page with one initial QR read, and no stored credential (so `linked` is false). */
function show(qr: WhatsappQrView) {
  vi.spyOn(Route, "useLoaderData").mockReturnValue({ credentials: [], qr } as never);
  return render(<Tokens />);
}

/** Let the panel's promises settle and state flush, with fake timers in place. */
const settle = async () => {
  await act(async () => {});
};
const tick = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await settle();
};

/** Point `document.visibilityState` at a value and tell the page about it. */
function visibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  getWhatsappQr.mockReset();
  getWhatsappQr.mockResolvedValue(view("live"));
  startWhatsappPairing.mockReset();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the poll while the tab is hidden (OB-1942)", () => {
  it("stops, and reads again the moment the tab comes back", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    show(view("live"));
    await settle();
    await tick(30_000);
    expect(getWhatsappQr).not.toHaveBeenCalled();

    // Coming back is not one interval away: the code on screen was read before the tab went away.
    await act(async () => visibility("visible"));
    await settle();
    expect(getWhatsappQr).toHaveBeenCalledTimes(1);
    await tick(5_000);
    expect(getWhatsappQr).toHaveBeenCalledTimes(2);
  });
});

describe("an out-of-order poll response (OB-1942)", () => {
  it("does not let a slow older read replace the newer one already applied", async () => {
    const first = deferred<WhatsappQrView>();
    const second = deferred<WhatsappQrView>();
    getWhatsappQr.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    show(view("live"));
    await settle();

    await tick(5_000); // poll 1 goes out
    await tick(5_000); // poll 2 goes out before 1 has resolved
    expect(getWhatsappQr).toHaveBeenCalledTimes(2);

    await act(async () => second.resolve(view("expired")));
    expect(screen.getByText(new RegExp(EXPIRED))).toBeTruthy();

    // The older read lands late: it must be dropped, not painted over the newer state.
    await act(async () => first.resolve(view("paired")));
    expect(screen.getByText(new RegExp(EXPIRED))).toBeTruthy();
    expect(screen.queryByText(new RegExp(PAIRED))).toBeNull();
  });

  it("does not paint an old read's failure over the newer state either", async () => {
    const first = deferred<WhatsappQrView>();
    const second = deferred<WhatsappQrView>();
    getWhatsappQr.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    show(view("live"));
    await settle();
    await tick(5_000);
    await tick(5_000);
    await act(async () => second.resolve(view("expired")));
    await act(async () => first.reject(new Error("the pairing read failed")));
    expect(screen.queryByText(/the pairing read failed/)).toBeNull();
    expect(screen.getByText(new RegExp(EXPIRED))).toBeTruthy();
  });
});

describe("the Start outcome line (OB-1942)", () => {
  it("is gone once a poll returns a different QR state", async () => {
    startWhatsappPairing.mockResolvedValue({
      ok: true,
      message: "Started the WhatsApp bridge.",
      qr: view("unset"),
    });
    show(view("unset"));
    await settle();

    await act(async () => {
      screen.getByRole("button", { name: "Start pairing" }).click();
    });
    await settle();
    expect(screen.getByText("Started the WhatsApp bridge.")).toBeTruthy();

    getWhatsappQr.mockResolvedValue(view("live"));
    await tick(20_000); // the idle cadence: a QR appeared
    expect(screen.getByText(new RegExp(LIVE))).toBeTruthy();
    expect(screen.queryByText("Started the WhatsApp bridge.")).toBeNull();
  });

  it("stays while the state it was shown against is still the one on screen", async () => {
    startWhatsappPairing.mockResolvedValue({
      ok: false,
      message: "The session is already live, so there is nothing to pair.",
      qr: view("live"),
    });
    show(view("unset"));
    await settle();
    await act(async () => {
      screen.getByRole("button", { name: "Start pairing" }).click();
    });
    await settle();
    expect(screen.getByText("The session is already live, so there is nothing to pair.")).toBeTruthy();
    getWhatsappQr.mockResolvedValue(view("live"));
    await tick(5_000);
    expect(screen.getByText("The session is already live, so there is nothing to pair.")).toBeTruthy();
  });
});

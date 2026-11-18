// Component tests (happy-dom). Named *.vitest.tsx so `bun test` never matches them; `vitest run` includes them (vitest.config.ts).
// @vitest-environment happy-dom
// OB-1944: useRealtime drops a snapshot older than the one it holds, and reconnects with a backoff.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRealtime } from "../src/lib/useRealtime.ts";
import type { Snapshot } from "../src/lib/types.ts";

/** A WebSocket the test drives by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  close() {}
  open() {
    this.onopen?.();
  }
  drop() {
    this.onclose?.();
  }
  push(at: string, alertCount = 0) {
    this.onmessage?.({ data: JSON.stringify({ type: "snapshot", data: snap(at, alertCount) }) });
  }
}

const snap = (at: string, alertCount = 0) => ({ at, alertCount }) as unknown as Snapshot;

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

describe("useRealtime ordering (OB-1944)", () => {
  it("ignores a pushed snapshot older than the one it holds, and takes a newer one", () => {
    const { result } = renderHook(() => useRealtime());
    act(() => last().push("2026-11-12T10:00:05.000Z", 5));
    expect(result.current.snap?.alertCount).toBe(5);
    act(() => last().push("2026-11-12T10:00:01.000Z", 1)); // read earlier, delivered late
    expect(result.current.snap?.alertCount).toBe(5);
    act(() => last().push("2026-11-12T10:00:09.000Z", 9));
    expect(result.current.snap?.alertCount).toBe(9);
  });

  it("after adopt(next), a push older than next.at is ignored and a newer one is taken", () => {
    const { result } = renderHook(() => useRealtime());
    act(() => last().push("2026-11-12T10:00:00.000Z", 0));
    act(() => result.current.adopt(snap("2026-11-12T10:00:10.000Z", 7)));
    expect(result.current.snap?.alertCount).toBe(7);
    act(() => last().push("2026-11-12T10:00:08.000Z", 0)); // read before the write, delivered after
    expect(result.current.snap?.alertCount).toBe(7);
    act(() => last().push("2026-11-12T10:00:12.000Z", 8));
    expect(result.current.snap?.alertCount).toBe(8);
  });
});

describe("useRealtime reconnect backoff (OB-1944)", () => {
  /** Drop the current socket and return how long the hook waited before dialling again. */
  const dropAndMeasure = (maxMs = 40_000) => {
    const before = FakeSocket.all.length;
    act(() => last().drop());
    for (let ms = 0; ms <= maxMs; ms += 500) {
      if (FakeSocket.all.length > before) return ms;
      act(() => void vi.advanceTimersByTime(500));
    }
    return Infinity;
  };

  it("waits 1, 2, 4, 8, 16, 30, 30 s across repeated failures, and 1 s again after an open", () => {
    renderHook(() => useRealtime());
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) waits.push(dropAndMeasure());
    // Measured on a 500 ms grid: the redial happens in the step that crosses the delay.
    expect(waits.map((w) => w / 1000)).toEqual([1, 2, 4, 8, 16, 30, 30]);
    act(() => last().open());
    expect(dropAndMeasure() / 1000).toBe(1);
  });

  it("reports connected from open to close", () => {
    const { result } = renderHook(() => useRealtime());
    expect(result.current.connected).toBe(false);
    act(() => last().open());
    expect(result.current.connected).toBe(true);
    act(() => last().drop());
    expect(result.current.connected).toBe(false);
  });
});

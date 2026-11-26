import { describe, expect, test } from "bun:test";
import {
  defaultReviewReaders,
  fallbackOf,
  parseReviewReaders,
  readersForComplexity,
  withFallback,
  withReader,
  withoutReader,
  ReviewReadersError,
} from "../../../apps/cli/src/review-readers.ts";

// The fallback a reader runs when it is unavailable is a setting (per reader), not a constant: the default is
// no fallback (readers are Opus only, OS-256), and the dashboard or `ob review readers fallback` sets or clears it.
describe("configurable review fallbacks", () => {
  test("OS-256: the default gives no reader a fallback, so neon never stands in for opus", () => {
    const v = defaultReviewReaders();
    expect(fallbackOf(v, "opus")).toBeNull();
    expect(fallbackOf(v, "neon")).toBeNull();
    expect(readersForComplexity(v, 5).find((r) => r.leg === "opus")!.fallback).toBeNull();
  });

  test("a fallback is set, changed and cleared, and changing a model keeps it", () => {
    let v = withFallback(defaultReviewReaders(), "neon", "opus");
    expect(fallbackOf(v, "neon")).toBe("opus");
    v = withReader(v, "neon", "antigravity:gemini-4-neon-2");
    expect(fallbackOf(v, "neon")).toBe("opus");
    v = withFallback(v, "neon", null);
    expect(fallbackOf(v, "neon")).toBeNull();
  });

  test("a fallback must name another reader that exists", () => {
    expect(() => withFallback(defaultReviewReaders(), "opus", "opus")).toThrow(/cannot fall back to itself/);
    expect(() => withFallback(defaultReviewReaders(), "opus", "qwen")).toThrow(/is not a reader/);
    expect(() => withFallback(defaultReviewReaders(), "ghost", "neon")).toThrow(ReviewReadersError);
  });

  test("the stored setting carries the fallback and refuses one that names no reader", () => {
    const ok = parseReviewReaders(
      JSON.stringify({
        readers: { neon: { model: "antigravity:gemini-4-neon" }, opus: { model: "claude-opus-5-5", fallback: "neon" } },
        tiers: [{ from: 1, to: 10, legs: ["neon", "opus"] }],
      }),
    );
    expect(fallbackOf(ok, "opus")).toBe("neon");
    expect(() =>
      parseReviewReaders(
        JSON.stringify({
          readers: { opus: { model: "claude-opus-5-5", fallback: "neon" } },
          tiers: [{ from: 1, to: 10, legs: ["opus"] }],
        }),
      ),
    ).toThrow(/falls back to 'neon', which is not a reader/);
  });

  test("removing a reader clears any fallback that named it", () => {
    const v = withoutReader(withFallback(defaultReviewReaders(), "opus", "neon"), "neon");
    expect(fallbackOf(v, "opus")).toBeNull();
  });
});

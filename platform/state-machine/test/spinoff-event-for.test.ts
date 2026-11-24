import { describe, expect, test } from "vitest";
import { SPINOFF_EDGES, spinoffEventFor, type SpinoffState } from "../src/spinoff.ts";

// OS-169: the reverse lookup on the spinoff edge table, used by the shadow check and SpinoffTransitionRefused.
describe("spinoffEventFor", () => {
  test("every edge maps back to its own event", () => {
    for (const [from, edges] of Object.entries(SPINOFF_EDGES) as [SpinoffState, Record<string, string>][]) {
      for (const [event, to] of Object.entries(edges)) expect(spinoffEventFor(from, to)).toBe(event);
    }
  });

  test("the launched self-move is the stamp edge", () => {
    expect(spinoffEventFor("launched", "launched")).toBe("stamp");
  });

  test("no edge, an unknown status or a missing row gives null", () => {
    expect(spinoffEventFor("failed", "launched")).toBeNull();
    expect(spinoffEventFor("pending", "pending")).toBeNull();
    expect(spinoffEventFor("building", "launched")).toBeNull();
    expect(spinoffEventFor("toString", "launched")).toBeNull();
    expect(spinoffEventFor(null, "launched")).toBeNull();
  });
});

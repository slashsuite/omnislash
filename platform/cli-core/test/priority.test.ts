import { describe, expect, test } from "bun:test";
import {
  effectivePriority,
  kindRank,
  parsePriority,
  priorityName,
  prioritySortRank,
  PRIORITY_HIGH,
  PRIORITY_NONE,
} from "../../../apps/cli/src/priority.ts";

describe("parsePriority", () => {
  test("friendly names", () => {
    expect(parsePriority("none")).toBe(0);
    expect(parsePriority("urgent")).toBe(1);
    expect(parsePriority("high")).toBe(2);
    expect(parsePriority("medium")).toBe(3);
    expect(parsePriority("low")).toBe(4);
    expect(parsePriority("flake")).toBe(5);
    expect(parsePriority("FLAKE")).toBe(5);
    expect(parsePriority("HIGH")).toBe(2);
    expect(parsePriority("critical")).toBe(6);
    expect(parsePriority("CRITICAL")).toBe(6);
  });
  test("ints", () => {
    expect(parsePriority("2")).toBe(2);
    expect(parsePriority("0")).toBe(0);
    expect(parsePriority("5")).toBe(5);
    expect(parsePriority("6")).toBe(6);
  });
  test("invalid", () => {
    expect(parsePriority("bogus")).toBeNull();
    expect(parsePriority("9")).toBeNull();
    expect(parsePriority("7")).toBeNull();
  });
});

describe("priorityName", () => {
  test("maps back", () => {
    expect(priorityName(2)).toBe("high");
    expect(priorityName(5)).toBe("flake");
    expect(priorityName(6)).toBe("critical");
    expect(priorityName(null)).toBe("none");
  });
});

describe("prioritySortRank", () => {
  test("none sorts last, urgent first", () => {
    expect(prioritySortRank(1)).toBeLessThan(prioritySortRank(4));
    expect(prioritySortRank(PRIORITY_NONE)).toBeGreaterThan(prioritySortRank(4));
  });
});

describe("kindRank", () => {
  test("side outranks the rest", () => {
    expect(kindRank("side")).toBeLessThan(kindRank("home"));
    expect(kindRank("learning")).toBeLessThan(kindRank(null));
  });
});

describe("effectivePriority", () => {
  test("explicit priority wins", () => {
    expect(effectivePriority({ priority: 1, projectId: "p", focusProject: "p" })).toBe(1);
  });
  test("focus project derives High when no explicit priority", () => {
    expect(effectivePriority({ priority: null, projectId: "p", focusProject: "p" })).toBe(
      PRIORITY_HIGH,
    );
  });
  test("non-focus project derives None", () => {
    expect(effectivePriority({ priority: null, projectId: "p", focusProject: "other" })).toBe(
      PRIORITY_NONE,
    );
    expect(effectivePriority({ priority: null, projectId: "p", focusProject: null })).toBe(
      PRIORITY_NONE,
    );
  });
});

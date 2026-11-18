import { describe, expect, test } from "bun:test";
import { canTransition, isValidStatus, statusVocab } from "../../../apps/cli/src/status.ts";

describe("statusVocab", () => {
  test("linear_ref gets the full lifecycle", () => {
    const v = statusVocab("linear_ref", null);
    expect(v).toContain("qa_ready");
    expect(v).toContain("merged");
    expect(v).toContain("qa");
  });
  test("side/home tasks get the review-gate subset (ready+merged, no QA states) — 154/G2", () => {
    const v = statusVocab("task", "side");
    expect(v).not.toContain("qa");
    expect(v).not.toContain("qa_ready");
    expect(v).toContain("ready");
    expect(v).toContain("merged");
    expect(v).toEqual(["open", "in_progress", "ready", "merged", "blocked", "done"]);
  });
});

describe("isValidStatus", () => {
  test("ready valid for side task (154/G2 review-gate)", () => {
    expect(isValidStatus("ready", "task", "side")).toBe(true);
    expect(isValidStatus("merged", "task", "side")).toBe(true);
  });
  test("qa states still invalid for side task", () => {
    expect(isValidStatus("qa_ready", "task", "side")).toBe(false);
  });
  test("ready valid for linear_ref", () => {
    expect(isValidStatus("ready", "linear_ref", null)).toBe(true);
  });
});

describe("canTransition", () => {
  test("valid linear_ref transitions", () => {
    expect(canTransition("open", "in_progress", "linear_ref", null)).toBe(true);
    expect(canTransition("ready", "merged", "linear_ref", null)).toBe(true);
    expect(canTransition("qa", "qa_rework", "linear_ref", null)).toBe(true);
  });
  test("invalid linear_ref transitions", () => {
    expect(canTransition("open", "qa", "linear_ref", null)).toBe(false);
    expect(canTransition("open", "merged", "linear_ref", null)).toBe(false);
  });
  test("side task transitions", () => {
    expect(canTransition("open", "in_progress", "task", "side")).toBe(true);
    expect(canTransition("in_progress", "done", "task", "side")).toBe(true);
  });
  test("side task review-gate loop: start→ready→merged→close works (154/G2)", () => {
    expect(canTransition("open", "in_progress", "task", "side")).toBe(true);
    expect(canTransition("in_progress", "ready", "task", "side")).toBe(true);
    expect(canTransition("ready", "merged", "task", "side")).toBe(true);
    expect(canTransition("merged", "done", "task", "side")).toBe(true);
    // qa states remain out of the basic vocab
    expect(canTransition("ready", "qa_ready", "task", "side")).toBe(false);
  });
});

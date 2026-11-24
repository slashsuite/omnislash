import { describe, expect, test } from "bun:test";
import { isValidStatus, statusVocab } from "../../../apps/cli/src/status.ts";
import { validNextStatuses } from "../../../apps/cli/src/workflow.ts";

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

// OS-172: the edges are the item machines (platform/state-machine), read here through validNextStatuses,
// which feeds the item detail's `valid_next`. The full edge list is pinned in platform/state-machine's parity test.
describe("validNextStatuses", () => {
  test("linear_ref moves", () => {
    expect(validNextStatuses("linear_ref", null, "open")).toEqual(["in_progress", "ready", "done", "blocked"]);
    expect(validNextStatuses("linear_ref", null, "ready")).toContain("merged");
    expect(validNextStatuses("linear_ref", null, "qa")).toContain("qa_rework");
  });
  test("side task review-gate loop: start→ready→merged→close works (154/G2)", () => {
    expect(validNextStatuses("task", "side", "open")).toContain("in_progress");
    expect(validNextStatuses("task", "side", "in_progress")).toContain("ready");
    expect(validNextStatuses("task", "side", "ready")).toContain("merged");
    expect(validNextStatuses("task", "side", "merged")).toContain("done");
    // qa states remain out of the basic vocab
    expect(validNextStatuses("task", "side", "ready")).not.toContain("qa_ready");
  });
  test("a stored status the machine does not know has no moves, and does not throw", () => {
    expect(validNextStatuses("task", null, "qa")).toEqual([]);
  });
});

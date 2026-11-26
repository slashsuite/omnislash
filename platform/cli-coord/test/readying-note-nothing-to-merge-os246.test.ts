// OS-246: a run with no commit past main (OS-211) is announced as "nothing to merge", not as a PR to gate.
import { describe, expect, test } from "bun:test";
import { readyingNote, type ReadyNoteFacts } from "../../../apps/cli/src/t3/dispatch.ts";

const facts: ReadyNoteFacts = {
  ticket: "OS-9",
  branch: "os-9",
  worktree: "/home/owner/dev/omnislash.os-9",
  commitsAhead: 0,
  state: null,
  builderNote: "measured it; answer is on the ticket",
  rowId: 77,
  status: "ready-for-gate",
  composedAt: "2026-11-26T12:00:00.000Z",
};

describe("readyingNote with nothingToMerge", () => {
  test("says there is nothing to gate or merge and tells the architect to read the note and close", () => {
    const note = readyingNote({ ...facts, nothingToMerge: true });
    expect(note).toContain("commits:   none past main (nothing to merge)");
    expect(note).toContain("no commit past main and no PR: nothing to gate or merge");
    expect(note).toContain("`ob show OS-9`");
    expect(note).toContain("`ob close OS-9`, and remove the worktree");
    expect(note).not.toContain("gh pr merge");
    expect(note).not.toContain("0 ahead of the base commit");
  });

  test("without it, the note is the usual gate-and-merge one", () => {
    const note = readyingNote(facts);
    expect(note).toContain("commits:   0 ahead of the base commit");
    expect(note).toContain("gh pr merge --squash");
    expect(note).not.toContain("nothing to gate or merge");
  });
});

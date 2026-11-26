// OB-2044: the handoff now reads the branch's open PR (`gh pr list --head <branch> ...`). Tests that fake the
// `sh` seam to exercise a handoff and are not about CI import `__setSh` from here instead of the source: it
// answers that one call with "no open PR" (`[]`) and hands every other command to the test's own fake.
// OS-211: a branch with no open PR hands off only with no commit past main, so the count of `main..<branch>`
// (the range the guard reads) is answered 0 too. The test's own `rev-list --count <base_sha>..` answer, which
// the readying note's `commits:` line reads, still comes from its fake.
import { __setSh as rawSetSh, type Sh } from "../src/commands/spinoff.ts";

export const isPrList = (cmd: readonly string[]): boolean => cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list";
const isPastMainCount = (cmd: readonly string[]): boolean =>
  cmd.includes("rev-list") && cmd.includes("--count") && cmd.some((a) => /^(?:origin\/)?main\.\./.test(a));

export function __setSh(fn: Sh): () => void {
  return rawSetSh((cmd, cwd, timeoutMs) =>
    isPrList(cmd) ? { ok: true, err: "", out: "[]" } : isPastMainCount(cmd) ? { ok: true, err: "", out: "0\n" } : fn(cmd, cwd, timeoutMs),
  );
}

/** The worktree HEAD `__setShGreenPr` reports, and its open PR's head. */
export const GREEN_PR_HEAD = "a".repeat(40);

/**
 * OS-211: a build with commits past main and an open PR at the worktree HEAD whose one check passed, for a test
 * about the readying note of a real build. Every other command goes to the test's own fake.
 */
export function __setShGreenPr(fn: Sh): () => void {
  const open = [{ number: 1, url: "https://github.com/o/r/pull/1", headRefOid: GREEN_PR_HEAD, statusCheckRollup: [{ __typename: "CheckRun", name: "gate", status: "COMPLETED", conclusion: "SUCCESS" }] }];
  return rawSetSh((cmd, cwd, timeoutMs) =>
    isPrList(cmd)
      ? { ok: true, err: "", out: JSON.stringify(open) }
      : cmd.includes("rev-parse") && cmd.includes("HEAD^{commit}")
        ? { ok: true, err: "", out: `${GREEN_PR_HEAD}\n` }
        : fn(cmd, cwd, timeoutMs),
  );
}

// OB-2044: the handoff now reads the branch's open PR (`gh pr list --head <branch> ...`). Tests that fake the
// `sh` seam to exercise a handoff and are not about CI import `__setSh` from here instead of the source: it
// answers that one call with "no open PR" (`[]`) and hands every other command to the test's own fake.
import { __setSh as rawSetSh, type Sh } from "../src/commands/spinoff.ts";

export const isPrList = (cmd: readonly string[]): boolean => cmd[0] === "gh" && cmd[1] === "pr" && cmd[2] === "list";

export function __setSh(fn: Sh): () => void {
  return rawSetSh((cmd, cwd, timeoutMs) => (isPrList(cmd) ? { ok: true, err: "", out: "[]" } : fn(cmd, cwd, timeoutMs)));
}

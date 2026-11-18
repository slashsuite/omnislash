import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitsAheadFor, readCommitState, rowVerdictState } from "../src/commands/spinoff.ts";
import { assessGateable, renderGateableList } from "../src/spinoff-gateable.ts";
import { readyingNote } from "../../../apps/cli/src/t3/dispatch.ts";

// OB-2228: a branch with no commit past main has its HEAD on a main commit. readCommitState fell back to
// HEAD when the main..branch range was empty, so it read main's own State line, and `ob spinoff gateable`
// called a no-change handoff landable. Real git in a temp repo, as 1639 does, because the range is git's.

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repo whose main tip carries `State: landable`, and a branch `ob-2223` cut from it with no commit of its own. */
function noChangeBranch(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "spinoff-state-2228-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "fix(OB-2205): another ticket's land\n\nState: landable\nGate: green");
  const base = git(dir, "rev-parse", "HEAD");
  git(dir, "switch", "-q", "-c", "ob-2223");
  return { dir, base };
}

const row = (dir: string) => ({ id: 2133, ticket_ref: "OB-2223", branch: "ob-2223", worktree: dir, repo: "acme" });

describe("a branch with no commit past main reads no State line (OB-2228)", () => {
  test("ob spinoff gateable prints landable: no and State: (none)", () => {
    const { dir } = noChangeBranch();
    const r = row(dir);
    const gateable = assessGateable(r, { missing: false, state: rowVerdictState(r), paths: [] });
    expect(gateable.landable).toBe(false);
    const out = renderGateableList([gateable], "human");
    expect(out).toContain("landable: no");
    expect(out).toContain("State: (none)");
    expect(out).not.toContain("State: landable");
  });

  test("the handoff note says 0 ahead and borrows no State line", () => {
    const { dir, base } = noChangeBranch();
    const note = readyingNote({
      ticket: "OB-2223",
      branch: "ob-2223",
      worktree: dir,
      commitsAhead: commitsAheadFor(dir, "ob-2223", base),
      state: rowVerdictState(row(dir)),
      builderNote: null,
      rowId: 2133,
      status: "ready-for-gate",
      composedAt: "2026-11-16T00:00:00Z",
    });
    expect(note).toContain("commits:   0 ahead of the base commit");
    expect(note).not.toContain("State: landable");
  });

  test("with no main ref at all, the HEAD fallback still reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "spinoff-state-2228-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "trunk");
    git(dir, "commit", "-q", "--allow-empty", "-m", "fix(OB-2223): only commit\n\nState: landable");
    expect(readCommitState(dir, "trunk")).toBe("State: landable");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCommitState } from "../src/commands/spinoff.ts";

// 1639: the handoff note quoted the OLDEST commit's State: line. `git log` is newest-first, so the
// verdict is the first match, not the last. Real git in a temp repo, because the order is git's, not ours.

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(p.stderr)}`);
}

describe("readCommitState reads the newest commit's State: line (1639)", () => {
  test("a two-commit branch whose States differ reports the tip, not the first commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "spinoff-state-1639-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "commit", "-q", "--allow-empty", "-m", "chore: base");
      git(dir, "switch", "-q", "-c", "1639");
      git(dir, "commit", "-q", "--allow-empty", "-m", "feat(ob 1639): first cut\n\nState: partial — nothing is installed");
      git(dir, "commit", "-q", "--allow-empty", "-m", "feat(ob 1639): live-proven\n\nState: landable — live-proven");

      expect(readCommitState(dir, "1639")).toBe("State: landable — live-proven");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a prose line starting State: ahead of the real verdict does not win", () => {
    const dir = mkdtempSync(join(tmpdir(), "spinoff-state-1639-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "commit", "-q", "--allow-empty", "-m", "chore: base");
      git(dir, "switch", "-q", "-c", "1639");
      git(
        dir,
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "fix(ob 1639): newest\n\nState: line. A wrapped body line that starts with the word State:\n\nState: landable — gate green",
      );

      expect(readCommitState(dir, "1639")).toBe("State: landable — gate green");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

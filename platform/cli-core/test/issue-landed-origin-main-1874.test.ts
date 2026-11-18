import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { landedIn, mainRefFor, readRepoState } from "../../../apps/cli/src/tracker-link.ts";

// ob 1874: `ob issue landed` is the #77 "is it already built?" check. The architect checkout never moves its
// local `main` (lands push from a land worktree), so it must read origin/main. REAL git, local temp repos
// only: no network, no live DB.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(p.stderr)}`);
  return new TextDecoder().decode(p.stdout).trim();
}

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "ob1874-"));
  dirs.push(d);
  return d;
}

/** A checkout on `main` with one base commit; `withOrigin` also gives it a bare origin it has pushed to. */
function fixture(withOrigin: boolean): { checkout: string; origin: string | null } {
  const checkout = tmp();
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "commit", "-q", "--allow-empty", "-m", "chore: base");
  let origin: string | null = null;
  if (withOrigin) {
    origin = tmp();
    git(origin, "init", "-q", "--bare", "-b", "main");
    git(checkout, "remote", "add", "origin", origin);
    git(checkout, "push", "-q", "origin", "main");
    git(checkout, "fetch", "-q", "origin");
  }
  return { checkout, origin };
}

/** Land `subject` on origin/main from a second clone, leaving the checkout's local `main` where it was. */
function landOnOrigin(origin: string, subject: string): void {
  const land = tmp();
  git(land, "clone", "-q", origin, ".");
  git(land, "commit", "-q", "--allow-empty", "-m", subject);
  git(land, "push", "-q", "origin", "main");
}

describe("readRepoState measures against origin/main (1874)", () => {
  test("a squash land naming `feat(ob N)` that is only on origin/main is a HIT", async () => {
    const { checkout, origin } = fixture(true);
    landOnOrigin(origin!, "feat(ob 1874): the thing");
    git(checkout, "fetch", "-q", "origin");
    // local main did not move, so reading it literally cannot see the land
    expect(git(checkout, "log", "main", "--format=%s")).not.toContain("1874");

    const state = await readRepoState(checkout);
    expect(state.readable).toBe(true);
    expect(state.main).toBe("origin/main");
    const report = landedIn(state, [{ namespace: "ob", number: 1874, via: "asked" }]);
    expect(report.landed).toBe(true);
    expect(report.fired).toContain("commit-ref");
  });

  test("an explicit main still wins (the old behaviour is one argument away)", async () => {
    const { checkout, origin } = fixture(true);
    landOnOrigin(origin!, "feat(ob 1874): the thing");
    git(checkout, "fetch", "-q", "origin");
    const state = await readRepoState(checkout, "main");
    expect(state.main).toBe("main");
    expect(landedIn(state, [{ namespace: "ob", number: 1874, via: "asked" }]).landed).toBe(false);
  });

  test("no origin: unchanged, reads local main", async () => {
    const { checkout } = fixture(false);
    git(checkout, "commit", "-q", "--allow-empty", "-m", "feat(ob 1874): the thing");
    expect(mainRefFor(checkout)).toBe("main");
    const state = await readRepoState(checkout);
    expect(state.main).toBe("main");
    expect(landedIn(state, [{ namespace: "ob", number: 1874, via: "asked" }]).landed).toBe(true);
    expect(landedIn(state, [{ namespace: "ob", number: 99, via: "asked" }]).landed).toBe(false);
  });

  test("an unpushed local main ahead of origin/main still wins", async () => {
    const { checkout } = fixture(true);
    git(checkout, "commit", "-q", "--allow-empty", "-m", "feat(ob 1874): local only");
    expect(mainRefFor(checkout)).toBe("main");
    const state = await readRepoState(checkout);
    expect(landedIn(state, [{ namespace: "ob", number: 1874, via: "asked" }]).landed).toBe(true);
  });

  test("main itself is never reported as a merged branch of its own work", async () => {
    const { checkout, origin } = fixture(true);
    landOnOrigin(origin!, "feat(ob 1874): the thing");
    git(checkout, "fetch", "-q", "origin");
    const state = await readRepoState(checkout);
    expect(state.branches.map((b) => b.name)).not.toContain("main");
  });
});

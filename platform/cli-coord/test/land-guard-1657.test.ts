import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkLand, renderReport } from "../src/land-guard.ts";

// 1657: the 1636 shape. A builder forks main at A. Main then gains M1 (deletes Cue) and M2 (edits a chart).
// The builder squashes with `git reset --soft main`, which keeps ITS stale tree, so the commit re-adds Cue
// and reverts the chart. The proper road, `git merge --squash` in a worktree cut from main, does not.

let repo: string;

function git(...args: string[]): string {
  const p = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (p.status !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.trim();
}

function put(path: string, body: string | null): void {
  const abs = join(repo, path);
  if (body === null) {
    rmSync(abs);
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function commit(msg: string): string {
  git("add", "-A");
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
}

let A: string;
let M1: string;
let M2: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "land-guard-1657-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  put("cue/a.ts", "cue a\n");
  put("cue/b.ts", "cue b\n");
  put("docs/chart.md", "chart v1\n");
  put("README.md", "readme\n");
  A = commit("chore: base");
  git("branch", "1636");
  put("cue/a.ts", null);
  put("cue/b.ts", null);
  M1 = commit("feat(ob 1622): remove Cue");
  put("docs/chart.md", "chart v2\n");
  M2 = commit("chore: chart");
  git("checkout", "-q", "1636");
  put("ops/power/rapl.sh", "echo watts\n");
  put("README.md", "readme + power\n");
  commit("feat(ob 1636): power publisher");
  git("checkout", "-q", "main");
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("land guard (1657)", () => {
  test("the 1636 shape: reset --soft main + commit re-adds Cue and reverts the chart, and is refused", () => {
    git("checkout", "-q", "1636");
    git("reset", "-q", "--soft", "main");
    const squash = commit("feat(ob 1636): power publisher");
    git("checkout", "-q", "main");
    git("merge", "-q", "--ff-only", squash);

    // Land guard runs on the commit about to be pushed, against what it lands on.
    const r = checkLand({ repo, head: squash, against: M2 });
    expect(r.ok).toBe(false);
    expect(r.reverts.map((v) => v.commit)).toEqual(expect.arrayContaining([M1, M2]));
    const cue = r.reverts.find((v) => v.commit === M1)!;
    expect(cue.paths).toEqual(["cue/a.ts", "cue/b.ts"]);
    expect(r.reverts.find((v) => v.commit === M2)!.paths).toEqual(["docs/chart.md"]);
    const text = renderReport(r);
    expect(text).toContain("REFUSED");
    expect(text).toContain("reverts " + M1.slice(0, 8));
    expect(text).toContain("merge --squash");
  });

  test("with the branch and its captured base_sha, the same squash also reads as touching paths outside the builder's diff", () => {
    git("checkout", "-q", "1636");
    // The row's base_sha is the fork point (A); the branch's own diff from there is rapl.sh + README only.
    git("reset", "-q", "--soft", "main");
    const squash = commit("feat(ob 1636): power publisher");
    const r = checkLand({ repo, head: squash, against: M2, branch: squash, base: A, allowRevert: [M1, M2] });
    expect(r.reverts).toEqual([]);
    // squash is the branch tip here, as after 1636 rewrote its own ref: diff(A, tip) hides nothing from main..squash
    // except main's own commits, which are exactly cue/ and the chart.
    expect(r.outside.sort()).toEqual(["cue/a.ts", "cue/b.ts", "docs/chart.md"]);
    expect(r.ok).toBe(false);
  });

  test("a proper `git merge --squash` onto main passes both checks", () => {
    git("merge", "--squash", "1636");
    const squash = commit("feat(ob 1636): power publisher");
    const r = checkLand({ repo, head: squash, against: M2, branch: "1636" });
    expect(r.ok).toBe(true);
    expect(r.changed.sort()).toEqual(["README.md", "ops/power/rapl.sh"]);
    expect(renderReport(r)).toContain("ok");
  });

  test("scope: a commit that edits a file the builder never touched is refused", () => {
    git("merge", "--squash", "1636");
    put("docs/chart.md", "chart sneaked\n");
    const squash = commit("feat(ob 1636): power publisher");
    const r = checkLand({ repo, head: squash, against: M2, branch: "1636" });
    expect(r.reverts).toEqual([]);
    expect(r.outside).toEqual(["docs/chart.md"]);
    expect(r.ok).toBe(false);
  });

  test("a real edit after a main commit is not a revert", () => {
    put("docs/chart.md", "chart v3 (builder's own edit)\n");
    const edit = commit("feat(ob 1700): extend the chart");
    const r = checkLand({ repo, head: edit, against: M2 });
    expect(r.ok).toBe(true);
  });

  test("a deliberate revert passes with --allow-revert", () => {
    git("revert", "--no-edit", M1);
    const revert = git("rev-parse", "HEAD");
    expect(checkLand({ repo, head: revert, against: M2 }).ok).toBe(false);
    expect(checkLand({ repo, head: revert, against: M2, allowRevert: [M1.slice(0, 10)] }).ok).toBe(true);
  });

  test("`depth` bounds how far back it looks", () => {
    git("checkout", "-q", "1636");
    git("reset", "-q", "--soft", "main");
    const squash = commit("feat(ob 1636): power publisher");
    const r = checkLand({ repo, head: squash, against: M2, depth: 1 });
    expect(r.reverts.map((v) => v.commit)).toEqual([M2]);
  });

  test("renaming or deleting a file a recent commit added is not a revert", () => {
    put("skills/old-name/SKILL.md", "skill\n");
    const added = commit("feat(skill): add skill");
    git("mv", "skills/old-name", "skills/ob-old-name");
    const renamed = commit("chore(skill): rename skill");
    expect(added).not.toBe(renamed);
    expect(checkLand({ repo, head: renamed, against: added }).ok).toBe(true);
  });

  test("an --allow-revert too short to name a commit is an error, not a silent no-op", () => {
    expect(() => checkLand({ repo, head: "HEAD", against: A, allowRevert: ["ab12"] })).toThrow(/too short/);
  });
});

// OB-2176: a PR branch that is merely behind main still holds the pre-image of what main changed after the fork,
// but GitHub's squash is three-way from merge-base(main, head) and keeps main's side there. Not a revert.
describe("land guard on a branch behind main (OB-2176)", () => {
  test("main changed X after the fork, the branch changed only Y: no revert, nothing outside", () => {
    const r = checkLand({ repo, head: "1636", against: M2, branch: "1636", base: A });
    expect(r.reverts).toEqual([]);
    expect(r.outside).toEqual([]);
    expect(r.changed.sort()).toEqual(["README.md", "ops/power/rapl.sh"]);
    expect(r.mainOnly).toBe(3);
    expect(r.ok).toBe(true);
    expect(renderReport(r)).toContain("3 path(s) only main changed, not the PR's");
    // --squash is the same reading without the scope check (a PR land in a clean repo).
    const s = checkLand({ repo, head: "1636", against: M2, squash: true });
    expect(s.reverts).toEqual([]);
    expect(s.ok).toBe(true);
  });

  test("a plain push of that same behind branch (pre-push, no --branch) still refuses: it would replace main's tree", () => {
    const r = checkLand({ repo, head: "1636", against: M2 });
    expect(r.mainOnly).toBe(0);
    expect(r.reverts.map((v) => v.commit)).toEqual(expect.arrayContaining([M1, M2]));
    expect(r.ok).toBe(false);
  });

  test("the branch also restores X's old content: still a revert (the 1636 shape)", () => {
    git("checkout", "-q", "1636");
    git("merge", "-q", "--no-edit", "main");
    put("docs/chart.md", "chart v1\n");
    const head = commit("feat(ob 1636): power publisher");
    const r = checkLand({ repo, head, against: M2, branch: head, base: A });
    expect(r.reverts.map((v) => v.commit)).toEqual([M2]);
    expect(r.reverts[0]!.paths).toEqual(["docs/chart.md"]);
    expect(r.ok).toBe(false);
  });

  test("without --branch, a head on top of main that restores X's old content is still refused (pre-push)", () => {
    put("docs/chart.md", "chart v1\n");
    const head = commit("chore: chart back");
    const r = checkLand({ repo, head, against: M2 });
    expect(r.mainOnly).toBe(0);
    expect(r.reverts.map((v) => v.commit)).toEqual([M2]);
    expect(r.ok).toBe(false);
  });

  test("a head with no merge-base with main falls back to the full check", () => {
    git("checkout", "-q", "--orphan", "stray");
    git("rm", "-rq", "--cached", ".");
    put("cue/a.ts", "cue a\n");
    put("cue/b.ts", "cue b\n");
    put("docs/chart.md", "chart v1\n");
    git("add", "cue", "docs", "README.md");
    git("commit", "-q", "-m", "chore: stray");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "-f", "main");
    const r = checkLand({ repo, head, against: M2, squash: true });
    expect(r.mainOnly).toBe(0);
    expect(r.reverts.map((v) => v.commit)).toEqual(expect.arrayContaining([M1, M2]));
    expect(r.ok).toBe(false);
  });
});

describe("land guard subject check (1666)", () => {
  test("a squash with a non-conventional subject is refused, and the report says how to fix it", () => {
    git("merge", "--squash", "1636");
    const squash = commit("power publisher");
    const r = checkLand({ repo, head: squash, against: M2, branch: "1636" });
    expect(r.reverts).toEqual([]);
    expect(r.outside).toEqual([]);
    expect(r.subject.ok).toBe(false);
    expect(r.ok).toBe(false);
    const text = renderReport(r);
    expect(text).toContain("REFUSED");
    expect(text).toContain("power publisher");
    expect(text).toContain("commit --amend");
    expect(text).not.toContain("cause: a squash taken");
  });

  test("the CLI exits 1 on a bad subject and 0 on a good one", () => {
    const cli = join(import.meta.dir, "../src/land-guard.ts");
    const run = (head: string) => spawnSync("bun", [cli, "--repo", repo, "--head", head, "--against", M2], { encoding: "utf8" });
    git("merge", "--squash", "1636");
    const bad = commit("power publisher");
    expect(run(bad).status).toBe(1);
    git("commit", "-q", "--amend", "-m", "feat(ob 1636): power publisher");
    const good = run("HEAD");
    expect(good.status).toBe(0);
    expect(good.stdout).toContain("Conventional Commit");
  });

  // OB-1670 (#80): a PR squash takes its subject from `gh pr merge --subject`, not from the branch head, so
  // the builder checks the subject it will pass rather than whatever its last commit happened to say.
  test("--subject checks the squash subject the PR merge will carry, not the head's", () => {
    const cli = join(import.meta.dir, "../src/land-guard.ts");
    git("merge", "--squash", "1636");
    const head = commit("wip: not the land subject");
    expect(checkLand({ repo, head, against: M2 }).subject.ok).toBe(false);
    expect(checkLand({ repo, head, against: M2, subject: "feat(OB-1670): builder merges its PR" }).ok).toBe(true);
    const run = (subject: string) =>
      spawnSync("bun", [cli, "--repo", repo, "--head", head, "--against", M2, "--subject", subject], { encoding: "utf8" });
    expect(run("feat(OB-1670): builder merges its PR").status).toBe(0);
    const bad = run("builder merges its PR");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("--subject");
  });
});

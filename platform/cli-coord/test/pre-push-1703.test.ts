import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// 1703: the pre-push hook runs the land guard on every push to main. A real `git push` through a real
// remote, so the hook sees the same stdin git gives it. The hook and the guard are copied into the throwaway
// repo at their repo-relative paths, because the hook resolves the guard from its own checkout root.

const ROOT = join(import.meta.dir, "../../..");
const HOOK = ".githooks/pre-push";
const GUARD = "platform/cli-coord/src/land-guard.ts";
const VALIDATOR = "platform/cli-coord/src/conventional-commit.ts";
// OB-1992: the guard's clean-repo leak check, and what it reads.
const CLEAN = "platform/cli-coord/src/clean-repo.ts";
const VOCAB = "platform/cli-coord/src/spinoff-vocab.ts";

let work: string;
let origin: string;

function git(cwd: string, ...args: string[]) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function must(cwd: string, ...args: string[]): string {
  const p = git(cwd, ...args);
  if (p.status !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.trim();
}

function put(path: string, body: string): void {
  const abs = join(work, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function commit(subject: string): void {
  must(work, "add", "-A");
  must(work, "commit", "-q", "-m", subject);
}

function push(branch = "main") {
  return git(work, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "pre-push-1703-"));
  // Named omnislash: this hook is omnislash's, and any other origin is a clean repo whose subjects carry no ref (OB-1992).
  origin = join(base, "omnislash.git");
  work = join(base, "work");
  must(base, "init", "-q", "--bare", "-b", "main", origin);
  mkdirSync(work);
  must(work, "init", "-q", "-b", "main");
  must(work, "config", "user.email", "t@example.com");
  must(work, "config", "user.name", "t");
  must(work, "config", "core.hooksPath", ".githooks");
  for (const f of [HOOK, GUARD, VALIDATOR, CLEAN, VOCAB]) {
    mkdirSync(dirname(join(work, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(work, f));
  }
  chmodSync(join(work, HOOK), 0o755);
  must(work, "remote", "add", "origin", origin);

  // main: add a.txt, then edit it. The second commit is what a later restore would undo.
  put("a.txt", "v1\n");
  commit("feat(ob 1): add a");
  put("a.txt", "v2\n");
  commit("fix(ob 1): edit a");
  must(work, "push", "-q", "origin", "main");
});

afterEach(() => {
  rmSync(dirname(work), { recursive: true, force: true });
});

describe("pre-push land guard (1703)", () => {
  test("a clean conventional push to main goes through", () => {
    put("a.txt", "v3\n");
    commit("feat(ob 2): edit a again");
    const p = push();
    expect(p.status).toBe(0);
    expect(p.stderr).not.toContain("refused");
  });

  test("a push to main that restores a file a recent commit changed is refused", () => {
    put("a.txt", "v1\n"); // the pre-image of "fix(ob 1): edit a"
    commit("feat(ob 2): restore a");
    const p = push();
    expect(p.status).not.toBe(0);
    expect(p.stderr).toContain("refused by the land guard");
    expect(must(work, "rev-parse", "origin/main")).not.toBe(must(work, "rev-parse", "HEAD"));
  });

  test("the same revert pushed to a branch other than main is not checked", () => {
    put("a.txt", "v1\n");
    commit("feat(ob 2): restore a");
    expect(push("some-branch").status).toBe(0);
  });

  test("a push to main that could not be checked is refused, naming --no-verify (OB-1925)", () => {
    // The remote's main is a sha this clone does not have: the guard cannot read it, exit 2, push refused.
    const hook = join(work, HOOK);
    const local = must(work, "rev-parse", "HEAD");
    const missing = "1".repeat(40);
    const run = spawnSync("sh", [hook], {
      cwd: work,
      encoding: "utf8",
      input: `refs/heads/main ${local} refs/heads/main ${missing}\n`,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("could not check");
    expect(run.stderr).toContain("--no-verify");
  });

  test("a clean repo's origin: a subject carrying a ticket ref is refused, a plain one goes through (OB-1992)", () => {
    const widgets = join(dirname(work), "widgets.git");
    must(dirname(work), "init", "-q", "--bare", "-b", "main", widgets);
    must(work, "remote", "set-url", "origin", widgets);
    must(work, "push", "-q", "--no-verify", "origin", "main");

    put("b.txt", "1\n");
    commit("feat(OB-12): add b");
    const refused = push();
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("ref 'OB-12'");

    must(work, "commit", "-q", "--amend", "-m", "feat(engine): add b");
    expect(push().status).toBe(0);
  });

  // OB-1925: a PATH holding only git, so `command -v bun` fails. The hook runs under /bin/sh, given this PATH.
  function bunlessEnv(): { PATH: string } {
    const bin = join(dirname(work), "bin");
    mkdirSync(bin);
    const gitPath = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(gitPath, join(bin, "git"));
    return { PATH: bin };
  }

  test("a push to main with bun missing is refused, naming --no-verify (OB-1925)", () => {
    const env = bunlessEnv();
    const local = must(work, "rev-parse", "HEAD");
    const remote = must(work, "rev-parse", "origin/main");
    const run = spawnSync("/bin/sh", [join(work, HOOK)], {
      cwd: work,
      encoding: "utf8",
      env,
      input: `refs/heads/main ${local} refs/heads/main ${remote}\n`,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("bun not on PATH");
    expect(run.stderr).toContain("--no-verify");
  });

  test("a push to a non-main branch with bun missing still goes through (OB-1925)", () => {
    const env = bunlessEnv();
    const local = must(work, "rev-parse", "HEAD");
    const remote = must(work, "rev-parse", "origin/main");
    const run = spawnSync("/bin/sh", [join(work, HOOK)], {
      cwd: work,
      encoding: "utf8",
      env,
      input: `refs/heads/some-branch ${local} refs/heads/some-branch ${remote}\n`,
    });
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("bun not on PATH");
  });
});

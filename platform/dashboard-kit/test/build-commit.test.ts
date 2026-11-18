// OB-2261: the commit both dashboard builds bake into <meta name="build-commit">.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommit } from "../src/build-commit.ts";
import { BUILD_COMMIT_META } from "../src/lib/buildCommitMeta.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync({ cmd: ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

function repo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "build-commit-"));
  dirs.push(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "one");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

describe("buildCommit (OB-2261)", () => {
  test("BUILD_COMMIT wins when set", () => {
    const { dir } = repo();
    expect(buildCommit(dir, { BUILD_COMMIT: "abc123" })).toBe("abc123");
  });

  test("otherwise the HEAD SHA of a clean tree", () => {
    const { dir, head } = repo();
    expect(buildCommit(dir, {})).toBe(head);
    expect(buildCommit(dir, { BUILD_COMMIT: "  " })).toBe(head);
  });

  test("with -dirty when the tree has uncommitted changes, an untracked file included", () => {
    const { dir, head } = repo();
    writeFileSync(join(dir, "b.txt"), "b\n");
    expect(buildCommit(dir, {})).toBe(`${head}-dirty`);
  });

  test("unknown outside git", () => {
    const dir = mkdtempSync(join(tmpdir(), "build-commit-nogit-"));
    dirs.push(dir);
    expect(buildCommit(dir, {})).toBe("unknown");
  });
});

describe("BUILD_COMMIT_META (OB-2261)", () => {
  test("is the build-commit head entry, and says unknown where no build defined the commit", () => {
    expect(BUILD_COMMIT_META).toEqual({ name: "build-commit", content: "unknown" });
  });
});

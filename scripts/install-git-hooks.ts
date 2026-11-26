#!/usr/bin/env bun
// Usage: bun scripts/install-git-hooks.ts
//
// Points this checkout's git at the tracked hooks in .githooks (commit-msg refuses a subject that is
// not a Conventional Commit; pre-push runs the land guard on a push to main). Runs from the root
// package.json `prepare` script, so a fresh `bun install` installs them. Outside a git checkout (a
// tarball, a container build without git) it does nothing and exits 0, so it never fails an install.
import { join } from "node:path";

const root = join(import.meta.dir, "..");

function git(args: string[]): { code: number; out: string } {
  try {
    const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "ignore" });
    return { code: r.exitCode ?? 1, out: r.stdout.toString().trim() };
  } catch {
    return { code: 127, out: "" };
  }
}

if (git(["rev-parse", "--is-inside-work-tree"]).out !== "true") {
  console.log("install-git-hooks: not a git checkout, hooks not installed");
  process.exit(0);
}
if (git(["config", "core.hooksPath"]).out === ".githooks") process.exit(0);
const set = git(["config", "core.hooksPath", ".githooks"]);
if (set.code !== 0) {
  console.error("install-git-hooks: could not set core.hooksPath; run `git config core.hooksPath .githooks` by hand");
  process.exit(0);
}
console.log("install-git-hooks: core.hooksPath set to .githooks");

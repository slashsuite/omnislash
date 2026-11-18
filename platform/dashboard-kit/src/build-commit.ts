// OB-2261: the commit a dashboard build is made from, baked into every page as <meta name="build-commit">
// so a deploy (the server's deploy script, its check_build_commit step) can read what the browser is really served.
// Node-only: each app's vite.config.ts calls it at build time and hands the value to `define`.
import { spawnSync } from "node:child_process";

function git(cwd: string, ...args: string[]): string | null {
  const p = spawnSync("git", args, { cwd, encoding: "utf8" });
  return p.status === 0 ? p.stdout.trim() : null;
}

/**
 * `BUILD_COMMIT` when set (the deploy, CI and the dev push set it, and a build with no git needs it), else
 * `git rev-parse HEAD` with `-dirty` when the tree has uncommitted changes, else `unknown`.
 */
export function buildCommit(cwd: string = process.cwd(), env: Record<string, string | undefined> = process.env): string {
  const set = env.BUILD_COMMIT?.trim();
  if (set) return set;
  const head = git(cwd, "rev-parse", "HEAD");
  if (!head) return "unknown";
  const status = git(cwd, "status", "--porcelain");
  return status ? `${head}-dirty` : head;
}

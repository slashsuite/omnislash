import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Sweep the `tmp-<pid>-<rand>/` dirs a killed Nx daemon leaves behind (ob 1373).
 *
 * The producer is not a test. Nx's daemon unpacks `nx@latest` (~72MB with node_modules) into a `tmp`-package
 * dir named `tmp-<daemon pid>-<rand>` the first time a client asks for the AI-agent status, and removes it
 * only on a graceful shutdown. Every worktree has its own daemon, so every one that is killed leaks a copy:
 * 55 of them filled the 16G `/tmp` tmpfs and the gate died with `Disk quota exceeded`. The fix is
 * `NX_USE_LOCAL=true` in each Nx repo's own `.env` and `.mcp.json` (acme itself runs moon since OB-2033,
 * but the other repos on this machine still run Nx); this sweep removes what earlier daemons already left.
 *
 * A dir goes only when ALL hold: the name is `tmp-<pid>-<rand>`, the pid is dead, it is older than the grace
 * period, and the dir is exactly what Nx's probe install leaves (only its known files, `package.json` holding
 * `devDependencies` of `nx` alone). Any
 * other `tmp-*` dir, anyone else's included, stays.
 */
export const NX_TMP_GRACE_MS = 30 * 60 * 1000;

const NAME = /^tmp-(\d+)-[A-Za-z0-9]+$/;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Everything Nx's `createTempNpmDirectory` + `<pm> add -D nx@latest` leaves in the dir, and nothing else.
const PROBE_FILES = new Set(["bunfig.toml", "bun.lock", "bun.lockb", "package.json", "package-lock.json", "node_modules"]);

function isNxProbe(dir: string): boolean {
  try {
    if (readdirSync(dir).some((f) => !PROBE_FILES.has(f))) return false;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
    const deps = Object.keys((pkg.devDependencies ?? {}) as object);
    return Object.keys(pkg).length === 1 && deps.length === 1 && deps[0] === "nx";
  } catch {
    return false;
  }
}

export function sweepNxTmp(
  root: string,
  opts: { now?: number; graceMs?: number; alive?: (pid: number) => boolean } = {},
): string[] {
  const now = opts.now ?? Date.now();
  const grace = opts.graceMs ?? NX_TMP_GRACE_MS;
  const alive = opts.alive ?? pidAlive;
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const m = NAME.exec(entry);
    if (!m) continue;
    const path = join(root, entry);
    try {
      if (alive(Number(m[1]))) continue;
      if (now - statSync(path).mtimeMs <= grace) continue;
      if (!isNxProbe(path)) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch {
      // vanished mid-sweep, or not ours to remove: leave it
    }
  }
  return removed;
}

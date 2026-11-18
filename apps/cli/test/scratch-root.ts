import { readFileSync, statfsSync } from "node:fs";

/**
 * OB-2024: where the suite's per-run scratch lives (see `preload.ts`).
 *
 * The scratch holds every throwaway SQLite file the suite makes. On a disk filesystem those files are
 * written back by the kernel in the background, and btrfs keeps a page stable while it is under writeback:
 * a `pwrite` to it, or a store through SQLite's mmapped `-shm`, waits in `folio_wait_bit` until that I/O
 * completes. Under a parallel gate that wait was measured at 1.7s and more on tests whose work takes 0.05s,
 * and it is how two tests reached 7s against bun's 5s budget. tmpfs has no writeback, so on tmpfs the wait
 * cannot happen. `synchronous=OFF` (1658, OB-1894) removed the fsyncs; it cannot remove writeback.
 *
 * `/dev/shm` is that tmpfs on Linux. It is used only when it is a tmpfs with room for a gate run (a full
 * Nx gate run peaked at 885 MB there, all of it removed when the run ends) and is not mounted `noexec`
 * (the suite runs stub scripts it writes into the scratch; a container's `/dev/shm` is often `noexec`).
 * Anything else keeps the scratch under the shared tmp as before.
 */
export const SHM_DIR = "/dev/shm";
/** The directory under the parent that holds one directory per run. */
export const SCRATCH_DIR_NAME = "ob-cli-test";
export const TMPFS_MAGIC = 0x01021994;
export const MIN_SHM_FREE_BYTES = 2 * 1024 ** 3;

export interface FsInfo {
  type: number;
  freeBytes: number;
  noexec: boolean;
}

/**
 * Whether the mount that covers `dir` is `noexec`, from the text of `/proc/self/mounts`: the deepest mount
 * point at or above `dir` wins, the later line on a tie (a mount stacked on another). No covering line is false.
 */
export function noexecIn(mounts: string, dir: string): boolean {
  let best: { point: string; options: string } | null = null;
  for (const line of mounts.split("\n")) {
    const [, point, , options] = line.split(" ");
    if (!point || options === undefined) continue;
    const covers = point === "/" || dir === point || dir.startsWith(`${point}/`);
    if (covers && (!best || point.length >= best.point.length)) best = { point, options };
  }
  return best?.options.split(",").includes("noexec") ?? false;
}

function mountedNoexec(dir: string): boolean {
  try {
    return noexecIn(readFileSync("/proc/self/mounts", "utf8"), dir);
  } catch {
    return false; // no procfs: not Linux, and no /dev/shm tmpfs to pick either
  }
}

export function shmInfo(dir: string = SHM_DIR): FsInfo | null {
  try {
    const s = statfsSync(dir);
    return { type: Number(s.type), freeBytes: Number(s.bavail) * Number(s.bsize), noexec: mountedNoexec(dir) };
  } catch {
    return null;
  }
}

/** The parent directory for the run scratch: `/dev/shm` when it is a usable tmpfs, else the shared tmp. */
export function scratchParent(sharedTmp: string, shm: FsInfo | null = shmInfo()): string {
  if (shm && shm.type === TMPFS_MAGIC && !shm.noexec && shm.freeBytes >= MIN_SHM_FREE_BYTES) return SHM_DIR;
  return sharedTmp;
}

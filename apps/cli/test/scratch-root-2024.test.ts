import { describe, expect, test } from "bun:test";
import { MIN_SHM_FREE_BYTES, SHM_DIR, noexecIn, scratchParent, shmInfo } from "./scratch-root.ts";

// OB-2024. The suite's throwaway SQLite files stalled for seconds in btrfs writeback under a parallel gate,
// so the per-run scratch moves to tmpfs where the machine has a usable one, and stays put where it has not.

const TMPFS = 0x01021994;
const BTRFS = 0x9123683e;
const roomy = 8 * 1024 ** 3;

describe("scratchParent (OB-2024)", () => {
  test("a tmpfs /dev/shm with room for a run is the parent", () => {
    expect(scratchParent("/shared/tmp", { type: TMPFS, freeBytes: MIN_SHM_FREE_BYTES, noexec: false })).toBe(SHM_DIR);
  });

  test("a /dev/shm too small for a run (a container's 64MB) keeps the shared tmp", () => {
    expect(scratchParent("/shared/tmp", { type: TMPFS, freeBytes: 64 * 1024 ** 2, noexec: false })).toBe("/shared/tmp");
  });

  test("a noexec /dev/shm keeps the shared tmp: the suite runs stub scripts it writes into the scratch", () => {
    expect(scratchParent("/shared/tmp", { type: TMPFS, freeBytes: roomy, noexec: true })).toBe("/shared/tmp");
  });

  test("a /dev/shm that is not tmpfs, or not there at all, keeps the shared tmp", () => {
    expect(scratchParent("/shared/tmp", { type: BTRFS, freeBytes: roomy, noexec: false })).toBe("/shared/tmp");
    expect(scratchParent("/shared/tmp", null)).toBe("/shared/tmp");
    expect(shmInfo("/no/such/dir/ob-2024")).toBeNull();
  });
});

describe("noexecIn (OB-2024)", () => {
  const root = "/dev/nvme0n1p2 / btrfs rw,relatime 0 0";

  test("reads the options of /dev/shm's own mount", () => {
    expect(noexecIn(`${root}\ntmpfs /dev/shm tmpfs rw,nosuid,nodev,inode64,usrquota 0 0`, SHM_DIR)).toBe(false);
    expect(noexecIn(`${root}\nshm /dev/shm tmpfs rw,nosuid,nodev,noexec,size=8g 0 0`, SHM_DIR)).toBe(true);
  });

  test("with no mount of its own, the deepest mount above /dev/shm decides", () => {
    expect(noexecIn(`${root}\ntmpfs /dev tmpfs rw,nosuid,noexec 0 0`, SHM_DIR)).toBe(true);
    expect(noexecIn(`${root}\ntmpfs /dev tmpfs rw,nosuid,noexec 0 0\ntmpfs /dev/shm tmpfs rw 0 0`, SHM_DIR)).toBe(false);
  });

  test("a mount whose path only shares a prefix does not cover it, and a later stacked mount wins", () => {
    expect(noexecIn(`${root}\ntmpfs /dev/shmx tmpfs rw,noexec 0 0`, SHM_DIR)).toBe(false);
    expect(noexecIn(`${root}\ntmpfs /dev/shm tmpfs rw 0 0\ntmpfs /dev/shm tmpfs rw,noexec 0 0`, SHM_DIR)).toBe(true);
  });
});

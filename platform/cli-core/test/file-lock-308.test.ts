import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireFileLock, systemFlock, type FlockFn } from "../../../apps/cli/src/file-lock.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

// ob 308: the primitive the replica swap is serialised on. These use the REAL flock -- a lock tested
// against a stub is a test of the stub -- and reach for a stub only where the real one cannot be made
// to misbehave on demand (a platform with no binding at all).

function lockPath(): string {
  const path = join(mkdtempSync(join(tmpdir(), "ob-lock-")), "replica.lock");
  writeFileSync(path, "");
  return path;
}

describe("file lock: the primitive the replica swap serialises on (308)", () => {
  test("readers share the hold with each other and the swap waits for all of them", () => {
    const path = lockPath();
    const first = acquireFileLock(path, "shared", { waitMs: 0 });
    const second = acquireFileLock(path, "shared", { waitMs: 0 });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    // one reader left is still a reader: the swap must not land
    expect(acquireFileLock(path, "exclusive", { waitMs: 50 })).toBeNull();
    first?.release();
    expect(acquireFileLock(path, "exclusive", { waitMs: 50 })).toBeNull();

    second?.release();
    const swap = acquireFileLock(path, "exclusive", { waitMs: 50 });
    expect(swap).not.toBeNull();
    // and while the swap holds it, a reader waits rather than opening across the rename
    expect(acquireFileLock(path, "shared", { waitMs: 50 })).toBeNull();
    swap?.release();
    const after = acquireFileLock(path, "shared", { waitMs: 50 });
    expect(after).not.toBeNull();
    after?.release();
  });

  test("a swap that cannot get the hold gives up inside its budget instead of blocking", () => {
    const path = lockPath();
    const reader = acquireFileLock(path, "shared", { waitMs: 0 });
    const started = Date.now();
    const swap = acquireFileLock(path, "exclusive", { waitMs: 300, pollMs: 10 });
    const waited = Date.now() - started;
    expect(swap).toBeNull();
    // it waited for its budget, and it did NOT wait for the holder: a hung `ob` is the worse failure
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(3_000);
    reader?.release();
  });

  test("with no flock binding at all, ob still runs: the hold is granted and locks nothing", () => {
    // The degrade path. An `ob` that refuses to read because it could not lock would be worse than the
    // lost race this whole mechanism exists to close.
    const path = lockPath();
    const held = acquireFileLock(path, "shared", { waitMs: 0, flock: null });
    expect(held).not.toBeNull();
    const swap = acquireFileLock(path, "exclusive", { waitMs: 0, flock: null });
    expect(swap).not.toBeNull();
    held?.release();
    swap?.release();
  });

  test("a lock file in a directory that cannot be created never takes ob down", () => {
    // /dev/null/... cannot be a directory, so the open fails; the caller still gets a hold.
    const held = acquireFileLock("/dev/null/nope/replica.lock", "exclusive", { waitMs: 0 });
    expect(held).not.toBeNull();
    held?.release();
  });

  test("the release path unlocks exactly once, however many times it is called", () => {
    const path = lockPath();
    const calls: number[] = [];
    const stub: FlockFn = (_fd, op) => {
      calls.push(op);
      return 0;
    };
    const held = acquireFileLock(path, "shared", { waitMs: 0, flock: stub });
    held?.release();
    held?.release();
    // one acquire, one unlock: a second release must not close a file descriptor it no longer owns
    expect(calls.length).toBe(2);
  });

  test("this platform really does have a flock binding", () => {
    // If this ever fails, every test above is exercising the degrade path and the ticket is not fixed.
    expect(typeof systemFlock()).toBe("function");
  });
});

describe("file lock: a holder that died without releasing (308)", () => {
  test("a hold left by a killed process does not wedge the next swap", async () => {
    const path = lockPath();
    const module = join(import.meta.dir, "../../../apps/cli/src", "file-lock.ts");
    const script = `
      import { acquireFileLock } from ${JSON.stringify(module)};
      const held = acquireFileLock(${JSON.stringify(path)}, "shared", { waitMs: 0 });
      console.log(held ? "HELD" : "NOT-HELD");
      await new Promise((r) => setTimeout(r, 60_000));
    `;
    const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const said = new TextDecoder().decode((await child.stdout.getReader().read()).value ?? new Uint8Array());
    expect(said.trim()).toBe("HELD");

    // alive: the swap is refused, which is the whole point
    expect(acquireFileLock(path, "exclusive", { waitMs: 200 })).toBeNull();

    // killed with no chance to clean up: the kernel drops the hold, so there is nothing stale to reap
    child.kill(9);
    await child.exited;
    const swap = acquireFileLock(path, "exclusive", { waitMs: 2_000 });
    expect(swap).not.toBeNull();
    swap?.release();
  }, spawnBudget(1));
});

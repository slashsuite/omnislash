import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

// -----------------------------------------------------------------------------
// A cross-process advisory lock on a file (ticket 308).
//
// WHY THIS EXISTS AND NOT AN `ob` LEASE: the thing being protected is the local
// read replica, and `ob lease` rows live in the very database the replica IS. A
// lock that has to read the database to decide whether the database may be
// replaced is no lock at all, so this one is a plain file next to the replica
// and it never touches sqlite.
//
// WHY flock(2) AND NOT A LOCK FILE: three primitives were on the table.
//
//   1. A sqlite transaction on a dedicated lock database (BEGIN for a shared
//      hold, BEGIN EXCLUSIVE for the swap). It reads well and needs no FFI, and
//      it is UNUSABLE here: measured on bun 1.3.12, an open transaction does not
//      survive an event-loop turn. A handle that BEGINs, inserts and then awaits
//      anything has committed and dropped its locks by the time the await
//      resolves -- a second connection could both write and read the uncommitted
//      row, and no journal file was left behind. `run()` in cli.ts awaits its
//      handler, so a hold taken this way would evaporate exactly when it matters.
//   2. An atomic mkdir/O_EXCL lock with pids in it. Portable and no FFI, but it
//      has to detect a holder that died without releasing, and pid liveness is a
//      guess that pid reuse can get wrong. It also has no natural shared mode:
//      several concurrent readers means maintaining a directory of reader files
//      and reaping the dead ones, which is a lot of machinery to leave lying
//      around a path whose failure mode is a wedged `ob`.
//   3. flock(2) through bun:ffi -- what this is. The kernel already has exactly
//      the semantics the ticket asks for: LOCK_SH is genuinely shared between
//      readers, LOCK_EX waits for every one of them to clear, LOCK_NB turns the
//      wait into a poll this module can bound, and a hold is released by the
//      kernel when the fd closes OR the process dies, so a SIGKILLed reader
//      leaves NOTHING to clean up and nothing to misjudge. Verified on this
//      machine: EX is refused while another process holds SH, SH is granted
//      alongside it, and EX succeeds immediately after that process is killed -9.
//
// If the binding cannot be made at all (an unexpected platform, a build without
// FFI), every acquire returns a hold that locks nothing. That is deliberate: it
// degrades to the pre-308 behaviour, which is an occasional lost race, rather
// than to a refusal, which would be an `ob` that cannot read. A caller that must
// fail closed instead passes `strict` and gets the refusal (OB-1935).
// -----------------------------------------------------------------------------

export type FlockFn = (fd: number, op: number) => number;

const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** How long an acquire polls before it gives up. */
export const LOCK_WAIT_MS = 5_000;

let binding: { flock: FlockFn } | null | undefined;

/** The libc `flock`, looked up once. `null` means this platform has no usable binding. */
export function systemFlock(): FlockFn | null {
  if (binding === undefined) {
    try {
      const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
        flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      });
      binding = { flock: lib.symbols.flock as unknown as FlockFn };
    } catch {
      binding = null;
    }
  }
  return binding?.flock ?? null;
}

export interface FileHold {
  release(): void;
}

/** The hold handed out when there is nothing to lock with: releasing it is a no-op. */
const UNLOCKED: FileHold = { release() {} };

export interface AcquireOptions {
  /** How long to keep trying. The first attempt always happens, even at 0. */
  waitMs?: number;
  /** How long to sleep between attempts. */
  pollMs?: number;
  /**
   * The binding to lock with. Left out, the system one is used. Passed as `null` it stands for a
   * platform with no flock at all, which is how the degrade path is tested without an odd machine.
   */
  flock?: FlockFn | null;
  /**
   * Refuse (`null`) instead of handing back a no-op hold when there is no flock or the lock file cannot be
   * opened. For a caller that must fail closed rather than run unlocked (OB-1935, the OAuth state store).
   */
  strict?: boolean;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take a `shared` or `exclusive` hold on `path`, polling until `waitMs` runs out.
 *
 * Returns the hold, or `null` when the wait ran out with someone else still holding it. `null` is a
 * REFUSAL, and the caller decides what that means: a refresh gives up and leaves the replica where it
 * is (a slightly stale replica is fine, a hung `ob` is not), while a reader carries on unprotected
 * rather than failing a command it could have answered.
 */
export function acquireFileLock(
  path: string,
  kind: "shared" | "exclusive",
  opts: AcquireOptions = {},
): FileHold | null {
  const flock = opts.flock === undefined ? systemFlock() : opts.flock;
  if (!flock) return opts.strict ? null : UNLOCKED;

  let fd: number;
  try {
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, "a+");
  } catch {
    // A lock file that cannot even be opened must not take `ob` down with it.
    return opts.strict ? null : UNLOCKED;
  }

  const op = (kind === "shared" ? LOCK_SH : LOCK_EX) | LOCK_NB;
  const deadline = Date.now() + (opts.waitMs ?? LOCK_WAIT_MS);
  const pollMs = opts.pollMs ?? 10;
  for (;;) {
    if (flock(fd, op) === 0) {
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            flock(fd, LOCK_UN);
          } finally {
            closeSync(fd);
          }
        },
      };
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      closeSync(fd);
      return null;
    }
    sleep(Math.max(1, Math.min(pollMs, left)));
  }
}

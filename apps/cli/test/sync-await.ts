import { drainMicrotasks } from "bun:jsc";

/**
 * Settle a promise that is ALREADY resolvable and hand back its value synchronously (337).
 *
 * It exists for exactly one shape: the fake `RemoteWriter`s in the 189/191/225 tests, which stand in for
 * an `ob` sub-invocation on the server. The real writer shells out with `Bun.spawnSync`, so `capture` is
 * SYNCHRONOUS by construction and cannot become async without changing the seam every remote-dispatching
 * command uses. Its fake, though, plays the server by calling the real database functions -- and those
 * are async since the store port. This bridges the two without weakening what the test proves: the fake
 * still runs the genuine `doneAgent` / `stampSpinoff` / `releaseLease`, not a hand-written SQL imitation.
 *
 * It is sound ONLY because everything behind these calls is a bun:sqlite builder, which does its work on
 * the calling thread and resolves on the microtask queue -- so draining that queue is enough. Anything
 * that awaits real I/O (a Postgres round trip, a file read) never settles here and throws rather than
 * returning a wrong answer. TEST-ONLY: nothing in src may use this.
 */
export function syncAwait<T>(promise: Promise<T>): T {
  let value: T;
  let error: unknown;
  let state: "pending" | "ok" | "failed" = "pending";
  promise.then(
    (v) => {
      value = v;
      state = "ok";
    },
    (e) => {
      error = e;
      state = "failed";
    },
  );
  drainMicrotasks();
  if (state === "pending") {
    throw new Error("syncAwait: the promise did not settle on the microtask queue (real I/O is not supported here)");
  }
  if (state === "failed") throw error;
  return value!;
}

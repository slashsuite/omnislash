import type { AnyStateMachine } from "xstate";
import { decide, type RefusalWhy } from "./decide.ts";

/** How one row is read and written. The package holds no table and no driver; the caller supplies both halves. */
export interface MoveSpec<R> {
  /** The event to apply. */
  event: string;
  /**
   * The states this writer moves from, a guard narrower than the machine (a stamp moves only a `launching`
   * row, though `stamp` also leaves `launched`). Omitted: every state the machine moves by `event`.
   */
  from?: readonly string[];
  /** The stored state, or null when there is no such row. */
  read: () => Promise<string | null>;
  /** The guarded write: set `to` only while the row is still `from` (`UPDATE ... WHERE status = from`). Null when nothing moved. */
  write: (from: string, to: string) => Promise<R | null>;
}

export type MoveOutcome<R> =
  | { ok: true; row: R; from: string; to: string }
  | { ok: false; why: RefusalWhy; from: string | null; event: string };

/**
 * OS-173 (spike OS-167 section 4): one move. Read the stored state, `decide` the event on it, check the
 * writer's own `from` guard, then the guarded write. When the row moved between the read and the write, the
 * move is decided again on where it is now, and written if the event still leads to the same target from there
 * (a `land` on a row handed off meanwhile still lands, as the old `status IN (...)` write did); otherwise that
 * is a `race`. A write that moved nothing on an unmoved row is a `guard` (the write's own extra condition
 * refused it). Never throws a refusal; the caller turns one into its own error. A missing row is a `machine`
 * refusal from null.
 */
export async function applyMove<R>(machine: AnyStateMachine, spec: MoveSpec<R>): Promise<MoveOutcome<R>> {
  const { event } = spec;
  let from = await spec.read();
  if (from === null) return { ok: false, why: "machine", from, event };
  const d = decide(machine, from, event);
  if (!d.ok) return { ok: false, why: "machine", from, event };
  if (spec.from && !spec.from.includes(from)) return { ok: false, why: "guard", from, event };
  // Bounded: each retry needs another writer to have moved the row, and the machine has six states.
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await spec.write(from, d.to);
    if (row !== null) return { ok: true, row, from, to: d.to };
    const now = await spec.read();
    if (now === from) return { ok: false, why: "guard", from, event };
    const again = now === null ? null : decide(machine, now, event);
    const allowed = now !== null && again?.ok === true && again.to === d.to && (!spec.from || spec.from.includes(now));
    if (!allowed) return { ok: false, why: "race", from: now, event };
    from = now;
  }
  return { ok: false, why: "race", from, event };
}

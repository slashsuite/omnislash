import type { RefusalWhy } from "../../../platform/state-machine/src/decide.ts";

export class UsageError extends Error {}
export class AppError extends Error {}

/**
 * A move a lifecycle machine refused (OS-169, spike OS-167 step 2): which machine, the row or item, the
 * stored state, the event tried and why. Nothing throws it directly yet; `SpinoffTransitionRefused` extends
 * it so the enforcement steps can catch one type for every refused move.
 */
export class TransitionRefused extends AppError {
  readonly machine: string;
  readonly id: string;
  readonly from: string;
  readonly event: string;
  readonly why: RefusalWhy;

  constructor(
    message: string,
    fields: { machine: string; id: string; from: string; event: string; why: RefusalWhy },
  ) {
    super(message);
    this.name = "TransitionRefused";
    this.machine = fields.machine;
    this.id = fields.id;
    this.from = fields.from;
    this.event = fields.event;
    this.why = fields.why;
  }
}

/**
 * OS-171 (spike OS-167 step 4): an item status write found the row no longer in the status the door read.
 * Another writer moved it between the read and the guarded `UPDATE ... WHERE status = <from>`, so this move
 * is refused rather than written over theirs. A `TransitionRefused` (why `race`), so every handler that maps
 * `AppError` to a 409 maps it too.
 */
export class StatusRaced extends TransitionRefused {
  readonly to: string;

  constructor(id: string, from: string, to: string) {
    super(`item '${id}' moved while '${from}' -> '${to}' was being written: it is no longer '${from}', so nothing was changed. Read it again`, {
      machine: "item",
      id,
      from,
      // `moveEvent(to)`, spelled here so this module does not load xstate.
      event: `to:${to}`,
      why: "race",
    });
    this.name = "StatusRaced";
    this.to = to;
  }
}

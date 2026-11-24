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

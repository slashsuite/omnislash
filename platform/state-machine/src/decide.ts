import { type AnyStateMachine, transition } from "xstate";

/**
 * Why a move was refused. `decide` gives only `machine` so far (OS-168): the machine has no such move from
 * that state, or the stored state is not one of its states. `guard` and `race` come with the guarded writer;
 * the type is wide now (OS-169) so `TransitionRefused` in apps/cli/src/errors.ts can carry any of them.
 */
export type RefusalWhy = "machine" | "guard" | "race";

export type Decision =
  | { ok: true; to: string }
  | { ok: false; why: RefusalWhy; from: string; event: string; message: string };

/**
 * Pure: the state `event` leads to from the stored state `from`, or a refusal. No actor and no I/O, only
 * XState's `resolveState`, `can` and `transition`. A stored value the machine does not know (the item status
 * is free TEXT) is refused, never thrown: `resolveState` throws on an unknown state, and a read must not crash.
 */
export function decide(machine: AnyStateMachine, from: string, event: string): Decision {
  const refuse = (message: string): Decision => ({ ok: false, why: "machine", from, event, message });
  if (!Object.hasOwn(machine.states, from)) {
    return refuse(`'${from}' is not a state of '${machine.id}'`);
  }
  const snapshot = machine.resolveState({ value: from, context: {} });
  if (!snapshot.can({ type: event })) {
    return refuse(`'${machine.id}' is ${from}: '${event}' is not a move from there`);
  }
  const [next] = transition(machine, snapshot, { type: event });
  return { ok: true, to: String(next.value) };
}

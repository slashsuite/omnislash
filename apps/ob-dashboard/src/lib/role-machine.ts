// OS-187, OS-214: the role and spinoff xstate machines (platform/state-machine) drawn by uislash's StateMachine,
// through fromXState. The role machine's meta sets each state's owner and whether a person must act on it; the
// failed end keeps its own tone. OS-237: each transition's meta.actor (role.ts) reaches fromXState as the arrow's
// actor, so a line takes the colour of the role that makes the move. Pure: nothing here reads a file or the store.
import { type CategoryTone, fromXState, type StateMachineDefinition, type StateMachineItem, type XStateMachineLike } from "@slashsuite/ui-react";
import { type Role, type RoleStateMeta, roleMachine } from "../../../../platform/state-machine/src/role.ts";
import { spinoffMachine } from "../../../../platform/state-machine/src/spinoff.ts";

/** A ticket in flight: its ref, its title and the id of the role state it is in. */
export type RoleTicket = { ref: string; title: string; state: string };

/**
 * OS-237: the owner keeps one colour whatever other roles the machine has, so the states and moves that are his
 * read the same on every diagram. The other roles take the next colours in order.
 */
export const ROLE_TONES: Readonly<Partial<Record<Role, CategoryTone>>> = { owner: "cat2" };

/** The one terminal state that means the work stopped, drawn in the danger tone rather than as done. */
const FAILED = "failed";

/** The role machine as a StateMachine definition: each state owned by its role, a human state in the warn tone. */
export function roleDefinition(): StateMachineDefinition {
  // xstate types a transition target as a StateNode; fromXState reads it as a state id. The shapes agree at runtime.
  return fromXState(roleMachine as unknown as XStateMachineLike, {
    state: ({ id, node, state }) => {
      const meta = node.meta as RoleStateMeta;
      const kind = meta.human_required ? "human" : id === FAILED ? "failed" : state.kind;
      return { ...state, owner: meta.role, kind };
    },
  });
}

/** The spinoff machine as a StateMachine definition: its states and the events that move a row between them. */
export function spinoffDefinition(): StateMachineDefinition {
  return fromXState(spinoffMachine as unknown as XStateMachineLike);
}

/** Each ticket as a dot: its ref on the dot, the ref and title as its name. */
export function roleItems(tickets: readonly RoleTicket[]): StateMachineItem[] {
  return tickets.map((t) => ({ id: t.ref, label: `${t.ref} ${t.title}`, state: t.state }));
}

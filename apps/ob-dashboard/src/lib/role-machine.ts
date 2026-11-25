// OS-187: the role state machine JSON (docs/role-state-machine.json, written by state-machine:export from
// platform/state-machine/src/role.ts) mapped onto uislash's StateMachine. Pure: the JSON comes in as an argument,
// so the component draws whatever machine it is handed and never reads a file or the server itself.
import type { StateMachineDefinition, StateMachineItem, StateMachineKind } from "@slashsuite/ui-react";

/** One state and one transition as the v1 JSON writes them (platform/state-machine/src/export.ts). */
type RoleStateJson = { id: string; label: string; role: string; human_required: boolean; terminal: boolean };
type RoleTransitionJson = { from: string; to: string; label: string; event: string; actor: string; source: string };

/** The parts of the role machine JSON the diagram reads. */
export type RoleMachineJson = { states: readonly RoleStateJson[]; transitions: readonly RoleTransitionJson[] };

/** A ticket in flight: its ref, its title and the id of the role state it is in. */
export type RoleTicket = { ref: string; title: string; state: string };

/** The one terminal state that means the work stopped, drawn in the danger tone rather than as done. */
const FAILED = "failed";

/**
 * A state's kind: waiting on a person (`human`, the warn tone) wins, then the failed end, then the other
 * terminal states. The JSON marks no initial state, and its first one (`idea`) is the owner's, so it is human.
 */
function kindOf(s: RoleStateJson): StateMachineKind {
  if (s.human_required) return "human";
  if (s.terminal) return s.id === FAILED ? "failed" : "terminal";
  return "normal";
}

/**
 * The JSON as a StateMachine definition: each state owned by its role, each arrow named by the transition's
 * short `label` (its `event` field is the long description, too long for an arrow).
 */
export function roleDefinition(machine: RoleMachineJson): StateMachineDefinition {
  return {
    states: machine.states.map((s) => ({ id: s.id, label: s.label, kind: kindOf(s), owner: s.role })),
    transitions: machine.transitions.map((t) => ({ from: t.from, to: t.to, event: t.label })),
  };
}

/** Each ticket as a dot: its ref on the dot, the ref and title as its name. */
export function roleItems(tickets: readonly RoleTicket[]): StateMachineItem[] {
  return tickets.map((t) => ({ id: t.ref, label: `${t.ref} ${t.title}`, state: t.state }));
}

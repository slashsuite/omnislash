// OS-187, OS-214: the role and spinoff xstate machines (platform/state-machine). OS-261: the role machine is drawn as
// persona swimlanes, one lane per role and one column per stage, each state a card in its lane and stage that lists
// the moves out of it, so the page says which persona does what, where. The spinoff machine is still drawn by uislash's
// StateMachine, through fromXState. Pure: nothing here reads a file or the store.
import { type CategoryTone, fromXState, type StateMachineDefinition, type XStateMachineLike } from "@slashsuite/ui-react";
import { ROLE_TRANSITIONS, ROLES, type Role, type RoleStateMeta, roleMachine, STAGES, type Stage } from "../../../../platform/state-machine/src/role.ts";
import { spinoffMachine } from "../../../../platform/state-machine/src/spinoff.ts";

/** A ticket in flight: its ref, its title and the id of the role state it is in. */
export type RoleTicket = { ref: string; title: string; state: string };

/**
 * OS-237, OS-261: each persona's colour, from uislash's categorical scale (every theme remaps it). The owner keeps
 * orange; the system, which is machinery rather than a persona, is grey.
 */
const ROLE_TONES: Readonly<Record<Role, CategoryTone | "neutral">> = {
  owner: "cat2",
  muse: "cat1",
  architect: "cat3",
  builder: "cat4",
  reviewer: "cat5",
  sentinel: "cat6",
  system: "neutral",
};

/** The text colour utility each tone paints in (uislash's VIZ_TONE, which it does not export). */
const TONE_CLASS: Readonly<Record<CategoryTone | "neutral", string>> = {
  neutral: "text-neutral-500",
  cat1: "text-indigo-600",
  cat2: "text-orange-600",
  cat3: "text-teal-600",
  cat4: "text-pink-600",
  cat5: "text-lime-600",
  cat6: "text-fuchsia-600",
  cat7: "text-rose-600",
  cat8: "text-yellow-600",
};

/** A persona's colour as a text colour utility: paint a swatch with `bg-current`. */
export const roleColour = (role: Role): string => TONE_CLASS[ROLE_TONES[role]];

/** How a lane and a stage are named on the page. */
export const ROLE_NAMES: Readonly<Record<Role, string>> = {
  owner: "Owner",
  muse: "Muse",
  architect: "Architect",
  builder: "Builder",
  reviewer: "Reviewer",
  sentinel: "Sentinel",
  system: "System",
};
export const STAGE_NAMES: Readonly<Record<Stage, string>> = { idea: "Idea", plan: "Plan", build: "Build", ship: "Ship", done: "Done" };

/** What a state is: where work starts, waiting on a person, an end, the failed end, or none of those. */
export type LaneKind = "initial" | "human" | "terminal" | "failed" | "normal";

/** One move out of a state: its plain label, the persona that makes it, and the state it goes to. */
export type LaneMove = { to: string; toLabel: string; label: string; actor: Role };

/** One state, as the swimlanes draw it. */
export type LaneState = { id: string; label: string; role: Role; stage: Stage; kind: LaneKind; moves: LaneMove[] };

/** The swimlanes: the lanes and stages in order, and the states in each cell (lane, stage) in machine order. */
export type Lanes = {
  lanes: readonly Role[];
  stages: readonly Stage[];
  states: readonly LaneState[];
  cell: (role: Role, stage: Stage) => LaneState[];
};

/** The one terminal state that means the work stopped, drawn in the danger tone rather than as done. */
const FAILED = "failed";

/** The role machine as swimlanes: every state in its persona's lane and its stage's column, with its moves. */
export function roleLanes(): Lanes {
  const nodes = Object.entries(roleMachine.states);
  const labelOf = new Map(nodes.map(([id, node]) => [id, (node.meta as RoleStateMeta).label]));
  const states: LaneState[] = nodes.map(([id, node]) => {
    const meta = node.meta as RoleStateMeta;
    const kind: LaneKind = meta.human_required
      ? "human"
      : id === FAILED
        ? "failed"
        : node.type === "final"
          ? "terminal"
          : id === roleMachine.config.initial
            ? "initial"
            : "normal";
    const moves = ROLE_TRANSITIONS.filter((t) => t.from === id).map((t) => ({ to: t.to, toLabel: labelOf.get(t.to) ?? t.to, label: t.label, actor: t.actor }));
    return { id, label: meta.label, role: meta.role, stage: meta.stage, kind, moves };
  });
  return {
    lanes: ROLES,
    stages: STAGES,
    states,
    cell: (role, stage) => states.filter((s) => s.role === role && s.stage === stage),
  };
}

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

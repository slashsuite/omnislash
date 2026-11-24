import { setup } from "xstate";

/**
 * The item lifecycles (OS-168), the one definition of which item status moves are allowed: since OS-172
 * `apps/cli/src/workflow.ts` decides every item move through these machines (`decide`). Each machine's
 * states must match the type's vocabulary in apps/cli/src/status.ts, and test/parity.test.ts pins every
 * from-to pair, so an edge change is a reviewed diff in both places.
 *
 * Events are the target status, `to:<status>` (`moveEvent`). A self-move (`to:<from>` from `from`) is an
 * allowed no-op, so a retried close succeeds and records nothing.
 */
type Table<S extends string> = Readonly<Record<S, readonly S[]>>;

/** The event that moves an item to `status` in this step. */
export function moveEvent(status: string): string {
  return `to:${status}`;
}

/** A flat machine whose events are `to:<target>`, one edge per table entry plus a self-move per state. */
function tableMachine<S extends string>(id: string, initial: S, table: Table<S>) {
  const states = Object.fromEntries(
    (Object.keys(table) as S[]).map((from) => [
      from,
      { on: Object.fromEntries([from, ...table[from]].map((to) => [moveEvent(to), { target: to }])) },
    ]),
  );
  return setup({ types: { events: {} as { type: string } } }).createMachine({ id, initial, states });
}

/** A task's stored status (today's `BASIC_TRANSITIONS` vocabulary). */
export type TaskStatus = keyof typeof BASIC;

const BASIC = {
  open: ["in_progress", "ready", "blocked", "done"],
  in_progress: ["ready", "blocked", "done", "open"],
  ready: ["merged", "in_progress", "blocked", "done"],
  merged: ["done", "blocked", "open"],
  blocked: ["open", "in_progress", "ready", "done"],
  done: ["open"],
} as const satisfies Table<string>;

const LINEAR = {
  open: ["in_progress", "ready", "blocked", "done"],
  in_progress: ["ready", "blocked", "done", "open"],
  ready: ["merged", "in_progress", "blocked", "qa_ready", "done"],
  merged: ["qa_ready", "done", "blocked"],
  qa_ready: ["qa", "blocked", "done"],
  qa: ["qa_rework", "done", "blocked"],
  qa_rework: ["in_progress", "ready", "qa", "blocked", "done"],
  blocked: ["open", "in_progress", "ready", "done"],
  done: ["open"],
} as const satisfies Table<string>;

const ROADMAP = { active: ["archived"], archived: ["active"] } as const satisfies Table<string>;

const DECISION = {
  draft: ["accepted", "superseded"],
  accepted: ["superseded"],
  superseded: [],
} as const satisfies Table<string>;

const LEARNING = {
  todo: ["in_progress", "done"],
  in_progress: ["done", "todo"],
  done: ["todo", "in_progress"],
} as const satisfies Table<string>;

// OB-2004: a reference document is not work, so it has one state and no moves out of it.
const REFERENCE = { active: [] } as const satisfies Table<string>;

/** A task of any kind (the kind does not change the lifecycle). */
export const taskMachine = tableMachine("task", "open", BASIC);
/** `linear_ref`, with the QA states. */
export const linearMachine = tableMachine("linear_ref", "open", LINEAR);
export const roadmapMachine = tableMachine("roadmap", "active", ROADMAP);
export const decisionMachine = tableMachine("decision", "draft", DECISION);
export const learningMachine = tableMachine("learning", "todo", LEARNING);
export const referenceMachine = tableMachine("reference", "active", REFERENCE);

export type ItemMachine = typeof taskMachine;

/**
 * The machine for an item of `type` and `kind`: the per-type machines first, `linear_ref`, and the task
 * lifecycle for anything else. `kind` is taken so a kind that
 * gets its own table later has one place to go; today every kind gets the task machine.
 */
export function itemMachineFor(type: string, _kind: string | null): ItemMachine {
  switch (type) {
    case "roadmap":
      return roadmapMachine;
    case "decision":
      return decisionMachine;
    case "learning":
      return learningMachine;
    case "reference":
      return referenceMachine;
    case "linear_ref":
      return linearMachine;
    default:
      return taskMachine;
  }
}

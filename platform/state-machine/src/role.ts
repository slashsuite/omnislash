import { setup } from "xstate";
import { moveEvent, type TaskStatus } from "./item.ts";
import { PHASES_BY_STATUS, type SpinoffPhase } from "./spinoff-phase.ts";
import { SPINOFF_EDGES, type SpinoffEvent, type SpinoffState } from "./spinoff.ts";

/**
 * The role state machine (OS-174, spike OS-167 section 6): what the skills and the code do to a piece of work,
 * from an idea to a closed ticket. It was hand-kept in slashslash `docs/role-state-machine.json` (SS-130); this
 * file is now its source, and `bunx moon run state-machine:export` writes `docs/role-state-machine.json` and
 * `.mmd` from `roleMachine` (src/export.ts). CI fails when the committed files drift from it.
 *
 * Only the item and spinoff machines underneath are enforced. This one rides on them: each state's
 * `meta.stored` names the item or row status it sits on, or null before any item exists (the muse phase).
 * Several role states share one stored status (parked_idea, drilling and checking are all `item:open`; building,
 * the owner's call, partial and review are all `spinoff:launched`; the sentinel's sub-states are all `spinoff:ready-for-gate`), so
 * stored data cannot tell them apart. Nothing calls `decide` on it yet.
 *
 * OS-230: the role states that only mirror a row status or a phase (queued, launching, building, handed_off, failed,
 * and the five phases) are built from the row and phase machines: `ROW_STATE` names each status's state, and the
 * status a phase belongs to, and whether the state is final, come from `PHASES_BY_STATUS` and `SPINOFF_EDGES`. Only
 * what those machines do not say (label, role, human_required) is kept here, in `MIRRORED`.
 *
 * A transition's `meta.source` is where the move is applied. A move code enforces names the symbol that applies
 * it (`<path>#<event or function>`), so it cannot drift with line numbers; a skill-only move keeps its
 * hand-written `skills/<name>/SKILL.md:<line>`, read at `SKILLS_READ_AT`.
 *
 * OS-236: there is one reviewer role with two steps, the blind brief check (`checking`) and the skeptical review
 * round (`reviewing`). They stay separate states; the old `checker` role is gone.
 */

export const ROLES = ["owner", "muse", "architect", "builder", "reviewer", "sentinel", "system"] as const;
export type Role = (typeof ROLES)[number];

/** The omnibus commit the `skills/...:<line>` sources were read at (SS-130). */
export const SKILLS_READ_AT = "74cca003 (2026-11-21)";

/** The stored status a role state rides on, or null when no column holds it. */
export type Stored = { table: "spinoff"; status: SpinoffState } | { table: "item"; status: TaskStatus } | null;

export type RoleStateMeta = { label: string; role: Role; human_required: boolean; stored: Stored };
export type RoleTransitionMeta = { label: string; actor: Role; source: string };

/** The spinoff row event that applies a move. */
const rowEvent = (event: SpinoffEvent) => `platform/state-machine/src/spinoff.ts#${event}`;
/** The task machine event that applies a move. */
const taskMove = (status: TaskStatus) => `platform/state-machine/src/item.ts#${moveEvent(status)}`;
/** A function outside the machines that refuses the move (test/role.test.ts checks it is declared there). */
const code = (path: string, fn: string) => `${path}#${fn}`;

const DISPATCH_CHECK = code("platform/cli-coord/src/spinoff-check.ts", "refuseUncheckedDispatch");

const row = (status: SpinoffState): Stored => ({ table: "spinoff", status });
const item = (status: TaskStatus): Stored => ({ table: "item", status });

type StateDef = RoleStateMeta & { id: string; terminal?: true };

/**
 * OS-230: the role state a row sits in per stored status when it has no phase (the dashboard places rows by it).
 * `merged` sits on `closed`, which is the item's state (`item:done`), so it is not a mirrored state.
 */
export const ROW_STATE = {
  pending: "queued",
  launching: "launching",
  launched: "building",
  "ready-for-gate": "handed_off",
  merged: "closed",
  failed: "failed",
} as const satisfies Record<SpinoffState, string>;

/** The role states that mirror a row status or a phase: every one is a key of `MIRRORED`. */
export type MirroredState = Exclude<(typeof ROW_STATE)[SpinoffState], "closed"> | SpinoffPhase;

/** What the row and phase machines do not say about the states that mirror them. */
const MIRRORED: Readonly<Record<MirroredState, Omit<RoleStateMeta, "stored">>> = {
  queued: { label: "Spinoff queued", role: "system", human_required: false },
  launching: { label: "Spinoff launching", role: "system", human_required: false },
  building: { label: "Building", role: "builder", human_required: false },
  reviewing: { label: "Skeptical review round", role: "reviewer", human_required: false },
  pr_ci: { label: "PR open, waiting on CI", role: "builder", human_required: false },
  handed_off: { label: "Handed off, in the sentinel inbox", role: "sentinel", human_required: false },
  gating: { label: "Sentinel gating the PR head", role: "sentinel", human_required: false },
  updating_pr: { label: "Sent back, builder updating the PR", role: "builder", human_required: false },
  owner_merge_call: { label: "Merge call only the owner can make", role: "owner", human_required: true },
  failed: { label: "Failed or abandoned", role: "system", human_required: false },
};

/**
 * The mirrored states, built from the machines: a status's own state rides on that status and is final when the
 * row machine has no move out of it; a phase's state rides on the status that holds the phase.
 */
export const MIRRORED_STATES: Readonly<Record<MirroredState, StateDef>> = (() => {
  const out: Partial<Record<MirroredState, StateDef>> = {};
  for (const status of Object.keys(SPINOFF_EDGES) as SpinoffState[]) {
    const own = ROW_STATE[status];
    if (own !== "closed") {
      const terminal = Object.keys(SPINOFF_EDGES[status]).length === 0;
      out[own] = { id: own, ...MIRRORED[own], stored: row(status), ...(terminal ? { terminal: true as const } : {}) };
    }
    for (const phase of PHASES_BY_STATUS[status] ?? []) out[phase] = { id: phase, ...MIRRORED[phase], stored: row(status) };
  }
  return out as Record<MirroredState, StateDef>;
})();

const mirrored = (id: MirroredState): StateDef => MIRRORED_STATES[id];

/** Every state, in the order the export writes them. `terminal` becomes `type: "final"`. */
const STATES: readonly StateDef[] = [
  { id: "exploring", label: "Exploring the design", role: "muse", human_required: false, stored: null },
  { id: "confirm_complete", label: "Is the thought complete?", role: "owner", human_required: true, stored: null },
  { id: "parked_idea", label: "Parked idea (tag idea)", role: "muse", human_required: false, stored: item("open") },
  { id: "drilling", label: "Drilling (## Drilled, ## Done when)", role: "architect", human_required: false, stored: item("open") },
  { id: "checking", label: "Blind check (measure twice)", role: "reviewer", human_required: false, stored: item("open") },
  { id: "owner_plan_call", label: "Planning call only the owner can make", role: "owner", human_required: true, stored: item("open") },
  { id: "spike", label: "Spike running", role: "builder", human_required: false, stored: row("launched") },
  mirrored("queued"),
  mirrored("launching"),
  mirrored("building"),
  mirrored("reviewing"),
  mirrored("pr_ci"),
  { id: "owner_call", label: "Owner's call (verdict blocked or needs-human)", role: "owner", human_required: true, stored: row("launched") },
  { id: "partial", label: "Partial (verdict)", role: "builder", human_required: false, stored: row("launched") },
  mirrored("handed_off"),
  mirrored("gating"),
  mirrored("updating_pr"),
  mirrored("owner_merge_call"),
  { id: "closed", label: "Closed (ticket done)", role: "sentinel", human_required: false, stored: item("done"), terminal: true },
  mirrored("failed"),
];

/** The ids of `STATES`, for the test that every mirrored state is drawn exactly once. */
export const STATE_IDS: readonly string[] = STATES.map((s) => s.id);

/** One move. `event` is the XState event name, written out as the export's `event`. */
export type RoleTransition = RoleTransitionMeta & { from: string; to: string; event: string };

/** Every move, in the order the export writes them. */
export const ROLE_TRANSITIONS: readonly RoleTransition[] = [
  { from: "exploring", to: "confirm_complete", label: "looks whole", event: "thought looks whole; muse asks with the question tool", actor: "muse", source: "skills/ob-muse/SKILL.md:22" },
  { from: "confirm_complete", to: "exploring", label: "no, keep going", event: "owner says no or let me think", actor: "owner", source: "skills/ob-muse/SKILL.md:24" },
  { from: "confirm_complete", to: "drilling", label: "yes, ticket it", event: "owner says yes; ob add, then t3_thread_send (queue) to the team architect", actor: "muse", source: "skills/ob-muse/SKILL.md:23" },
  { from: "exploring", to: "parked_idea", label: "note a raw idea", event: "owner asks to note a raw idea; ob add + ob tag idea", actor: "muse", source: "skills/ob-muse/SKILL.md:24" },
  { from: "parked_idea", to: "confirm_complete", label: "picks it up", event: "owner returns to the idea", actor: "owner", source: "skills/ob-architect/SKILL.md:261" },
  { from: "drilling", to: "checking", label: "seal score, run checker", event: "architect seals its score; runs the Haiku checker on ob spinoff brief", actor: "architect", source: "skills/ob-architect/SKILL.md:401" },
  { from: "checking", to: "queued", label: "go, ob spinoff", event: "ob spinoff check: every checker question resolved (go); ob spinoff <ref>", actor: "architect", source: DISPATCH_CHECK },
  { from: "checking", to: "drilling", label: "no-go, change ticket", event: "ob spinoff check: an unresolved question (no-go); change the ticket, at most twice", actor: "architect", source: "skills/ob-architect/SKILL.md:418" },
  { from: "drilling", to: "owner_plan_call", label: "owner's call", event: "the open question is the owner's call", actor: "architect", source: "skills/ob-architect/SKILL.md:422" },
  { from: "owner_plan_call", to: "drilling", label: "answer", event: "owner answers", actor: "owner", source: "skills/ob-architect/SKILL.md:422" },
  { from: "drilling", to: "spike", label: "only by trying", event: "unknown only by trying; spike ticket dispatched (no score, needs Questions, Box, Done when)", actor: "architect", source: DISPATCH_CHECK },
  { from: "spike", to: "drilling", label: "answers on parent", event: "spike answers with ob note on the parent; architect rescores", actor: "builder", source: "skills/ob-architect/SKILL.md:434" },
  { from: "spike", to: "closed", label: "spike closed", event: "ob close on the spike; row ends failed with a spike error", actor: "architect", source: rowEvent("fail") },
  { from: "drilling", to: "queued", label: "no-check with reason", event: "still under 70 after two tries: ob spinoff <ref> --no-check '<why>'", actor: "architect", source: DISPATCH_CHECK },
  { from: "queued", to: "launching", label: "claim", event: "launch claims the row", actor: "system", source: rowEvent("claim") },
  { from: "launching", to: "building", label: "thread opened", event: "T3 thread opened; row stamped launched", actor: "system", source: rowEvent("stamp") },
  { from: "launching", to: "queued", label: "retry launch", event: "spawn failure or stale claim, under MAX_LAUNCH_ATTEMPTS (2)", actor: "system", source: rowEvent("retry") },
  { from: "launching", to: "failed", label: "attempt cap hit", event: "spawn failure at the attempt cap", actor: "system", source: rowEvent("fail") },
  { from: "queued", to: "failed", label: "abandon", event: "abandoned before launch", actor: "architect", source: rowEvent("fail") },
  { from: "building", to: "failed", label: "abandon or lost trial", event: "abandoned, or lost a trial pair", actor: "architect", source: rowEvent("fail") },
  { from: "building", to: "reviewing", label: "review legs run", event: "build and local gate done; review legs launched on git diff main...HEAD", actor: "builder", source: "skills/ob-spinoff/SKILL.md:181" },
  { from: "reviewing", to: "building", label: "open finding, fix", event: "a wrong finding, or a rejected answer, is open; fix and run the next (rebuttal) round", actor: "reviewer", source: "skills/ob-skeptical-review/SKILL.md:266" },
  { from: "reviewing", to: "pr_ci", label: "0 open, open PR", event: "0 open; rebase, push, gh pr create", actor: "builder", source: "skills/ob-spinoff/SKILL.md:212" },
  { from: "pr_ci", to: "building", label: "CI fails, fix", event: "a CI check fails; fix on the branch", actor: "builder", source: code("platform/cli-coord/src/commands/spinoff.ts", "assertHandoffCiForRow") },
  { from: "pr_ci", to: "handed_off", label: "handoff, CI green", event: "verdict landable and CI green: ob spinoff handoff (note to the team sentinel, else architect)", actor: "builder", source: rowEvent("handoff") },
  { from: "pr_ci", to: "owner_call", label: "verdict needs-human", event: "verdict needs-human; builder asks with the question tool", actor: "builder", source: "skills/ob-spinoff/SKILL.md:114" },
  { from: "owner_call", to: "handed_off", label: "owner hands off", event: "needs-human only (a blocked build has no PR): owner runs /ob-spinoff-handoff (the human yes)", actor: "owner", source: rowEvent("handoff") },
  { from: "owner_call", to: "building", label: "owner answers", event: "owner gives the decision or access, or answers with a change to make", actor: "owner", source: "skills/ob-architect/SKILL.md:103" },
  { from: "building", to: "owner_call", label: "verdict blocked", event: "verdict blocked: a decision or access is missing; no PR", actor: "builder", source: "skills/ob-spinoff/SKILL.md:117" },
  { from: "building", to: "partial", label: "verdict partial", event: "verdict partial: some Done when items unmet; no PR", actor: "builder", source: "skills/ob-spinoff/SKILL.md:119" },
  { from: "partial", to: "building", label: "redispatch", event: "architect redispatches or steers the rest", actor: "architect", source: "skills/ob-architect/SKILL.md:102" },
  { from: "handed_off", to: "gating", label: "read inbox", event: "the sentinel (else the architect) reads its inbox, oldest first, and starts the gate", actor: "sentinel", source: code("apps/cli/src/inbox.ts", "listRoleMessages") },
  { from: "gating", to: "updating_pr", label: "sendback", event: "red CI, a Done when item unmet, a claim it cannot verify, or a PR that conflicts (or is behind main with an overlap): ob spinoff sendback to the builder", actor: "sentinel", source: rowEvent("sendback") },
  { from: "updating_pr", to: "handed_off", label: "fixed, handoff again", event: "builder fixes it on the branch, pushes, CI green: ob spinoff handoff again", actor: "builder", source: rowEvent("handoff") },
  { from: "gating", to: "owner_merge_call", label: "taste, waiver or flake", event: "a taste call, a waived check, or a known flake", actor: "sentinel", source: "skills/ob-sentinel/SKILL.md:51" },
  { from: "owner_merge_call", to: "gating", label: "owner answers", event: "owner answers", actor: "owner", source: "skills/ob-land/SKILL.md:198" },
  { from: "owner_merge_call", to: "building", label: "owner sends back for more work", event: "owner's yes lands part of the ticket and the builder carries on in the same thread: ob spinoff resume", actor: "owner", source: rowEvent("resume") },
  { from: "gating", to: "closed", label: "merge, deploy, close", event: "every gate question yes: gh pr merge --squash, ob deploy run --sha, then ob close (ticket done, rows landed, unread handoffs withdrawn)", actor: "sentinel", source: taskMove("done") },
  { from: "closed", to: "building", label: "reopen", event: "ob spinoff reopen: an exception for a row that reconcile landed although nothing merged", actor: "architect", source: rowEvent("reopen") },
];

/** Each state's moves, keyed by event, with the transition `meta` (label, actor, source). */
function onFor(from: string) {
  return Object.fromEntries(
    ROLE_TRANSITIONS.filter((t) => t.from === from).map((t) => [
      t.event,
      { target: t.to, meta: { label: t.label, actor: t.actor, source: t.source } satisfies RoleTransitionMeta },
    ]),
  );
}

export const roleMachine = setup({ types: { events: {} as { type: string } } }).createMachine({
  id: "role",
  initial: "exploring",
  states: Object.fromEntries(
    STATES.map(({ id, terminal, ...meta }) => [
      id,
      { ...(terminal ? { type: "final" as const } : {}), meta: meta satisfies RoleStateMeta, on: onFor(id) },
    ]),
  ),
});

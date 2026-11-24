export type Kind = "side" | "home" | "admin" | "learning";

const LINEAR_STATUSES = [
  "open",
  "in_progress",
  "ready",
  "merged",
  "qa_ready",
  "qa",
  "qa_rework",
  "done",
  "blocked",
];

// side/home/admin/learning-kind tickets (the ob-native wayfinder loop) get a `ready`/`merged`
// review-gate on top of the basic set so chart→start→ready→merged→close works natively (154/G2).
// Additive only — no existing status is removed, and the DB stores status as free TEXT (no enum/CHECK),
// so this is a pure app-vocab change (097 schema fingerprint unaffected).
const BASIC_STATUSES = ["open", "in_progress", "ready", "merged", "blocked", "done"];

const ROADMAP_STATUSES = ["active", "archived"];
const DECISION_STATUSES = ["draft", "accepted", "superseded"];
const LEARNING_STATUSES = ["todo", "in_progress", "done"];
// OB-2004: a reference document is not work, so it has one status. The moves between statuses are the
// lifecycle machines in platform/state-machine/src/item.ts (OS-172).
const REFERENCE_STATUSES = ["active"];

/**
 * The item types anything may create. Here rather than in capture.ts (352) because the API's create
 * endpoint has to refuse an unknown type the same way `ob add --type` does, and importing capture.ts to
 * learn the list would drag the GitHub-issue path into the server for the sake of five strings.
 */
export const VALID_TYPES = ["task", "linear_ref", "roadmap", "decision", "learning", "reference"];

/**
 * Item types that are not work (OB-2004): `queryItems({ open: true })`, `ob next`, `ob list --open`, the
 * `ob status` focus and blocked lists and the aging alert all leave them out. Only `reference` is here;
 * decision, learning and roadmap items keep the queue behaviour they have today.
 */
export const NON_QUEUE_TYPES = ["reference"];

/**
 * The statuses that mean an item of this type is finished work (OB-1929): task, linear_ref and learning at
 * `done`; a roadmap once archived; a decision once it has a
 * verdict (accepted or superseded). An unknown type falls back to `done`. `project rm` and the drift report
 * read this rather than treating every status but `done` as open. (`ob list --open` has its own rule.)
 */
export function closedStatuses(type: string): readonly string[] {
  switch (type) {
    case "roadmap":
      return ["archived"];
    case "decision":
      return ["accepted", "superseded"];
    default:
      // A reference (OB-2004) is never closed on purpose: a project that holds one is not removable
      // without --force, so a document is not deleted by removing its project.
      return ["done"];
  }
}

/** True when `status` is a closed status for an item of `type`. */
export function isClosedStatus(type: string, status: string): boolean {
  return closedStatuses(type).includes(status);
}

/** Default status a newly-created item of this type starts in. */
export function defaultStatus(type: string): string {
  switch (type) {
    case "roadmap":
      return "active";
    case "decision":
      return "draft";
    case "learning":
      return "todo";
    case "reference":
      return "active";
    default:
      return "open";
  }
}

export function statusVocab(type: string, kind: Kind | null): string[] {
  if (type === "roadmap") return ROADMAP_STATUSES;
  if (type === "decision") return DECISION_STATUSES;
  if (type === "learning") return LEARNING_STATUSES;
  if (type === "reference") return REFERENCE_STATUSES;
  return type === "linear_ref" ? LINEAR_STATUSES : BASIC_STATUSES;
}

export function isValidStatus(status: string, type: string, kind: Kind | null): boolean {
  return statusVocab(type, kind).includes(status);
}

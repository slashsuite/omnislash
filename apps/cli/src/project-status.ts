// OS-134: a project's lifecycle status, `active` (the default), `paused` or `archived`. Modelled on stage.ts
// (OB-2103): stored on `project.status`, set with `ob project edit <p> --status <s>` or its aliases
// `ob project pause|resume|archive <p>`.
//
// What each status does:
// - `paused`: `ob spinoff`, `ob spinoff queue` and `ob spinoff drain` refuse the project's tickets (naming the
//   status) unless `--allow-paused '<why>'`, whose reason goes on the ticket's Decisions trail; `ob next`, the
//   team brief's next items and `ob role tick` leave the project out. `ob project list` shows it, marked.
// - `archived`: all of `paused`, and `ob project list` hides it unless `--all`.

const PROJECT_STATUSES = ["active", "paused", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** The status a project with none stored reads as (a row written before migration 0005 has `active`). */
const DEFAULT_PROJECT_STATUS: ProjectStatus = "active";

export class ProjectStatusError extends Error {}

/** `--status <s>` -> the status to store. Trimmed and case-folded; anything else throws naming the three. */
export function parseProjectStatus(value: string): ProjectStatus {
  const v = value.trim().toLowerCase();
  if ((PROJECT_STATUSES as readonly string[]).includes(v)) return v as ProjectStatus;
  throw new ProjectStatusError(`--status must be one of ${PROJECT_STATUSES.join(", ")}, not '${value}'`);
}

/** The status a stored value reads as: one of the three, else active (a hand-written row could hold anything). */
export function projectStatusOf(p: { status?: string | null } | null | undefined): ProjectStatus {
  const v = p?.status;
  return v && (PROJECT_STATUSES as readonly string[]).includes(v) ? (v as ProjectStatus) : DEFAULT_PROJECT_STATUS;
}

/** Is the project held off work (paused or archived)? Its tickets are not dispatched or offered. */
export function isProjectHeld(p: { status?: string | null } | null | undefined): boolean {
  return projectStatusOf(p) !== "active";
}

/** The `ob project pause|resume|archive` aliases and the status each sets. */
export const PROJECT_STATUS_ALIASES: Record<string, ProjectStatus> = {
  pause: "paused",
  resume: "active",
  archive: "archived",
};

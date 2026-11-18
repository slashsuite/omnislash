// Work-classification tags (ticket 134, phase 1 — tags only, no metrics).
//
// A FLAT, documented vocabulary for classifying the nature of a task. Deliberately
// flat (no `basis:`/`layer:`/`work:` namespacing): a flat classification tag is
// indistinguishable from a legitimate free-form tag, so these are a CONVENTION, not
// a validated set — `ob tag` never rejects an unknown tag. The list is exported so
// help/docs can render it, and (phase 2) so metrics can roll up by class.
//
// The repo dimension is orthogonal: it is carried by the item's project (`--repo`
// is an alias for `--project`), not by a tag. Slice with `ob list --tag <t> --repo <r>`.

export const WORK_TAGS = [
  "frontend",
  "backend",
  "new-work",
  "rework",
  "maintenance",
  "security-fix",
  "bug-fix",
  "based-off-design",
  "based-off-acs",
] as const;

export type WorkTag = (typeof WORK_TAGS)[number];

/** One-line purpose per tag, for help text and docs. */
export const WORK_TAG_PURPOSES: Readonly<Record<WorkTag, string>> = {
  frontend: "work on the client / UI layer",
  backend: "work on the server / API / data layer",
  "new-work": "net-new feature or capability",
  rework: "redoing or revising work already delivered (churn)",
  maintenance: "upkeep — deps, refactors, chores; no new behaviour",
  "security-fix": "remediating a security vulnerability (e.g. a CVE)",
  "bug-fix": "fixing a defect in existing behaviour",
  "based-off-design": "implemented from a design mockup (Figma)",
  "based-off-acs": "implemented from written acceptance criteria",
} as const;

/** Is `name` a canonical work-classification tag? (Advisory only — unknown tags are still accepted.) */
export function isWorkTag(name: string): name is WorkTag {
  return (WORK_TAGS as readonly string[]).includes(name.trim().toLowerCase());
}

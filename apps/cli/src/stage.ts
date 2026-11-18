// OB-2103: a project's release stage, the one place architects and builders read what kind of break a
// change may make. The rule each stage sets is `skills/ob-architect/SKILL.md` ("Every project has a stage");
// the one-line rules below are what `ob project rules` and every spinoff launch prompt carry.

export const PROJECT_STAGES = ["alpha", "beta", "rc", "stable", "legacy"] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

/** The stage a project with none set is treated as. */
export const DEFAULT_STAGE: ProjectStage = "beta";

export const STAGE_RULES: Record<ProjectStage, string> = {
  alpha: "anything may break, no compatibility work owed",
  beta: "breaks allowed, each flagged with ! and a Breaking: line",
  rc: "very cautious: a break needs an impact note and the owner's yes before dispatch",
  stable: "no break on the current version; a break waits for the next major",
  legacy: "not maintained: take no work unless the owner says",
};

export class StageError extends Error {}

/**
 * `--stage <s>` -> the stage to store, or "" for `none` (clear). Trimmed and case-folded; anything else
 * throws naming the five values. Shared by the CLI and the API handler. The empty string also clears: it
 * is what the CLI's parsed patch carries over the wire for `none`.
 */
export function parseStage(value: string): ProjectStage | "" {
  const v = value.trim().toLowerCase();
  if (v === "none" || v === "") return "";
  if ((PROJECT_STAGES as readonly string[]).includes(v)) return v as ProjectStage;
  throw new StageError(`--stage must be one of ${PROJECT_STAGES.join(", ")} (or none to clear), not '${value}'`);
}

/** The stage of the project named `idOrName` in a project list (id or name, as `getProject` matches), or null. */
export function stageIn(projects: Array<{ id: string; name: string; stage?: string | null }>, idOrName: string): string | null {
  return projects.find((p) => p.id === idOrName || p.name === idOrName)?.stage ?? null;
}

/** Whether a stored value is one of the five (a row written by hand could hold anything). */
function isStage(v: string | null | undefined): v is ProjectStage {
  return !!v && (PROJECT_STAGES as readonly string[]).includes(v);
}

/** The one line `ob project rules` and the launch prompt open with: `Stage: alpha (<rule>)`, or the beta default. */
export function stageLine(stage: string | null | undefined): string {
  if (isStage(stage)) return `Stage: ${stage} (${STAGE_RULES[stage]})`;
  return `Stage: not set, treat as ${DEFAULT_STAGE} (${STAGE_RULES[DEFAULT_STAGE]})`;
}

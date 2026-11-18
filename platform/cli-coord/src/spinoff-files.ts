// OB-2131: the go check's planned files against the branch's changed files, the `files:` line of
// `ob spinoff gateable` and `ob spinoff show`. The OB-2132 audit found a 12.5% planning-miss rate when under
// half the planned files were touched, against 4.0% when all were, so the line says to read why. Pure.

export interface FilesComparison {
  planned: string[];
  touched: string[];
  unplanned: string[];
  /** Set when there is nothing to compare, and printed in place of the counts. */
  note: string | null;
}

const NO_GO_CHECK = "no go check";
const NO_PLANNED_FILES = "no planned files on the go check";
const NO_DIFF = "no diff to compare";
const NOT_READ = "planned files not read (the API server has no planned-files route)";

/**
 * `planned` is the go check's files (`null`: no go check; `"unread"`: not read). `changed` is the branch diff,
 * `missing` a worktree that is gone.
 */
export function compareFiles(planned: string[] | null | "unread", changed: string[], missing: boolean): FilesComparison {
  const empty = (note: string): FilesComparison => ({ planned: Array.isArray(planned) ? planned : [], touched: [], unplanned: [], note });
  if (planned === "unread") return empty(NOT_READ);
  if (planned === null) return empty(NO_GO_CHECK);
  if (planned.length === 0) return empty(NO_PLANNED_FILES);
  if (missing || changed.length === 0) return empty(NO_DIFF);
  const changedSet = new Set(changed);
  const plannedSet = new Set(planned);
  return {
    planned,
    touched: planned.filter((p) => changedSet.has(p)),
    unplanned: changed.filter((c) => !plannedSet.has(c)),
    note: null,
  };
}

/** The `files:` line, without indent. */
export function filesLine(f: FilesComparison): string {
  if (f.note) return `files: ${f.note}`;
  const t = f.touched.length;
  const n = f.planned.length;
  const why = t < n / 2 ? " (read why: under half the planned files touched)" : "";
  return `files: ${t} of ${n} planned touched, ${f.unplanned.length} unplanned${why}`;
}

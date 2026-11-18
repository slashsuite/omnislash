import type { Mode } from "../../../apps/cli/src/output.ts";
import { stateDisplayLines } from "./spinoff-state-reason.ts";
import { isLandableToken } from "./spinoff-vocab.ts";
import { compareFiles, filesLine, type FilesComparison } from "./spinoff-files.ts";

export const REBUILD_CLI_DB =
  "gate includes moon run cli-db:test twice, the second with --force. On-PATH ob is a source wrapper — no binary rebuild.";
export const REBUILD_CLI = "moon run cli:typecheck cli:test cli-core:test. No binary rebuild.";
export const REBUILD_DASHBOARD = "after land: deploy + restart omnislash-web.";
export const REBUILD_OPS = "after land: server deploy.";
export const REBUILD_NONE = "none";
export const REBUILD_CLOSE_ONLY = "close only";
export const REBUILD_MISSING = "worktree missing";

const KNOWN_APPS = new Set(["cli", "dashboard", "ob-dashboard"]);

export interface GateableSource {
  id: number;
  ticket_ref: string;
  branch: string;
  worktree: string;
  repo: string;
  /** 1480: the tier it was rated and the model it ran on — a stalled cheap build reads as such here. */
  tier?: string | null;
  model?: string | null;
  /** OB-2172: why the last readying note did not reach the architect (`<iso time> <reason>`), or null. */
  note_error?: string | null;
}

export interface GateableFacts {
  missing: boolean;
  state: string | null;
  paths: string[];
}

export interface GateableRow {
  ticket: string;
  id: number;
  branch: string;
  worktree: string;
  repo: string;
  tier: string | null;
  model: string | null;
  state: string | null;
  landable: boolean;
  paths: string[];
  rebuild: string[];
  /** OB-2172: the row's `note_error`: the architect was never told this row is ready. */
  note_error?: string | null;
  /** OB-2131: the go check's planned files against `paths`. Absent on a trial pair. */
  files?: FilesComparison;
  /** OB-1991: both row ids of a model-trial pair, the entry standing for the pair. Absent for an ordinary row. */
  ids?: number[];
  /** OB-1991: the trial pair, legs by blind label only (no model, no leg a/b). */
  /** `building`: the labels of legs not handed off yet; the pair is judged only once it is empty. */
  pair?: { id: number; legs: GateablePairLeg[]; building: string[] };
}

/** OB-1991: one leg of a gateable trial pair, as the blind reviewer may see it. */
export interface GateablePairLeg {
  label: string;
  id: number;
  branch: string;
  worktree: string;
  state: string | null;
  landable: boolean;
  /** OB-2172: this leg's readying note never reached the architect. */
  note_error?: string | null;
}

/** OB-1991: an open trial pair as `gateable` needs it: its rows and which label leg a carries. */
export interface GateablePair {
  id: number;
  row_a: number | null;
  row_b: number | null;
  label_a: string;
}

function stateToken(state: string | null): string | null {
  if (!state) return null;
  // The token is the verdict word; trailing punctuation (`State: landable: gate green`) is not part of it (1618).
  return state.match(/^State:\s+([\w-]+)/)?.[1] ?? null;
}

/**
 * The one landable predicate (OB-1924). `landable` (or the pre-1513 `ready`) always; `needs-human` only once the
 * row is handed off (471, amends 442: the handoff is the human yes); blocked, partial and a missing State never.
 * `handedOff` is whether the row being judged is `ready-for-gate`.
 */
export function isLandable(state: string | null, opts: { handedOff: boolean }): boolean {
  const token = stateToken(state);
  return isLandableToken(token) || (opts.handedOff && token === "needs-human");
}

function hasPrefix(path: string, prefix: string): boolean {
  const p = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === p || path.startsWith(`${p}/`);
}

function unknownApp(path: string): string | null {
  const name = path.match(/^apps\/([^/]+)/)?.[1];
  if (!name || KNOWN_APPS.has(name)) return null;
  return `apps/${name}`;
}

export function rebuildAdvice(paths: string[], facts: { missing: boolean; state?: string | null }): string[] {
  if (facts.missing) return [REBUILD_MISSING];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    if (seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const path of paths) {
    if (hasPrefix(path, "apps/cli/src/db/") || hasPrefix(path, "platform/cli-db/")) add(REBUILD_CLI_DB);
    else if (hasPrefix(path, "apps/cli/") || hasPrefix(path, "platform/cli-core/")) add(REBUILD_CLI);
    if (hasPrefix(path, "apps/dashboard/")) add(REBUILD_DASHBOARD);
    if (hasPrefix(path, "ops/")) add(REBUILD_OPS);
    const unknown = unknownApp(path);
    if (unknown) add(unknown);
  }
  if (out.length > 0) return out;
  const nothingToMerge = paths.length === 0 || /nothing to merge/i.test(facts.state ?? "");
  return [nothingToMerge ? REBUILD_CLOSE_ONLY : REBUILD_NONE];
}

/**
 * OB-2131: the planned files of a row's ticket, read before rendering because the store is async and this is
 * not. `null` is no go check; `"unread"` is an API server without the route. No `plannedFor` at all leaves the
 * line off, for a caller that has no store to ask.
 */
export type PlannedFiles = string[] | null | "unread";
type PlannedFor = (row: GateableSource) => PlannedFiles;

/** OB-2172: the line `gateable` and `show` print for a row whose last readying note failed, or null. Pure. */
export function noteErrorLine(noteError: string | null | undefined, indent = "  "): string | null {
  const text = noteError?.trim();
  if (!text) return null;
  const space = text.indexOf(" ");
  const at = space > 0 ? text.slice(0, space) : text;
  const reason = space > 0 ? text.slice(space + 1) : "no reason recorded";
  return `${indent}readying note: NOT delivered at ${at}: ${reason}`;
}

export function assessGateable(row: GateableSource, facts: GateableFacts, planned?: PlannedFiles): GateableRow {
  const state = facts.missing ? null : facts.state;
  return {
    ticket: row.ticket_ref,
    id: row.id,
    branch: row.branch,
    worktree: row.worktree,
    repo: row.repo,
    tier: row.tier ?? null,
    model: row.model ?? null,
    state,
    landable: !facts.missing && isLandable(state, { handedOff: true }),
    paths: facts.missing ? [] : facts.paths,
    rebuild: rebuildAdvice(facts.paths, { missing: facts.missing, state }),
    note_error: row.note_error ?? null,
    ...(planned === undefined ? {} : { files: compareFiles(planned, facts.missing ? [] : facts.paths, facts.missing) }),
  };
}

export function reportGateable(
  rows: GateableSource[],
  factsFor: (row: GateableSource) => GateableFacts,
  mode: Mode,
  pairs: GateablePair[] = [],
  plannedFor?: PlannedFor,
): string {
  return renderGateableList(
    groupTrialPairs(
      rows.map((row) => assessGateable(row, factsFor(row), plannedFor?.(row))),
      pairs,
    ),
    mode,
  );
}

/**
 * OB-1991: the rows of one open trial pair become ONE entry, carrying both row ids and a `pair` field. The entry
 * names no model and no leg (a/b): the legs are listed by their blind label, X first, so the architect gates the pair
 * without learning which model built which.
 */
export function groupTrialPairs(rows: GateableRow[], pairs: GateablePair[]): GateableRow[] {
  const out: GateableRow[] = [];
  const done = new Set<number>();
  for (const row of rows) {
    if (done.has(row.id)) continue;
    const pair = pairs.find((p) => p.row_a === row.id || p.row_b === row.id);
    if (!pair) {
      out.push(row);
      continue;
    }
    const labelB = pair.label_a === "Y" ? "X" : "Y";
    const legs: GateablePairLeg[] = [];
    const building: string[] = [];
    for (const [rowId, label] of [
      [pair.row_a, pair.label_a],
      [pair.row_b, labelB],
    ] as const) {
      const leg = rows.find((r) => r.id === rowId);
      if (!leg) {
        building.push(label);
        continue;
      }
      done.add(leg.id);
      legs.push({ label, id: leg.id, branch: leg.branch, worktree: leg.worktree, state: leg.state, landable: leg.landable, note_error: leg.note_error ?? null });
    }
    legs.sort((x, y) => x.label.localeCompare(y.label));
    const ids = legs.map((l) => l.id).sort((x, y) => x - y);
    const rebuild = [...new Set(rows.filter((r) => ids.includes(r.id)).flatMap((r) => r.rebuild))];
    out.push({
      ticket: row.ticket,
      id: ids[0]!,
      branch: legs.map((l) => l.branch).join(" "),
      worktree: legs.map((l) => l.worktree).join(" "),
      repo: row.repo,
      tier: row.tier,
      model: null,
      state: null,
      // a pair is judged on both diffs, so half a pair is not landable yet
      landable: building.length === 0 && legs.some((l) => l.landable),
      paths: [],
      rebuild,
      ids,
      pair: { id: pair.id, legs, building: building.sort() },
    });
  }
  return out;
}

export function renderGateableList(rows: GateableRow[], mode: Mode): string {
  if (mode === "json") return JSON.stringify(rows, null, 2);
  if (mode === "quiet") return rows.map((r) => r.ticket).join("\n");
  if (rows.length === 0) return "no gateable spinoffs";
  return rows.map(formatGateableRow).join("\n");
}

function formatGateableRow(r: GateableRow): string {
  if (r.pair) {
    return [
      `${r.ticket}  trial pair #${r.pair.id}  rows ${(r.ids ?? []).map((id) => `#${id}`).join(" ")}  ${r.repo}`,
      ...r.pair.legs.flatMap((l) => [
        `  ${l.label}: #${l.id}  ${l.branch}  ${l.worktree}  landable: ${l.landable ? "yes" : "no"}`,
        ...stateDisplayLines(l.state, "    ", "State: (none)"),
        ...(noteErrorLine(l.note_error, "    ") ? [noteErrorLine(l.note_error, "    ")!] : []),
      ]),
      r.pair.building.length > 0
        ? `  ${r.pair.building.join(" and ")} still building: review once both legs hand off (over 24 hours late: trial record --forfeit)`
        : `  review blind: ob spinoff trial pair ${r.ticket} --diffs <dir>; land the winner only`,
      `  rebuild: ${r.rebuild.join("; ")}`,
    ].join("\n");
  }
  return [
    `${r.ticket}  #${r.id}  ${r.branch}  ${r.worktree}  ${r.repo}`,
    ...stateDisplayLines(r.state, "  ", "State: (none)"),
    `  tier: ${r.tier ?? "-"} · model: ${r.model ?? "-"}`,
    `  landable: ${r.landable ? "yes" : "no"}`,
    ...(noteErrorLine(r.note_error) ? [noteErrorLine(r.note_error)!] : []),
    ...(r.files ? [`  ${filesLine(r.files)}`] : []),
    `  rebuild: ${r.rebuild.join("; ")}`,
  ].join("\n");
}

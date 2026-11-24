// OS-48: conflict detection, part 2. While builders run in one repo, their pushed branches are test-merged against each
// other with `git merge-tree`, and only a real merge conflict counts: two branches touching one file at different
// lines merge cleanly and are not reported. It reuses OS-47's row shape, `Sh`, timeouts and lockfile skip. This part
// only detects and reports; who pauses is OS-49.
//
// The check runs in this machine's checkout of each repo (the API host has none): `ob spinoff conflicts` on demand,
// and `role tick` (every 15 minutes), which posts each conflicting pair once per pair of heads to the team's sentinel.
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Sh, ShResult } from "./commands/spinoff.ts";
import { FETCH_TIMEOUT_MS, GIT_TIMEOUT_MS, isLockfile, type OverlapRow } from "./spinoff-overlap.ts";
import { IN_FLIGHT } from "./spinoff-vocab.ts";

/** One running row's side of a conflict: its fetched `origin/<branch>` head. */
export interface ConflictSide {
  row: number;
  ref: string;
  item_id: string | null;
  branch: string;
  head: string;
}

/**
 * Two running branches that do not merge. `a` is the lower row id. `files` never holds a resolved-at-land file (a
 * lockfile or the root FACTS.md), and is empty when git reports a conflict that names no file (a directory rename, say).
 */
export interface BranchConflict {
  repo: string;
  a: ConflictSide;
  b: ConflictSide;
  files: string[];
}

export interface ConflictCheck {
  conflicts: BranchConflict[];
  /** Git failures (a fetch that is not a missing branch, a merge-tree above exit 1): reported, never fatal. */
  warnings: string[];
  /** Running rows left out because their branch is not on origin yet. */
  unpushed: Array<{ row: number; ref: string; branch: string }>;
}

export interface ConflictDeps {
  /** A row's `repo` as a checkout path on this machine, so a slug and a path for one repo compare equal. */
  repoPath(repo: string): Promise<string> | string;
  sh: Sh;
}

/** What `role tick` reads the check from: the team's rows, and where a ticket's note goes. */
export interface ConflictSource extends ConflictDeps {
  /** The team's spinoff rows (any status; the check keeps the running ones). */
  rows(team: string): Promise<OverlapRow[]>;
  /** Append `text` as a note on one side's ticket. */
  note(side: ConflictSide, text: string): Promise<void>;
}

/**
 * Files two running branches may both touch without it being a conflict to report. Lockfiles reinstall. The root
 * FACTS.md is the one shared line every PR bumps (AGENTS.md: "Checked against"), so two running PRs always collide
 * there; the trade-off is that a real clash in another FACTS.md line is not reported here either. A pair whose
 * conflicted files are all in this list is clean; any other file still reports.
 */
const RESOLVED_AT_LAND_PATHS = new Set(["FACTS.md"]);
export const isResolvedAtLand = (path: string): boolean => isLockfile(path) || RESOLVED_AT_LAND_PATHS.has(path);

const short = (sha: string): string => sha.slice(0, 7);
const fileList = (c: BranchConflict): string => (c.files.length ? c.files.join(", ") : "no file named by git");
const why = (r: ShResult): string => (r.err || r.out || (r.signal ? `killed by ${r.signal}` : `exit ${r.code ?? "?"}`)).trim().split("\n")[0] ?? "";
const missingRef = (r: ShResult): boolean => /couldn't find remote ref|no such ref/i.test(`${r.err}\n${r.out ?? ""}`);
const refspec = (branch: string): string => `+refs/heads/${branch}:refs/remotes/origin/${branch}`;

/**
 * The conflicted paths of a `git merge-tree --write-tree --name-only` that exited 1: the lines after the tree id up
 * to the first blank line, deduplicated and sorted. Lockfiles are kept; the caller drops them. Pure.
 */
export function conflictedPaths(out: string): string[] {
  const rows = out.split("\n").slice(1);
  const end = rows.findIndex((l) => l.trim() === "");
  const names = (end === -1 ? rows : rows.slice(0, end)).map((l) => l.trim()).filter((l) => l !== "");
  return [...new Set(names)].sort();
}

/** Two rows are one build when they serve one ticket (a trial's legs) or share a branch: never compared. */
function sameBuild(x: OverlapRow, y: OverlapRow): boolean {
  return x.branch === y.branch || x.ticket_ref === y.ticket_ref || (x.item_id != null && x.item_id === y.item_id);
}

/**
 * Fetch every branch in one `git fetch`. When that fails because a branch is not on origin, fetch each alone so one
 * unpushed branch does not hide the rest. Any other failure (no remote, auth, a timeout) is one warning and fetches
 * nothing more. Returns the branches now on origin and those origin does not have.
 */
function fetchBranches(sh: Sh, repo: string, branches: string[], warnings: string[]): { got: Set<string>; missing: Set<string> } {
  const fetch = (bs: string[]): ShResult => sh(["git", "-C", repo, "fetch", "--quiet", "--no-tags", "origin", ...bs.map(refspec)], undefined, FETCH_TIMEOUT_MS);
  const got = new Set<string>();
  const missing = new Set<string>();
  const all = fetch(branches);
  if (all.ok) return { got: new Set(branches), missing };
  if (!missingRef(all)) {
    warnings.push(`conflicts: git fetch in ${repo} failed: ${why(all)}`);
    return { got, missing };
  }
  for (const b of branches) {
    const one = fetch([b]);
    if (one.ok) got.add(b);
    else if (missingRef(one)) missing.add(b);
    else warnings.push(`conflicts: git fetch ${b} in ${repo} failed: ${why(one)}`);
  }
  return { got, missing };
}

/**
 * Test-merge every pair of running rows (pending, launching, launched, ready-for-gate, with a branch) in each repo
 * that has two or more. Per repo: one fetch of their branches, then `git merge-tree --write-tree --name-only` on each
 * pair's fetched heads. Exit 0 is clean, 1 a conflict, anything else a warning that skips the pair. A pair whose
 * only conflicted files are resolved at land (lockfiles, FACTS.md) is clean; one with a real file too reports only
 * the real files. A repo with no checkout on this machine is skipped. `onlyRepo` (a checkout path) limits the check to
 * that repo.
 */
export async function findBranchConflicts(rows: OverlapRow[], deps: ConflictDeps, onlyRepo?: string): Promise<ConflictCheck> {
  const out: ConflictCheck = { conflicts: [], warnings: [], unpushed: [] };
  const byRepo = new Map<string, OverlapRow[]>();
  for (const row of [...rows].sort((x, y) => x.id - y.id)) {
    if (!IN_FLIGHT.has(row.status) || !row.branch) continue;
    const path = await deps.repoPath(row.repo);
    if (onlyRepo !== undefined && path !== onlyRepo) continue;
    // A team's other repos may be checked out on another machine: nothing to merge in here, and nothing to warn.
    if (!isAbsolute(path) || !existsSync(path)) continue;
    byRepo.set(path, [...(byRepo.get(path) ?? []), row]);
  }
  for (const [repo, live] of byRepo) {
    if (live.length < 2) continue;
    const { got, missing } = fetchBranches(deps.sh, repo, [...new Set(live.map((r) => r.branch))], out.warnings);
    const sides: Array<{ row: OverlapRow; head: string }> = [];
    for (const row of live) {
      if (missing.has(row.branch)) out.unpushed.push({ row: row.id, ref: row.ticket_ref, branch: row.branch });
      if (!got.has(row.branch)) continue;
      const head = deps.sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${row.branch}^{commit}`], undefined, GIT_TIMEOUT_MS);
      const sha = head.ok ? (head.out ?? "").trim() : "";
      if (sha) sides.push({ row, head: sha });
      else out.warnings.push(`conflicts: git rev-parse origin/${row.branch} in ${repo} failed: ${why(head)}`);
    }
    for (let i = 0; i < sides.length; i++) {
      for (let j = i + 1; j < sides.length; j++) {
        const [x, y] = [sides[i]!, sides[j]!];
        if (sameBuild(x.row, y.row)) continue;
        const r = deps.sh(["git", "-C", repo, "merge-tree", "--write-tree", "--name-only", x.head, y.head], undefined, GIT_TIMEOUT_MS);
        if (r.code === 0) continue;
        if (r.code !== 1) {
          out.warnings.push(`conflicts: git merge-tree ${x.row.ticket_ref} ${y.row.ticket_ref} in ${repo} failed: ${why(r)}`);
          continue;
        }
        const paths = conflictedPaths(r.out ?? "");
        const files = paths.filter((p) => !isResolvedAtLand(p));
        if (paths.length > 0 && files.length === 0) continue;
        const side = (s: { row: OverlapRow; head: string }): ConflictSide => ({ row: s.row.id, ref: s.row.ticket_ref, item_id: s.row.item_id ?? null, branch: s.row.branch, head: s.head });
        out.conflicts.push({ repo, a: side(x), b: side(y), files });
      }
    }
  }
  return out;
}

/** The pair's dedupe key: one inbox message per pair of heads. Pure. */
export function conflictKey(c: Pick<BranchConflict, "a" | "b">): string {
  return `conflict:${c.a.row}:${c.a.head}:${c.b.row}:${c.b.head}`;
}

/** `conflict: OS-1 (abc1234) and OS-2 (def5678): a.ts, b.ts`. Pure. */
export function renderConflict(c: BranchConflict): string {
  return `conflict: ${c.a.ref} (${short(c.a.head)}) and ${c.b.ref} (${short(c.b.head)}): ${fileList(c)}`;
}

/** The note on one side's ticket: `conflict: <other ticket> at <shaA>/<shaB>: <files>`. Pure. */
export function conflictNote(c: BranchConflict, side: "a" | "b"): string {
  const other = side === "a" ? c.b : c.a;
  return `conflict: ${other.ref} at ${short(c.a.head)}/${short(c.b.head)}: ${fileList(c)}`;
}

/** The sentinel's message for one pair. Pure. */
export function conflictMessage(c: BranchConflict): string {
  return `${renderConflict(c)}. The running branches ${c.a.branch} (row ${c.a.row}) and ${c.b.branch} (row ${c.b.row}) in ${c.repo} do not merge; one of them has to give way.`;
}

/** `ob spinoff conflicts`: one line per pair, or `conflicts: none`; `--json` gives the check as it is. */
export function renderConflictCheck(check: ConflictCheck, json: boolean): string {
  if (json) {
    return JSON.stringify({ conflicts: check.conflicts.map((c) => ({ ...c, key: conflictKey(c), line: renderConflict(c) })), unpushed: check.unpushed, warnings: check.warnings });
  }
  return check.conflicts.length === 0 ? "conflicts: none" : check.conflicts.map(renderConflict).join("\n");
}

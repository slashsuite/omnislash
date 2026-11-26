// OS-48: conflict detection, part 2. While builders run in one repo, their pushed branches are test-merged against each
// other with `git merge-tree`, and only a real merge conflict counts: two branches touching one file at different
// lines merge cleanly and are not reported. It reuses OS-47's row shape, `Sh`, timeouts and lockfile skip.
//
// The check runs in this machine's checkout of each repo (the API host has none): `ob spinoff conflicts` on demand,
// and `role tick` (every 15 minutes), which posts each conflicting pair once to the team's sentinel.
//
// OS-259 (part 3, OS-49): a branch already on origin/main (merged, or squash-landed) is no longer running and is left
// out. For each pair the higher priority ticket wins, and at equal priority the lower row (queued first); the tick
// stops the loser's thread and tells it to wait, then tells it to rebase and go on once every winner it yields to
// has landed or stopped. The pause is recorded as the sentinel message's key, so it needs no table.
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Sh, ShResult } from "./commands/spinoff.ts";
import { FETCH_TIMEOUT_MS, GIT_TIMEOUT_MS, isLockfile, type OverlapRow } from "./spinoff-overlap.ts";
import { priorityName, prioritySortRank } from "../../../apps/cli/src/priority.ts";
import { IN_FLIGHT } from "./spinoff-vocab.ts";

/** One running row's side of a conflict: its fetched `origin/<branch>` head. */
export interface ConflictSide {
  row: number;
  ref: string;
  item_id: string | null;
  branch: string;
  head: string;
  /** OS-259: the builder's T3 thread, which a pause or resume is sent to; null when the row has none. */
  thread: string | null;
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
  /** OS-259: running rows left out because their branch head is already on origin/main. */
  landed: Array<{ row: number; ref: string; branch: string }>;
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
  /** OS-259: the stored priority of one side's ticket, null when it has none. */
  priority(side: ConflictSide): Promise<number | null>;
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

/** OS-259: the T3 thread ob can tell a row's builder through, or null (another launcher, or no thread yet). Pure. */
export function rowThread(row: Pick<OverlapRow, "launcher" | "t3_thread_id">): string | null {
  return row.launcher === "t3" && row.t3_thread_id ? row.t3_thread_id : null;
}

/**
 * OS-259: fetch origin/main and return its tree id, or null (with a warning) when it cannot be read; then no branch is
 * read as landed.
 */
function fetchMainTree(sh: Sh, repo: string, warnings: string[]): string | null {
  const f = sh(["git", "-C", repo, "fetch", "--quiet", "--no-tags", "origin", refspec("main")], undefined, FETCH_TIMEOUT_MS);
  if (!f.ok) {
    // A repo with no main on origin has nothing landed: no warning, as for a branch that is not pushed.
    if (!missingRef(f)) warnings.push(`conflicts: git fetch main in ${repo} failed: ${why(f)}`);
    return null;
  }
  const t = sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main^{tree}"], undefined, GIT_TIMEOUT_MS);
  const tree = t.ok ? (t.out ?? "").trim() : "";
  if (!tree) warnings.push(`conflicts: git rev-parse origin/main in ${repo} failed: ${why(t)}`);
  return tree || null;
}

/**
 * OS-259: is a branch head already on origin/main: an ancestor of it (a merge or fast-forward), or a head whose
 * changes main already holds (a squash merge: merging it into main changes nothing).
 */
function landedOnMain(sh: Sh, repo: string, head: string, mainTree: string): boolean {
  if (sh(["git", "-C", repo, "merge-base", "--is-ancestor", head, "refs/remotes/origin/main"], undefined, GIT_TIMEOUT_MS).code === 0) return true;
  const m = sh(["git", "-C", repo, "merge-tree", "--write-tree", "refs/remotes/origin/main", head], undefined, GIT_TIMEOUT_MS);
  return m.code === 0 && (m.out ?? "").split("\n")[0]?.trim() === mainTree;
}

/**
 * Test-merge every pair of running rows (pending, launching, launched, ready-for-gate, with a branch) in each repo
 * that has two or more. Per repo: one fetch of their branches, then `git merge-tree --write-tree --name-only` on each
 * pair's fetched heads. Exit 0 is clean, 1 a conflict, anything else a warning that skips the pair. A head
 * already on origin/main is left out as landed. A pair whose
 * only conflicted files are resolved at land (lockfiles, FACTS.md) is clean; one with a real file too reports only
 * the real files. A repo with no checkout on this machine is skipped. `onlyRepo` (a checkout path) limits the check to
 * that repo.
 */
export async function findBranchConflicts(rows: OverlapRow[], deps: ConflictDeps, onlyRepo?: string): Promise<ConflictCheck> {
  const out: ConflictCheck = { conflicts: [], warnings: [], unpushed: [], landed: [] };
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
    const mainTree = fetchMainTree(deps.sh, repo, out.warnings);
    const sides: Array<{ row: OverlapRow; head: string }> = [];
    for (const row of live) {
      if (missing.has(row.branch)) out.unpushed.push({ row: row.id, ref: row.ticket_ref, branch: row.branch });
      if (!got.has(row.branch)) continue;
      const head = deps.sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${row.branch}^{commit}`], undefined, GIT_TIMEOUT_MS);
      const sha = head.ok ? (head.out ?? "").trim() : "";
      if (sha && mainTree !== null && landedOnMain(deps.sh, repo, sha, mainTree)) out.landed.push({ row: row.id, ref: row.ticket_ref, branch: row.branch });
      else if (sha) sides.push({ row, head: sha });
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
        const side = (s: { row: OverlapRow; head: string }): ConflictSide => ({
          row: s.row.id,
          ref: s.row.ticket_ref,
          item_id: s.row.item_id ?? null,
          branch: s.row.branch,
          head: s.head,
          thread: rowThread(s.row),
        });
        out.conflicts.push({ repo, a: side(x), b: side(y), files });
      }
    }
  }
  return out;
}

/** OS-259: the pair's key, `conflict:<row a>:<row b>`: one report per pair, whatever its heads become. Pure. */
export function conflictPairKey(c: Pick<BranchConflict, "a" | "b">): string {
  return `conflict:${c.a.row}:${c.b.row}`;
}

/**
 * The sentinel message's dedupe key, `conflict:<row a>:<row b>:loser:<row>`. It is also the record of the pause: the
 * resume pass reads who yields to whom from it. A pair whose key is already in the inbox (any loser) is not reported
 * again. Pure.
 */
export function conflictKey(c: Pick<BranchConflict, "a" | "b">, loser: number): string {
  return `${conflictPairKey(c)}:loser:${loser}`;
}

/** The resume notice's key: `resume:<loser row>:<winner rows, sorted, comma separated>`. Pure. */
export function resumeKey(loser: number, winners: number[]): string {
  return `resume:${loser}:${[...winners].sort((x, y) => x - y).join(",")}`;
}

/** One side's priority as a rank, best first: no priority ranks with `none`. */
const rankOf = (p: number | null): number => prioritySortRank(p ?? 0);

/**
 * OS-259 (OS-49): who gives way. The better priority wins (critical, urgent, flake, high, medium, low, none); at equal
 * priority the lower row wins, as it was queued first. Pure.
 */
export function pickLoser(c: Pick<BranchConflict, "a" | "b">, pa: number | null, pb: number | null): { winner: ConflictSide; loser: ConflictSide } {
  const [ra, rb] = [rankOf(pa), rankOf(pb)];
  const aWins = ra !== rb ? ra < rb : c.a.row < c.b.row;
  return aWins ? { winner: c.a, loser: c.b } : { winner: c.b, loser: c.a };
}

/**
 * The pauses still open, by loser row: each loser's winners whose pause came after its last resume notice. Read from
 * the sentinel messages' keys; a higher message id was written later. Pure.
 */
export function openYields(messages: ReadonlyArray<{ id: number; client_key?: string | null }>): Map<number, number[]> {
  const yields: Array<{ id: number; loser: number; winner: number }> = [];
  const lastResume = new Map<number, number>();
  for (const m of messages) {
    const key = m.client_key ?? "";
    const y = /^conflict:(\d+):(\d+):loser:(\d+)$/.exec(key);
    if (y) {
      const [a, b, loser] = [Number(y[1]), Number(y[2]), Number(y[3])];
      if (loser === a || loser === b) yields.push({ id: m.id, loser, winner: loser === a ? b : a });
      continue;
    }
    const r = /^resume:(\d+):/.exec(key);
    if (r) lastResume.set(Number(r[1]), Math.max(lastResume.get(Number(r[1])) ?? 0, m.id));
  }
  const open = new Map<number, number[]>();
  for (const y of yields.sort((x, z) => x.id - z.id)) {
    if (y.id < (lastResume.get(y.loser) ?? 0)) continue;
    const ws = open.get(y.loser) ?? [];
    if (!ws.includes(y.winner)) ws.push(y.winner);
    open.set(y.loser, ws);
  }
  return open;
}

/** `conflict: OS-1 (abc1234) and OS-2 (def5678): a.ts, b.ts`. Pure. */
export function renderConflict(c: BranchConflict): string {
  return `conflict: ${c.a.ref} (${short(c.a.head)}) and ${c.b.ref} (${short(c.b.head)}): ${fileList(c)}`;
}

/** The note on one side's ticket: `conflict: <other ticket> at <shaA>/<shaB>: <files>; <loser> gives way`. Pure. */
export function conflictNote(c: BranchConflict, side: "a" | "b", loser: ConflictSide): string {
  const other = side === "a" ? c.b : c.a;
  return `conflict: ${other.ref} at ${short(c.a.head)}/${short(c.b.head)}: ${fileList(c)}; ${loser.ref} gives way`;
}

/** How the loser was paused: told on its thread, already paused for another pair, or not reachable (by hand). */
/** by-hand: the loser has no T3 thread; unreached: it has one, but the pause message could not be sent there. */
export type PauseOutcome = "paused" | "already" | "by-hand" | "unreached";

/** Who won and why, with each side's priority word. Pure. */
function verdict(winner: ConflictSide, loser: ConflictSide, pw: number | null, pl: number | null): string {
  const tie = rankOf(pw) === rankOf(pl) ? `, equal priority and row ${winner.row} queued first` : "";
  return `${winner.ref} (${priorityName(pw)}) wins over ${loser.ref} (${priorityName(pl)}${tie})`;
}

/** The sentinel's message for one pair: who wins, who pauses, and whether ob paused it. Pure. */
export function conflictMessage(c: BranchConflict, winner: ConflictSide, loser: ConflictSide, pw: number | null, pl: number | null, pause: PauseOutcome): string {
  const head = `${renderConflict(c)}. The running branches ${c.a.branch} (row ${c.a.row}) and ${c.b.branch} (row ${c.b.row}) in ${c.repo} do not merge. ${verdict(winner, loser, pw, pl)}`;
  const tail =
    pause === "paused"
      ? `${loser.ref} (row ${loser.row}) is paused and resumes by itself after ${winner.ref} lands.`
      : pause === "already"
        ? `${loser.ref} (row ${loser.row}) is already paused for another pair and now also waits for ${winner.ref}.`
        : `${loser.ref} (row ${loser.row}) ${pause === "unreached" ? "did not take ob's pause message" : "has no builder thread ob could tell"}: pause it by hand, and resume it after ${winner.ref} lands.`;
  return `${head}; ${tail}`;
}

/** What the loser's builder is told: stop, commit, mark itself blocked and wait. Pure. */
export function yieldMessage(c: BranchConflict, winner: ConflictSide, loser: ConflictSide, pw: number | null, pl: number | null): string {
  return [
    `ob role tick (OS-259): your branch ${loser.branch} does not merge with ${winner.ref}'s branch ${winner.branch} (${fileList(c)}). ${verdict(winner, loser, pw, pl)}, so you give way until it lands.`,
    `Stop now: commit what you have on your branch, run \`ob agent register --id <your builder id> --status blocked --note "yielding to ${winner.ref}"\` and wait.`,
    `Do not rebase, open a PR or hand off meanwhile. You will be told to rebase and go on once ${winner.ref} has landed.`,
  ].join("\n\n");
}

/** What a paused builder is told once every ticket it yielded to has landed or stopped. Pure. */
export function resumeMessage(loserRef: string, winnerRefs: string[]): string {
  return [
    `ob role tick (OS-259): ${winnerRefs.join(", ")} has landed or stopped, so ${loserRef} goes on.`,
    "Run `git fetch origin && git rebase origin/main`, resolve any conflict with the ob-resolving-merge-conflicts skill, re-run your checks, set your status back to working and carry on.",
    "If the rebase conflicts and you cannot resolve it with confidence, stamp needs-human and ask.",
  ].join("\n\n");
}

/** The sentinel's notice that a paused row was resumed (or has to be, by hand). Pure. */
export function resumeNotice(loserRef: string, loserRow: number, winnerRefs: string[], told: boolean): string {
  const who = winnerRefs.join(", ");
  return told
    ? `resume: ${loserRef} (row ${loserRow}) goes on; ${who} no longer running, and it was told to rebase onto origin/main.`
    : `resume: ${loserRef} (row ${loserRow}) can go on; ${who} no longer running, but ob could not tell its builder: resume it by hand.`;
}

/** `ob spinoff conflicts`: one line per pair, or `conflicts: none`; `--json` gives the check as it is. */
export function renderConflictCheck(check: ConflictCheck, json: boolean): string {
  if (json) {
    return JSON.stringify({ conflicts: check.conflicts.map((c) => ({ ...c, key: conflictPairKey(c), line: renderConflict(c) })), unpushed: check.unpushed, landed: check.landed, warnings: check.warnings });
  }
  return check.conflicts.length === 0 ? "conflicts: none" : check.conflicts.map(renderConflict).join("\n");
}

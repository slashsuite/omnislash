// OS-47: conflict detection, part 1. Before a parallel dispatch, the ticket's declared files (its newest `go`
// check's sheets, directories and globs kept) are compared with every live spinoff row in the same repo. A live
// row's files are its own declared files plus what its pushed branch already touched, read from this machine's
// checkout (the API host has none). An overlap is a warning, never a refusal, in this part: the dispatch prints one
// line per row, records one `overlap` decision on the ticket's trail, and launches anyway.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Database } from "bun:sqlite";
import { recordDecision } from "../../../apps/cli/src/decisions.ts";
import { print, warn } from "../../../apps/cli/src/output.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import type { Sh } from "./commands/spinoff.ts";
import { declaredFilesFor } from "./spinoff-check.ts";
import { ticketItemIdFor } from "./spinoff-item.ts";
import { IN_FLIGHT } from "./spinoff-vocab.ts";

/** Lockfiles rebase cleanly with a reinstall, so a shared one is no conflict. Matched by file name, at any depth. */
const LOCKFILES = new Set(["bun.lock", "package-lock.json", "pnpm-lock.yaml"]);
const MAIN = "origin/main";
const FETCH_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 15_000;

const OVERLAP_UNKNOWN_LINE = "overlap: unknown, no recorded check";

/** The fields of a spinoff row the check reads. */
export interface OverlapRow {
  id: number;
  ticket_ref: string;
  item_id?: string | null;
  repo: string;
  branch: string;
  worktree: string;
  status: string;
}

/** One live row that shares files with the ticket. `declaredOnly`: its branch and worktree could not be read. */
export interface OverlapHit {
  ref: string;
  row: number;
  paths: string[];
  declaredOnly: boolean;
}

/** `unknown`: the ticket has no recorded `go` check, so there is no declared list to compare. */
export type OverlapResult = { kind: "unknown" } | { kind: "checked"; rows: OverlapHit[] };

export interface OverlapDeps {
  /** A ticket's declared files (its newest `go` check), or null when it has none. */
  declared(ref: string, itemId: string | null): Promise<string[] | null>;
  /** Every spinoff row; the check keeps the live ones itself. */
  rows(): Promise<OverlapRow[]>;
  /** A row's `repo` as a checkout path on this machine, so a slug and a path for one repo compare equal. */
  repoPath(repo: string): Promise<string> | string;
  sh: Sh;
}

const isLockfile = (path: string): boolean => LOCKFILES.has(basename(path));
const isPattern = (entry: string): boolean => entry.endsWith("/") || /[*?[{]/.test(entry);

/** The prefix a directory entry covers (`dir/` and `dir/**` both cover `dir/`), or null. Pure. */
function dirPrefix(entry: string): string | null {
  if (entry.endsWith("/**")) return entry.slice(0, -2);
  if (entry.endsWith("/")) return entry;
  return null;
}

/** Does a declared entry cover a concrete path: exact, a directory over it, or a glob matching it. Pure. */
export function entryCovers(entry: string, path: string): boolean {
  if (entry === path) return true;
  const dir = dirPrefix(entry);
  if (dir !== null) return path.startsWith(dir);
  if (!isPattern(entry)) return false;
  return new Bun.Glob(entry).match(path);
}

/**
 * The paths two file lists share, lockfiles left out on both sides. Either list may hold directory and glob
 * entries. Two patterns overlap when they are the same entry or one directory holds the other (the narrower is
 * named); two globs that are not the same entry are not compared. Pure.
 */
export function sharedPaths(mine: string[], theirs: string[]): string[] {
  const a = mine.filter((p) => !isLockfile(p));
  const b = theirs.filter((p) => !isLockfile(p));
  const out = new Set<string>();
  for (const x of a) {
    for (const y of b) {
      if (x === y) out.add(x);
      else if (!isPattern(x) && entryCovers(y, x)) out.add(x);
      else if (!isPattern(y) && entryCovers(x, y)) out.add(y);
      else {
        const dx = dirPrefix(x);
        const dy = dirPrefix(y);
        if (dx !== null && y.startsWith(dx)) out.add(y);
        else if (dy !== null && x.startsWith(dy)) out.add(x);
      }
    }
  }
  return [...out].sort();
}

/** Lines of `git` output, blank ones dropped. */
function lines(out: string | undefined): string[] {
  return (out ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/**
 * The files a live row already touched, read on this machine: its pushed branch against origin/main, else its
 * worktree (committed and uncommitted, untracked included), else null (declared only). Run after a fetch.
 */
export function touchedFiles(sh: Sh, repoPath: string, row: Pick<OverlapRow, "branch" | "worktree">): string[] | null {
  const remote = `origin/${row.branch}`;
  if (sh(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/remotes/${remote}`], undefined, GIT_TIMEOUT_MS).ok) {
    const diff = sh(["git", "-C", repoPath, "diff", "--name-only", `${MAIN}...${remote}`], undefined, GIT_TIMEOUT_MS);
    if (diff.ok) return lines(diff.out);
  }
  if (!row.worktree || !existsSync(row.worktree)) return null;
  const base = sh(["git", "-C", row.worktree, "merge-base", MAIN, "HEAD"], undefined, GIT_TIMEOUT_MS);
  if (!base.ok) return null;
  const diff = sh(["git", "-C", row.worktree, "diff", "--name-only", lines(base.out)[0] ?? MAIN], undefined, GIT_TIMEOUT_MS);
  if (!diff.ok) return null;
  const untracked = sh(["git", "-C", row.worktree, "ls-files", "--others", "--exclude-standard"], undefined, GIT_TIMEOUT_MS);
  return [...new Set([...lines(diff.out), ...lines(untracked.ok ? untracked.out : "")])];
}

/**
 * The overlap of `ticket` with every live row in its repo (any status before landed or failed; the ticket's own
 * rows left out). The repo's checkout is fetched once first, so a pushed branch is read as it is on origin.
 */
export async function overlapFor(ticket: { ref: string; itemId?: string | null; repo: string }, deps: OverlapDeps): Promise<OverlapResult> {
  const itemId = ticket.itemId ?? null;
  const mine = await deps.declared(ticket.ref, itemId);
  if (mine === null) return { kind: "unknown" };
  const repoPath = await deps.repoPath(ticket.repo);
  const live: OverlapRow[] = [];
  for (const row of await deps.rows()) {
    // The ticket's own rows, a trial's `<ref>-b` leg among them, are left out by ref and by item.
    if (!IN_FLIGHT.has(row.status) || row.ticket_ref === ticket.ref || (itemId !== null && row.item_id === itemId)) continue;
    if ((await deps.repoPath(row.repo)) === repoPath) live.push(row);
  }
  if (live.length === 0 || mine.length === 0) return { kind: "checked", rows: [] };
  deps.sh(["git", "-C", repoPath, "fetch", "--quiet", "origin"], undefined, FETCH_TIMEOUT_MS); // a failed fetch reads the refs as last fetched
  const hits: OverlapHit[] = [];
  for (const row of live) {
    const declared = (await deps.declared(row.ticket_ref, row.item_id ?? null)) ?? [];
    const touched = touchedFiles(deps.sh, repoPath, row);
    const paths = sharedPaths(mine, [...declared, ...(touched ?? [])]);
    if (paths.length > 0) hits.push({ ref: row.ticket_ref, row: row.id, paths, declaredOnly: touched === null });
  }
  return { kind: "checked", rows: hits.sort((x, y) => x.row - y.row) };
}

/** One line per overlapping row; none when nothing is shared. Pure. */
export function renderOverlap(result: OverlapResult): string[] {
  if (result.kind === "unknown") return [OVERLAP_UNKNOWN_LINE];
  return result.rows.map((h) => `overlap: ${h.ref} (#${h.row}) ${h.paths.join(", ")}${h.declaredOnly ? " (declared only)" : ""}`);
}

/** The `overlap` decision's payload, `{ rows: [{ ref, row, paths }] }`, or null when there is nothing to record. Pure. */
function overlapDecisionRows(result: OverlapResult): Array<{ ref: string; row: number; paths: string[] }> | null {
  if (result.kind !== "checked" || result.rows.length === 0) return null;
  return result.rows.map(({ ref, row, paths }) => ({ ref, row, paths }));
}

/** The trail words of the `overlap` decision: `dispatch -> overlap`, payload `{ rows }`. */
const OVERLAP_FROM = "dispatch";
const OVERLAP_TO = "overlap";

export type OverlapDecisionRow = { ref: string; row: number; paths: string[] };

/** Where a dispatch's overlap is read and recorded: the store on a local or server-side run, the API on a client. */
export interface DispatchOverlapDeps extends Omit<OverlapDeps, "declared"> {
  declared?: OverlapDeps["declared"];
  /** Record the `overlap` decision on the ticket's trail; absent where this machine cannot write the trail. */
  record?: (rows: OverlapDecisionRow[], note: string) => Promise<void>;
}

/** Record one `overlap` decision on `ref`'s trail. A ref with no item has no trail: nothing is recorded. */
export async function recordOverlap(store: Database | Store, ref: string, rows: OverlapDecisionRow[], opts: { note?: string | null; actor?: string | null; itemId?: string | null } = {}): Promise<boolean> {
  const itemId = opts.itemId ?? (await ticketItemIdFor(store, ref));
  if (!itemId) return false;
  await recordDecision(store, itemId, OVERLAP_FROM, OVERLAP_TO, { actor: opts.actor, note: opts.note, extra: { rows } });
  return true;
}

/**
 * The dispatch's overlap check (OS-47), one call from each dispatch path, after the check gate and before the
 * launch. Prints one line per overlapping row and records one `overlap` decision; it never refuses. With
 * `--no-check` there is no declared list to trust, so it says the overlap is unknown.
 */
export async function warnDispatchOverlap(
  store: Database | Store | null,
  ticket: { ref: string; repo: string; itemId?: string | null },
  opts: DispatchOverlapDeps & { noCheck?: string | null; actor?: string | null },
): Promise<OverlapResult> {
  if (opts.noCheck != null) {
    warn(`  ⚠ ${OVERLAP_UNKNOWN_LINE}`);
    return { kind: "unknown" };
  }
  const itemId = ticket.itemId ?? (store ? await ticketItemIdFor(store, ticket.ref) : null);
  const declared = opts.declared ?? ((ref: string, id: string | null) => (store ? declaredFilesFor(store, ref, id) : Promise.resolve(null)));
  const result = await overlapFor({ ...ticket, itemId }, { ...opts, declared });
  const lines = renderOverlap(result);
  for (const line of lines) warn(`  ⚠ ${line}`);
  const rows = overlapDecisionRows(result);
  if (rows) {
    const note = lines.join("; ");
    if (opts.record) await opts.record(rows, note);
    else if (store) await recordOverlap(store, ticket.ref, rows, { note, actor: opts.actor, itemId });
  }
  return result;
}

/** The preview's output (`ob spinoff overlap <ticket>`): the same lines, or a JSON object with `--json`. */
export function printOverlap(ticket: { ref: string; repo: string }, result: OverlapResult, json: boolean): void {
  if (json) {
    const rows = result.kind === "checked" ? result.rows.map((h) => ({ ref: h.ref, row: h.row, paths: h.paths, declared_only: h.declaredOnly })) : null;
    print(JSON.stringify({ ticket: ticket.ref, repo: ticket.repo, checked: result.kind === "checked", rows, lines: renderOverlap(result) }));
    return;
  }
  const lines = renderOverlap(result);
  if (lines.length === 0) print(`overlap: none for ${ticket.ref}`);
  for (const line of lines) print(line);
}

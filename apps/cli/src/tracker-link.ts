import { defineSeam } from "./test-seams.ts";
import type { Database } from "bun:sqlite";
import { isObRepo } from "../../../platform/cli-coord/src/clean-repo.ts";
import { eq, isNotNull } from "drizzle-orm";
import { orm } from "./db/orm.ts";
import { item, linearRef, spinoff, taskDetail } from "./db/schema.ts";
import { attachLinear } from "./items.ts";
import { nowIso } from "./db.ts";
import { asStore, type Store } from "./db/store.ts";
import { setting, settingFor } from "./settings.ts";
import { isClosedStatus } from "./status.ts";
import { parseRemote } from "./project.ts";
import { AppError, UsageError } from "./errors.ts";
import { closeIssue, deriveBranch, reopenIssue, type IssueStateChange } from "./github-issues.ts";
import { fetchIssuesLive, type GithubIssue, type IssueFetcher } from "./wayfinder.ts";

// 77: the two trackers, kept in sync.
//
// Work here is tracked in TWO numberings: ob item ids and GitHub issues on `wayfinder_repo`. Landing a
// change used to close whichever numbering the session happened to be holding, so the other side stayed
// open (ob 55 landed as `Merge ob 55` while gh#110 stayed "to do", and a whole builder run was spent
// re-verifying finished work). The #97 leases only stop two sessions working one ticket AT THE SAME
// TIME; they say nothing about a ticket that is ALREADY finished. This module is that missing half:
//   - the LINK between an ob item and its GitHub issue (read/write/lookup),
//   - the "is this already on `main`?" check that stands in for remembering,
//   - the drift + candidate-pair heuristics behind `ob issue reconcile` / `ob issue drift`.
//
// The link is NOT a new table. `ob add --issue` already stores the issue URL in `linear_ref.url` (with
// `linear_id` NULL, since a GitHub URL carries no CUE-### id), which is what `ob show` renders. Reusing
// that row keeps one place to look and needs NO migration.

const ISSUE_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/i;

export interface IssueRef {
  repo: string; // owner/name
  number: number;
}

/** Canonical web URL for an issue. Pure. */
export function issueUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/issues/${number}`;
}

/** Parse a GitHub issue URL into `{ repo, number }`, or null when it is not one (e.g. a Linear URL). Pure. */
export function parseGithubIssueUrl(url: string | null | undefined): IssueRef | null {
  if (!url) return null;
  const m = url.trim().match(ISSUE_URL_RE);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

/**
 * Parse the issue argument the CLI accepts: `#122`, a bare `122`, or a full issue URL. A URL carries its
 * own repo; the short forms leave `repo` undefined for the caller to default to `wayfinder_repo`. Pure.
 */
export function parseIssueArg(arg: string): { repo?: string; number: number } {
  const raw = arg.trim();
  const fromUrl = parseGithubIssueUrl(raw);
  if (fromUrl) return fromUrl;
  const m = raw.match(/^#?(\d+)$/);
  if (!m) throw new UsageError(`invalid issue ref '${arg}' (expected #<n>, <n>, or an issue URL)`);
  return { number: Number(m[1]) };
}

/** Repo equality, case-insensitively (GitHub owner/name are case-insensitive). Pure. */
export function sameRepo(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// --- the link, stored in linear_ref.url -------------------------------------

export interface IssueLink extends IssueRef {
  url: string;
}

/** The GitHub issue an item is linked to, or null (no ref row, or a ref that is not a GitHub issue). */
export async function getIssueLink(db: Database | Store, itemId: string): Promise<IssueLink | null> {
  const store = asStore(db);
  const row = (
    await store.q
      .select({ url: store.t.linearRef.url })
      .from(store.t.linearRef)
      .where(eq(store.t.linearRef.item_id, itemId))
      .limit(1)
  )[0] as { url: string | null } | undefined;
  const ref = parseGithubIssueUrl(row?.url);
  return ref ? { ...ref, url: issueUrl(ref.repo, ref.number) } : null;
}

/**
 * The Linear reference on an item, when its ref row holds one (a URL that is NOT a GitHub issue). The two
 * kinds share `linear_ref` (one row per item), so this is what tells them apart.
 */
export async function getLinearOnlyRef(
  db: Database | Store,
  itemId: string,
): Promise<{ linear_id: string | null; url: string } | null> {
  const store = asStore(db);
  const row = (
    await store.q
      .select({ url: store.t.linearRef.url, linear_id: store.t.linearRef.linear_id })
      .from(store.t.linearRef)
      .where(eq(store.t.linearRef.item_id, itemId))
      .limit(1)
  )[0] as { url: string | null; linear_id: string | null } | undefined;
  if (!row?.url || row.url.trim().length === 0) return null;
  return parseGithubIssueUrl(row.url) ? null : { linear_id: row.linear_id, url: row.url };
}

/**
 * Pair an existing item with an existing issue (idempotent: re-linking just rewrites the URL).
 *
 * REFUSES an item that already carries a Linear reference. `linear_ref` holds ONE row per item and
 * `attachLinear` upserts `linear_id = excluded.linear_id`, which is NULL for a GitHub URL, so linking used
 * to null a real `CUE-1234` id and overwrite its URL with no warning: an unrecoverable loss of a read-only
 * reference to a real Cue ticket. Refusing costs a command; clobbering costs the data. By this repo's own
 * routing rule these are different kinds of work anyway (Cue work belongs in Linear, ob work in ob), so an
 * item needing BOTH is rare enough to deserve a schema change rather than a silent overwrite.
 */
export async function linkIssue(db: Database | Store, itemId: string, ref: IssueRef): Promise<IssueLink> {
  const linear = await getLinearOnlyRef(db, itemId);
  if (linear) {
    throw new AppError(
      `ob ${itemId} already carries a Linear reference (${linear.linear_id ?? "no id"} ${linear.url}) and an ` +
        `item can hold only one reference, so linking would overwrite it. Clear that reference first with ` +
        `'ob issue unlink ${itemId}', then 'ob issue link ${itemId} #${ref.number}'. Unlink clears the ` +
        `reference only: the item keeps its notes, tags, links, history and state, and nothing in Linear is ` +
        `touched (ob only ever held a read-only pointer to it).`,
    );
  }
  const url = issueUrl(ref.repo, ref.number);
  await attachLinear(db, itemId, url);
  return { ...ref, url };
}

export type ClearedRef =
  | { kind: "issue"; url: string; issue: number }
  | { kind: "linear"; url: string; linear_id: string | null };

/**
 * Clear WHICHEVER reference an item's ref row holds, GitHub issue or Linear (138). One row per item holds
 * both kinds, so one remedy covers both: a wrong reference is a wrong field, and a wrong field must never
 * cost the item. Clears the row's url/id rather than DELETEing it: a `linear_ref` item is created with that
 * row, and other readers only ever guard on `url`, so nulling is the non-destructive way out. Everything
 * attached to the item (notes, tags, links, history, state) survives, and clearing a Linear reference drops
 * ob's local read-only pointer only: nothing in Linear is written. Returns what was cleared, or null.
 */
export async function clearRef(db: Database | Store, itemId: string): Promise<ClearedRef | null> {
  const store = asStore(db);
  const issue = await getIssueLink(store, itemId);
  const linear = issue ? null : await getLinearOnlyRef(store, itemId);
  if (!issue && !linear) return null;
  await store.txn("issue unlink", async (tx) => {
    await tx.q
      .update(tx.t.linearRef)
      .set({ url: null, linear_id: null })
      .where(eq(tx.t.linearRef.item_id, itemId));
    await tx.q.update(tx.t.item).set({ updated_at: nowIso() }).where(eq(tx.t.item.id, itemId));
  });
  return issue
    ? { kind: "issue", url: issue.url, issue: issue.number }
    : { kind: "linear", url: linear!.url, linear_id: linear!.linear_id };
}

export interface LinkedItem {
  item_id: string;
  /** The item's type; absent from an older server's pairing response, which reads as a task. */
  type?: string;
  status: string;
  title: string;
  ref: IssueRef;
}

/**
 * Every item that carries a GitHub issue link. Parsed in JS rather than matched in SQL so a stored URL
 * with a trailing slash or a different host case still resolves; `linear_ref` holds one row per linked
 * item, so this stays a small scan.
 */
export async function linkedItems(db: Database | Store): Promise<LinkedItem[]> {
  const store = asStore(db);
  const rows = (await store.q
    .select({
      item_id: store.t.linearRef.item_id,
      url: store.t.linearRef.url,
      status: store.t.item.status,
      type: store.t.item.type,
      title: store.t.item.title,
    })
    .from(store.t.linearRef)
    .innerJoin(store.t.item, eq(store.t.linearRef.item_id, store.t.item.id))
    .where(isNotNull(store.t.linearRef.url))) as Array<{
    item_id: string;
    url: string | null;
    status: string;
    type: string;
    title: string;
  }>;
  const out: LinkedItem[] = [];
  for (const r of rows) {
    const ref = parseGithubIssueUrl(r.url);
    if (ref) out.push({ item_id: r.item_id, type: r.type, status: r.status, title: r.title, ref });
  }
  return out;
}

/**
 * The last SQLITE-ONLY reads in this module (337), and they exist for exactly one caller:
 * `spinoffTicketTags`, which resolves a spinoff row's ticket to its tags for launch routing. That
 * function is synchronous, is called from inside the drain's launch path, and is pinned by
 * test/spinoff.test.ts, which this branch is not permitted to edit. So it keeps a synchronous read here
 * rather than being half-converted, and it is honest about being sqlite-only instead of pretending to be
 * engine-agnostic. Converting `spinoffTicketTags` to the async `itemForIssue`/`trackerRepo`/`getTags`
 * beside them is a two-line change plus four lines in that test file, and it is the last thing standing
 * between this module and being wholly on the store.
 */
export function sqliteLinkedItems(db: Database): LinkedItem[] {
  const rows = orm(db)
    .select({ item_id: linearRef.item_id, url: linearRef.url, status: item.status, type: item.type, title: item.title })
    .from(linearRef)
    .innerJoin(item, eq(linearRef.item_id, item.id))
    .where(isNotNull(linearRef.url))
    .all() as Array<{ item_id: string; url: string | null; status: string; type: string; title: string }>;
  const out: LinkedItem[] = [];
  for (const r of rows) {
    const ref = parseGithubIssueUrl(r.url);
    if (ref) out.push({ item_id: r.item_id, type: r.type, status: r.status, title: r.title, ref });
  }
  return out;
}

/** The item linked to a given issue, or null. Sqlite-only, same caller as above. */
export function sqliteItemForIssue(db: Database, ref: IssueRef): LinkedItem | null {
  return (
    sqliteLinkedItems(db).find((l) => l.ref.number === ref.number && sameRepo(l.ref.repo, ref.repo)) ??
    null
  );
}

/** The configured tracker repo. Sqlite-only, same caller as above. */
export function sqliteTrackerRepo(db: Database): string {
  return setting(db, "wayfinder_repo");
}

export async function itemForIssue(db: Database | Store, ref: IssueRef): Promise<LinkedItem | null> {
  return (
    (await linkedItems(db)).find((l) => l.ref.number === ref.number && sameRepo(l.ref.repo, ref.repo)) ??
    null
  );
}

/**
 * The one-issue-one-item guard (OB-1929): the refusal text when `ref` is already linked to an item other
 * than `ownItemId`, else null. `ob issue link`, the API link route, `ob add --link` and the API create
 * with a `link_url` all call this, so the four give the same message. Callers throw their own error type.
 */
export async function issueClashMessage(
  db: Database | Store,
  ref: IssueRef,
  ownItemId?: string,
): Promise<string | null> {
  const clash = await itemForIssue(db, ref);
  if (!clash || clash.item_id === ownItemId) return null;
  return (
    `issue #${ref.number} is already linked to ob ${clash.item_id} ('${clash.title}'); run ` +
    `'ob issue unlink ${clash.item_id}' first if the issue belongs to this item instead`
  );
}

/**
 * The clash message for a `--link <url>` / `link_url` on a NEW item, or null. A URL that is not a GitHub
 * issue URL (a Linear URL, say) is not checked: it names no issue number to clash on.
 */
export async function linkUrlClashMessage(db: Database | Store, url: string | null | undefined): Promise<string | null> {
  const ref = parseGithubIssueUrl(url);
  return ref ? issueClashMessage(db, ref) : null;
}

/** The configured tracker repo (`wayfinder_repo`): the ONLY repo the close/reopen path will touch. */
export async function trackerRepo(db: Database | Store): Promise<string> {
  return settingFor(db, "wayfinder_repo");
}

// --- landing closes BOTH trackers ------------------------------------------

export type SyncSkipReason = "no-link" | "flag" | "foreign-repo" | "dry-run";

export interface IssueSyncOutcome {
  link: IssueLink | null;
  skipped: SyncSkipReason | null;
  change: IssueStateChange | null;
  error: string | null;
}

/**
 * Mirror an item's local state change onto its linked GitHub issue. Deliberately NARROW and VISIBLE:
 *   - nothing is attempted when the item carries no GitHub issue link (`no-link`);
 *   - `skip` (the `--no-github` flag) opts out entirely (`flag`);
 *   - `dryRun` reports the intended call and makes none (`dry-run`);
 *   - a link pointing at any repo OTHER than the configured tracker repo is REFUSED, not followed
 *     (`foreign-repo`); the close path only ever touches the repo this tracker owns;
 *   - a GitHub failure is returned as `error`, never thrown: the LOCAL close already happened and must
 *     stand, and the caller reports the drift loudly rather than swallowing it.
 * `ob add --issue` already creates issues from ob, so closing ob's own linked issue on landing is the
 * same sanctioned direction; the caller prints exactly which issue it touched.
 */
export async function syncIssueState(
  db: Database | Store,
  itemId: string,
  want: "closed" | "open",
  opts: { skip?: boolean; dryRun?: boolean } = {},
): Promise<IssueSyncOutcome> {
  const link = await getIssueLink(db, itemId);
  if (!link) return { link: null, skipped: "no-link", change: null, error: null };
  if (opts.skip) return { link, skipped: "flag", change: null, error: null };
  // EVERYTHING after this point is inside the try, including reading `wayfinder_repo`: by here the local
  // close has already happened, so any throw must come back as an `error` the caller reports. A throw
  // escaping to `run()` would exit 1 having printed nothing on stdout, which is the "we always report the
  // drift" contract failing in exactly the machine-readable mode that relies on it.
  try {
    if (!sameRepo(link.repo, await trackerRepo(db))) {
      return { link, skipped: "foreign-repo", change: null, error: null };
    }
    if (opts.dryRun) return { link, skipped: "dry-run", change: null, error: null };
    const change =
      want === "closed"
        ? await closeIssue(db, link.repo, link.number)
        : await reopenIssue(db, link.repo, link.number);
    return { link, skipped: null, change, error: null };
  } catch (e) {
    return { link, skipped: null, change: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// --- "is it already on main?" ----------------------------------------------
//
// No network: every signal below is local git state or the local spinoff table. An architect asking "was
// this already built?" gets an answer from the repo instead of from memory.

export type ShResult = { ok: boolean; err: string; out: string };
export type Sh = (cmd: string[], cwd?: string) => ShResult;

const realSh: Sh = (cmd, cwd) => {
  try {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    return {
      ok: p.exitCode === 0,
      err: new TextDecoder().decode(p.stderr).trim(),
      out: new TextDecoder().decode(p.stdout),
    };
  } catch (e) {
    return { ok: false, err: String(e), out: "" };
  }
};

const shSeam = defineSeam<Sh>("tracker-link.sh", realSh);
const sh: Sh = (cmd, cwd) => shSeam.get()(cmd, cwd);

/** Test seam: swap the shell runner so nothing forks a real `git`; returns a restore fn. */
export function __setSh(fn: Sh): () => void {
  return shSeam.set(fn);
}

export const MAIN_BRANCH = "main";
const LOG_LIMIT = 4000;

/**
 * The ref that stands for "main" in `repo`: `origin/main` when the repo has one, else local `main`. A
 * local `main` strictly AHEAD of `origin/main` (unpushed commits, nothing new upstream) wins; if the two
 * have diverged, origin/main wins. The architect checkout never moves its local `main` (lands push from a
 * `<repo>.land-<n>` worktree), so a reader that took the literal `main` would miss every land that exists
 * only on origin (1871, 1874). `run` is the shell seam, so a caller with its own (cli-coord's spinoff)
 * keeps its tests' stubs. No network: it reads the remote-tracking ref as last fetched.
 */
export function mainRefFor(
  repo: string,
  run: (cmd: string[]) => { ok: boolean; out?: string } = (cmd) => sh(cmd),
): string {
  const origin = (run(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${MAIN_BRANCH}^{commit}`]).out ?? "").trim();
  if (!origin) return MAIN_BRANCH;
  return run(["git", "-C", repo, "merge-base", "--is-ancestor", origin, MAIN_BRANCH]).ok ? MAIN_BRANCH : origin;
}

/**
 * The enclosing git checkout root, or null when `cwd` is not in a repo. A `wt` worktree answers with its
 * OWN root, which is what we want: worktrees share the object store, so `git -C <worktree> log main`
 * still sees main's full history.
 */
export function gitToplevel(cwd: string): string | null {
  const r = sh(["git", "-C", cwd, "rev-parse", "--show-toplevel"]);
  const top = r.ok ? r.out.trim() : "";
  return top.length > 0 ? top : null;
}

export interface Commit {
  sha: string;
  subject: string;
  body: string;
}

const REC = "\x1e";
const FLD = "\x1f";

/**
 * A git read that reports whether it could actually run. Silently mapping a git failure to "empty" is how
 * "no evidence on main" got printed for a checkout the code never managed to read: absence of a result is
 * not evidence of absence, so every reader below hands back its failure and `readRepoState` keeps it.
 */
export interface GitRead<T> {
  ok: boolean;
  err: string;
  value: T;
}

/** `git log <main>` as records. */
export function gitLog(repo: string, main: string = MAIN_BRANCH, max = LOG_LIMIT): GitRead<Commit[]> {
  const r = sh(["git", "-C", repo, "log", main, `--max-count=${max}`, `--format=%H${FLD}%s${FLD}%b${REC}`]);
  if (!r.ok) return { ok: false, err: r.err || `cannot read '${main}' in ${repo}`, value: [] };
  const value = r.out
    .split(REC)
    .map((chunk) => chunk.replace(/^\s+/, ""))
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [sha = "", subject = "", body = ""] = chunk.split(FLD);
      return { sha, subject, body };
    });
  return { ok: true, err: "", value };
}

/** The `owner/name` this checkout's `origin` points at, or null when it has no parseable remote. */
export function checkoutRepoSlug(checkout: string): string | null {
  const r = sh(["git", "-C", checkout, "config", "--get", "remote.origin.url"]);
  if (!r.ok) return null;
  const info = parseRemote(r.out.trim());
  return info ? `${info.org}/${info.repo}` : null;
}

export interface MergedBranch {
  name: string;
  tip: string;
  /** Proved to carry commits of its own past where it started. Only then is it evidence of landed work. */
  ownCommits: boolean;
  /** How ownCommits was decided: the spinoff row's captured base, or main's first-parent line. */
  proof: "base-sha" | "first-parent";
  /**
   * Which namespace this branch belongs to, from its spinoff row's `ticket_ref`. NULL when no row names it:
   * `deriveBranch` writes `<n>-<slug>` for BOTH an issue number and an ob id, so an unattributed branch is
   * evidence for neither namespace and is reported as ambiguous instead of counted.
   */
  mention: RefMention | null;
}

/**
 * Branches (local + remote) fully merged into `main`, each with its tip. Empty on any git error.
 * `--merged` ALONE is not evidence of landed work: a branch created off `main` with zero commits is
 * trivially an ancestor of `main`, so every freshly created worktree branch shows up here (#60 hit the
 * same trap in `spinoff reconcile`). `ownCommits` is the gate; see `provedOwnCommits`.
 */
export function mergedBranches(
  repo: string,
  main: string = MAIN_BRANCH,
): GitRead<Array<{ name: string; tip: string }>> {
  const out: Array<{ name: string; tip: string }> = [];
  const seen = new Set<string>();
  let ok = false;
  let err = "";
  for (const args of [
    ["branch", "--merged", main, "--format=%(objectname)%09%(refname:short)"],
    ["branch", "-r", "--merged", main, "--format=%(objectname)%09%(refname:short)"],
  ]) {
    const r = sh(["git", "-C", repo, ...args]);
    if (!r.ok) {
      err = err || r.err || `cannot list branches merged into '${main}' in ${repo}`;
      continue;
    }
    ok = true; // the local listing succeeding is enough; a repo with no remote has no remote branches
    for (const line of r.out.split(/\r?\n/)) {
      const [tip = "", raw = ""] = line.trim().split("\t");
      const name = raw.trim().replace(/^origin\//, "");
      if (name.length === 0 || tip.length === 0) continue;
      if (name === main || name === main.replace(/^origin\//, "") || name === "origin" || name === "HEAD" || name.startsWith("HEAD ")) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, tip });
    }
  }
  return { ok, err: ok ? "" : err, value: out };
}

/** The shas on `main`'s FIRST-PARENT line: main's own trunk, excluding everything merged in from a side. */
export function firstParentShas(repo: string, main: string = MAIN_BRANCH, max = LOG_LIMIT): GitRead<Set<string>> {
  const r = sh(["git", "-C", repo, "rev-list", "--first-parent", `--max-count=${max}`, main]);
  if (!r.ok) return { ok: false, err: r.err || `cannot walk '${main}' in ${repo}`, value: new Set() };
  return {
    ok: true,
    err: "",
    value: new Set(r.out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)),
  };
}

/**
 * Commits on `branch` past `baseSha`, reusing `spinoff reconcile`'s gate verbatim
 * (`git rev-list --count <base>..<branch>`, #60/#61). A NULL base or any git error counts 0, the same
 * conservative default reconcile takes: we never claim work landed on evidence we cannot actually check.
 */
export function uniqueCommitCount(repo: string, baseSha: string | null, branch: string): number {
  if (!baseSha) return 0;
  const r = sh(["git", "-C", repo, "rev-list", "--count", `${baseSha}..${branch}`]);
  if (!r.ok) return 0;
  const n = Number(r.out.trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Does this merged branch carry commits of its OWN, or is it just a pointer into `main`'s trunk?
 * Two ways to know, in order of authority:
 *  1. `base-sha`: the branch's `spinoff` row captured the merge-base at launch, so
 *     `rev-list --count base..branch` is the same unique-commit proof `spinoff reconcile` applies. This is
 *     what rules out a just-created branch whose base IS its tip (gh#133).
 *  2. `first-parent`: with no captured base (a branch predating the column, or one never spun off) the base
 *     is unrecoverable after the merge, so fall back to WHERE THE TIP SITS. Merges here are real merge
 *     commits, so a branch that contributed work has its tip as a SECOND parent, off main's first-parent
 *     line; a zero-commit branch's tip is a commit on that line. A fast-forwarded branch reads as "no own
 *     commits" under this test, a deliberate false NEGATIVE: a missed hit costs a second look, a false hit
 *     stops work from being dispatched at all.
 */
export function provedOwnCommits(
  branch: { name: string; tip: string },
  opts: { baseSha: string | null; unique: (base: string | null, branch: string) => number; firstParent: Set<string> },
): { ownCommits: boolean; proof: "base-sha" | "first-parent" } {
  if (opts.baseSha) return { ownCommits: opts.unique(opts.baseSha, branch.name) > 0, proof: "base-sha" };
  return { ownCommits: !opts.firstParent.has(branch.tip), proof: "first-parent" };
}

/** The signal names `landed` evaluates, in report order. */
export const LANDED_SIGNALS = ["merge-commit", "commit-ref", "merged-branch", "spinoff-row"] as const;
export type LandedSignalName = (typeof LANDED_SIGNALS)[number];

/**
 * The answers the check is allowed to give (129). FOUR, not two, and each one is a different thing:
 *   landed         evidence fired under a numbering that actually belongs to the ref
 *   could-not-tell evidence matched the NUMBER but not the numbering, so which ticket it landed is unknown
 *   no-evidence    nothing matched, which is not proof of absence
 *   could-not-read git could not be read here, so nothing was checked at all
 * `could-not-tell` is the answer #129 added: `main` carries `Merge #122` for ob item 122, which has no
 * linked issue, while GitHub #122 is an unrelated real ticket, so that subject reads as either and the
 * check must say so rather than silently pick one.
 */
export const LANDED_ANSWERS = ["landed", "could-not-tell", "no-evidence", "could-not-read"] as const;
export type LandedAnswer = (typeof LANDED_ANSWERS)[number];

export interface LandedHit {
  signal: LandedSignalName;
  ref: string; // the numbering the hit was found under, e.g. "ob 55" / "#110"
  detail: string;
}

export interface LandedReport {
  landed: boolean;
  /** Which of the four answers this is. `landed` stays the boolean shorthand for `answer === "landed"`. */
  answer: LandedAnswer;
  /** False when git could not be read at all: NOT the same answer as "no evidence found". */
  readable: boolean;
  read_error: string | null;
  checkout: string;
  main: string;
  refs: string[]; // the refs checked, namespace-labelled (`ob 55`, `#110`)
  checked: readonly LandedSignalName[]; // every signal the check CONSIDERED
  fired: readonly LandedSignalName[]; // only the signals that actually produced evidence
  hits: LandedHit[];
  /**
   * Evidence that matched a number but could not be attributed to a namespace, so it was NOT counted.
   * Non-empty with no hits is what makes the answer `could-not-tell` rather than `no-evidence`.
   */
  ambiguous: string[];
  /**
   * OB-1992: the checkout is a clean repo (not OmniSlash), whose subjects carry no ref, so only the spinoff row
   * and the branch it recorded can answer. Absent for OmniSlash.
   */
  clean?: true;
}

// --- the two NAMESPACES, kept apart -----------------------------------------
//
// ob item ids and GitHub issue numbers are INDEPENDENT sequences that collide constantly: `main` carries
// `Merge ob 75` for ob item 75 (lease --holder work) while GitHub #75 is a completely unrelated OPEN
// ticket. Treating "75" as one integer made the guard report gh#75 as already landed and advise
// `gh issue close 75` on unbuilt work. So evidence is only ever read WITH its marker:
//   `ob <n>` / a spinoff `ticket_ref` of `<n>`   -> the ob namespace, and nothing else
//   `#<n>`   / a spinoff `ticket_ref` of `#<n>`  -> the issue namespace, and nothing else
//   a bare `<n>` in a commit scope (`docs(27):`) -> AMBIGUOUS, evidence for neither
//   `#<n>` where `<n>` is ALSO an unlinked ob item  -> AMBIGUOUS too (129): the marker says issue, the
//     history says the author meant the ob id, and nothing in the subject settles it
// A signal found under one namespace may be reported for a ref in the OTHER only when an ob<->issue LINK
// proves they are the same ticket. That link is the only bridge.

// 1949 adds a third namespace, the per-project ref (`PS-12`). Its key is part of its identity: PS-12 and
// HC-12 are different tickets, and neither says anything about `ob 12` or `#12`.
export type Namespace = "ob" | "issue" | "ref";

/** A ref a commit/branch/spinoff row claims, carrying the namespace its marker established. */
export interface RefMention {
  namespace: Namespace;
  number: number;
  /** The uppercase project key of a `ref` mention (`PS`); absent for the other two namespaces. */
  key?: string;
}

/** How a ref reads in output: `ob 55`, `#110` or `PS-12`. Pure. */
export function refLabel(m: RefMention): string {
  if (m.namespace === "ref") return `${m.key}-${m.number}`;
  return m.namespace === "ob" ? `ob ${m.number}` : `#${m.number}`;
}

function sameMention(a: RefMention, b: RefMention): boolean {
  return a.namespace === b.namespace && a.number === b.number && (a.key ?? null) === (b.key ?? null);
}

/** A `PS-12` token inside a scope, merge subject or closing keyword (case-insensitive, leading zeros dropped). */
const REF_TOKEN = String.raw`\b[A-Za-z]{2,4}-0*\d+\b`;

/**
 * The house rule an author is expected to write, restated wherever the check reports a break of it (129).
 */
export const HASH_HOUSE_RULE = "an unlinked ob item lands as 'Merge ob <n>', never '#<n>'";

/**
 * Is a `#<n>` mention UNREADABLE rather than an issue mention? `#<n>` marks the issue namespace, but ob
 * items 120-128 were landed as `Merge #120`..`Merge #127` while carrying NO linked GitHub issue, and those
 * numbers are unrelated real issues in this repo. So a `#<n>` whose `<n>` is ALSO a live ob item with no
 * link reads as either ticket, and the honest answer is that we cannot tell: counting it as the issue made
 * `landed #122` cite two unrelated changes, and refusing to consider the ob reading made `landed 122`
 * report "no evidence" for work sitting on `main`. Pure.
 */
export function hashCollidesWithObItem(m: RefMention, n: number, unlinkedObItems: ReadonlySet<number>): boolean {
  return m.namespace === "issue" && m.number === n && unlinkedObItems.has(n);
}

/** The `ambiguous` line a collided `#<n>` earns, naming the evidence, both readings and the house rule. */
function collisionNote(how: string, evidence: string, n: number, label: string): string {
  return (
    `${how} ${evidence} spells '#${n}', but ob ${n} is an ob item with NO linked GitHub issue, so this reads ` +
    `as either issue #${n} or ob ${n} written the wrong way and it is NOT counted for ${label}; ${HASH_HOUSE_RULE}`
  );
}

/**
 * Pull the marked refs out of a run of numbers, e.g. `#123 + #128`, `#99,#98`, `ob 61`. A number with NO
 * marker is dropped: this repo really does write `docs(27):` and `fix(111):` scopes whose numbers belong
 * to the old markdown tracker, so a bare number proves nothing about either namespace. Pure.
 */
function markedRefs(run: string): RefMention[] {
  const out: RefMention[] = [];
  // A `PS-12` ref carries its own marker, its key (1949).
  for (const m of run.matchAll(/(#|\bob\s+)0*(\d+)\b|\b([A-Za-z]{2,4})-0*(\d+)\b/gi)) {
    if (m[3]) {
      out.push({ namespace: "ref", key: m[3].toUpperCase(), number: Number(m[4]) });
      continue;
    }
    const marker = m[1]!.trim().toLowerCase();
    out.push({ namespace: marker === "#" ? "issue" : "ob", number: Number(m[2]) });
  }
  return out;
}

/**
 * The refs a MERGE-COMMIT subject claims to be landing: `Merge ob 55: …`, `Merge #102: …`,
 * `Merge #123 + #128: …`, `Merge issue #41`. This repo lands every branch as one of these, so it is the
 * strongest signal available. The ref run must be followed by `:` or end the subject, which keeps
 * `Merge branch 'x'` and `Merge main (#101, #105) into #102` from reading as landings of what they merged
 * IN (a mid-subject mention is not a claim). Multi-ticket subjects yield every ref they name. Pure.
 */
export function parseMergeSubject(subject: string): RefMention[] {
  const one = `(?:(?:issue\\s+)?(?:#|ob\\s+)0*\\d+|${REF_TOKEN})`;
  const more = `(?:(?:issue\\s+)?(?:#|ob\\s+)?0*\\d+|${REF_TOKEN})`;
  const m = subject.trim().match(new RegExp(`^merge\\s+(${one}(?:\\s*[+,]\\s*${more})*)\\s*(?::|$)`, "i"));
  if (!m) return [];
  // In `Merge #99 + #98` the marker is only written once; inherit it (and a ref's key) across the run.
  const run = m[1]!;
  const refs = markedRefs(run);
  if (refs.length === 0) return [];
  const first = refs[0]!;
  const seen = new Set(refs.filter((r) => sameMention({ ...r, number: 0 }, { ...first, number: 0 })).map((r) => r.number));
  for (const bare of run.matchAll(/[+,]\s*0*(\d+)\b/g)) {
    const n = Number(bare[1]);
    if (!seen.has(n)) {
      seen.add(n);
      refs.push(first.key ? { namespace: first.namespace, key: first.key, number: n } : { namespace: first.namespace, number: n });
    }
  }
  return refs;
}

/**
 * The refs a commit claims via a LEADING conventional-commit scope (`feat(ob 77):`, `fix(#123,#128):`) or
 * a closing keyword anywhere in subject/body (`Closes #41`). Anchored at the start for the scope: an
 * unanchored `\(#n\)` matched prose like `docs(104): reconcile #24 with the WhatsApp map`, turning every
 * passing mention into "already landed". Pure.
 */
export function parseCommitRefs(subject: string, body: string): RefMention[] {
  const out: RefMention[] = [];
  const scope = subject.trim().match(/^[a-z]+!?\(([^)]*)\)!?\s*:/i);
  if (scope) out.push(...markedRefs(scope[1]!));
  const tok = `(?:(?:#|ob\\s+)0*\\d+|${REF_TOKEN})`;
  const tokMore = `(?:(?:#|ob\\s+)?0*\\d+|${REF_TOKEN})`;
  for (const m of `${subject}\n${body}`.matchAll(
    new RegExp(`\\b(?:closes|closed|fixes|fixed|resolves|resolved)\\s*:?\\s+(${tok}(?:\\s*,\\s*${tokMore})*)`, "gi"),
  )) {
    out.push(...markedRefs(m[1]!));
  }
  return out.filter((m, i) => out.findIndex((o) => sameMention(o, m)) === i);
}

/** The refs a commit provides, merge subject first. Pure. */
export function commitRefs(c: Commit): RefMention[] {
  const merge = parseMergeSubject(c.subject);
  return merge.length > 0 ? merge : parseCommitRefs(c.subject, c.body);
}

/**
 * The subject types that NAME a ticket without landing its work (ob 1201). Wayfinder writes both, and
 * both land by design BEFORE or DURING the build: `docs(ob 738): Hermes loop map` is the chart commit
 * for the ticket, and `chart(ob 911): …` is a map update. Reading either as a landing retired spinoff
 * row 601 while its builder was still working and its work was unlanded, so they never count here.
 */
const NON_LANDING_TYPES = new Set(["docs", "chart"]);

/**
 * The leading conventional-commit type of a subject (`feat(ob 77): …` → `feat`), lower-cased, or null
 * when the subject is not conventional. Pure.
 */
function commitType(subject: string): string | null {
  const m = subject.trim().match(/^([a-z]+)!?(?:\([^)]*\))?!?\s*:/i);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Is this commit the LANDING of a ticket rather than a note about one? (ob 1201)
 * `Merge ob 77: …` is the repo's own landing shape, and every other landing CLAIMS the ticket — a
 * conventional-commit scope naming it (`feat(ob 77):`, `fix(#102):`, `chore(ob 915):`), or, for a subject
 * with no conventional type at all, the closing keyword that is the only way such a commit can name one
 * (`Update the thing` + `Closes ob 77`). Both of those are read by `commitRefs`, so asking it keeps both
 * claims alive — and the only thing excluded is the documentation pair, whose subjects always name a
 * ticket and never land its work. The gate is those two TYPES, not an allow-list: a land really does
 * arrive as `chore(ob 915): delete the leftover visual-gate app`, and an allow-list of `feat`/`fix` would
 * stop retiring those rows. Pure.
 */
export function landsTicket(c: Commit): boolean {
  if (parseMergeSubject(c.subject).length > 0) return true;
  const type = commitType(c.subject);
  if (type !== null && NON_LANDING_TYPES.has(type)) return false;
  return commitRefs(c).length > 0;
}

/**
 * The commits strictly newer than `baseSha`, from a newest-first log (`gitLog` order). A commit that
 * lands this ticket's work cannot predate the row that dispatched the build, so the row's own record —
 * the merge-base with `main` captured at launch — bounds the search: everything logged after `baseSha`
 * is older and out.
 *
 * The two ways there is no bound are NOT the same, and they resolve in opposite directions:
 *   - no base recorded at all (a pre-#61 row) leaves every commit eligible: that row has always relied on
 *     the 932 signal, and taking it away would leave it to a hand-run `ob agent done`.
 *   - a base the log does NOT contain is a row whose start cannot be located in the history in hand, so
 *     NOTHING is provably newer than it and no landing is claimed — the same conservative direction
 *     `gitUniqueCommitCount` takes on an unverifiable base, and the direction that cannot retire a live
 *     row mid-flight. It self-heals as soon as the read reaches the base (a pushed `origin/main`). Pure.
 */
export function commitsSinceBase(commits: Commit[], baseSha: string | null | undefined): Commit[] {
  if (!baseSha) return commits;
  const i = commits.findIndex((c) => c.sha === baseSha);
  return i < 0 ? [] : commits.slice(0, i);
}

/**
 * Has this ticket's work landed without local `main` moving? (ob 932)
 * A done ticket, or a LANDING commit naming the ticket on the commits handed in (the caller walks
 * `origin/main`, not the dirty local branch) — a landing being a merge subject, a conventional scope, or
 * an explicit closing keyword, never a `docs(`/`chart(` note, and never one older than the row's `baseSha`
 * (ob 1201): a row with no base recorded at all keeps the 932 signal, while a recorded base the log cannot
 * find claims no landing. A bare number in prose is not a landing. Pure.
 */
export function workHasLanded(
  ticketRef: string,
  opts: { status?: string | null; commits?: Commit[]; baseSha?: string | null },
): boolean {
  if (opts.status === "done") return true;
  return landingCommitFor(ticketRef, opts) !== null;
}

/**
 * The newest LANDING commit naming the ticket since `baseSha`, by the same rule `workHasLanded` reads
 * commits with, or null. `ob spinoff reopen` refuses a row that has one (OB-2180): its work is on main. Pure.
 */
export function landingCommitFor(
  ticketRef: string,
  opts: { commits?: Commit[]; baseSha?: string | null },
): Commit | null {
  const mention = ticketRefMention(ticketRef);
  if (!mention) return null;
  return (
    commitsSinceBase(opts.commits ?? [], opts.baseSha).find(
      (c) => landsTicket(c) && commitRefs(c).some((m) => sameMention(m, mention)),
    ) ?? null
  );
}

/**
 * The namespace-marked ref a spinoff `ticket_ref` names: `#133` is issue 133, a bare `133` is ob item 133
 * (the disambiguator `parseIssueRef` already documents), `PS-12` (any case) is that per-project ref (1949),
 * anything else (`local-twilio-dev-loop`) is none of them. Pure.
 */
export function ticketRefMention(ref: string): RefMention | null {
  const t = ref.trim();
  const hash = t.match(/^#(\d+)$/);
  if (hash) return { namespace: "issue", number: Number(hash[1]) };
  const keyed = t.match(/^([A-Za-z]{2,4})-0*(\d+)$/);
  if (keyed) return { namespace: "ref", key: keyed[1]!.toUpperCase(), number: Number(keyed[2]) };
  const bare = t.match(/^(\d+)$/);
  return bare ? { namespace: "ob", number: Number(bare[1]) } : null;
}

/**
 * Does a branch name carry this number, by the `<n>-<slug>` convention (`55-theme-sync`)?
 * NOTE this is namespace-BLIND on purpose: `deriveBranch` builds the same shape from an issue number and
 * from an ob id, so the name alone cannot say which. The namespace comes from the branch's spinoff
 * `ticket_ref`; a branch with no row stays unattributed and is reported as ambiguous, never as a hit. Pure.
 */
export function branchMatches(branch: string, n: number, key?: string): boolean {
  if (!Number.isSafeInteger(n) || n <= 0) return false;
  // A per-project ref's branch is `ps-12` (1949): the key is in the name, so it matches only its own key.
  if (key) return new RegExp(`^${key}-0*${n}(?:-|$)`, "i").test(branch.trim());
  return new RegExp(`^0*${n}(?:-|$)`).test(branch.trim());
}

export interface MergedSpinoff {
  ticket_ref: string;
  branch: string;
  base_sha: string | null;
  /** Same unique-commit proof reconcile applies. A row without it is not evidence, whatever its status. */
  ownCommits: boolean;
}

/** Everything the landed check reads, gathered ONCE (git is forked a handful of times, not per ref). */
export interface RepoState {
  checkout: string;
  main: string;
  /** False when git could not be read here at all. The report must say so instead of "no evidence". */
  readable: boolean;
  readError: string | null;
  commits: Commit[];
  branches: MergedBranch[];
  spinoffs: MergedSpinoff[];
  /**
   * Numeric ob item ids carrying NO GitHub issue link. These are exactly the numbers a `#<n>` in a commit
   * cannot be trusted to mean, so this is what turns such evidence into `could-not-tell` (129). Empty when
   * no db was supplied, the same way `spinoffs` is: with no ob namespace to consult there is no collision
   * to find.
   */
  unlinkedObItems: Set<number>;
}

/**
 * Every numeric ob item id with no GitHub issue link, ANY status. Closed items count: ob 120-127 are all
 * done and their merge subjects are still on `main`, which is the whole case #129 exists for.
 */
export async function unlinkedObItemIds(s: Store): Promise<Set<number>> {
  const linked = new Set((await linkedItems(s)).map((l) => l.item_id));
  const out = new Set<number>();
  for (const r of (await s.q.select({ id: s.t.item.id }).from(s.t.item)) as Array<{ id: string }>) {
    if (linked.has(r.id) || !/^\d+$/.test(r.id)) continue;
    out.add(Number(r.id));
  }
  return out;
}

/**
 * Store facts the landed/drift git half needs. Gathered once on the API host (or from a local Store)
 * and handed to `readRepoState` so an API client can run git HERE without opening a database.
 */
export interface LandedStoreFacts {
  unlinkedObItems: Set<number>;
  mergedSpinoffs: Array<{ ticket_ref: string; branch: string; base_sha: string | null }>;
  allSpinoffs: Array<{ branch: string; base_sha: string | null; ticket_ref: string }>;
}

export async function gatherLandedStoreFacts(store: Store): Promise<LandedStoreFacts> {
  const mergedSpinoffs = (await store.q
    .select({ ticket_ref: store.t.spinoff.ticket_ref, branch: store.t.spinoff.branch, base_sha: store.t.spinoff.base_sha })
    .from(store.t.spinoff)
    .where(eq(store.t.spinoff.status, "merged"))) as Array<{ ticket_ref: string; branch: string; base_sha: string | null }>;
  const allSpinoffs = (await store.q
    .select({ branch: store.t.spinoff.branch, base_sha: store.t.spinoff.base_sha, ticket_ref: store.t.spinoff.ticket_ref })
    .from(store.t.spinoff)) as Array<{ branch: string; base_sha: string | null; ticket_ref: string }>;
  return { unlinkedObItems: await unlinkedObItemIds(store), mergedSpinoffs, allSpinoffs };
}

function isStore(x: Store | LandedStoreFacts): x is Store {
  return "kind" in x && "q" in x;
}

/**
 * Gather the local evidence. Each merged branch and each `merged` spinoff row is resolved to whether it
 * actually carries commits of its own AND which namespace it belongs to, BEFORE any ref is matched against
 * it, so neither a zero-commit branch nor a cross-namespace number collision can reach the report.
 */
export async function readRepoState(
  checkout: string,
  mainArg?: string,
  storeOrFacts?: Store | LandedStoreFacts,
): Promise<RepoState> {
  // Unset means origin/main when the checkout has one (1874): the architect's local `main` never moves.
  const main = mainArg ?? (mainRefFor(checkout) === MAIN_BRANCH ? MAIN_BRANCH : `origin/${MAIN_BRANCH}`);
  const log = gitLog(checkout, main);
  const merged = mergedBranches(checkout, main);
  const firstParent = firstParentShas(checkout, main);
  const readError = !log.ok ? log.err : !merged.ok ? merged.err : !firstParent.ok ? firstParent.err : null;
  const unique = (base: string | null, branch: string) => uniqueCommitCount(checkout, base, branch);
  const facts: LandedStoreFacts | undefined = !storeOrFacts
    ? undefined
    : isStore(storeOrFacts)
      ? await gatherLandedStoreFacts(storeOrFacts)
      : storeOrFacts;
  const rows = facts?.mergedSpinoffs ?? [];
  const baseByBranch = new Map<string, string>();
  const mentionByBranch = new Map<string, RefMention>();
  for (const r of facts?.allSpinoffs ?? []) {
    if (r.base_sha && !baseByBranch.has(r.branch)) baseByBranch.set(r.branch, r.base_sha);
    const m = ticketRefMention(r.ticket_ref);
    if (m && !mentionByBranch.has(r.branch)) mentionByBranch.set(r.branch, m);
  }
  const branches: MergedBranch[] = merged.value.map((b) => ({
    ...b,
    ...provedOwnCommits(b, { baseSha: baseByBranch.get(b.name) ?? null, unique, firstParent: firstParent.value }),
    mention: mentionByBranch.get(b.name) ?? null,
  }));
  const provedBranches = new Set(branches.filter((b) => b.ownCommits).map((b) => b.name));
  return {
    checkout,
    main,
    readable: readError === null,
    readError,
    commits: log.value,
    branches,
    unlinkedObItems: facts?.unlinkedObItems ?? new Set<number>(),
    spinoffs: rows.map((r) => ({
      ...r,
      ownCommits: unique(r.base_sha, r.branch) > 0 || provedBranches.has(r.branch),
    })),
  };
}

/** A ref the check is asked about, always namespace-tagged. */
export interface CheckedRef extends RefMention {
  /** Why this ref is being checked: the ref asked for, or one a LINK proved is the same ticket. */
  via: "asked" | "link";
}

/**
 * Does the implementation for these refs already appear on `main`? Four signals, each reported with the
 * evidence that fired it:
 *   merge-commit   = a `Merge ob <n>` / `Merge #<n>` subject in `main`'s history (how this repo lands)
 *   commit-ref     = a commit on `main` scoped `(ob <n>)`/`(#<n>)` or closing `#<n>`
 *   merged-branch  = a branch named `<n>-*` merged into `main` AND PROVED to carry commits of its own
 *   spinoff-row    = a `spinoff` row for `<n>` reconciled `merged`, held to that same proof
 * The last two both gate on `ownCommits` (see `provedOwnCommits`). Without that gate `git branch --merged`
 * lists every freshly created worktree branch, so the guard told an architect "already done, do not dispatch"
 * about work that had not started (gh#133). That failure is worse than the drift this exists to prevent:
 * the drift cost one builder run, this would stop work being dispatched at all. So the bar is evidence of
 * a DIFFERENCE (commits that exist), never the absence of one.
 * Any hit means "look before you dispatch". No hit means no evidence was found, NOT proof of absence, and
 * evidence that matched the NUMBER under the wrong marker answers `could-not-tell` rather than either (129).
 * Pure over a gathered RepoState.
 */
export function landedIn(state: RepoState, refs: CheckedRef[]): LandedReport {
  const hits: LandedHit[] = [];
  const ambiguous: string[] = [];
  for (const ref of refs) {
    const label = refLabel(ref);
    const via = ref.via === "link" ? " (via the link)" : "";

    // A `#<n>` whose number is also an unlinked ob item is evidence for NEITHER numbering (129), so each
    // commit signal is read twice: once for mentions that confidently belong to this ref, once for the
    // collided ones, which become `ambiguous` lines instead of hits.
    const confident = (mentions: RefMention[]) =>
      mentions.some((m) => sameMention(m, ref) && !hashCollidesWithObItem(m, ref.number, state.unlinkedObItems));
    const collided = (mentions: RefMention[]) =>
      mentions.some((m) => hashCollidesWithObItem(m, ref.number, state.unlinkedObItems));

    const merge = state.commits.find((c) => confident(parseMergeSubject(c.subject)));
    if (merge) {
      hits.push({ signal: "merge-commit", ref: label, detail: `${merge.sha.slice(0, 7)} ${merge.subject}${via}` });
    }
    for (const c of state.commits.filter((c) => collided(parseMergeSubject(c.subject)))) {
      ambiguous.push(collisionNote("merge commit", `${c.sha.slice(0, 7)} ${c.subject}`, ref.number, label));
    }
    const named = state.commits.find((c) => confident(parseCommitRefs(c.subject, c.body)));
    if (named) {
      hits.push({ signal: "commit-ref", ref: label, detail: `${named.sha.slice(0, 7)} ${named.subject}${via}` });
    }
    for (const c of state.commits.filter((c) => collided(parseCommitRefs(c.subject, c.body)))) {
      ambiguous.push(collisionNote("commit", `${c.sha.slice(0, 7)} ${c.subject}`, ref.number, label));
    }
    // A merged branch counts only when it BOTH carries commits of its own and is attributed to this ref's
    // namespace by its spinoff row. A name-only match is reported as ambiguous, never as a hit: the same
    // `<n>-<slug>` shape is produced from an issue number and from an ob id.
    for (const b of state.branches) {
      // OB-1992: a clean repo's branch is a title slug that names no ref, so the branch the ROW recorded is
      // what ties it to the ticket.
      const byRow = b.mention !== null && sameMention(b.mention, ref);
      if (!branchMatches(b.name, ref.number, ref.key) && !byRow) continue;
      if (!b.ownCommits) continue;
      // A `ps-12` branch names its key, so unlike `<n>-<slug>` it needs no row to say which namespace (1949).
      if (b.mention ? sameMention(b.mention, ref) : ref.namespace === "ref") {
        hits.push({
          signal: "merged-branch",
          ref: label,
          detail: `${b.name} is merged into ${state.main} with commits of its own (${b.proof})${via}`,
        });
      } else if (!b.mention) {
        ambiguous.push(
          `branch ${b.name} is merged into ${state.main} with commits of its own, but nothing says whether ` +
            `'${b.name.split("-")[0]}' means an ob id or an issue number, so it is not counted for ${label}`,
        );
      }
    }
    const row = state.spinoffs.find((s) => {
      const m = ticketRefMention(s.ticket_ref);
      return s.ownCommits && m !== null && sameMention(m, ref);
    });
    if (row) {
      hits.push({
        signal: "spinoff-row",
        ref: label,
        detail: `spinoff ${row.ticket_ref} (${row.branch}) reconciled merged${via}`,
      });
    }
  }
  hits.sort(
    (a, b) => LANDED_SIGNALS.indexOf(a.signal) - LANDED_SIGNALS.indexOf(b.signal) || a.ref.localeCompare(b.ref),
  );
  const fired = LANDED_SIGNALS.filter((s) => hits.some((h) => h.signal === s));
  const notes = state.readable ? [...new Set(ambiguous)] : [];
  // A hit outranks an ambiguity: something did fire under this ref's own numbering, and the caller is told
  // to read the merge either way. Ambiguity with NO hit is the case that must not read as "no evidence".
  const answer: LandedAnswer = !state.readable
    ? "could-not-read"
    : hits.length > 0
      ? "landed"
      : notes.length > 0
        ? "could-not-tell"
        : "no-evidence";
  return {
    // A checkout we could not read yields no hits for reasons that have nothing to do with the work, so it
    // can never answer "landed".
    landed: state.readable && hits.length > 0,
    answer,
    readable: state.readable,
    read_error: state.readError,
    checkout: state.checkout,
    main: state.main,
    refs: refs.map((r) => refLabel(r)),
    checked: LANDED_SIGNALS,
    fired,
    hits: state.readable ? hits : [],
    ambiguous: notes,
    ...(isObRepo(state.checkout) ? {} : { clean: true as const }),
  };
}

// --- candidate-pair heuristics (ob issue reconcile) -------------------------

const STOPWORDS = new Set([
  "a", "an", "and", "the", "to", "for", "of", "on", "in", "it", "its", "is", "be", "with", "at", "by",
  "from", "into", "that", "this", "ob", "add", "make",
]);

/** Meaningful lowercase tokens of a title (stopwords + 2-char noise dropped). Pure. */
export function titleTokens(title: string): string[] {
  return [
    ...new Set(
      title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
    ),
  ];
}

/** Token overlap of two titles, 0..1 (intersection over the smaller token set). Pure. */
export function titleScore(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setB = new Set(tb);
  const shared = ta.filter((t) => setB.has(t)).length;
  return shared / Math.min(ta.length, tb.length);
}

/** Strip a leading `<number>-` from a branch name, leaving the slug. Pure. */
export function branchSlug(branch: string | null | undefined): string {
  if (!branch) return "";
  return branch.trim().replace(/^\d+-/, "");
}

/**
 * Do an item's branch and an issue's derived branch describe the same work? Compares the slug halves
 * (the number halves are the two numberings we are trying to reconcile, so they never match): equal, or
 * one is a suffix/prefix of the other. Short slugs are ignored to keep this from firing on noise. Pure.
 */
export function branchSlugsAgree(itemBranch: string | null | undefined, issue: { number: number; title: string }): boolean {
  const a = branchSlug(itemBranch);
  const b = branchSlug(deriveBranch(issue.number, issue.title));
  if (a.length < 8 || b.length < 8) return false;
  return a === b || a.endsWith(b) || b.endsWith(a) || a.startsWith(b) || b.startsWith(a);
}

export const TITLE_MATCH_THRESHOLD = 0.6;

export interface PairCandidateItem {
  id: string;
  title: string;
  status: string;
  branch: string | null;
}

export interface PairCandidate {
  item_id: string;
  item_title: string;
  item_status: string;
  issue: number;
  issue_title: string;
  issue_state: string;
  score: number;
  reasons: string[];
}

/**
 * Likely ob-item ↔ GitHub-issue pairs that are NOT linked yet, the ob 55 / gh#110 shape. Candidates
 * only: a human confirms each with `ob issue link`. Never links anything itself, and never guesses when
 * a side is already linked. Pure.
 */
export function candidatePairs(
  items: PairCandidateItem[],
  issues: Array<{ number: number; title: string; state: string }>,
  linkedIssueNumbers: Set<number>,
  perItem = 3,
): PairCandidate[] {
  const out: PairCandidate[] = [];
  for (const it of items) {
    const scored: PairCandidate[] = [];
    for (const issue of issues) {
      if (linkedIssueNumbers.has(issue.number)) continue;
      const reasons: string[] = [];
      const score = titleScore(it.title, issue.title);
      if (score >= TITLE_MATCH_THRESHOLD) reasons.push(`title ${score.toFixed(2)}`);
      if (branchSlugsAgree(it.branch, issue)) reasons.push(`branch ${it.branch} ~ ${deriveBranch(issue.number, issue.title)}`);
      if (reasons.length === 0) continue;
      scored.push({
        item_id: it.id,
        item_title: it.title,
        item_status: it.status,
        issue: issue.number,
        issue_title: issue.title,
        issue_state: issue.state.toLowerCase(),
        score,
        reasons,
      });
    }
    scored.sort((a, b) => b.reasons.length - a.reasons.length || b.score - a.score || a.issue - b.issue);
    out.push(...scored.slice(0, perItem));
  }
  out.sort((a, b) => b.reasons.length - a.reasons.length || b.score - a.score || Number(a.item_id) - Number(b.item_id));
  return out;
}

/** Open, unlinked ob items worth reconciling against the issue list (tasks only; `ob rm`'d rows are gone). */
export async function unlinkedOpenItems(db: Database | Store): Promise<PairCandidateItem[]> {
  const store = asStore(db);
  const linked = new Set((await linkedItems(store)).map((l) => l.item_id));
  const rows = (await store.q
    .select({
      id: store.t.item.id,
      title: store.t.item.title,
      status: store.t.item.status,
      type: store.t.item.type,
      branch: store.t.taskDetail.branch,
    })
    .from(store.t.item)
    .leftJoin(store.t.taskDetail, eq(store.t.item.id, store.t.taskDetail.item_id))) as Array<{
    id: string;
    title: string;
    status: string;
    type: string;
    branch: string | null;
  }>;
  return rows
    .filter((r) => r.type === "task" && r.status !== "done" && !linked.has(r.id))
    .map((r) => ({ id: r.id, title: r.title, status: r.status, branch: r.branch }));
}

// --- drift (ob issue drift) ------------------------------------------------

export interface DriftRow {
  kind: "issue-open-but-landed" | "issue-closed-but-item-open";
  issue: number;
  issue_title: string;
  item_id: string | null;
  detail: string;
}

export interface DriftInput {
  checkout: string; // the local checkout to read git state from
  trackerRepo: string; // owner/name the issues belong to (link matching is repo-scoped)
  issues: GithubIssue[];
  store?: Store;
  facts?: LandedStoreFacts;
  links?: LinkedItem[];
  main?: string;
}

/**
 * Tracker drift, both directions:
 *   issue-open-but-landed      = an OPEN issue whose implementation already looks like it is on `main`,
 *                               checked in the ISSUE namespace, plus the ob namespace only when a link
 *                               proves the two numbers are one ticket
 *   issue-closed-but-item-open = a CLOSED issue whose linked ob item is still open
 * Read-only: no writes, no GitHub mutations, and the issue list arrives from the caller's fetch seam.
 * An unreadable checkout yields NO rows: this must never advise closing a ticket on evidence it could not
 * gather, and it must never advise it on evidence belonging to the other numbering.
 */
export async function computeDrift(input: DriftInput): Promise<DriftRow[]> {
  const facts = input.facts ?? (input.store ? await gatherLandedStoreFacts(input.store) : undefined);
  const state = await readRepoState(input.checkout, input.main, facts);
  if (!state.readable) return [];
  const links = input.links ?? (input.store ? await linkedItems(input.store) : []);
  const out: DriftRow[] = [];
  for (const issue of input.issues) {
    const link =
      links.find((l) => l.ref.number === issue.number && sameRepo(l.ref.repo, input.trackerRepo)) ?? null;
    const closed = issue.state.toUpperCase() === "CLOSED";
    if (!closed) {
      const refs: CheckedRef[] = [{ namespace: "issue", number: issue.number, via: "asked" }];
      if (link && /^\d+$/.test(link.item_id)) {
        refs.push({ namespace: "ob", number: Number(link.item_id), via: "link" });
      }
      const report = landedIn(state, refs);
      if (report.landed) {
        out.push({
          kind: "issue-open-but-landed",
          issue: issue.number,
          issue_title: issue.title,
          item_id: link?.item_id ?? null,
          detail: report.hits.map((h) => `${h.signal} (${h.ref}): ${h.detail}`).join("; "),
        });
      }
    } else if (link && !isClosedStatus(link.type ?? "task", link.status)) {
      out.push({
        kind: "issue-closed-but-item-open",
        issue: issue.number,
        issue_title: issue.title,
        item_id: link.item_id,
        detail: `ob ${link.item_id} is '${link.status}' while the issue is closed`,
      });
    }
  }
  return out;
}

// --- the issue-list seam ---------------------------------------------------

const listIssuesSeam = defineSeam<IssueFetcher>("tracker-link.listIssues", fetchIssuesLive);

/** The wayfinder-labelled issues of a repo (open + closed), through the injectable seam. */
export function listIssues(db: Database | Store, repo: string): Promise<GithubIssue[]> {
  return listIssuesSeam.get()(db, repo);
}

/** Test seam: swap the issue lister; returns a restore fn. */
export function __setListIssues(fn: IssueFetcher): () => void {
  return listIssuesSeam.set(fn);
}

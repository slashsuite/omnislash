import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isObRepo, obLeaks, renderLeaks, type Leak } from "./clean-repo.ts";
import { checkSubject, type SubjectCheck } from "./conventional-commit.ts";

// 1657: the land guard. Run in the land worktree on the squash commit, BEFORE `git push origin HEAD:main`.
// Since OB-1670 (#80) a land is a GitHub PR squash, which never pushes to main from here, so
// the pre-push hook never sees it: whoever merges (the architect since OB-1686, #82; the builder runs it too before
// it opens the PR) runs this on the rebased branch head before `gh pr merge`, with `--subject` naming the squash
// subject it will pass to `gh pr merge --subject`.
//
// 945cad09 (ob 1636) was squashed from a tree that predated b5e94c5a (1622, Cue removal) and 981911e1
// (a chart), so the commit silently re-added ~5.6k lines of Cue and dropped the chart. The builder had
// run `git reset --soft main` in ITS OWN worktree and committed: that keeps the branch's tree, which is
// the stale tree, and turns every commit main gained since the fork into part of the "builder's diff".
// Nothing in ob-land noticed because its `git merge --squash` step was never run; the squash commit
// reached origin/main by a different road.
//
// Three checks, all pure git, no network:
//  1. REVERTS (always): for each of the last `depth` commits M on `against`, a path the land commit
//     touches whose new blob is exactly the blob M replaced (or absent where M added it) has had M
//     undone. A real edit after M produces a new blob, so only a wholesale restore of the pre-M file
//     trips this. This is the check that catches the 1636 shape. Merely deleting a file M added is too
//     common (renames) to count alone; it is listed only beside a restored file. A stale squash that only
//     DROPS new files is the scope check's to catch. For a PR squash (`--branch` or `--squash`, OB-2176) only
//     paths changed since merge-base(against, head) are tested: a branch that is merely behind main still holds
//     the pre-image of what main changed later, but GitHub's three-way squash keeps main's side there. A plain
//     push (the pre-push hook) replaces main's tree, so it tests every path that differs.
//  2. SCOPE (with `branch`): the commit may only touch paths the builder's own branch changed since its
//     fork point (`base`, else merge-base with `against`). Catches a squash taken with `--theirs`,
//     `checkout <branch> -- .` or similar. It cannot see a branch rewritten onto main before the land,
//     which is why `base` should be the spinoff row's captured base_sha when you have it.
//  3. SUBJECT (always, 1666): the land commit's subject is a Conventional Commit, by the same validator the
//     commit-msg hook uses (conventional-commit.ts). The hook is bypassable with --no-verify and absent in a
//     checkout that never ran `bun install`; this is the check that cannot be skipped by accident.
//  4. CLEAN REPO (OB-1992): in every repo but OmniSlash, the squash subject and body carry nothing of ob (no
//     ticket ref, no State:/Gate:/Visual: line, no architect, spinoff, omnislash, ob command or AGENTS.md). The
//     repo is told by its origin url; one with no origin cannot be told apart and is not checked unless
//     `--clean` says so. The diff itself is never read.

export interface Revert {
  commit: string;
  subject: string;
  paths: string[];
}

export interface GuardReport {
  ok: boolean;
  head: string;
  against: string;
  /** Paths the land changes on `against`. For a squash, those that differ from it AND changed since the merge base (OB-2176). */
  changed: string[];
  /** Paths that differ from `against` only because `against` changed them after the fork (OB-2176); not checked. */
  mainOnly: number;
  reverts: Revert[];
  /** Paths outside the builder's own diff; empty unless `branch` was given. */
  outside: string[];
  /** The fork point the scope check measured from, when one was used. */
  base: string | null;
  /** The land commit's subject against the Conventional Commits rule (1666). */
  subject: SubjectCheck;
  /** OB-1992: whether the repo is a clean one (not OmniSlash), and what of ob its squash subject and body carry. */
  clean: boolean;
  leaks: { where: string; leaks: Leak[] }[];
}

export interface GuardOptions {
  repo: string;
  /** The commit about to be pushed. Default HEAD. */
  head?: string;
  /** What it is pushed onto. Default origin/main. */
  against?: string;
  /** The builder's branch; turns the scope check on. */
  branch?: string;
  /** OB-2176: the land is a three-way squash (a PR merge), so paths only `against` changed since the fork are
   * not checked. Default: on when `branch` is given; off for a plain push, which replaces main's tree. */
  squash?: boolean;
  /** Fork point for the scope check; default merge-base(against, branch). */
  base?: string;
  /** How many commits of `against` history to test for reverts. Default 100. */
  depth?: number;
  /** Commits whose reversal is intended (shas or prefixes). */
  allowRevert?: string[];
  /** The subject the land will carry, when it is not `head`'s own (a `gh pr merge --subject`). */
  subject?: string;
  /** The squash body the land will carry (`gh pr merge --body`); default `head`'s own body. */
  body?: string;
  /** OB-1992: force the clean-repo check on (true) or off (false); default: the origin url says. */
  clean?: boolean;
  /** The `ob project` ref keys (`OB,PS`), so a ref is told from `UTF-8`; without them any `[A-Z]{2,4}-<n>`. */
  keys?: string[];
}

/** Is `repo` a clean one (OB-1992)? Told by its origin url; no origin means it cannot be told, so not checked. */
function isCleanCheckout(repo: string): boolean {
  const origin = gitOrNull(repo, ["remote", "get-url", "origin"]);
  return origin !== null && !isObRepo(origin);
}

const ZERO = /^0+$/;

function git(repo: string, args: string[]): string {
  const p = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (p.status !== 0) throw new Error(`git ${args.join(" ")}: ${(p.stderr || p.error?.message || "failed").trim()}`);
  return p.stdout;
}

function gitOrNull(repo: string, args: string[]): string | null {
  try {
    return git(repo, args).trim() || null;
  } catch {
    return null;
  }
}

function nameOnly(repo: string, a: string, b: string): string[] {
  return git(repo, ["diff", "--name-only", "--no-renames", "-z", a, b]).split("\0").filter(Boolean);
}

/** `git diff-tree --raw -z` for one commit: path -> [old blob | null, new blob | null]. */
function blobChanges(repo: string, commit: string): Map<string, [string | null, string | null]> {
  const out = git(repo, ["diff-tree", "-r", "--no-renames", "--root", "--no-commit-id", "--raw", "-z", commit]);
  const parts = out.split("\0");
  const m = new Map<string, [string | null, string | null]>();
  // Each entry is ":<mode> <mode> <oldsha> <newsha> <status>" NUL "<path>" NUL.
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i]!.split(" ");
    const oldSha = meta[2] ?? "";
    const newSha = meta[3] ?? "";
    m.set(parts[i + 1]!, [ZERO.test(oldSha) ? null : oldSha, ZERO.test(newSha) ? null : newSha]);
  }
  return m;
}

export function checkLand(opts: GuardOptions): GuardReport {
  const { repo } = opts;
  const head = opts.head ?? "HEAD";
  const against = opts.against ?? "origin/main";
  const depth = opts.depth ?? 100;
  const allow = opts.allowRevert ?? [];
  const tooShort = allow.find((a) => a.length < 7);
  if (tooShort) throw new Error(`--allow-revert '${tooShort}' is too short to name a commit (7+ characters)`);

  // OB-2176: a PR squash is three-way from merge-base(against, head), so a path only `against` changed since
  // that fork keeps main's content; the head's pre-image there is not a revert. In squash mode (`--branch` or
  // `--squash`) only the paths the squash applies are checked: `all` ∩ diff(base, head) over every merge base
  // (criss-cross history has several; the union keeps the check the stricter one). A squash rebuilt on main's
  // tip (the 1636 shape) has main's tip as its merge base, so its stale paths stay in. A plain push (the
  // pre-push hook) replaces main's tree, so it keeps the full check, as does a head with no merge base.
  const all = nameOnly(repo, against, head);
  const squash = opts.squash ?? Boolean(opts.branch);
  const bases = squash ? (gitOrNull(repo, ["merge-base", "--all", against, head])?.split("\n").filter(Boolean) ?? []) : [];
  const applied = bases.length > 0 ? new Set(bases.flatMap((b) => nameOnly(repo, b, head))) : null;
  const changed = applied ? all.filter((p) => applied.has(p)) : all;
  const mainOnly = all.length - changed.length;
  const changedSet = new Set(changed);
  const blobAt = new Map<string, string | null>();
  const headBlob = (path: string): string | null => {
    if (!blobAt.has(path)) blobAt.set(path, gitOrNull(repo, ["rev-parse", "--verify", "-q", `${head}:${path}`]));
    return blobAt.get(path)!;
  };

  const base = opts.branch ? (opts.base ?? git(repo, ["merge-base", against, opts.branch]).trim()) : null;
  const own = opts.branch && base ? new Set(nameOnly(repo, base, opts.branch)) : new Set<string>();

  // Restoring an old blob is a strong signal. Merely deleting a file M added is weak (renames and cleanups do
  // it all the time), so those paths are listed only for a commit that is also strongly reverted.
  const reverts: Revert[] = [];
  const log = git(repo, ["log", "--no-merges", "-n", String(depth), "--format=%H%x09%s", against]);
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha = "", ...rest] = line.split("\t");
    if (allow.some((a) => sha.startsWith(a))) continue;
    const strong: string[] = [];
    const weak: string[] = [];
    for (const [path, [before, after]] of blobChanges(repo, sha)) {
      if (!changedSet.has(path) || before === after) continue;
      if (headBlob(path) !== before) continue;
      (before === null ? weak : strong).push(path);
    }
    if (strong.length > 0) reverts.push({ commit: sha, subject: rest.join("\t"), paths: [...strong, ...weak].sort() });
  }

  const outside = opts.branch ? changed.filter((p) => !own.has(p)) : [];
  const subjectText = opts.subject ?? git(repo, ["log", "-1", "--format=%s", head]).trim();
  const subject = checkSubject(subjectText);

  const clean = opts.clean ?? isCleanCheckout(repo);
  const leaks: GuardReport["leaks"] = [];
  if (clean) {
    const body = opts.body ?? git(repo, ["log", "-1", "--format=%b", head]);
    for (const [where, text] of [["subject", subjectText], ["body", body]] as const) {
      const hits = obLeaks(text, opts.keys ?? []);
      if (hits.length > 0) leaks.push({ where, leaks: hits });
    }
  }

  const ok = reverts.length === 0 && outside.length === 0 && subject.ok && leaks.length === 0;
  return { ok, head, against, changed, mainOnly, reverts, outside, base, subject, clean, leaks };
}

const SHOW = 12;
const short = (s: string) => s.slice(0, 8);

export function renderReport(r: GuardReport): string {
  if (r.ok) {
    const ok = `land guard: ok: ${r.changed.length} path(s) the land changes on ${r.against}, none undoes a recent commit${r.base ? ", all inside the builder's diff" : ""}${r.mainOnly > 0 ? `, ${r.mainOnly} path(s) only main changed, not the PR's` : ""}, subject is a Conventional Commit${r.clean ? ", nothing of ob in the subject or body" : ""}`;
    return r.subject.warning ? `${ok}\n  warning: ${r.subject.warning}` : ok;
  }
  const lines = [`land guard: REFUSED — ${r.head} cannot land on ${r.against}. Do not push.`];
  if (!r.subject.ok) {
    lines.push(`  subject "${r.subject.subject}" is not a Conventional Commit: ${r.subject.reason}.`);
    lines.push("  Fix: amend it (`git commit --amend`), or pass a conforming `--subject \"<type>(PS-12): <subject>\"` for a PR squash, then rerun the guard.");
  }
  if (r.leaks.length > 0) {
    lines.push("  this is a clean repo (not OmniSlash), and the squash carries ob:");
    for (const l of r.leaks) lines.push(...renderLeaks(l.where, l.leaks).map((x) => `  ${x}`));
    lines.push("  Fix: a `<type>(<area>): <subject>` subject with no ref and a plain body (`--subject`, `--body`), then rerun the guard.");
  }
  for (const v of r.reverts) {
    lines.push(`  reverts ${short(v.commit)} ${v.subject}`);
    for (const p of v.paths.slice(0, SHOW)) lines.push(`    ${p}`);
    if (v.paths.length > SHOW) lines.push(`    … ${v.paths.length - SHOW} more`);
  }
  if (r.outside.length > 0) {
    lines.push(`  touches ${r.outside.length} path(s) outside the builder's own diff (${short(r.base ?? "")}..branch):`);
    for (const p of r.outside.slice(0, SHOW)) lines.push(`    ${p}`);
    if (r.outside.length > SHOW) lines.push(`    … ${r.outside.length - SHOW} more`);
  }
  if (r.reverts.length > 0 || r.outside.length > 0) lines.push(
    "  cause: a squash taken from a tree older than origin/main (`git reset --soft main` in the builder worktree,",
    "  a hand-rolled commit-tree, `checkout <branch> -- .`). Redo it from origin/main: `git rebase origin/main`",
    "  for a PR branch, or a fresh worktree and `git merge --squash <branch>`. If the revert is intended, pass",
    "  --allow-revert <sha>.",
  );
  return lines.join("\n");
}

export function parseArgs(argv: string[]): GuardOptions {
  const o: GuardOptions = { repo: process.cwd(), allowRevert: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${a} needs a value`);
      return x;
    };
    if (a === "--repo") o.repo = v();
    else if (a === "--head") o.head = v();
    else if (a === "--against") o.against = v();
    else if (a === "--branch") o.branch = v();
    else if (a === "--base") o.base = v();
    else if (a === "--depth") o.depth = Number(v());
    else if (a === "--subject") o.subject = v();
    else if (a === "--body") o.body = v();
    else if (a === "--body-file") o.body = readFileSync(v(), "utf8");
    else if (a === "--keys") o.keys = v().split(",").map((k) => k.trim()).filter(Boolean);
    else if (a === "--clean") o.clean = true;
    else if (a === "--squash") o.squash = true;
    else if (a === "--allow-revert") o.allowRevert!.push(...v().split(",").filter(Boolean));
    else throw new Error(`unknown argument '${a}'`);
  }
  return o;
}

if (import.meta.main) {
  try {
    const report = checkLand(parseArgs(process.argv.slice(2)));
    const out = renderReport(report);
    if (report.ok) console.log(out);
    else console.error(out);
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    console.error(`land guard: could not check — ${(e as Error).message}`);
    process.exit(2);
  }
}

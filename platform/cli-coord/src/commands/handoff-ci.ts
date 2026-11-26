/**
 * OB-2044: a builder hands off only once its PR's CI passes.
 *
 * `assertHandoffCi` is the ONE guard both handoff paths call (the local command in `spinoff.ts` and the API
 * client in `spinoff-client.ts`), after the worktree checks and before the stamp. It reads the branch's OPEN
 * PR and its check rollup with `gh pr list`, through an injected shell seam, so the rules are testable with a
 * fake `gh` and nothing here forks a real process.
 *
 * The rules (the ticket's design calls):
 *  - no open PR for the branch (OS-211): a branch with no commit past main (a scan or a measurement, whose answer is
 *    its note) hands off with nothing to merge; a branch with commits is refused, open the PR first; a count git
 *    could not read refuses as `COULD NOT READ CI`. A spike never reaches this guard (it opens no PR for code);
 *  - the PR head is not the worktree HEAD: refuse, push first;
 *  - any check failing (a conclusion other than success, skipped or neutral): refuse, naming each with its link;
 *  - any check pending, or no checks yet while the repo has a workflow that runs on `pull_request`: refuse, wait;
 *  - `gh` cannot be read: refuse with `COULD NOT READ CI`. A read failure is never green;
 *  - a pending PixelSlash status (OB-2544) waits on a human review, not a runner: it is neither waited on nor a
 *    failure, and the result names it as `PixelSlash review owed: <status> <link>`. A failed or errored one still
 *    refuses (a broken upload). The rule is written once for agents in skills/ob-babysit-pr/SKILL.md
 *    ("PixelSlash is a review, not CI"); `pr-wait` in that skill applies the same rule.
 *  - `--ci-unchecked '<why>'` skips the read and returns the reason for the trail and the readying note.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type ShResult = { ok: boolean; err: string; out?: string };
type ShFn = (cmd: string[], cwd?: string, timeoutMs?: number) => ShResult;

/** One check on a PR, normalised from GitHub's CheckRun and StatusContext shapes. */
export interface CiCheck {
  name: string;
  state: "pass" | "fail" | "pending";
  /** The conclusion or state GitHub reported, lower-cased (`failure`, `in_progress`, ...). */
  detail: string;
  url: string | null;
}

/** What the guard concluded. `line` goes on the trail and in the readying note; null when there was nothing to say. */
export interface HandoffCiResult {
  /** `checked`: a green PR. `no-commits`: no open PR and no commit past main, so nothing to merge (OS-211). `no-checks`: a PR, and the repo runs no CI on it. `unchecked`: overridden. `not-read`: the caller skipped the guard (a spike, a gone worktree, a quiet repeat). */
  kind: "checked" | "no-commits" | "no-checks" | "unchecked" | "not-read";
  line: string | null;
  /** OB-2544: one `PixelSlash review owed: ...` line per pending PixelSlash status; also folded into `line`. */
  owed?: string[];
}

/**
 * OB-2544: is this check a PixelSlash visual status? Its context is `PixelSlash`, or starts with it
 * (`PixelSlash / hackcove-ui-actions`). Pure.
 */
export function isPixelSlashCheck(name: string): boolean {
  return /^pixelslash\b/i.test(name.trim());
}

/** The line that names a PixelSlash review still owed, so the architect sees it. Colons and `;` are flattened
 * past the label, so it never reads as another label or segment of the one-line readying note. Pure. */
function pixelSlashOwedLine(check: CiCheck, prUrl?: string | null): string {
  const flat = (s: string) => s.replace(/;/g, ",").replace(/\s*:\s*/g, " ").trim();
  const link = check.url ?? prUrl ?? null;
  return `PixelSlash review owed: ${flat(check.name)}${link ? ` ${link}` : ""}`;
}

const PASSING = new Set(["success", "skipped", "neutral"]);
const FAILING_STATUS_CONTEXT = new Set(["failure", "error"]);
const PENDING_STATUS_CONTEXT = new Set(["pending", "expected"]);

/** Read one entry of `statusCheckRollup`. Pure. */
export function normaliseCheck(raw: unknown): CiCheck {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  if (str(r.__typename) === "StatusContext" || (r.context !== undefined && r.name === undefined)) {
    // A commit status: `state` is SUCCESS | PENDING | FAILURE | ERROR | EXPECTED.
    const state = str(r.state).toLowerCase();
    return {
      name: str(r.context) || "(unnamed status)",
      state: state === "success" ? "pass" : FAILING_STATUS_CONTEXT.has(state) ? "fail" : PENDING_STATUS_CONTEXT.has(state) || state === "" ? "pending" : "fail",
      detail: state || "unknown",
      url: str(r.targetUrl) || null,
    };
  }
  // A check run: `status` is QUEUED | IN_PROGRESS | COMPLETED (and others), `conclusion` is set once COMPLETED.
  const status = str(r.status).toLowerCase();
  const conclusion = str(r.conclusion).toLowerCase();
  const name = str(r.name) || "(unnamed check)";
  const url = str(r.detailsUrl) || null;
  if (status !== "completed") return { name, state: "pending", detail: status || "unknown", url };
  if (PASSING.has(conclusion)) return { name, state: "pass", detail: conclusion, url };
  return { name, state: "fail", detail: conclusion || "no conclusion", url };
}

/**
 * Does the checkout carry a workflow that runs on pull requests, so a PR with no checks has simply not
 * reported yet? Reads the `on:` trigger of each workflow: `pull_request` (or `pull_request_target`), filtered or not. A
 * filter (`paths`, `branches`, `types`) may mean it never runs for this PR, but that is an unknown, and an unknown
 * refuses: `--ci-unchecked` is the exit for a filtered workflow that really does not apply.
 * Throws when a workflow cannot be read or parsed: an unknown is never "no CI", so the guard refuses on it.
 */
export function repoRunsCiOnPullRequests(worktree: string): boolean {
  const dir = join(worktree, ".github", "workflows");
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f))) {
    const doc = Bun.YAML.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown> | null;
    // YAML 1.1 reads a bare `on` as true; Bun keeps the string, but accept both.
    const on = doc?.on ?? doc?.["true"];
    for (const event of ["pull_request", "pull_request_target"]) {
      if (typeof on === "string" ? on === event : Array.isArray(on) ? on.includes(event) : on && typeof on === "object" && event in on) return true;
    }
  }
  return false;
}

const short = (sha: string): string => sha.slice(0, 7);

/** The `ci:` line for a green PR: `ci: gate pass, ui-review pass on abc1234`. Pure. */
export function ciLine(checks: readonly CiCheck[], headSha: string): string {
  // A colon in a check name is dropped so the segment can never read as another `label:` (the readying note's
  // review line is found by a `review:` label in the same one-line note).
  return `ci: ${checks.map((c) => `${c.name.replace(/\s*:\s*/g, " ")} ${c.detail === "success" ? "pass" : c.detail}`).join(", ")} on ${short(headSha)}`;
}

/** Thrown-by-the-caller messages. Kept here so the wording is one place. */
export const COULD_NOT_READ_CI = "COULD NOT READ CI";

export interface HandoffCiInput {
  worktree: string;
  branch: string;
  /** The worktree's HEAD for the branch (full sha), or null when git could not say. */
  headSha: string | null;
  /** The `--ci-unchecked` reason, when passed. */
  unchecked?: string | null;
  /** OS-211: the branch's commits past main, read only when it has no open PR; null when git could not count them. */
  commitsPastMain: () => number | null;
  sh: ShFn;
}

/**
 * Run the guard. Returns the result on a pass; throws `Error` (the caller wraps it in its own AppError type via
 * the `fail` callback) with the refusal text on anything else. Nothing is stamped before this returns.
 */
export function assertHandoffCi(input: HandoffCiInput, fail: (message: string) => Error): HandoffCiResult {
  const why = input.unchecked?.replace(/\s+/g, " ").trim();
  if (input.unchecked !== undefined && input.unchecked !== null) {
    if (!why) throw fail("--ci-unchecked needs a reason: --ci-unchecked '<why CI cannot be read or waited for>'");
    // `;` and `:` would let the reason read as another segment or label of the one-line readying note (a forged
    // `skeptical-review: ...`), so they are flattened.
    return { kind: "unchecked", line: `ci: UNCHECKED (--ci-unchecked: ${why.replace(/;/g, ",").replace(/\s*:\s*/g, " ")})` };
  }
  const cannot = (reason: string): Error =>
    fail(
      [
        `${COULD_NOT_READ_CI}: ${reason}. Nothing was handed off.`,
        "CI is never assumed green. Fix gh (`gh auth status`), then hand off again; or, if CI cannot be read at all,",
        "`--ci-unchecked '<why>'` hands off and records the reason on the ticket and in the readying note.",
      ].join("\n"),
    );
  const r = input.sh(
    ["gh", "pr", "list", "--head", input.branch, "--state", "open", "--json", "number,url,headRefOid,statusCheckRollup"],
    input.worktree,
    30_000,
  );
  if (!r.ok) {
    // Only a successful, empty list proves there is no open PR; any gh failure is a failed read.
    throw cannot(`gh pr list failed (${(r.err ?? "").trim().split("\n")[0] || "no output"})`);
  }
  let prs: Array<{ number?: number; url?: string; headRefOid?: string; statusCheckRollup?: unknown }>;
  try {
    const parsed = JSON.parse(r.out ?? "");
    if (!Array.isArray(parsed)) throw new Error("not a list");
    if (parsed.some((e) => e === null || typeof e !== "object" || Array.isArray(e))) throw new Error("not PR objects");
    prs = parsed;
  } catch {
    throw cannot("gh pr list printed something that is not a JSON list of PRs");
  }
  if (prs.length === 0) return noPr(input, fail, cannot);
  // `gh pr list --head` matches by branch name, so more than one open PR can come back: every one must pass.
  const results = prs.map((pr) => checkPr(pr, input, fail, cannot));
  // One PR reports its own line; several report each, so the trail never names just the first.
  if (results.length === 1) return results[0]!;
  const owed = results.flatMap((r) => r.owed ?? []);
  return { kind: results[0]!.kind, line: results.map((r) => r.line).filter(Boolean).join("; ") || null, ...(owed.length > 0 ? { owed } : {}) };
}

/** The text a branch with no open PR and no commit past main hands off with (OS-211). */
export const NO_COMMITS_LINE = "ci: none (no commit past main and no PR: nothing to merge)";

/**
 * OS-211: the branch has no open PR. A build with commits must open one first (the architect merges a PR, never a
 * bare branch); a run with no commit past main (a scan, a measurement) has nothing to merge and hands off. Throws
 * the refusal; returns the pass.
 */
function noPr(input: HandoffCiInput, fail: (message: string) => Error, cannot: (reason: string) => Error): HandoffCiResult {
  const n = input.commitsPastMain();
  if (n === null) throw cannot(`${input.branch} has no open PR, and git could not count its commits past main`);
  if (n === 0) return { kind: "no-commits", line: NO_COMMITS_LINE };
  throw fail(
    `${input.branch} has ${n} commit(s) past main and no open PR: a build hands off through its PR. ` +
      "Push the branch and open it (`gh pr create --base main`), wait for CI, then hand off again. Nothing was handed off.",
  );
}

/** One open PR against the worktree HEAD. Throws the refusal; returns the pass. */
function checkPr(
  pr: { number?: number; url?: string; headRefOid?: string; statusCheckRollup?: unknown },
  input: HandoffCiInput,
  fail: (message: string) => Error,
  cannot: (reason: string) => Error,
): HandoffCiResult {
  const n = pr.number ?? 0;
  const prHead = String(pr.headRefOid ?? "");
  if (!/^[0-9a-f]{40}$/.test(prHead)) throw cannot(`PR #${n} reported no head commit`);
  if (!input.headSha) throw cannot(`git could not read the HEAD of ${input.branch}, so it cannot be compared with PR #${n}`);
  if (prHead !== input.headSha) {
    throw fail(`PR #${n} head is ${short(prHead)}, your HEAD is ${short(input.headSha)}: the two differ: push (or pull, if the PR is ahead) so they match, wait for CI, then hand off again (a PR from a fork with the same branch name also lands here: \`--ci-unchecked '<why>'\` hands off anyway). Nothing was handed off.`);
  }
  // `gh` prints `[]` for a PR with no checks; a missing or non-list field is an unreadable answer, never "no CI".
  if (!Array.isArray(pr.statusCheckRollup)) throw cannot(`PR #${n} came back with no statusCheckRollup list`);
  const all = pr.statusCheckRollup.map(normaliseCheck);
  // OB-2544: a pending PixelSlash status is a human review the architect owes, not CI still running.
  const owedChecks = all.filter((c) => c.state === "pending" && isPixelSlashCheck(c.name));
  const owed = owedChecks.map((c) => pixelSlashOwedLine(c, pr.url));
  const rollup = all.filter((c) => !owedChecks.includes(c));
  const withOwed = (r: HandoffCiResult): HandoffCiResult =>
    owed.length === 0 ? r : { ...r, line: [r.line, ...owed].filter(Boolean).join("; "), owed };
  const failing = rollup.filter((c) => c.state === "fail");
  if (failing.length > 0) {
    throw fail(
      [
        `CI is failing on PR #${n} (${short(prHead)}). Nothing was handed off:`,
        ...failing.map((c) => `  ${c.name}: ${c.detail}${c.url || pr.url ? ` ${c.url ?? pr.url}` : ""}`),
        "Fix it on the branch and push, or report a flake (ob-spinoff section 3). A failing check is never handed off.",
      ].join("\n"),
    );
  }
  const pending = rollup.filter((c) => c.state === "pending");
  if (pending.length > 0) {
    throw fail(`CI still running on ${short(prHead)}: ${pending.map((c) => c.name).join(", ")}. Wait with \`~/.claude/skills/ob-babysit-pr/scripts/pr-wait ${n} --until green\` (it skips a pending PixelSlash review), then hand off. Nothing was handed off.${owed.length > 0 ? ` (A pending PixelSlash review is not waited on: ${owed.join("; ")}.)` : ""}`);
  }
  if (rollup.length === 0) {
    let runsCi: boolean;
    try {
      runsCi = repoRunsCiOnPullRequests(input.worktree);
    } catch (e) {
      throw cannot(`the workflows under .github/workflows could not be read (${e instanceof Error ? e.message : String(e)}), so it is unknown whether this repo runs CI on pull_request`);
    }
    if (runsCi) {
      throw fail(`CI has not reported on PR #${n} (${short(prHead)}) yet, and this repo runs workflows on pull_request. Wait with \`~/.claude/skills/ob-babysit-pr/scripts/pr-wait ${n} --until green\` (it skips a pending PixelSlash review), then hand off (a workflow filtered by paths that never applies to this PR: \`--ci-unchecked '<why>'\`). Nothing was handed off.`);
    }
    return withOwed({ kind: "no-checks", line: `no CI checks on PR #${n}` });
  }
  return withOwed({ kind: "checked", line: ciLine(rollup, prHead) });
}

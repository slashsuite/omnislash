// OB-1992: a CLEAN repo is every repo that is not ob's own. ob is private, so a clean repo's PR title, body,
// branch name, commits and squash commit carry nothing of ob: no ticket ref, no `State:`/`Gate:`/`Visual:`
// line, no planner, architect, sentinel, muse, spinoff or omnibus, no `ob` command, no pointer to the private AGENTS.md. OmniSlash keeps
// its own flow (refs, `State:` in git, the commit hook).
//
// Everything here is pure: no git, no store, no network. The callers bring the facts.

import { STATE_VERDICT_TOKENS } from "./spinoff-vocab.ts";

/** The repos that are ob's own: OmniSlash, and omnibus while it keeps ob's way of working (OS-65). */
const OB_REPOS = new Set(["omnislash", "omnibus"]);

/**
 * Is this repo ob's own? Takes a project id, a repo slug (`omnislash`, `org/omnislash`), a checkout path
 * (`/home/x/dev/omnislash`), a `wt` worktree path (`/home/x/dev/omnislash.ob-12`) or a remote url
 * (`git@github.com:x/omnislash.git`). True for OmniSlash and omnibus; every other repo is clean.
 */
export function isObRepo(repo: string | null | undefined): boolean {
  if (!repo) return false;
  const last = repo.trim().replace(/[/\\]+$/, "").split(/[/\\:]/).filter(Boolean).pop() ?? "";
  const name = last.replace(/\.git$/, "").split(".")[0] ?? "";
  return OB_REPOS.has(name.toLowerCase());
}

/** The longest branch name a clean repo's slug takes, suffix included. */
export const BRANCH_SLUG_MAX = 40;

/** Words a branch slug drops, so the name cannot itself carry ob. */
/** `planner` stays beside the team roles (OB-2256): it is ob's old name for the architect, still ob's word. */
const SLUG_DROP = new Set(["ob", "planner", "architect", "sentinel", "muse", "spinoff", "spinoffs", "omnibus", "agents"]);

/**
 * A clean repo's branch name from the ticket TITLE (OB-1992): lowercase words joined by hyphens, at most `max`
 * characters, cut at a word boundary. A ref (`PS-12`) and ob's own words are dropped. Pure.
 */
export function branchSlug(title: string, max = BRANCH_SLUG_MAX): string {
  const words = title
    .replace(/\b[A-Za-z]{2,4}-\d+\b/g, " ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !SLUG_DROP.has(w));
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > max) {
      if (!out) out = w.slice(0, max);
      break;
    }
    out = next;
  }
  return out || "change";
}

/**
 * The first free name for `base`: itself, then `base-2`, `base-3`, … within `max` characters (the base is cut
 * to make room for the suffix). `taken` answers whether a name is in use locally or on the remote. Pure.
 */
export function uniqueBranch(base: string, taken: (name: string) => boolean, max = BRANCH_SLUG_MAX): string {
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const head = base.slice(0, max - suffix.length).replace(/-+$/, "");
    const name = `${head}${suffix}`;
    if (!taken(name)) return name;
  }
  throw new Error(`no free branch name for '${base}'`);
}

/** One hit of `obLeaks`: what matched, and the kind of leak it is. */
export interface Leak {
  kind: "ref" | "state-line" | "ob-command" | "word";
  match: string;
}

/** Prefixes that look like a ref but are standards or hashes, used only when no project keys are given. */
const NOT_A_REF = new Set(["UTF", "SHA", "ISO", "RFC", "CVE", "PEP", "TLS", "ES", "HTTP", "MD", "UTC", "GMT", "IEC"]);

/**
 * What of ob a clean repo's text carries (OB-1992). `keys` are the `ob project` keys (`OB`, `PS`, …); with
 * them a ref is `<KEY>-<n>` for one of those keys, without them any `[A-Z]{2,4}-<n>` that is not a known
 * standard (`UTF-8`, `SHA-256`). Flags a ref, a `State:`/`Gate:`/`Visual:` line, the word `ob` (alone or as
 * `ob <subcommand>`), the team roles (architect, sentinel, muse) and the old planner, spinoff, omnibus, AGENTS.md. Empty for a plain open-source PR body. Pure.
 */
export function obLeaks(text: string, keys: readonly string[] = []): Leak[] {
  const leaks: Leak[] = [];
  const seen = new Set<string>();
  const add = (kind: Leak["kind"], match: string) => {
    const k = `${kind}:${match}`;
    if (seen.has(k)) return;
    seen.add(k);
    leaks.push({ kind, match });
  };
  const keySet = new Set(keys.map((k) => k.toUpperCase()));
  for (const m of text.matchAll(/\b([A-Z]{2,4})-(\d+)\b/g)) {
    const prefix = m[1]!;
    if (keySet.size > 0 ? keySet.has(prefix) : !NOT_A_REF.has(prefix)) add("ref", m[0]);
  }
  for (const m of text.matchAll(/^[ \t>*-]*(State|Gate|Visual):/gm)) add("state-line", `${m[1]}:`);
  for (const m of text.matchAll(/(?<![\w./-])ob(?:\s+[a-z][\w-]*)?(?![\w./-])/g)) {
    add(/\s/.test(m[0]) ? "ob-command" : "word", m[0].replace(/\s+/g, " "));
  }
  for (const m of text.matchAll(/\b(planners?|architects?|sentinels?|muses?|spinoffs?|omnibus)\b|AGENTS\.md/gi)) add("word", m[0]);
  return leaks;
}

/** One line per leak, for a refusal. */
export function renderLeaks(where: string, leaks: Leak[]): string[] {
  return leaks.map((l) => `  ${where}: ${l.kind} '${l.match}'`);
}

/** A clean repo's recorded verdict (OB-1992): the row's columns. */
export interface RowVerdict {
  repo: string;
  verdict?: string | null;
  verdict_reason?: string | null;
  gate_line?: string | null;
}

/** The verdict words `ob spinoff state` takes (the pre-1513 `ready` stays an input alias of landable). */
const RECORDABLE_VERDICTS = STATE_VERDICT_TOKENS.filter((t) => t !== "ready");

/**
 * A recorded verdict as the `State:` paragraph every reader already parses (the one git would carry: the State
 * line, then the Gate line), or null when none is recorded. Pure.
 */
export function rowStateText(row: RowVerdict): string | null {
  if (!row.verdict) return null;
  const reason = oneLine(row.verdict_reason);
  const gate = oneLine(row.gate_line);
  const state = reason ? `State: ${row.verdict} - ${reason}` : `State: ${row.verdict}`;
  return gate ? `${state}\nGate: ${gate}` : state;
}

function oneLine(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** A `ob spinoff state` verdict word, checked; anything else is a usage error naming the four. Pure. */
export function parseRecordableVerdict(word: string): string {
  const w = word.trim().toLowerCase();
  if (!(RECORDABLE_VERDICTS as readonly string[]).includes(w)) {
    throw new RangeError(`'${word}' is not a verdict: use one of ${RECORDABLE_VERDICTS.join(", ")}`);
  }
  return w;
}

/**
 * THE verdict of a row (OB-1992), for every reader: the gateable list, the handoff, the readying note, the
 * API client. A clean repo's recorded verdict wins; omnislash, and a clean-repo row that recorded none (a build
 * dispatched before 0040), read the `State:` line in git through `readGit`.
 */
export function verdictStateFor(row: RowVerdict, readGit: () => string | null): string | null {
  if (!isObRepo(row.repo)) {
    const recorded = rowStateText(row);
    if (recorded) return recorded;
  }
  return readGit();
}

/** The ticket ref as a local key (`PS-12` → `ps-12`): a clean repo's worktree suffix and builder id. Pure. */
export function refKey(ticketRef: string): string {
  // A bare `#<n>` issue ref has no project key: name it `issue-<n>`, never `-<n>` (a leading dash reads as a flag).
  const issue = /^#(\d+)$/.exec(ticketRef.trim());
  if (issue) return `issue-${issue[1]}`;
  return ticketRef.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

/**
 * The builder's registry id for a row (OB-1992): the recorded `agent_id`, else the branch in OmniSlash (where the
 * branch is the ref) and the ref in a clean repo, whose branch is a title slug. Local, so it keeps the ref. Pure.
 */
export function builderIdOf(row: { agent_id?: string | null; branch: string; repo: string; ticket_ref: string; trial_leg?: string | null }): string {
  if (row.agent_id) return row.agent_id;
  return isObRepo(row.repo) ? row.branch : refKey(legRef(row.ticket_ref, row.trial_leg));
}

/** OB-1991: `<ref>-b` for a trial's leg b, the ref itself otherwise. Leg b's branch, worktree, builder id and
 *  `ticket:` lease all carry the suffix, so the two legs of a pair never share a name. Pure. */
export function legRef(ref: string, leg: string | null | undefined): string {
  return leg === "b" ? `${ref}-b` : ref;
}

/** The one line a clean repo's launch prompt carries, so a builder that skips the skill still sees the rule. */
export function cleanRepoLaunchLine(ticketRef: string): string {
  return (
    `Clean repo (not OmniSlash): nothing of ob goes in this repo's PR title, body, branch or commits. No ticket ref, no State:/Gate:/Visual: line, no architect, sentinel, muse, spinoff, omnibus, ob command or AGENTS.md. ` +
    `Subjects are \`<type>(<area>): <subject>\`. Record the verdict with \`ob spinoff state ${ticketRef} <landable|needs-human|blocked|partial> --reason '<one line>' --gate '<gate line>'\`, ` +
    `and put the Done check and skeptical review on the ticket with \`ob spinoff handoff ${ticketRef} --report <file>\`. Your builder id is \`${refKey(ticketRef)}\`.`
  );
}

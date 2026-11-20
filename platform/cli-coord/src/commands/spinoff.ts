import { defineSeam } from "../../../../apps/cli/src/test-seams.ts";
import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, dirname, basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, writeSync, closeSync, statSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Ctx } from "../../../../apps/cli/src/ctx.ts";
import { UsageError, AppError } from "../../../../apps/cli/src/errors.ts";
import { sendRoleMessage } from "../../../../apps/cli/src/inbox.ts";
import { print, warn } from "../../../../apps/cli/src/output.ts";
import { nowIso } from "../../../../apps/cli/src/db.ts";
import { getConfig, setConfig } from "../../../../apps/cli/src/config.ts";
import {
  setting,
  settingFor,
  effectiveOpencodeArchitectCmd,
  effectiveOpencodeSpinoffAgentCmd,
  LEGACY_OPENCODE_SPINOFF_AGENT_CMDS,
} from "../../../../apps/cli/src/settings.ts";
import { registerAgent, listAgents, getAgent } from "../agent.ts";
import { finishAgent } from "../agent-register.ts";
import { plannedFilesFor, readCheckInput, recordSpinoffCheck, type CheckResult, refuseUncheckedDispatch, renderCheckResult } from "../spinoff-check.ts";
import { compareFiles, filesLine, type FilesComparison } from "../spinoff-files.ts";
import { stateDisplayLines } from "../spinoff-state-reason.ts";
import { BRANCH_SLUG_MAX, branchSlug, builderIdOf, cleanRepoLaunchLine, isObRepo, legRef, obLeaks, parseRecordableVerdict, refKey, renderLeaks, rowStateText, uniqueBranch, verdictStateFor, type Leak, type RowVerdict } from "../clean-repo.ts";
import { IN_FLIGHT, STATE_VERDICT_TOKENS, spinoffStatusWord, toStoredSpinoffStatus, withStatusWord } from "../spinoff-vocab.ts";
import {
  acquireLeases,
  foreignHold,
  formatHold,
  heartbeatOrReacquire,
  holderRemedy,
  leaseHolderId,
  leaseKeyClass,
  listLeasesByHolder,
  liveHold,
  recordedHold,
  releaseLease,
  releaseLeasesByHolder,
  ticketLeaseKey,
  worktreeLeaseKey,
  type LeaseHold,
} from "../lease.ts";
import { isHop, shellWords, splitPartialFailure, SPINOFF_SUBCOMMANDS, type RemoteWriter } from "../../../../apps/cli/src/remote.ts";
import { expandHome } from "../../../../apps/cli/src/net.ts";
import { installOpencodeWiring, rulesBlock } from "../../../../apps/cli/src/repo-private.ts";
import { asStore, SQLITE_ESCAPE_HATCH, STORE_ENV, type Store } from "../../../../apps/cli/src/db/store.ts";
import { deriveBranch, fetchIssue, parseIssueRef, type FetchedIssue } from "../../../../apps/cli/src/github-issues.ts";
import { getItem, getTags, getTagsSync } from "../../../../apps/cli/src/items.ts";
import { isTeamRoleAgent, listTeams, storeTeamOf, teamHandoffTarget, teamMembersIn } from "../../../../apps/cli/src/team.ts";
import { PRIORITY_URGENT } from "../../../../apps/cli/src/priority.ts";
import { getProject, listProjects } from "../../../../apps/cli/src/project.ts";
import { equivalentRefs, normalizeRef } from "../../../../apps/cli/src/refs.ts";
import { decisionOptsOf, recordDecision, type DecisionOpts } from "../../../../apps/cli/src/decisions.ts";
import {
  gitLog,
  mainRefFor as sharedMainRefFor,
  itemForIssue,
  sqliteItemForIssue,
  sqliteTrackerRepo,
  trackerRepo,
  landingCommitFor,
  workHasLanded,
  type Commit,
} from "../../../../apps/cli/src/tracker-link.ts";
import { activeProfile } from "../../../../apps/cli/src/models-file.ts";
import { launchAcrossProfiles, modelsFileOrRefuse, relaunchOnCreditFailure, withProfileTiers } from "../spinoff-credit.ts";
import { readSpinoffTokens, readOpencodeSpinoffTokens, readRowTokens, tokensForRow, type TokenReader, formatTokens, rootOpencodeSessionId, tokenSourceFor, type TokenUsage } from "../spinoff-tokens.ts";
import { parseSince, reportMix } from "../spinoff-mix.ts";
import { abandonSpinoff, renderAbandon, type AbandonDeps } from "../spinoff-abandon.ts";
import { assertSpikeDocsOnly, formatSpikeReport, isSpikeTagged, spikeEndError } from "../spinoff-spike.ts";
import { renderSendBack, sendBackSpinoff, type SendBackDeps } from "../spinoff-sendback.ts";
import { renderReopen, reopenSpinoff, type ReopenDeps } from "../spinoff-reopen.ts";
import { isLandable, noteErrorLine, reportGateable, type GateableFacts, type GateableSource, type PlannedFiles } from "../spinoff-gateable.ts";
import {
  DEFAULT_SPINOFF_TIER,
  T3_LAUNCHER,
  effortRejection,
  isSpinoffEffort,
  refuseUnusableEffort,
  withOpusHighNote,
  opusHighAskOf,
  refuseOpusHigh,
  refuseOpusHighTrial,
  refuseRaisedOpusHigh,
  announceReadyNote,
  isSpinoffTier,
  parseTierModels,
  tierFitLine,
  tierFitOf,
  tierRejection,
  frontmatterField,
  launchT3Spinoff,
  reconcileT3Runs,
  renderReadyNoteOutcome,
  storeAgentRegistry,
  storeT3HoldProbe,
  canonicalPath,
  stopThreadOverT3,
  refuseUnregisteredT3Project,
  t3Seam,
  ticketFilePath,
  worktreeRepoOf,
  type ReadyNoteOutcome,
  type SpinoffEffort,
  type SpinoffTier,
  type TierFitRating,
  type T3MirrorEntry,
  type T3MirrorSkip,
} from "../../../../apps/cli/src/t3/dispatch.ts";
// The ob item a spinoff ref serves (1163) lives in its own module: this file imports the dispatcher and
// the dispatcher resolves rows through the same helper, so importing it here would close a cycle back
// into this file (measured: it makes T3_LAUNCHER a use-before-init at load time).
import { FLAKE_BOX_MARKER, FLAKE_SLOT_KEY, FLAKE_SLOT_TTL_S, flakeBoxParagraph, flakeBoxPresent, flakeSlotHeldMessage, flakeSlotKeyFor, flakeSlotRefFor, noFlakeBoxWarning, recordNoFlakeSlot, refuseHeldFlakeSlot, ticketIsFlake, withFlakeParagraph } from "../spinoff-flake.ts";
import { collidingRefWarning, dispatchRefFor, refuseAmbiguousDispatchRef, rowItemId, spinoffRowsServingItem, ticketItemIdFor } from "../spinoff-item.ts";
import { attachLegs, dispatchTrialPair, legBranch, noteLegHandoff, openPairs, noteLegSendback, noteTrialLanded, openPair, runTrialOp, trialPlanFor, voidPair, type TrialDeps } from "../spinoff-trial.ts";
import { gitLegDiff, liveFileIO, liveMeasureDeps, runTrialCli } from "../spinoff-trial-cli.ts";
import { abandonedError } from "../spinoff-abandon.ts";
import { assertHandoffCi, type HandoffCiResult } from "./handoff-ci.ts";

// Spinoff launch queue (055, launch path 1589): `ob spinoff <ref>` inserts a row and launches it in the
// same invocation (claim → T3 thread → stamp); `ob spinoff queue <ref>` only inserts, and a manual
// `ob spinoff drain` launches what is queued (no daemon runs it any more, 1589). It IS a DB queue (not a
// mere file drop) because claims are transactional (overlapping launches don't double-open) and the
// depth is inspectable. Drain launches every pending row that is not lease-blocked (#97) or launcher-not-
// ready (#118/#161). Agent count is not a reason to leave a row pending (ob 767, amends 560/024/
// 043/044): expired zombies do not occupy a launch slot, and `ob agent done` is not required to
// free the next tab. A BUILD agent's repo is derived by joining `agent.id` → `spinoff.agent_id`
// → `spinoff.repo` of its `launched` row (no repo column on `agent`).

export const SPINOFF_MODES = ["agent", "interactive"] as const;
export const AGENT_FLAG_GONE =
  "spinoff --agent is gone; spinoff is always interactive (bare ask; you steer; you declare done with ob spinoff handoff)";

export function rejectAgentFlag(agent: boolean | undefined): void {
  if (agent === true) throw new UsageError(AGENT_FLAG_GONE);
}

/**
 * The LAST-resort launch message (563): a pointer to the ticket, for a ref ob can find no work order for
 * at all. The ORDERED fallback chain lives in `spinoffAskFor`; this is the end of it, byte-for-byte what
 * every spinoff opened on before 1162.
 */
export function spinoffAsk(ticketRef: string): string {
  return `Read ${ticketRef}'s brief and implement per its acceptance criteria.`;
}

// --- the launch message (1162): the ticket's own brief, not a pointer to it ---------------------------
//
// Until 1162 the WHOLE launch message was `spinoffAsk`'s one line, so a fresh thread opened on "Read N's
// brief and implement per its acceptance criteria": to learn what the task IS you left the thread and
// opened `wayfinder/tickets/<ref>-*.md`, which is impossible from a phone. 1143 fixed the thread NAME;
// this is the same gap one level down. The message is now COMPOSED FROM THE TICKET: its `## What to
// build`, `## Acceptance` and `## Do not` sections — the work order — plus the short directive to run the
// spinoff skill. `## Context` / `## Work log` are the RECORD, not the order, and stay out.
//
// Two sources, each read where it lives (the split 217/353 already made): the ticket FILE is on the
// checkout, which the machine that ENQUEUES has; the ob ITEM is in the store. Order, most explicit first:
// a caller's `--brief`, then the ticket FILE, then the ob ITEM, then a `#<n>` issue's own head (221), then
// the unchanged pointer. It is the ASK, not a procedure (563): no gate list, no report-this-before-that —
// the builder still runs the spinoff skill, the architect still steers, the human still declares done.

/** The `##` sections a launch message inlines, in reading order. Everything else is the record (1162). */
const BRIEF_SECTIONS = ["What to build", "Acceptance", "Do not"] as const;

/**
 * How much ticket a launch message carries. A longer one is CUT at a line boundary and marked with the
 * source to read for the rest — never pasted whole into a prompt, never silently truncated mid-sentence.
 */
const BRIEF_MAX_CHARS = 20000;

/** One `##` section of a ticket file: its own heading text and its body. */
interface TicketSection {
  heading: string;
  body: string;
}

/** The `##` sections of a ticket file, in file order (`###` sub-headings stay inside their section). Pure. */
function ticketSections(text: string): TicketSection[] {
  const out: TicketSection[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  const flush = (): void => {
    if (heading !== null) out.push({ heading, body: body.join("\n").trim() });
  };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^##\s+(.+?)\s*$/);
    if (m) {
      flush();
      heading = m[1]!;
      body = [];
      continue;
    }
    if (heading !== null) body.push(line);
  }
  flush();
  return out;
}

/**
 * A ticket file's title: its frontmatter `title`, else its leading `# ` heading, else null. YAML-quoted
 * titles are unquoted and `\"` / `\\` unescaped, because the title is printed into a prompt and a reader
 * should not see the escaping. Pure.
 */
function ticketFileTitle(text: string): string | null {
  const fm = frontmatterField(text, "title");
  const title = (fm ?? text.match(/^#\s+(.+?)\s*$/m)?.[1] ?? "").trim();
  if (!title) return null;
  return title.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

/** Cut a work order to `BRIEF_MAX_CHARS` at a line boundary, marked with where the rest is. Pure. */
function cutBrief(work: string, rest: string): string {
  if (work.length <= BRIEF_MAX_CHARS) return work;
  const head = work.slice(0, BRIEF_MAX_CHARS);
  const at = head.lastIndexOf("\n");
  const kept = (at > 0 ? head.slice(0, at) : head).trimEnd();
  return `${kept}\n\n[cut at ${BRIEF_MAX_CHARS} characters — the rest is in ${rest}]`;
}

/** Where a composed launch message can be built from. Each is read by whoever has it (1162). */
export interface TicketBriefSources {
  /** The ticket file's raw text (`wayfinder/tickets/<ref>-*.md`), read off the checkout. */
  file?: string | null;
  /** The ob item behind the ref, read where the store is — the fallback when there is no ticket file. */
  item?: { title?: string | null; body?: string | null } | null;
}

/**
 * The launch message for a spinoff, composed from the ticket itself (1162): `<ref> · <title>` then the
 * `BRIEF_SECTIONS` it has, then the directive to run the spinoff skill. A file wins over an item when
 * both are handed in; null when neither carries a work order, so the caller falls back. Pure.
 */
export function ticketBrief(ticketRef: string, sources: TicketBriefSources): string | null {
  const ref = ticketRef.trim();
  const file = sources.file?.trim() ? sources.file : null;
  const item = sources.item;
  let parts: string[] | null = null;
  if (file) {
    const title = ticketFileTitle(file);
    const sections = ticketSections(file);
    const wanted = BRIEF_SECTIONS.map((h) =>
      sections.find((s) => s.heading.toLowerCase() === h.toLowerCase()),
    ).filter((s): s is TicketSection => s !== undefined);
    if (title || wanted.length > 0) {
      parts = [title ? `${ref} · ${title}` : ref];
      for (const s of wanted) parts.push(`## ${s.heading}`, s.body);
    }
  }
  if (!parts && item && (item.title?.trim() || item.body?.trim())) {
    // No file: the item's own title + body is the whole work order ob has (1162's second fallback).
    parts = [item.title?.trim() ? `${ref} · ${item.title.trim()}` : ref];
    if (item.body?.trim()) parts.push(item.body.trim());
  }
  if (!parts) return null;
  // The marker names the source it cut, so it never points at a file that does not exist.
  const rest = file ? `wayfinder/tickets/${ref}-*.md` : `the ob item ${ref} (ob show ${ref})`;
  return [cutBrief(parts.join("\n\n"), rest), spinoffSkillDirective()].join("\n\n");
}

/**
 * The ticket file's text for a ref, read off a checkout. ABSENCE is null — the fallbacks are for that —
 * but a file that exists and cannot be read THROWS: quietly queueing the pointer instead is the silent
 * downgrade of the work order that 1162 exists to end.
 */
function readTicketFileText(repoPath: string | null | undefined, ticketRef: string): string | null {
  if (!repoPath) return null;
  const path = ticketFilePath(repoPath, ticketRef);
  if (!path) return null;
  return readFileSync(path, "utf8");
}

/**
 * The ob item behind a ref as a brief source, or null when the ref resolves to no item (a `#<n>` ref
 * goes through its issue link). Absence is null; a store that throws is reported, not swallowed.
 */
async function itemBriefSourceFor(
  db: Database | Store,
  ticketRef: string,
): Promise<{ title: string | null; body: string | null } | null> {
  const num = parseIssueRef(ticketRef);
  let id: string | null = ticketRef;
  if (num !== null) {
    id = (await itemForIssue(db, { repo: await trackerRepo(db), number: num }))?.item_id ?? null;
  }
  if (!id) return null;
  const item = await getItem(db, id);
  return item ? { title: item.title, body: item.body } : null;
}

/**
 * What a caller can hand a launch message (1162): the explicit heads it already composed, and — where it
 * has a wire instead of a store — the one item read an API client is allowed to make (1190).
 */
export interface SpinoffAskInput {
  /** A caller-supplied `--brief` (or its stdin form): wins outright, exactly as it did before 1162. */
  brief?: string | null;
  /** A `#<n>` ref's own head, composed from the fetched GitHub issue (221). */
  issueHead?: string | null;
  /**
   * The ob item behind the ref, read over the API by a caller with no store (1190). Consulted ONLY when
   * there is no ticket file, and never in place of `db`: the file is the work order, the item is the
   * fallback. A read that fails is a fallthrough, not a failed dispatch.
   */
  readItem?: () => Promise<{ title?: string | null; body?: string | null } | null>;
  /** The repo whose private rules ride on the message (1803): a slug, or a checkout/worktree path reduced to its repo. Defaults to `repoPath`. */
  project?: string;
  /**
   * OB-2103: the project's stored stage (null = not set) for a caller with no store, read over the API. With
   * a store the stage is read from it. A read that fails leaves the stage line off and says so.
   */
  readStage?: (slug: string) => Promise<string | null>;
  /**
   * OB-2230: is `flake-box` on the machine that will launch the builder? Defaults to this machine. `spinoff queue`
   * passes null (unknown): it may run on the server, which launches nothing, so the paragraph tells the builder to
   * check, and the launching client checks and warns.
   */
  flakeBox?: boolean | null;
}

/**
 * The project a repo value names (1803): a bare slug passes through and a checkout path is its basename, but a
 * worktree (`<repo>.<branch>` beside its repo, or T3's `~/.t3/worktrees/<repo>/t3-<id>`) is its REPO — the same
 * rule 217/235 use to turn a `--repo` path into a slug, so a launch from a worktree still finds the rules.
 */
function projectSlugOf(repo: string): string {
  const main = isAbsolute(repo) ? worktreeRepoOf(repo) : null;
  return basename(main ?? repo);
}

/**
 * The item leg for a caller holding a WIRE rather than a store (1190): one read, and a read that fails is
 * a FALLTHROUGH. The composed brief is an improvement on the pointer, never a gate on the dispatch — so a
 * dead API opens the thread on `spinoffAsk`'s pointer and says why, rather than failing the enqueue.
 */
async function itemBriefOverWire(
  ticketRef: string,
  read: () => Promise<{ title?: string | null; body?: string | null } | null>,
): Promise<{ title?: string | null; body?: string | null } | null> {
  try {
    return await read();
  } catch (e) {
    warn(`could not read ob item ${ticketRef} for the launch message (${(e as Error).message}) — falling through`);
    return null;
  }
}

/**
 * The launch message a spinoff of `ticketRef` opens with (1162), in fallback order, most explicit first:
 * the caller's `brief`, then the ticket FILE, then the ob ITEM, then a `#<n>` ref's own `issueHead`, then
 * `spinoffAsk`'s pointer text.
 *
 * Two sources, each read where it lives: the file off the checkout the enqueuer has, the item from the
 * store. A `#<n>` ref reads NEITHER as its ticket — `#` is the disambiguator (221: a `#42` is a GitHub
 * issue, while `wayfinder/tickets/42-*.md` would be a different, local ticket) — so its own head is used
 * as it always was. An API CLIENT passes `db = null` and a `readItem` closure: it has the checkout but no
 * store, so it makes the SAME single `GET /items/:id` call `ob show <ref>` makes (1190) rather than
 * falling through to the pointer. The file still wins; a failed read still falls through.
 */
export async function spinoffAskFor(
  db: Database | Store | null,
  repoPath: string | null,
  ticketRef: string,
  input: SpinoffAskInput = {},
): Promise<string> {
  const ask = await withFlakeBoxFor(db, ticketRef, await spinoffAskBase(db, repoPath, ticketRef, input), input.flakeBox);
  // 1803: the repo's private rules (OmniSlash's `repos/<project>/AGENTS.md`) ride on every launch, a custom
  // `--brief` included; a repo with none gets the prompt it always got.
  const project = input.project ?? repoPath;
  if (!project) return ask;
  const slug = projectSlugOf(project);
  // OB-1992: a clean repo's prompt carries the one-line rule, so a builder that skips the skill still sees it.
  const clean = isObRepo(slug) ? "" : `\n\n${cleanRepoLaunchLine(ticketRef)}`;
  return ask + clean + rulesBlock(slug, await launchStage(db, slug, input.readStage));
}

/**
 * OB-2230: a `flake` ticket's launch message tells its builder to test inside `flake-box`, just before the
 * directive to run the spinoff skill. With a store the priority is read here and the box is checked on THIS
 * machine, which composes the message and launches the thread. An API client has no store, so the server's
 * enqueue adds it instead (`withFlakeBoxBrief`), from the box presence the client sends: that keeps the
 * client's one-item-read budget (1190).
 */
async function withFlakeBoxFor(db: Database | Store | null, ticketRef: string, ask: string, boxPresent?: boolean | null): Promise<string> {
  if (!db || !(await ticketIsFlake(db, ticketRef))) return ask;
  return withFlakeBoxBrief(ask, boxPresent === undefined ? flakeBoxPresent() : boxPresent);
}

/** The flake-box paragraph put into a launch message, once (a message that already has it is unchanged). Pure. */
export function withFlakeBoxBrief(brief: string, boxPresent: boolean | null): string {
  if (brief.includes(FLAKE_BOX_MARKER)) return brief;
  return withFlakeParagraph(brief, flakeBoxParagraph(boxPresent), spinoffSkillDirective());
}

/**
 * The stage the launch prompt carries (OB-2103): from the store when there is one, else the caller's API read,
 * else undefined (no stage line, the prompt it always got). A failed read is a warning, never a failed dispatch.
 */
async function launchStage(
  db: Database | Store | null,
  slug: string,
  readStage: ((slug: string) => Promise<string | null>) | undefined,
): Promise<string | null | undefined> {
  try {
    if (db) return (await getProject(db, slug))?.stage ?? null;
    if (readStage) return await readStage(slug);
  } catch (e) {
    warn(`could not read ${slug}'s stage for the launch message (${(e as Error).message}); it goes without the Stage line`);
  }
  return undefined;
}

async function spinoffAskBase(
  db: Database | Store | null,
  repoPath: string | null,
  ticketRef: string,
  input: SpinoffAskInput,
): Promise<string> {
  if (input.brief !== undefined && input.brief !== null) return input.brief;
  if (parseIssueRef(ticketRef) === null) {
    const file = readTicketFileText(repoPath, ticketRef);
    if (file) {
      const fromFile = ticketBrief(ticketRef, { file });
      if (fromFile) return fromFile;
    }
    // The item leg: the store where there is one, else the one wire read a client is allowed (1190).
    const item = db
      ? await itemBriefSourceFor(db, ticketRef)
      : input.readItem
        ? await itemBriefOverWire(ticketRef, input.readItem)
        : null;
    if (item) {
      const fromItem = ticketBrief(ticketRef, { item });
      if (fromItem) return fromItem;
    }
  }
  if (input.issueHead !== undefined && input.issueHead !== null) return input.issueHead;
  return spinoffAsk(ticketRef);
}

/**
 * 1803: put the repo's opencode architect wiring (OmniSlash's `repos/<project>/opencode`) into a fresh worktree.
 * A failure ABORTS the launch: the wiring is what makes the thread an ob thread in this repo (SOUL, memory,
 * skills), and an unwritable exclude leaves the untracked copies visible, which `ob spinoff handoff` refuses
 * as a dirty tree. `prepareLaunch`'s caller turns the throw into a failed row carrying the message. The manual
 * `ob project wire` runs the same install, where a broken checkout is only reported.
 */
function installRepoWiring(project: string, worktree: string): void {
  const res = installOpencodeWiring(project, worktree);
  if (res.excludeFailed) {
    throw new AppError(
      `opencode wiring installed in ${worktree}, but its git info/exclude could not be written: the files would show` +
        ` in git status and \`ob spinoff handoff\` refuses a dirty tree. Fix the checkout's git metadata, or run` +
        ` \`ob project wire ${project} --dir ${worktree}\` yourself`,
    );
  }
}

/** The harness engines a spinoff/architect launch can be composed for. */
export const ENGINES = ["claude", "opencode"] as const;
export type Engine = (typeof ENGINES)[number];

export function isEngine(s: string): s is Engine {
  return (ENGINES as readonly string[]).includes(s);
}

/** The engine from a `spinoff_engine` setting: anything unrecognised reads as the claude default. Pure. */
export function engineFromSetting(raw: string): Engine {
  return raw === "opencode" ? "opencode" : "claude";
}
/**
 * The statuses a spinoff row can hold. Named (360) so `GET /spinoffs?status=` validates its filter rather
 * than passing an arbitrary string into a `WHERE`, where a typo answers 200 with an empty list -- which
 * reads exactly like "nothing is queued".
 */
export const SPINOFF_STATUSES = ["pending", "launching", "launched", "ready-for-gate", "merged", "failed"] as const;
/** Human-declared "architect should gate this": not a merge, not `agent done` (ob 391). */
export const READY_FOR_GATE = "ready-for-gate";
const READYABLE_STATUSES = ["launched", READY_FOR_GATE] as const;
export type SpinoffStatus = (typeof SPINOFF_STATUSES)[number];

/**
 * OB-1920: every edge a spinoff row's status may take, and nothing else. Derived from the writers that
 * exist, not invented: every status write goes through `moveSpinoff`, which updates only
 * `WHERE id = ? AND status IN (<from-states>)` and refuses by name when no row moved. `failed` is
 * terminal and `merged` nearly so (a re-dispatch inserts a NEW row; `enqueueSpinoff` dedupes only
 * pending/launching): its one exit is `ob spinoff reopen`, for a land that was wrong (OB-2180).
 *
 *   pending        → launching (claim) · failed (abandon)
 *   launching      → launched (stamp) · pending (reclaim / spawn-failure retry) · failed (stamp, reclaim,
 *                    spawn failure, abandon)
 *   launched       → launched (384 session-id re-stamp) · ready-for-gate (handoff) · merged (land) ·
 *                    pending (spawn-failure retry) · failed (spawn failure, spike end, abandon)
 *   ready-for-gate → launched (send-back) · merged (land) · failed (spike end, abandon)
 *   merged         → launched (reopen, OB-2180)
 */
export const SPINOFF_TRANSITIONS: Readonly<Record<SpinoffStatus, readonly SpinoffStatus[]>> = {
  pending: ["launching", "failed"],
  launching: ["launched", "pending", "failed"],
  launched: ["launched", READY_FOR_GATE, "merged", "pending", "failed"],
  [READY_FOR_GATE]: ["launched", "merged", "failed"],
  // OB-2180: a landed row's one way back is `ob spinoff reopen`, for a row reconcile landed wrongly. Every
  // other move to `launched` names its own narrower from-state, so this edge serves only `markSpinoffReopened`.
  merged: ["launched"],
  failed: [],
};

/** The statuses the table lets a row move from to reach `to`. Pure. */
function spinoffFromStates(to: SpinoffStatus): SpinoffStatus[] {
  return SPINOFF_STATUSES.filter((from) => SPINOFF_TRANSITIONS[from].includes(to));
}

/** A status move the table (or the writer's narrower from-set) does not allow. Still an AppError (409 on the API). */
export class SpinoffTransitionRefused extends AppError {
  constructor(id: number, current: string | null, to: SpinoffStatus) {
    super(
      current === null
        ? `no spinoff #${id}`
        : `spinoff #${id} is ${spinoffStatusWord(current)}; it cannot move to ${spinoffStatusWord(to)}`,
    );
    this.name = "SpinoffTransitionRefused";
  }
}

/**
 * The one status writer (OB-1920): set `to` (plus `set`) on row `id` only while its status is one of `from`
 * (default: every from-state the table allows; a narrower list is intersected with the table, never widened).
 * Returns the stored row as written; throws `SpinoffTransitionRefused` naming the row, its current status
 * and the target when nothing moved.
 */
export async function moveSpinoff(
  db: Database | Store,
  id: number,
  to: SpinoffStatus,
  set: Partial<SpinoffRow> = {},
  from: readonly SpinoffStatus[] = spinoffFromStates(to),
): Promise<SpinoffRow> {
  const s = asStore(db);
  const allowed = from.filter((f) => SPINOFF_TRANSITIONS[f].includes(to));
  if (allowed.length > 0) {
    const rows = (await s.q
      .update(s.t.spinoff)
      // A handoff and a merge are each reported once by the watch (OB-1924): re-arm reported_at on both.
      .set({ ...set, status: to, ...(to === READY_FOR_GATE || to === "merged" ? { reported_at: null } : {}) })
      .where(and(eq(s.t.spinoff.id, id), inArray(s.t.spinoff.status, allowed)))
      .returning()) as SpinoffRow[];
    if (rows[0]) return rows[0];
  }
  throw new SpinoffTransitionRefused(id, (await getSpinoffRow(s, id))?.status ?? null, to);
}

/** The stored row by id, or null. */
export async function getSpinoffRow(db: Database | Store, id: number): Promise<SpinoffRow | null> {
  const s = asStore(db);
  const rows = (await s.q.select().from(s.t.spinoff).where(eq(s.t.spinoff.id, id)).limit(1)) as SpinoffRow[];
  return rows[0] ?? null;
}
const WATCHABLE_DONE_STATUSES = ["merged", READY_FOR_GATE] as const;
export type SpinoffMode = (typeof SPINOFF_MODES)[number];

export interface SpinoffRow {
  id: number;
  ticket_ref: string;
  repo: string;
  branch: string;
  worktree: string;
  mode: string;
  brief: string;
  status: string; // pending | launching | launched | ready-for-gate | merged | failed
  error: string | null;
  agent_id: string | null;
  request_at: string;
  launched_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  total_tokens: number | null;
  base_sha: string | null;
  reported_at: string | null;
  launcher: string | null; // t3, stamped at launch (#125); null = pre-0020 row; may read a legacy value on an old row (#79)
  launch_attempts: number | null; // launch attempts: counted once per claim (OB-1921; was per `launched`, #151); null = pre-0021 row
  session_id: string | null; // the Claude Code session this launch was given (#126); null = not resumable
  engine: string | null; // claude | opencode, the harness this launch was composed for (0023); null = pre-0023 row
  t3_thread_id: string | null; // the T3 Code thread a `--launcher t3` row opened (1120); null = no thread
  t3_run_id: string | null; // the T3 run that launch minted (1120); null = an idle thread, or no thread
  item_id: string | null; // the ob ITEM this row serves (1163); null = queued before 0032, or the ref names no item
  tier: string | null; // complex | medium | simple, rated at queue time (1480); null = pre-0034 (launches as medium)
  model: string | null; // the model the launch actually ran on (1480); null = not launched, a legacy headless row, or pre-0034
  effort: string | null; // OB-1815: the level --effort named at queue; the launch stamps `high` | `default (high)` | `default (none listed)`; null = not stamped, or pre-0039
  // OB-1992 (0040): a clean repo's recorded verdict, reason and gate line (`ob spinoff state`); null = none recorded
  verdict?: string | null;
  verdict_reason?: string | null;
  gate_line?: string | null;
  // OB-1991 (0041): which leg of a model trial pair this row is (a | b), and the model the trial launches it on;
  // null = not a trial leg
  trial_leg?: string | null;
  trial_model?: string | null;
  // OB-2172 (0044): why the last readying note did not reach the architect, `<iso time> <reason>`; null = it went
  note_error?: string | null;
}
export interface EnqueueInput {
  ticketRef: string;
  repo: string;
  branch: string;
  mode: SpinoffMode;
  brief: string;
  worktree?: string; // explicit --worktree override; takes precedence over the derived <repo>.<branch> path
  launcher?: LauncherName | null; // explicit --launcher override (#135), recorded at QUEUE time so the drain honours it
  tier?: SpinoffTier | null; // --tier (1480); absent = DEFAULT_SPINOFF_TIER, recorded on the row either way
  effort?: SpinoffEffort | null; // --effort (OB-1815); absent = no level named: the model's own default, nothing recorded at queue
  decision?: DecisionOpts; // --note/-m (1515): why this was dispatched at this tier; recorded on the item's trail
  trialLeg?: "a" | "b" | null; // OB-1991: a trial leg; b's worktree and builder id carry `-b`
  trialModel?: string | null; // OB-1991: the model the trial launches this leg on, over the tier's model
}

/**
 * The spinoff row's transition on its ITEM's decision trail (1515), with the row id linked. The words are
 * the displayed ones (queued / building / handed-off / landed), the same the human reads in `ob spinoff
 * list`. A row serving no tracker item has no trail to write to, and a trail write never fails the
 * transition it is describing: the row is the record, this is the note beside it.
 */
async function recordRowDecision(
  db: Database | Store,
  row: SpinoffRow,
  from: string,
  to: string,
  decision: DecisionOpts = {},
): Promise<void> {
  try {
    const itemId = row.item_id ?? (await rowItemId(asStore(db), row));
    if (!itemId) return;
    await recordDecision(db, itemId, from, to, { ...decision, spinoffRow: row.id });
  } catch (e) {
    warn(`  ⚠ decision not recorded for ${row.ticket_ref}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The worktree path for a branch, matching the `wt` convention `<repo>.<branch>`. Pure. */
export function worktreePath(repo: string, branch: string): string {
  return `${repo}.${branch}`;
}

/**
 * What a row's worktree is named after (OB-1992): the branch in OmniSlash, where the branch is the ref, and the ref
 * in a clean repo, whose branch is a title slug. The worktree is local and never shown, so it keeps the ref. Pure.
 */
export function worktreeKeyOf(row: { repo: string; branch: string; ticket_ref: string; trial_leg?: string | null }): string {
  return isObRepo(row.repo) ? row.branch : refKey(legRef(row.ticket_ref, row.trial_leg));
}

/** Is `name` a branch in `repoPath`, locally or on origin (OB-1992)? Over the `sh` seam, so tests never touch a remote. */
export function branchTakenIn(repoPath: string, name: string): boolean {
  if (sh(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`]).ok) return true;
  const remote = sh(["git", "-C", repoPath, "ls-remote", "--exit-code", "--heads", "origin", name], undefined, 15_000);
  return remote.ok && (remote.out ?? "").trim().length > 0;
}

/**
 * The branch a dispatch gets when no `--branch` names one (OB-1992). omnislash: the lowercased ref, as always. A
 * clean repo: a slug of the ticket title (at most 40 characters, `-2`, `-3` when taken locally or on origin),
 * since the branch name shows on every PR. A re-dispatch reuses the branch the ticket's newest row in this repo
 * already has, so a retry does not fork a second branch.
 */
export async function defaultBranchFor(db: Database | Store, repo: string, ticketRef: string): Promise<string> {
  if (isObRepo(repo)) return ticketRef.toLowerCase();
  const s = asStore(db);
  const rows = await listSpinoffs(s);
  const repoPath = await rowRepoPathFor(s, repo);
  return cleanBranchFor(rows, repo, ticketRef, async () => {
    const itemId = await ticketItemIdFor(s, ticketRef);
    return itemId ? ((await getItem(s, itemId))?.title ?? "") : "";
  }, (name) => branchTakenIn(repoPath, name));
}

/**
 * A clean repo's branch for a dispatch (OB-1992), shared by the local and API paths: a re-dispatch reuses the
 * newest prior row's branch for the same repo and ticket, so the builder picks up its own work; a first
 * dispatch takes the title slug, suffixed `-2`, `-3` when `taken` says the name is in use.
 */
export async function cleanBranchFor(
  rows: ReadonlyArray<{ repo: string; ticket_ref: string; branch: string }>,
  repo: string,
  ticketRef: string,
  title: () => Promise<string>,
  taken: (name: string) => boolean,
): Promise<string> {
  const prior = rows.find((r) => r.repo === repo && ticketRefIs(r.ticket_ref, ticketRef));
  if (prior) return prior.branch;
  return uniqueBranch(branchSlug(await title(), BRANCH_SLUG_MAX), taken);
}

// --- the config reads on the spinoff path, in BOTH engines (337) -------------
//
// `setting()` is synchronous and sqlite-only, and it cannot follow config.ts async: ~90 unported call
// sites through whatsapp, net, cert, credentials and the connectors sit in synchronous chains. So this
// module follows the settings.ts / events.ts precedent -- an async `...For` form BESIDE each synchronous
// one -- with one rule that makes the pair safe: THE DECISION IS A PURE FUNCTION OF THE SETTING'S TEXT,
// and both forms call it. Only the READ differs, so the two engines cannot answer the same question
// differently, and there is no second implementation to drift.
//
// `ob spinoff` itself uses the async forms exclusively (see cmdSpinoff), which is what puts it on the
// servable list. The synchronous ones stay for the callers that are NOT ported -- the remote-dispatch
// argv rewrite -- which holds a raw handle that postgres mode never issues it.

// --- the engine (0023): which harness a launch is composed for -----------------
// One `spinoff_engine` setting chooses the harness for every launch shape: builders AND architect. It
// resolves to an `Engine` that drives the command builders (spinoffTabCommand / withSessionID / resume),
// the session scheme (claude pre-mints a
// UUID; opencode mints its own `ses_` ids that cannot be named before a session exists, so an opencode
// launch is not pre-mintable and gets no session_id), and the token reader at land time. Every consumer
// goes through one of these reads, so the per-engine decisions stay in one place; the engine itself is
// stamped on the row at launch (spinoff.engine) so reconcile does not re-read a setting that flipped.

export function spinoffEngine(db: Database): Engine {
  return engineFromSetting(setting(db, "spinoff_engine"));
}

/** The store-aware form of `spinoffEngine()` (337): the same engine, read through the store. */
export async function spinoffEngineFor(db: Database | Store): Promise<Engine> {
  return engineFromSetting(await settingFor(db, "spinoff_engine"));
}

/** The builder launch command for an engine: `spinoff_agent_cmd` or its opencode counterpart. */
export async function agentCmdFor(db: Database | Store, engine: Engine): Promise<string> {
  if (engine !== "opencode") return settingFor(db, "spinoff_agent_cmd");
  const stored = await getConfig(asStore(db), "opencode_spinoff_agent_cmd");
  const cmd = effectiveOpencodeSpinoffAgentCmd(stored);
  if (stored !== null && (LEGACY_OPENCODE_SPINOFF_AGENT_CMDS as readonly string[]).includes(stored)) {
    await setConfig(db, "opencode_spinoff_agent_cmd", cmd);
  }
  return cmd;
}

/** The architect launch command for an engine: `architect_cmd` or its opencode counterpart. */
export async function architectCmdFor(db: Database | Store, engine: Engine): Promise<string> {
  if (engine !== "opencode") return settingFor(db, "architect_cmd");
  return effectiveOpencodeArchitectCmd(await getConfig(asStore(db), "opencode_architect_cmd"));
}

/**
 * OB-2075: an URGENT ticket always builds on the complex tier (Opus), whatever `--tier` named.
 *
 * True when the item at `itemId` is at the stored urgent priority (compared by the named constant, not a
 * bare integer; `flake` and `high` are NOT urgent). A null id (a ref with no item) or a failed read is
 * not urgent: the named tier stands, like the thread title, this is best effort.
 */
export async function itemIsUrgent(db: Database | Store, itemId: string | null | undefined): Promise<boolean> {
  if (!itemId) return false;
  try {
    return (await getItem(db, itemId))?.priority === PRIORITY_URGENT;
  } catch {
    return false;
  }
}

/** A trial leg (OB-1991) keeps its recorded tier and `trial_model`: the urgent rule leaves it alone. */
function isTrialRow(row: { trial_leg?: string | null; trial_model?: string | null }): boolean {
  return Boolean(row.trial_leg) || Boolean(row.trial_model);
}

/**
 * The launch-time half of the urgent rule (OB-2075): the row as it must LAUNCH, and the tier it was raised
 * from (null when nothing was raised). Pure of writes: the caller decides whether to record the raise.
 * A row whose item is not urgent, a trial leg, and a row already on `complex` come back untouched.
 */
export async function urgentLaunchRow(
  db: Database | Store,
  row: SpinoffRow,
): Promise<{ row: SpinoffRow; raisedFrom: SpinoffTier | null; urgent: boolean }> {
  if (isTrialRow(row)) return { row, raisedFrom: null, urgent: false };
  if (!(await itemIsUrgent(db, await rowItemId(db, row)))) return { row, raisedFrom: null, urgent: false };
  if (row.tier === "complex") return { row, raisedFrom: null, urgent: true };
  return { row: { ...row, tier: "complex" }, raisedFrom: row.tier && isSpinoffTier(row.tier) ? row.tier : DEFAULT_SPINOFF_TIER, urgent: true };
}

/**
 * Enqueue a launch. Dedups on an active (pending|launching) row for the same ticket.
 *
 * `collision` is the ob item id the ref is ALSO the id of, when the ref's ticket path bound the row to a
 * different item (1226): ref "1133" is both the strip mirror's id and the wayfinder number of the
 * readying-note ticket (item 1135). The binding is the path either way — this only says so, and it is
 * resolved HERE, where the store is, so the split client reads it from the enqueue it already sends
 * instead of asking the tracker again (and never with an id in a url, 357). Null in every ordinary case.
 */
export async function enqueueSpinoff(
  db: Database | Store,
  input: EnqueueInput,
): Promise<{ row: SpinoffRow; deduped: boolean; collision: string | null; urgent: boolean; raisedFrom: SpinoffTier | null }> {
  const s = asStore(db);
  // 1949: one row per ITEM, named by its `<KEY>-<seq>` ref however it was typed (the bare id, a lowercase
  // ref, an alias a move left). A branch the caller only defaulted from the typed ref follows the ref too,
  // so the API's enqueue (whose client cannot resolve a wayfinder mirror) lands on the same name.
  const ticketRef = await dispatchRefFor(s, input.ticketRef);
  if (ticketRef !== input.ticketRef) {
    const defaulted = input.branch === input.ticketRef.toLowerCase();
    input = { ...input, ticketRef, branch: defaulted ? ticketRef.toLowerCase() : input.branch };
  }
  // 1949: a row parked before refs carries the bare id (`1925`), so the dedupe matches every name the item
  // has had, not only the ref it is queued under now. The exact ref always dedupes (its recorded item may be
  // stale, 1226); another name only counts when the row is bound to this item or to none, since a bare `1133`
  // row bound to item 1135 is another item's row.
  const typedItem = await ticketItemIdFor(s, input.ticketRef);
  // OB-2075: an urgent item always builds on complex (Opus), whatever tier was named. The rule lives HERE,
  // where every dispatch goes through (the local `ob spinoff` and the API's enqueue alike). A trial leg
  // (OB-1991) keeps its recorded tier.
  const urgent = !input.trialLeg && !input.trialModel && (await itemIsUrgent(s, typedItem));
  const raisedFromOf = (named: SpinoffTier | null | undefined): SpinoffTier | null => (urgent && named && named !== "complex" ? named : null);
  const sameTicket = typedItem
    ? or(
        eq(s.t.spinoff.ticket_ref, input.ticketRef),
        and(
          inArray(s.t.spinoff.ticket_ref, await equivalentRefs(s, typedItem)),
          or(isNull(s.t.spinoff.item_id), eq(s.t.spinoff.item_id, typedItem)),
        ),
      )
    : eq(s.t.spinoff.ticket_ref, input.ticketRef);
  const actives = (await s.q
    .select()
    .from(s.t.spinoff)
    .where(and(sameTicket, inArray(s.t.spinoff.status, ["pending", "launching"])))
    .limit(1)) as SpinoffRow[];
  const active = actives[0];
  if (active) {
    // 1226: a DEDUPED dispatch hands back a row that may have been queued under the old bare-id rule, and
    // every join reads that row's RECORDED identity. Re-resolve it here — this is a write path, and the row
    // is about to be launched as if the ref had just been dispatched, so a stale binding left in place is a
    // stale binding at launch. Only a CONFIRMED answer corrects the record: `rowItemId`'s null also covers a
    // ref two items name or a read that failed, and an identity that cannot be checked is not one to
    // overwrite. That outcome is left distinct on purpose — the value is untouched (nothing was decided),
    // and every reader resolves the row again anyway, so this write is a correction, never the decision.
    const resolved = await rowItemId(s, active);
    if (resolved !== null && resolved !== active.item_id) {
      await s.q.update(s.t.spinoff).set({ item_id: resolved }).where(eq(s.t.spinoff.id, active.id));
      active.item_id = resolved;
    }
    // 1480: a re-dispatch that NAMES a tier re-rates a row that is still PENDING — the drain has not
    // picked a model yet, so the newer rating is the one to launch at. A `launching` row is left alone (its
    // model may already be resolved), and no --tier leaves the rating alone.
    // OB-2075: an urgent item is re-rated to complex too, named tier or not.
    const priorTier = active.tier && isSpinoffTier(active.tier) ? active.tier : null;
    const wantTier = urgent && !isTrialRow(active) ? "complex" : input.tier;
    // OB-2107: a re-rate moves a pending row onto another tier's model at the effort it already carries, so
    // Opus above its default needs his ask here too (a dispatch with no --effort skipped the check upstream).
    // The ask is the quote the dispatch's own note carries, so the API's enqueue is checked the same way.
    if (active.status === "pending" && !isTrialRow(active) && ((wantTier && wantTier !== active.tier) || (input.effort && input.effort !== active.effort))) {
      const tier: SpinoffTier = wantTier ?? priorTier ?? DEFAULT_SPINOFF_TIER;
      refuseOpusHigh(tierModelsOrRefuse(await settingFor(s, "spinoff_tier_models")), tier, (input.effort ?? rowEffortOf(active.effort)) as SpinoffEffort | undefined, opusHighAskOf(input.decision?.note));
    }
    if (wantTier && wantTier !== active.tier && active.status === "pending") {
      await s.q.update(s.t.spinoff).set({ tier: wantTier }).where(eq(s.t.spinoff.id, active.id));
      active.tier = wantTier;
    }
    // OB-1815: --effort follows --tier exactly. A still-PENDING row is re-rated in place; a launching row is
    // left alone; no --effort leaves the rating alone.
    if (input.effort && input.effort !== active.effort && active.status === "pending") {
      await s.q.update(s.t.spinoff).set({ effort: input.effort }).where(eq(s.t.spinoff.id, active.id));
      active.effort = input.effort;
    }
    return {
      row: active,
      deduped: true,
      collision: await collidingRefItem(s, active.ticket_ref, resolved ?? active.item_id),
      urgent: urgent && !isTrialRow(active) && active.tier === "complex",
      raisedFrom: active.tier === "complex" ? raisedFromOf(input.tier ?? priorTier) : null,
    };
  }
  // The ob ITEM this row serves (1163), resolved here — the one place every dispatch goes through, the
  // local `ob spinoff` and the API's enqueue alike. Best effort: a ref that resolves to no item records
  // NULL, which is exactly what a row that is not about a tracker item should say.
  const itemId = typedItem;
  const inserted = (await s.q
    .insert(s.t.spinoff)
    .values({
      ticket_ref: input.ticketRef,
      item_id: itemId,
      repo: input.repo,
      branch: input.branch,
      worktree: input.worktree ?? worktreePath(input.repo, worktreeKeyOf({ repo: input.repo, branch: input.branch, ticket_ref: input.ticketRef, trial_leg: input.trialLeg })),
      mode: input.mode,
      brief: input.brief,
      // An explicit --launcher is recorded HERE, not at launch (#135): the drain resolves the launcher
      // from live config, so a caller that flipped a setting, queued, and flipped it back got the
      // launcher it was trying to avoid, silently. A row that names its own launcher cannot be re-routed
      // by a later config change, and the intended route is visible on the pending row.
      launcher: input.launcher ?? null,
      // 1480: the tier is recorded at QUEUE time, like the launcher, and always — a dispatch that named
      // none records the default, so the pending row says what it will cost before it launches.
      // OB-2075: an urgent item records complex.
      tier: urgent ? "complex" : (input.tier ?? DEFAULT_SPINOFF_TIER),
      // OB-1815: only a level that was NAMED is recorded; the launch stamps the final text.
      effort: input.effort ?? null,
      trial_leg: input.trialLeg ?? null,
      trial_model: input.trialModel ?? null,
      status: "pending",
      request_at: nowIso(),
    })
    .returning()) as SpinoffRow[];
  await recordRowDecision(s, inserted[0]!, "—", spinoffStatusWord("pending"), input.decision);
  return { row: inserted[0]!, deduped: false, collision: await collidingRefItem(s, input.ticketRef, itemId), urgent, raisedFrom: raisedFromOf(input.tier) };
}

/**
 * The item id a ref is ALSO the id of (1226), when the row's ticket path bound it to a different item —
 * one read, made only where a collision is possible at all (the row serves an item that is not the ref).
 * A read that fails answers null: this makes a coincidence visible, and a diagnostic never fails the
 * dispatch it is describing.
 */
async function collidingRefItem(db: Database | Store, ticketRef: string, itemId: string | null): Promise<string | null> {
  const ref = ticketRef.trim();
  if (!itemId || itemId === ref) return null;
  try {
    return (await getItem(db, ref))?.id ?? null;
  } catch {
    return null;
  }
}

export async function listSpinoffs(db: Database | Store, status?: string): Promise<SpinoffRow[]> {
  const s = asStore(db);
  const q = s.q.select().from(s.t.spinoff);
  const filtered = status ? q.where(eq(s.t.spinoff.status, status)) : q;
  // id is the primary key, so it is NOT NULL and DESC orders identically on both engines (the NULLS
  // FIRST/LAST split only shows up on a nullable ordering column).
  return (await filtered.orderBy(desc(s.t.spinoff.id))) as SpinoffRow[];
}

/**
 * The pending rows a drain may attempt, OLDEST FIRST (FIFO), so a launchable repo drains in request order.
 * One query, shared by the local drain and by `POST /spinoffs/launchable` (360), because "which rows are
 * waiting and in what order" must not be answered two ways.
 */
export async function pendingSpinoffs(db: Database | Store): Promise<SpinoffRow[]> {
  const s = asStore(db);
  return (await s.q
    .select()
    .from(s.t.spinoff)
    .where(eq(s.t.spinoff.status, "pending"))
    .orderBy(asc(s.t.spinoff.id))) as SpinoffRow[];
}

// --- per-repo BUILD-agent attribution ---------------------------------------
// A live BUILD agent is attributed to a repo by joining its registry id to the `spinoff` row that
// launched it. Agents have no `repo` column, but the launcher registers the agent with `id = branch`
// and stamps `spinoff.agent_id = branch` on the `launched` row — so `agent.id === spinoff.agent_id`
// and that row carries `spinoff.repo`. Team role rows (`architect-*`, `sentinel-*`, `muse-*`, OB-2255) are
// excluded from the count. Informational (drain report / launchable): agent count is not a limiter (ob 767).

/** A team role row: a coordinator, never counted as a live BUILD agent. Pure. */
export function isCoordinatorAgent(id: string): boolean {
  return isTeamRoleAgent(id);
}

/** Map of live agent id → repo, from `launched` spinoff rows (agent.id === spinoff.agent_id). */
export async function agentRepoMap(db: Database | Store): Promise<Map<string, string>> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ agentId: s.t.spinoff.agent_id, repo: s.t.spinoff.repo })
    .from(s.t.spinoff)
    .where(eq(s.t.spinoff.status, "launched"))) as Array<{ agentId: string | null; repo: string }>;
  const m = new Map<string, string>();
  for (const r of rows) if (r.agentId) m.set(r.agentId, r.repo);
  return m;
}

/** Map of live agent id → its spinoff row's token total, same `launched` join as agentRepoMap (#70). */
export async function agentTokensMap(db: Database | Store): Promise<Map<string, number | null>> {
  const s = asStore(db);
  // total_tokens is a stored integer COLUMN, not an aggregate, so it arrives as a number on both engines
  // and needs no readNumber (readNumber is for sum()/count(), which Postgres returns as strings).
  const rows = (await s.q
    .select({ agentId: s.t.spinoff.agent_id, totalTokens: s.t.spinoff.total_tokens })
    .from(s.t.spinoff)
    .where(eq(s.t.spinoff.status, "launched"))) as Array<{ agentId: string | null; totalTokens: number | null }>;
  const m = new Map<string, number | null>();
  for (const r of rows) if (r.agentId) m.set(r.agentId, r.totalTokens);
  return m;
}

/**
 * Map of live agent id → the launcher its spinoff row recorded, same `launched` join as agentRepoMap
 * (#125). A FALLBACK only: the agent registry stores its own launcher, so this covers a row registered
 * before 0020 whose spinoff has since been stamped, and rows registered by something that did not say.
 */
export async function agentLauncherMap(db: Database | Store): Promise<Map<string, string>> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ agentId: s.t.spinoff.agent_id, launcher: s.t.spinoff.launcher })
    .from(s.t.spinoff)
    .where(eq(s.t.spinoff.status, "launched"))) as Array<{ agentId: string | null; launcher: string | null }>;
  const m = new Map<string, string>();
  for (const r of rows) if (r.agentId && r.launcher) m.set(r.agentId, r.launcher);
  return m;
}

/**
 * Count BUILD agents per repo — every registry row that has not been `agent done`, including
 * expired/stale. `architect-*` rows excluded (they coordinate). A non-architect agent that can't be
 * mapped to a repo via the spinoff join (e.g. a hand-registered agent with no `launched` row) is
 * counted in `total` but attributed to no repo. Informational (drain report / launchable): agent
 * count is not a reason to leave a row pending (ob 767).
 */
export async function liveBuildAgentsByRepo(
  db: Database | Store,
): Promise<{ perRepo: Map<string, number>; total: number }> {
  const s = asStore(db);
  const repoOf = await agentRepoMap(s);
  const perRepo = new Map<string, number>();
  let total = 0;
  for (const a of await listAgents(s, { includeExpired: true })) {
    if (isCoordinatorAgent(a.id)) continue; // team threads never count
    total++;
    const repo = repoOf.get(a.id);
    if (repo === undefined) continue; // unmappable → not attributed to any repo
    perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
  }
  return { perRepo, total };
}

// `out` carries the command's stdout so read-only git queries (worktree list, branch --merged,
// status --porcelain — used by `spinoff cleanup`) can go through the same seam as the mutating ones.
/** `code` and `signal` are how the process ended (OB-2145): a failure with empty stderr is named by them. */
export type ShResult = { ok: boolean; err: string; out?: string; code?: number | null; signal?: string | null };
export type Sh = (cmd: string[], cwd?: string, timeoutMs?: number) => ShResult;

const realSh: Sh = (cmd, cwd, timeoutMs) => {
  try {
    const p = Bun.spawnSync(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
      // a fetch that wants a credential must fail, not sit on a prompt nobody is watching
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return {
      ok: p.exitCode === 0,
      err: new TextDecoder().decode(p.stderr).trim(),
      out: new TextDecoder().decode(p.stdout),
      code: p.exitCode,
      signal: p.signalCode == null ? null : String(p.signalCode),
    };
  } catch (e) {
    return { ok: false, err: String(e), out: "" };
  }
};

/**
 * Why `cmd` did not do its job, for an error message (OB-2145). git's stderr when it wrote any; otherwise the
 * command and how it ended (exit code, signal, or "exit 0" when it claimed success but left nothing behind),
 * so a failure with empty stderr names itself instead of reading as a bare "git worktree error".
 */
function describeShFailure(cmd: string[], r: ShResult): string {
  if (r.err) return r.err;
  const ended = r.signal ? `killed by ${r.signal}` : r.code === undefined || r.code === null ? "no exit code" : `exit ${r.code}`;
  const out = (r.out ?? "").trim();
  return `\`${cmd.join(" ")}\` wrote nothing to stderr (${ended}${r.ok ? ", reported success" : ""})${out ? `; stdout: ${out.slice(0, 300)}` : ""}`;
}

/** The shell-runner seam — injectable so tests never fork a real `git`/`open`. */
const shSeam = defineSeam<Sh>("cli-coord/spinoff.sh", realSh);
const sh: Sh = (cmd, cwd, timeoutMs) => shSeam.get()(cmd, cwd, timeoutMs);
/** Test seam: swap the shell runner; returns a restore fn. */
export function __setSh(fn: Sh): () => void {
  return shSeam.set(fn);
}
/** Test seam (OB-2145): is the real shell runner installed? A test file ends by asserting it, so a stub it leaked cannot reach the next file. */
export function __shIsReal(): boolean {
  return shSeam.isReal();
}

/**
 * The shell command a spawned tab runs for one spinoff row: the SINGLE source of truth shared by both
 * launchers (#96), so no two launch shapes can run different effective commands and drift.
 *
 * Every spinoff starts the harness with the brief as its opening prompt (#147). It used to `cat` the
 * brief, which printed text and exited, so the one thing a spinoff exists for (a session a human can
 * DRIVE) was the one thing it could not do. Enqueue always stores the bare ask (563): no operating
 * procedure, no self-terminate — the human steers and declares it done. `agentCmd` is the single
 * `spinoff_agent_cmd` setting, so the model and effort cannot drift. Existing `mode=agent` rows still
 * launch this same command; only their stored brief (already composed at enqueue) differs.
 *
 * The brief arrives via `"$(cat '<briefPath>')"`: the spawning shell substitutes the FILE'S CONTENTS at
 * spawn time, so a large multi-line brief never has to be quoted into a command string. Both launchers
 * spawn through a shell that performs that substitution: the launcher splits to argv. Verified against
 * a real `zsh -lc` for #146/#147 at both a one-line and an 8.4KB brief, plain and `exec`-wrapped: one
 * argv, byte-exact, with `$`/backticks/globs/`!` in the brief left unexpanded, so brief size and
 * quoting are not what silently drops a spawn.
 *
 * The row is not a parameter: the command does not vary by row (the worktree is applied by the launcher
 * as the tab's directory, not by this string), and taking one invited exactly the per-mode divergence
 * #147 fixed. Pure.
 *
 * `engine` is the harness the brief opens under. claude puts the prompt in a trailing positional (the
 * TUI takes the brief that way); opencode's TUI does NOT take a positional message — its positional is
 * the project directory, and the prompt arrives through the `--prompt` flag — so the opencode shape is
 * `… --prompt "$(cat '…')"`. Both run the same brief.
 */
export function spinoffTabCommand(briefPath: string, agentCmd = "claude", sessionID?: string, engine: Engine = "claude"): string {
  const briefArg = engine === "opencode" ? `--prompt "$(cat '${briefPath}')"` : `"$(cat '${briefPath}')"`;
  return `${withSessionID(agentCmd, sessionID, engine)} ${briefArg}`;
}

// --- the engine-shaped command builders (#126) -------------------------------
// `spinoffTabCommand` composes the interactive launch command and `withSessionID` splices an engine's
// session flag into it after the executable. The minted-session/resume half (`claude --session-id`, the
// `--resume` command and the tab-restore path) went with the retired interactive launcher (ob 1109);
// the build half stays as this module's command-shape seam (no launch path shells it since `ob cve`
// went in OB-1806; `ob spinoff` opens a T3 thread).

/**
 * `agentCmd` with the engine's session-id flag spliced in after its EXECUTABLE, or untouched when no id
 * is given. Pure.
 *
 * The flag is `--session-id <uuid>` under claude (a minted input) and `--session <id>` under opencode
 * (which names an EXISTING session to continue — opencode cannot pre-mint, so this is the resume shape,
 * not a launch shape). Splice position after the executable rather than appended, because the commands
 * this has to serve differ in shape: `spinoff_agent_cmd` is flags only, but `architect_cmd` ends in its
 * prompt (`claude … "/ob-architect"`), and a flag appended after a positional is the kind of thing that
 * parses today and stops parsing later. The position it goes into is unambiguous for both.
 */
export function withSessionID(agentCmd: string, sessionID?: string, engine: Engine = "claude"): string {
  if (!sessionID) return agentCmd;
  const flag = engine === "opencode" ? "--session" : "--session-id";
  return spliceSessionFlag(agentCmd, flag, sessionID);
}

/** `<flag> <sessionID>` inserted after `agentCmd`'s executable token. Pure. */
function spliceSessionFlag(agentCmd: string, flagName: string, sessionID: string): string {
  const cut = agentCmd.indexOf(" ");
  if (cut < 0) return `${agentCmd} ${flagName} ${sessionID}`;
  return `${agentCmd.slice(0, cut)} ${flagName} ${sessionID}${agentCmd.slice(cut)}`;
}

/**
 * The path of an EXISTING worktree already checked out on `branch` in `repo`, if any: read via
 * `git worktree list --porcelain` (parsed by `parseWorktreeList`, defined below). Returns null on a
 * git error or when no worktree carries that branch. Used by `ensureWorktree` (#61) so adopting a
 * branch already checked out at a DIFFERENT path (e.g. a `wt`-created worktree, or a re-spun-off
 * ticket) reuses it instead of failing on `git worktree add` ("is already used by worktree at …").
 */
function findWorktreeForBranch(repo: string, branch: string): string | null {
  const r = sh(["git", "-C", repo, "worktree", "list", "--porcelain"]);
  if (!r.ok) return null;
  const found = parseWorktreeList(r.out ?? "").find((w) => w.branch === branch);
  return found ? found.path : null;
}

/** How long the pre-launch `git fetch origin main` may take before the launch goes on with what it has. */
const BASE_FETCH_TIMEOUT_MS = 30_000;

/**
 * Refresh `origin/main` before a fresh branch is cut (1490). The local `main` ref is the wrong base: lands
 * push from their own `<repo>.land-<n>` worktree, so the checkout's local `main` never moves and every
 * builder cut from it starts behind, quietly reintroducing code later landings removed (1448/1452 undid
 * 1440; 1598/1599 in pixelslash). A repo with no `origin` is left alone. A fetch that fails (offline, no
 * credential) is reported on stderr and the launch goes on with `origin/main` as last fetched, rather
 * than failing: the row's base_sha records where the branch began.
 */
function fetchOriginMain(repo: string): void {
  if (!sh(["git", "-C", repo, "remote", "get-url", "origin"]).ok) return;
  const fetched = sh(["git", "-C", repo, "fetch", "--quiet", "origin", MAIN_BRANCH], undefined, BASE_FETCH_TIMEOUT_MS);
  if (!fetched.ok) {
    warn(`spinoff base: could not fetch origin (${fetched.err || "git fetch failed"}); starting from origin/${MAIN_BRANCH} as last fetched, which may be behind`);
  }
}

/**
 * The ref that stands for "main" in `repo`: `origin/main`'s sha when the repo has one, else local `main`.
 * A local `main` that is strictly AHEAD of `origin/main` (unpushed commits, nothing new upstream) wins, so
 * nothing is started behind work the checkout already has; if the two have diverged, origin/main wins. Used for the start point AND for every "what is this branch's own
 * work" range (`base_sha`, `State:` line, changed paths): a branch cut from origin/main measured against
 * a stale local `main` would claim every landing since as its own.
 */
function mainRefFor(repo: string): string {
  return sharedMainRefFor(repo, (cmd) => sh(cmd));
}

/**
 * Ensure a worktree exists for this spinoff, driving `git` directly, NOT `wt`. `wt` is a zsh shell
 * function (not a binary on PATH), so `Bun.spawnSync(["wt", …])` fails headless with ENOENT; `git` is a
 * real binary and works in any environment (daemon, background session). Returns the RESOLVED path,
 * which the caller must persist back onto the row when it differs from `row.worktree` (#61 adoption).
 *
 * `row.worktree` is the desired path (the derived `<repo>.<branch>` convention, or an explicit
 * `--worktree` override, enqueueSpinoff already resolved that precedence). Order: (1) if it already
 * exists, done. (2) if `branch` is ALREADY checked out at some other worktree (adoption, the common
 * case a `wt`-created worktree or a re-run spinoff hits), reuse that path rather than attempting
 * `git worktree add` on top of it, which would fail with "is already used by worktree at …". (3)
 * otherwise create fresh: fetch, then `git worktree add <path> -b <branch> <origin/main sha>` (1490;
 * local `main` when the repo has no `origin/main`, or its local `main` is ahead of it), falling back to attaching an existing branch
 * (`git worktree add <path> <branch>`) if `-b` fails. Throws a clear AppError if the worktree still
 * doesn't exist after the attempt.
 */
export function ensureWorktree(row: SpinoffRow): string {
  const path = row.worktree || worktreePath(row.repo, worktreeKeyOf(row));
  if (existsSync(path)) return path;
  const adopted = findWorktreeForBranch(row.repo, row.branch);
  if (adopted) return adopted;
  fetchOriginMain(row.repo);
  const start = mainRefFor(row.repo);
  let cmd = ["git", "-C", row.repo, "worktree", "add", path, "-b", row.branch, start];
  let r = sh(cmd);
  if (!r.ok && !existsSync(path)) {
    cmd = ["git", "-C", row.repo, "worktree", "add", path, row.branch];
    r = sh(cmd);
  }
  if (!existsSync(path)) throw new AppError(`worktree create failed: ${describeShFailure(cmd, r)}`);
  return path;
}

// --- launcher seam (154/G5; warp removed: #79, the interactive app retired: ob 1109, headless: ob 1589) ---
// The SPAWN is the only surface that differs between launch shapes. Everything else (worktree, agent
// registry, reconcile) is spawn-agnostic, so the launch sits behind a `spinoff_launcher` setting. `t3` is the
// only reachable value since 1589: it opens a T3 Code thread bound to the row's worktree. Legacy values
// (`warp`, the retired interactive app, `headless`) are never rewritten on rows that recorded them, but
// they are no longer routable -- an unroutable value resolves to `t3`.

/**
 * Per-launch options a caller can force, as opposed to anything derived from the row or from config.
 * Empty today: its one member (`variant`) named which interactive instance a launch went to, and that
 * launcher retired (ob 1109). Kept because it is the seam's per-call parameter, and P2's `t3` launcher
 * is the next thing that may need one.
 */
export type LaunchOpts = Record<string, never>;

/**
 * What a launcher DID that the row has to remember. Returned rather than written (191): a launcher runs
 * on the machine with the tabs, which after the cutover is not the machine with the database, so the only
 * thing it can honestly do with a session id is hand it back to the STAMP.
 */
export interface LaunchEffect {
  /** The Claude Code session this launch minted (#126), for the stamp to persist. */
  sessionId?: string;
  /** The T3 Code thread this launch opened (1120), for the stamp to persist. */
  t3ThreadId?: string;
  /** The T3 run that launch minted (1120); absent for an adopted idle thread. */
  t3RunId?: string | null;
  /** The model a T3 thread runs on (1480), for the stamp to persist. */
  model?: string;
  /** The effort text the launch ran at (OB-1815): `high`, `default (high)` or `default (none listed)`. */
  effort?: string;
  /** OB-2075: the launch adopted a thread a previous attempt opened, so it did not run on the row's tier model. */
  adopted?: boolean;
  /** OB-2075: the launch ran an urgent item on complex (a fresh thread), so the stamp records the row as complex. */
  raised?: boolean;
}

/** The one stderr line an urgent launch owes: the raise, or that an adopted thread kept its model (OB-2075). */
export function warnUrgentTier(ticketRef: string, raisedFrom: string | null, adopted: boolean | undefined): void {
  if (adopted) warn(`  ↳ ${ticketRef} is urgent, but its adopted T3 thread keeps its model`);
  else if (raisedFrom) warn(`  ↳ ${ticketRef} tier: complex (urgent, raised from ${raisedFrom})`);
}

/** The urgent note the launched line may carry: none when the launch adopted a thread, which kept its own model (OB-2075). */
export function launchedUrgentNote(urgent: UrgentTierNote | null, adopted: boolean | undefined): UrgentTierNote | null {
  return adopted ? null : urgent;
}

/**
 * `t3` launcher (1120) — open a T3 Code thread for this row and hand the ids back to the stamp.
 *
 * The repo path is resolved HERE, on the machine that owns the worktree, because T3's project is matched
 * by its `workspaceRoot` (the repo, not the `<repo>.<branch>` worktree beside it). Everything else --
 * the project, the model, the adoption of a thread a previous attempt already opened -- is
 * apps/cli/src/t3/dispatch.ts's, so there is one implementation of "which thread does this row own".
 *
 * A failure here THROWS: the drain stamps the row `failed` with T3's own reason (or the named refusal),
 * which is the same contract every other launcher has. Nothing is registered as launched on a guess.
 */
export async function t3LauncherFor(db: Database | Store, row: SpinoffRow): Promise<LaunchEffect> {
  // The thread's NAME is read here, once, where the row and the store are both at hand (1143). It is a
  // label: a ticket with no item (or no title) launches under the old `<ticket> · <branch>`.
  // OB-1970: a credit or quota refusal moves the launch to the next models profile.
  const seam = await t3Seam();
  const repoPath = await rowRepoPathFor(db, row.repo);
  const title = await ticketTitleFor(db, row.ticket_ref, row.item_id);
  // OB-2075: an urgent item launches on complex (Opus) even if the row says otherwise (a priority raised
  // after queueing, or a row queued before the rule). The stamp records the raise on the row; an adopted
  // thread keeps its own model.
  const { row: launchRow, urgent, raisedFrom } = await urgentLaunchRow(db, row);
  const outcome = await launchAcrossProfiles(launchRow, settingTierModelsOrRefuse(await settingFor(db, "spinoff_tier_models")), (models) => {
    refuseRaisedOpusHigh(launchRow, models, raisedFrom); // OB-2107
    return launchT3Spinoff(seam, launchRow, repoPath, title, models, urgent);
  });
  if (urgent) warnUrgentTier(row.ticket_ref, raisedFrom, outcome.adopted);
  warn(
    outcome.adopted
      ? `  ↳ ${row.ticket_ref} adopted T3 thread ${outcome.threadId} (a previous attempt opened it)`
      : `  ↳ ${row.ticket_ref} T3 thread: ${outcome.threadId}`,
  );
  return { t3ThreadId: outcome.threadId, t3RunId: outcome.runId, model: outcome.model, effort: outcome.effort, adopted: outcome.adopted, raised: !!urgent && !outcome.adopted };
}

/**
 * `--tier <value>` (1480): undefined when absent, the tier when it is one, and a UsageError naming the
 * tiers otherwise — never a fallback, because a guessed tier is a guessed model. Pure.
 */
export function tierFlag(raw: string | undefined): SpinoffTier | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (!isSpinoffTier(v)) throw new UsageError(tierRejection("spinoff --tier", raw));
  return v;
}

/**
 * `--effort <value>` (OB-1815): undefined when absent, the level when it is one of the five, and a UsageError
 * naming them otherwise. `ultrathink`, `ultracode`, `none`, `minimal` and `auto` are refused here. Pure.
 */
export function effortFlag(raw: string | undefined): SpinoffEffort | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (!isSpinoffEffort(v)) throw new UsageError(effortRejection("spinoff --effort", raw));
  return v;
}

/** The effort half of a queue or launch line (OB-1815): `; effort: high`, or nothing when no text is known. Pure. */
function effortNote(effort: string | null | undefined): string {
  return effort ? `; effort: ${effort}` : "";
}

/**
 * OB-2075: what an urgent ticket's tier line says. `from` is the lower tier the architect named, which was
 * raised, or null when none was named (or the named one was already complex).
 */
export interface UrgentTierNote {
  from: SpinoffTier | null;
}

/** The urgent half of a tier line: `urgent` or `urgent, raised from medium`. Pure. */
function urgentWord(note: UrgentTierNote): string {
  return note.from ? `urgent, raised from ${note.from}` : "urgent";
}

/** The tier half of the queue line (1480): `tier: simple`, `tier: medium (default)`, or `tier: complex (urgent, raised from medium)` (OB-2075). */
function tierNote(tier: string | null, defaulted: boolean, urgent?: UrgentTierNote | null): string {
  if (urgent) return `tier: ${tier ?? "complex"} (${urgentWord(urgent)})`;
  return `tier: ${tier ?? DEFAULT_SPINOFF_TIER}${defaulted && (tier ?? DEFAULT_SPINOFF_TIER) === DEFAULT_SPINOFF_TIER ? " (default)" : ""}`;
}

/**
 * The line `ob spinoff <ref>` prints, local and over the API alike (1480 adds the tier). `(default)` only
 * on a NEW row queued without --tier: a deduped row keeps whatever it was rated, which this call did not
 * decide.
 */
export function renderQueuedLine(row: SpinoffRow, deduped: boolean, tierNamed: boolean, urgent?: UrgentTierNote | null): string {
  const tier = tierNote(row.tier, !tierNamed && !deduped, urgent);
  if (deduped) return `already queued: ${row.ticket_ref} (#${row.id}); ${tier}${effortNote(row.effort)}`;
  return `queued ${row.ticket_ref} → ${row.branch} (#${row.id})${row.launcher ? ` via ${row.launcher}` : ""}; ${tier}${effortNote(row.effort)}; 'ob spinoff drain' launches it`;
}

/** The line a bare `ob spinoff <ref>` prints once its thread is open (1589), local, split and API alike. */
export function renderLaunchedLine(row: SpinoffRow, threadId: string | null, model: string | null, deduped: boolean, tierNamed: boolean, effort?: string | null, urgent?: UrgentTierNote | null): string {
  const tier = tierNote(row.tier, !tierNamed && !deduped, urgent);
  return `launched ${row.ticket_ref} → ${row.branch} (#${row.id}) in T3 thread ${threadId ?? "(no id)"}${model ? ` on ${model}` : ""}; ${tier}${effortNote(effort)}`;
}

/**
 * The tier → model map off the `spinoff_tier_models` setting (1480), or a THROW naming what is wrong with
 * it: the launcher's throw is what stamps the row `failed` with the reason, and a malformed map must not
 * quietly launch every tier at its default.
 */
export function tierModelsOrRefuse(raw: string | null | undefined): Record<SpinoffTier, string> {
  // OB-1969: the machine's models file wins over the setting, tier by tier; a tier it leaves out keeps the
  // setting's or the default. The file is local to the machine that launches, so this is read here and
  // never over the API. A file that does not parse refuses by name rather than launching on the defaults.
  return withProfileTiers(settingTierModelsOrRefuse(raw), activeProfile(modelsFileOrRefuse()));
}

/** `spinoff_tier_models` over the defaults, with no models-file profile laid over it (OB-1970), or a throw. */
export function settingTierModelsOrRefuse(raw: string | null | undefined): Record<SpinoffTier, string> {
  const { models, error } = parseTierModels(raw);
  if (error) throw new AppError(`${error}: fix it with \`ob config set spinoff_tier_models '<json>'\` (or set it to '' for the defaults), then re-run the drain`);
  return models;
}

/** One row of `probeArgv`'s output. */
export interface ProcessRow {
  pid: number;
  /** argv[0]: the path this process was launched as. */
  comm: string;
}

/** Parses `ps -A -o pid=,comm=` output. Unparseable lines are dropped rather than guessed at. Pure. */
export function parseProcessTable(out: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), comm: m[2]! });
  }
  return rows;
}

/**
 * Whether a table can be reasoned from AT ALL: it has to contain the process that asked. A read that
 * cannot find `ob`'s own pid is not evidence about anything, and treating it as "nothing is running" is
 * the mistake #121 is about -- `pgrep` could not find the asker either, by design, which is exactly why
 * it could not find the app. Pure given `selfPid`.
 */
export function processTableSawSelf(rows: ProcessRow[], selfPid: number): boolean {
  return rows.some((r) => r.pid === selfPid);
}

// --- process table (the cleanup's in-use check, #121/#138) ------------------
// One `ps -A -o pid=,comm=` read. Before ob 1109 this also backed the interactive app's liveness probe;
// the launcher is gone and the worktree in-use check is the only reader left.

/** How the process table is read: pid, then argv[0] as the whole rest of the line. Pure. */
export function probeArgv(): string[] {
  return ["ps", "-A", "-o", "pid=", "-o", "comm="];
}

/**
 * The process table, or null when it could not be read well enough to conclude anything from -- `ps`
 * failing, empty output, or a table without `ob`'s own pid in it. Null is the third answer, and callers
 * must not read it as "nothing is running".
 */
function processRows(): ProcessRow[] | null {
  const r = sh(probeArgv());
  if (!r.ok) return null;
  const rows = parseProcessTable(r.out ?? "");
  return processTableSawSelf(rows, process.pid) ? rows : null;
}

export type WorktreeUse =
  | { kind: "running"; pid: number; comm: string }
  | { kind: "clear" }
  | { kind: "unknown" };

function existingRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Whether any process in `rows` was launched from a path inside `worktreePath` (ob 138).
 *
 * Three answers, never two (#121): `rows === null` is UNKNOWN (the table could not be reasoned from),
 * not "nothing is running". A process counts when argv[0] is the worktree itself or a path under it
 * (canonicalised so a /var vs /private/var alias still matches). Relative argv[0] cannot be attributed
 * to a worktree and is ignored. A sibling prefix (`repo.fix-1` vs `repo.fix-10`) is not a match. Pure
 * given `rows`.
 */
export function processUsingPath(rows: ProcessRow[] | null, worktreePath: string): WorktreeUse {
  if (rows === null) return { kind: "unknown" };
  if (!worktreePath) return { kind: "clear" };
  const root = existingRealpath(worktreePath);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  for (const r of rows) {
    if (!r.comm.startsWith("/")) continue;
    const launched = existingRealpath(r.comm);
    if (launched === root || launched.startsWith(prefix)) {
      return { kind: "running", pid: r.pid, comm: r.comm };
    }
  }
  return { kind: "clear" };
}

/**
 * The tags on a spinoff row's ticket, or `[]` when it resolves to no tracker item. A `#<n>` ref goes
 * through its issue link (`ob issue link`), everything else is an ob item id. Never throws: a routing
 * decision must not be the thing that fails a drain, and an unresolvable ref simply carries no tags.
 */
export function spinoffTicketTags(db: Database, ticketRef: string): string[] {
  try {
    const num = parseIssueRef(ticketRef);
    if (num !== null) {
      const linked = sqliteItemForIssue(db, { repo: sqliteTrackerRepo(db), number: num });
      return linked ? getTagsSync(db, linked.item_id) : [];
    }
    return getTagsSync(db, ticketRef);
  } catch {
    return [];
  }
}

/**
 * The store-aware form of `spinoffTicketTags()` (337), through the one ref → item resolution (1163).
 * Same contract, including the one that matters: it never throws, so a routing decision is never the
 * thing that fails a drain.
 *
 * `itemId` is the row's RECORDED item (`spinoff.item_id`) when the caller holds the row: the identity
 * wins, because a hand-charted ticket's ref is its wayfinder number and resolving THAT reads another
 * item's tags. Without one (a row queued before 0032), the ref is resolved through `ticketItemIdFor`,
 * which knows the wayfinder mapping too.
 */
export async function spinoffTicketTagsFor(
  db: Database | Store,
  ticketRef: string,
  itemId?: string | null,
): Promise<string[]> {
  try {
    const id = itemId ?? (await ticketItemIdFor(db, ticketRef));
    return id ? await getTags(db, id) : [];
  } catch {
    return [];
  }
}

/**
 * The ob item's own TITLE for a spinoff row's ticket, or null when the ref resolves to no tracker item
 * (1143). Exactly the shape of `spinoffTicketTagsFor`, through the same resolution and with the same
 * preference for the row's recorded item — the thread's NAME must not come from an item the row does not
 * serve. Used ONCE per launch to name the T3 thread.
 *
 * Never throws: the name is a sidebar label, so an unresolvable ref leaves the launcher's old
 * `<ticket> · <branch>` title rather than failing a drain over a missing label.
 */
export async function ticketTitleFor(
  db: Database | Store,
  ticketRef: string,
  itemId?: string | null,
): Promise<string | null> {
  try {
    const id = itemId ?? (await ticketItemIdFor(db, ticketRef));
    return id ? ((await getItem(db, id))?.title ?? null) : null;
  } catch {
    return null;
  }
}

/** A launcher that reads its config through the store (337). Same effect, awaited. */
export type AsyncLauncher = (db: Database | Store, row: SpinoffRow) => Promise<LaunchEffect>;

const ASYNC_LAUNCHERS: Record<string, AsyncLauncher> = {
  // The T3 launcher (1120): opens a thread in T3 Code bound to this row's ob-owned worktree. Async and
  // store-taking like every other launcher here; the whole dispatch half lives in
  // apps/cli/src/t3/dispatch.ts, so this table stays what it always was -- one line per launch shape.
  t3: (db, row) => t3LauncherFor(db, row),
};

/** The launcher names a spinoff/agent row can be ROUTED to (#125): the keys of ASYNC_LAUNCHERS. */
export const LAUNCHER_NAMES = [T3_LAUNCHER] as const;
export type LauncherName = (typeof LAUNCHER_NAMES)[number];

export function isLauncherName(s: string): s is LauncherName {
  return (LAUNCHER_NAMES as readonly string[]).includes(s);
}

/** The launcher a new row is routed to when nothing more specific says otherwise (ob 1109; t3 since 1589). */
export const DEFAULT_LAUNCHER: LauncherName = T3_LAUNCHER;

// A launcher value existing rows RECORD but nothing can be routed to any more: `warp` (#79) and `headless`
// (1589: T3 is the only launcher). The retired interactive app's value (ob 1109) is in the same class. The registry holds real rows stamped with both,
// so those still read, render and filter as what they recorded (#125's rule: a row is never silently
// dropped for the launcher it has) and historical values are never rewritten. Routing one is what stops
// working: any value outside LAUNCHER_NAMES is rejected, and the rejection NAMES what it got.
export const LEGACY_LAUNCHER_NAMES = ["warp", "headless"] as const;

export function isLegacyLauncherName(s: string): boolean {
  return (LEGACY_LAUNCHER_NAMES as readonly string[]).includes(s);
}

/** The rejection for an unroutable `--launcher <value>`: what remains, plus why a legacy value is gone. Pure. */
export function launcherRejection(prefix: string, value: string): string {
  const legacy = isLegacyLauncherName(value)
    ? `; ${value} was retired (#79 removed warp, ob 1109 retired the interactive app, ob 1589 removed headless), though existing ${value} rows still read as ${value}`
    : "";
  return `${prefix} must be one of ${LAUNCHER_NAMES.join("|")} (got '${value}')${legacy}`;
}

/**
 * The per-repo launcher override map (#83), parsed the same defensive way as `repoCheckoutsMap`: a JSON
 * object mapping a repo's basename (its last path segment, via `lastRepoSegment`) to a launcher value.
 * A missing/malformed setting is an empty map, never a throw.
 */
function launcherByRepoMap(db: Database): Record<string, string> {
  return parseJsonMap(setting(db, "spinoff_launcher_by_repo"));
}

/** A JSON-object setting as a string map: a missing/malformed value is an empty map, never a throw. Pure. */
export function parseJsonMap(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the configured launcher's NAME. Precedence (#83): a `spinoff_launcher_by_repo` entry for
 * `repo`'s basename, if it names a known launcher, wins; otherwise fall back to the global
 * `spinoff_launcher`. A `repo` entry naming an unknown launcher is NOT a hard failure: it warns and
 * falls back to the global, same as the global's own unknown-value fallback below. Pure aside from the
 * warning, so it stays cheaply unit-testable.
 *
 * The NAME is what `launch` persists on the row (#125). Resolving it once, at launch, and storing it is
 * the whole point: these two settings change, so a launcher re-derived later describes today's config
 * rather than where the agent actually went.
 */
export function selectLauncherName(db: Database, repo?: string): LauncherName {
  return launcherNameFrom(setting(db, "spinoff_launcher"), launcherByRepoMap(db), repo);
}

/** The store-aware form of `selectLauncherName()` (337): the same precedence, both reads through the store. */
export async function selectLauncherNameFor(db: Database | Store, repo?: string): Promise<LauncherName> {
  return launcherNameFrom(
    await settingFor(db, "spinoff_launcher"),
    parseJsonMap(await settingFor(db, "spinoff_launcher_by_repo")),
    repo,
  );
}

/** The precedence rule itself, given both settings' values. Pure aside from the fallback warning. */
function launcherNameFrom(configured: string, byRepo: Record<string, string>, repo?: string): LauncherName {
  const globalName = configured || DEFAULT_LAUNCHER;
  if (repo) {
    const name = lastRepoSegment(repo);
    const mapped = byRepo[name];
    if (mapped) {
      if (isLauncherName(mapped)) return mapped;
      warn(`spinoff_launcher_by_repo: unknown launcher '${mapped}' for '${name}' — falling back to spinoff_launcher '${globalName}'`);
    }
  }
  return isLauncherName(globalName) ? globalName : DEFAULT_LAUNCHER;
}

/**
 * The launcher ONE ROW goes to. Resolution order, most specific first (#135):
 *
 *   1. the row's own recorded launcher (`ob spinoff --launcher`), a per-row decision
 *   2. `spinoff_launcher_by_repo[<repo basename>]`, when it names a known launcher (#83)
 *   3. `spinoff_launcher`, else `t3`
 *
 * Steps 2-3 are `selectLauncherName`, so this only adds the row in front of them. Routing ONE spinoff
 * elsewhere used to mean mutating the global settings around the dispatch, which is a global change for a
 * per-row decision and races anything else draining at the same time -- and because the drain re-resolved
 * from live config, restoring the setting straight after queueing silently re-routed the row back.
 *
 * A row launcher that is not a known name falls back to config rather than throwing, the same way an
 * unknown `spinoff_launcher_by_repo` entry does: the CLI rejects an unknown `--launcher` up front, so a
 * bad value here is a hand-edited row, and a resolver is the wrong place to fail a launch. A RETIRED
 * value (warp, the retired app) lands here too: it warns and falls back, so a row queued under it
 * launches -- a warning, never a wait (ob 1109).
 */
export function rowLauncherName(db: Database, row: { repo: string; launcher: string | null }): LauncherName {
  if (row.launcher) {
    if (isLauncherName(row.launcher)) return row.launcher;
    warn(`spinoff #${row.launcher}/${row.repo}: launcher '${row.launcher}' is retired — launching with the configured launcher instead`);
  }
  return selectLauncherName(db, row.repo);
}

/** The store-aware form of `rowLauncherName()` (337): the row still wins, then config through the store. */
export async function rowLauncherNameFor(
  db: Database | Store,
  row: { repo: string; launcher: string | null },
): Promise<LauncherName> {
  if (row.launcher) {
    if (isLauncherName(row.launcher)) return row.launcher;
    warn(`spinoff on ${row.repo}: launcher '${row.launcher}' is retired — launching with the configured launcher instead`);
  }
  return selectLauncherNameFor(db, row.repo);
}

/**
 * The merge-base of (branch, main) in `repo`: captured at launch/adoption time so reconcile (#61) can
 * later tell a "just launched, zero commits yet" branch apart from one that has actually done work,
 * uniformly for a fresh branch (base == its own tip) and an adopted one that already carries commits
 * (base == where it diverged from main BEFORE this agent started). Returns null on any git error;
 * reconcile treats that (persisted as a null base_sha) conservatively, see reconcileSpinoffs.
 */
function computeBaseSha(repo: string, branch: string, main: string = mainRefFor(repo)): string | null {
  const r = sh(["git", "-C", repo, "merge-base", branch, main]);
  const sha = (r.out ?? "").trim();
  return r.ok && sha ? sha : null;
}

// --- ticket/worktree leases (#97) ------------------------------------------
// Two concurrent architect sessions had no mutual exclusion over a ticket or its worktree, so one removed
// a worktree, deleted its branch and landed the ticket UNDER another session's review + gate: the
// reviewing architect's git/test output then described a state that no longer existed. The fix reuses the
// existing lease primitive (decision #37, ports) with `ticket:`/`worktree:` keys, and puts the guard on
// the paths that actually destroy or finalise: launch, reconcile (marks landed), cleanup (removes the
// worktree, deletes the branch). A LIVE foreign holder is never stomped, not even with --force; an
// EXPIRED one is reclaimed silently (TTL, so a dead session cannot wedge a ticket forever).

/** How long a launched agent holds its ticket + worktree (matches the agent registry's TTL). */
const AGENT_LEASE_TTL_S = 900;

/** The lease keys covering one spinoff row's contended resources: its ticket AND its worktree. Pure. */
export function spinoffLeaseKeys(row: { ticket_ref: string; worktree: string; trial_leg?: string | null }): Array<string | null> {
  // OB-1991: a trial's leg b holds `ticket:<ref>-b`, so the two legs of a pair never contend for one key.
  return [ticketLeaseKey(legRef(row.ticket_ref, row.trial_leg)), worktreeLeaseKey(row.worktree)];
}

/**
 * Every lease key a row's launch claims: `spinoffLeaseKeys`, plus the machine-wide `flake:slot` when the row's
 * item is at priority `flake` and no `--no-flake-slot` released it (OB-2230).
 */
export async function rowLeaseKeys(
  db: Database | Store,
  row: { id: number; ticket_ref: string; worktree: string; item_id?: string | null; trial_leg?: string | null },
): Promise<Array<string | null>> {
  return [...spinoffLeaseKeys(row), await flakeSlotKeyFor(db, row)];
}

/** A path/row skipped because another live session holds its lease. Reported, never silent. */
export interface LeaseBlocked {
  ticket: string;
  resource: string;
  holder: string;
}

/**
 * The subset of `keys` this launch must CLAIM: every key except the ones `under` already holds LIVE
 * (#136, following #75's `agent register --holder`). A hold of the caller's own is compatible, not a
 * collision, and it is LEFT EXACTLY AS IT IS rather than re-taken: re-taking it would move the key to the
 * agent's id and shorten the architect's TTL to the agent's, and only a lease's holder should heartbeat it.
 *
 * An empty `under` claims everything, which is the unchanged default. Reads liveness before the claim the
 * same non-transactional way `agent register --holder` does, for the same reason: the alternative is
 * teaching the shared `acquireLeases` primitive about a second holder.
 */
export async function launchClaimKeys(
  db: Database | Store,
  keys: Array<string | null>,
  under: string,
): Promise<Array<string | null>> {
  if (!under) return keys;
  const s = asStore(db);
  const kept: Array<string | null> = [];
  for (const k of keys) {
    if (!k) {
      kept.push(k);
      continue;
    }
    if ((await liveHold(s, k))?.holder !== under) kept.push(k);
  }
  return kept;
}

/** What the LOCAL half of a launch resolved before spawning: the stamp persists it, here or there. */
export interface LaunchPrep {
  worktree: string;
  base_sha: string | null;
  launcher: LauncherName;
  engine: Engine;
}

/**
 * The part of a launch that reads THIS machine: the worktree (created or adopted, #61) and the base sha
 * of its branch. Mutates `row` so the launcher sees the resolved worktree, and returns what the stamp has
 * to write. It does NOT write, because after the cutover (191) the database is on another machine and
 * `db` here is a read-only replica: everything it resolves crosses the wire in the stamp instead.
 */
async function prepareLaunch(db: Database | Store, row: SpinoffRow): Promise<LaunchPrep> {
  // 217: a row queued through a server carries a repo SLUG, and the checkout it names is on THIS machine,
  // so the path is derived here. Its worktree is derived here for the same reason — `<slug>.<branch>` is a
  // relative path, and only the machine with the checkout can make it absolute.
  // Resolve the launcher ONCE (#125) before spawning, so a row that fails to launch still records where
  // it was headed, and nothing has to re-derive it from config later. The row's own `--launcher` (#135)
  // wins over config, see rowLauncherName. The ENGINE is resolved the same way and for the same reason:
  // it cannot be re-derived at land time, or a flipped setting would read a claude transcript (or worse,
  // an opencode one) for a launch that ran under the other harness.
  return prepareLaunchWith(await rowRepoPathFor(db, row.repo), await rowLauncherNameFor(db, row), await spinoffEngineFor(db), row);
}

/**
 * The machine half of `prepareLaunch`, given the three facts that came from the database (the row's repo
 * as a path here, its resolved launcher, and its resolved engine). 360 pulled it out so an API client,
 * which holds the config rather than the store, prepares a launch exactly the way the store-backed drain
 * does.
 */
export function prepareLaunchWith(repo: string, launcherName: LauncherName, engine: Engine, row: SpinoffRow): LaunchPrep {
  const worktree = row.worktree && isAbsolute(row.worktree) ? row.worktree : worktreePath(repo, worktreeKeyOf(row));
  const resolvedWorktree = ensureWorktree({ ...row, repo, worktree }); // may differ from row.worktree when an existing worktree was adopted (#61)
  installRepoWiring(projectSlugOf(row.repo), resolvedWorktree);
  const baseSha = computeBaseSha(repo, row.branch);
  row.worktree = resolvedWorktree;
  if (baseSha) row.base_sha = baseSha;
  row.launcher = launcherName;
  row.engine = engine;
  return { worktree: resolvedWorktree, base_sha: baseSha, launcher: launcherName, engine };
}

// --- the drain's three steps: CLAIM, launch, STAMP (191) ----------------------
//
// 189 could not put `spinoff drain` in the split class because its database half was a per-row
// claim/lease/launch/stamp pass in ONE sweep, so it refused it instead -- which would have stopped the
// 45s drain job dead at cutover. The sweep is separated here into two things that can each cross the
// wire (`ob spinoff claim` and `ob spinoff stamp`) with the launch itself, which needs the tabs and the
// process table, staying on this machine in between.
//
// THE CLAIM IS THE EXCLUSION, so it goes FIRST, against 189's local-half-first rule (see
// `splitPartialFailure` for why that exception is the safe direction here). It must be atomic in the
// strong sense: two drains that both read "pending" and then both write "launching" would each open a
// tab for the same row, and two Claude sessions in one worktree cannot be undone by an error message.
// So the claim is ONE conditional statement -- `UPDATE ... SET status='launching' WHERE id=? AND
// status='pending' RETURNING *` -- and SQLite serialises writers, so exactly one drain gets a row back
// and every other gets nothing. There is no read-then-write window for a second drain to interleave with.
//
// CRASH RECOVERY is the price of splitting the pass, and it is paid with a lease rather than a new
// column. A claim takes `spinoff:<id>` under the row's branch for CLAIM_TTL_S, and the stamp releases it,
// so a machine that dies between claim and stamp leaves a row that is `launching` with a lease that
// simply LAPSES. `ob spinoff reclaim` (run at the head of every drain, and available by hand) puts such a
// row back to `pending`, bounded by #151's MAX_LAUNCH_ATTEMPTS so a deterministic crash cannot relaunch
// forever. Reusing the lease table is what keeps the fix additive: the claim IS a lease, it already has a
// TTL, an owner and an expiry, and the alternative was a migration adding claimed_at/claimed_by to a live
// table for a fact the lease already carries.

/**
 * How long a claim is good for before `spinoff reclaim` may take the row back. Far longer than any real
 * claim-to-stamp window, and the launch heartbeats its claim (OB-1921) so a slow launcher keeps it; far
 * shorter than a human noticing a stuck row. The window matters because reclaiming a row whose drain
 * is merely SLOW is itself a double-launch, so the TTL is what makes the reaper safe rather than racy.
 */
export const CLAIM_TTL_S = 300;

/** The lease key that IS the claim on one spinoff row: taken by `claim`, released by `stamp`. */
export function spinoffClaimKey(id: number): string {
  return `spinoff:${id}`;
}

export interface ClaimOutcome {
  /** The row this machine now owns, or null when another drain got there first. */
  claimed: SpinoffRow | null;
  /** With `claimed`: not launchable (a live foreign hold on its ticket/worktree), and the drain stamps it failed.
   *  With `claimed: null`: the claim lease could not be taken, so the row stays pending (OB-1921). */
  error: string | null;
  /** The server could not be asked at all, so NOTHING was claimed and the sweep stops. */
  remoteError: string | null;
}

export interface StampInput {
  id: number;
  outcome: "launched" | "failed";
  worktree?: string | null;
  base_sha?: string | null;
  launcher?: string | null;
  session_id?: string | null;
  engine?: string | null;
  /** 1120: the T3 thread (and run) a `t3` launch opened, or ADOPTED from a previous attempt. */
  t3_thread_id?: string | null;
  t3_run_id?: string | null;
  /** 1480: the model that T3 launch ran on (the tier's, or an adopted thread's own). */
  model?: string | null;
  /** OB-1815: the effort text the launch ran at (`high`, `default (high)`, `default (none listed)`). */
  effort?: string | null;
  /** OB-2075: the launch ran an urgent item on complex (not an adopted thread), so the host records the row as complex. */
  raised?: boolean;
  error?: string | null;
  /** 1515: why this stamp (a `--note` from the caller), recorded on the row's item. */
  decision?: DecisionOpts;
}

/** A row `reclaim` took back from a machine that claimed it and never came back. */
export interface ReclaimEntry {
  id: number;
  ticket: string;
  status: "pending" | "failed";
  attempts: number;
}

/**
 * The database half of the three sweeps, as steps that can each run HERE or on the server. With no
 * server every step is the direct write it has always been, which is what keeps inert mode identical and
 * what makes the SAME code correct when the server itself runs the sweep.
 */
export interface SpinoffSteps {
  reclaim(): Promise<{ entries: ReclaimEntry[]; remoteError: string | null }>;
  claim(row: SpinoffRow): Promise<ClaimOutcome>;
  /** Returns null when applied, else the failure ready to print. */
  stamp(input: StampInput): Promise<string | null>;
  /** Retire a merged row (`reconcile`): status, token totals, agent deregistration. Null when applied. */
  land(input: { id: number; tokens: TokenUsage }): Promise<string | null>;
  /** `cleanup`'s database half: the swept branch's agent row and its leases. */
  agentDone(id: string): Promise<{ done: boolean; error: string | null }>;
  /** OB-1921: refresh the row's claim lease while its launch runs, so a slow launch is not reclaimed. */
  heartbeatClaim(row: SpinoffRow): Promise<void>;
}

/** OB-1921: how often a running launch refreshes its claim lease: three beats inside one CLAIM_TTL_S. */
export const CLAIM_HEARTBEAT_MS = Math.floor((CLAIM_TTL_S * 1000) / 3);

/**
 * Run `launch` while `beat` refreshes the claim every `intervalMs` (OB-1921). A beat that fails is
 * ignored: the next one tries again, and a claim that does lapse is what `reclaim` is for. The timer is
 * always cleared, whether the launch resolves or throws.
 */
export async function withClaimHeartbeat<T>(
  beat: () => Promise<unknown>,
  launch: () => Promise<T>,
  intervalMs: number = CLAIM_HEARTBEAT_MS,
): Promise<T> {
  const timer = setInterval(() => {
    beat().catch(() => undefined);
  }, intervalMs);
  try {
    return await launch();
  } finally {
    clearInterval(timer);
  }
}

/** The message a launch refused by a live foreign hold reports, unchanged since #75/#97. */
function leaseUnavailableMessage(hold: LeaseHold): string {
  return `lease unavailable: ${formatHold(hold)}. If that holder is you, drain under it with --holder ${hold.holder}; otherwise wait for it, and 'ob lease release ${hold.resource} --force' ONLY if that holder is gone`;
}

/**
 * Claim ONE pending row for this machine: the atomic conditional update above, then the ticket/worktree
 * leases the launch runs under. Runs against the authoritative database, which after the cutover means
 * it runs on the server as `ob spinoff claim`.
 *
 * The claim lease is taken BEFORE the row moves, and a lease that cannot be taken leaves the row pending
 * (OB-1921), so every `launching` row this produced has a claim on record. A row without one (from before
 * 191, or moved by hand) is reclaimed once it is older than the claim TTL. Taking it first is free -- it
 * is keyed by row id and held under the branch, so a drain that then LOSES the conditional update has
 * merely refreshed a lease under the same holder the winner uses.
 */
export async function claimSpinoffRow(db: Database | Store, id: number, under = ""): Promise<ClaimOutcome> {
  const s = asStore(db);
  const pendings = (await s.q
    .select()
    .from(s.t.spinoff)
    .where(and(eq(s.t.spinoff.id, id), eq(s.t.spinoff.status, "pending")))
    .limit(1)) as SpinoffRow[];
  const pending = pendings[0];
  if (!pending) return { claimed: null, error: null, remoteError: null };
  // OB-1921: a claim lease that cannot be taken leaves the row `pending`. Moving it to `launching` with no
  // claim on record is what used to strand a row there.
  const claimLease = await acquireLeases(s, [spinoffClaimKey(id)], pending.branch, CLAIM_TTL_S);
  if (!claimLease.ok) return { claimed: null, error: leaseUnavailableMessage(claimLease.hold), remoteError: null };
  // Still ONE conditional statement, so the atomicity the comment above rests on is unchanged: sqlite
  // serialises writers and Postgres takes a row lock on the UPDATE, so exactly one drain gets a row back.
  // OB-1920: through the transition table, and a lost claim is still a null, never a throw.
  // OB-1921: the claim is THE launch attempt, so it is the one place `launch_attempts` is counted, and
  // `launched_at` records when that attempt started (the stamp overwrites it with the launch time), which
  // is what lets `reclaim` age a `launching` row whose claim lease has gone.
  let row: SpinoffRow;
  try {
    row = await moveSpinoff(
      s,
      id,
      "launching",
      { launch_attempts: (pending.launch_attempts ?? 0) + 1, launched_at: nowIso() },
      ["pending"],
    );
  } catch (e) {
    if (e instanceof SpinoffTransitionRefused) return { claimed: null, error: null, remoteError: null };
    throw e;
  }
  // Claim the ticket + worktree BEFORE spawning, under the agent id the registry uses (the branch in OmniSlash,
  // the lowercase ref in a clean repo, OB-1992), so the spawned agent's own `ob agent register --id <that id>`
  // refreshes the same keys rather than colliding with them. The drain pre-checks too; this is the
  // authoritative, transactional claim.
  // OB-2230: a `flake` row also takes the machine-wide `flake:slot`, in the SAME transaction, so a second flake
  // fix is refused here as atomically as a second builder on one ticket.
  const keys = await launchClaimKeys(s, await rowLeaseKeys(s, row), under);
  const claimed = await acquireLeases(s, keys, builderIdOf(row), AGENT_LEASE_TTL_S);
  if (!claimed.ok) {
    const error =
      claimed.hold.resource === FLAKE_SLOT_KEY
        ? `${flakeSlotHeldMessage(claimed.hold.holder, await flakeSlotRefFor(s, claimed.hold.holder))}; 'ob lease release ${FLAKE_SLOT_KEY} --force' ONLY if that holder is gone`
        : leaseUnavailableMessage(claimed.hold);
    return { claimed: row, error, remoteError: null };
  }
  // The slot outlives a builder's 900 s agent TTL between beats: a fix loops a test for hours. Same holder, so
  // this only moves its TTL; `ob agent heartbeat` keeps it alive after that.
  if (keys.includes(FLAKE_SLOT_KEY)) await acquireLeases(s, [FLAKE_SLOT_KEY], builderIdOf(row), FLAKE_SLOT_TTL_S);
  return { claimed: row, error: null, remoteError: null };
}

/**
 * Record the outcome of a launch this machine performed. `launched` is the ordinary end of the pass;
 * `failed` is a launcher that threw, and it still writes what the local half resolved (worktree, base
 * sha, launcher) so a row that failed to launch records where it was headed, exactly as it did when the
 * whole sweep ran in one place.
 */
export async function stampSpinoff(db: Database | Store, input: StampInput): Promise<void> {
  const s = asStore(db);
  const rows = (await s.q.select().from(s.t.spinoff).where(eq(s.t.spinoff.id, input.id)).limit(1)) as SpinoffRow[];
  const row = rows[0];
  if (!row) throw new AppError(`no spinoff #${input.id}`);
  // 384: the TUI exists only AFTER the first launched stamp, so a later pass writes the captured
  // opencode id onto an already-launched row. That must not increment launch_attempts or re-register.
  if (row.status === "launched" && input.outcome === "launched" && input.session_id) {
    await moveSpinoff(s, row.id, "launched", { session_id: input.session_id }, ["launched"]);
    await registerAgent(s, {
      id: builderIdOf(row),
      ticket: legRef(row.ticket_ref, row.trial_leg),
      branch: row.branch,
      sessionId: input.session_id,
      ttlS: AGENT_LEASE_TTL_S,
    });
    return;
  }
  const resolved: Partial<SpinoffRow> = {};
  if (input.worktree) resolved.worktree = input.worktree;
  if (input.base_sha) resolved.base_sha = input.base_sha;
  if (input.launcher) resolved.launcher = input.launcher;
  if (input.session_id) resolved.session_id = input.session_id;
  if (input.engine) resolved.engine = input.engine;
  // 1120: a T3 launch records the thread it opened -- or ADOPTED, which is the retry case: the ids are
  // what the NEXT attempt needs to find the thread instead of opening a second one. Written on the
  // `failed` path too (a stamp that failed after the thread existed still leaves the ids to be found by
  // adoption, and the row's own error says what happened).
  if (input.t3_thread_id) resolved.t3_thread_id = input.t3_thread_id;
  if (input.t3_run_id) resolved.t3_run_id = input.t3_run_id;
  if (input.model) resolved.model = input.model;
  // OB-1815: the launch's final effort text replaces the level --effort named at queue, as the model is stamped.
  if (input.effort) resolved.effort = input.effort;
  // OB-2075: the launch says whether it ran an urgent item on complex (`raised`), so the row records what ran, not a fresh read of the priority.
  if (input.outcome === "launched" && input.raised) resolved.tier = "complex";
  if (input.outcome === "launched") {
    // OB-1920: only a claimed (`launching`) row is launched; a pending row is claimed first, and a merged or
    // failed one is never brought back.
    await moveSpinoff(
      s,
      row.id,
      "launched",
      { ...resolved, agent_id: builderIdOf(row), launched_at: nowIso() }, // OB-1921: the attempt was counted at the claim
      ["launching"],
    );
    // 1189: NO workflow word is claimed here. `launching` was the launcher's honest bookend (#146), and
    // it is a LAUNCHER word that left `agent.status` when the vocabulary split — the spinoff row already
    // carries it (`SPINOFF_STATUSES`), and the agent row does not need a second copy. So the row is
    // created for the tree/lease with NO status at all, and the agent's own first
    // `ob agent register --status <s>` is what puts a workflow word on it. The row reads `-` until then,
    // which is the honest thing for a launch nothing has confirmed.
    await registerAgent(s, {
      id: builderIdOf(row),
      ticket: legRef(row.ticket_ref, row.trial_leg),
      worktree: input.worktree ?? row.worktree,
      branch: row.branch,
      status: null,
      launcher: input.launcher ?? row.launcher ?? undefined,
      // 1120: the id that lets a human REOPEN this launch. For `t3` it is the thread id (the agent's
      // session_id column is the same idea — "the id that lets a human reopen the session" — and a
      // second column would be a second truth). A t3 row's own `session_id` column stays NULL: it is
      // the Claude Code session, and the thread lives in `t3_thread_id` where reconcile reads it.
      sessionId: input.session_id ?? input.t3_thread_id ?? undefined,
      ttlS: AGENT_LEASE_TTL_S,
    });
  } else {
    // OB-1920: any live row may fail (drain, spike end, abandon from pending); a merged or failed one may not.
    await moveSpinoff(s, row.id, "failed", { ...resolved, error: (input.error ?? "").slice(0, 500) });
    // OB-2230: a failed row frees the one flake slot now, not after its 6 hour TTL, so the next flake dispatches.
    await releaseLease(s, FLAKE_SLOT_KEY, builderIdOf(row));
  }
  // The claim is answered either way, so nothing has to wait for its TTL to know this row is settled.
  await releaseLease(s, spinoffClaimKey(row.id), row.branch);
  // 1515: the row's own move, on its item's trail — queued/launching -> building/landed.
  await recordRowDecision(
    s,
    row,
    spinoffStatusWord(row.status),
    spinoffStatusWord(input.outcome === "launched" ? "launched" : "failed"),
    input.decision,
  );
}

/**
 * Take back the rows claimed by a machine that never came back: `launching`, and either its claim lease
 * is recorded and expired (nobody is still launching it; a live launch heartbeats it, OB-1921), or no
 * claim lease is recorded at all and the row is older than the claim TTL (OB-1921: a row moved by hand,
 * one from before 191, or one whose claim lease was released under it; left alone, it is stuck forever).
 * Bounded by #151's retry count, which the claim counted (OB-1921), because the crash may well be
 * deterministic and an unbounded re-enqueue would relaunch it forever.
 */
export async function reclaimSpinoffs(db: Database | Store): Promise<ReclaimEntry[]> {
  const s = asStore(db);
  const nowMs = Date.now(); // one instant for both the hold's expiry and the row's age
  const entries: ReclaimEntry[] = [];
  const rows = (await s.q.select().from(s.t.spinoff).where(eq(s.t.spinoff.status, "launching"))) as SpinoffRow[];
  for (const row of rows) {
    const hold = await recordedHold(s, spinoffClaimKey(row.id), nowMs);
    let error: string;
    if (hold) {
      if (!hold.expired) continue;
      error = `claimed by ${hold.holder} at ${hold.since ?? "unknown"} and never stamped: the drain that claimed it did not come back`;
    } else {
      const since = row.launched_at ?? row.request_at;
      const sinceMs = new Date(since).getTime();
      if (Number.isFinite(sinceMs) && nowMs - sinceMs <= CLAIM_TTL_S * 1000) continue;
      error = `launching since ${since} with no claim on record and never stamped`;
    }
    const attempts = Math.max(row.launch_attempts ?? 0, 1); // a pre-OB-1921 claim did not count itself
    const retrying = attempts < MAX_LAUNCH_ATTEMPTS;
    try {
      if (retrying) {
        await moveSpinoff(s, row.id, "pending", { error, agent_id: null, launched_at: null, launch_attempts: attempts }, ["launching"]);
      } else {
        await moveSpinoff(s, row.id, "failed", { error, launch_attempts: attempts }, ["launching"]);
      }
    } catch (e) {
      if (e instanceof SpinoffTransitionRefused) continue; // stamped since it was read: not abandoned after all
      throw e;
    }
    // nothing is running under them, so holding them only blocks the retry (the claim is the branch's, the rest the builder's)
    for (const h of new Set([row.branch, builderIdOf(row)])) await releaseLeasesByHolder(s, h);
    entries.push({ id: row.id, ticket: row.ticket_ref, status: retrying ? "pending" : "failed", attempts });
  }
  return entries;
}

/** Retire a merged row: its status, the token totals recovered from its transcript, and its agent (#55). */
export async function landSpinoff(db: Database | Store, id: number, usage: TokenUsage, decision: DecisionOpts = {}): Promise<void> {
  const s = asStore(db);
  const rows = (await s.q.select().from(s.t.spinoff).where(eq(s.t.spinoff.id, id)).limit(1)) as SpinoffRow[];
  const row = rows[0];
  if (!row) throw new AppError(`no spinoff #${id}`);
  // OB-1920: only a building or handed-off row lands; a queued or launching one has nothing to land.
  // OB-1993: a zero read (a machine with no transcripts) never overwrites a count the row already has.
  const keep = usage.totalTokens === 0 && (row.total_tokens ?? 0) > 0;
  await moveSpinoff(s, row.id, "merged", keep ? {} : tokenColumns(usage));
  await recordRowDecision(s, row, spinoffStatusWord(row.status), spinoffStatusWord("merged"), decision);
  await finishAgent(s, builderIdOf(row)); // 341: does not drop an architect hold the builder inherited
  await noteTrialLanded(s, row.id); // OB-1991: a trial winner's launch to landed
}

/** The five token columns of a row, from a usage. Pure. */
function tokenColumns(usage: TokenUsage): Partial<SpinoffRow> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_creation_tokens: usage.cacheCreationTokens,
    cache_read_tokens: usage.cacheReadTokens,
    total_tokens: usage.totalTokens,
  };
}

/**
 * OB-1993: the token-only write for backfill. Sets the five token columns of a row that is already landed and
 * records no count yet; any other row is refused by name. It never changes a status and never touches a row
 * that has a count, so it cannot undo a land or overwrite a real reading.
 */
export async function recordSpinoffTokens(db: Database | Store, id: number, usage: TokenUsage): Promise<SpinoffRow> {
  const s = asStore(db);
  const rows = (await s.q
    .update(s.t.spinoff)
    .set(tokenColumns(usage))
    .where(
      and(
        eq(s.t.spinoff.id, id),
        eq(s.t.spinoff.status, "merged"),
        or(isNull(s.t.spinoff.total_tokens), eq(s.t.spinoff.total_tokens, 0)),
      ),
    )
    .returning()) as SpinoffRow[];
  if (rows[0]) return rows[0];
  const row = await getSpinoffRow(s, id);
  if (!row) throw new AppError(`no spinoff #${id}`);
  if (row.status !== "merged") {
    throw new AppError(`spinoff #${id} (${row.ticket_ref}) is ${spinoffStatusWord(row.status)}, not landed; only a landed row takes a token backfill`);
  }
  throw new AppError(`spinoff #${id} (${row.ticket_ref}) already records ${row.total_tokens} tokens; a backfill never overwrites a count`);
}

/** One row a backfill looked at (OB-1993). */
export interface BackfillEntry {
  id: number;
  ticket: string;
  tokens: TokenUsage;
  /** recorded: written · would-record: --dry-run · unrecoverable: nothing readable here · failed: the write was refused */
  outcome: "recorded" | "would-record" | "unrecoverable" | "failed";
  error?: string;
}

/** The landed rows with no token count, landed on or after `since` when given. Pure. */
function rowsMissingTokens(rows: SpinoffRow[], since: string | null = null): SpinoffRow[] {
  return rows.filter((r) => {
    if (r.status !== "merged" || (r.total_tokens ?? 0) > 0) return false;
    if (!since) return true;
    const at = new Date(r.launched_at ?? r.request_at).getTime();
    return Number.isFinite(at) && at >= Date.parse(since);
  });
}

/**
 * `ob spinoff tokens backfill` (OB-1993): read each landed row with no count on THIS machine and record the non-zero
 * reads. The reader and the writer are injected: locally the writer is `recordSpinoffTokens`, over the API it is the
 * tokens endpoint. A row that reads zero is reported as not recoverable, never written.
 */
export async function backfillSpinoffTokens(
  rows: SpinoffRow[],
  deps: { read: (row: SpinoffRow) => TokenUsage; record: (id: number, usage: TokenUsage) => Promise<unknown> },
  opts: { since?: string | null; dryRun?: boolean } = {},
): Promise<BackfillEntry[]> {
  const out: BackfillEntry[] = [];
  for (const row of rowsMissingTokens(rows, opts.since ?? null)) {
    const tokens = deps.read(row);
    const base = { id: row.id, ticket: row.ticket_ref, tokens };
    if (tokens.totalTokens <= 0) {
      out.push({ ...base, outcome: "unrecoverable" });
      continue;
    }
    if (opts.dryRun) {
      out.push({ ...base, outcome: "would-record" });
      continue;
    }
    try {
      await deps.record(row.id, tokens);
      out.push({ ...base, outcome: "recorded" });
    } catch (e) {
      out.push({ ...base, outcome: "failed", error: (e as Error).message });
    }
  }
  return out;
}

/** The backfill's report: one line per row, then a tally. Pure. */
export function renderBackfill(entries: BackfillEntry[], json: boolean): string {
  if (json) return JSON.stringify(entries, null, 2);
  if (entries.length === 0) return "no landed row is missing its token count";
  const words: Record<BackfillEntry["outcome"], string> = {
    recorded: "recorded",
    "would-record": "would record",
    unrecoverable: "not recoverable (nothing readable on this machine)",
    failed: "failed",
  };
  const lines = entries.map((e) => {
    const count = e.tokens.totalTokens > 0 ? ` ${formatTokens(e.tokens.totalTokens)} tok` : "";
    return `  #${e.id} ${e.ticket}: ${words[e.outcome]}${count}${e.error ? `: ${e.error}` : ""}`;
  });
  const n = (o: BackfillEntry["outcome"]) => entries.filter((e) => e.outcome === o).length;
  const tally = [
    n("recorded") ? `${n("recorded")} recorded` : "",
    n("would-record") ? `${n("would-record")} would record (dry run)` : "",
    n("unrecoverable") ? `${n("unrecoverable")} not recoverable` : "",
    n("failed") ? `${n("failed")} failed` : "",
  ].filter(Boolean);
  return [...lines, tally.join(", ")].join("\n");
}

/**
 * OB-1991: what a trial verdict does to the losing leg's row, on the host with the store: `failed` with
 * "abandoned: lost trial pair <n>" (so `spinoff mix` reads it as retired, not a failed launch), and its
 * builder's own leases released. The PR is the architect's to close (ob-land).
 */
export function trialStoreDeps(db: Database | Store): TrialDeps {
  return {
    retire: async (row, error) => {
      await moveSpinoff(db, row.id, "failed", { error: abandonedError(error) });
      await finishAgent(db, builderIdOf(row));
    },
  };
}

/** The steps applied straight to `db`: no server configured, or this IS the server. */
export function localSpinoffSteps(db: Database | Store, under = "", decision: DecisionOpts = {}): SpinoffSteps {
  return {
    reclaim: async () => ({ entries: await reclaimSpinoffs(db), remoteError: null }),
    claim: (row) => claimSpinoffRow(db, row.id, under),
    heartbeatClaim: async (row) => {
      // OB-1922: a beat never revives a lapsed claim, so a launch that outlived its claim takes it again
      // with a fresh acquire (refused if anyone else holds it live), which keeps reclaim off it
      await heartbeatOrReacquire(db, spinoffClaimKey(row.id), row.branch, CLAIM_TTL_S);
    },
    stamp: async (input) => {
      // 1515: the drain's --note/--holder travel with every stamp it makes, not just its land, so a
      // queued -> building launch the drain caused says so. An input that names its own decision wins.
      // OB-1920: a refused transition comes back as the step's error string, like a remote refusal does.
      try {
        await stampSpinoff(db, { ...input, decision: input.decision ?? decision });
        return null;
      } catch (e) {
        if (e instanceof SpinoffTransitionRefused) return e.message;
        throw e;
      }
    },
    land: async (input) => {
      // Reconcile retires a merged row on nobody's say-so, so its trail entry names the actor it ran under.
      try {
        await landSpinoff(db, input.id, input.tokens, { ...decision, actor: decision.actor ?? (under || "reconcile") });
        return null;
      } catch (e) {
        if (e instanceof SpinoffTransitionRefused) return e.message;
        throw e;
      }
    },
    agentDone: async (id) => {
      const { done } = await finishAgent(db, id); // 341: releases only this agent's own leases
      return { done, error: null };
    },
  };
}

/** Parse a sub-invocation's `--json` answer, turning a garbled one into a message rather than a throw. */
function parseStepAnswer<T>(argv: string[], stdout: string): { value: T | null; error: string | null } {
  try {
    return { value: JSON.parse(stdout) as T, error: null };
  } catch {
    return { value: null, error: `'ob ${argv.join(" ")}' did not answer with JSON: ${stdout.trim().slice(0, 200)}` };
  }
}

/** The steps as `ob` sub-invocations on the server: the DB half of the split (189's RemoteWriter seam). */
export function remoteSpinoffSteps(remote: RemoteWriter, under = "", decision: DecisionOpts = {}): SpinoffSteps {
  const holderArgs = under ? ["--holder", under] : [];
  return {
    reclaim: async () => {
      const argv = ["spinoff", "reclaim", "--json"];
      const outcome = remote.write(argv);
      if (!outcome.ok) return { entries: [], remoteError: outcome.message };
      const parsed = parseStepAnswer<{ reclaimed: ReclaimEntry[] }>(argv, outcome.stdout);
      if (!parsed.value) return { entries: [], remoteError: parsed.error };
      return { entries: parsed.value.reclaimed ?? [], remoteError: null };
    },
    claim: async (row) => {
      const argv = ["spinoff", "claim", "--id", String(row.id), ...holderArgs, "--json"];
      const outcome = remote.write(argv);
      if (!outcome.ok) return { claimed: null, error: null, remoteError: outcome.message };
      const parsed = parseStepAnswer<{ claimed: SpinoffRow | null; error: string | null }>(argv, outcome.stdout);
      if (!parsed.value) return { claimed: null, error: null, remoteError: parsed.error };
      return { claimed: parsed.value.claimed, error: parsed.value.error, remoteError: null };
    },
    heartbeatClaim: async (row) => {
      const beat = remote.write(["lease", "heartbeat", spinoffClaimKey(row.id), "--holder", row.branch, "--json"]);
      // OB-1922: a lapsed claim is not revived by a beat; take it again with a fresh acquire. Only on the
      // expiry refusal, as the local and API paths do: a claim reclaim released stays released.
      const expired = !beat.ok && parseStepAnswer<{ error?: string }>(["lease", "heartbeat"], beat.stdout).value?.error === "LeaseExpiredError";
      if (expired) remote.write(["lease", "acquire", spinoffClaimKey(row.id), "--holder", row.branch, "--ttl", String(CLAIM_TTL_S)]);
    },
    stamp: async (input) => {
      const outcome = remote.write(stampArgv({ ...input, decision: input.decision ?? decision }));
      return outcome.ok ? null : outcome.message;
    },
    land: async (input) => {
      // 1515: the note the sweep was given travels with its retire; the server records it on the item.
      const outcome = remote.write(landArgv(input.id, input.tokens, decision));
      return outcome.ok ? null : outcome.message;
    },
    agentDone: async (id) => {
      const argv = ["agent", "done", id, ...decisionArgs(decision), "--json"];
      const outcome = remote.write(argv);
      if (!outcome.ok) return { done: false, error: outcome.message };
      const parsed = parseStepAnswer<{ done: boolean }>(argv, outcome.stdout);
      if (!parsed.value) return { done: false, error: parsed.error };
      return { done: parsed.value.done === true, error: null };
    },
  };
}

/** The stamp as an argv, so the partial-failure message can name the exact command that finishes the job. */
export function stampArgv(input: StampInput): string[] {
  const argv = ["spinoff", "stamp", "--id", String(input.id), "--outcome", input.outcome];
  if (input.worktree) argv.push("--worktree", input.worktree);
  if (input.base_sha) argv.push("--base-sha", input.base_sha);
  if (input.launcher) argv.push("--launcher", input.launcher);
  if (input.session_id) argv.push("--session", input.session_id);
  if (input.engine) argv.push("--engine", input.engine);
  if (input.t3_thread_id) argv.push("--t3-thread", input.t3_thread_id);
  if (input.t3_run_id) argv.push("--t3-run", input.t3_run_id);
  if (input.model) argv.push("--model", input.model);
  if (input.effort) argv.push("--effort", input.effort); // OB-1815: the text a launch stamped, e.g. 'default (high)'
  if (input.raised) argv.push("--raised");
  if (input.error) argv.push("--error", input.error);
  argv.push(...decisionArgs(input.decision));
  return argv;
}

/** `--note` / `--holder` for a sub-invocation that must record a decision (1515). Empty when neither is set. */
export function decisionArgs(decision: DecisionOpts = {}): string[] {
  const args: string[] = [];
  if (decision.note) args.push("--note", decision.note);
  if (decision.actor) args.push("--holder", decision.actor);
  return args;
}

/** The land as an argv, for the same reason: a failed land must print the command that repeats it. */
export function landArgv(id: number, usage: TokenUsage, decision: DecisionOpts = {}): string[] {
  return [
    "spinoff",
    "land",
    "--id",
    String(id),
    "--input-tokens",
    String(usage.inputTokens),
    "--output-tokens",
    String(usage.outputTokens),
    "--cache-creation-tokens",
    String(usage.cacheCreationTokens),
    "--cache-read-tokens",
    String(usage.cacheReadTokens),
    "--total-tokens",
    String(usage.totalTokens),
    ...decisionArgs(decision),
  ];
}

/** A row left pending because its launcher cannot start anything yet (#118). Reported, never silent. */
export interface LaunchNotReady {
  ticket: string;
  reason: string;
}

/**
 * Why a pending row cannot launch RIGHT NOW, or null when it can. Checked BEFORE the row is claimed, so
 * a not-ready row stays `pending` (like the lease pre-check) and a later drain launches it by itself,
 * strictly better than `failed`, which would need a manual re-enqueue.
 *
 * NOTHING IS NOT-READY ANY MORE (ob 1109). The one answer used to be about the interactive launcher: no
 * instance up (#118), or only the instance this row's agent would rebuild (#161), both of which deferred
 * rather than failed. With `t3` the only launcher left (1589), a row that cannot name a live launcher is a
 * bug that launches, never a wait. The seam is kept (like `launcherNameFrom`) because T3
 * can be down, and this is the one place that decision already lives.
 */
export function launchNotReady(_db: Database, _row: SpinoffRow, _opts: LaunchOpts = {}): string | null {
  return null;
}

/** The store-aware form of `launchNotReady()` (337): the same answer, both reads through the store. */
export async function launchNotReadyFor(
  _db: Database | Store,
  _row: SpinoffRow,
  _opts: LaunchOpts = {},
): Promise<string | null> {
  return null;
}

/**
 * Why a pending row must not launch because its work is already done (OB-1695): the ticket is `done`, or a
 * landing commit on `origin/main` names it after the row's `base_sha` (`workHasLanded`, the check reconcile
 * and `list --json` use). A drain once reclaimed a stale claimed-never-stamped row for a finished ticket and
 * launched a builder on it. A row with no `base_sha` yet is judged by the ticket's status alone. The row stays queued, not failed: reopening the ticket lets it launch, and
 * `ob spinoff abandon` retires it. Null when nothing says the work landed.
 */
export async function alreadyLandedReason(
  db: Database | Store,
  row: SpinoffRow,
  readCommits: (repo: string) => Commit[] = originMainCommits,
): Promise<string | null> {
  // A row never launched has no `base_sha`, and without one every old commit counts: a reopened ticket's
  // first landing would then block its re-dispatch for good. Such a row is judged by the ticket's status alone.
  const landed = await landedTicketRefs(db, [row], row.base_sha ? readCommits : () => []);
  if (!landed.has(row.id)) return null;
  return `${row.ticket_ref} already landed (ticket done, or a landing commit is on origin/main); 'ob spinoff abandon ${row.id}' retires this row, or reopen the ticket to launch it`;
}

/** A local half that happened whose database half did not (191). Printed, and it exits the drain non-zero. */
export interface DbHalfFailure {
  ticket: string;
  /** The full partial-failure sentence: what exists, what does not, and the command that finishes it. */
  detail: string;
}

export interface DrainResult {
  launched: string[];
  failed: Array<{ ticket: string; error: string }>;
  blocked: LeaseBlocked[]; // left pending: another live session holds this ticket/worktree (#97)
  not_ready: LaunchNotReady[]; // left pending: the configured launcher cannot start it yet (#118); empty since ob 1109
  reclaimed: ReclaimEntry[]; // taken back from a drain that claimed them and never stamped (191)
  db_failures: DbHalfFailure[]; // launched HERE, unrecorded THERE (191)
  remote_error: string | null; // the server could not be asked, so the sweep stopped (191)
  remaining_pending: number;
  active: number; // BUILD agent rows after the drain (expired included; architect-* excluded); informational
  /** OB-1796: which repo this pass was allowed to launch: `all`, or the repo's slug. */
  scope: string;
  /** OB-1796: queued rows left alone because they belong to another repo. Never claimed, never failed. */
  skipped_other_repo: Array<{ ticket: string; repo: string }>;
  /** OB-1796: rows this pass attempted, per repo (a row whose checkout is not on this machine counts as failed). */
  by_repo: Record<string, { launched: number; failed: number }>;
}

// --- OB-1796: a drain launches the caller's repo, not every repo's -----------------------------------
// `ob spinoff drain` once launched every pending row on the tracker, so an architect draining its own repo
// opened another architect's builders in someone else's worktree and tier. The scope is decided ONCE, up
// front, by the rule `ob spinoff <ref>` uses for "here" (`--repo`, else the cwd), and rows are compared by the CHECKOUT they name, never by string: a row carries a slug when it
// was enqueued over the API and a path when it was enqueued locally.

/** Which repo(s) a drain pass may launch. */
export type DrainScope =
  | { kind: "all" }
  | { kind: "repo"; slug: string; target: string; checkouts: Record<string, string>; home: string };

const ALL_REPOS: DrainScope = { kind: "all" };

/** `all` or the repo's slug: the word the report and the JSON carry. */
export function drainScopeLabel(scope: DrainScope): string {
  return scope.kind === "all" ? "all" : scope.slug;
}

/**
 * Decide the scope of a drain. Throws a UsageError that names the reason and the flag that settles it, so a
 * drain run from nowhere resolvable changes nothing instead of falling back to everything.
 */
export function resolveDrainScope(
  cfg: Pick<SpinoffLaunchConfig, "repoCheckouts">,
  opts: { all?: boolean; repo?: string; cwd: string; home?: string },
): DrainScope {
  const home = opts.home ?? homedir();
  if (opts.all && opts.repo !== undefined) throw new UsageError("spinoff drain takes --all or --repo <slug|path>, not both");
  if (opts.all) return ALL_REPOS;
  const hint = "pass --repo <slug|path> to drain one repo, or --all to drain every repo";
  const input = (opts.repo ?? opts.cwd).trim();
  let target: string | null = null;
  if (looksLikeRepoPath(input, opts.cwd)) {
    // A path (the cwd, or a --repo path): the checkout it is in, a worktree mapped to its main repo. A
    // checkout outside ~/dev still resolves, exactly as `ob spinoff <ref>` uses the cwd as it is.
    const abs = canonicalDir(resolve(opts.cwd, expandHome(input)));
    if (abs && isGitRepoDir(abs)) {
      const main = worktreeRepoOf(abs);
      target = (main ? canonicalDir(main) : null) ?? abs;
    }
    if (!target) {
      const why = opts.repo === undefined ? `${opts.cwd} is not inside a git checkout` : `--repo '${input}' is not a git checkout on this machine`;
      throw new UsageError(`spinoff drain launched nothing: ${why}; ${hint}`);
    }
  } else {
    try {
      target = canonicalDir(resolveRepoWith(cfg.repoCheckouts, input, home));
    } catch (err) {
      throw new UsageError(`spinoff drain launched nothing: ${err instanceof Error ? err.message : String(err)}; ${hint}`);
    }
    if (!target) throw new UsageError(`spinoff drain launched nothing: repo '${input}' has no checkout on this machine; ${hint}`);
  }
  const slug = looksLikeRepoPath(input, opts.cwd) ? basename(target) : input;
  return { kind: "repo", slug, target, checkouts: cfg.repoCheckouts, home };
}

/** The checkout a queued row's `repo` names on this machine, or null when it names none here. */
function rowCheckout(scope: Extract<DrainScope, { kind: "repo" }>, repo: string): string | null {
  try {
    const path = isAbsolute(repo) ? repo : resolveRepoWith(scope.checkouts, repo, scope.home);
    const real = canonicalDir(path);
    if (!real) return null;
    const main = worktreeRepoOf(real);
    return (main ? canonicalDir(main) : null) ?? real;
  } catch {
    return null;
  }
}

/** Is this queued row inside the scope? A row whose checkout is not on this machine is not the caller's. */
export function rowInDrainScope(scope: DrainScope, repo: string): boolean {
  if (scope.kind === "all") return true;
  return rowCheckout(scope, repo) === scope.target;
}

/** The repo name a report shows for a row: its full slug, or the checkout's basename for a row that carries a path. */
export function drainRepoLabel(repo: string): string {
  // A slug keeps its owner (`a/foo` and `b/foo` are two repos); a path is named by its checkout.
  return isAbsolute(repo) ? lastRepoSegment(repo) : repo;
}

/** An empty per-repo tally with one more outcome counted. */
export function tallyDrain(by: DrainResult["by_repo"], repo: string, outcome: "launched" | "failed"): void {
  const label = drainRepoLabel(repo);
  const entry = (by[label] ??= { launched: 0, failed: 0 });
  entry[outcome]++;
}

/** What happened to ONE pending row when it was taken through claim → launch → stamp. */
export type RowLaunch =
  | { kind: "blocked"; blocked: LeaseBlocked; dbFailure?: undefined }
  | { kind: "not-ready"; reason: string; dbFailure?: undefined }
  | { kind: "raced"; dbFailure?: undefined }
  | { kind: "remote-error"; error: string; dbFailure?: undefined }
  | { kind: "launched"; row: SpinoffRow; effect: LaunchEffect; dbFailure?: DbHalfFailure }
  | { kind: "failed"; row: SpinoffRow; error: string; dbFailure?: DbHalfFailure };

/**
 * Take one pending row through the launch: the foreign-hold check, the claim, the launch and the stamp. The
 * per-row body of `drainSpinoffs`, and since 1589 also what `ob spinoff <ref>` runs on the row it has just
 * queued, so the immediate launch and the manual drain cannot drift apart.
 */
export async function launchQueuedRow(
  db: Database | Store,
  pending: SpinoffRow,
  under: string,
  steps: SpinoffSteps,
  readCommits: (repo: string) => Commit[] = originMainCommits,
): Promise<RowLaunch> {
  // Another live session holds this ticket/worktree (#97), so leave the row PENDING (not failed) and
  // report it.
  const hold = await foreignHold(db, await rowLeaseKeys(db, pending), [leaseHolderId(), pending.branch, builderIdOf(pending), under]);
  if (hold) return { kind: "blocked", blocked: { ticket: pending.ticket_ref, resource: hold.resource, holder: hold.holder } };
  const reason = (await launchNotReadyFor(db, pending)) ?? (await alreadyLandedReason(db, pending, readCommits));
  if (reason) return { kind: "not-ready", reason };
  // THE CLAIM: atomic, and on the server once there is one. Nothing local has happened yet, so losing
  // the race costs nothing and a claim that cannot be taken leaves no residue at all.
  const outcome = await steps.claim(pending);
  if (outcome.remoteError) return { kind: "remote-error", error: outcome.remoteError };
  const row = outcome.claimed;
  // OB-1921: a claim lease that could not be taken leaves the row pending, and says why.
  if (!row) return outcome.error ? { kind: "not-ready", reason: outcome.error } : { kind: "raced" }; // else no longer pending
  if (outcome.error) {
    // Claimed, then refused by the authoritative lease check: the row fails.
    const stampError = await steps.stamp({ id: row.id, outcome: "failed", error: outcome.error });
    return {
      kind: "failed",
      row,
      error: outcome.error,
      dbFailure: stampError ? { ticket: row.ticket_ref, detail: claimNotStamped(row, outcome.error, stampError) } : undefined,
    };
  }
  let prep: LaunchPrep | null = null;
  try {
    prep = await prepareLaunch(db, row);
    const launcher = ASYNC_LAUNCHERS[prep.launcher]!;
    // The prep is synchronous git (its fetch capped at 30s), so only the launcher can outlive the claim TTL.
    const effect = await withClaimHeartbeat(() => steps.heartbeatClaim(row), () => launcher(db, row));
    // THE STAMP: the row, and the agent registration tied to this repo (id = agent_id = the builder id, OB-1992).
    const stamp: StampInput = {
      id: row.id,
      outcome: "launched",
      ...prep,
      session_id: effect.sessionId ?? null,
      t3_thread_id: effect.t3ThreadId ?? null,
      t3_run_id: effect.t3RunId ?? null,
      model: effect.model ?? null,
      effort: effect.effort ?? null,
      raised: effect.raised,
    };
    const stampError = await steps.stamp(stamp);
    return {
      kind: "launched",
      // OB-2075: the line reports the tier the thread ran on, which a launch-time raise moved to complex.
      row: effect.raised ? { ...row, tier: "complex" } : row,
      effect,
      dbFailure: stampError ? { ticket: row.ticket_ref, detail: launchNotStamped(row, stamp, stampError) } : undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stamp: StampInput = { id: row.id, outcome: "failed", error: msg, ...(prep ?? {}) };
    const stampError = await steps.stamp(stamp);
    return {
      kind: "failed",
      row,
      error: msg,
      dbFailure: stampError ? { ticket: row.ticket_ref, detail: claimNotStamped(row, msg, stampError) } : undefined,
    };
  }
}

/**
 * Launch every pending row that is not lease-blocked (#97) — row by row, it spawns the agent in its
 * worktree. Agent count is not a reason to leave a row pending (ob 767): expired zombies do not occupy a
 * launch slot, and `ob agent done` is not required to free the next slot. Run by the in-session daemon.
 * Pending rows are walked oldest-first (FIFO).
 *
 * `under` is a holder whose ticket:/worktree: holds count as the caller's own (#136): the architect that
 * took `ticket:<n>` for its gate draining that very ticket's queued row. A hold by ANY OTHER live holder
 * still leaves the row pending and reported, which is the #97 behaviour this must not weaken.
 */
export async function drainSpinoffs(
  db: Database | Store,
  under = "",
  _opts: LaunchOpts = {},
  steps: SpinoffSteps = localSpinoffSteps(db, under),
  scope: DrainScope = ALL_REPOS,
): Promise<DrainResult> {
  // `Database | Store` since 337 pass 5: every read this sweep makes now goes through the store, the
  // config ones (the launcher routing, the `--repo` slug map) through the `...For` forms beside
  // settings.ts's synchronous `setting()`. What stays on this machine either way is the part that is
  // ABOUT this machine: the worktrees and git.
  const launched: string[] = [];
  const failed: Array<{ ticket: string; error: string }> = [];
  const blocked: LeaseBlocked[] = [];
  const notReady: LaunchNotReady[] = [];
  const dbFailures: DbHalfFailure[] = [];
  const skipped: DrainResult["skipped_other_repo"] = [];
  const byRepo: DrainResult["by_repo"] = {};
  let remoteError: string | null = null;

  // Before anything is claimed: take back the rows a previous drain claimed and never stamped, so a
  // machine that died mid-pass cannot strand its rows (191). It reads the claim leases, so a claim still
  // inside its TTL is left alone.
  const recovered = await steps.reclaim();
  if (recovered.remoteError) {
    return {
      launched, failed, blocked, not_ready: notReady, reclaimed: [], db_failures: dbFailures,
      remote_error: recovered.remoteError,
      remaining_pending: (await listSpinoffs(db, "pending")).length,
      active: (await liveBuildAgentsByRepo(db)).total,
      scope: drainScopeLabel(scope),
      skipped_other_repo: skipped,
      by_repo: byRepo,
    };
  }

  const pendings = await pendingSpinoffs(db);

  for (const pending of pendings) {
    // OB-1796: another repo's row is neither claimed nor failed; it stays queued for its own architect.
    if (!rowInDrainScope(scope, pending.repo)) {
      skipped.push({ ticket: pending.ticket_ref, repo: drainRepoLabel(pending.repo) });
      continue;
    }
    const r = await launchQueuedRow(db, pending, under, steps);
    if (r.dbFailure) dbFailures.push(r.dbFailure);
    if (r.kind === "blocked") blocked.push(r.blocked);
    else if (r.kind === "not-ready") notReady.push({ ticket: pending.ticket_ref, reason: r.reason });
    else if (r.kind === "launched") {
      launched.push(r.row.ticket_ref);
      tallyDrain(byRepo, pending.repo, "launched");
    } else if (r.kind === "failed") {
      failed.push({ ticket: r.row.ticket_ref, error: r.error });
      tallyDrain(byRepo, pending.repo, "failed");
    }
    else if (r.kind === "remote-error") {
      remoteError = r.error;
      break; // the server is unreachable: every remaining row would fail the same way
    }
  }
  return {
    launched,
    failed,
    blocked,
    not_ready: notReady,
    reclaimed: recovered.entries,
    db_failures: dbFailures,
    remote_error: remoteError,
    remaining_pending: (await listSpinoffs(db, "pending")).length,
    active: (await liveBuildAgentsByRepo(db)).total,
    scope: drainScopeLabel(scope),
    skipped_other_repo: skipped,
    by_repo: byRepo,
  };
}

/** A tab is open here and the server still calls the row `launching`. Names the command that settles it. */
function launchNotStamped(row: SpinoffRow, stamp: StampInput, detail: string): string {
  return splitPartialFailure({
    didLocally: `${row.ticket_ref} LAUNCHED here (${row.launcher ?? "launcher"} in ${row.worktree})`,
    missing: `recording the launch`,
    detail,
    recover: `ob ${shellWords(stampArgv(stamp))} (or leave it: the claim lapses after ${CLAIM_TTL_S}s and 'ob spinoff reclaim' re-queues the row)`,
  });
}

/** Nothing opened, and the row is still claimed on the server. Same recovery, opposite local half. */
function claimNotStamped(row: SpinoffRow, why: string, detail: string): string {
  return splitPartialFailure({
    didLocally: `${row.ticket_ref} did NOT launch here (${why})`,
    missing: `recording the failure`,
    detail,
    recover: `ob spinoff reclaim (the claim lapses after ${CLAIM_TTL_S}s and the row is re-queued)`,
  });
}

// --- the app reports a spawn that produced nothing (#151, on #146's report path) ------------------
// `launch` stamps the row `launched` before anything can know a process exists, exactly as it must (the
// registry row is what a tab nests under). #146 taught the app to report the spawn it found produced no
// session; that correction reached the AGENT row and stopped there, so `spinoff.status` kept saying
// `launched` for a session that never started — which left nothing to re-enqueue the launch.
//
// The correction arrives through #146's OWN report (`ob agent register --spawn-failed`), deliberately:
// the agent row and the row status drifted apart precisely because two separate mechanisms wrote them.
// It is NEVER inferred here - no age threshold, no "no process found" guess - because a guessed failure
// is how the original false `working` arose. The app knows; the app says so.

/**
 * How many times one row may be launched: the first attempt plus ONE retry (#151).
 *
 * Bounded at one because the two failure causes are indistinguishable from here. #146 could not
 * determine why the spawn produced nothing, so it may well be deterministic (a command the agent binary
 * rejects, a worktree that is gone), and an unbounded re-enqueue against that relaunches forever.
 * One retry is what covers the case worth covering: a transient failure (a libghostty handle, a PTY
 * exhausted by a momentary fd shortage) that a second attempt clears. The second failure is terminal
 * and says so, rather than retrying quietly.
 */
export const MAX_LAUNCH_ATTEMPTS = 2;

/** What a reported spawn failure did to the row. */
export interface SpawnFailureRecord {
  id: number;
  ticket: string;
  branch: string;
  status: "pending" | "failed";
  attempts: number;
  /** true when the row went back to `pending` and a later drain will launch it again. */
  retrying: boolean;
}

/**
 * Record that `agentId`'s launch produced no session, per the app's report. Re-enqueues the row
 * (`pending`) while it still has a retry to spend, else marks it terminally `failed`; either way the row
 * leaves `launched`, which is what makes `ob spinoff list` stop calling it a live launch.
 *
 * Returns null when there is no launched row under that id - an architect request (#84) carries no branch,
 * and a hand-registered agent has no spinoff row - so a report about something the queue never launched
 * changes nothing. The lookup is by branch or agent_id: the launcher registers the agent under the builder id
 * and stamps `agent_id` with it, which is the branch in OmniSlash and the lowercase ref in a clean repo (OB-1992).
 *
 * The failed agent's ticket/worktree leases are released: nothing is running under that holder, so
 * holding them only blocks the retry (and a human taking the ticket over) until their TTL runs out. The
 * AGENT row is left as it is: since 1189 it carries no `failed` word (a launcher word), so the SPINOFF
 * row — its `status` + `error` — is where a human looks to see that a launch died.
 */
export async function recordSpinoffSpawnFailure(
  db: Database | Store,
  agentId: string,
  reason: string,
): Promise<SpawnFailureRecord | null> {
  const s = asStore(db);
  const rows = (await s.q
    .select()
    .from(s.t.spinoff)
    .where(and(or(eq(s.t.spinoff.branch, agentId), eq(s.t.spinoff.agent_id, agentId)), inArray(s.t.spinoff.status, ["launching", "launched"])))
    .orderBy(desc(s.t.spinoff.id))
    .limit(1)) as SpinoffRow[];
  const row = rows[0];
  if (!row) return null;
  const attempts = row.launch_attempts ?? 0;
  const retrying = attempts < MAX_LAUNCH_ATTEMPTS;
  const error = reason.slice(0, 500);
  // Clearing agent_id/launched_at on a retry keeps the row from claiming a launch it no longer has;
  // the next drain re-stamps both when it actually relaunches.
  try {
    if (retrying) await moveSpinoff(s, row.id, "pending", { error, agent_id: null, launched_at: null }, ["launching", "launched"]);
    else await moveSpinoff(s, row.id, "failed", { error }, ["launching", "launched"]);
  } catch (e) {
    if (e instanceof SpinoffTransitionRefused) return null; // moved since it was read: nothing launched to record
    throw e;
  }
  for (const h of new Set([row.branch, builderIdOf(row)])) await releaseLeasesByHolder(s, h);
  return { id: row.id, ticket: row.ticket_ref, branch: row.branch, status: retrying ? "pending" : "failed", attempts, retrying };
}

/** Is a launched spinoff DONE? `(repo, branch) => boolean`. Injectable so tests pass a fake. */
export type MergeChecker = (repo: string, branch: string) => boolean;

/**
 * A PR-based checker: is the branch's PR merged on GitHub (via `gh`)? Kept as an available injectable
 * checker, but NO LONGER the default — OmniSlash skips PRs (decision #29), so with no PR this never fires
 * and a spinoff would linger `launched` forever (#36). The default is now `gitMergedChecker` below.
 */
export function prMerged(repo: string, branch: string): boolean {
  try {
    const p = Bun.spawnSync(["gh", "pr", "list", "--head", branch, "--state", "merged", "--json", "mergedAt", "--limit", "1"], {
      cwd: repo,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (p.exitCode !== 0) return false;
    const arr = JSON.parse(new TextDecoder().decode(p.stdout).trim() || "[]");
    return Array.isArray(arr) && arr.length > 0 && !!arr[0]?.mergedAt;
  } catch {
    return false;
  }
}

/**
 * The DEFAULT reconcile signal (#36): a spinoff is done when its branch is **fully merged into `main`** —
 * the git-state signal `ob spinoff cleanup` uses via `mergedBranches`. Like cleanup (1760), it measures against `mainRefFor(repo)`:
 * origin/main when the repo has one (the architect checkout never moves its local `main`, so lands live only on origin), else local `main` (1871).
 * This replaces the PR check because OmniSlash skips PRs (decision #29). Results are memoised PER REPO so a
 * single reconcile pass shells out to git once per repo; any git error → an empty merged-set → the row is
 * simply not reconciled this tick (graceful — never throws). Injectable for tests.
 */
export function gitMergedChecker(): MergeChecker {
  const cache = new Map<string, Set<string>>();
  return (repo, branch) => {
    let set = cache.get(repo);
    if (!set) {
      set = mergedBranches(repo, mainRefFor(repo)).merged; // OB-2141: squash-merged PRs count
      cache.set(repo, set);
    }
    return set.has(branch);
  };
}

export interface ReconcileResult {
  merged: string[];
  blocked: LeaseBlocked[]; // would have been marked landed, but another live session holds it (#97)
  db_failures: DbHalfFailure[]; // merged per THIS machine's git, not recorded on the server (191)
  /** 1120: live `t3` rows whose run state was mirrored onto their agent row. Absent on the API-client
   *  reconcile, which asks the host for rows and has no T3 credential of its own. */
  mirrored?: T3MirrorEntry[];
  /** 1120: live `t3` rows whose thread could not be read, or reported a status this build does not know. */
  mirror_skipped?: T3MirrorSkip[];
}

// OB-1993: the row's reader lives beside `tokenSourceFor`, so reconcile, close and backfill share one expression.
export { tokensForRow, type TokenReader };

/**
 * How many commits `branch` has past `baseSha` in `repo`: `(repo, baseSha, branch) => count`.
 * Injectable so tests never need real git. `git branch --merged main` (mergedBranches, used by the
 * default MergeChecker) trivially includes a branch with ZERO commits ahead of main, so a just-launched
 * spinoff was being marked "merged" while its agent was still starting (#60). This counter is the
 * second gate reconcile applies on top of "merged into main": a branch is only DONE once it also has
 * at least one commit past the base captured at launch/adoption time.
 */
export type UniqueCommitCounter = (repo: string, baseSha: string | null, branch: string) => number;

/**
 * The real counter: `git rev-list --count <baseSha>..<branch>`. A NULL `baseSha` (a row launched before
 * the #61 migration added the column) counts from the branch's reflog fork point instead (OB-1921); with
 * no reflog it returns 0, conservative by design, never repeating the #60 false-positive on a branch we
 * can't actually verify. Any
 * git error likewise returns 0 (graceful, never throws, mirrors gitMergedChecker's error handling).
 * A branch that only picked up main's commits by a rebase counts 0 (OB-2180, `onlyPickedUpMain`).
 */
export function gitUniqueCommitCount(): UniqueCommitCounter {
  return (repo, baseSha, branch) => {
    const base = baseSha ?? branchForkPoint(repo, branch);
    if (!base) return 0;
    const r = sh(["git", "-C", repo, "rev-list", "--count", `${base}..${branch}`]);
    if (!r.ok) return 0;
    const n = Number((r.out ?? "").trim());
    if (!Number.isFinite(n) || n <= 0) return 0;
    return onlyPickedUpMain(repo, base, branch) ? 0 : n;
  };
}

/**
 * OB-2180: did `branch` only pick up main's commits? True when its tip is a commit on main's own first-parent
 * line after `base` AND its reflog shows no commit made on it. Then every commit in `base..branch` is main's,
 * taken when the builder ran `git rebase origin/main` before it had any work (a dispatch records `base_sha`
 * from a checkout that can lag origin/main). Row 2022 (OB-2173) was landed that way at 11:22 on 2026-11-15:
 * base b0da00b7, the empty branch rebased onto f9c1a85c, so `rev-list --count` said 2 and `--merged` said yes.
 * The reflog is what tells it from a branch whose own commits were fast-forwarded onto main (a local-only
 * repo's land, OB-1921): that branch's reflog has its `commit:` entries, or a `merge` that was not a
 * fast-forward. A tip off the line (a merge's second
 * parent, a squash's head) is the builder's own. Unreadable git, or no reflog, answers false: the count stands.
 */
function onlyPickedUpMain(repo: string, base: string, branch: string): boolean {
  const tip = (sh(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `${branch}^{commit}`]).out ?? "").trim();
  if (!tip) return false;
  const line = sh(["git", "-C", repo, "rev-list", "--first-parent", `${base}..${mainRefFor(repo)}`]);
  if (!line.ok || !(line.out ?? "").split("\n").some((sha) => sha.trim() === tip)) return false;
  const log = sh(["git", "-C", repo, "reflog", "show", "--format=%gs", `refs/heads/${branch}`, "--"]);
  const entries = (log.out ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!log.ok || entries.length === 0) return false;
  // a commit made on the branch: its own, or a merge that was not a fast-forward (a review round on this ticket)
  return !entries.some((e) => /^(commit|cherry-pick|revert|am)\b/.test(e) || (/^(merge|pull)\b/.test(e) && !/Fast-forward$/.test(e)));
}

/**
 * OB-1921: where a branch began, for a row that never recorded `base_sha` (OB-1631). A merge-base with
 * `main` cannot answer this once the branch has merged, because it is then the branch tip itself and
 * every count is 0, so this reads the branch's own reflog: its oldest entry is the commit it was created
 * at (`branch: Created from main`). Null when there is no reflog (a fetched branch, an expired reflog),
 * and then the row keeps the conservative 0. Never throws.
 */
export function branchForkPoint(repo: string, branch: string): string | null {
  const r = sh(["git", "-C", repo, "reflog", "show", "--format=%H", `refs/heads/${branch}`, "--"]);
  if (!r.ok) return null;
  const shas = (r.out ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return shas.at(-1) ?? null;
}

/**
 * Close out launched spinoffs whose branch has merged into `main` AND has at least one commit past its
 * captured base (#60/#61: a branch merged into main with ZERO unique commits is never "done", it just
 * hasn't started): mark the row `merged`, persist the token usage recovered from its worktree's Claude
 * Code transcript (#55), and deregister its agent. Default merge signal is
 * git-state (`gitMergedChecker`) since OmniSlash skips PRs (#36/decision #29); `isMerged` and `countUnique`
 * both stay injectable (tests pass fakes; the PR-based `prMerged` remains available for `isMerged`).
 * `readTokens` is injectable so tests point it at a fixture dir. Run before a drain so a completed
 * spinoff is retired before the next pending launch.
 */
/**
 * After the TUI exists: capture the unique root opencode session for each launched opencode row
 * that still has no session_id, and stamp it (384). 0 or >1 roots leave the row alone — do not guess.
 * Uses `steps.stamp` so the write is local or remote the same way land is.
 */
export async function stampEmptyOpencodeSessions(db: Database | Store, steps: SpinoffSteps): Promise<string[]> {
  const stamped: string[] = [];
  for (const row of await listSpinoffs(db, "launched")) {
    if (row.engine !== "opencode") continue;
    if (row.session_id) continue;
    const id = rootOpencodeSessionId(row.worktree);
    if (!id) continue;
    const err = await steps.stamp({ id: row.id, outcome: "launched", session_id: id });
    if (!err) stamped.push(row.ticket_ref);
  }
  return stamped;
}

/** Commits on `origin/main` in `repo`. A missing ref or a git error is an empty list — not "landed". */
export function originMainCommits(repo: string): Commit[] {
  const log = gitLog(repo, "origin/main");
  return log.ok ? log.value : [];
}

/**
 * How a caller supplies the two inputs `workHasLanded` needs. The store path
 * and the API client both go through `landedTicketRefsVia`, so `list --json`'s
 * `landed` flag cannot drift between them (937).
 */
export interface LandedRead {
  status: (ticketRef: string) => Promise<string | null>;
  repoPath: (repo: string) => string | Promise<string>;
  commits?: (repoPath: string) => Commit[];
}

/**
 * The row facts a landed read needs: which row, which ticket, which checkout, and — since ob 1201 — when
 * its build started (`base_sha`, so a chart commit that landed before the dispatch cannot pass as its land).
 */
export interface LandedRow {
  id: number;
  ticket_ref: string;
  repo: string;
  base_sha?: string | null;
}

/**
 * ROW ids whose work has landed without local `main` moving (ob 932): the
 * item is `done`, or a LANDING commit on `origin/main` names the ticket — a merge subject or a
 * conventional scope, never a `docs(`/`chart(` note, and never one older than the row's `base_sha`
 * (1201). One commit read per checkout.
 *
 * The answer is per ROW, not per ticket (1201): `base_sha` is the row's own record of when its build
 * started, so two rows for one ticket — a re-dispatch — can disagree, and a ticket-keyed answer would let
 * whichever row was read first decide for both, retiring a newer dispatch on an older one's land. Callers
 * ask `landed.has(row.id)` for the same reason. Does not fast-forward anything.
 */
export async function landedTicketRefsVia(
  rows: LandedRow[],
  read: LandedRead,
): Promise<Set<number>> {
  const readCommits = read.commits ?? originMainCommits;
  const landed = new Set<number>();
  const commitsByRepo = new Map<string, Commit[]>();
  for (const row of rows) {
    const status = await read.status(row.ticket_ref);
    const repo = await read.repoPath(row.repo);
    if (!commitsByRepo.has(repo)) {
      try {
        commitsByRepo.set(repo, readCommits(repo));
      } catch {
        commitsByRepo.set(repo, []);
      }
    }
    if (workHasLanded(row.ticket_ref, { status, commits: commitsByRepo.get(repo) ?? [], baseSha: row.base_sha })) {
      landed.add(row.id);
    }
  }
  return landed;
}

/**
 * Store-backed `landedTicketRefsVia`: item status from the tracker, checkout
 * from the row's repo slug. The API client passes its own readers (937).
 */
export async function landedTicketRefs(
  db: Database | Store,
  rows: LandedRow[],
  readCommits: (repo: string) => Commit[] = originMainCommits,
): Promise<Set<number>> {
  return landedTicketRefsVia(rows, {
    status: async (ref) => (await getItem(db, ref))?.status ?? null,
    repoPath: (repo) => rowRepoPathFor(db, repo),
    commits: readCommits,
  });
}

/**
 * OB-1970: a t3 row whose FIRST turn the mirror just saw end `failed` on a credit or quota error is
 * relaunched on the next models profile, or failed by name when every profile is spent. Reports, never
 * throws: T3 or the models file being unreadable leaves the row as the mirror recorded it.
 */
export async function relaunchCreditFailures(db: Database | Store, mirrored: readonly T3MirrorEntry[]): Promise<void> {
  const failed = mirrored.filter((m) => m.status === "failed");
  if (failed.length === 0) return;
  let file: ReturnType<typeof modelsFileOrRefuse>;
  try {
    file = modelsFileOrRefuse();
  } catch (err) {
    warn(`  ⚠ credit-fallback check skipped: ${(err as Error).message}`);
    return;
  }
  if (!file) return; // no models file: nothing to fall back to, and nothing asked of T3
  const s = asStore(db);
  for (const entry of failed) {
    try {
      const stored = ((await s.q
        .select()
        .from(s.t.spinoff)
        .where(and(eq(s.t.spinoff.t3_thread_id, entry.threadId), eq(s.t.spinoff.status, "launched")))
        .limit(1)) as SpinoffRow[])[0];
      if (!stored) continue;
      // OB-2075: the new thread of an urgent ticket opens on complex even when its first (adopted) thread kept another model.
      const { row } = await urgentLaunchRow(db, stored);
      const seam = await t3Seam();
      const repoPath = await rowRepoPathFor(db, row.repo);
      const title = await ticketTitleFor(db, row.ticket_ref, row.item_id);
      const result = await relaunchOnCreditFailure(row, entry.threadId, {
        file,
        seam,
        base: settingTierModelsOrRefuse(await settingFor(db, "spinoff_tier_models")),
        launch: (models) => launchT3Spinoff(seam, row, repoPath, title, models),
        relaunched: async (outcome) => {
          await moveSpinoff(s, row.id, "launched", { t3_thread_id: outcome.threadId, t3_run_id: outcome.runId, model: outcome.model, effort: outcome.effort, tier: row.tier }, ["launched"]);
          await registerAgent(s, { id: builderIdOf(row), ticket: legRef(row.ticket_ref, row.trial_leg), branch: row.branch, sessionId: outcome.threadId, ttlS: AGENT_LEASE_TTL_S });
        },
        fail: async (reason) => {
          await stampSpinoff(db, { id: row.id, outcome: "failed", error: reason });
        },
      });
      if (result.kind === "failed") warn(`  ✗ ${row.ticket_ref}: ${result.reason}`);
      if (result.kind === "skipped") warn(`  ⚠ ${row.ticket_ref}: ${result.reason}`);
    } catch (err) {
      warn(`  ⚠ ${entry.ticket}: credit-fallback check failed: ${(err as Error).message}`);
    }
  }
}

export async function reconcileSpinoffs(
  db: Database | Store,
  isMerged: MergeChecker = gitMergedChecker(),
  readTokens: TokenReader | null = null,
  countUnique: UniqueCommitCounter = gitUniqueCommitCount(),
  under = "",
  steps: SpinoffSteps = localSpinoffSteps(db, under),
  readOriginCommits: (repo: string) => Commit[] = originMainCommits,
): Promise<ReconcileResult> {
  await stampEmptyOpencodeSessions(db, steps);
  // 1120: mirror every LIVE t3 row's run state onto its agent row FIRST, so a run that ended is reflected
  // before this pass decides anything from git. It never touches a spinoff QUEUE status (T3 has no
  // "waiting to be launched for a ticket") and reports rather than throws: T3 being down is not a reason
  // to fail the queue, and a row whose thread is unreadable keeps its last honest agent value.
  const mirror = await reconcileT3Runs(db);
  for (const s of mirror.skipped) warn(`  ⚠ ${s.ticket}: ${s.reason}`);
  await relaunchCreditFailures(db, mirror.mirrored);
  const merged: string[] = [];
  const blocked: LeaseBlocked[] = [];
  const dbFailures: DbHalfFailure[] = [];
  const rows = await landableSpinoffs(db);
  const landed = await landedTicketRefs(db, rows, readOriginCommits);
  for (const row of rows) {
    const repo = await rowRepoPathFor(db, row.repo); // a slug row (217) names its checkout on this machine
    const branchDone = isMerged(repo, row.branch) && countUnique(repo, row.base_sha, row.branch) > 0;
    // A LANDING commit on origin/main, or a done ticket, counts even when local main has
    // not moved (ob 932); a chart/docs note naming the ticket, or a commit older than the
    // row's base_sha, does not (ob 1201). A handed-off row lands on the branch being merged or on its
    // ticket being DONE (1596: `ob close` is the land decision, and a squash never makes the branch an
    // ancestor of main); a commit naming the ticket does not retire it, the architect squashes before it closes.
    const originDone =
      row.status === READY_FOR_GATE ? (await getItem(db, row.ticket_ref))?.status === "done" : landed.has(row.id);
    if (!branchDone && !originDone) continue;
    // OB-1826: a closed spike's ticket reads `done`, which is a landing for any other row. A spike has nothing
    // to land, so a reconcile that runs between the close and its stamp retires it as the spike end the close
    // would have, never as `merged`.
    if (isSpikeTagged(await spinoffTicketTagsFor(db, row.ticket_ref, row.item_id))) {
      if (originDone) {
        try {
          await stampSpinoff(db, { id: row.id, outcome: "failed", error: spikeEndError("closed") });
          await finishAgent(db, builderIdOf(row));
        } catch (e) {
          if (!(e instanceof SpinoffTransitionRefused)) throw e; // the close ended it first (OB-1920)
        }
      }
      continue;
    }
    // Marking a row landed (and deregistering its agent) is a finalisation, so it must not happen under
    // a THIRD party's lease (#97), e.g. an architect mid-review of this very ticket. The row's OWN agent is not
    // foreign: reconcile is that agent's completion, and it releases the agent's leases below. Neither is
    // `under`, the holder the caller named (#136): the architect holding `ticket:<n>` for its gate IS the
    // reviewer, so its own hold must not block the landing it is performing.
    const self = [leaseHolderId(), builderIdOf(row), under];
    const hold = await foreignHold(db, spinoffLeaseKeys(row), self);
    if (hold) {
      blocked.push({ ticket: row.ticket_ref, resource: hold.resource, holder: hold.holder });
      continue;
    }
    // The token reader is the ENGINE's, from the engine the row was STAMPED with (0023): a claude launch
    // keeps its totals in ~/.claude/projects jsonl, an opencode launch in its own session table, and
    // neither is readable by the other's reader. A NULL `engine` (a pre-0023 row) reads as claude, which
    // is truthful because nothing before this migration could have launched opencode.
    const usage = (readTokens ?? tokensForRow(row))(row.worktree); // recover this agent's totals from ITS transcript source
    const landError = await steps.land({ id: row.id, tokens: usage });
    if (landError) {
      dbFailures.push({
        ticket: row.ticket_ref,
        detail: splitPartialFailure({
          didLocally: `${row.ticket_ref} has merged into main here`,
          missing: "retiring the row",
          detail: landError,
          recover: `ob ${landArgv(row.id, usage).join(" ")}`,
        }),
      });
      continue;
    }
    merged.push(row.ticket_ref);
  }
  return { merged, blocked, db_failures: dbFailures, mirrored: mirror.mirrored, mirror_skipped: mirror.skipped };
}

/**
 * Mark the closed item's own building / handed-off rows landed (1589): `ob close` is the land, so the row
 * should read `landed` without waiting for a reconcile. Only the rows that SERVE this item (1226). No lease
 * check, unlike reconcile (#97): reconcile lands on nobody's say-so, while a close IS the land decision,
 * and the architect running it normally still holds `ticket:<n>`. `ob spinoff reconcile` stays for every
 * other row. Never throws: the close has already happened, so a failure comes back as a message.
 */
export async function landClosedItemSpinoffs(
  db: Database | Store,
  itemId: string,
  decision: DecisionOpts = {},
  /** OB-1993: the tokens the CLIENT read, by row id. A row present here uses them; a row absent reads where this runs. */
  tokensById: Record<number, TokenUsage> = {},
): Promise<{ landed: string[]; ended: string[]; error: string | null }> {
  const landed: string[] = [];
  const ended: string[] = [];
  try {
    const item = await getItem(db, itemId);
    if (!item) return { landed, ended, error: null };
    const { rows } = await spinoffRowsServingItem(db, await landableSpinoffs(db), item);
    // OB-1826: a spike has no merge to land. Its close retires the row as an ordinary `failed` one whose error
    // carries the `spike:` marker, so `landed` never claims a merge that did not happen and `spinoff mix`
    // never counts it as one.
    const spike = isSpikeTagged(await getTags(db, item.id));
    for (const row of rows) {
      const actor = decision.actor ?? "close";
      // OB-1920: a row a racing reconcile already retired is refused by the table; skip it, the rest still land.
      try {
        if (spike) {
          await stampSpinoff(db, { id: row.id, outcome: "failed", error: spikeEndError(decision.note), decision: { ...decision, actor } });
          await finishAgent(db, builderIdOf(row));
          ended.push(row.ticket_ref);
          continue;
        }
        await landSpinoff(db, row.id, tokensById[row.id] ?? tokensForRow(row)(row.worktree), { ...decision, actor });
        landed.push(row.ticket_ref);
      } catch (e) {
        if (!(e instanceof SpinoffTransitionRefused)) throw e;
      }
    }
    return { landed, ended, error: null };
  } catch (err) {
    return { landed, ended, error: (err as Error).message };
  }
}

// --- ready-for-gate (ob 391) ------------------------------------------------
// An interactive spinoff is declared done by the HUMAN, never self-declared. `ob agent done` deletes
// the row (and used to drop the architect's ticket lease: 341 keeps an inherited hold); `spinoff watch` only fired on a MERGE. The
// durable signal is a new spinoff status, not a second meaning of `agent done` and not `spinoff stamp`
// (that verb is the drain's launched|failed write, 191). Status is free text, so no migration; the
// unique index only covers pending|launching. Watch emits it the same way it emits a merge
// (`reported_at` still gates exactly-once). Reconcile still lands the row once the branch IS on main.
// Architect leases stay put through the gate (341). Builder ticket:/worktree: holds are released (426)
// so the architect can acquire them: the 418 miss: `/ob-spinoff-done` (now `/ob-spinoff-handoff`) left ticket:418 held by 418.

/** Statuses a human may hand off (stored `launched`), or that already are handed off (`ready-for-gate`). */
export function isReadyableStatus(status: string): boolean {
  return (READYABLE_STATUSES as readonly string[]).includes(status);
}

export interface ReadySpinoffResult {
  row: SpinoffRow;
  already: boolean;
  /** True when this call released at least one builder ticket:/worktree: hold (426). */
  leasesReleased: boolean;
  /**
   * The `tier-fit:` line this handoff recorded on the ticket's trail (1552), or null when the builder
   * rated no tier. Returned so the readying note says the same thing the trail does.
   */
  tierFit: string | null;
  /** OB-1826: the row serves a spike, so it was NOT stamped handed-off: it stays building until `ob close`. */
  spike?: boolean;
}

/**
 * The refusal a ref that names a LANDED row earns (1188): "nothing to gate; <ref> landed as <sha>".
 *
 * The wording is deliberate. "not launched (cannot mark ready-for-gate)" reads like a bookkeeping quirk;
 * "landed as <sha>" says the thing that stops an architect acting on it: and it can be said even when the
 * worktree is long gone, because the sha comes from the REPO main carries, not from the checkout. An
 * unreadable sha is reported as unreported rather than guessed, the same rule the notes follow.
 */
export function alreadyLandedRefusal(ticketRef: string, sha: string | null): string {
  return sha
    ? `nothing to gate; ${ticketRef} landed as ${sha}`
    : `nothing to gate; ${ticketRef} has already landed (its merge commit sha is unreported)`;
}

/**
 * A `--status` filter a human typed, in either spelling (1513: `handed-off` or `ready-for-gate`), as the
 * STORED value `listSpinoffs` filters on. Undefined passes through (no filter); anything else is usage.
 */
export function spinoffStatusFilter(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const stored = toStoredSpinoffStatus(input);
  if (!stored) {
    throw new UsageError(
      `unknown spinoff status '${input}' (queued|launching|building|handed-off|landed|failed; the old pending|launched|ready-for-gate|merged still work)`,
    );
  }
  return stored;
}

/** Why this ref cannot be handed off: landed rows are named as landed (1188). Pure. */
function readyRefusalFor(row: SpinoffRow, landedShaFor?: (row: SpinoffRow) => string | null): string {
  if (row.status === "merged") return alreadyLandedRefusal(row.ticket_ref, landedShaFor?.(row) ?? null);
  return `spinoff ${row.ticket_ref} is ${spinoffStatusWord(row.status)}, not building (cannot hand off)`;
}

/**
 * The refusal a row whose checkout is gone earns (1188): there is nothing to gate and nothing to announce.
 *
 * Exported so BOTH ready paths (the local command and the API client) say it with one voice — the check
 * itself cannot live on the host, which has none of these checkouts.
 */
export function missingWorktreeRefusal(worktree: string): string {
  return `worktree ${worktree} does not exist; nothing to gate from it — the checkout was removed (if the ticket already landed, this row is stale)`;
}

/**
 * The note outcome a REPEAT on an already-stamped row whose checkout is gone earns (1188).
 *
 * A repeat `ob spinoff ready` exists for its 426 cleanup — releasing the builder's leftover `ticket:` /
 * `worktree:` holds (the 418 class) — and that half is safe with the checkout gone. The ANNOUNCE is not:
 * the note names a worktree an architect could not gate, which is the 1163 hazard. So the cleanup happens and
 * the note is a NAMED SKIP, shaped like every other skip so both paths print it the way they already do.
 */
export function worktreeGoneNoteOutcome(ticket: string, worktree: string): ReadyNoteOutcome {
  return {
    ticket,
    threadId: null,
    outcome: "skipped",
    reason: `the worktree ${worktree} does not exist, so there is nothing to announce (1188)`,
  };
}

/**
 * What a handoff that carried no `--tier-fit` prints (1552). Optional, so it never refuses: but an architect
 * reading a run of handoffs should know which builder never answered the question.
 */
export const TIER_FIT_HINT =
  "tier-fit: not rated, pass --tier-fit lower|right|higher (and --tier-fit-why '<one line>') so the architect learns whether the tier fit";

/**
 * The note outcome `ob spinoff ready --no-note` earns (1205): the stamp, and nothing queued.
 *
 * The note exists to tell the ARCHITECT a builder is waiting for a gate. `ob-land` has the architect stamp on
 * the human's behalf — the stamp is the land yes, and the human said land — so when the caller IS the
 * architect's own thread the note is a message to itself, delivered when that same turn ends (measured: the
 * 22:48 stamp for 738 arrived at 23:08, for a ticket already landed). The caller that knows it is its own
 * audience says so; the flag cannot be inferred from the row, which describes the BUILDER, not the caller.
 */
export function noNoteOutcome(ticket: string): ReadyNoteOutcome {
  return {
    ticket,
    threadId: null,
    outcome: "skipped",
    reason: `--no-note: stamped only, nothing announced (1205, the caller is the architect's own thread)`,
  };
}

/**
 * Pick the launched / ready-for-gate row a `spinoff ready` should act on. Pure over the row list
 * (the API client lists, then picks, then POSTs the id). `ref` is a spinoff id, a ticket_ref, or a
 * branch. With no ref, the cwd's worktree path then `branch`. Refuses rather than guessing.
 *
 * A REF THAT NAMES A LANDED ROW GETS ITS OWN REFUSAL (1188): `nothing to gate; <ref> landed as <sha>`.
 * `landedShaFor` is injected because the sha needs git and this function is pure (the same shape the
 * land-reply path uses). It matters because a stale builder is not the only way to get here — anything
 * holding a ticket ref can ask, and the answer must be "it landed", not "it is not launched".
 */
/**
 * OB-1991: a model trial gives one ticket two live rows (legs a and b). A builder names only its ticket, so the row
 * whose worktree is this checkout (or whose branch is checked out here) is the one it means; otherwise the first.
 */
export function ownLegFirst<R extends { worktree: string; branch: string }>(rows: R[], opts: { cwd?: string; branch?: string | null } = {}): R | undefined {
  if (rows.length <= 1) return rows[0];
  const cwd = opts.cwd ?? process.cwd();
  let cwdReal = cwd;
  try {
    cwdReal = realpathSync(cwd);
  } catch {
    // cwd may not exist in tests
  }
  const byWt = rows.find((r) => pathsEqual(r.worktree, cwd, cwdReal));
  if (byWt) return byWt;
  const branch = opts.branch === undefined ? currentBranch(cwd) : opts.branch;
  return (branch ? rows.find((r) => r.branch === branch) : undefined) ?? rows[0];
}

export function pickSpinoffForReady(
  all: SpinoffRow[],
  opts: {
    ref?: string;
    cwd?: string;
    branch?: string | null;
    landedShaFor?: (row: SpinoffRow) => string | null;
    /** 1949: the item the typed ref resolves to, so `PS-12` finds a row parked under its bare `1925`. */
    itemId?: string | null;
  } = {},
): SpinoffRow {
  const readyable = all.filter((r) => isReadyableStatus(r.status));
  const ref = opts.ref?.trim();
  const sameItem = (r: SpinoffRow): boolean => opts.itemId != null && r.item_id === opts.itemId;
  if (ref) {
    if (/^\d+$/.test(ref)) {
      const byId = readyable.find((r) => r.id === Number(ref));
      if (byId) return byId;
    }
    const byTicket = ownLegFirst(readyable.filter((r) => ticketRefIs(r.ticket_ref, ref)), opts) ?? readyable.find(sameItem);
    if (byTicket) return byTicket;
    const byBranch = readyable.find((r) => r.branch === ref);
    if (byBranch) return byBranch;
    if (/^\d+$/.test(ref)) {
      const any = all.find((r) => r.id === Number(ref));
      if (any) throw new AppError(readyRefusalFor(any, opts.landedShaFor));
    }
    const anyTicket = all.find((r) => ticketRefIs(r.ticket_ref, ref)) ?? all.find(sameItem);
    if (anyTicket) {
      throw new AppError(readyRefusalFor(anyTicket, opts.landedShaFor));
    }
    throw new AppError(`no building spinoff matching '${ref}'`);
  }
  const cwd = opts.cwd ?? process.cwd();
  let cwdReal = cwd;
  try {
    cwdReal = realpathSync(cwd);
  } catch {
    // cwd may not exist in tests; match the raw path below
  }
  const byWt = readyable.find((r) => pathsEqual(r.worktree, cwd, cwdReal));
  if (byWt) return byWt;
  const branch = opts.branch ?? currentBranch(cwd);
  if (branch) {
    const byBr = readyable.find((r) => r.branch === branch);
    if (byBr) return byBr;
  }
  throw new AppError("no building spinoff for this worktree/branch; pass a ticket or spinoff id");
}

/**
 * Find the launched / ready-for-gate row a `spinoff ready` should act on. Store wrapper around
 * `pickSpinoffForReady`.
 */
export async function findSpinoffForReady(
  db: Database | Store,
  opts: { ref?: string; cwd?: string; landedShaFor?: (row: SpinoffRow) => string | null } = {},
): Promise<SpinoffRow> {
  const itemId = opts.ref ? await ticketItemIdFor(db, opts.ref) : null;
  return pickSpinoffForReady(await listSpinoffs(db), { ...opts, itemId });
}

function pathsEqual(worktree: string, cwd: string, cwdReal: string): boolean {
  if (worktree === cwd || worktree === cwdReal) return true;
  try {
    return realpathSync(worktree) === cwdReal;
  } catch {
    return false;
  }
}

function currentBranch(cwd: string): string | null {
  const r = sh(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
  const b = (r.out ?? "").trim();
  return r.ok && b && b !== "HEAD" ? b : null;
}

/**
 * Stamp a launched row `ready-for-gate`. Idempotent if it already is. Does NOT call `doneAgent`
 * (the row stays so the architect can see it). Releases the builder's `ticket:` / `worktree:` holds
 * (holder = `row.agent_id` or `row.branch`, including the `worktree:omnislash.<branch>` form) so the
 * architect can acquire them (426). Never a `architect-*` hold (341). The already-ready path still
 * releases leftover builder leases (the 418 case). Bumps the agent row's status to `readying` so
 * `ob agents` shows the same signal; a missing agent is not an error.
 */
export async function markSpinoffReady(
  db: Database | Store,
  row: SpinoffRow,
  decision: DecisionOpts = {},
  tierFit: TierFitRating | null = null,
): Promise<ReadySpinoffResult> {
  if (row.status !== READY_FOR_GATE && row.status !== "launched") {
    throw new AppError(`spinoff #${row.id} is ${spinoffStatusWord(row.status)}, not building (cannot hand off)`);
  }
  const already = row.status === READY_FOR_GATE;
  const s = asStore(db);
  let updated = row;
  // OB-1826: a spike answers on its parent and ends at `ob close`, so it is never handed off for a gate: the
  // row stays `launched` and `ob spinoff gateable` cannot list it. The host decides from the item's own tags,
  // so a client that did not check cannot stamp one by mistake.
  const spike = !already && isSpikeTagged(await spinoffTicketTagsFor(s, row.ticket_ref, row.item_id));
  if (spike) {
    // --note still goes on the trail, as building → building: the row does not move.
    await recordRowDecision(s, row, spinoffStatusWord(row.status), spinoffStatusWord(row.status), decision);
    const existing = await getAgent(s, builderIdOf(row));
    if (existing) {
      await registerAgent(s, {
        id: existing.id,
        status: "readying",
        note: "spike answered: the sentinel, else the architect, reads the notes on the parent, then closes the spike",
        ttlS: existing.ttl_s,
      });
    }
  } else if (!already) {
    updated = await moveSpinoff(s, row.id, READY_FOR_GATE, {}, ["launched"]);
    await recordRowDecision(s, row, spinoffStatusWord(row.status), spinoffStatusWord(READY_FOR_GATE), decision);
    await noteLegHandoff(s, row); // OB-1991: a trial leg's wall time ends at its handoff
    const agentId = builderIdOf(row);
    const existing = await getAgent(s, agentId);
    if (existing) {
      await registerAgent(s, {
        id: existing.id,
        status: "readying",
        note: "handed-off: the sentinel, else the architect, gates it",
        ttlS: existing.ttl_s,
      });
    }
  }
  const released = await releaseBuilderReadyLeases(s, updated);
  // 1552: the builder's rating of its own tier goes on the SAME decisions trail `--note` writes, as its own
  // row whose note is the tier-fit line. Recorded on a repeat too: each handoff rates its own attempt, and
  // a repeat's rating is exactly the data the tier statistics must not lose.
  const tierFitRecorded = tierFit ? tierFitLine(tierFit.fit, row.tier, row.model, tierFit.why) : null;
  if (tierFitRecorded) {
    await recordRowDecision(s, row, spinoffStatusWord(row.status), spinoffStatusWord(spike ? row.status : READY_FOR_GATE), {
      ...decision,
      note: tierFitRecorded,
    });
  }
  return { row: updated, already, leasesReleased: released.length > 0, tierFit: tierFitRecorded, spike };
}

/**
 * Move a handed-off row back to building (`launched`) for a send-back (OB-1805), the inverse of the stamp
 * `markSpinoffReady` makes. The builder's agent row goes back to `working` with the note, so the sidebar and
 * `ob agents` stop saying it is waiting for the architect. Refuses a row that is not handed-off. The builder's
 * released ticket:/worktree: holds are NOT re-taken: the architect holds the ticket for its gate, and the
 * builder's own `ob agent register` takes what it needs.
 */
export async function markSpinoffSentBack(db: Database | Store, row: SpinoffRow, decision: DecisionOpts = {}): Promise<SpinoffRow> {
  if (row.status !== READY_FOR_GATE) {
    throw new AppError(`spinoff #${row.id} is ${spinoffStatusWord(row.status)}, not handed-off (cannot send back)`);
  }
  const s = asStore(db);
  await retakeFlakeSlot(s, row, "send back"); // OB-2230: the handoff freed it, and the fix is building again
  const moved = await moveSpinoff(s, row.id, "launched", {}, [READY_FOR_GATE]);
  await recordRowDecision(s, row, spinoffStatusWord(READY_FOR_GATE), spinoffStatusWord("launched"), decision);
  await noteLegSendback(s, row); // OB-1991: a trial leg sent back did not pass the gate first time
  const existing = await getAgent(s, builderIdOf(row));
  if (existing) {
    await registerAgent(s, {
      id: existing.id,
      status: "working",
      note: `sent back by the sentinel, else the architect: ${(decision.note ?? "see the thread").slice(0, 200)}`,
      ttlS: existing.ttl_s,
    });
  }
  return moved;
}

/**
 * OB-2230: a flake row that goes back to building (a send-back, a reopen) takes `flake:slot` again for its
 * builder, since the handoff or land released it. Refused by name, before the row moves, when another flake
 * fix took the slot in the meantime: two flake builders must never run at once.
 */
async function retakeFlakeSlot(s: Store, row: SpinoffRow, what: string): Promise<void> {
  if (!(await flakeSlotKeyFor(s, row))) return;
  const took = await acquireLeases(s, [FLAKE_SLOT_KEY], builderIdOf(row), FLAKE_SLOT_TTL_S);
  if (took.ok) return;
  throw new AppError(
    `cannot ${what} #${row.id}: ${flakeSlotHeldMessage(took.hold.holder, await flakeSlotRefFor(s, took.hold.holder))}. ` +
      `Nothing changed; ${what} it once that fix hands off`,
  );
}

/**
 * `ob spinoff reopen` (OB-2180): a row reconcile marked landed although nothing merged goes back to building.
 * Only a `landed` row, and only the move the table allows from it; the caller has already refused a row whose
 * work is on main (that is git, so it is the client's read). The builder's agent row was finished by the land
 * and comes back with the builder's next `ob agent register`, which also re-takes its ticket lease.
 */
export async function markSpinoffReopened(db: Database | Store, row: SpinoffRow, decision: DecisionOpts = {}): Promise<SpinoffRow> {
  if (row.status !== "merged") {
    throw new AppError(`spinoff #${row.id} is ${spinoffStatusWord(row.status)}, not landed (nothing to reopen)`);
  }
  const s = asStore(db);
  await retakeFlakeSlot(s, row, "reopen"); // OB-2230: the land freed it, and the fix is building again
  const moved = await moveSpinoff(s, row.id, "launched", {}, ["merged"]);
  await recordRowDecision(s, row, spinoffStatusWord("merged"), spinoffStatusWord("launched"), decision);
  return moved;
}

/**
 * Undo a send-back whose builder could not be told (OB-1805): hand the row off again from what is STORED
 * now (OB-1920), never from the row as it was before the flip, so a row that moved in between is refused
 * (by `markSpinoffReady`'s guard and the table) rather than stamped from a made-up `launched`. The CLI and the
 * API restore both call this.
 */
export async function restoreSentBackRow(db: Database | Store, id: number, decision: DecisionOpts = {}): Promise<ReadySpinoffResult> {
  const stored = await getSpinoffRow(db, id);
  if (!stored) throw new AppError(`no spinoff #${id}`);
  return markSpinoffReady(db, stored, decision);
}

/**
 * The worktree checks a handoff runs before it stamps (OB-1920: one function, so the local CLI, the API
 * client and the API host cannot drift). A spike may carry documentation commits only (OB-1826, OB-2227); any other row needs a
 * gateable (clean) worktree. A worktree that is not on this disk is NOT a refusal here: the API host may
 * not have it, and the CLI's own "gone and not a repeat" refusal stays with the CLI.
 */
export function assertHandoffWorktree(
  row: Pick<SpinoffRow, "ticket_ref" | "branch" | "worktree" | "base_sha">,
  spike: boolean,
): void {
  if (!existsSync(row.worktree)) return;
  if (spike) assertSpikeDocsOnly(row, changedPathsFor(row.worktree, row.branch, row.base_sha));
  else assertWorktreeGateable(row.worktree);
}

/**
 * OB-2044: the CI guard both handoff paths run (the local command and the API client), after the worktree
 * checks and before the stamp. A thin wrapper over `assertHandoffCi` that supplies the row's checkout, the
 * branch tip and the shell seam; a refusal is an `AppError`, so nothing is stamped. `unchecked` is the
 * `--ci-unchecked '<why>'` override.
 */
export function assertHandoffCiForRow(
  row: Pick<SpinoffRow, "branch" | "worktree">,
  unchecked?: string | null,
): HandoffCiResult {
  return assertHandoffCi(
    { worktree: row.worktree, branch: row.branch, headSha: worktreeHeadSha(row.worktree), unchecked, sh },
    (message) => new AppError(message),
  );
}

/** The full SHA of the worktree's checked-out HEAD (a detached checkout differs from its branch ref). Null when git cannot say. */
function worktreeHeadSha(worktree: string): string | null {
  const r = sh(["git", "-C", worktree, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const out = (r.out ?? "").trim();
  return r.ok && /^[0-9a-f]{40}$/.test(out) ? out : null;
}

/** The CI line onto the handoff note that goes on the ticket's Decisions trail. */
export function noteWithCi(note: string | null, ci: HandoffCiResult): string | null {
  return [note, ci.line].filter(Boolean).join("\n\n") || null;
}

/** The CI line onto the builder's gate note, so the readying note's `gate:` line names what CI passed. */
export function gateNoteWithCi(builderNote: string | null, ci: HandoffCiResult): string | null {
  if (!ci.line) return builderNote;
  const base = builderNote?.trim();
  return base ? `${base}; ${ci.line}` : ci.line;
}

/**
 * Builder ticket:/worktree: holds, and the flake:slot (OB-2230), only (426). `releaseLeasesByHolder` exists but would also drop
 * an `app:` / `port:` the builder happened to hold, and would not distinguish an architect holder.
 */
async function releaseBuilderReadyLeases(db: Database | Store, row: SpinoffRow): Promise<string[]> {
  const holders = [...new Set([row.agent_id, row.branch, builderIdOf(row)].filter((h): h is string => !!h && !isTeamRoleAgent(h)))];
  const released: string[] = [];
  for (const holder of holders) {
    for (const resource of await listLeasesByHolder(db, holder)) {
      const cls = leaseKeyClass(resource);
      if (cls !== "ticket" && cls !== "worktree" && cls !== "flake") continue; // OB-2230: the flake slot goes with the handoff
      if (await releaseLease(db, resource, holder)) released.push(resource);
    }
  }
  return released;
}

/**
 * THE verdict of a row (OB-1992), for every reader: a recorded `ob spinoff state` verdict wins for every repo
 * (OS-78), and a row that recorded none reads the `State:` line in git.
 */
export function rowVerdictState(row: { worktree: string; branch: string } & RowVerdict): string | null {
  return verdictStateFor(row, () => readCommitState(row.worktree, row.branch));
}

/**
 * Record a clean repo's verdict on its row (OB-1992, `ob spinoff state`). The verdict cannot live in a clean
 * repo's commits, so it lives here; OmniSlash keeps its `State:` line in git and is refused. A landed row is
 * refused too: its verdict is history.
 */
export async function recordSpinoffVerdict(
  db: Database | Store,
  row: SpinoffRow,
  input: { verdict: string; reason?: string | null; gate?: string | null },
): Promise<SpinoffRow> {
  let verdict: string;
  try {
    verdict = parseRecordableVerdict(input.verdict);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (isObRepo(row.repo)) {
    throw new AppError(`${row.ticket_ref} is an OmniSlash build: its verdict is the State: line in the commit, not 'ob spinoff state'`);
  }
  if (row.status === "merged") throw new AppError(`${row.ticket_ref} (#${row.id}) is already landed: its verdict is not recorded again`);
  const s = asStore(db);
  const reason = input.reason?.replace(/\s+/g, " ").trim() || null;
  const gate = input.gate?.replace(/\s+/g, " ").trim() || null;
  await s.q.update(s.t.spinoff).set({ verdict, verdict_reason: reason, gate_line: gate }).where(eq(s.t.spinoff.id, row.id));
  return (await getSpinoffRow(s, row.id)) ?? { ...row, verdict, verdict_reason: reason, gate_line: gate };
}

/**
 * OB-1992: a PR's title and body, read with `gh pr view` behind the `sh` seam. null only when gh says there is
 * no PR; any other failure (auth, network, rate limit, output that is not JSON) is `{ error }`, so the leak
 * check fails closed instead of reading "could not look" as "nothing there".
 */
function readPrText(worktree: string, branch: string): { title: string; body: string } | { error: string } | null {
  const r = sh(["gh", "pr", "view", branch, "--json", "title,body"], worktree, 30_000);
  if (!r.ok) {
    const why = (r.err ?? "").trim();
    if (/no pull requests? found/i.test(why)) return null;
    return { error: why.split("\n")[0] || "gh pr view failed" };
  }
  try {
    const j = JSON.parse(r.out ?? "") as { title?: unknown; body?: unknown };
    return { title: String(j.title ?? ""), body: String(j.body ?? "") };
  } catch {
    return { error: "gh pr view printed something that is not JSON" };
  }
}

/**
 * What of ob a clean repo's branch, commits and PR carry (OB-1992), one refusal line per hit; empty for OmniSlash
 * and for a clean PR. The branch name is read as words (so `ps-12` is the ref it is); the commits are the
 * messages past main; the PR is read only when one exists. A git or gh read that fails is a line too (it fails
 * closed): the guard exists to keep ob out of a public PR. The diff itself is never read.
 */
export function cleanRepoLeakLines(
  row: { repo: string; branch: string; worktree: string; ticket_ref: string },
  keys: readonly string[],
): string[] {
  if (isObRepo(row.repo)) return [];
  const lines: string[] = [];
  const words = row.branch.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const branchLeaks = obLeaks(words.join(" "), keys).filter((l) => l.kind !== "ref");
  const key = refKey(row.ticket_ref);
  if (`-${row.branch.toLowerCase()}-`.replace(/[^a-z0-9.]+/g, "-").includes(`-${key}-`)) branchLeaks.unshift({ kind: "ref", match: key });
  lines.push(...renderLeaks(`branch ${row.branch}`, branchLeaks));
  const log = sh(["git", "-C", row.worktree, "log", "--format=%B", `${mainRefFor(row.worktree)}..${row.branch}`]);
  if (log.ok) lines.push(...renderLeaks("commits", obLeaks(log.out ?? "", keys)));
  else lines.push(`  commits: could not read them (${(log.err ?? "").trim().split("\n")[0] || "git log failed"}), so they were not checked`);
  const pr = readPrText(row.worktree, row.branch);
  if (pr && "error" in pr) lines.push(`  PR: could not read it (${pr.error}), so its title and body were not checked`);
  else if (pr) {
    lines.push(...renderLeaks("PR title", obLeaks(pr.title, keys)));
    lines.push(...renderLeaks("PR body", obLeaks(pr.body, keys)));
  }
  return lines;
}

/** The refusal `ob spinoff handoff` gives when a clean repo's PR carries ob. Nothing is stamped. */
export function cleanRepoLeakRefusal(ticket: string, lines: string[]): string {
  return [
    `${ticket} is in a clean repo, and its branch, commits or PR carry ob (or could not be read). Nothing was handed off:`,
    ...lines,
    "Reword them (subjects are `<type>(<area>): ...`, no ref; the verdict goes on the row with `ob spinoff state`,",
    "the Done check and review on the ticket with `--report <file>`), push, and hand off again.",
  ].join("\n");
}

/** The ref keys of every project (`OB`, `PS`, ...), so a leak check knows a ref from `UTF-8`. Never throws. */
export async function projectRefKeys(db: Database | Store): Promise<string[]> {
  try {
    return (await listProjects(db)).map((p) => p.key).filter((k): k is string => !!k);
  } catch {
    return [];
  }
}

/** `--report <file>`: the Done check and review, put on the ticket's Decisions trail with the handoff note. */
export function handoffNoteWithReport(note: string | null | undefined, reportPath: string | undefined): string | null {
  const parts = [note?.trim() || null];
  if (reportPath !== undefined) {
    if (!existsSync(reportPath)) throw new UsageError(`--report: no such file '${reportPath}'`);
    const text = readFileSync(reportPath, "utf8").trim();
    if (!text) throw new UsageError(`--report: '${reportPath}' is empty`);
    parts.push(text);
  }
  const joined = parts.filter(Boolean).join("\n\n");
  return joined || null;
}

/** What `ob spinoff state` prints: the row and the verdict as every reader will now see it. */
export function renderRecordedVerdict(row: SpinoffRow): string[] {
  const gate = row.gate_line ? [`  Gate: ${row.gate_line}`] : [];
  return [`recorded ${row.ticket_ref} (#${row.id}):`, ...stateDisplayLines(rowStateText(row)?.split("\n")[0] ?? null, "  "), ...gate];
}

/**
 * The newest `State:` line on the branch's commits not in main (HEAD only when that range cannot be read).
 * Null when git is missing, the branch has no commit past main (OB-2228), or no commit carries one. Pure over the `sh` seam.
 *
 * `git log` emits NEWEST FIRST, so the newest commit's line is the first match. Taking the last match
 * read the oldest commit instead (1639): a branch whose first commit said `partial` and whose tip said
 * `landable` was reported as partial, which is what ob-land and `ob spinoff gateable` read too.
 *
 * Only a VERDICT line counts: `State:` then one of the known words (STATE_VERDICT_TOKENS). A prose line
 * that happens to start `State:` (a wrapped commit body) is skipped, or it would be read as the verdict.
 */
export function readCommitState(worktree: string, branch: string): string | null {
  const ranged = sh(["git", "-C", worktree, "log", "--format=%B", `${mainRefFor(worktree)}..${branch}`]);
  // OB-2228: a range that was read and is empty means the branch has no commit past main. Its HEAD is a main
  // commit, so reading HEAD would borrow main's own State line and call a no-change branch landable. Only a
  // range git could not read (no main ref) falls back to HEAD.
  const text = (ranged.ok ? ranged.out : sh(["git", "-C", worktree, "log", "-1", "--format=%B"]).out) ?? "";
  const verdict = new RegExp(`^State:\\s+(?:${STATE_VERDICT_TOKENS.join("|")})(?![\\w-]).*$`, "m");
  const at = text.search(verdict);
  return at < 0 ? null : stateParagraph(text.slice(at));
}

/**
 * The `State:` paragraph that starts `text`: the verdict line plus its wrapped continuation lines, joined by a
 * space, up to a blank line or the next labelled line (`Gate:`, `Look at:`, `Run:`, a trailer). A builder wraps
 * the line at 72 columns, so reading one line cut the reason off mid-sentence (1579). Pure.
 */
export function stateParagraph(text: string): string {
  const [first = "", ...rest] = text.split("\n");
  const parts = [first.trim()];
  for (const line of rest) {
    if (!line.trim() || /^[A-Z][\w-]*(?: [a-z]+)?:\s/.test(line)) break;
    parts.push(line.trim());
  }
  return parts.join(" ");
}

/**
 * How many commits the branch has that its captured base does not (1133). Null when the row captured no
 * base, or when git cannot answer — the readying note then says `unreported`, which is the honest read;
 * a 0 would say "this branch carries no work", which is a different claim.
 */
/** The full SHA of a branch's tip, read in its worktree (OB-1805: the readying note's idempotence key). Null when git cannot say. */
export function headShaFor(worktree: string, branch: string): string | null {
  const r = sh(["git", "-C", worktree, "rev-parse", "--verify", "--quiet", `${branch}^{commit}`]);
  const out = (r.out ?? "").trim();
  return r.ok && /^[0-9a-f]{40}$/.test(out) ? out : null;
}

/**
 * Every path a branch itself changes (OB-2227), for the spike rule: the same merge-base range `readChangedPaths`
 * reads, so a spike that rebased onto main is not charged with what main gained. `--no-renames` lists both sides
 * of a rename and a deletion is listed too, so moving or deleting a code file reads as touching it. Null when
 * there is no range (no main and no base_sha) or git cannot say.
 */
export function changedPathsFor(worktree: string, branch: string, baseSha: string | null): string[] | null {
  return diffPathsFor(worktree, branch, baseSha, ["--no-renames"]);
}

/**
 * The URL of the open PR for a branch, read with `gh pr view` behind the `sh` seam (OB-2227, the same shape as
 * `readPrText`). Null when there is none, when gh fails, or when the PR is not open: the URL only enriches a
 * spike's note, so a failed read never refuses the handoff.
 */
export function openPrUrlFor(worktree: string, branch: string): string | null {
  const r = sh(["gh", "pr", "view", branch, "--json", "url,state"], worktree, 30_000);
  if (!r.ok) return null;
  try {
    const j = JSON.parse(r.out ?? "") as { url?: unknown; state?: unknown };
    const url = typeof j.url === "string" ? j.url.trim() : "";
    return url && String(j.state).toUpperCase() === "OPEN" ? url : null;
  } catch {
    return null;
  }
}

/** What a spike's handoff says about its branch (OB-2227): whether it carries a doc commit, and its open PR. */
export function spikeDocFactsFor(row: Pick<SpinoffRow, "worktree" | "branch" | "base_sha">): { committed: boolean; prUrl: string | null } {
  if (!existsSync(row.worktree)) return { committed: false, prUrl: null };
  const committed = (changedPathsFor(row.worktree, row.branch, row.base_sha) ?? []).length > 0;
  return { committed, prUrl: committed ? openPrUrlFor(row.worktree, row.branch) : null };
}

export function commitsAheadFor(worktree: string, branch: string, baseSha: string | null): number | null {
  if (!baseSha) return null;
  const r = sh(["git", "-C", worktree, "rev-list", "--count", `${baseSha}..${branch}`]);
  if (!r.ok) return null;
  const n = Number((r.out ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * The commit a land left on `main` for a ticket, or null when it cannot be read (1133).
 *
 * The repo squashes with a subject naming the ob item (`feat(ob 1133): …`), so the newest commit on main
 * whose subject carries `(ob <ref>)` IS the land. Deliberately NOT "main's tip": if another land or a
 * chart commit lands between the squash and the close, the tip is a different ticket's commit — and a
 * wrong sha in a note is worse than an unreported one. A ref that names nothing (a branch-name ref, a
 * chart-only commit) reports null, which the note prints as unreported.
 */
export function landCommitFor(repo: string, ticketRef: string): string | null {
  // (1760) the land is on origin/main; a checkout that lands from its own worktree never moves local `main`.
  const r = sh([
    "git",
    "-C",
    repo,
    "log",
    mainRefFor(repo),
    "-1",
    "--fixed-strings",
    "--grep",
    `(ob ${ticketRef})`,
    "--format=%h",
  ]);
  if (!r.ok) return null;
  const sha = (r.out ?? "").trim().split("\n")[0]?.trim();
  return sha && sha.length > 0 ? sha : null;
}

/**
 * OB-2180: why reconcile would land this row again, read from THIS machine's checkout, or null. `ob spinoff
 * reopen` refuses a row that has one, since reopening it would only last until the next reconcile. The
 * same two git signals reconcile reads: a LANDING commit naming the ticket on main since base_sha (its
 * short sha), or the branch merged into main with commits of its own. The third, a done ticket, is the
 * caller's read (the tracker is not git). A main that cannot be read is a refusal, never a "nothing landed".
 */
export function rowRelandReason(repo: string, row: Pick<SpinoffRow, "ticket_ref" | "base_sha" | "branch">): string | null {
  const ref = mainRefFor(repo);
  // Exactly the commits since base, uncapped: an old land past gitLog's window is still a land (a review
  // round on this ticket). With no base recorded, the capped log and every commit in it, as reconcile reads it.
  const log = row.base_sha ? gitLog(repo, `${row.base_sha}..${ref}`, 2_000_000_000) : gitLog(repo, ref);
  if (!log.ok) throw new AppError(`cannot read ${ref} in ${repo} to check whether ${row.ticket_ref} landed: ${log.err}`);
  const hit = landingCommitFor(row.ticket_ref, { commits: log.value, baseSha: null });
  if (hit) return `merged as ${hit.sha.slice(0, 8)} on main`;
  if (gitMergedChecker()(repo, row.branch)) {
    if (gitUniqueCommitCount()(repo, row.base_sha, row.branch) > 0) return `its branch ${row.branch} is merged into main with commits of its own`;
    // an old row with no base and no reflog: whether the merged branch did any work cannot be told, so no
    if (!row.base_sha && !branchForkPoint(repo, row.branch)) return `its branch ${row.branch} is merged into main and the row records no base_sha to tell whether that was its own work`;
  }
  return null;
}

export function readChangedPaths(worktree: string, branch: string, baseSha: string | null): string[] {
  return diffPathsFor(worktree, branch, baseSha, []) ?? [];
}

/** The paths `main...branch` changes (base_sha when there is no main), or null when there is no range or git fails. */
function diffPathsFor(worktree: string, branch: string, baseSha: string | null, extra: readonly string[]): string[] | null {
  const mainOk = sh(["git", "-C", worktree, "rev-parse", "--verify", MAIN_BRANCH]);
  const range = mainOk.ok ? `${mainRefFor(worktree)}...${branch}` : baseSha ? `${baseSha}...${branch}` : null;
  if (!range) return null;
  const r = sh(["git", "-C", worktree, "diff", "--name-only", ...extra, range]);
  if (!r.ok) return null;
  return (r.out ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** OB-2131: the `files:` comparison for `ob spinoff show`: the go check's planned files against the branch diff. */
export function showFilesFor(row: { worktree: string; branch: string; base_sha?: string | null }, planned: PlannedFiles): FilesComparison {
  const missing = !existsSync(row.worktree);
  return compareFiles(planned, missing ? [] : readChangedPaths(row.worktree, row.branch, row.base_sha ?? null), missing);
}

export function gateableFactsFor(row: GateableSource & RowVerdict & { base_sha?: string | null }): GateableFacts {
  if (!existsSync(row.worktree)) return { missing: true, state: null, paths: [] };
  return {
    missing: false,
    state: rowVerdictState(row),
    paths: readChangedPaths(row.worktree, row.branch, row.base_sha ?? null),
  };
}

function porcelainPath(line: string): string {
  const rest = line.length >= 3 ? line.slice(3) : line.trim();
  const arrow = rest.lastIndexOf(" -> ");
  return (arrow >= 0 ? rest.slice(arrow + 4) : rest).trim();
}

export function readDirtyPaths(worktree: string): string[] {
  const r = sh(["git", "-C", worktree, "status", "--porcelain"]);
  if (!r.ok) throw new AppError(`cannot read git status in ${worktree}${r.err ? `: ${r.err}` : ""}`);
  return (r.out ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => porcelainPath(line));
}

/**
 * The worktree a readying decision is about must be THERE, and CLEAN (1188, and 391's dirty rule).
 *
 * MISSING USED TO RETURN SILENTLY, and that is the hole the 1163 wake walked through: a builder woken by
 * its own land reply is bounded by nothing, so it can re-derive a landed ticket and announce it — while
 * the only check standing in front of the announce (this one, meant to catch exactly that) passed a
 * checkout that had been deleted with the land. The worktree is the thing a gate is about; without it
 * there is nothing to gate, and saying so refuses the false announce instead of composing a note for it.
 *
 * The `ready` paths call this for a row that still owes a gating decision. A row ALREADY stamped
 * `ready-for-gate` keeps its 426 cleanup instead (see `worktreeGoneNoteOutcome`): the stamp is a no-op
 * there, the leftover-hold release is the point of a repeat, and nothing is announced.
 */
export function assertWorktreeGateable(worktree: string): void {
  if (!existsSync(worktree)) throw new AppError(missingWorktreeRefusal(worktree));
  const paths = readDirtyPaths(worktree);
  if (paths.length === 0) return;
  throw new AppError(
    `worktree is dirty; commit first, then hand off again (do not invent a commit):\n${paths.map((p) => `  ${p}`).join("\n")}`,
  );
}

/** What the architect (or the human who just declared) should see. Pure. */
export function formatReadyReport(row: SpinoffRow, state: string | null, already = false): string {
  const landable = isLandable(state, { handedOff: true });
  return [
    already ? `${row.ticket_ref} already handed off` : `${row.ticket_ref} handed off`,
    `  ticket:    ${row.ticket_ref}`,
    `  branch:    ${row.branch}`,
    `  worktree:  ${row.worktree}`,
    ...stateDisplayLines(state),
    `  landable: ${landable ? "yes" : "no"}`,
    landable
      ? "  next:      the sentinel, else the architect, gates and merges the PR (the handoff is the human yes)"
      : "  next:      do not merge: State is blocked, partial, or missing",
  ].join("\n");
}

export function readyResultJson(
  // The local result, or the wire response (1552's `tierFit` is absent from a host that predates it).
  result: { row: SpinoffRow; already: boolean; leasesReleased: boolean; tierFit?: string | null },
  state: string | null,
): Record<string, unknown> {
  return {
    id: result.row.id,
    ticket: result.row.ticket_ref,
    branch: result.row.branch,
    worktree: result.row.worktree,
    status: spinoffStatusWord(result.row.status),
    already: result.already,
    state,
    tier_fit: result.tierFit ?? null,
    leases_released: result.leasesReleased,
  };
}

/**
 * Compose and send the readying note for a stamped row (1133), from facts ob holds on this machine: the
 * branch's commits past its captured base, the last `State:` line the caller read, and the builder's own
 * readying note (read BEFORE the stamp rewrote it).
 *
 * Never throws and never gates: the caller prints the outcome, and a failure is a warning plus exit 1 —
 * the stamp and the lease release stand, because a notifier must not fail the thing it reports on. A row
 * that did not run under the t3 launcher, or a repo with no architect thread, is a NAMED SKIP and neither
 * case reads a credential.
 */
async function announceReadyForRow(
  store: Database | Store,
  row: SpinoffRow,
  state: string | null,
  builderNote: string | null,
  tierFit: string | null,
  repeat = false,
  spike = false,
  spikeDoc: { committed: boolean; prUrl: string | null } | null = null,
): Promise<ReadyNoteOutcome> {
  // OB-2255: the note goes to the ticket's team's sentinel, else its architect; a project in no team gets none.
  const registry = storeAgentRegistry(store);
  const route = await teamHandoffTarget({ ticket: row.ticket_ref, projectOf: () => rowProjectOf(store, row), teamOf: storeTeamOf(store), registry });
  const outcome = await announceReadyNote(registry, {
    row,
    route,
    launcher: row.launcher,
    state,
    builderNote,
    commitsAhead: commitsAheadFor(row.worktree, row.branch, row.base_sha),
    tierFit,
    headSha: headShaFor(row.worktree, row.branch),
    repeat,
    spike,
    spikeCommitted: spikeDoc?.committed ?? false,
    prUrl: spikeDoc?.prUrl ?? null,
    inbox: (msg) => sendRoleMessage(store, { ...msg, from: builderIdOf(row), kind: "handoff" }),
    // OS-56: the stored handoff goes into the role's run, started if none is open. Imported here: role.ts imports this module.
    deliver: async (team, role, seam) => {
      const [{ deliverToRole }, { storeRoleBackend }, { storeInboxBackend }] = await Promise.all([
        import("../../../../apps/cli/src/role-deliver.ts"),
        import("../../../../apps/cli/src/commands/role.ts"),
        import("../../../../apps/cli/src/commands/inbox.ts"),
      ]);
      return deliverToRole(storeRoleBackend(store), storeInboxBackend(store), seam, team, role);
    },
  });
  return recordReadyNoteOutcome(store, row.id, outcome);
}

/**
 * OB-2245: the project of the item a row serves (its id), or null when the row names no item or the item has
 * no project. A read that fails throws, so `teamHandoffTarget` says so instead of taking it for "no project".
 */
export async function rowProjectOf(db: Database | Store, row: Pick<SpinoffRow, "ticket_ref" | "item_id">): Promise<string | null> {
  const itemId = await rowItemId(asStore(db), row);
  return itemId ? ((await getItem(asStore(db), itemId))?.project_id ?? null) : null;
}

/** OB-2172: the `note_error` text for a failed note: when, then T3's reason, on one line. Pure. */
export function noteErrorText(reason: string | null, at: Date = new Date()): string {
  return `${at.toISOString()} ${(reason ?? "no reason given").replace(/\s+/g, " ").trim()}`;
}

/**
 * OB-2172: keep the readying note's outcome on the row, so an architect nobody told by hand still learns of it.
 * A failed note (after its one retry) sets `note_error` and the outcome says where it is recorded; a sent note
 * clears it. A skip leaves it as it was. Never throws: a write that fails is returned as `recordError`.
 */
export async function recordReadyNoteOutcome(store: Database | Store, rowId: number, outcome: ReadyNoteOutcome): Promise<ReadyNoteOutcome> {
  if (outcome.outcome === "skipped") return outcome;
  const s = asStore(store);
  const noteError = outcome.outcome === "failed" ? noteErrorText(outcome.reason) : null;
  try {
    await s.q.update(s.t.spinoff).set({ note_error: noteError }).where(eq(s.t.spinoff.id, rowId));
  } catch (err) {
    return { ...outcome, recordError: (err as Error).message };
  }
  return outcome.outcome === "failed" ? { ...outcome, recordedOn: rowId } : outcome;
}


// --- watch: push delivery of spinoff completions (#36) ---------------------
// The architect can't poll for spinoffs finishing. `ob spinoff watch` BLOCKS, watching the DB directory
// (reusing realtime.ts's fs.watch + debounce): every DB change (an agent heartbeat, `ob agent done`,
// any ob write) triggers a git-state reconcile, and each spinoff that NEWLY transitions to done is
// printed once. `--once` exits 0 after the first such transition so an architect can run it as a one-shot
// background task and be re-invoked. Reportedness is PERSISTED in the DB (#41): a completion is emitted
// only while `spinoff.reported_at` is NULL, and stamping it happens right AFTER the print, never before
// (74): a row stamped but not yet announced would be lost forever. That is what makes the
// signal usable - an in-memory id set restarted empty in every process, so a fresh `watch` replayed the
// entire historical `merged` backlog on its first tick and `--once` exited on that backlog instead of on
// the completion the architect was waiting for. The DB is also the only gate that survives some OTHER
// process (`spinoff reconcile` / `spinoff drain`, both of which call reconcileSpinoffs) transitioning a
// row first. Migration 0019 backfills `reported_at` for rows already `merged`, so the backlog starts
// pre-reported.

/** A spinoff that just transitioned to done, for the watch report. */
export interface DoneSpinoff {
  id: number;
  ticket_ref: string;
  branch: string;
  outcome: string;
}
/**
 * Per-run watch state: the ids reported by THIS process, a record only. `spinoff.reported_at` is the
 * authoritative gate (moveSpinoff re-arms it on each handoff and merge), so a brand-new state object never
 * re-reports an already-reported row and a reused one never swallows a re-armed one.
 */
export interface SpinoffWatchState {
  reported: Set<number>;
}

/** A concise one-line report for a newly-done spinoff: ticket · branch · outcome. Pure. */
export function formatDoneSpinoff(d: DoneSpinoff): string {
  // 1513: no "done" here — the outcome names the step (`handed off` / `landed on main`).
  return `✓ ${d.ticket_ref} · ${d.branch} · ${d.outcome}`;
}

/**
 * One watch tick — the PURE, injectable core of `ob spinoff watch` (no watcher, no I/O beyond the git
 * seam + db + the injected `emit`, unit-testable with a fake `isMerged`). Reconciles launched spinoffs by
 * git-state, then, for each `merged` spinoff whose `reported_at` is still NULL, ANNOUNCES it via `emit`
 * and only THEN stamps `reported_at`, so no later tick, no later PROCESS, and no fresh
 * `SpinoffWatchState` can emit that same status again (#41); a handoff and a later merge are two reports (OB-1924). The ordering is the point (74): a print cannot be made
 * transactional with the write, so stamping first left a window where a crash lost the completion for
 * good (stamped, never announced, so nothing ever re-emits it). Emitting first degrades the other way
 * instead: at worst a repeat report, never a lost one. Returns the emitted completions.
 * Graceful: a git/db error is swallowed and one row whose `emit` throws is skipped with `reported_at`
 * left NULL (a later tick or process re-emits it), neither killing the watcher nor discarding the rows
 * already emitted in this tick.
 */
export async function watchReconcileTick(
  db: Database | Store,
  state: SpinoffWatchState,
  emit: (done: DoneSpinoff) => void,
  isMerged: MergeChecker = gitMergedChecker(),
): Promise<DoneSpinoff[]> {
  const newly: DoneSpinoff[] = [];
  try {
    await reconcileSpinoffs(db, isMerged);
    for (const row of await unreportedDoneSpinoffs(db)) {
      // No skip on state.reported (OB-1924): a row re-armed by a merge after its handoff, or a second
      // handoff after a sendback, has the same id and must be reported again. reported_at NULL decides.
      const outcome = row.status === READY_FOR_GATE ? "handed off" : "landed on main";
      const done: DoneSpinoff = { id: row.id, ticket_ref: row.ticket_ref, branch: row.branch, outcome };
      try {
        emit(done);
        await markSpinoffReported(db, row.id, row.status);
        state.reported.add(row.id);
        newly.push(done);
      } catch {
        continue; // unannounced: leave reported_at NULL so this completion is re-emitted, never lost
      }
    }
  } catch {
    // a git/db hiccup must not kill the watcher, so skip the rest of this tick, try again on next change
  }
  return newly;
}

/** The `merged` / `ready-for-gate` spinoffs never yet reported by a watch (`reported_at` NULL), newest first. */
export async function unreportedDoneSpinoffs(db: Database | Store): Promise<SpinoffRow[]> {
  const s = asStore(db);
  return (await s.q
    .select()
    .from(s.t.spinoff)
    .where(and(inArray(s.t.spinoff.status, [...WATCHABLE_DONE_STATUSES]), isNull(s.t.spinoff.reported_at)))
    .orderBy(desc(s.t.spinoff.id))) as SpinoffRow[];
}

/** Rows reconcile may land: still launched, or already stamped ready-for-gate (391). */
async function landableSpinoffs(db: Database | Store): Promise<SpinoffRow[]> {
  const launched = await listSpinoffs(db, "launched");
  const ready = await listSpinoffs(db, READY_FOR_GATE);
  return [...launched, ...ready];
}

/**
 * Stamp a spinoff as reported, so its completion is never emitted a second time by any process. Only while the
 * row still has the status that was announced: a row that moved on meanwhile (handed off, then merged) was
 * re-armed by moveSpinoff, and a late stamp must not swallow the next report (OB-1924).
 */
export async function markSpinoffReported(db: Database | Store, id: number, announcedStatus?: string): Promise<void> {
  const s = asStore(db);
  const where = announcedStatus ? and(eq(s.t.spinoff.id, id), eq(s.t.spinoff.status, announcedStatus)) : eq(s.t.spinoff.id, id);
  await s.q.update(s.t.spinoff).set({ reported_at: nowIso() }).where(where);
}

/**
 * Block, watching the DB directory, reconciling on every debounced change and printing each newly-done
 * spinoff. Does one immediate reconcile+report on start (already-done-but-unreported per the persisted
 * `reported_at`, so NOT the historical backlog), then watches. With `once`, exits after the first
 * reported completion (initial or later). The reconcile core is `watchReconcileTick` (pure/injectable) so
 * tests never need a real watcher; `isMerged` defaults to the git-state checker. The printing is handed
 * to the tick as its `emit` callback so a row is announced BEFORE it is stamped reported (74).
 */
export async function watchSpinoffs(
  db: Database,
  dbPath: string,
  opts: { once?: boolean; json?: boolean; debounceMs?: number; isMerged?: MergeChecker } = {},
): Promise<void> {
  const state: SpinoffWatchState = { reported: new Set() };
  const isMerged = opts.isMerged ?? gitMergedChecker();
  const emit = (d: DoneSpinoff) => print(opts.json ? JSON.stringify(d) : formatDoneSpinoff(d));

  const initial = await watchReconcileTick(db, state, emit, isMerged);
  if (opts.once && initial.length) return;

  const dir = dirname(dbPath);
  const base = basename(dbPath);
  const debounceMs = opts.debounceMs ?? 250;

  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const watcher: FSWatcher = watch(dir, (_event, filename) => {
      if (filename && !filename.startsWith(base)) return; // only the DB family (omnislash.sqlite/-wal/-shm)
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // The tick is async now, so its rejection has to be caught here rather than by the try/catch it
        // used to sit inside: an unhandled rejection from a timer would take the watcher down, which is
        // exactly what this whole function is written not to do.
        void watchReconcileTick(db, state, emit, isMerged)
          .then((done) => {
            if (opts.once && done.length) finish();
          })
          .catch(() => {});
      }, debounceMs);
    });
    const finish = () => {
      if (timer) clearTimeout(timer);
      watcher.close();
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    // graceful shutdown on signal so a foreground/background run exits cleanly (no TTY assumptions).
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

/**
 * Why `ob spinoff watch` refuses under OMNISLASH_STORE=postgres (337). Named here rather than inline so the
 * refusal can be asserted without running the watcher.
 */
export const WATCH_UNDER_POSTGRES_MSG = [
  `'ob spinoff watch' watches the SQLite database FILE for changes, and ${STORE_ENV}=postgres has no file to watch.`,
  `  refusing: it would block forever and report no completion, rather than fail.`,
  `  every other 'ob spinoff' subcommand (drain, reconcile, list, cleanup, brief, ready, claim/stamp/land/reclaim) is served from Postgres.`,
  `  to watch now: ${SQLITE_ESCAPE_HATCH} (the sqlite file still exists, but it is FROZEN at the cutover), or poll 'ob spinoff list --status landed'.`,
].join("\n");

/** The most-recently-completed spinoffs (`merged` or `ready-for-gate`), newest first — a cheap `ob status` surface (#36/#391). */
export async function recentlyDoneSpinoffs(db: Database | Store, limit = 5): Promise<SpinoffRow[]> {
  const s = asStore(db);
  return (await s.q
    .select()
    .from(s.t.spinoff)
    .where(inArray(s.t.spinoff.status, [...WATCHABLE_DONE_STATUSES]))
    .orderBy(desc(s.t.spinoff.id))
    .limit(limit)) as SpinoffRow[];
}

// --- worktree cleanup (217, 138) -------------------------------------------
// A HUMAN-RUN sweep of the worktrees + local branches the spinoff/agent fleet leaves behind once a
// task is DONE (its PR merged). Git state is the source of truth (NOT the spinoff table): a worktree
// whose branch is fully merged into `main` AND is clean is safe to remove; anything dirty or unmerged
// is SKIPPED with a reason (we never delete unmerged/dirty work). A worktree a live process was
// launched from is also SKIPPED, even with `--force` (ob 138): git-clean is not "nothing is using
// this tree", and could-not-tell is skip rather than remove (#121). The main checkout is never
// touched. Default is safe; `--force` is the explicit opt-in to also remove dirty/unmerged. No
// daemon — a person runs it.

export const MAIN_BRANCH = "main";

export interface WorktreeInfo {
  path: string;
  branch: string | null; // null = detached HEAD / bare (no local branch to delete)
  isMain: boolean; // the primary repo checkout — never a cleanup candidate
}

/** Parse `git worktree list --porcelain` into worktree records. The first block is the main checkout. Pure. */
export function parseWorktreeList(porcelain: string): WorktreeInfo[] {
  const blocks = porcelain
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const out: WorktreeInfo[] = [];
  blocks.forEach((block, i) => {
    let path = "";
    let branch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      // "detached" / "bare" lines leave branch null
    }
    if (path) out.push({ path, branch, isMain: i === 0 });
  });
  return out;
}

export interface CleanupCandidate {
  branch: string;
  path: string;
  merged: boolean; // branch fully merged into main
  dirty: boolean; // worktree has uncommitted changes
  isMain: boolean; // the primary repo checkout
}
export interface CleanupDecision {
  action: "remove" | "skip";
  reason?: string;
}

/**
 * The cleanup decision for one worktree/branch — PURE, fully unit-testable. The main checkout is
 * NEVER removed (even with `--force`). Otherwise `--force` removes regardless; the safe default keeps
 * anything dirty (uncommitted work) or unmerged (not in main yet), reporting why it was skipped.
 */
export function decideCleanup(c: CleanupCandidate, opts: { force?: boolean } = {}): CleanupDecision {
  if (c.isMain) return { action: "skip", reason: "main checkout — never removed" };
  if (opts.force) return { action: "remove" };
  if (c.dirty) return { action: "skip", reason: "uncommitted changes (use --force to override)" };
  if (!c.merged) return { action: "skip", reason: "not merged into main (use --force to override)" };
  return { action: "remove" };
}

/**
 * Every ticket ref known to map to `branch`/`path`: from the spinoff queue (durable, since it outlives the
 * agent row) and from the LIVE agent registry (covers a hand-registered or adopted agent, #61, that has
 * no spinoff row). Used to derive the `ticket:` keys a worktree/branch removal must respect (#97).
 */
async function ticketsForCandidate(db: Database | Store, branch: string | null, path: string): Promise<string[]> {
  const s = asStore(db);
  const refs = new Set<string>();
  if (branch) {
    const rows = (await s.q
      .select({ ticket: s.t.spinoff.ticket_ref })
      .from(s.t.spinoff)
      .where(eq(s.t.spinoff.branch, branch))) as Array<{ ticket: string }>;
    for (const r of rows) if (r.ticket) refs.add(r.ticket);
  }
  for (const a of await listAgents(s)) {
    if (!a.ticket) continue;
    if ((branch && a.branch === branch) || (path && a.worktree === path)) refs.add(a.ticket);
  }
  return [...refs];
}

/**
 * The lease keys a cleanup candidate is covered by (#97): its `worktree:<path>` plus a `ticket:<ref>` for
 * every ticket that maps to it. Holding EITHER blocks the removal, because a ticket and its worktree are
 * only ~1:1 (adopted worktrees, #61, break the mapping) and an architect may hold whichever it knows.
 */
export async function cleanupLeaseKeys(
  db: Database | Store,
  branch: string | null,
  path: string,
): Promise<Array<string | null>> {
  return [worktreeLeaseKey(path), ...(await ticketsForCandidate(db, branch, path)).map(ticketLeaseKey)];
}

/**
 * The two DATABASE questions a cleanup sweep asks about one candidate (360): is a live foreign session
 * holding it, and is there a registry row a removal would clear. Everything else `cleanup` does is git on
 * this disk, so this is the whole seam the API client has to fill -- and filling it is why `cleanup` works
 * from anywhere the laptop is rather than refusing off-LAN.
 */
export interface CleanupData {
  hold(branch: string | null, path: string): Promise<LeaseHold | null>;
  agentExists(branch: string): Promise<boolean>;
  /**
   * 1120: a reason to SKIP this worktree because of T3, or null when T3 says it is clear. A `t3` row's
   * worktree belongs to a thread that may be mid-run, and deleting the checkout under a live builder is
   * not recoverable. Optional because it is the one question an API CLIENT cannot ask: the thread ids
   * live in the database on the host while T3 and the worktree live here, and the split rig is S2's to
   * delete rather than P2's to extend. Absent, the guard is skipped (the store-backed form always has it).
   */
  t3Hold?(path: string): Promise<string | null>;
  /**
   * OB-2159: the live spinoff row (queued, launching, building or handed-off) whose worktree is `path` or
   * whose branch is `branch`, or null when none is. Required in both forms: the row's own status is the
   * one fact that says a builder still owns this checkout when its lease has lapsed, its thread is between
   * turns and its branch has no commits yet (so git reads it as merged). Throwing means "could not tell",
   * and the sweep skips the candidate.
   */
  liveRow(branch: string | null, path: string): Promise<LiveSpinoffRow | null>;
}

/** A live spinoff row as the cleanup guard reports it (OB-2159). */
export interface LiveSpinoffRow {
  id: number;
  status: string;
  ref: string;
}

/**
 * The first live row among `rows` that owns `branch` or `path` (OB-2159). Paths compare canonicalised, so
 * two spellings of one checkout match; an empty path (the branch-only pass) matches by branch alone. Pure
 * apart from the realpath read.
 */
export function findLiveRow(
  rows: ReadonlyArray<{ id: number; status: string; ticket_ref: string; branch: string | null; worktree: string | null }>,
  branch: string | null,
  path: string,
): LiveSpinoffRow | null {
  const want = path ? canonicalPath(path) : null;
  for (const r of rows) {
    if (!IN_FLIGHT.has(r.status)) continue; // live: queued, launching, building, handed-off
    const byBranch = branch != null && r.branch === branch;
    const byPath = want != null && !!r.worktree && canonicalPath(r.worktree) === want;
    if (byBranch || byPath) return { id: r.id, status: r.status, ref: r.ticket_ref };
  }
  return null;
}

/** The skip reason for a live row (OB-2159): names the row and how to retire it if it is stale. Pure. */
function liveRowReason(row: LiveSpinoffRow): string {
  return `live spinoff row ${row.id} ${row.ref} (${spinoffStatusWord(row.status)}): retire it with ob spinoff abandon ${row.ref} if it is stale`;
}

/** The store-backed live-row read (OB-2159): one query over the live rows, matched by branch or path. */
export async function storeLiveRow(db: Database | Store, branch: string | null, path: string): Promise<LiveSpinoffRow | null> {
  const s = asStore(db);
  const rows = (await s.q
    .select({
      id: s.t.spinoff.id,
      status: s.t.spinoff.status,
      ticket_ref: s.t.spinoff.ticket_ref,
      branch: s.t.spinoff.branch,
      worktree: s.t.spinoff.worktree,
    })
    .from(s.t.spinoff)
    .where(inArray(s.t.spinoff.status, [...IN_FLIGHT]))) as Array<{
    id: number;
    status: string;
    ticket_ref: string;
    branch: string | null;
    worktree: string | null;
  }>;
  return findLiveRow(rows, branch, path);
}

/** The store-backed `CleanupData`: the reads `cleanup` has always made, plus the live-row read. */
export function storeCleanupData(db: Database | Store): CleanupData {
  return {
    hold: async (branch, path) => foreignHold(db, await cleanupLeaseKeys(db, branch, path), [leaseHolderId()]),
    agentExists: async (branch) => (await getAgent(db, branch)) != null,
    t3Hold: storeT3HoldProbe(db),
    liveRow: (branch, path) => storeLiveRow(db, branch, path),
  };
}

/**
 * The live-row guard (OB-2159) as the sweep runs it: a reason to skip, or null when no live row owns the
 * candidate. A failed read is a skip, never a removal. Outranks --force like the lease and t3 guards.
 */
async function liveRowSkip(data: CleanupData, branch: string | null, path: string): Promise<string | null> {
  try {
    const row = await data.liveRow(branch, path);
    return row ? liveRowReason(row) : null;
  } catch (err) {
    return `could not read spinoff rows: ${(err as Error).message}`;
  }
}

export interface CleanupEntry {
  kind: "worktree" | "branch";
  branch: string | null;
  path?: string;
  action: "removed" | "skipped";
  reason?: string;
  agent_done?: boolean; // an agent-registry row was (or would be) cleared for this branch
}
export interface CleanupSummary {
  dry_run: boolean;
  force: boolean;
  removed: CleanupEntry[];
  skipped: CleanupEntry[];
  db_failures: DbHalfFailure[]; // removed HERE, still registered THERE (191)
  /** OB-2141: why the merged-PR read failed, so squash merges went unrecognised. Absent when it was read. */
  github_error?: string;
}

/** What `mergedBranches` found: the merged set, and why GitHub could not be read (null when it was). */
interface MergedRead {
  merged: Set<string>;
  github_error: string | null;
}

/**
 * Parse the merged-PR read (OB-2141): one `["<head ref>","<head sha>"]` JSON array per line, which is what
 * `gh api --paginate … --jq '.[] | select(.merged_at) | [.head.ref, .head.sha]'` prints for every page.
 * Returns head ref → every head sha a merged PR had for it (a branch name can be reused). Pure; a line
 * that is not such an array is ignored.
 */
export function parseMergedPrHeads(out: string): Map<string, Set<string>> {
  const heads = new Map<string, Set<string>>();
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      continue;
    }
    if (!Array.isArray(v) || typeof v[0] !== "string" || typeof v[1] !== "string") continue;
    const set = heads.get(v[0]) ?? new Set<string>();
    set.add(v[1]);
    heads.set(v[0], set);
  }
  return heads;
}

/** The GitHub read times out rather than hang a cleanup: a big repo's history is a few pages a second. */
const MERGED_PR_READ_TIMEOUT_MS = 180_000;

/** What the merged-PR read returns: head ref → head shas, or why it could not be read. */
export type MergedPrHeads = { heads: Map<string, Set<string>> } | { error: string };
export type MergedPrReader = (repo: string) => MergedPrHeads;

/**
 * Every merged pull request's head (ref and sha) for `repo`'s GitHub remote, in ONE paginated read with no
 * cap (`gh pr list --limit` would silently drop old PRs). An error string when it cannot be read: no
 * GitHub remote, no `gh`, no network. Never a guess. `run` is the shell runner, run in `repo`.
 */
export function githubMergedPrHeads(repo: string, run: Sh): MergedPrHeads {
  // gh fills {owner}/{repo} from the checkout's remote, and says so on stderr when there is no GitHub one
  const r = run(
    [
      "gh",
      "api",
      "--paginate",
      "repos/{owner}/{repo}/pulls?state=closed&per_page=100",
      "--jq",
      ".[] | select(.merged_at) | [.head.ref, .head.sha]",
    ],
    repo,
    MERGED_PR_READ_TIMEOUT_MS,
  );
  if (!r.ok) return { error: (r.err || "gh api failed").split("\n")[0]!.trim() };
  return { heads: parseMergedPrHeads(r.out ?? "") };
}

/**
 * The merged-PR seam (OB-2141). Its own seam rather than `sh`, so the git fakes the cleanup guard tests
 * already use see exactly the commands they always did. The test preload sets `OB_GITHUB_PR_READ=off`,
 * so no test reaches GitHub.
 */
const mergedPrReadSeam = defineSeam<MergedPrReader>("cli-coord/spinoff.mergedPrRead", (repo) =>
  process.env.OB_GITHUB_PR_READ === "off"
    ? { error: "GitHub read disabled (OB_GITHUB_PR_READ=off)" }
    : githubMergedPrHeads(repo, realSh),
);
const mergedPrRead: MergedPrReader = (repo) => mergedPrReadSeam.get()(repo);
/** Test seam: swap the merged-PR read; returns a restore fn. */
export function __setMergedPrRead(fn: MergedPrReader): () => void {
  return mergedPrReadSeam.set(fn);
}

/** Local branch → its tip sha. */
function branchTips(repo: string): Map<string, string> {
  const r = sh(["git", "-C", repo, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]);
  const tips = new Map<string, string>();
  for (const line of (r.out ?? "").split("\n")) {
    const [name, sha] = line.trim().split(/\s+/);
    if (name && sha) tips.set(name, sha);
  }
  return tips;
}

/**
 * The branches of `repo` that count as merged into `main` (OB-2141): `git branch --merged` says so, OR a
 * MERGED GitHub pull request has the branch as its head ref AND its head sha is the local branch tip.
 * Every land since decision #80 is a squash, and a squash commit never makes the branch an ancestor of
 * main, so git alone saw no landed branch as merged. The sha match keeps a branch that gained commits
 * after its PR merged as not merged. When GitHub cannot be read every branch keeps the git-only answer
 * and `github_error` says why. Cleanup and the reconcile signal (`gitMergedChecker`) share this set.
 */
function mergedBranches(repo: string, main: string): MergedRead {
  const r = sh(["git", "-C", repo, "branch", "--merged", main, "--format=%(refname:short)"]);
  const merged = new Set(
    (r.out ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const pr = mergedPrRead(repo);
  if ("error" in pr) return { merged, github_error: pr.error };
  for (const [branch, tip] of branchTips(repo)) {
    if (pr.heads.get(branch)?.has(tip)) merged.add(branch);
  }
  return { merged, github_error: null };
}

/** The one summary line a cleanup prints when the merged-PR read failed (OB-2141). */
function githubReadFailedLine(reason: string): string {
  return `github: could not read merged PRs (${reason}); squash-merged branches were not recognised`;
}

function allBranches(repo: string): string[] {
  const r = sh(["git", "-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return (r.out ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Uncommitted changes in a worktree. Unknown (git error) counts as dirty — never remove what we can't verify clean. */
function isDirty(path: string): boolean {
  const r = sh(["git", "-C", path, "status", "--porcelain"]);
  if (!r.ok) return true;
  return (r.out ?? "").trim().length > 0;
}

/**
 * Sweep merged+clean worktrees and dangling merged branches (git state = source of truth). Removes the
 * worktree then its branch; SKIPS (with a reason) anything dirty/unmerged unless `--force`. A worktree
 * a live process was launched from is SKIPPED even with `--force` (ob 138): `--force` overrides git
 * state, never a process still executing from inside the tree. An unreadable process table is the
 * same skip (unknown ≠ not running, #121). Cross-refs the agent registry: a swept branch's agent row
 * is marked done so `ob agents` stays truthful. Never touches the main checkout/branch. `dryRun`
 * previews only (removes nothing). The git seam is the injectable `sh` (mirrors the rest of this
 * module) so tests never mutate a real repo. The process table is the same `ps` read the in-use
 * check uses.
 *
 * IT IS A LOCAL COMMAND BY DEFINITION (191). The git half runs against the checkout in front of whoever
 * typed it and can never be dispatched: on the server it would remove worktrees and delete branches out
 * of the server's OWN clone of this repo, which is a different set of branches with the same names. So
 * `cleanup` joins the split class rather than growing a claim protocol like `drain` -- there is no
 * per-row claim to make, because the thing being contended for (a worktree on this disk) is not a row.
 * Its whole database half is `agentDone`, one `ob agent done <branch>` per branch it actually removed,
 * and that runs strictly AFTER the removal, so the residue it can leave is a registry row for a branch
 * that is gone, which `ob agents` shows and a repeat of the same command clears.
 */
export async function cleanupWorktrees(
  db: Database | Store | null,
  opts: {
    repo: string;
    dryRun?: boolean;
    force?: boolean;
    steps?: SpinoffSteps;
    /** 360: where the two database questions go. Required when there is no `db` (an API client). */
    data?: CleanupData;
  },
): Promise<CleanupSummary> {
  // (1760) "merged" is measured against origin/main (via mainRefFor): a checkout that lands from its own
  // worktree never moves local `main`, so measuring against it reads a landed branch as unmerged. `main`
  // stays the NAME that is never swept.
  const main = MAIN_BRANCH;
  const mergedInto = mainRefFor(opts.repo);
  const force = !!opts.force;
  const dryRun = !!opts.dryRun;
  if (!db && (!opts.steps || !opts.data)) {
    throw new AppError("cleanupWorktrees without a store needs both `steps` and `data` (360)");
  }
  const steps = opts.steps ?? localSpinoffSteps(db!);
  const data = opts.data ?? storeCleanupData(db!);
  const removed: CleanupEntry[] = [];
  const skipped: CleanupEntry[] = [];
  const dbFailures: DbHalfFailure[] = [];
  /** The swept branch's registry row + leases, wherever the database is. Reports rather than throws. */
  const clearAgent = async (branch: string): Promise<boolean> => {
    const done = await steps.agentDone(branch);
    if (done.error) {
      dbFailures.push({
        ticket: branch,
        detail: splitPartialFailure({
          didLocally: `branch ${branch} was REMOVED from ${opts.repo} here`,
          missing: "deregistering its agent",
          detail: done.error,
          recover: `ob agent done ${branch}`,
        }),
      });
    }
    return done.done;
  };

  const worktrees = parseWorktreeList(sh(["git", "-C", opts.repo, "worktree", "list", "--porcelain"]).out ?? "");
  const mergedRead = mergedBranches(opts.repo, mergedInto);
  const merged = mergedRead.merged;
  const wtBranches = new Set<string>();
  // One process-table read for every worktree (ob 138 / #121): the table is a single fact, and
  // unknown means SKIP rather than remove.
  const table = processRows();

  for (const wt of worktrees) {
    if (wt.branch) wtBranches.add(wt.branch);
    if (wt.isMain) continue; // primary checkout — never a candidate, don't even list it
    if (!wt.branch) {
      skipped.push({ kind: "worktree", branch: null, path: wt.path, action: "skipped", reason: "detached HEAD (no branch)" });
      continue;
    }
    // The lease guard comes FIRST and outranks --force (#97): --force exists to override *git* state
    // (dirty/unmerged), never to remove a worktree another LIVE session is building or gating. Breaking
    // a stale-but-live-looking lease is the explicit `ob lease release <resource> --force`.
    const hold = await data.hold(wt.branch, wt.path);
    if (hold) {
      skipped.push({
        kind: "worktree",
        branch: wt.branch,
        path: wt.path,
        action: "skipped",
        reason: `leased: ${formatHold(hold)} (${holderRemedy(`ob lease release ${hold.resource}`, hold.holder)})`,
      });
      continue;
    }
    // OB-2159: a live spinoff row outranks --force too. A builder between turns, with a lapsed lease and
    // no commits yet, passes every other guard (its branch at main's commit reads as merged).
    const live = await liveRowSkip(data, wt.branch, wt.path);
    if (live) {
      skipped.push({ kind: "worktree", branch: wt.branch, path: wt.path, action: "skipped", reason: live });
      continue;
    }
    // A live process launched from inside the tree outranks --force the same way a lease does
    // (ob 138): deleting the bundle out from under pid 5140 made its Info.plist unverifiable.
    const use = processUsingPath(table, wt.path);
    if (use.kind !== "clear") {
      skipped.push({
        kind: "worktree",
        branch: wt.branch,
        path: wt.path,
        action: "skipped",
        reason:
          use.kind === "running"
            ? `in use: pid ${use.pid} launched as ${use.comm}`
            : "could not tell if in use — skip rather than remove",
      });
      continue;
    }
    // 1120: a `t3` row's thread outranks --force exactly the way the lease and in-use probes do. A live
    // run means a builder is working in this checkout RIGHT NOW, and removing it is the one thing git
    // state cannot tell you about. Only worktrees a t3 row owns are probed, so a fleet with no t3 rows
    // pays one query and no network.
    const t3Hold = await data.t3Hold?.(wt.path);
    if (t3Hold) {
      skipped.push({ kind: "worktree", branch: wt.branch, path: wt.path, action: "skipped", reason: t3Hold });
      continue;
    }
    const dirty = isDirty(wt.path);
    const decision = decideCleanup(
      { branch: wt.branch, path: wt.path, merged: merged.has(wt.branch), dirty, isMain: false },
      { force },
    );
    if (decision.action === "skip") {
      skipped.push({ kind: "worktree", branch: wt.branch, path: wt.path, action: "skipped", reason: decision.reason });
      continue;
    }
    const entry: CleanupEntry = { kind: "worktree", branch: wt.branch, path: wt.path, action: "removed" };
    if (dryRun) {
      entry.agent_done = await data.agentExists(wt.branch); // preview whether a registry row would clear
    } else {
      const rm = sh(["git", "-C", opts.repo, "worktree", "remove", ...(force ? ["--force"] : []), wt.path]);
      if (!rm.ok) {
        skipped.push({
          kind: "worktree",
          branch: wt.branch,
          path: wt.path,
          action: "skipped",
          reason: `git worktree remove failed: ${rm.err || "error"}`,
        });
        continue;
      }
      // -D: `-d` measures against HEAD, which in a checkout that lands from its own worktree is the stale
      // local main (1760). This branch already passed the merged-into-origin/main check above (or --force).
      const del = sh(["git", "-C", opts.repo, "branch", "-D", wt.branch]);
      if (!del.ok) {
        // The tree is gone, so don't leave its leases as litter (#97). Since 191 that goes through the
        // same `agent done` step as the success path, which also clears the registry row: the two used to
        // differ (leases only), and expressing "release this holder's leases but keep its row" as a
        // sub-invocation would need a command that does not exist. Clearing it is honest anyway -- the
        // worktree that agent was building in has just been deleted, so it is not running.
        entry.reason = `worktree removed; branch delete failed: ${del.err || "error"}`;
        await clearAgent(wt.branch);
      } else {
        entry.agent_done = await clearAgent(wt.branch);
      }
    }
    removed.push(entry);
  }

  // Dangling merged branches: a local branch with no worktree, merged into main (never `main` itself).
  for (const branch of allBranches(opts.repo)) {
    if (branch === main || wtBranches.has(branch)) continue;
    // A dangling branch has no worktree path, so its guard rests on the `ticket:` keys the spinoff
    // queue / agent registry map to it. Same rule: a live foreign holder is never deleted out from under.
    const hold = await data.hold(branch, "");
    if (hold) {
      skipped.push({
        kind: "branch",
        branch,
        action: "skipped",
        reason: `leased: ${formatHold(hold)} (${holderRemedy(`ob lease release ${hold.resource}`, hold.holder)})`,
      });
      continue;
    }
    const live = await liveRowSkip(data, branch, ""); // OB-2159, as for worktrees
    if (live) {
      skipped.push({ kind: "branch", branch, action: "skipped", reason: live });
      continue;
    }
    const decision = decideCleanup({ branch, path: "", merged: merged.has(branch), dirty: false, isMain: false }, { force });
    if (decision.action === "skip") {
      skipped.push({ kind: "branch", branch, action: "skipped", reason: decision.reason });
      continue;
    }
    const entry: CleanupEntry = { kind: "branch", branch, action: "removed" };
    if (dryRun) {
      entry.agent_done = await data.agentExists(branch);
    } else {
      const del = sh(["git", "-C", opts.repo, "branch", "-D", branch]); // merged into origin/main, or --force (1760)
      if (!del.ok) {
        skipped.push({ kind: "branch", branch, action: "skipped", reason: `git branch delete failed: ${del.err || "error"}` });
        continue;
      }
      entry.agent_done = await clearAgent(branch); // branch gone, so clear its registry row and leases (#97)
    }
    removed.push(entry);
  }

  return {
    dry_run: dryRun,
    force,
    removed,
    skipped,
    db_failures: dbFailures,
    ...(mergedRead.github_error ? { github_error: mergedRead.github_error } : {}),
  };
}

// --- --repo slug resolution (#61) -------------------------------------------
// --repo used to be treated as a filesystem path, full stop - an org/name slug (e.g.
// acmecorp/cue-frontend) would only fail much later, at launch, with a confusing "cannot change to …:
// No such file or directory". resolveRepo validates + resolves --repo up front, in order: (1) an
// existing local directory that is itself a git repo, used as-is; (2) a configured `repo_checkouts`
// map (slug or its last path segment -> absolute path); (3) ~/dev/<name> (the last path segment) if
// that is a git repo. If nothing resolves, it throws a clear error naming everything it tried.

function isGitRepoDir(p: string): boolean {
  if (!p) return false;
  try {
    return existsSync(join(p, ".git"));
  } catch {
    return false;
  }
}

/** The last non-empty path segment of a repo path/slug, e.g. "acmecorp/cue-frontend" -> "cue-frontend". */
export function lastRepoSegment(input: string): string {
  const parts = input.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : input;
}

function repoCheckoutsMap(db: Database): Record<string, string> {
  return parseJsonMap(setting(db, "repo_checkouts"));
}

/**
 * Resolve --repo to a local checkout path. `home` is injectable (defaults to the real homedir) so
 * tests can exercise the ~/dev/<name> fallback without touching the real ~/dev.
 */
export function resolveRepo(db: Database, input: string, home: string = homedir()): string {
  return resolveRepoWith(repoCheckoutsMap(db), input, home);
}

/** The store-aware form of `resolveRepo()` (337): the same three steps, `repo_checkouts` via the store. */
export async function resolveRepoFor(
  db: Database | Store,
  input: string,
  home: string = homedir(),
): Promise<string> {
  return resolveRepoWith(parseJsonMap(await settingFor(db, "repo_checkouts")), input, home);
}

/** The resolution order itself, given the configured checkouts. Pure aside from the directory tests. */
export function resolveRepoWith(checkouts: Record<string, string>, input: string, home: string): string {
  if (isGitRepoDir(input)) return input;
  const name = lastRepoSegment(input);
  const mapped = checkouts[input] ?? checkouts[name];
  if (mapped && isGitRepoDir(mapped)) return mapped;
  const devPath = join(home, "dev", name);
  if (isGitRepoDir(devPath)) return devPath;
  throw new AppError(`repo '${input}' not found: not a local path, no repo_checkouts entry, and ${devPath} is not a git repo`);
}

/**
 * A row's repo as a path on THIS machine. A row queued since 217 carries a machine-independent SLUG, so
 * it is resolved here, where the checkouts are; a row that carries an absolute path (queued before 217,
 * or queued with no server configured) is used exactly as it always was, never re-resolved — a deleted
 * directory must fail as itself rather than fall through to a same-named checkout somewhere else.
 * Tolerant by design: an unresolvable slug is handed back untouched so the git call fails naming it,
 * rather than aborting a whole reconcile sweep over one row.
 */
export function rowRepoPath(db: Database, repo: string): string {
  if (isAbsolute(repo)) return repo;
  try {
    return resolveRepo(db, repo, homedir());
  } catch {
    return repo;
  }
}

/** The store-aware form of `rowRepoPath()` (337): same tolerance, `repo_checkouts` through the store. */
export async function rowRepoPathFor(db: Database | Store, repo: string): Promise<string> {
  if (isAbsolute(repo)) return repo;
  try {
    return await resolveRepoFor(db, repo, homedir());
  } catch {
    return repo;
  }
}

// --- the ticket's own project names the repo (OB-2130) -----------------------
//
// With no `--repo`, a dispatch used to build in the cwd, so `ob spinoff SS-5` run from the OmniSlash checkout
// made an OmniSlash row and an empty omnislash.ss-5 worktree. The ticket's project is the better answer: when it
// names a checkout on this machine that is not the cwd's repo, the build goes there. `--repo` still wins, and
// a project with no checkout here (or no project at all) leaves the cwd as it was.

/** Where a ticket's project sends its build, and the one line that says so. */
export interface TicketProjectRepo {
  /** The project's checkout on this machine. */
  repo: string;
  project: string;
  notice: string;
}

/**
 * The ticket's project as a checkout, given the configured checkouts (OB-2130). Null when the item has no
 * project, the project resolves to no checkout here, or that checkout is already the cwd's repo (the cwd or
 * a worktree of it), so a dispatch from inside its own repo is exactly what it was. The checkout is answered
 * canonical (absolute, symlinks resolved). Pure aside from the directory tests.
 */
export function ticketProjectRepoWith(
  checkouts: Record<string, string>,
  ticketRef: string,
  project: string | null | undefined,
  cwd: string,
  home: string = homedir(),
): TicketProjectRepo | null {
  const name = project?.trim();
  if (!name) return null;
  let checkout: string;
  try {
    checkout = resolveRepoWith(checkouts, name, home);
  } catch {
    return null; // no checkout for this project here: the cwd, as before
  }
  const want = canonicalDir(checkout);
  if (!want) return null;
  const here = canonicalDir(cwd);
  const hereMain = canonicalDir(worktreeRepoOf(cwd) ?? cwd);
  if (want === here || want === hereMain) return null;
  return { repo: want, project: name, notice: `${ticketRef} is a ${name} ticket: building in ${want}` };
}

/**
 * The store-aware form: the item's project read through the store. No item is null (the cwd, as before); a read
 * that FAILS is null too, but said on stderr, since a silent fall back to the cwd is the bug this replaces.
 */
export async function ticketProjectRepoFor(
  db: Database | Store,
  ticketRef: string,
  cwd: string = process.cwd(),
  home: string = homedir(),
): Promise<TicketProjectRepo | null> {
  try {
    const itemId = await ticketItemIdFor(db, ticketRef);
    const item = itemId ? await getItem(asStore(db), itemId) : null;
    if (!item) return null;
    return ticketProjectRepoWith(parseJsonMap(await settingFor(db, "repo_checkouts")), ticketRef, item.project_name ?? item.project_id, cwd, home);
  } catch (e) {
    warn(projectReadFailed(ticketRef, e));
    return null;
  }
}

/** The line a failed project read earns (OB-2130): the dispatch goes on in the cwd, and says why. Pure. */
export function projectReadFailed(ticketRef: string, e: unknown): string {
  return `  ⚠ could not read ${ticketRef}'s project (${e instanceof Error ? e.message : String(e)}): building in the cwd; pass --repo to choose`;
}

/** The ref a `spinoff` enqueue argv names (`spinoff <ref>` or `spinoff queue <ref>`), or null. Pure. */
export function spinoffEnqueueRef(command: string, args: string[]): string | null {
  if (!isSpinoffEnqueue(command, args)) return null;
  return (args[0] === "queue" ? args[1] : args[0]) ?? null;
}

// --- --repo is resolved on the CLIENT, before dispatch (217) -----------------
//
// `ob spinoff <ticket>` is a write, so once `remote_host` is set the whole invocation is dispatched to the
// server (189) and every argument is interpreted THERE. A `--repo` naming a filesystem path is then
// resolved against the server's filesystem, which holds /opt/omnislash and none of the owner's checkouts: it
// either fails or matches something different. Refusing paths outright was weighed and rejected, because
// pointing at a directory is the ergonomic actually used.
//
// So the path is turned into a SLUG here, on the machine that has the checkout, and only the slug crosses
// the wire. A slug is machine-independent: `resolveRepo` maps it back to a checkout on whichever machine
// asks, which is what the drain does when it later launches the row (`rowRepoPath`).
//
// It follows 235 rather than inventing a second notion of "which repo is this": the slug is the checkout's
// basename, and a `wt` worktree (`<repo>.<branch>`) counts as its repo. The honesty checks are the point:
//  - a path outside any checkout REFUSES rather than guessing a slug from a basename;
//  - a slug that does not resolve BACK to the same checkout here REFUSES and names the slugs that would be
//    accepted, because silently picking one would queue work against the wrong repo;
//  - relative paths and symlinks are canonicalised first, the same way lease keys canonicalise a worktree.

/** The outcome of resolving one `--repo` value for dispatch: a slug to send, or why it refused. */
export interface RepoSlugResolution {
  slug: string | null;
  error: string | null;
}

/** The realpath of a directory (symlinks + `.`/`..` resolved), or null when there is no such directory. */
function canonicalDir(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Does this `--repo` value name a filesystem PATH rather than an `org/name` slug? Anchored forms
 * (`/`, `~`, `.`, `..`) are paths by shape; anything else is a path only when it actually names a
 * checkout relative to `cwd`, so `acmecorp/cue-frontend` stays a slug. Pure apart from the directory test.
 */
export function looksLikeRepoPath(input: string, cwd: string): boolean {
  if (input.startsWith("/") || input.startsWith("~") || input === "." || input === "..") return true;
  if (input.startsWith("./") || input.startsWith("../")) return true;
  return isGitRepoDir(resolve(cwd, input));
}

/**
 * The machine-independent repo slug for a `--repo` value (217). A bare slug passes through unchanged; a
 * path is canonicalised, checked to be a checkout, reduced to its slug and round-tripped back through
 * `resolveRepo` so the value that crosses the wire provably names this same checkout here.
 */
export function repoDispatchSlug(
  db: Database,
  input: string,
  cwd: string = process.cwd(),
  home: string = homedir(),
): RepoSlugResolution {
  return repoDispatchSlugWith(repoCheckoutsMap(db), input, cwd, home);
}

/**
 * The resolution itself, given the configured checkouts. 360 pulled it out of `repoDispatchSlug` so an
 * API client can run the SAME rule against the `repo_checkouts` map the API handed it, rather than
 * growing a second notion of what slug a directory yields.
 */
export function repoDispatchSlugWith(
  checkouts: Record<string, string>,
  input: string,
  cwd: string = process.cwd(),
  home: string = homedir(),
): RepoSlugResolution {
  const raw = input.trim();
  if (!raw) return { slug: null, error: "--repo needs a value" };
  if (!looksLikeRepoPath(raw, cwd)) return { slug: raw, error: null };

  const abs = canonicalDir(resolve(cwd, expandHome(raw)));
  if (!abs) {
    return { slug: null, error: `--repo '${raw}' names no directory on this machine, so there is no repo to send` };
  }
  if (!isGitRepoDir(abs)) {
    return {
      slug: null,
      error:
        `--repo '${raw}' (${abs}) is not a git checkout, so it is outside every repo this machine knows. ` +
        `Only a repo SLUG crosses the wire, and there is none to derive here: pass --repo <slug> (or point at the checkout itself)`,
    };
  }

  // A worktree is not its own repo, so the slug is the repo's, not the worktree's. `worktreeRepoOf` reads
  // both shapes: a `wt` worktree is `<repo>.<branch>` beside its repo (235 reads it the same way), and a
  // T3 composer worktree is a linked git worktree under ~/.t3/worktrees/<repo>/t3-<id> (1414), whose common
  // dir names the repo. A repo whose own name contains a dot is still itself: no sibling checkout, no link.
  const mainOf = worktreeRepoOf(abs);
  const worktreeOf = mainOf ? canonicalDir(mainOf) : null;
  const fromName = basename(worktreeOf ?? abs);
  const target = worktreeOf ?? abs;

  // The slug has to resolve BACK to this same checkout, or it names a different repo on the machine that
  // reads the row. The basename is tried first (it is the slug a reader expects to see on the row); a
  // `repo_checkouts` key pointing at this checkout is tried next, since the configured map is as much a
  // source of truth as the naming convention. Both are checked, neither is assumed.
  const configured = Object.entries(checkouts)
    .filter(([, path]) => canonicalDir(path) === target)
    .map(([key]) => key)
    .sort();
  const namesTarget = (candidate: string): boolean => {
    try {
      return canonicalDir(resolveRepoWith(checkouts, candidate, home)) === target;
    } catch {
      return false;
    }
  };
  for (const candidate of [fromName, ...configured]) {
    if (namesTarget(candidate)) return { slug: candidate, error: null };
  }

  let elsewhere: string | null = null;
  try {
    elsewhere = canonicalDir(resolveRepoWith(checkouts, fromName, home));
  } catch {
    elsewhere = null;
  }
  return {
    slug: null,
    error: elsewhere
      ? `--repo '${raw}' is ambiguous: it is the checkout ${target}, but the only slug it yields ('${fromName}') names ` +
        `${elsewhere} here, and only a slug crosses the wire. Add a repo_checkouts entry mapping a slug to ${target}, ` +
        `then pass that slug`
      : `--repo '${raw}' is the checkout ${target}, but nothing here maps a slug back to it, and only a slug crosses ` +
        `the wire. Add a repo_checkouts entry for '${fromName}' → ${target}`,
  };
}

/**
 * Is this invocation a `spinoff` ENQUEUE (the only kind whose `--repo` is dispatched)? The bare
 * `spinoff <ref>` and its DB half `spinoff queue <ref>` (1589). Pure.
 */
export function isSpinoffEnqueue(command: string, args: string[]): boolean {
  if (command !== "spinoff" || args.length === 0) return false;
  return args[0] === "queue" ? args.length > 1 : !SPINOFF_SUBCOMMANDS.has(args[0]!);
}

export interface DispatchRewrite {
  argv: string[];
  error: string | null;
}

/** `ob spinoff check`'s JSON files live on THIS machine, so the argv carries their text to the server (OB-1825). */
function inlineCheckFiles(argv: string[]): DispatchRewrite {
  const out = [...argv];
  try {
    for (let i = 0; i < out.length; i++) {
      const eq = out[i]!.match(/^--(architect|checker|resolutions)=(.*)$/s);
      if (eq) out[i] = `--${eq[1]}=${JSON.stringify(readCheckInput(eq[1]!, eq[2]!))}`;
      else if ((out[i] === "--architect" || out[i] === "--checker" || out[i] === "--resolutions") && i + 1 < out.length) {
        out[i + 1] = JSON.stringify(readCheckInput(out[i]!.slice(2), out[i + 1]!));
      }
    }
  } catch (e) {
    return { argv, error: e instanceof Error ? e.message : String(e) };
  }
  return { argv: out, error: null };
}

/**
 * The argv actually sent to the server for a `spinoff` enqueue (217): `--repo` carries a machine-
 * independent slug, resolved here against this machine's checkouts.
 *
 * With no `--repo` at all the cwd default is resolved here too, for the same reason: the server's cwd is
 * never the repo the owner meant.
 * Every other invocation is returned untouched.
 */
export function rewriteSpinoffRepoArgv(input: {
  argv: string[];
  command: string;
  args: string[];
  flags: Record<string, unknown>;
  db: Database;
  cwd?: string;
  home?: string;
  /** OB-2130: the ticket's project checkout (`ticketProjectRepoFor`), used in place of the cwd when no --repo is given. */
  ticketRepo?: string | null;
}): DispatchRewrite {
  const { argv, command, args, flags, db } = input;
  const cwd = input.cwd ?? process.cwd();
  const home = input.home ?? homedir();
  if (command === "spinoff" && args[0] === "check") return inlineCheckFiles(argv);
  if (!isSpinoffEnqueue(command, args)) return { argv, error: null };

  const repoFlag = typeof flags.repo === "string" ? flags.repo : undefined;
  if (repoFlag === undefined) {
    // OB-2130: the ticket's project names the repo; otherwise the cwd does.
    if (input.ticketRepo) {
      const fromProject = repoDispatchSlug(db, input.ticketRepo, cwd, home);
      if (fromProject.error || !fromProject.slug) return { argv, error: fromProject.error };
      return { argv: [...argv, "--repo", fromProject.slug], error: null };
    }
    const fromCwd = repoDispatchSlug(db, cwd, cwd, home);
    if (fromCwd.error || !fromCwd.slug) return { argv, error: fromCwd.error };
    return { argv: [...argv, "--repo", fromCwd.slug], error: null };
  }

  const resolution = repoDispatchSlug(db, repoFlag, cwd, home);
  if (resolution.error || !resolution.slug) return { argv, error: resolution.error };
  const slug = resolution.slug;
  const out = [...argv];
  for (let i = 0; i < out.length; i++) {
    const token = out[i]!;
    if (token === "--repo" && i + 1 < out.length) out[i + 1] = slug;
    else if (token.startsWith("--repo=")) out[i] = `--repo=${slug}`;
  }
  return { argv: out, error: null };
}

/**
 * The `--repo` value RECORDED on the row. Locally it is resolved to this machine's checkout as it always
 * has been (#61). Over the wire it arrives already resolved to a slug (217), by the client that is the
 * only machine holding those checkouts, so the server records that slug verbatim: re-resolving it here
 * would go looking for the owner's checkouts on a box that has none of them.
 */
async function repoForRow(db: Database | Store, input: string): Promise<string> {
  return isHop() ? input : resolveRepoFor(db, input);
}

// --- the launch half, given the config rather than the store (360) ----------
//
// `ob spinoff` was classified LOCAL-ONLY at the API cutover (353) because it touches the database, and
// that classification was the bug: its two halves live in DIFFERENT places and neither of them is the API
// host. The queue (rows, the ticket, the leases) is data and belongs behind an endpoint; the worktree and
// the agent spawn belong to the machine in front of the human -- which is the laptop he carries to the
// office, not the box in the cupboard.
//
// So the launch half is expressed once here as a function of RESOLVED CONFIG. The store-backed forms above
// read those values through `settingFor`; an API client is handed the same values by `GET /spinoffs/config`
// and calls the same functions. There is one decision procedure, reached two ways, which is the only shape
// that cannot drift: `launcherNameFrom`, `resolveRepoWith` and `livenessFor` each stay a single
// implementation.

/** Everything the LAUNCH half needs from the database, resolved by whoever can reach it. */
export interface SpinoffLaunchConfig {
  /** `repo_checkouts`: slug -> checkout path, resolved on the machine that HAS the checkouts. */
  repoCheckouts: Record<string, string>;
  /** `spinoff_launcher`. */
  launcher: string;
  /** `spinoff_launcher_by_repo` (#83). */
  launcherByRepo: Record<string, string>;
  /** `spinoff_engine`, resolved once so the launch half composes the right harness. */
  engine: Engine;
  /** `spinoff_tier_models` (1480), raw: parsed at launch so a malformed value fails that row by name. */
  tierModels?: string;
}

/** Read the launch config off a store. The API host runs this; the client is handed the result. */
export async function readSpinoffLaunchConfig(db: Database | Store): Promise<SpinoffLaunchConfig> {
  const engine = await spinoffEngineFor(db);
  return {
    repoCheckouts: parseJsonMap(await settingFor(db, "repo_checkouts")),
    launcher: await settingFor(db, "spinoff_launcher"),
    launcherByRepo: parseJsonMap(await settingFor(db, "spinoff_launcher_by_repo")),
    engine,
    tierModels: await settingFor(db, "spinoff_tier_models"),
  };
}

/** `resolveRepo()` against a config rather than a store. */
export function resolveRepoIn(cfg: SpinoffLaunchConfig, input: string, home: string = homedir()): string {
  return resolveRepoWith(cfg.repoCheckouts, input, home);
}

/** `rowRepoPath()` against a config: the same tolerance for a slug that resolves to nothing here. */
export function rowRepoPathIn(cfg: SpinoffLaunchConfig, repo: string, home: string = homedir()): string {
  if (isAbsolute(repo)) return repo;
  try {
    return resolveRepoIn(cfg, repo, home);
  } catch {
    return repo;
  }
}

/** OB-2255: `--team` on `spinoff list|gateable` against the store; no team is every row. */
async function localTeamRows(db: Database | Store, team: string | undefined, rows: SpinoffRow[]): Promise<SpinoffRow[]> {
  if (team === undefined) return rows;
  const members = teamMembersIn(team, (await listTeams(db)).map((t) => t.name), await listProjects(db));
  return rowsInTeam(rows, members, parseJsonMap(await settingFor(db, "repo_checkouts")));
}

/**
 * OB-2255: the rows a team's member projects built, for `spinoff list|gateable --team`. A row is the team's
 * when its repo (a slug, or its last path segment) names a member project, or when its repo resolves, as
 * `resolveRepoWith` resolves it, to the same checkout as a member project. A member with no checkout here
 * still matches by slug. Pure aside from the directory tests.
 */
export function rowsInTeam<T extends { repo: string }>(
  rows: T[],
  members: ReadonlyArray<{ id: string; name: string }>,
  checkouts: Record<string, string>,
  home: string = homedir(),
): T[] {
  const slugs = new Set<string>();
  const dirs = new Set<string>();
  for (const m of members) {
    for (const n of [m.id, m.name]) {
      slugs.add(n);
      try {
        const dir = canonicalDir(resolveRepoWith(checkouts, n, home));
        if (dir) dirs.add(dir);
      } catch {
        // no checkout for this member here: its slug still matches
      }
    }
  }
  return rows.filter((row) => {
    if (slugs.has(row.repo) || slugs.has(lastRepoSegment(row.repo))) return true;
    let dir: string | null = null;
    try {
      dir = canonicalDir(isAbsolute(row.repo) ? row.repo : resolveRepoWith(checkouts, row.repo, home));
    } catch {
      dir = null;
    }
    return dir !== null && dirs.has(dir);
  });
}

/** `rowLauncherName()` against a config: the row's own launcher still wins over both settings (#135). */
export function rowLauncherNameIn(
  cfg: SpinoffLaunchConfig,
  row: { repo: string; launcher: string | null },
): LauncherName {
  if (row.launcher && isLauncherName(row.launcher)) return row.launcher;
  return launcherNameFrom(cfg.launcher, cfg.launcherByRepo, row.repo);
}

/**
 * `launchNotReady()` against a config: always null since ob 1109 -- `t3` is always ready (1120). Kept as the seam's config-taking form (see `launchNotReady`).
 *
 * A `t3` row is NOT deferred here, and that is the point: the machine running this API-CLIENT drain is
 * the machine that owns the worktree, the T3 server and the credential — the map's split ("the launch
 * runs HERE"). Deferring it would leave the row pending forever on the one machine that can launch it.
 */
export function launchNotReadyIn(
  _cfg: SpinoffLaunchConfig,
  _row: SpinoffRow,
  _tags: readonly string[],
  _opts: LaunchOpts = {},
): string | null {
  return null;
}

/** `prepareLaunch()` against a config: the worktree and the base sha come off THIS machine's git. */
export function prepareLaunchIn(cfg: SpinoffLaunchConfig, row: SpinoffRow): LaunchPrep {
  return prepareLaunchWith(rowRepoPathIn(cfg, row.repo), rowLauncherNameIn(cfg, row), cfg.engine, row);
}

/**
 * The launch itself, against a config. It runs HERE, on the machine in front of the human: `t3` (1120)
 * opens a thread in the T3 server that lives on this machine. The database half — the claim and the stamp, including the thread id — crosses the wire, so
 * this is async for the same reason every store-backed launcher is.
 *
 * `ticketTitle` is the ticket's own ob title (1143), which a CLIENT drain has no store of its own to
 * read: it arrives on the launchable row it is draining, so the thread is named the same either way.
 */
export async function launchRowIn(
  cfg: SpinoffLaunchConfig,
  _launcher: LauncherName,
  row: SpinoffRow,
  ticketTitle?: string | null,
  /** OB-2075: the item is urgent (the host sent the raised row), so an adopted thread keeps its model. */
  urgent?: { raisedFrom: string | null } | null,
): Promise<LaunchEffect> {
  const seam = await t3Seam();
  const outcome = await launchAcrossProfiles(row, settingTierModelsOrRefuse(cfg.tierModels), (models) => {
    refuseRaisedOpusHigh(row, models, urgent?.raisedFrom ?? null); // OB-2107
    return launchT3Spinoff(seam, row, rowRepoPathIn(cfg, row.repo), ticketTitle ?? null, models, !!urgent);
  });
  if (urgent) warnUrgentTier(row.ticket_ref, urgent.raisedFrom, outcome.adopted);
  warn(
    outcome.adopted
      ? `  ↳ ${row.ticket_ref} adopted T3 thread ${outcome.threadId} (a previous attempt opened it)`
      : `  ↳ ${row.ticket_ref} T3 thread: ${outcome.threadId}`,
  );
  return { t3ThreadId: outcome.threadId, t3RunId: outcome.runId, model: outcome.model, effort: outcome.effort, adopted: outcome.adopted, raised: !!urgent && !outcome.adopted };
}

/** `repoDispatchSlug()` against a config: which slug this directory sends over the wire (217). */
export function repoDispatchSlugIn(
  cfg: SpinoffLaunchConfig,
  input: string,
  cwd: string,
  home: string = homedir(),
): RepoSlugResolution {
  return repoDispatchSlugWith(cfg.repoCheckouts, input, cwd, home);
}

// --- the renderers, shared by the local command and the API client (360) ----
// Both paths print the SAME text. Extracted rather than re-written on the client, because two renderers
// for one command is how `ob spinoff list` at the office quietly stops matching `ob spinoff list` at home.

/**
 * Does a row's `ticket_ref` name what the human typed? Exact, the `#<n>` issue spelling, or (1949) the same
 * per-project ref in any case (`ps-12` is the row `PS-12`). Pure.
 */
export function ticketRefIs(rowRef: string, typed: string): boolean {
  if (rowRef === typed || rowRef === `#${typed}`) return true;
  const ref = normalizeRef(typed);
  return ref !== null && normalizeRef(rowRef) === ref;
}

/**
 * Pick the row `ob spinoff show` should print. Pure over the row list (newest-first, as `listSpinoffs`
 * returns). A numeric ref is the row id when that id exists; otherwise ticket_ref, then branch. Ticket
 * and branch take the newest match. Refuses rather than enqueueing.
 */
export function pickSpinoffForShow(all: SpinoffRow[], ref: string, itemId?: string | null): SpinoffRow {
  const key = ref.trim();
  if (!key) throw new UsageError("spinoff show requires a <ticket|id>");
  if (/^\d+$/.test(key)) {
    const byId = all.find((r) => r.id === Number(key));
    if (byId) return byId;
  }
  // 1949: then the row serving the item the ref names, which reaches a row parked under its bare id.
  const byTicket = all.find((r) => ticketRefIs(r.ticket_ref, key)) ?? (itemId ? all.find((r) => r.item_id === itemId) : undefined);
  if (byTicket) return byTicket;
  const byBranch = all.find((r) => r.branch === key);
  if (byBranch) return byBranch;
  throw new AppError(`no spinoff matching '${key}'`);
}

/**
 * OB-1991: `spinoff state <ticket>` from a trial leg's checkout. The ticket has two live rows, so the builder's own
 * (its worktree or branch is here) takes the verdict; anything else picks as `show` does.
 */
export function pickSpinoffForState(all: SpinoffRow[], ref: string, itemId?: string | null, here: { cwd?: string; branch?: string | null } = {}): SpinoffRow {
  const key = ref.trim();
  if (!/^\d+$/.test(key)) {
    const live = all.filter((r) => ticketRefIs(r.ticket_ref, key) && (r.status === "launched" || r.status === READY_FOR_GATE));
    const own = live.length > 1 ? ownLegFirst(live, here) : undefined;
    if (own) return own;
  }
  return pickSpinoffForShow(all, ref, itemId);
}

/** The last `State:` paragraph on a row's branch for `spinoff show`; null when the checkout is gone. */
export function showStateFor(row: SpinoffRow): string | null {
  if (row.verdict) return rowVerdictState(row);
  return existsSync(row.worktree) ? rowVerdictState(row) : null;
}

/**
 * One row's full detail — the inspect half of `ob spinoff show`. `state` is the branch's last `State:`
 * paragraph the caller read (1579): printed as the verdict word plus its one-line reason, never the paragraph.
 */
export function renderSpinoffShow(row: SpinoffRow, json: boolean, state?: string | null, files?: FilesComparison): string {
  if (json) return JSON.stringify(files ? { ...withStatusWord(row), files } : withStatusWord(row), null, 2);
  const lines = [
    `${row.id}  ${spinoffStatusWord(row.status)}  ${row.ticket_ref}`,
    `  repo:      ${row.repo}`,
    `  branch:    ${row.branch}`,
    `  worktree:  ${row.worktree}`,
    `  mode:      ${row.mode}`,
    `  launcher:  ${row.launcher ?? "-"}`,
    `  engine:    ${row.engine ?? "claude"}`,
    // 1480: the tier it was RATED (null = queued before tiers: launches as the default) and the model the
    // launch actually ran on, stamped — never re-derived from today's tier map.
    `  tier:      ${row.tier ?? `${DEFAULT_SPINOFF_TIER} (unrated)`}`,
    `  model:     ${row.model ?? "-"}`,
    // OB-1815: the stamped effort text; a row with none (not launched, or queued before 0039) says `default`.
    `  effort:    ${row.effort ?? "default"}`,
    `  agent:     ${row.agent_id ?? "-"}`,
    `  requested: ${row.request_at}`,
    `  launched:  ${row.launched_at ?? "-"}`,
    `  tokens:    ${formatTokens(row.total_tokens)}`,
    `  error:     ${row.error ?? "-"}`,
    `  session:   ${row.session_id ?? "-"}`,
  ];
  if (state) lines.push(...stateDisplayLines(state));
  const noteError = noteErrorLine(row.note_error); // OB-2172
  if (noteError) lines.push(noteError);
  if (files) lines.push(`  ${filesLine(files)}`); // OB-2131
  // 1163: the ob ITEM this row serves, when it is not simply the ref it was dispatched with. A hand-charted
  // ticket is dispatched by its wayfinder number while its ob mirror carries another id, so without this
  // line the row's own output names a ticket that `ob show` answers for with a different ticket.
  if (row.item_id && row.item_id !== row.ticket_ref) lines.splice(1, 0, `  item:      ${row.item_id}`);
  if (row.t3_thread_id) {
    lines.push(`  t3 thread: ${row.t3_thread_id}`);
    lines.push(`  t3 run:    ${row.t3_run_id ?? "-"}`);
  }
  lines.push("  brief:");
  for (const line of row.brief.split("\n")) lines.push(`    ${line}`);
  return lines.join("\n");
}

/** The listing `ob spinoff list` prints. A legacy `headless` row reads as what it recorded (1589). */
export function renderSpinoffList(
  rows: SpinoffRow[],
  json: boolean,
  landed?: Set<number>, // ROW ids, from `landedTicketRefs` (1201)
): string {
  if (json) {
    return JSON.stringify(
      rows.map((r) => ({ ...withStatusWord(r), landed: landed?.has(r.id) ?? false })),
      null,
      2,
    );
  }
  if (rows.length === 0) return "no spinoffs";
  return rows
    .map((r) => {
      // engine next to the launcher: WHERE the tab lives vs WHICH harness ran in it. A pre-0023 row reads
      // as claude (NULL), which is truthful — nothing before it could have launched opencode.
      return `${r.id}\t${spinoffStatusWord(r.status)}\t${r.ticket_ref}\t${r.branch}\t${r.launcher ?? "-"}\t${r.engine ?? "claude"}\t${r.tier ?? "-"}\t${r.model ?? "-"}\t${formatTokens(r.total_tokens)} tok${r.error ? `\t(${r.error})` : ""}`;
    })
    .join("\n");
}

/** The human report a drain pass prints: the reconcile half, then the launch half. */
export function renderDrainLines(r: DrainResult, rec: ReconcileResult): string[] {
  const lines: string[] = [];
  if (rec.merged.length) lines.push(`reconciled ${rec.merged.length} landed: ${rec.merged.join(", ")}`);
  // 1120: what the T3 mirror wrote onto agent rows (stderr-free, so a `--json` drain stays parseable).
  for (const m of rec.mirrored ?? []) lines.push(`  ⟳ ${m.ticket}: T3 run ${m.status} (thread ${m.threadId})`);
  for (const b of rec.blocked) lines.push(`  ⏸ ${b.ticket}: not landed, ${b.resource} held by ${b.holder}`);
  for (const e of r.reclaimed) {
    lines.push(`  ↺ ${e.ticket}: reclaimed from an unfinished drain → ${spinoffStatusWord(e.status)} (attempt ${e.attempts})`);
  }
  lines.push(
    `launched ${r.launched.length}${r.failed.length ? `, failed ${r.failed.length}` : ""} — ${r.remaining_pending} still queued (${r.active} build agents active)`,
  );
  if (r.scope === "all") {
    for (const [repo, n] of Object.entries(r.by_repo).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${repo}: launched ${n.launched}${n.failed ? `, failed ${n.failed}` : ""}`);
    }
  } else {
    lines.push(`  scope: ${r.scope} only (--all drains every repo)`);
  }
  for (const k of r.skipped_other_repo) lines.push(`  ⏸ ${k.ticket}: skipped, queued for repo ${k.repo}, not ${r.scope}`);
  for (const f of r.failed) lines.push(`  ✗ ${f.ticket}: ${f.error}`);
  for (const b of r.blocked) lines.push(`  ⏸ ${b.ticket}: left queued, ${b.resource} held by ${b.holder}`);
  for (const n of r.not_ready) lines.push(`  ⏸ ${n.ticket}: left queued, ${n.reason}`);
  return lines;
}

/** The human report a cleanup sweep prints. */
export function renderCleanupLines(res: CleanupSummary): string[] {
  const lines: string[] = [];
  if (res.dry_run) lines.push("DRY RUN — nothing removed");
  if (res.force) lines.push("FORCE — removing dirty/unmerged worktrees + branches too");
  if (res.github_error) lines.push(githubReadFailedLine(res.github_error));
  if (res.removed.length === 0 && res.skipped.length === 0) {
    lines.push("no merged worktrees or branches to clean up");
    return lines;
  }
  if (res.removed.length) {
    lines.push(`REMOVED (${res.removed.length}):`);
    for (const e of res.removed) {
      const label = e.kind === "worktree" ? `worktree ${e.path} + branch ${e.branch}` : `branch ${e.branch}`;
      const agent = e.agent_done ? " [agent done]" : "";
      const note = e.reason ? ` — ${e.reason}` : "";
      lines.push(`  ${res.dry_run ? "would remove" : "✓"} ${label}${agent}${note}`);
    }
  }
  if (res.skipped.length) {
    lines.push(`SKIPPED (${res.skipped.length}):`);
    for (const e of res.skipped) {
      const label = e.kind === "worktree" ? `${e.path} (branch ${e.branch ?? "detached"})` : `branch ${e.branch}`;
      lines.push(`  - ${label} — ${e.reason}`);
    }
  }
  return lines;
}

// --- command ---------------------------------------------------------------

function flag(ctx: Ctx, key: string): string | undefined {
  const v = (ctx.flags as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}
async function readStdin(): Promise<string> {
  return (await new Response(Bun.stdin.stream()).text()).trim();
}

/** A numeric flag the step commands (191) require: a missing or unparseable one is a usage error. */
function numberFlag(ctx: Ctx, key: string, fallback?: number): number {
  const raw = flag(ctx, key);
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new UsageError(`--${key} is required`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${key} must be a number, got '${raw}'`);
  return n;
}

/**
 * Where this sweep's database half goes (191). `ctx.remote` is present ONLY in split mode: absent means
 * there is no server and the writes are the direct ones they have always been, which is both the
 * pre-cutover behaviour and what the server itself does when it runs the same code.
 */
function spinoffSteps(ctx: Ctx, under = ""): SpinoffSteps {
  const decision = decisionOptsOf(ctx);
  return ctx.remote ? remoteSpinoffSteps(ctx.remote, under, decision) : localSpinoffSteps(ctx.store ?? ctx.db, under, decision);
}

/**
 * A local half that happened whose database half did not. Printed on stderr (so a `--json` consumer's
 * stdout stays parseable) and non-zero, per 189's partial-failure contract: what exists, what does not,
 * and the command that finishes the job.
 */
function reportDbFailures(ctx: Ctx, failures: DbHalfFailure[]): void {
  if (failures.length === 0) return;
  for (const f of failures) warn(`NOT RECORDED: ${f.detail}`);
  ctx.exit = 1;
}

// --- operating procedure (#3, was 157) -------------------------------------
// The brief names the spinoff skill and makes reporting through `ob agent` non-optional.
// Every repo uses ob-spinoff.

export type ProcedurePrefix = "ob";

/**
 * Which spinoff skill a repo gets, by prefix. Pure. Always "ob".
 */
export function selectProcedure(_repo: string | undefined): ProcedurePrefix {
  return "ob";
}

/**
 * The one sentence that points a fresh session at its repo's spinoff skill, with nothing else attached
 * (1162). The composed launch message ends with it; the retired operating procedure (#3) opened with it.
 * Pure. Every repo's prefix is `ob` (617).
 */
function spinoffSkillDirective(repo?: string): string {
  return `Run the \`${selectProcedure(repo)}-spinoff\` skill now and follow it end to end (it is in your skills; invoke it).`;
}

/**
 * The operating procedure appended to every spun-off agent's brief (#3): a short, REQUIRED directive
 * pointing the agent at the `ob-spinoff` skill, instead of inlining the workflow here. `branch` is the
 * agent id the drain registers. Retired from the stored brief by 563 (unused by the enqueue paths); kept
 * because the report-each-gate text is still the record of what the wrapper said.
 */
export function operatingProcedure(ticketRef: string, branch: string, repo?: string): string {
  return [
    ``,
    `--- Operating procedure (REQUIRED) ---`,
    `${spinoffSkillDirective(repo)} It sequences the gates + composes the general skills (post-pr, pr-screenshots, etc.). REPORT each gate via \`ob agent register --id ${branch} --status <s> --note <...>\` before moving on: a gate you did not report reads as skipped. Heartbeat while working: \`ob agent heartbeat ${branch}\`.`,
    ``,
  ].join("\n");
}

/**
 * The full brief for an agent spinoff: the ticket-specific ask + the operating procedure directive
 * that points the agent at the `ob-spinoff` skill.
 */
export function composeBrief(ticketRef: string, branch: string, repo?: string, custom?: string): string {
  const head = custom ?? `Implement ${ticketRef} in this worktree (branch ${branch}) per its acceptance criteria.`;
  return `${head}\n${operatingProcedure(ticketRef, branch, repo)}`;
}

/**
 * A spinoff ref that resolves to a GitHub issue (221 phase 3): the `#<n>` form fetches issue N on
 * `wayfinder_repo` for its title + body, deriving a descriptive branch and a brief head. Returns null
 * for any other ref (the existing ob/wayfinder ref path — used verbatim, unchanged). Fetch is behind
 * the injectable github-issues seam so tests never hit the network.
 */
export interface ResolvedIssueRef {
  ticketRef: string; // `#<n>`
  branch: string; // derived `<n>-<slug>` unless --branch overrides
  head: string; // brief head composed from the issue title + body
  issue: FetchedIssue;
}
export async function resolveIssueRef(db: Database, ref: string): Promise<ResolvedIssueRef | null> {
  return resolveIssueRefOn(db, db, ref);
}

/**
 * The store-aware form of `resolveIssueRef()` (337). `wayfinder_repo` comes from the store, but the
 * FETCH still needs the raw handle: `fetchIssue` reads the GitHub credential through the unported
 * credentials path. Under postgres that handle is the stand-in that throws, so `ob spinoff #<n>` refuses
 * by name -- the same documented edge `ob add --issue` already has, and the same way back (unset
 * OMNISLASH_STORE). Every other spinoff ref never reaches it.
 */
export async function resolveIssueRefFor(
  store: Database | Store,
  raw: Database,
  ref: string,
): Promise<ResolvedIssueRef | null> {
  return resolveIssueRefOn(store, raw, ref);
}

async function resolveIssueRefOn(
  store: Database | Store,
  raw: Database,
  ref: string,
): Promise<ResolvedIssueRef | null> {
  const num = parseIssueRef(ref);
  if (num === null) return null;
  const issue = await fetchIssue(raw, await settingFor(store, "wayfinder_repo"), num);
  const head = `Implement GitHub issue #${issue.number}: ${issue.title}${issue.body ? `\n\n${issue.body}` : ""}`;
  return { ticketRef: `#${issue.number}`, branch: deriveBranch(issue.number, issue.title), head, issue };
}

const QUESTIONS_RESOLVED_REPLACED = "--questions-resolved is replaced by --resolutions (one entry per checker question); see 'ob --help'";

/** `ob spinoff check`'s arguments, on whichever machine holds the JSON files (OB-1825, OB-2131). */
export function spinoffCheckArgs(ctx: {
  args: string[];
  flags: { architect?: string; checker?: string; resolutions?: string; "questions-resolved"?: boolean };
}): { ref: string; architect: unknown; checker: unknown; resolutions: unknown } {
  // OB-2131: a bare yes lost which question was answered and how, so it is refused, not aliased.
  if (ctx.flags["questions-resolved"] !== undefined) throw new UsageError(QUESTIONS_RESOLVED_REPLACED);
  const ref = ctx.args[1];
  const { architect, checker, resolutions } = ctx.flags;
  if (!ref || architect === undefined || checker === undefined) {
    throw new UsageError("spinoff check requires <ticket> --architect <json|file> --checker <json|file> [--resolutions <json|file>]");
  }
  return {
    ref,
    architect: readCheckInput("architect", architect),
    checker: readCheckInput("checker", checker),
    resolutions: resolutions === undefined ? undefined : readCheckInput("resolutions", resolutions),
  };
}

/** Print a check; anything short of `go` exits 1, so a script cannot read a refusal as a pass (OB-1825). */
export function reportSpinoffCheck(ctx: { mode: string; exit?: number }, res: CheckResult): void {
  if (ctx.mode === "json") print(JSON.stringify(res, null, 2));
  else if (ctx.mode === "quiet") print(res.verdict);
  else for (const line of renderCheckResult(res)) print(line);
  if (res.verdict !== "go") ctx.exit = 1;
}

/**
 * A ref that IS a spinoff subcommand word is refused, not launched (1697). `ob spinoff abandon 782` once
 * took `abandon` for a ticket and launched a real builder on it; `ob spinoff queue list` still would.
 */
export function refuseSubcommandRef(ref: string): void {
  if (SPINOFF_SUBCOMMANDS.has(ref)) {
    throw new UsageError(`'${ref}' is a spinoff subcommand, not a ticket ref: nothing was queued or launched (see 'ob spinoff --help' for its arguments)`);
  }
}

export const SPINOFF_STATE_USAGE = "spinoff state requires <ticket|id> <landable|needs-human|blocked|partial> [--reason '<one line>'] [--gate '<gate line>']";

export async function cmdSpinoff(ctx: Ctx): Promise<void> {
  rejectAgentFlag(ctx.flags.agent);
  const sub = ctx.args[0];
  // 337: every read and write below goes through the store, which is what puts `spinoff` on the
  // POSTGRES_SERVABLE_COMMANDS list. `ctx.db` is used for exactly two things, both unported and both
  // loud rather than silent under postgres: the GitHub fetch behind a `#<n>` ref, and `watch`'s
  // file-watcher, which is refused by name below.
  const store = ctx.store ?? ctx.db;

  if (sub === "drain") {
    // --holder names a hold that is ALREADY the caller's (#136), the same flag `agent register` takes
    // (#75): the documented gate flow holds `ticket:<n>` and then dispatches a builder for that ticket, so
    // without it the normal case reads as contention and the row it holds is the one it cannot drain.
    const under = flag(ctx, "holder") ?? "";
    // OB-1796: decided FIRST, so a drain run from nowhere resolvable refuses before it changes anything.
    const scope = resolveDrainScope(await readSpinoffLaunchConfig(store), {
      all: ctx.flags.all === true,
      repo: flag(ctx, "repo"),
      cwd: process.cwd(),
    });
    const steps = spinoffSteps(ctx, under);
    // Reconcile judges merges, not launches, so it stays global; only the LAUNCH is scoped.
    const rec = await reconcileSpinoffs(store, undefined, undefined, undefined, under, steps); // retire merged spinoffs first
    const r = await drainSpinoffs(store, under, {}, steps, scope);
    const dbFailures = [...rec.db_failures, ...r.db_failures];
    if (ctx.mode === "json") {
      print(JSON.stringify({ ...r, merged: rec.merged, reconcile_blocked: rec.blocked, db_failures: dbFailures }, null, 2));
    } else {
      for (const line of renderDrainLines(r, rec)) print(line);
    }
    reportDbFailures(ctx, dbFailures);
    if (r.remote_error) {
      warn(`the drain stopped: ${r.remote_error}`);
      ctx.exit = 1;
    }
    return;
  }

  if (sub === "reconcile") {
    const under = flag(ctx, "holder") ?? "";
    const rec = await reconcileSpinoffs(store, undefined, undefined, undefined, under, spinoffSteps(ctx, under));
    if (ctx.mode === "json") print(JSON.stringify(rec));
    else {
      print(rec.merged.length ? `marked landed: ${rec.merged.join(", ")}` : "no building spinoffs landed yet");
      // 1120: the T3 mirror is a write, so it is reported here the same way the drain reports it.
      for (const m of rec.mirrored ?? []) print(`  ⟳ ${m.ticket}: T3 run ${m.status} (thread ${m.threadId})`);
      for (const b of rec.blocked) print(`  ⏸ ${b.ticket}: not landed, ${b.resource} held by ${b.holder}`);
    }
    reportDbFailures(ctx, rec.db_failures);
    return;
  }

  // --- the database half of the sweeps above, as commands (191) --------------
  // These are the steps `spinoff drain|reconcile|cleanup` dispatch when a server is configured, and they
  // are ordinary writes: REMOTE from the laptop, local on the server, never split themselves. They are
  // also the recovery commands the partial-failure messages name, which is why they take flags rather
  // than a blob: a human has to be able to retype one off the error.

  if (sub === "claim") {
    const id = numberFlag(ctx, "id");
    const outcome = await claimSpinoffRow(store, id, flag(ctx, "holder") ?? "");
    if (ctx.mode === "json") print(JSON.stringify({ claimed: outcome.claimed, error: outcome.error }, null, 2));
    else if (!outcome.claimed) print(outcome.error ? `#${id} left queued: ${outcome.error}` : `#${id} was not queued: nothing claimed`);
    else if (outcome.error) print(`#${id} claimed, but not launchable: ${outcome.error}`);
    else print(`claimed #${id} (${outcome.claimed.ticket_ref}) for ${CLAIM_TTL_S}s`);
    return;
  }

  if (sub === "stamp") {
    const id = numberFlag(ctx, "id");
    const outcome = flag(ctx, "outcome");
    if (outcome !== "launched" && outcome !== "failed") {
      throw new UsageError("spinoff stamp requires --outcome launched|failed");
    }
    await stampSpinoff(store, {
      id,
      outcome,
      worktree: flag(ctx, "worktree") ?? null,
      base_sha: flag(ctx, "base-sha") ?? null,
      launcher: flag(ctx, "launcher") ?? null,
      session_id: flag(ctx, "session") ?? null,
      engine: flag(ctx, "engine") ?? null,
      t3_thread_id: flag(ctx, "t3-thread") ?? null,
      t3_run_id: flag(ctx, "t3-run") ?? null,
      model: flag(ctx, "model") ?? null,
      effort: flag(ctx, "effort") ?? null, // the stamped text (`high`, `default (high)`), not a flag a human types
      raised: ctx.flags.raised === true,
      error: flag(ctx, "error") ?? null,
      decision: decisionOptsOf(ctx),
    });
    if (ctx.mode === "json") print(JSON.stringify({ id, outcome }, null, 2));
    else print(`stamped #${id} ${outcome}`);
    return;
  }

  if (sub === "land") {
    const id = numberFlag(ctx, "id");
    await landSpinoff(
      store,
      id,
      {
        inputTokens: numberFlag(ctx, "input-tokens", 0),
        outputTokens: numberFlag(ctx, "output-tokens", 0),
        cacheCreationTokens: numberFlag(ctx, "cache-creation-tokens", 0),
        cacheReadTokens: numberFlag(ctx, "cache-read-tokens", 0),
        totalTokens: numberFlag(ctx, "total-tokens", 0),
      },
      decisionOptsOf(ctx),
    );
    if (ctx.mode === "json") print(JSON.stringify({ id, status: spinoffStatusWord("merged") }, null, 2));
    else print(`landed #${id}`);
    return;
  }

  if (sub === "reclaim") {
    const entries = await reclaimSpinoffs(store);
    if (ctx.mode === "json") print(JSON.stringify({ reclaimed: entries }, null, 2));
    else if (entries.length === 0) print("no abandoned claims");
    else for (const e of entries) print(`↺ ${e.ticket} (#${e.id}) → ${spinoffStatusWord(e.status)} (attempt ${e.attempts})`);
    return;
  }

  if (sub === "handoff" || sub === "ready") {
    // 1513: `handoff` is the word; `ready` stays as the alias in-flight builders and old scripts type.
    // Human (or the live interactive session) declares this spinoff ready for the architect to gate
    // (391/426). Writes the row; does not merge; releases the builder's ticket:/worktree: holds;
    // does not release an architect-* hold and does not call agent done.
    //
    // 1133: it ALSO tells the pinned architect thread, so a finished builder reaches the architect without a
    // human reading a sidebar. The note is composed from facts ob holds here and is a NOTIFICATION: the
    // stamp below is the record, and a send that fails is a warning plus exit 1, never a rollback.
    const found = await findSpinoffForReady(store, {
      ref: ctx.args[1],
      cwd: process.cwd(),
      // 1188: a ref that names a LANDED row is refused by name, with the sha — read from the repo, so it
      // still answers when that row's worktree is gone.
      landedShaFor: (row) => landCommitFor(worktreeRepoOf(row.worktree) ?? row.worktree, row.ticket_ref),
    });
    // 1188: no stamp and no note without the checkout the decision is about. A row ALREADY ready-for-gate
    // is the exception, because a repeat exists for its 426 cleanup (the stuck-lease class) and only the
    // ANNOUNCE is unsafe with the checkout gone — so the dirty rule still refuses for it, a missing
    // worktree does not, and the note becomes the named skip below.
    const repeat = found.status === READY_FOR_GATE;
    const gone = !existsSync(found.worktree);
    if (gone && !repeat) throw new AppError(missingWorktreeRefusal(found.worktree));
    // OB-1826: a spike's worktree is dirty by design (it tries things), so the dirty rule does not apply; the
    // rule that does is that it commits documentation only (OB-2227).
    const spike = isSpikeTagged(await spinoffTicketTagsFor(store, found.ticket_ref, found.item_id));
    assertHandoffWorktree(found, spike);
    // OB-1992: a clean repo's branch, commits and PR carry nothing of ob; a hit is refused before the stamp.
    let report = handoffNoteWithReport(flag(ctx, "note"), flag(ctx, "report"));
    // 1552: the builder rates its own tier. A bad value (or a why with no rating) is a usage error BEFORE
    // anything is stamped, and before the slower CI read; omitting it is allowed and only costs a hint.
    const tierFit = tierFitOf(flag(ctx, "tier-fit"), flag(ctx, "tier-fit-why"));
    // OB-2044: a builder hands off only once its PR's CI passes; refused before the stamp.
    let ci: HandoffCiResult = { kind: "no-pr", line: null };
    // OB-2227: a spike may now push a doc commit and open a PR, so its branch, commits and PR are checked too.
    if (!gone) {
      const leaks = cleanRepoLeakLines(found, await projectRefKeys(store));
      if (leaks.length > 0) throw new AppError(cleanRepoLeakRefusal(found.ticket_ref, leaks));
    }
    if (!spike && !gone) {
      // A repeat that is `--no-note` announces nothing and stamps no new handoff, so there is no readying to gate.
      if (!(repeat && ctx.flags["no-note"] === true)) {
        ci = assertHandoffCiForRow(found, flag(ctx, "ci-unchecked"));
        report = noteWithCi(report, ci);
      }
    }
    // Read the builder's own readying note BEFORE the stamp: the stamp rewrites that row's note to
    // "handed-off: the sentinel, else the architect, gates it", and the gate the builder reported would be lost.
    const builderNote = gateNoteWithCi((await getAgent(store, builderIdOf(found)))?.note ?? null, ci);
    const result = await markSpinoffReady(store, found, { ...decisionOptsOf(ctx), note: report }, tierFit);
    // OB-2227: a spike may carry a documentation commit and its PR; the note and the report name the PR.
    const spikeDoc = result.spike ? spikeDocFactsFor(result.row) : null;
    const state = rowVerdictState(result.row);
    // 1205: `--no-note` is the caller saying "stamp only", the architect stamping on the human's behalf is
    // not the event the note exists to announce, and a note it sends goes to its own thread.
    const note = ctx.flags["no-note"] === true
      ? noNoteOutcome(result.row.ticket_ref)
      : gone
        ? worktreeGoneNoteOutcome(result.row.ticket_ref, result.row.worktree)
        : await announceReadyForRow(store, result.row, state, builderNote, result.tierFit, result.already, result.spike === true, spikeDoc);
    const rendered = renderReadyNoteOutcome(note);
    if (ctx.mode === "json") {
      print(JSON.stringify({ ...readyResultJson(result, state), spike: result.spike === true, ...(spikeDoc ? { pr_url: spikeDoc.prUrl } : {}), architect_note: note }, null, 2));
    } else {
      print(result.spike ? formatSpikeReport(result.row, spikeDoc ?? {}) : formatReadyReport(result.row, state, result.already));
      if (!tierFit) print(TIER_FIT_HINT);
      if (rendered.warning) warn(rendered.line);
      else print(rendered.line);
    }
    if (rendered.warning) ctx.exit = 1;
    return;
  }

  if (sub === "reopen") {
    // OB-2180: a row reconcile landed by mistake goes back to building; refused when its work is on main.
    const ref = ctx.args[1];
    if (!ref) throw new UsageError("spinoff reopen requires a <row|ticket>");
    const row = pickSpinoffForShow(await listSpinoffs(store), ref, await ticketItemIdFor(store, ref));
    const repo = await rowRepoPathFor(store, row.repo);
    const deps: ReopenDeps = {
      flip: (note) => markSpinoffReopened(store, row, { ...decisionOptsOf(ctx), note }),
      ticketDone: async (r) => (await getItem(store, r.item_id ?? r.ticket_ref))?.status === "done",
      relandReason: (r) => rowRelandReason(repo, r),
    };
    print(renderReopen(await reopenSpinoff(row, deps, flag(ctx, "note") ?? ""), ctx.mode === "json"));
    return;
  }

  if (sub === "sendback") {
    // OB-1805: the architect sends a handed-off PR back to its builder: row -> building, note -> the builder's
    // thread, off `gateable` until the builder hands off again.
    const ref = ctx.args[1];
    if (!ref) throw new UsageError("spinoff sendback requires a <ticket|id>");
    const row = pickSpinoffForShow(await listSpinoffs(store), ref, await ticketItemIdFor(store, ref));
    const note = flag(ctx, "note") ?? "";
    const decision = { ...decisionOptsOf(ctx), note };
    const deps: SendBackDeps = {
      flip: async () => {
        await markSpinoffSentBack(store, row, decision);
      },
      restore: async () => {
        // OB-1920: re-read the stored row after the flip rather than fabricating `status: "launched"`.
        await restoreSentBackRow(store, row.id, { ...decisionOptsOf(ctx), note: "send-back undone: the builder thread could not be told" });
      },
      send: async (threadId, message, clientRequestId) => {
        await (await t3Seam()).send({ threadId, message, mode: "queue", clientRequestId });
      },
      headSha: (r) => headShaFor(r.worktree, r.branch),
    };
    const res = await sendBackSpinoff(row, deps, note);
    print(renderSendBack(res, ctx.mode === "json"));
    return;
  }

  if (sub === "watch") {
    // 337: `watch` is the one spinoff subcommand that is SQLITE-ONLY BY CONSTRUCTION -- its trigger is
    // fs.watch on the database FILE, and a Postgres store has no file to watch. Under postgres it would
    // block forever and report nothing, which is the silent failure this whole port is ordered against,
    // so it refuses by name instead. Everything else `spinoff` does is served from either engine.
    if (ctx.store?.kind === "postgres") throw new AppError(WATCH_UNDER_POSTGRES_MSG);
    // Block, watching the DB dir; reconcile (git-state) on each change and print each newly-done
    // spinoff. --once exits 0 after the first transition so an architect can run it as a one-shot bg task.
    await watchSpinoffs(ctx.db, ctx.dbPath, { once: ctx.flags.once === true, json: ctx.mode === "json" });
    return;
  }

  if (sub === "cleanup") {
    const repo = flag(ctx, "repo") ?? process.cwd();
    const dryRun = ctx.flags["dry-run"] === true;
    const force = ctx.flags.force === true;
    const res = await cleanupWorktrees(store, { repo, dryRun, force, steps: spinoffSteps(ctx) });
    if (ctx.mode === "json") {
      print(JSON.stringify(res, null, 2));
      reportDbFailures(ctx, res.db_failures);
      return;
    }
    for (const line of renderCleanupLines(res)) print(line);
    reportDbFailures(ctx, res.db_failures);
    return;
  }

  if (sub === "brief") {
    // Print the same launch message enqueue would store — dry-run/inspection, no launch (154/G3, 563).
    // Since 1162 that message is COMPOSED FROM THE TICKET (title + what to build + acceptance + do not),
    // read off the checkout this repo names, so the dry run shows what the thread will open on.
    const rawRef = ctx.args[1];
    if (!rawRef) throw new UsageError("spinoff brief requires a <ticket-ref>");
    await refuseAmbiguousDispatchRef(store, rawRef); // OB-1751
    const resolved = await resolveIssueRefFor(store, ctx.db, rawRef); // `#<n>` → fetch the GitHub issue
    const typedRef = resolved?.ticketRef ?? rawRef;
    const ticketRef = await dispatchRefFor(store, typedRef); // 1949: the item's `<KEY>-<seq>`
    const repoFlag = flag(ctx, "repo");
    // The repo's checkout is where the ticket file is read from.
    // OB-2130: resolved as the dispatch resolves it, so the brief checked is the brief the builder gets.
    const fromProject = repoFlag ? null : await ticketProjectRepoFor(store, ticketRef);
    const repo = repoFlag ? await repoForRow(store, repoFlag) : (fromProject?.repo ?? process.cwd());
    if (fromProject) warn(fromProject.notice);
    const branch = flag(ctx, "branch") ?? (isObRepo(repo) ? resolved?.branch : undefined) ?? (await defaultBranchFor(store, repo, ticketRef)); // OB-1992: a clean repo never takes the issue-number branch
    let custom = flag(ctx, "brief");
    if (custom === "-") custom = await readStdin();
    const brief = await spinoffAskFor(store, repo, typedRef, { brief: custom, issueHead: resolved?.head, project: repoFlag ?? undefined });
    if (ctx.mode === "json") print(JSON.stringify({ ticket: ticketRef, branch, brief }, null, 2));
    else print(brief);
    return;
  }

  if (sub === "check") {
    // OB-1825: record the measure-twice verdict the dispatch gate reads. ob never runs the checker.
    const { ref, architect, checker, resolutions } = spinoffCheckArgs(ctx);
    const res = await recordSpinoffCheck(store, ref, { architect, checker, resolutions }, { actor: flag(ctx, "holder") });
    reportSpinoffCheck(ctx, res);
    return;
  }

  if (sub === "state") {
    // OB-1992: a clean repo's verdict, recorded on the row because its commits carry nothing of ob.
    const ref = ctx.args[1];
    const word = ctx.args[2];
    if (!ref || !word) throw new UsageError(SPINOFF_STATE_USAGE);
    const row = pickSpinoffForState(await listSpinoffs(store), ref, await ticketItemIdFor(store, ref));
    const recorded = await recordSpinoffVerdict(store, row, { verdict: word, reason: flag(ctx, "reason"), gate: flag(ctx, "gate") });
    if (ctx.mode === "json") print(JSON.stringify({ id: recorded.id, ticket: recorded.ticket_ref, verdict: recorded.verdict, reason: recorded.verdict_reason, gate: recorded.gate_line }, null, 2));
    else if (ctx.mode === "quiet") print(recorded.verdict ?? "");
    else for (const line of renderRecordedVerdict(recorded)) print(line);
    return;
  }

  if (sub === "show") {
    const ref = ctx.args[1];
    if (!ref) throw new UsageError("spinoff show requires a <ticket|id>");
    const row = pickSpinoffForShow(await listSpinoffs(store), ref, await ticketItemIdFor(store, ref));
    if (ctx.mode === "quiet") print(String(row.id));
    else {
      const files = showFilesFor(row, await plannedFilesFor(store, row.ticket_ref, row.item_id ?? null)); // OB-2131
      print(renderSpinoffShow(row, ctx.mode === "json", ctx.mode === "json" ? undefined : showStateFor(row), files));
    }
    return;
  }

  if (sub === "list") {
    const rows = await localTeamRows(store, flag(ctx, "team"), await listSpinoffs(store, spinoffStatusFilter(flag(ctx, "status"))));
    const landed = ctx.mode === "json" ? await landedTicketRefs(store, rows) : undefined;
    print(renderSpinoffList(rows, ctx.mode === "json", landed));
    return;
  }

  if (sub === "gateable") {
    const rows = await localTeamRows(store, flag(ctx, "team"), await listSpinoffs(store, READY_FOR_GATE));
    // OB-2131: the files: line. Read before the render, which is synchronous.
    const planned = new Map<number, string[] | null>();
    for (const row of rows) planned.set(row.id, await plannedFilesFor(store, row.ticket_ref, row.item_id ?? null));
    print(reportGateable(rows, gateableFactsFor, ctx.mode, await openPairs(store), (row) => planned.get(row.id) ?? null)); // OB-1991: a pair is one entry
    return;
  }

  if (sub === "abandon") {
    // 1697: retire a launched-but-unbuilt spinoff WITHOUT `ob close` (which would stamp it landed).
    const ref = ctx.args[1];
    if (!ref) throw new UsageError("spinoff abandon requires a <row-id|ticket>");
    const row = pickSpinoffForShow(await listSpinoffs(store), ref, await ticketItemIdFor(store, ref));
    const stamp = localSpinoffSteps(store, "", decisionOptsOf(ctx)).stamp;
    const deps: AbandonDeps = {
      commitsAhead: (r) => commitsAheadFor(r.worktree, r.branch, r.base_sha),
      stopThread: (threadId) => stopThreadOverT3(threadId),
      stamp,
      finishAgent: async (agentId) => {
        const fin = await finishAgent(store, agentId); // 341: the agent's OWN leases; an architect's hold stays
        return { done: fin.done, released: fin.released, error: null };
      },
    };
    const res = await abandonSpinoff(row, deps, { note: flag(ctx, "note"), force: ctx.flags.force === true });
    print(renderAbandon(res, ctx.mode === "json"));
    if (res.warnings.length > 0) ctx.exit = 1;
    return;
  }

  if (sub === "trial") {
    // OB-1991: the model trial. The store work runs here; the measures are read here too (this is the machine).
    const t3 = await t3Seam().catch(() => null);
    await runTrialCli(ctx as unknown as Parameters<typeof runTrialCli>[0], {
      op: (req) => runTrialOp(store, req, trialStoreDeps(store)),
      print,
      measures: liveMeasureDeps(t3 ? (id) => t3.read(id, { limit: 500 }) : null),
      diffOf: gitLegDiff,
      ...liveFileIO,
    });
    return;
  }

  if (sub === "tokens") {
    // OB-1993: recover the token count of landed rows that recorded none, read on this machine.
    if (ctx.args[1] !== "backfill") throw new UsageError("spinoff tokens requires 'backfill' (ob spinoff tokens backfill [--since <date>] [--dry-run])");
    const entries = await backfillSpinoffTokens(
      await listSpinoffs(store, "merged"),
      { read: readRowTokens, record: (id, usage) => recordSpinoffTokens(store, id, usage) },
      { since: parseSince(flag(ctx, "since")), dryRun: ctx.flags["dry-run"] === true },
    );
    print(renderBackfill(entries, ctx.mode === "json"));
    if (entries.some((e) => e.outcome === "failed")) ctx.exit = 1;
    return;
  }

  if (sub === "mix") {
    const since = parseSince(flag(ctx, "since"));
    const rows = await listSpinoffs(store);
    const tags = new Map<string, string[]>();
    for (const id of new Set(rows.map((r) => r.item_id).filter((x): x is string => !!x))) {
      tags.set(id, await getTags(store, id));
    }
    print(reportMix(rows, tags, since, ctx.mode));
    return;
  }

  // enqueue: ob spinoff <ticket-ref | #issue> [--repo <path-or-slug>] [--branch <b>] [--worktree <path>] [--brief -]
  // `queue` is the same enqueue WITHOUT the launch (1589): the DB half a split client sends its server, and
  // the way to park a row for a later `spinoff drain`.
  if (!sub || (sub === "queue" && !ctx.args[1])) {
    throw new UsageError(
      "spinoff requires a <ticket-ref> (or 'queue'/'drain'/'list'/'show'/'mix'/'gateable'/'abandon'/'sendback'/'reopen'/'reconcile'/'watch'/'handoff'/'brief'/'check'/'cleanup'/'reclaim'/'claim'/'stamp'/'land'; 'ready' is an alias of 'handoff')",
    );
  }
  const queueOnly = sub === "queue";
  const rawRef = queueOnly ? ctx.args[1]! : sub;
  refuseSubcommandRef(rawRef);
  await refuseAmbiguousDispatchRef(store, rawRef); // OB-1751: before the split client sends it, and before anything is queued
  const launcherFlag = flag(ctx, "launcher");
  if (launcherFlag !== undefined && !isLauncherName(launcherFlag)) {
    throw new UsageError(launcherRejection("spinoff --launcher", launcherFlag));
  }
  const tier = tierFlag(flag(ctx, "tier")); // 1480: refused before anything is read or written
  const effort = effortFlag(flag(ctx, "effort")); // OB-1815: the same, at the flag
  let custom = flag(ctx, "brief");
  if (custom === "-") custom = await readStdin();
  const under = flag(ctx, "holder") ?? "";
  const noCheck = flag(ctx, "no-check");
  const noFlakeSlot = flag(ctx, "no-flake-slot"); // OB-2230

  if (!queueOnly && ctx.remote) {
    await enqueueAndLaunchSplit(ctx, ctx.remote, rawRef, { launcher: launcherFlag, tier, effort, brief: custom, under });
    return;
  }

  const resolved = await resolveIssueRefFor(store, ctx.db, rawRef); // `#<n>` → fetch the GitHub issue on wayfinder_repo
  const typedRef = resolved?.ticketRef ?? rawRef;
  // 1949: the row, branch, worktree and `ticket:` lease are named by the item's `<KEY>-<seq>`. The brief
  // still reads the TYPED ref, so a hand-charted `wayfinder/tickets/<n>-….md` keeps being the work order.
  const ticketRef = await dispatchRefFor(store, typedRef);
  const repoFlag = flag(ctx, "repo");
  // OB-2130: with no --repo, the ticket's own project names the repo before the cwd does.
  const fromProject = repoFlag ? null : await ticketProjectRepoFor(store, ticketRef);
  const repo = repoFlag ? await repoForRow(store, repoFlag) : (fromProject?.repo ?? process.cwd());
  if (fromProject) warn(fromProject.notice);
  // A checkout T3 has no project for would fail at launch, after the row and the worktree exist: refuse now.
  // `queue` skips it: that is the server's DB half, and T3 is on the caller's machine, which ran the check.
  if (!queueOnly) await refuseUnregisteredT3Project(await t3Seam(), await rowRepoPathFor(store, repo));
  const branch = flag(ctx, "branch") ?? (isObRepo(repo) ? resolved?.branch : undefined) ?? (await defaultBranchFor(store, repo, ticketRef)); // OB-1992: a clean repo never takes the issue-number branch
  const worktree = flag(ctx, "worktree"); // explicit checkout override (#61), takes precedence over the derived path
  // 1589: a foreign ticket:/worktree: hold refuses BEFORE the row exists, so a refusal leaves nothing pending
  // for a later drain to launch behind the holder's back. `--holder` names a hold that is the caller's own.
  // `queue` refuses too: it is the split client's DB half, and only here, on the server, are the leases real.
  await refuseForeignHold(store, ticketRef, branch, worktree ?? worktreePath(repo, worktreeKeyOf({ repo, branch, ticket_ref: ticketRef })), under);
  // OB-2230: one flake fix on the whole machine. A held `flake:slot` refuses here, before the row exists.
  const flake = await refuseHeldFlakeSlot(store, ticketRef, [leaseHolderId(), branch, refKey(ticketRef), under], noFlakeSlot);
  if (flake && !queueOnly && !flakeBoxPresent()) warn(noFlakeBoxWarning(ticketRef));
  // OB-1815: a level the tier's model cannot take is refused here, before the row exists, for the same reason.
  // `queue` skips it: that is the server's DB half and T3 is on the caller's machine, which ran the check.
  // OB-2075: the check reads the tier the build will run on, and an urgent ticket runs on complex whatever was named.
  if (effort !== undefined) {
    const effortTier = (await itemIsUrgent(store, await ticketItemIdFor(store, ticketRef))) ? "complex" : (tier ?? DEFAULT_SPINOFF_TIER);
    // OB-2107: the Opus-high check needs no T3, so `queue` runs it too (the split client forwards --opus-high).
    if (queueOnly) refuseOpusHigh(tierModelsOrRefuse(await settingFor(store, "spinoff_tier_models")), effortTier, effort, flag(ctx, "opus-high"));
    else await refuseUnusableEffortFor(store, repo, effortTier, effort, flag(ctx, "opus-high"));
  }
  // The thread's FIRST item is the work order itself (1162): the ticket's title + what to build +
  // acceptance + do not, read off `repo`'s checkout, then the directive to run the spinoff skill. Still
  // the ASK, not a procedure (563); the human steers the session and declares it done. A `#<n>` ref keeps
  // the issue's own head (221), and a caller's `--brief` still wins outright.
  const brief = await spinoffAskFor(store, repo, typedRef, { brief: custom, issueHead: resolved?.head, project: repoFlag ?? undefined, flakeBox: queueOnly ? null : undefined });

  // OB-1825: last, so a dispatch another check refuses leaves no stray `--no-check` on the trail.
  const uncheckedWarning = await refuseUncheckedDispatch(store, ticketRef, { noCheck, actor: flag(ctx, "holder") });
  if (uncheckedWarning) warn(`  ⚠ ${uncheckedWarning}`);

  // OB-1991: while a model trial is active, a dispatch at its tier runs twice, same brief, one row per leg.
  // `queue` is the split client's DB half and stays single; so does `--no-trial`.
  // OB-2230: a flake ticket runs no trial either: two legs would be two flake fixes on one machine.
  if (!queueOnly && ctx.flags["no-trial"] !== true && !flake) {
    const paired = await dispatchTrialPair({
      plan: async () => refuseOpusHighTrial(await trialPlanFor(store, tier ?? DEFAULT_SPINOFF_TIER), tier ?? DEFAULT_SPINOFF_TIER, flag(ctx, "opus-high")),
      open: (plan) => openPair(store, { trial_id: plan.trial.id, ticket_ref: ticketRef, repo }),
      leg: async (leg, spec) => {
        const legBranchName = legBranch(branch, leg);
        const legWorktree = worktree === undefined ? undefined : legBranch(worktree, leg);
        if (leg === "b") {
          const derived = legWorktree ?? worktreePath(repo, worktreeKeyOf({ repo, branch: legBranchName, ticket_ref: ticketRef, trial_leg: "b" }));
          await refuseForeignHold(store, legRef(ticketRef, "b"), legBranchName, derived, under);
        }
        const queued = await enqueueSpinoff(store, {
          ticketRef,
          repo,
          branch: legBranchName,
          worktree: legWorktree,
          mode: "interactive",
          brief,
          launcher: launcherFlag,
          tier,
          effort: (spec.effort ?? undefined) as SpinoffEffort | undefined,
          trialLeg: leg,
          trialModel: spec.model,
          decision: dispatchDecisionOf(ctx), // OB-2107: carries the --opus-high quote
        });
        if (queued.deduped) {
          // The ticket already had a queued row: that row is launched as the single build it was queued as.
          await launchAndReport(ctx, store, queued.row, true, tier !== undefined, under, spinoffSteps(ctx, under));
          return { row: null, launched: false, error: `${ticketRef} already had queued row #${queued.row.id}, launched as a single build`, settled: true };
        }
        return { row: queued.row, launched: await launchAndReport(ctx, store, queued.row, false, tier !== undefined, under, spinoffSteps(ctx, under)) };
      },
      void: async (id, reason) => {
        await voidPair(store, id, reason);
      },
      attach: async (id, rows) => {
        await attachLegs(store, id, rows);
      },
      say: (line) => {
        if (ctx.mode !== "json" && ctx.mode !== "quiet") print(line);
      },
      warn,
    });
    if (paired.kind !== "single") return;
  }

  const { row, deduped, collision, urgent, raisedFrom } = await enqueueSpinoff(store, {
    ticketRef,
    repo,
    branch,
    worktree,
    mode: "interactive",
    brief,
    launcher: launcherFlag,
    tier,
    effort,
    decision: dispatchDecisionOf(ctx), // OB-2107: carries the --opus-high quote
  });
  // 1226: a ref two sequences both claim — the mirror whose ticket path names it, and the item whose id it
  // is — was bound to the PATH. Say so, here, where the human who typed it can act: decided by the enqueue,
  // which is the one place this resolution already happened, and silent in every other case.
  const collides = collidingRefWarning(row.ticket_ref, row.item_id, collision);
  if (collides) warn(collides);
  // OB-2230: the override is bound to THIS row on the trail, so the claim (here, a drain, or the server) reads it.
  if (flake && noFlakeSlot) await recordNoFlakeSlot(store, row, noFlakeSlot, under || null);
  if (queueOnly) {
    if (ctx.mode === "json")
      print(JSON.stringify({ id: row.id, ticket: row.ticket_ref, status: spinoffStatusWord(row.status), deduped, launcher: row.launcher, tier: row.tier, effort: row.effort, urgent, raised_from: raisedFrom, row }));
    else if (ctx.mode === "quiet") print(String(row.id));
    else print(renderQueuedLine(row, deduped, tier !== undefined, urgent ? { from: raisedFrom } : null));
    return;
  }
  await launchAndReport(ctx, store, row, deduped, tier !== undefined, under, spinoffSteps(ctx, under), urgent ? { from: raisedFrom } : null);
}

/**
 * The pre-enqueue check of `--effort` (OB-1815), run where T3 is (this machine). The repo path and the tier →
 * model map are the ones a launch from here would read, so the check and the launch agree.
 */
async function refuseUnusableEffortFor(db: Database | Store, repo: string, tier: SpinoffTier, effort: SpinoffEffort, opusHighAsk?: string): Promise<void> {
  await refuseUnusableEffort(await t3Seam(), await rowRepoPathFor(db, repo), tier, tierModelsOrRefuse(await settingFor(db, "spinoff_tier_models")), effort, opusHighAsk);
}

/** A pending row's recorded effort, or undefined when it names none (or one no longer known). */
function rowEffortOf(raw: string | null | undefined): SpinoffEffort | undefined {
  return raw && isSpinoffEffort(raw) ? raw : undefined;
}

/** The dispatch's decision: `--note`/`--holder`, with the `--opus-high` quote in front of the note (OB-2107). */
function dispatchDecisionOf(ctx: Ctx): DecisionOpts {
  const decision = decisionOptsOf(ctx);
  return { ...decision, note: withOpusHighNote(decision.note, flag(ctx, "opus-high")) };
}

/**
 * The refusal a foreign ticket:/worktree: hold earns at dispatch (1589). Thrown before the row is queued,
 * so it leaves no pending row behind; the holder is named, with the `--holder` remedy when it is the
 * caller's own hold.
 */
async function refuseForeignHold(db: Database | Store, ticketRef: string, branch: string, worktree: string, under: string): Promise<void> {
  // The same "who counts as us" a drain's per-row check uses: this process, the builder's own branch, --holder.
  const hold = await foreignHold(db, spinoffLeaseKeys({ ticket_ref: ticketRef, worktree }), [leaseHolderId(), branch, refKey(ticketRef), under]);
  if (!hold) return;
  throw new AppError(
    `not dispatched: ${formatHold(hold)}. Nothing was queued. If that holder is you, dispatch under it with ` +
      `--holder ${hold.holder}; otherwise wait for it, and 'ob lease release ${hold.resource} --force' ONLY if that holder is gone`,
  );
}

/**
 * `ob spinoff <ref>` on a split client (1589): the row is queued ON THE SERVER (`spinoff queue`), then the
 * same claim → launch → stamp a drain runs takes it, the launch here and the claim and stamp there, all in
 * this one invocation. A claim whose stamp never lands lapses through the claim lease like any drain's.
 */
async function enqueueAndLaunchSplit(
  ctx: Ctx,
  remote: RemoteWriter,
  rawRef: string,
  opts: { launcher?: string; tier?: SpinoffTier; effort?: SpinoffEffort; brief?: string; under: string },
): Promise<void> {
  const argv = ["spinoff", "queue", rawRef];
  const repoFlag = flag(ctx, "repo");
  // OB-2130: the ticket's project names the repo before the cwd does; checked against T3 here, where T3 is.
  const fromProject = repoFlag ? null : await ticketProjectRepoFor(ctx.db, rawRef);
  if (fromProject) warn(fromProject.notice);
  const repo = repoFlag ? await repoForRow(ctx.db, repoFlag) : (fromProject?.repo ?? process.cwd());
  // A checkout T3 has no project for would fail at launch, after the server made the row: refuse here, where T3 is.
  await refuseUnregisteredT3Project(await t3Seam(), repo);
  // OB-2230: the builder launches HERE, so the box is checked here; the server's `queue` takes and refuses the slot.
  if (!flakeBoxPresent() && (await ticketIsFlake(ctx.db, rawRef))) warn(noFlakeBoxWarning(rawRef));
  // OB-1815: T3 is on THIS machine, so the check of --effort runs here, before anything crosses the wire.
  if (opts.effort !== undefined) {
    const urgent = await itemIsUrgent(ctx.db, await ticketItemIdFor(ctx.db, rawRef)); // OB-2075
    await refuseUnusableEffortFor(ctx.db, repo, urgent ? "complex" : (opts.tier ?? DEFAULT_SPINOFF_TIER), opts.effort, flag(ctx, "opus-high"));
  }
  if (repoFlag !== undefined) argv.push("--repo", repoFlag);
  // OB-2107: --opus-high crosses too: the server's `queue` re-checks it and puts the quote on the trail note.
  for (const name of ["branch", "worktree", "holder", "note", "no-check", "no-flake-slot", "opus-high"] as const) {
    const value = flag(ctx, name);
    if (value !== undefined) argv.push(`--${name}`, value);
  }
  if (opts.launcher !== undefined) argv.push("--launcher", opts.launcher);
  if (opts.tier !== undefined) argv.push("--tier", opts.tier);
  if (opts.effort !== undefined) argv.push("--effort", opts.effort);
  if (opts.brief !== undefined) argv.push("--brief", opts.brief);
  // --repo crosses the wire as a SLUG (217), resolved here against this machine's checkouts.
  const rewrite = rewriteSpinoffRepoArgv({ argv, command: "spinoff", args: ["queue", rawRef], flags: ctx.flags as unknown as Record<string, unknown>, db: ctx.db, ticketRepo: fromProject?.repo });
  if (rewrite.error) throw new AppError(rewrite.error);
  // The foreign-hold refusal runs inside the server's `spinoff queue` (it carries --holder): the leases live
  // there, and this machine's replica may not have a hold yet.
  const queueArgv = [...rewrite.argv, "--json"];
  const outcome = remote.write(queueArgv);
  if (!outcome.ok) throw new AppError(outcome.message ?? `'ob ${queueArgv.join(" ")}' failed on the server`);
  const parsed = parseStepAnswer<{ row: SpinoffRow; deduped: boolean; urgent?: boolean; raised_from?: SpinoffTier | null }>(queueArgv, outcome.stdout);
  if (!parsed.value?.row) throw new AppError(parsed.error ?? `'ob ${queueArgv.join(" ")}' answered no row`);
  const urgentNote = parsed.value.urgent ? { from: parsed.value.raised_from ?? null } : null; // OB-2075: the server decided it
  await launchAndReport(ctx, ctx.db, parsed.value.row, parsed.value.deduped === true, opts.tier !== undefined, opts.under, spinoffSteps(ctx, opts.under), urgentNote);
}

/**
 * Launch the row `ob spinoff <ref>` just queued (or deduped onto) and say what happened (1589): the T3 thread
 * id on success, a named reason otherwise. A row that is already launching is reported, never launched twice.
 * Anything short of a launch exits non-zero.
 */
async function launchAndReport(
  ctx: Ctx,
  db: Database | Store,
  queued: SpinoffRow,
  deduped: boolean,
  tierNamed: boolean,
  under: string,
  steps: SpinoffSteps,
  urgent: UrgentTierNote | null = null,
): Promise<boolean> {
  const r: RowLaunch = queued.status === "pending" ? await launchQueuedRow(db, queued, under, steps) : { kind: "raced" };
  if (r.dbFailure) reportDbFailures(ctx, [r.dbFailure]);
  const row = r.kind === "launched" || r.kind === "failed" ? r.row : queued;
  const threadId = r.kind === "launched" ? (r.effect.t3ThreadId ?? null) : null;
  const status = r.kind === "launched" ? "launched" : r.kind === "failed" ? "failed" : r.kind === "raced" ? spinoffStatusWord(queued.status) : "pending";
  const reason =
    r.kind === "failed" ? r.error
    : r.kind === "blocked" ? `${r.blocked.resource} held by ${r.blocked.holder}`
    : r.kind === "not-ready" ? r.reason
    : r.kind === "remote-error" ? r.error
    : null;
  if (ctx.mode === "json") {
    print(JSON.stringify({ id: row.id, ticket: row.ticket_ref, status, deduped, launcher: row.launcher, tier: row.tier, effort: r.kind === "launched" ? (r.effect.effort ?? row.effort ?? null) : (row.effort ?? null), t3_thread_id: threadId, model: r.kind === "launched" ? (r.effect.model ?? null) : null, error: reason }));
  } else if (ctx.mode === "quiet") {
    print(threadId ?? String(row.id));
  } else if (r.kind === "launched") {
    print(renderLaunchedLine(row, threadId, r.effect.model ?? null, deduped, tierNamed, r.effect.effort ?? row.effort, launchedUrgentNote(urgent, r.effect.adopted)));
  } else if (r.kind === "raced") {
    print(`already ${spinoffStatusWord(queued.status)}: ${row.ticket_ref} (#${row.id}); nothing new was launched`);
  } else {
    warn(`${row.ticket_ref} (#${row.id}) was not launched: ${reason}`);
  }
  if (r.kind !== "launched" && r.kind !== "raced") ctx.exit = 1;
  return r.kind === "launched";
}

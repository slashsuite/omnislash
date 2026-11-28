/**
 * ob → T3 DISPATCH: the spinoff queue's `t3` launcher, the architect thread, the run-state mirror, the
 * settle-on-close handoff and the cleanup guard (ticket 1120).
 *
 * The TRANSPORT lives in `client.ts` (1102) and is the only module that knows the endpoint, the
 * credential or the protocol. This module is the layer above it: it knows which T3 project a spinoff's
 * repo belongs to, which model a launch runs on, which thread a row already owns, and what T3's run
 * state means for an ob agent row. Everything here goes through `T3Seam`, so tests drive the whole
 * dispatch surface without a server and without a credential.
 *
 * ── The three rules this file exists to keep ────────────────────────────────────────────────────────
 *
 *   1. ONE THREAD PER WORKTREE, EVER. ob owns worktrees (`<repo>.<branch>`, one per spinoff row, held
 *      by lease), so a thread bound to a row's worktree IS that row's thread. Every launch scans for one
 *      first and ADOPTS it instead of opening a second. That is what makes a drain that died between the
 *      launch and the stamp safe to re-run — not a receipt: measured on the pinned build, T3's
 *      `t3_thread_launch` takes no retry key at all ("Each call creates a new launch with no retry key").
 *      The stable `clientRequestId` is still sent, so the day T3 honours one it is already the right key.
 *   2. MIRROR, NEVER INVENT. T3's thread statuses are written onto the agent row's `run` field verbatim
 *      (`T3_THREAD_STATUSES`, 1189); ob's own `status` keeps the workflow words and is never touched by
 *      the mirror, and ob's own spinoff QUEUE states (stored `pending · launching · launched · ready-for-gate ·
 *      merged · failed`) are untouched too, because T3 has no concept of "queued for a ticket". An
 *      unrecognised status is REPORTED and skipped, never guessed at.
 *   3. NEVER A SILENT WRONG LAUNCH. A repo with no T3 project, a project with no default model, a
 *      provider T3 reports as unusable: each is a named refusal with a one-line remedy. Nothing here
 *      falls back to another provider, another model or another launcher.
 */

import { leaseLabel } from "./lease-icon.ts";
import { defineSeam } from "../test-seams.ts";
import { builderIdOf, isObRepo } from "../../../../platform/cli-coord/src/clean-repo.ts";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { asStore, type Store } from "../db/store.ts";
import { warn } from "../output.ts";
import { UsageError } from "../errors.ts";
import { DEFAULT_COMPLEXITY, DEFAULT_TIER_MODELS, TIER_COMPLEXITY, complexityOf, parseComplexity, emptyHalfOf, isSpinoffTier, modelForComplexity, bandFor, rangeRoute, SPINOFF_TIERS, splitTierModel, withModelAt, type BuilderModels, type SpinoffTier } from "../models-file.ts";
import { getItem, getTags } from "../items.ts";
import { getAgent, listAgents, registerAgent, setAgentRun } from "../../../../platform/cli-coord/src/agent.ts";
import { isTeamRoleAgent, teamRoleAgentId, teamRoleOf, teamThreadIdOf, teamThreadTitle, type HandoffRoute, type Team, type TeamRole } from "../team.ts";
import { storeHandoffQuietly, type HandoffMessage } from "../inbox.ts";
import { renderDelivery, type DeliverOutcome } from "../role-deliver.ts";
import { itemDispatchRefs, spinoffRowsServingItem, type ServingRows } from "../../../../platform/cli-coord/src/spinoff-item.ts";
import { NEEDS_YOU_MARKER, stateDisplayLines } from "../../../../platform/cli-coord/src/spinoff-state-reason.ts";
import { spinoffStatusWord } from "../../../../platform/cli-coord/src/spinoff-vocab.ts";
import { isSpikeEnd, isSpikeTagged } from "../../../../platform/cli-coord/src/spinoff-spike.ts";
import {
  PAST_THE_END,
  T3Client,
  T3Error,
  T3_LIVE_STATUSES,
  isT3ThreadStatus,
  isT3Timeout,
  turnAutoSettleOff,
  type T3Capabilities,
  type T3LaunchInput,
  type T3LaunchResult,
  type T3Project,
  type T3ProviderModel,
  type T3QueueRead,
  type T3SendInput,
  type T3Thread,
  type T3ThreadListResult,
  type T3ThreadRead,
} from "./client.ts";

/** The launcher value that routes a spinoff row to T3 (the `launcher` column's third vocabulary word). */
export const T3_LAUNCHER = "t3";

/** The runtime modes `t3_thread_launch` accepts, transcribed from its schema. */
export const T3_RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
/** Builders run with full access unless the ticket says otherwise (map: the settled "no approvals" answer). */
export const T3_DEFAULT_RUNTIME_MODE = "full-access";

/** How long a mirrored agent row lives without a refresh: the same 15m every launcher stamps. */
export const T3_AGENT_TTL_S = 900;

// ---------------------------------------------------------------------------
// The seam — one interface, one fake in tests, `T3Client.connected()` in production
// ---------------------------------------------------------------------------

export interface T3Seam {
  projects(): Promise<T3Project[]>;
  /** `search` (OB-1815) asks T3 for models its short default list omits; absent is the short list. */
  capabilities(search?: string): Promise<T3Capabilities>;
  list(opts: {
    projectId?: string;
    titleContains?: string;
    settled?: boolean;
    statuses?: string[];
    includeSubagents?: boolean;
    limit?: number;
    cursor?: number;
  }): Promise<T3ThreadListResult>;
  /** `afterPosition`/`limit` page the timeline from a position (T3 lists oldest first); the default is one item. */
  read(threadId: string, opts?: { afterPosition?: number; limit?: number; view?: "messages" | "activity" }): Promise<T3ThreadRead>;
  launch(input: T3LaunchInput): Promise<T3LaunchResult>;
  /** Put a thread on the pinned list (`t3_thread_organize pin`): every team thread, on every bind (OB-2255). */
  pin(threadId: string): Promise<void>;
  /** Take a thread off the pinned list (`t3_thread_organize unpin`): a team role removed (`--remove`, `team rm --force`). */
  unpin(threadId: string): Promise<void>;
  /** Turn T3's inactivity sweep off for one thread and read it back (OB-1845). Throws when it did not take. */
  disableAutoSettle(threadId: string): Promise<void>;
  /** Retitle a thread (`t3_thread_update rename`): a team thread's fixed title on adopt (1414, OB-2255). */
  rename(threadId: string, title: string): Promise<void>;
  settle(threadId: string): Promise<void>;
  /** Stop a thread's turn in flight (`t3_thread_interrupt`): `ob spinoff abandon` (1697), before the settle. */
  interrupt(threadId: string): Promise<void>;
  /** Deliver a message into a thread (1133): the readying note, and the land reply. */
  send(input: T3SendInput): Promise<void>;
  /**
   * The messages a thread is HOLDING, queued and undelivered (1205). Read — and withdrawn from — by the
   * land, so a readying note for a ticket that has just landed never arrives as a gate request. The read
   * reports whether it saw the WHOLE queue: an incomplete read is never evidence of absence.
   */
  queue(threadId: string): Promise<T3QueueRead>;
  /** Withdraw one held message before T3 delivers it (`t3_queue` `action: "cancel"`, 1205). */
  queueCancel(threadId: string, queuedRunId: string): Promise<void>;
  /**
   * Wait (bounded) for a thread's run to finish (1133). Returns immediately when there is no run, so it
   * is safe to call after a send that did nothing.
   */
  wait(threadId: string, timeoutMs?: number): Promise<{ runId: string | null; status: string; timedOut: boolean }>;
}

/**
 * Read only a thread's header (OB-2192): `afterPosition` past the end, so T3 pages no items. The plain
 * `seam.read(id)` starts at the first item, which times out under load on a long architect thread; every
 * caller that wants only `.thread` reads through this. `read` itself keeps its from-the-start default.
 */
export async function readThreadHeader(seam: Pick<T3Seam, "read">, threadId: string): Promise<T3Thread> {
  return (await seam.read(threadId, { afterPosition: PAST_THE_END, limit: 1 })).thread;
}

/** The production seam: a connected `T3Client` behind the same shape tests fake. */
export async function connectedT3Seam(): Promise<T3Seam> {
  const client = await T3Client.connected();
  return {
    projects: () => client.projects(),
    capabilities: (search) => client.capabilities(search),
    list: (opts) => client.list(opts),
    read: (threadId, opts) =>
      client.read(threadId, {
        limit: opts?.limit ?? 1,
        runLimit: 5,
        ...(opts?.afterPosition === undefined ? {} : { afterPosition: opts.afterPosition }),
        ...(opts?.view === undefined ? {} : { view: opts.view }),
      }),
    launch: (input) => client.launch(input),
    // A re-pin of a pinned thread is a no-op, not an error (checked live 2026-11-17, OB-2251: pin, pin, unpin
    // on a builder thread all answered with a sequence), so every bind can pin without reading first.
    pin: async (threadId) => {
      await client.organize(threadId, "pin");
    },
    unpin: async (threadId) => {
      await client.organize(threadId, "unpin");
    },
    disableAutoSettle: async (threadId) => {
      await turnAutoSettleOff(threadId);
    },
    rename: async (threadId, title) => {
      await client.rename(threadId, title);
    },
    settle: async (threadId) => {
      await client.settle(threadId);
    },
    interrupt: async (threadId) => {
      await client.interrupt(threadId);
    },
    send: async (input) => {
      await client.send(input);
    },
    queue: (threadId) => client.queue(threadId),
    queueCancel: async (threadId, queuedRunId) => {
      await client.queueCancel(threadId, queuedRunId);
    },
    wait: (threadId, timeoutMs) => client.wait(threadId, timeoutMs),
  };
}

const t3SeamOverride = defineSeam<T3Seam | null>("t3/dispatch.t3Seam", null);

/** Test seam: drive the whole dispatch surface with a fake T3. Returns a restore fn. */
export function __setT3Seam(next: T3Seam | null): () => void {
  return t3SeamOverride.set(next);
}

/**
 * The seam to use. Built LAZILY and only where it is needed: a machine with no `t3` rows and no
 * `ob t3 architect` never reads a credential, and the credential's own named failures (`ob t3 login`)
 * arrive from `T3Client.connected()` unchanged.
 */
export async function t3Seam(): Promise<T3Seam> {
  return t3SeamOverride.get() ?? (await connectedT3Seam());
}

// ---------------------------------------------------------------------------
// Naming — what ob titles a thread, and the retry key it sends
// ---------------------------------------------------------------------------

/**
 * The retry key ob sends with a launch, derived from the row id so it is STABLE across every retry of
 * that row. Sent as `clientRequestId`; not relied upon on the pinned build (see the file header).
 */
export function clientRequestIdFor(rowId: number): string {
  return `ob-spinoff-${rowId}`;
}

/**
 * The retry key for ONE team-thread creation (OB-2128): the role's agent id plus a nonce made once per
 * creation. T3 dedups a launch on its clientRequestId and hands back the thread the first launch made, so a key
 * stable across creations would return a thread already settled. Pure.
 */
function teamRequestIdFor(agentId: string, nonce: string): string {
  return `ob-team-${agentId}-${nonce}`;
}

/** The nonce for one team-thread creation: the thread it replaces (or `new`) and the time. */
function teamNonce(replacing: string | null): string {
  return `${replacing ?? "new"}-${Date.now().toString(36)}`;
}

/**
 * The first message a NEWLY CREATED team thread receives (1458, OB-2255). T3 has no per-thread system
 * instructions, so the role can only arrive as this message: the role's skill (`/ob-architect`, `/ob-sentinel`,
 * `/ob-muse`) and one orientation line naming the team. It orients ONLY: no ticket work, then it asks. Pure.
 */
export function teamSeedMessage(team: string, role: TeamRole, members: readonly string[], repoPath: string): string {
  const projects = members.length > 0 ? members.join(", ") : "none yet";
  return [
    `/ob-${role}`,
    "",
    `You are the ${role} of team \`${team}\` (projects: ${projects}), opened in ${repoPath}. Orient only: read ` +
      `\`ob t3 team show ${team}\` and \`ob status\`, then ask me what to do. Do not start ticket work or dispatch anything yet.`,
  ].join("\n");
}

/**
 * The first message a team thread opened by `ob t3 team restart` receives (OB-2257): the role's skill, one line
 * saying whose seat it takes, and the old thread's handoff, which it carries on from (not "orient only"). Its
 * scheduled tasks could not move with it, so the seed names re-creating the ones the handoff lists. Pure.
 */
export function teamRestartSeedMessage(
  team: string,
  role: TeamRole,
  members: readonly string[],
  repoPath: string,
  handoff: { body: string; oldThreadId: string | null },
): string {
  const projects = members.length > 0 ? members.join(", ") : "none yet";
  const replaced = handoff.oldThreadId ? `thread ${handoff.oldThreadId}` : "the previous thread";
  return [
    `/ob-${role}`,
    "",
    `You are the ${role} of team \`${team}\` (projects: ${projects}), opened in ${repoPath}. \`ob t3 team restart\` ` +
      `replaced ${replaced} with you to start a fresh thread. Carry on from the handoff below: pick up the work it ` +
      `names, re-create each scheduled task it lists with your own schedule_task tool (they could not move with ` +
      `the thread), and ask the owner only what it leaves open.`,
    "",
    "## Handoff",
    "",
    handoff.body,
  ].join("\n");
}

/** The message `ob t3 team restart` sends a role thread it is about to replace (OB-2257). Pure. */
export function teamHandoffRequestMessage(team: string, role: TeamRole): string {
  return [
    `ob is restarting this thread (\`ob t3 team restart ${team}\`): a fresh ${role} thread takes over from you, ` +
      `seeded with the handoff you write now.`,
    "",
    `1. Write everything the next ${role} of team \`${team}\` needs to carry on without asking: the work in flight ` +
      `with its refs, what you are waiting on, questions open for the owner, calls made this session that are not yet ` +
      `recorded, and the full prompt and schedule of every scheduled task you own.`,
    `2. Record it: write it to a file and run \`ob t3 team handoff ${team} --role ${role} --body-file <file>\`.`,
    "3. Only after that, delete your own scheduled tasks (their prompts are in the handoff).",
    "4. End your turn and start nothing else: ob settles this thread once the handoff is recorded.",
  ].join("\n");
}

/** How long a ticket title may get before it is cut: a sidebar shows one line, not a paragraph. */
const TICKET_TITLE_MAX = 60;

/** The separators a title may put between a repeated ref and the name: `1124: x`, `1124 — x`, `1124 - x`. */
const REF_SEPARATOR = /^[\s:·—–-]+/;

/**
 * An ob item's title reduced to a one-line sidebar NAME (1143). Drops a LEADING repeat of the ticket ref
 * ('1143: spinoff threads wear the ticket's name' → 'spinoff threads wear the ticket's name'), because
 * the ref is already printed in front of the name and would otherwise appear twice; collapses every run
 * of whitespace, so a title carrying a newline is still one line; and cuts to `TICKET_TITLE_MAX` chars
 * with an ellipsis. Null when there is no usable title at all, so the caller can fall back. Pure, and
 * module-private: the title a thread WEARS is `builderThreadTitle`'s contract, and that is what is tested.
 */
function shortTicketTitle(ticketRef: string, title: string | null | undefined): string | null {
  if (!title) return null;
  let s = title.replace(/\s+/g, " ").trim();
  const ref = ticketRef.trim().replace(/^#/, "");
  if (ref) {
    const bare = s.startsWith("#") ? s.slice(1) : s;
    // A title that begins with the ref: '1143: fix it', '1143 fix it'. It must be the WHOLE ref — so
    // '11431 not this ticket' is left alone — and what follows it must be a separator, or nothing.
    if (bare.startsWith(ref)) {
      const rest = bare.slice(ref.length);
      if (rest === "" || REF_SEPARATOR.test(rest)) s = rest.replace(REF_SEPARATOR, "").trim();
    }
  }
  if (!s) return null;
  return s.length > TICKET_TITLE_MAX ? `${s.slice(0, TICKET_TITLE_MAX - 1).trimEnd()}…` : s;
}

/**
 * What ob TITLES a builder thread: `<ticket> · <name>` (1143), where `<name>` is the TICKET'S OWN title
 * — the human name for the work, and the thing a column of bare numbers was missing.
 *
 * Fallbacks, in order: no title found → the pre-1143 `<ticket> · <branch>` (an explicitly named branch
 * still carries information); still nothing → the ticket alone (the common case, `ob spinoff 1120` →
 * branch `1120`). The ref is always FIRST and is the identity.
 *
 * A title is read from the row's ob item at LAUNCH (one lookup where the row is already at hand) and is
 * never re-read per thread read. ob writes this and ob is the only reader that matters; a thread title
 * is NEVER parsed back into a ticket (the map's "ids only" rule) — which is why a wrong or missing name
 * cannot mis-route anything. The title is a label for the human's sidebar. Pure.
 */
export function builderThreadTitle(ticketRef: string, branch: string, ticketTitle?: string | null): string {
  const ref = ticketRef.trim();
  const name = shortTicketTitle(ref, ticketTitle);
  if (name) return `${ref} · ${name}`;
  const b = branch.trim();
  return b && b !== ref ? `${ref} · ${b}` : ref;
}

/**
 * A thread title with the needs-you marker set or cleared (1579). `needs-human` puts `🙋 ` in front of whatever
 * title the thread wears; any other status takes it off again, so the marker lives exactly as long as the
 * agent is waiting. Idempotent, and it never touches the rest of the title. Pure.
 */
export function titleWithNeedsYou(title: string, status: string | null | undefined): string {
  // The lease marker run (OB-2153 `⏳`, OB-2169 `🔒`) stays in front: this function only moves its own marker, behind it.
  const lease = LEASE_MARKER_RUN.exec(title)?.[0] ?? "";
  const bare = title.slice(lease.length).replace(new RegExp(`^${NEEDS_YOU_MARKER}\\s*`, "u"), "");
  return `${lease}${status === "needs-human" ? `${NEEDS_YOU_MARKER} ${bare}` : bare}`;
}

/** A waiting lease's marker emoji (OB-2153). */
const LEASE_WAIT_MARKER = "⏳";
/** A held lease's marker emoji (OB-2169): only `ob lease run` sets it. */
const LEASE_HOLD_MARKER = "🔒";
/**
 * The run of lease markers at the very front of a title (OB-2169): one or more `⏳<label>` / `🔒<label>` tokens
 * separated by one space, ended by one ` · `. A label never carries whitespace (`leaseLabel`).
 */
const LEASE_MARKER_RUN = new RegExp(`^((?:(?:${LEASE_WAIT_MARKER}|${LEASE_HOLD_MARKER})\\S+ )*(?:${LEASE_WAIT_MARKER}|${LEASE_HOLD_MARKER})\\S+) · `, "u");

/** Which lease marker a resource wears: `waiting` is `⏳` (OB-2153), `holding` is `🔒` (OB-2169). */
export type LeaseMarkerState = "waiting" | "holding";

/** A title split into its lease marker tokens (front first) and the rest. Pure. */
function splitLeaseMarkers(title: string): { markers: string[]; rest: string } {
  const m = LEASE_MARKER_RUN.exec(title);
  return m ? { markers: m[1]!.split(" "), rest: title.slice(m[0].length) } : { markers: [], rest: title };
}

/** The label a marker token carries: everything after its state emoji. Pure. */
function markerLabel(token: string): string {
  return Array.from(token).slice(1).join("");
}

/** The title with every lease marker taken off (the whole run and its ` · `). Pure. */
export function stripLeaseMarkers(title: string): string {
  return splitLeaseMarkers(title).rest;
}

/**
 * A thread title with ONE resource's lease marker set or cleared (OB-2153, OB-2169). Several leases each keep their
 * own marker in the run at the front (`🔒🌐 ⏳🔌5101 · <title>`). `waiting` sets `⏳<label>`, `holding` sets
 * `🔒<label>`: in place of this resource's own marker if it has one (a wait that turns into a hold swaps it), else at
 * the front of the run. null removes only this resource's marker. Every other marker, and everything after the run
 * (a needs-you `🙋` included), is left byte for byte. A marker is found by its label, so two resources with the same
 * label in one thread share one marker. Pure.
 */
export function titleWithLeaseMarker(title: string, resource: string, state: LeaseMarkerState | null | undefined): string {
  const label = leaseLabel(resource);
  const { markers, rest } = splitLeaseMarkers(title);
  const i = markers.findIndex((t) => markerLabel(t) === label);
  const next = [...markers];
  if (state) {
    const token = `${state === "holding" ? LEASE_HOLD_MARKER : LEASE_WAIT_MARKER}${label}`;
    if (i >= 0) next[i] = token;
    else next.unshift(token);
  } else if (i >= 0) next.splice(i, 1);
  return next.length ? `${next.join(" ")} · ${rest}` : rest;
}

/** Every team thread title ends with ` · <role>` (OB-2255); no builder title does (builders are `<ref> · <title>`). */
const TEAM_TITLE_SUFFIX = / · (architect|sentinel|muse)$/;

/**
 * Whether a thread title is a team role's (`🚌 OmniSlash · architect`), whatever the icon, name or needs-you marker
 * in front. A builder is `<ref> · <title>`, so a title that starts with a ticket ref is a builder's even when its
 * ticket title ends in a role word. Routing never uses this (a team thread is found by its recorded thread id);
 * it is for reports that sort a thread list into team threads and builders. Pure.
 */
export function isTeamRoleTitle(title: string): boolean {
  const bare = titleWithNeedsYou(stripLeaseMarkers(title), null);
  const m = TEAM_TITLE_SUFFIX.exec(bare);
  if (!m) return false;
  const head = bare.slice(0, m.index).trim();
  return head !== "" && !/^([A-Z]{2,4}-)?\d+( · |$)/.test(head);
}

// ---------------------------------------------------------------------------
// Resolution — the project, the model, the runtime mode
// ---------------------------------------------------------------------------

/** A path as the filesystem really spells it, so two spellings of one checkout compare equal. Pure-ish. */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The repo a `<repo>.<branch>` worktree belongs to, or null when `path` is not one. A `wt` worktree is
 * `<repo>.<branch>` BESIDE its repo — the convention #217 and #235 already read a worktree directory by —
 * and the T3 PROJECT is the repo checkout, never the worktree (which is why a thread binds one as an
 * `existing_worktree`). So a human sitting in a worktree gets the repo's project and the repo's architect
 * slug, rather than a second identity per checkout. Pure-ish (one directory probe).
 */
export function worktreeRepoOf(path: string): string | null {
  const seg = basename(path);
  const dot = seg.indexOf(".");
  if (dot > 0) {
    const sibling = join(dirname(path), seg.slice(0, dot));
    try {
      if (existsSync(join(sibling, ".git"))) return sibling;
    } catch {
      // fall through to git's own record
    }
  }
  return linkedWorktreeRepoOf(path);
}

/**
 * The main checkout of a linked git worktree that is NOT beside its repo — T3's own composer worktrees
 * live at `~/.t3/worktrees/<repo>/t3-<id>` (1414). Read from git's own files, no process: the worktree's
 * `.git` FILE names its gitdir, whose `commondir` names the repo's `.git`. Null for a repo checkout (its
 * `.git` is a directory) or anything git did not write. Pure-ish (two small reads).
 */
function linkedWorktreeRepoOf(path: string): string | null {
  try {
    const dotGit = readFileSync(join(path, ".git"), "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!dotGit) return null;
    const gitdir = resolve(path, dotGit);
    const common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
    if (basename(common) !== ".git") return null;
    const repo = dirname(common);
    return existsSync(join(repo, ".git")) ? repo : null;
  } catch {
    return null;
  }
}

/**
 * The T3 project a repo checkout belongs to: the one whose `workspaceRoot` IS that checkout. T3 binds a
 * thread to a worktree *of* the project, so the project is resolved from the repo ob owns the worktrees
 * of — never from the worktree path itself, which is a sibling directory. A worktree path resolves to its
 * repo first (see `worktreeRepoOf`). Null when no project matches; the caller refuses with the remedy
 * rather than guessing. Pure.
 */
export function t3ProjectFor(projects: T3Project[], repoPath: string): T3Project | null {
  const match = (p: string): T3Project | null => {
    const want = canonicalPath(p);
    return projects.find((x) => !x.deletedAt && canonicalPath(x.workspaceRoot) === want) ?? null;
  };
  return match(repoPath) ?? match(worktreeRepoOf(repoPath) ?? repoPath);
}

export interface T3ModelSelection {
  instanceId: string;
  model: string;
}

export interface ModelResolution {
  selection: T3ModelSelection | null;
  /** The named reason there is none. */
  error: string | null;
  /** What the spinoff row records: `<provider>:<model>` when the tier named its provider (1549), else the bare model. */
  stamp?: string;
  /** True when the refusal is ob's `spinoff_tier_models` config (not the T3 project's own settings). */
  tierConfig?: boolean;
}

// ---------------------------------------------------------------------------
// The complexity tier — which model a builder runs on (1480)
// ---------------------------------------------------------------------------

/**
 * The tiers an architect rates a dispatch with (`ob spinoff <ref> --tier …`, 1480). Every build used to run on
 * the T3 project's default model, which for OmniSlash is Opus — so a copy fix cost what a schema migration
 * costs. The tier picks the model instead; the architect's rubric for it lives in the ob-architect skill.
 */
export { SPINOFF_TIERS, splitTierModel, type SpinoffTier };
// OS-145: the tier defaults and the setting parser moved to models-file.ts, which the route resolver shares.
export { DEFAULT_TIER_MODELS, isSpinoffTier, parseTierModels } from "../models-file.ts";

/** A dispatch that names no tier runs on this one: forgetting to rate costs Sonnet, not Opus. */
export const DEFAULT_SPINOFF_TIER: SpinoffTier = "medium";

/** The rejection for an unknown `--tier <value>`. Pure. */
export function tierRejection(prefix: string, value: string): string {
  return `${prefix} '${value}' is not a tier — use one of ${SPINOFF_TIERS.join("|")} (no tier = ${DEFAULT_SPINOFF_TIER})`;
}

/** The note `--tier` prints now that the score is `--complexity` (OS-177). */
export const TIER_ALIAS_NOTE = "ob: --tier is now --complexity; simple=2 medium=5 complex=8";

/**
 * A dispatch's score off `--complexity <1-10>` and its old alias `--tier <simple|medium|complex>` (OS-177):
 * undefined when neither is named, the score otherwise. `--tier` prints `TIER_ALIAS_NOTE` through `note`; both
 * flags, a score outside 1-10 and an unknown tier are UsageErrors (exit 2) before anything is read or written.
 */
export function dispatchComplexityFlags(complexity: string | undefined, tier: string | undefined, note: (line: string) => void = warn, prefix = "spinoff"): number | undefined {
  if (complexity !== undefined && tier !== undefined) throw new UsageError(`${prefix}: pass --complexity <1-10> or --tier, not both (--tier is the old name of --complexity)`);
  if (complexity !== undefined) {
    const c = parseComplexity(complexity);
    if (c === null) throw new UsageError(`${prefix} --complexity '${complexity}' is not a score: use a whole number 1-10 (no score = ${DEFAULT_COMPLEXITY})`);
    return c;
  }
  if (tier === undefined) return undefined;
  const t = tier.trim();
  if (!isSpinoffTier(t)) throw new UsageError(tierRejection(`${prefix} --tier`, tier));
  note(TIER_ALIAS_NOTE);
  return TIER_COMPLEXITY[t];
}

/**
 * The builder's verdict on its own tier (`ob spinoff handoff --tier-fit`): was the tier it ran on right?
 * `lower` = it could have run on a cheaper tier, `higher` = it needed a more expensive one. Feeds 1548/1551.
 */
export const TIER_FITS = ["lower", "right", "higher"] as const;
export type TierFit = (typeof TIER_FITS)[number];

/** The decision-trail text for a tier-fit rating: `tier-fit: higher (ran medium on claude-sonnet-5-5) — why`. Pure. */
export function tierFitLine(fit: TierFit, tier: string | null, model: string | null, why: string | null): string {
  const ran = `ran ${tier ?? DEFAULT_SPINOFF_TIER} on ${model ?? "(model unreported)"}`;
  return `tier-fit: ${fit} (${ran})${why ? ` — ${why}` : ""}`;
}

/** A handoff's tier-fit rating (1552): the verdict plus the builder's one-line reason, if it gave one. */
export interface TierFitRating {
  fit: TierFit;
  why: string | null;
}

/**
 * The rating a handoff carries (1552), or null when it carries none. `why` only explains a rating, so a why
 * with no rating, and a rating that is not one of TIER_FITS, are UsageErrors before anything is stamped — the
 * API route maps that to a 400 for free, so the CLI and the host refuse with one call and one wording.
 */
export function tierFitOf(fit: string | undefined | null, why: string | undefined | null): TierFitRating | null {
  const f = fit?.trim() ? fit.trim() : null;
  const w = why?.trim() ? why.trim() : null;
  if (f == null) {
    if (w != null) throw new UsageError("--tier-fit-why needs --tier-fit lower|right|higher");
    return null;
  }
  if (!(TIER_FITS as readonly string[]).includes(f)) {
    throw new UsageError(`spinoff handoff --tier-fit '${f}' is not a tier fit — use one of ${TIER_FITS.join("|")}`);
  }
  return { fit: f as TierFit, why: w };
}

/**
 * The tier a ROW launches at: its recorded tier, or the default for a row that has none (queued before
 * 0034, or a client that sent none). A recorded value that is not a tier is a refusal, never the default:
 * something wrote a word this build does not know, and guessing a model for it is the silent wrong launch.
 */
export function rowTier(raw: string | null | undefined): SpinoffTier {
  if (raw === null || raw === undefined || raw === "") return DEFAULT_SPINOFF_TIER;
  if (isSpinoffTier(raw)) return raw;
  throw new T3Error("refused", tierRejection("the row's tier", raw), `re-dispatch with --tier ${SPINOFF_TIERS.join("|")}`);
}

/**
 * The score a ROW launches at (OS-177): its stamped complexity, else its tier's alias value (a row queued before
 * OS-177), else the default 5. A tier this build does not know is refused, as `rowTier` refuses it.
 */
export function rowComplexity(row: { complexity?: number | null; tier?: string | null }): number {
  const c = complexityOf(row.complexity, row.tier);
  if (c !== null) return c;
  if (row.complexity !== null && row.complexity !== undefined) {
    throw new T3Error("refused", `the row's complexity '${row.complexity}' is not a score 1-10`, "re-dispatch with --complexity <1-10>");
  }
  return TIER_COMPLEXITY[rowTier(row.tier)]; // rowTier refuses the unknown tier by name
}

// ---------------------------------------------------------------------------
// The reasoning level — how hard a builder thinks on the model the tier picked (OB-1815)
// ---------------------------------------------------------------------------

/**
 * The levels `--effort` accepts. The five a Claude model lists as its real levels: T3 also lists
 * `ultrathink` (a one-turn prompt keyword, not a level a builder runs at) and OpenCode lists its own
 * `variant` words, so `ultrathink`, `ultracode`, `none`, `minimal` and `auto` are refused at the flag.
 */
export const SPINOFF_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type SpinoffEffort = (typeof SPINOFF_EFFORTS)[number];

export function isSpinoffEffort(s: string): s is SpinoffEffort {
  return (SPINOFF_EFFORTS as readonly string[]).includes(s);
}

/** The rejection for an unknown `--effort <value>`. Pure. */
export function effortRejection(prefix: string, value: string): string {
  return `${prefix} '${value}' is not an effort level — use one of ${SPINOFF_EFFORTS.join("|")} (no --effort = the model's own default)`;
}

/**
 * The level a ROW asks for: the word `queue` recorded, or undefined for a row that named none. The column
 * also holds what a launch STAMPED (`high`, `default (high)`, `default (none listed)`, `route (low)`), so a
 * `default (...)` or `route (...)` text reads as "none named": a relaunch takes the route's effort afresh (OS-145). Any other value is a refusal, never a guess (as `rowTier`).
 */
function rowEffort(raw: string | null | undefined): SpinoffEffort | undefined {
  if (raw === null || raw === undefined || raw === "" || raw.startsWith("default") || raw.startsWith("route")) return undefined;
  if (isSpinoffEffort(raw)) return raw;
  throw new T3Error("refused", effortRejection("the row's effort", raw), `re-dispatch with --effort ${SPINOFF_EFFORTS.join("|")}`);
}

/** What a launch does about effort: the `options` it sends (none when no level was named) and the text the row stores. */
interface EffortResolution {
  options?: Array<{ id: string; value: string }>;
  /** `high` when named; else `default (<the model's default>)`, or `default (none listed)`. */
  stamp: string;
}

/**
 * The effort a launch sends for `model`, read from the options the model lists. Claude models list
 * `effort`, OpenCode models `variant`: whichever the model has is the option id. With no level named,
 * nothing is sent and the stamp says what T3 will run at. A named level on a model that lists no such
 * option, or not that level, is an `error` naming the model and the levels it does list. Pure.
 */
function effortFor(model: T3ProviderModel | undefined, modelId: string, requested: SpinoffEffort | undefined): { resolution: EffortResolution; error: null } | { resolution: null; error: string } {
  const options = model?.options ?? [];
  const option = options.find((o) => o.id === "effort") ?? options.find((o) => o.id === "variant");
  if (requested === undefined) {
    return { resolution: { stamp: option?.default ? `default (${option.default})` : "default (none listed)" }, error: null };
  }
  if (!option) {
    return { resolution: null, error: `model '${modelId}' lists no effort or variant option, so --effort ${requested} cannot be applied` };
  }
  if (!option.values.includes(requested)) {
    // Only the levels --effort accepts: T3 also lists `ultrathink` (a prompt word) and `ultracode`, which the flag refuses.
    const usable = option.values.filter(isSpinoffEffort);
    return { resolution: null, error: `model '${modelId}' does not list ${option.id} '${requested}' — it lists ${usable.length > 0 ? usable.join(", ") : "none --effort takes"}` };
  }
  return { resolution: { options: [{ id: option.id, value: requested }], stamp: requested }, error: null };
}


/**
 * The model a launch runs on (1480): the TIER's model, on the T3 project's own provider instance.
 *
 * The instance comes from the project's default selection — that is T3's own per-project answer to
 * "which provider does this repo's work run on" — and only the MODEL is swapped for the tier's. A tier
 * value of the form `<provider>:<model>` (1549) names its provider instead: the instance is then looked up
 * in the capabilities by that id, so a cheap tier can reach a model the project's own provider does not
 * carry (DeepSeek on `opencode`). The project's default is not consulted for such a tier.
 * There is deliberately no catalog fallback: a fallback would silently pick whatever happens to be listed first,
 * which on this machine is a free model — a quiet downgrade of every builder, worse than a refusal. So
 * a project with no default, a provider T3 does not advertise or reports as disabled or unauthenticated,
 * and a tier model the instance's catalog does not list are each a refusal naming its own reason, not a
 * run that dies later inside T3's activity view. `tierModel` absent keeps the project's own model (the
 * pre-1480 behaviour, kept for callers that have no tier). Pure.
 */
export function modelSelectionFor(
  project: T3Project,
  capabilities: T3Capabilities,
  tierModel?: string,
  /** OS-132: what named `tierModel`, for the refusal: the profile's band (`tier model`) or the dispatch's `--model`. */
  source = "tier model",
): ModelResolution {
  const split = tierModel === undefined ? null : splitTierModel(tierModel);
  if (tierModel !== undefined && !split) {
    return { selection: null, error: `${source} '${tierModel}' has an empty ${emptyHalfOf(tierModel)} — a qualified value needs a provider AND a model around the first colon`, tierConfig: true };
  }
  const named = split?.providerInstanceId ?? null;
  const selection = project.defaultModelSelection ?? null;
  if (!named && (!selection || !selection.instanceId || !selection.model)) {
    return {
      selection: null,
      error: `T3 project '${project.title}' has no default model, so a launch would run on a guess`,
    };
  }
  const instanceId = named ?? selection!.instanceId;
  const instance = capabilities.providers.find((p) => p.providerInstanceId === instanceId);
  if (!instance) {
    return named
      ? { selection: null, error: `T3 does not advertise the provider instance '${instanceId}' the ${source} '${tierModel}' names`, tierConfig: true }
      : { selection: null, error: `T3 does not advertise the provider instance '${instanceId}' the project's default model names` };
  }
  const constraints = instance.constraints ?? [];
  if (constraints.length > 0) {
    return {
      selection: null,
      error: `T3 reports provider '${instanceId}' unusable: ${constraints[0]}`,
      tierConfig: !!named,
    };
  }
  const model = split ? split.model : selection!.model;
  if (split && !(instance.models ?? []).some((m) => m.id === model)) {
    return {
      selection: null,
      error: `T3's catalog does not list ${source === "tier model" ? "model" : source} '${model}' on provider '${instanceId}'`,
      tierConfig: true,
    };
  }
  return named
    ? { selection: { instanceId, model }, error: null, stamp: `${named}:${model}` }
    : { selection: { instanceId, model }, error: null };
}

/**
 * The runtime mode a ticket asks for, from its own frontmatter (`runtimeMode: <mode>` in
 * `wayfinder/tickets/<id>-*.md`), defaulting to full access. An unknown value is a WARNING and the
 * default, never a silent pass-through of a string T3 would reject. Pure over the file contents.
 */
export function runtimeModeFromFrontmatter(text: string, ticketRef: string): string {
  const raw = frontmatterField(text, "runtimeMode");
  if (raw === null) return T3_DEFAULT_RUNTIME_MODE;
  if ((T3_RUNTIME_MODES as readonly string[]).includes(raw)) return raw;
  warn(`ticket ${ticketRef}: runtimeMode '${raw}' is not one of ${T3_RUNTIME_MODES.join("|")} — launching with ${T3_DEFAULT_RUNTIME_MODE}`);
  return T3_DEFAULT_RUNTIME_MODE;
}

/** One `key: value` line out of a markdown file's leading `---` frontmatter block, or null. Pure. */
export function frontmatterField(text: string, field: string): string | null {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return null;
  for (const line of block[1]!.split(/\r?\n/)) {
    const m = line.match(new RegExp(`^\\s*${field}\\s*:\\s*(.*?)\\s*$`));
    if (m) return m[1]!.replace(/^["']|["']$/g, "");
  }
  return null;
}

/**
 * The `wayfinder/tickets/` file for a ticket ref, or null. A leading `#` is tolerated. Pure-ish (fs).
 *
 * ABSENCE (no such directory, no such file) is null — that is the common case for a ref with no charted
 * ticket, and every caller has a fallback for it. Any OTHER readdir error is REPORTED rather than read as
 * absence (1162): an unreadable ticket directory would otherwise silently downgrade a composed brief to a
 * pointer, or a ticket's runtimeMode to the default, with nothing saying so.
 */
export function ticketFilePath(repoPath: string, ticketRef: string): string | null {
  const dir = join(repoPath, "wayfinder", "tickets");
  const ref = ticketRef.trim().replace(/^#/, "");
  if (!ref) return null;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const hit = names
    .filter((n) => n.endsWith(".md"))
    .find((n) => n === `${ref}.md` || n.startsWith(`${ref}-`));
  return hit ? join(dir, hit) : null;
}

/** The runtime mode for one ticket, read off its frontmatter file when there is one. */
export function runtimeModeForTicket(repoPath: string, ticketRef: string): string {
  const path = ticketFilePath(repoPath, ticketRef);
  if (!path) return T3_DEFAULT_RUNTIME_MODE;
  try {
    return runtimeModeFromFrontmatter(readFileSync(path, "utf8"), ticketRef);
  } catch {
    return T3_DEFAULT_RUNTIME_MODE;
  }
}

// ---------------------------------------------------------------------------
// Launch — find the thread this row already owns, else open one
// ---------------------------------------------------------------------------

/** The row fields a T3 launch reads. Structural, so the spinoff row satisfies it as it is. */
export interface T3DispatchRow {
  id: number;
  ticket_ref: string;
  repo: string;
  branch: string;
  worktree: string;
  brief: string;
  /** The tier the architect rated it (1480): only the label now, and a NULL-complexity row's score (OS-177). */
  tier?: string | null;
  /** OS-177: the score 1-10 that picks the builder band; absent/null reads the tier's alias value, else 5. */
  complexity?: number | null;
  /** The effort `--effort` named at queue (OB-1815), or what a launch stamped; absent/null/`default (...)` names none. */
  effort?: string | null;
  /** OB-1991: a model trial leg's own model, which beats the tier's (and any profile's). */
  trial_model?: string | null;
  /** OS-132: the model `--model` named for this row, which beats the band's (and any profile's); a trial leg's beats it. */
  model_ask?: string | null;
  /** OS-145: the route's effort, used when the row names none and the model lists that level. */
  route_effort?: string | null;
}

/** How many `t3_thread_list` pages the adoption scan will walk before giving up rather than guessing. */
export const ADOPTION_SCAN_MAX_PAGES = 5;

export interface T3LaunchOutcome {
  threadId: string;
  runId: string | null;
  /** true when this launch FOUND the thread a previous attempt opened and stamped it, rather than opening one. */
  adopted: boolean;
  /** The model the thread runs on (1480): the tier's model, or an adopted thread's own. Stamped on the row. */
  model: string;
  /** The effort text the row stores (OB-1815): `high`, `default (high)` or `default (none listed)`. */
  effort: string;
}

/**
 * The thread this row already owns, or null. Identity is the WORKTREE: ob gives each spinoff row its own
 * `<repo>.<branch>` checkout under a lease, so a thread bound to that path is that row's thread and no
 * other row can claim it. T3's own `titleContains` filter narrows the scan to the threads ob titled for
 * this ticket; the TITLE is never the identity — the `worktreePath` is.
 *
 * A truncated scan throws rather than returning "none": an unproven absence would double-launch, which
 * is the one thing this function exists to prevent.
 */
export async function findThreadForWorktree(
  seam: T3Seam,
  projectId: string,
  row: T3DispatchRow,
): Promise<T3Thread | null> {
  for await (const thread of worktreeThreads(seam, projectId, row, { settled: false })) return thread;
  return null;
}

/**
 * Every thread T3 lists for this row's ticket that is bound to its worktree, as headers, in T3's list order.
 * `settled: false` asks T3 for live threads only. A scan that runs past `ADOPTION_SCAN_MAX_PAGES` throws rather
 * than ending: an unproven absence is not "nothing there".
 */
async function* worktreeThreads(
  seam: T3Seam,
  projectId: string,
  row: T3DispatchRow,
  filter: { settled?: false } = {},
): AsyncGenerator<T3Thread> {
  const want = canonicalPath(row.worktree);
  const namesRef = titleNamesRef(row.ticket_ref);
  let cursor: number | undefined;
  for (let page = 0; page < ADOPTION_SCAN_MAX_PAGES; page++) {
    const listed = await seam.list({
      projectId,
      titleContains: row.ticket_ref,
      ...filter,
      includeSubagents: false,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const summary of listed.threads) {
      // OS-203: each header read is the one scan cost that grows with T3's load (about 4ms idle, up to 135ms
      // under a read burst), so read only a thread that can be this row's (T3 leaves subagents out), titled
      // with the ref as a whole token (T3's titleContains is a substring, so "OS-20" also lists every "OS-203").
      if (!namesRef(summary.title)) continue;
      const thread = await readThreadHeader(seam, summary.threadId);
      if (thread.worktreePath && canonicalPath(thread.worktreePath) === want) yield thread;
    }
    if (listed.nextCursor === null || listed.nextCursor === undefined) return;
    cursor = listed.nextCursor;
  }
  throw new T3Error(
    "refused",
    `gave up looking for an existing T3 thread for ${row.worktree} after ${ADOPTION_SCAN_MAX_PAGES} pages — settle the finished threads in this project, then re-run the drain`,
    "settle the finished threads in this project, then re-run the drain",
  );
}

/** How far T3's clock may trail the queueing host's before a row's own thread reads as older than the row (OS-302). */
const CLOCK_SKEW_MS = 60_000;

/**
 * OS-302: the settled thread that is this row's builder: of the threads bound to the row's worktree, the newest
 * that is not archived and was created at or after the row was requested. Two attempts on one worktree leave two
 * threads, and T3's list order says nothing about which is newer, so the first match could be the earlier failed
 * attempt's. A thread with no `createdAt` cannot be shown to be this row's and is passed over. `request_at` is the
 * queueing host's clock (the API server's, in API mode) and `createdAt` is T3's, so a minute of skew is allowed;
 * an earlier attempt's thread predates the next row by far more than that.
 */
async function newestSettledThreadForRow(seam: T3Seam, projectId: string, row: T3DispatchRow & { request_at: string }): Promise<T3Thread | null> {
  const since = Date.parse(row.request_at) - CLOCK_SKEW_MS;
  let newest: { thread: T3Thread; at: number } | null = null;
  for await (const thread of worktreeThreads(seam, projectId, row)) {
    if (thread.archived) continue;
    const at = thread.createdAt ? Date.parse(thread.createdAt) : Number.NaN;
    if (Number.isNaN(at) || !(at >= since)) continue;
    if (!newest || at > newest.at) newest = { thread, at };
  }
  return newest?.thread ?? null;
}

/**
 * OS-300: the T3 thread bound to this row's worktree, live first, else settled, as the ids a stamp records, or null
 * when T3 proves there is none. Settled threads count: a builder that committed its verdict is usually settled by the close
 * or the OS-288 sweep, and it is still the row's builder. A settled one is the newest unarchived thread created after
 * the row (OS-302), never an earlier attempt's. Throws when it cannot say: T3 unreachable, no project
 * registered for the checkout, or a scan that gave up (`worktreeThreads`), because "could not look" is not
 * "nothing there".
 */
export async function threadForRow(
  seam: T3Seam,
  repoPath: string,
  row: T3DispatchRow & { request_at: string },
): Promise<{ threadId: string; runId: string | null } | null> {
  const project = t3ProjectFor(await seam.projects(), repoPath);
  if (!project) throw new T3Error("refused", `no T3 project is registered for ${repoPath}`, `register the checkout as a T3 project (\`t3 project add ${repoPath}\`)`);
  // A live thread wins over a settled one.
  const thread = (await findThreadForWorktree(seam, project.id, row)) ?? (await newestSettledThreadForRow(seam, project.id, row));
  return thread ? { threadId: thread.threadId, runId: thread.activeRunId ?? thread.latestRunId } : null;
}

/**
 * Does a thread title carry this ticket ref as a whole token (OS-203)? Case-insensitive, and the ref may not
 * run on into more of a ref (`OS-20` does not match `OS-203` or `OS-20a`). Pure.
 */
export function titleNamesRef(ticketRef: string): (title: string) => boolean {
  const ref = ticketRef.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${ref}(?![\\p{L}\\p{N}])`, "iu");
  return (title) => re.test(title);
}

/**
 * T3's capabilities, with the tier's model in them (OB-1815). T3's default list is short (it reports
 * `omittedModels`), so a model it leaves out is asked for BY NAME with `search` and merged in, rather than
 * refused for being omitted. Only an exact id match is merged. `modelSelectionFor` then judges the merged
 * list exactly as before.
 */
async function capabilitiesWithModel(seam: T3Seam, project: T3Project, tierModel: string): Promise<T3Capabilities> {
  const caps = await seam.capabilities();
  const split = splitTierModel(tierModel);
  if (!split) return caps; // malformed: modelSelectionFor refuses it by name
  const instanceId = split.providerInstanceId ?? project.defaultModelSelection?.instanceId;
  const model = split.model;
  if (!instanceId) return caps;
  const instance = caps.providers.find((p) => p.providerInstanceId === instanceId);
  if (!instance || (instance.constraints ?? []).length > 0 || (instance.models ?? []).some((m) => m.id === model)) return caps;
  const found = (await seam.capabilities(model)).providers.find((p) => p.providerInstanceId === instanceId)?.models.filter((m) => m.id === model) ?? [];
  if (found.length === 0) return caps;
  return { ...caps, providers: caps.providers.map((p) => (p === instance ? { ...p, models: [...p.models, ...found] } : p)) };
}

/** A refusal before anything is launched: `reason` says what, `remedy` what to do. Each caller words its own ending. */
interface LaunchRefusal {
  reason: string;
  remedy: string;
}

/**
 * The model a builder at score `complexity` launches on (the band covering it, OS-177) and the effort it runs at (OB-1815), resolved in one place so a launch and
 * the pre-enqueue check of `--effort` cannot disagree. A refusal is returned, never thrown, because the
 * launch ends it with "re-run the drain" and the pre-enqueue check with "nothing was queued".
 */
export async function resolveModelAndEffort(
  seam: T3Seam,
  project: T3Project,
  complexity: number,
  models: BuilderModels,
  requested: SpinoffEffort | undefined,
  /** OS-132: the `--model` the row asked for, already in `models`; a refusal then points at the flag, not the profile. */
  asked?: string | null,
): Promise<{ model: ModelResolution & { selection: T3ModelSelection }; effort: EffortResolution } | { refusal: LaunchRefusal }> {
  const bandModel = modelForComplexity(models, complexity);
  const caps = await capabilitiesWithModel(seam, project, bandModel);
  const model = modelSelectionFor(project, caps, bandModel, asked ? "--model" : undefined);
  if (!model.selection) {
    // Two different remedies: a band model T3 cannot serve is ob's config; everything else is the T3 project's.
    const remedy = model.tierConfig && asked
      ? `re-dispatch with a --model T3 lists for this project (\`<provider>:<model>\`, as \`ob models show\` names them), or without --model`
      : model.tierConfig
      ? `set ${rangeRoute(bandFor(models, complexity))}, the builder range covering ${complexity}, to a model T3 lists (\`ob models show\`, \`ob models set ${rangeRoute(bandFor(models, complexity))} <model>\`, \`ob models use <profile>\`; an older spinoff_tier_models setting also feeds the 1-3, 4-6 and 7-10 bands), or re-dispatch with another --complexity`
      : `set ${project.title}'s default model in T3 Code (Project settings → model)`;
    return { refusal: { reason: `${model.error ?? "no model resolved"} (complexity ${complexity})`, remedy } };
  }
  const instance = caps.providers.find((p) => p.providerInstanceId === model.selection!.instanceId);
  const listed = (instance?.models ?? []).find((m) => m.id === model.selection!.model);
  const effort = effortFor(listed, model.selection.model, requested);
  if (!effort.resolution) {
    return { refusal: { reason: `${effort.error} (complexity ${complexity})`, remedy: "re-dispatch with a level the model lists, or without --effort" } };
  }
  return { model: { ...model, selection: model.selection }, effort: effort.resolution };
}

/** The levels above Opus's default that only the owner's explicit ask may dispatch it at (OB-2107). */
export const OPUS_HIGH_EFFORTS: readonly SpinoffEffort[] = ["high", "xhigh", "max"];

/**
 * Why a dispatch of an Opus model at `high` or above is refused (OB-2107: Opus runs on high only
 * when the owner explicitly asks for it), or null when it may go. `model` is the band's model as
 * configured (bare or `<provider>:<model>`); `ask` is the `--opus-high` quote of his ask. Pure.
 */
export function opusHighRefusal(model: string, complexity: number, effort: SpinoffEffort | undefined, ask: string | undefined): string | null {
  if (effort === undefined || !OPUS_HIGH_EFFORTS.includes(effort)) return null;
  const id = splitTierModel(model)?.model ?? model;
  if (!/opus/i.test(id)) return null;
  if (ask !== undefined && ask.trim() !== "") return null;
  return (
    `not dispatched: complexity ${complexity} runs ${id}, and Opus runs above its default effort (--effort ${effort}) only when the owner explicitly asks for it. ` +
    `Re-dispatch without --effort, or pass --opus-high '<his ask, quoted>' to record that he asked. Nothing was queued.`
  );
}

/**
 * The launch-time half (OB-2107): the urgent rule raised the row's score AFTER it was queued (OB-2075, OS-177), so
 * the effort it was queued at was checked against another band's model. Opus above its default is refused here,
 * never launched, because his ask (if any) was not for this model. Throws a T3 refusal; no-op otherwise.
 */
export function refuseRaisedOpusHigh(
  row: { ticket_ref: string; tier: string | null; complexity?: number | null; effort: string | null; model_ask?: string | null },
  models: BuilderModels,
  raisedFrom: number | null,
): void {
  if (raisedFrom === null) return;
  // OS-132: an explicit --model is what launches, raised or not, and it was checked against the ask at dispatch.
  if (row.model_ask) return;
  const c = rowComplexity(row);
  const bandModel = modelForComplexity(models, c);
  if (!opusHighRefusal(bandModel, c, rowEffort(row.effort), undefined)) return;
  const id = splitTierModel(bandModel)?.model ?? bandModel;
  throw new T3Error(
    "refused",
    `${row.ticket_ref} is urgent, so it launches at complexity ${c} (${id}) instead of ${raisedFrom}, and it was queued at --effort ${row.effort}: Opus runs above its default only when the owner explicitly asks. Re-dispatch without --effort, or with --opus-high '<his ask, quoted>'`,
    `re-dispatch without --effort, or with --opus-high '<his ask, quoted>'`,
  );
}

/** Throw the Opus-high refusal for score `complexity` (OB-2107), or return. Pure; the `queue` half of a dispatch runs only this. */
export function refuseOpusHigh(models: BuilderModels, complexity: number, effort: SpinoffEffort | undefined, ask: string | undefined): void {
  const refusal = opusHighRefusal(modelForComplexity(models, complexity), complexity, effort, ask);
  if (refusal) throw new UsageError(refusal);
}

/**
 * A model trial's legs carry their own model and effort (OB-1991), so a leg on Opus at `high` or above needs his
 * ask like any dispatch (OB-2107). Checked on the plan, before a pair opens or a leg is queued. Returns the plan.
 */
export function refuseOpusHighTrial<P extends { a: { model: string; effort: string | null }; b: { model: string; effort: string | null } }>(plan: P | null, complexity: number, ask: string | undefined): P | null {
  if (!plan) return plan;
  for (const leg of [plan.a, plan.b]) {
    const effort = leg.effort !== null && isSpinoffEffort(leg.effort) ? leg.effort : undefined;
    const refusal = opusHighRefusal(leg.model, complexity, effort, ask);
    if (refusal) throw new UsageError(`${refusal.replace(/^not dispatched: /, `not dispatched: the active model trial runs a leg on ${leg.model}#${leg.effort}; `)}`);
  }
  return plan;
}

const OPUS_HIGH_NOTE = `opus-high on the owner's ask: "`;

/** The `--opus-high` quote a dispatch note carries (`withOpusHighNote`'s head), or undefined. Pure. */
export function opusHighAskOf(note: string | null | undefined): string | undefined {
  if (!note?.startsWith(OPUS_HIGH_NOTE)) return undefined;
  const end = note.indexOf('"', OPUS_HIGH_NOTE.length);
  const quote = end < 0 ? "" : note.slice(OPUS_HIGH_NOTE.length, end).trim();
  return quote === "" ? undefined : quote;
}

/** The dispatch's trail note with the `--opus-high` quote in front (OB-2107), or the note as it was. Pure. */
export function withOpusHighNote<N extends string | null | undefined>(note: N, ask: string | undefined): N | string {
  const quote = ask?.trim();
  if (!quote) return note;
  const head = `${OPUS_HIGH_NOTE}${quote}"`;
  return note?.trim() ? `${head}; ${note}` : head;
}

/**
 * Refuse a `--effort` the band's model cannot take, or a `--model` T3 cannot serve (OS-132), BEFORE the row is
 * queued (OB-1815): the launch resolves the model after the enqueue, which is too late to leave no pending row.
 * Runs on the machine with T3, only when `--effort` or `--model` is named, and throws a refusal that says
 * nothing was queued. A `--model` replaces the band's model for this check exactly as it does at launch.
 */
export async function refuseUnusableEffort(
  seam: T3Seam,
  repoPath: string,
  complexity: number,
  bandModels: BuilderModels,
  effort: SpinoffEffort | undefined,
  opusHighAsk?: string,
  model?: string,
): Promise<void> {
  const models = model ? withModelAt(bandModels, complexity, model) : bandModels;
  // OB-2107: Opus above its default needs his ask, checked before T3 is asked anything.
  refuseOpusHigh(models, complexity, effort, opusHighAsk);
  const project = await refuseUnregisteredT3Project(seam, repoPath);
  const resolved = await resolveModelAndEffort(seam, project, complexity, models, effort, model ?? null);
  if ("refusal" in resolved) {
    throw new UsageError(`not dispatched: ${resolved.refusal.reason} — ${resolved.refusal.remedy}. Nothing was queued.`);
  }
}

/**
 * OB-2130: a launching dispatch is refused here, before the row and the worktree exist, when no T3 project is
 * registered for its checkout. The launch would refuse it anyway (`launchT3Spinoff`), but only after both were
 * made, which left a failed row and an empty worktree behind. Answers the project, for a caller that needs it.
 */
export async function refuseUnregisteredT3Project(seam: T3Seam, repoPath: string): Promise<T3Project> {
  const project = t3ProjectFor(await seam.projects(), repoPath);
  if (project) return project;
  throw new UsageError(`not dispatched: no T3 project is registered for ${repoPath} (\`t3 project add ${repoPath}\`). Nothing was queued.`);
}

/** The launch request ob sends for one spinoff row. Pure — every input is already resolved. */
export function spinoffLaunchPlan(input: {
  row: T3DispatchRow;
  projectId: string;
  model: T3ModelSelection;
  /** The `options` a named effort sends (OB-1815): `[{id:"effort",value:"high"}]`. Absent sends none. */
  options?: Array<{ id: string; value: string }> | undefined;
  runtimeMode: string;
  /** The ticket's own ob title, read once at launch (1143). Absent/null falls back inside the title builder. */
  ticketTitle?: string | null | undefined;
}): T3LaunchInput {
  const { row } = input;
  return {
    projectId: input.projectId,
    title: builderThreadTitle(row.ticket_ref, row.branch, input.ticketTitle),
    message: row.brief,
    modelSelection: {
      instanceId: input.model.instanceId,
      model: input.model.model,
      ...(input.options && input.options.length > 0 ? { options: input.options } : {}),
    },
    runtimeMode: input.runtimeMode,
    // T3 binds the worktree ob made; ob never asks T3 to create one (map decision #4).
    workspaceStrategy: { type: "existing_worktree", worktreePath: row.worktree, branch: row.branch },
    clientRequestId: clientRequestIdFor(row.id),
  };
}

/**
 * Launch one spinoff row as a T3 thread, or adopt the thread a previous attempt already opened.
 *
 * Order matters: resolve everything that can refuse (project, model) BEFORE the adoption scan, so a
 * misconfigured machine fails without touching T3's thread list.
 *
 * `ticketTitle` is the row's ticket's own ob title (1143), read by the caller where the store (or the
 * wire) is already at hand. It only ever LABELS the new thread — a launch that has none is titled from
 * the branch, as before — so it is optional and is never consulted for adoption (the worktree is the
 * identity).
 *
 * `tierModels` is the builder bands (OS-177; the old tier → model map still reads as the tier bands), read by
 * the caller where config is at hand. The row's score picks the band's model; the project picks the provider.
 *
 * `keepThreadModel` (OB-2075): the score was RAISED by the urgent rule, not asked for by a human, so a thread
 * the worktree already has is adopted on whatever model it runs instead of being refused as a re-dispatch at
 * another tier.
 */
export async function launchT3Spinoff(
  seam: T3Seam,
  row: T3DispatchRow,
  repoPath: string,
  ticketTitle?: string | null,
  tierModels: BuilderModels = DEFAULT_TIER_MODELS,
  keepThreadModel = false,
): Promise<T3LaunchOutcome> {
  const complexity = rowComplexity(row);
  const project = t3ProjectFor(await seam.projects(), repoPath);
  if (!project) {
    throw new T3Error(
      "refused",
      `no T3 project is registered for ${repoPath} — register the checkout as a T3 project (\`t3 project add ${repoPath}\`), then re-run the drain`,
      `register the checkout as a T3 project (\`t3 project add ${repoPath}\`)`,
    );
  }
  // OB-1991: a trial leg launches on the trial's model for its leg, whatever the band (or a profile) says.
  // OS-132: a row that named --model launches on it the same way, for this row only; the profile is untouched.
  const asked = row.model_ask ?? null;
  const override = row.trial_model ?? asked;
  const models = override ? withModelAt(tierModels, complexity, override) : tierModels;
  const own = rowEffort(row.effort);
  // OS-132: a route's effort was set for the band's model, so a --model row with no --effort runs at its model's default.
  const routeEffort = own === undefined && !asked && row.route_effort && isSpinoffEffort(row.route_effort) ? row.route_effort : undefined;
  let resolved = await resolveModelAndEffort(seam, project, complexity, models, own ?? routeEffort, asked);
  if ("refusal" in resolved && routeEffort !== undefined) {
    // OS-145: the route's effort is a preference across its chain; a model that does not take it runs at its default.
    const plain = await resolveModelAndEffort(seam, project, complexity, models, undefined, asked);
    if (!("refusal" in plain)) {
      warn(`  ↳ ${row.ticket_ref}: ${modelForComplexity(models, complexity)} does not take the route's effort ${routeEffort}; it runs at its default`);
      resolved = plain;
    }
  }
  if ("refusal" in resolved) {
    throw new T3Error(
      "refused",
      `${resolved.refusal.reason} — ${resolved.refusal.remedy}, then re-run the drain`,
      resolved.refusal.remedy,
    );
  }
  const { model } = resolved;
  const effort = own === undefined && resolved.effort.options ? { ...resolved.effort, stamp: `route (${resolved.effort.stamp})` } : resolved.effort;

  const existing = await findThreadForWorktree(seam, project.id, row);
  const stamp = model.stamp ?? model.selection.model;
  const providerDiffers = !!existing?.providerInstanceId && existing.providerInstanceId !== model.selection.instanceId;
  if (existing && !keepThreadModel && ((existing.model && existing.model !== model.selection.model) || providerDiffers)) {
    // A RE-DISPATCH AT ANOTHER TIER (1480): the worktree already has an unsettled thread on a different
    // model — typically a Haiku build that stalled, relaunched with --tier medium|complex. Adopting it
    // would silently keep the old model; opening a second would put two agents in one checkout. Neither:
    // say which thread is in the way and let the human settle it.
    const onModel = providerDiffers ? `${existing.providerInstanceId}:${existing.model}` : existing.model;
    throw new T3Error(
      "refused",
      `${row.worktree} already has T3 thread ${existing.threadId} on ${onModel}, and this row asks for complexity ${complexity} (${stamp}) — settle that thread in T3 Code first, then re-run the drain`,
      `settle T3 thread ${existing.threadId}, then re-run the drain`,
    );
  }
  if (existing) {
    // ADOPTED: a previous drain opened this thread and died before the stamp (or a human opened one on
    // the same worktree). The row records what already exists; nothing new is created.
    warn(`  ↳ ${row.ticket_ref} already has a T3 thread on ${row.worktree} — adopting ${existing.threadId}`);
    if (rowEffort(row.effort) !== undefined) warn(`  ↳ --effort ${row.effort} cannot be confirmed: T3 does not report the effort an adopted thread was opened with`);
    return {
      threadId: existing.threadId,
      runId: existing.activeRunId ?? existing.latestRunId,
      adopted: true,
      model: existing.model ? (model.stamp ? `${existing.providerInstanceId}:${existing.model}` : existing.model) : stamp,
      // The adopted thread runs at its own effort, whatever the row asked for: say so rather than stamp a level it never got.
      effort: "default (adopted thread's own)",
    };
  }

  const plan = spinoffLaunchPlan({
    row,
    projectId: project.id,
    model: model.selection,
    options: effort.options,
    runtimeMode: runtimeModeForTicket(repoPath, row.ticket_ref),
    ticketTitle: ticketTitle ?? null,
  });
  let result: { threadId: string; runId?: string | null };
  try {
    result = await seam.launch(plan);
  } catch (err) {
    // OS-203: a launch that timed out may still have opened the thread (T3 slow, not down). Look once
    // more by worktree before calling it failed: a found thread is this launch's, and stamping the row
    // failed would orphan a running builder and let the next drain open a second one in the same checkout.
    if (!isT3Timeout(err)) throw err;
    const opened = await findThreadForWorktree(seam, project.id, row).catch(() => null);
    if (!opened) throw err;
    warn(`  ↳ ${row.ticket_ref}: ${err.message}, but the thread opened; stamping ${opened.threadId}`);
    return { threadId: opened.threadId, runId: opened.activeRunId ?? opened.latestRunId, adopted: false, model: stamp, effort: effort.stamp };
  }
  return { threadId: result.threadId, runId: result.runId ?? null, adopted: false, model: stamp, effort: effort.stamp };
}

// ---------------------------------------------------------------------------
// Team threads (OB-2255): one per role per team, tracked by thread id
// ---------------------------------------------------------------------------

export interface TeamThreadOutcome {
  team: string;
  role: TeamRole;
  agentId: string;
  /** The title ob gives the thread, for the link a human is handed. */
  title: string;
  threadId: string;
  /** true when this call opened the thread; false when a live one already existed or was adopted. */
  created: boolean;
  /** true when this call adopted `--thread`. */
  adopted: boolean;
  message: string;
  /** true when T3's own read shows auto-settle off for this thread (OB-1845). */
  autoSettleOff: boolean;
  /** Why it is not off, naming the thread and the manual fix. The title stands either way. */
  autoSettleWarning: string | null;
}

/**
 * A team thread is a long-lived seat, so T3's inactivity sweep must not settle it (OB-1845). Builders keep the
 * sweep as their backstop. A failure here is reported, never thrown: the title already stands.
 */
export async function teamAutoSettleOff(seam: T3Seam, threadId: string): Promise<Pick<TeamThreadOutcome, "autoSettleOff" | "autoSettleWarning">> {
  try {
    await seam.disableAutoSettle(threadId);
    return { autoSettleOff: true, autoSettleWarning: null };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      autoSettleOff: false,
      autoSettleWarning: `t3: auto-settle is still ON for team thread ${threadId}: ${reason}. Fix it by hand: right-click the thread in T3 Code's sidebar, Auto-settle behavior, Disabled.`,
    };
  }
}

/**
 * One agent-registry row, read and written. A seam because the two ways in are genuinely different
 * machines — the store (this machine has the database) and the API (this machine is a client and the row
 * is behind an endpoint) — while the DECISIONS above it (is the thread live? create or refuse? what does
 * the run state mean?) are one procedure, reached both ways. Same shape as `SpinoffLaunchConfig`.
 *
 * Both users are here: `ob t3 architect|sentinel|muse` (the row holds the team thread id) and the run-state mirror
 * (the row holds the builder's run state).
 */
export interface AgentRegistry {
  read(id: string): Promise<{ session_id: string | null; launcher: string | null; status: string | null; run: string | null } | null>;
  register(input: {
    id: string;
    ticket?: string | null;
    worktree: string;
    branch?: string | null;
    /** ob's workflow word. Omitted/null preserves the stored one (the mirror never passes it, 1189). */
    status?: string | null;
    /** T3's run word (1189). The mirror no longer writes here: it uses `setRun` (OB-1923). */
    run?: string | null;
    launcher: string;
    /** Absent/null writes no id: the creation marker is announced before T3 has answered with a thread id. */
    sessionId?: string | null;
    ttlS: number;
  }): Promise<void>;
  /**
   * Write T3's run word onto an EXISTING agent row; never inserts (OB-1923). False when there is no row.
   * Refreshes `heartbeat_at` only while the run is active, so a finished builder's row ages out.
   */
  setRun(id: string, run: string): Promise<boolean>;
}

/** The store-backed registry: the same reads and writes `ob agent register` makes. */
export function storeAgentRegistry(db: Database | Store): AgentRegistry {
  return {
    read: async (id) => {
      const row = await getAgent(db, id);
      return row ? { session_id: row.session_id, launcher: row.launcher, status: row.status, run: row.run } : null;
    },
    register: async (input) => {
      await registerAgent(db, {
        id: input.id,
        ticket: input.ticket ?? null,
        worktree: input.worktree,
        branch: input.branch ?? null,
        status: input.status ?? null,
        run: input.run ?? null,
        launcher: input.launcher,
        sessionId: input.sessionId ?? null,
        ttlS: input.ttlS,
      });
    },
    setRun: (id, run) => setAgentRun(db, id, run),
  };
}

/**
 * Open or adopt a team's role thread, idempotently (OB-2255; the procedure of the per-project thread before teams, 1120/1414,
 * applied to a team role).
 *
 * The thread id is the ONLY identity: it lives on the role's agent row (`<role>-<team>`) in `session_id`, and
 * this never looks a thread up by title. A live recorded thread is kept (retitled, pinned, auto-settle off) and
 * never opened twice; a settled, archived or deleted one is replaced. `adoptThreadId` (`--thread`) adopts that
 * live thread instead, refused when it is not live or when a different live thread is already recorded. Every
 * call pins the thread (every team thread is pinned). A NEW thread opens in `repoPath`'s
 * T3 project on the active models profile's `builder.complex` model (falling back to the project's
 * default model when no usable profile is configured), seeded once with the role's skill; an adopted
 * one is never seeded.
 */
export async function ensureTeamThread(
  registry: AgentRegistry,
  input: {
    team: Pick<Team, "name" | "icon" | "display_name">;
    role: TeamRole;
    /** The team's member project ids, for the seed's orientation line. */
    members: readonly string[];
    /** The checkout a new thread opens in (the cwd's repo), and the row's worktree. */
    repoPath: string;
    adoptThreadId?: string;
    seam?: T3Seam;
    /** The first message a NEW thread gets in place of `teamSeedMessage` (`ob t3 team restart`'s handoff seed, OB-2257). */
    seedMessage?: string;
    /**
     * OS-145: the model a NEW thread opens on, route `role.<role>` (`teamRoleModel`). Absent opens on the T3
     * project's default model, which is what a route nobody set means for a team thread.
     */
    roleModel?: string;
    /**
     * OS-212: the recorded thread a restart is replacing. It is still live (it is retired only once its replacement
     * holds the seat), so it is not read as the role's live thread: a new one opens and takes the row.
     */
    replacing?: string;
  },
): Promise<TeamThreadOutcome> {
  const seam = input.seam ?? (await t3Seam());
  const { team, role } = input;
  const agentId = teamRoleAgentId(team.name, role);
  const title = teamThreadTitle(team, role);
  const base = { team: team.name, role, agentId, title };
  const existing = await registry.read(agentId);

  // A row that says `t3` and holds NO thread id is a creation that did not finish: the thread was asked for and
  // the id never came back. It REFUSES rather than launching a second thread (the orphan is in T3 with nothing
  // in ob pointing at it), and names the clear.
  if (existing && existing.launcher === T3_LAUNCHER && !existing.session_id) {
    throw new T3Error(
      "refused",
      `a ${team.name} ${role} thread was being created and never recorded its id; look for a '${title}' thread in T3, settle it if it is an orphan, then clear this row (\`ob agent done ${agentId}\`) and re-run`,
      `settle the orphan in T3 and clear the row with \`ob agent done ${agentId}\``,
    );
  }

  const recorded = existing?.session_id && existing.launcher === T3_LAUNCHER ? existing.session_id : null;
  const adopt = input.adoptThreadId && input.adoptThreadId !== recorded ? input.adoptThreadId : null;
  let live: T3Thread | null = null;
  if (adopt) {
    const other = recorded ? await readTeamThread(seam, recorded) : null;
    if (other) {
      throw new T3Error(
        "refused",
        `${agentId} is already live in thread ${other.threadId} ('${other.title}'); settle that thread in T3 or drop the role first, then re-run`,
        `settle the other thread or drop the role`,
      );
    }
    live = await readThreadHeader(seam, adopt).then(
      (t) => (t.settled || t.archived ? null : t),
      (err) => {
        if (err instanceof T3Error && err.kind === "refused") return null;
        throw err;
      },
    );
    if (!live) {
      throw new T3Error("refused", `thread ${adopt} is not a live T3 thread (settled, archived or unknown), so it cannot be the ${team.name} ${role}`, "pass the id of a live thread");
    }
    await registry.register({ id: agentId, worktree: input.repoPath, status: "planning", launcher: T3_LAUNCHER, sessionId: live.threadId, ttlS: T3_AGENT_TTL_S });
  } else if (input.adoptThreadId && recorded) {
    // `--thread` naming the thread already recorded: a re-run, idempotent. Read it as an adopt would.
    live = await readTeamThread(seam, recorded);
    if (!live) {
      throw new T3Error("refused", `thread ${recorded} is not a live T3 thread (settled, archived or unknown), so it cannot be the ${team.name} ${role}`, "pass the id of a live thread");
    }
  } else if (recorded && recorded !== input.replacing) {
    live = await readTeamThread(seam, recorded);
  }

  if (live) {
    const retitled = live.title !== title;
    if (retitled) await seam.rename(live.threadId, title);
    await seam.pin(live.threadId);
    const what = [`${live.status}`, ...(retitled ? [`retitled '${title}'`] : []), "pinned"].join(", ");
    return {
      ...base,
      threadId: live.threadId,
      created: false,
      adopted: adopt !== null,
      ...(await teamAutoSettleOff(seam, live.threadId)),
      message: adopt
        ? `${team.name} ${role} adopted: ${agentId} → ${live.threadId} (${what}); nothing created`
        : `${team.name} ${role} already live: ${agentId} → ${live.threadId} (${what}); nothing created`,
    };
  }

  const project = t3ProjectFor(await seam.projects(), input.repoPath);
  if (!project) {
    throw new T3Error(
      "refused",
      `no T3 project is registered for ${input.repoPath}; register the checkout as a T3 project (\`t3 project add ${input.repoPath}\`)`,
      `register the checkout as a T3 project`,
    );
  }
  const tierModel = input.roleModel;
  const caps = tierModel ? await capabilitiesWithModel(seam, project, tierModel) : await seam.capabilities();
  const model = modelSelectionFor(project, caps, tierModel);
  if (!model.selection) {
    const remedy = model.tierConfig
      ? `set role.${role} (${tierModel}) to a model T3 lists (\`ob models set role.${role} <model>\`)`
      : `set ${project.title}'s default model in T3 Code (Project settings, model)`;
    throw new T3Error("refused", `${model.error ?? "no model resolved"}; ${remedy}`, remedy);
  }

  // THE MARKER, before anything is created: the row records that a launch was asked for (launcher `t3`, no
  // thread id yet), which is what the refusal above reads.
  await registry.register({ id: agentId, worktree: input.repoPath, status: "planning", launcher: T3_LAUNCHER, ttlS: T3_AGENT_TTL_S });

  const launched = await seam.launch({
    projectId: project.id,
    title,
    message: input.seedMessage ?? teamSeedMessage(team.name, role, input.members, input.repoPath),
    modelSelection: { instanceId: model.selection.instanceId, model: model.selection.model },
    runtimeMode: T3_DEFAULT_RUNTIME_MODE,
    workspaceStrategy: { type: "root" },
    clientRequestId: teamRequestIdFor(agentId, teamNonce(recorded)),
  });
  // OB-2128: T3 answers a launch it has seen before with the thread it made then. The recorded thread, or one
  // that reads settled or archived, is an OLD thread and is never reported as a creation.
  const restore = () =>
    registry.register({ id: agentId, worktree: input.repoPath, status: "planning", launcher: T3_LAUNCHER, sessionId: launched.threadId, ttlS: T3_AGENT_TTL_S });
  let old = launched.threadId === recorded;
  if (!old) {
    try {
      const back = await readThreadHeader(seam, launched.threadId);
      old = back.settled || back.archived;
    } catch (err) {
      await restore();
      throw err;
    }
  }
  const rerun = `ob t3 ${role} ${team.name}`;
  if (old) {
    await restore();
    throw new T3Error(
      "refused",
      `T3 handed back an old thread (${launched.threadId}) instead of opening a new ${team.name} ${role} thread, so nothing was created; re-run \`${rerun}\``,
      `re-run \`${rerun}\``,
    );
  }
  const readState = launched.status && isT3ThreadStatus(launched.status) ? launched.status : "idle";
  await restore();
  await seam.pin(launched.threadId);
  return {
    ...base,
    threadId: launched.threadId,
    created: true,
    adopted: false,
    ...(await teamAutoSettleOff(seam, launched.threadId)),
    message: `${team.name} ${role} created: ${agentId} → ${launched.threadId} (${readState}, pinned); steer it in T3 Code`,
  };
}

/**
 * The team thread a recorded id points at, when it is still LIVE (not settled, not archived). A thread T3 no
 * longer knows (T3 refusing the read, whatever its wording) is null, which lets the caller replace it; any
 * OTHER failure (an unreachable server, a rejected credential) is rethrown unchanged.
 */
export async function readTeamThread(seam: T3Seam, threadId: string): Promise<T3Thread | null> {
  try {
    const thread = await readThreadHeader(seam, threadId);
    return thread.settled || thread.archived ? null : thread;
  } catch (err) {
    if (err instanceof T3Error && err.kind === "refused") {
      warn(`t3: the recorded team thread ${threadId} is no longer available to T3 (${err.message})`);
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The run-state mirror — T3's vocabulary onto the agent row
// ---------------------------------------------------------------------------

/**
 * The agent row's `run` value for a thread, in T3's own words — or null when the status is one this build
 * does not know (a NEWER T3), in which case the caller reports it and writes nothing rather than inventing
 * a word for it.
 *
 * `pendingRequestCount > 0` reads as `waiting`: the run is parked on the human, which is exactly what
 * T3's own `waiting` means, and it is the one state a stale `running` would otherwise hide.
 */
export function t3RunStatus(thread: { status: string; pendingRequestCount?: number | undefined }): string | null {
  if (!isT3ThreadStatus(thread.status)) return null;
  if ((thread.pendingRequestCount ?? 0) > 0) return "waiting";
  return thread.status;
}

export interface T3MirrorEntry {
  ticket: string;
  threadId: string;
  status: string;
}
export interface T3MirrorSkip {
  ticket: string;
  reason: string;
}
export interface T3MirrorResult {
  mirrored: T3MirrorEntry[];
  skipped: T3MirrorSkip[];
}

/**
 * Put the needs-you marker on a builder thread's title, or take it off, to match the status the agent just
 * registered (1579). Reads the title the thread wears NOW (T3 or the owner may have renamed it) and renames
 * only when the marker state differs. BEST EFFORT: a title is a label, so an unreachable T3 returns the
 * reason instead of failing the register that triggered it.
 */
export async function syncNeedsYouTitle(
  threadId: string,
  status: string,
  seam?: T3Seam,
): Promise<TitleSync> {
  return syncThreadTitle(threadId, (t) => titleWithNeedsYou(t, status), seam);
}

/** What a best-effort title sync did: whether it renamed, the title it left, or the reason it could not. */
export interface TitleSync {
  renamed: boolean;
  title: string | null;
  error: string | null;
}

/**
 * Read the title a thread wears now (T3 or the owner may have renamed it), apply `retitle`, and rename only when
 * that changes it. Never throws: an unreachable T3 returns the reason.
 */
async function syncThreadTitle(threadId: string, retitle: (title: string) => string, seam?: T3Seam): Promise<TitleSync> {
  try {
    const client = seam ?? (await t3Seam());
    const current = (await readThreadHeader(client, threadId)).title ?? "";
    const wanted = retitle(current);
    if (!current || wanted === current) return { renamed: false, title: current || null, error: null };
    await client.rename(threadId, wanted);
    return { renamed: true, title: wanted, error: null };
  } catch (err) {
    return { renamed: false, title: null, error: (err as Error).message };
  }
}

/** How many renames one lease-marker sync may make before it gives up on a racing writer (OB-2169). */
const LEASE_SYNC_TRIES = 3;

/**
 * Set or clear ONE resource's lease marker on a thread's title (OB-2153, OB-2169). Best effort like
 * `syncNeedsYouTitle`, so a T3 failure never touches the lease.
 *
 * One thread can retitle from two processes at once (a `lease run` whose command runs another, or two shells), and
 * T3 has no compare-and-set rename, so a rename can carry a title read before the other's change and drop its
 * marker. So this re-reads after each rename and, while its own marker is not as it wanted (the other writer's
 * rename dropped or reverted it), applies its change to the fresh title and renames again: up to 3 renames, inside
 * the caller's 5 s bound. It only ever re-applies its own change, so a marker another run cleared is never put
 * back. A dropped marker is restored only when its writer re-reads after the stale rename that dropped it: a stale
 * rename that lands after the other writer's last re-read still wins, and without compare-and-set nothing here can
 * see it. Still losing after 3 renames is reported as an error, never thrown.
 */
export async function syncLeaseTitle(
  threadId: string,
  resource: string,
  state: LeaseMarkerState | null,
  seam?: T3Seam,
): Promise<TitleSync> {
  try {
    const client = seam ?? (await t3Seam());
    const want = (t: string) => titleWithLeaseMarker(t, resource, state);
    let current = (await readThreadHeader(client, threadId)).title ?? "";
    let renamed = false;
    for (let tries = 0; ; tries++) {
      const wanted = want(current);
      if (!current || wanted === current) return { renamed, title: current || null, error: null };
      if (tries === LEASE_SYNC_TRIES) {
        return { renamed, title: current, error: `the title kept changing under ${LEASE_SYNC_TRIES} renames; gave up` };
      }
      await client.rename(threadId, wanted);
      renamed = true;
      current = (await readThreadHeader(client, threadId)).title ?? "";
    }
  } catch (err) {
    return { renamed: false, title: null, error: (err as Error).message };
  }
}

/**
 * The register-time wrapper both `ob agent register` paths (direct and API) share (1579): moves the title
 * only for a t3 row that has a thread and a status to react to, and returns the warning to print, or null.
 */
export async function titleSyncWarning(
  row: { launcher: string | null; session_id: string | null },
  status: string | null,
): Promise<string | null> {
  if (!status || row.launcher !== T3_LAUNCHER || !row.session_id) return null;
  const synced = await syncNeedsYouTitle(row.session_id, status);
  return synced.error ? `thread title not updated: ${synced.error}` : null;
}

/** The agent-row fields the architect clear reads (OB-1710): a subset of `AgentRow`, so the store and the API feed it alike. */
export interface TeamRowFacts {
  id: string;
  worktree: string | null;
  status: string | null;
  launcher: string | null;
  session_id: string | null;
  heartbeat_at: string;
  /** The row's own TTL, written back unchanged so the clear does not shorten or lengthen the architect's lease. */
  ttl_s: number;
}

/** How many of an architect thread's newest timeline items the clear reads: a few runs, plenty for one reply. */
const ARCHITECT_RECENT_ITEMS = 60;

/** A creation source that is a scheduler or a tool call, never the owner typing: those runs must not clear the mark. */
const NON_HUMAN_SOURCE = /sched|task|cron|automat|mcp|provider|system|api/i;

/**
 * Did the owner send this thread a message after `since`? Only a `user_message` item written by a `user` from a
 * human surface counts. A queued ob note (handoff/landed) and the `t3_thread_send` of a scheduled watchdog
 * arrive as `agent`/`mcp` items, and a source that names a scheduler is refused too, so the safe reading of
 * anything ambiguous is "not him" (OB-1710). Reads the newest items only; T3 lists oldest first, so the page
 * starts from `itemCount`. Pure of side effects; throws what the seam throws.
 */
export async function userMessagedSince(seam: T3Seam, threadId: string, since: string): Promise<boolean> {
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return false;
  const head = await readThreadHeader(seam, threadId);
  if (typeof head.itemCount !== "number") return false;
  const page = await seam.read(threadId, { afterPosition: Math.max(0, head.itemCount - ARCHITECT_RECENT_ITEMS), limit: ARCHITECT_RECENT_ITEMS });
  return page.items.some(
    (i) =>
      i.type === "user_message" &&
      i.createdBy === "user" &&
      !NON_HUMAN_SOURCE.test(i.creationSource ?? "") &&
      Date.parse(i.updatedAt ?? "") > sinceMs,
  );
}

export interface TeamClearResult {
  cleared: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Take an architect row off `needs-human` when the owner's next message has started a run (OB-1710). An architect
 * stamps `needs-human` before it asks him something and then has to remember `--status planning`; on
 * 2026-10-30 it did not, and `🙋` sat on the thread for hours. The mirror already visits T3 for the `run`
 * field, so this is its architect half: no new watcher.
 *
 * Team role rows only (`architect-*`, `sentinel-*`, `muse-*`, launcher t3, a thread id, OB-2255). A builder's `needs-human` waits on him across
 * turns and is changed only by the builder or its handoff. The boundary is the row's `heartbeat_at`, which the
 * architect's own `needs-human` register set: a user message newer than that is the answer to the question,
 * while the message that started the stamping run is older and never counts. The mirror writes nothing to a
 * architect row except this clear, so it does not move that boundary itself.
 *
 * The title marker comes off through `syncNeedsYouTitle` (1579), the one place that sets or removes it.
 * Reported per row, never fatal: an unreadable thread keeps the row as it was.
 */
export async function clearTeamNeedsHuman(
  rows: TeamRowFacts[],
  registry: AgentRegistry,
  seam?: T3Seam,
): Promise<TeamClearResult> {
  const out: TeamClearResult = { cleared: [], skipped: [] };
  const architects = rows.filter((r) => isTeamRoleAgent(r.id) && r.launcher === T3_LAUNCHER && r.status === "needs-human" && r.session_id);
  if (architects.length === 0) return out;
  let client: T3Seam;
  try {
    client = seam ?? (await t3Seam());
  } catch (err) {
    for (const r of architects) out.skipped.push({ id: r.id, reason: `T3 unreachable: ${(err as Error).message}` });
    return out;
  }
  for (const r of architects) {
    try {
      if (!r.worktree) {
        out.skipped.push({ id: r.id, reason: "no worktree recorded on the row" });
        continue;
      }
      if (!(await userMessagedSince(client, r.session_id!, r.heartbeat_at))) continue;
      await registry.register({ id: r.id, worktree: r.worktree, status: "planning", launcher: T3_LAUNCHER, sessionId: r.session_id, ttlS: r.ttl_s });
      const synced = await syncNeedsYouTitle(r.session_id!, "planning", client);
      if (synced.error) out.skipped.push({ id: r.id, reason: `cleared, thread title not updated: ${synced.error}` });
      out.cleared.push(r.id);
    } catch (err) {
      out.skipped.push({ id: r.id, reason: `thread ${r.session_id} unreadable: ${(err as Error).message}` });
    }
  }
  return out;
}

/** The row fields the mirror reads: which agent row, and which thread to read its state from. */
export interface T3MirrorRow {
  ticket: string;
  agentId: string;
  threadId: string;
}

/**
 * Mirror each live `t3` row's T3 run state onto its agent row. The spinoff row's own QUEUE status is never
 * touched: `launched` says "a builder is out for this ticket", which T3 has no opinion about, and only
 * ob's queue states can say it.
 *
 * `launched` and `ready-for-gate` (printed `handed-off`) rows are read; `merged`/`failed` are over. The write is
 * `setRun`, which only UPDATES an existing agent row (OB-1923): it never creates one, so a retired or deleted
 * agent stays gone (a named skip), and a handed-off builder's `run` keeps moving until the row lands. The
 * heartbeat moves only while the run is active, so a finished builder ages out on its TTL.
 *
 * A row whose thread cannot be read is REPORTED and skipped, never failed: T3 being unreachable is not a
 * reason to fail a queue row, and the row's own agent row keeps its last honest value. The seam is built
 * lazily and only when there is a row, so a machine that has never used the launcher needs no credential.
 */
export async function mirrorT3Runs(rows: T3MirrorRow[], registry: AgentRegistry, seam?: T3Seam): Promise<T3MirrorResult> {
  const mirrored: T3MirrorEntry[] = [];
  const skipped: T3MirrorSkip[] = [];
  if (rows.length === 0) return { mirrored, skipped };

  let client: T3Seam | null = seam ?? null;
  let connectError: string | null = null;
  if (!client) {
    try {
      client = await t3Seam();
    } catch (err) {
      connectError = (err as Error).message;
    }
  }
  for (const row of rows) {
    if (!client) {
      skipped.push({ ticket: row.ticket, reason: `T3 unreachable: ${connectError}` });
      continue;
    }
    let thread: T3Thread;
    try {
      thread = await readThreadHeader(client, row.threadId);
    } catch (err) {
      skipped.push({ ticket: row.ticket, reason: `thread ${row.threadId} unreadable: ${(err as Error).message}` });
      continue;
    }
    const status = t3RunStatus(thread);
    if (status === null) {
      skipped.push({ ticket: row.ticket, reason: `T3 reports unknown thread status '${thread.status}'` });
      continue;
    }
    // 1189: the RUN field, not `status`. The row's own workflow word belongs to the agent, and the mirror
    // must not touch it — that is what lets `run = failed` sit beside `status = working` and say "the run
    // died and the agent never reported back".
    let written: boolean;
    try {
      written = await registry.setRun(row.agentId, status);
    } catch (err) {
      // A refused write (an API host older than `set-run`, a store error) is reported per row, like a read
      // failure, so the rest of the sweep still runs.
      skipped.push({ ticket: row.ticket, reason: `run not written for '${row.agentId}': ${(err as Error).message}` });
      continue;
    }
    if (!written) {
      skipped.push({ ticket: row.ticket, reason: `no agent row '${row.agentId}': the mirror never creates one` });
      continue;
    }
    mirrored.push({ ticket: row.ticket, threadId: row.threadId, status });
  }
  return { mirrored, skipped };
}

/** OS-226: `endedThreadReason` for a thread T3 does not have. */
export const THREAD_GONE = "is gone from T3";

/**
 * OS-226: why a builder's thread is over, or null while it may still run. Over means T3 no longer has it
 * (`thread_not_found`), or it is archived, settled or cancelled with no run in flight. A run in flight is checked
 * first, because `settled` is organisational and a settled thread can still be running (`liveRunReason`).
 * Throws when T3 cannot say (unreachable, any other refusal), because "could not look" is not "ended".
 */
export async function endedThreadReason(seam: Pick<T3Seam, "read">, threadId: string): Promise<string | null> {
  let thread: T3Thread;
  try {
    thread = await readThreadHeader(seam, threadId);
  } catch (err) {
    if (err instanceof T3Error && err.code === "thread_not_found") return THREAD_GONE;
    throw err;
  }
  if (thread.activeRunId) return null;
  if (thread.archived) return "was archived";
  if (thread.settled) return "was settled";
  if (thread.status === "cancelled") return "was cancelled";
  return null;
}

/** The store-backed mirror: this machine's own `launched` and handed-off t3 rows, onto this machine's registry. */
export async function reconcileT3Runs(db: Database | Store, seam?: T3Seam): Promise<T3MirrorResult> {
  const s = asStore(db);
  const rows = (await s.q
    .select()
    .from(s.t.spinoff)
    .where(
      and(
        inArray(s.t.spinoff.status, ["launched", "ready-for-gate"]),
        eq(s.t.spinoff.launcher, T3_LAUNCHER),
        isNotNull(s.t.spinoff.t3_thread_id),
      ),
    )) as Array<
    T3DispatchRow & { agent_id: string | null; t3_thread_id: string | null }
  >;
  const registry = storeAgentRegistry(s);
  const mirror = await mirrorT3Runs(
    rows.map((r) => ({ ticket: r.ticket_ref, agentId: builderIdOf(r), threadId: r.t3_thread_id! })),
    registry,
    seam,
  );
  // OB-1710: the architect half. Architect rows have no spinoff row, so they are read from the registry.
  const cleared = await clearTeamNeedsHuman(await listAgents(s, { includeExpired: true }), registry, seam);
  for (const skip of cleared.skipped) mirror.skipped.push({ ticket: skip.id, reason: skip.reason });
  return mirror;
}

// ---------------------------------------------------------------------------
// Settle on close — the thread a closed ticket leaves behind
// ---------------------------------------------------------------------------

export interface T3SettleOutcome {
  ticket: string;
  threadId: string;
  settled: boolean;
  /** How many times the settle was asked for: 1 when one ask was enough (1188). */
  attempts: number;
  error: string | null;
}

/**
 * How many times `ob close` asks T3 to settle one thread before it reports the refusal (1188).
 *
 * ONE shot was not enough. T3 refuses a settle while a run is live, and the land reply's own note IS a run
 * — the very write 1133 sequenced around the settle. On the first real land (1163) the re-activated
 * builder was still working minutes later, so the single settle after a single 30s wait was refused and
 * the thread rode T3's 3-day auto-settle instead of the door this feature exists to be. The bounded retry
 * is the shape: a close gives up and says so rather than hanging on an agent.
 */
export const SETTLE_ATTEMPTS = 6;

/**
 * How long each retry waits for that live turn to end before asking again (1188). `t3_thread_wait` returns
 * as soon as the run ends, so this is a ceiling on ONE attempt, not a sleep — a builder that stops at once
 * costs nothing, and the whole close is bounded by `SETTLE_ATTEMPTS × this` (~2 minutes) in the worst case.
 */
export const SETTLE_RETRY_WAIT_MS = 20_000;

/** The outcome of asking T3 to settle ONE thread, retries included. */
export interface ThreadSettleOutcome {
  settled: boolean;
  /** 1 when the first ask was accepted; otherwise the asks made before giving up. */
  attempts: number;
  error: string | null;
}

/**
 * Settle one thread, re-asking over a bounded window while a live turn refuses it (1188).
 *
 * The retry is spaced by `t3_thread_wait` and by nothing else, because the run ENDING is the only thing
 * that can change T3's answer: there is nothing to wait *for* but that (a sleep would just re-refuse). Two
 * properties fall out of that, and both are wanted:
 *
 *   • a thread with NO run at all returns from the wait immediately, so a settle refused for any other
 *     reason (`thread_not_found`, a rejected credential, `unavailable`) costs a few fast asks and reports
 *     that reason — never a two-minute hang on a thread that is not running anything; and
 *   • a wait that cannot be performed at all (T3 unreachable, thread gone, credential refused) is where
 *     asking again would be a guess, so the loop stops there and the refusal stands.
 *
 * A caller must not read `attempts > 1` as a problem in itself: the first ask after a land note is EXPECTED
 * to be refused while that note is being read.
 */
export async function settleThreadWithRetry(
  client: T3Seam,
  threadId: string,
  opts: { attempts?: number; waitMs?: number } = {},
): Promise<ThreadSettleOutcome> {
  const attempts = opts.attempts ?? SETTLE_ATTEMPTS;
  const waitMs = opts.waitMs ?? SETTLE_RETRY_WAIT_MS;
  let asked = 0;
  let error: string | null = null;
  while (asked < attempts) {
    asked++;
    try {
      await client.settle(threadId);
      return { settled: true, attempts: asked, error: null };
    } catch (err) {
      error = (err as Error).message;
      if (asked >= attempts) break;
      try {
        await client.wait(threadId, waitMs);
      } catch {
        break;
      }
    }
  }
  return { settled: false, attempts: asked, error };
}

/**
 * Stop an abandoned builder's thread (1697): interrupt its turn, then settle it. The interrupt is best
 * effort and its failure is reported, not fatal, because a thread with no turn in flight has nothing to
 * interrupt; the SETTLE is the verdict (a live turn refuses it, so a settle that stands means the thread
 * is stopped). Settling retries on the same bounded window `ob close` uses, spaced by the run ending.
 */
export async function stopThreadOverT3(threadId: string, seam?: T3Seam): Promise<{ interrupted: boolean; settled: boolean; error: string | null }> {
  try {
    const client = seam ?? (await t3Seam());
    let interrupted = true;
    try {
      await client.interrupt(threadId);
    } catch {
      interrupted = false;
    }
    const out = await settleThreadWithRetry(client, threadId);
    return { interrupted, settled: out.settled, error: out.error };
  } catch (e) {
    return { interrupted: false, settled: false, error: (e as Error).message };
  }
}

/** One line per settle outcome, for the close's report. Pure, and shared by both close paths (1188). */
export function renderSettleOutcome(outcome: T3SettleOutcome): { line: string; warning: boolean } {
  if (outcome.settled) {
    return { line: `  t3 thread ${outcome.threadId} settled`, warning: false };
  }
  // The attempt count is in the line on purpose: a warning that took two minutes to earn must not read
  // like the one-shot refusal it replaces. One ask keeps the old sentence, byte for byte.
  const tried = outcome.attempts > 1 ? ` after ${outcome.attempts} attempts` : "";
  return {
    line: `t3: ${outcome.ticket} closed, but thread ${outcome.threadId} was NOT settled${tried}: ${outcome.error} (it auto-settles in 3 days)`,
    warning: true,
  };
}

/**
 * Settle every T3 thread a ticket's spinoff rows opened, so a finished builder leaves T3's active list
 * when the ticket is closed (`ob close`). The 3-day auto-settle is the backstop; this is the door.
 *
 * THE ROWS ARE FOUND BY IDENTITY, NOT BY MATCHING TWO NAMESPACES (1163), and the identity is RESOLVED
 * here, where the store is (1226). `itemId` is the closed ITEM; a row serves it when the item its ref
 * names is that item — the row's own recorded identity (`spinoff.item_id`, stamped at dispatch), or, for
 * a row queued before 0032 recorded one, the wayfinder number it was dispatched under resolved through
 * the same path-first rule (row 591: ref "1124", item 1134). The old rule compared the closed item's id
 * to `ticket_ref` as strings, which silently matched nothing for exactly those tickets; and the first
 * version of this one let the bare id win over the path, which bound row 595 (ref "1133") to the strip's
 * mirror item 1133 and told the readying-note thread about a land that was not its own.
 *
 * BEST EFFORT BY DESIGN: the close already happened in ob and a settle is a UI-organisation write, so a
 * failure is returned for the caller to WARN about and never rolls the close back. Idempotent: settling
 * a settled thread is a no-op on T3's side, so a second close costs nothing.
 */
export async function settleT3ThreadsForTicket(
  db: Database | Store,
  itemId: string,
  seam?: T3Seam,
): Promise<T3SettleOutcome[]> {
  return settleT3ThreadsFor((await servingSpinoffRows(db, itemId)).rows, itemId, seam);
}

/**
 * The settle itself, given the rows (1226). A caller that already resolved them for the LAND REPLY hands
 * them over rather than letting this re-read: the reply and the settle are one close acting on one set of
 * rows, and a second selection is a second answer (a row stamped in between would be settled but never
 * told, or the reverse).
 */
export async function settleT3ThreadsFor(
  rows: ReadonlyArray<{ id: number; ticket_ref: string; item_id?: string | null; worktree: string; t3_thread_id: string | null }>,
  itemId: string,
  seam?: T3Seam,
): Promise<T3SettleOutcome[]> {
  const mine = rows.filter((row) => row.t3_thread_id);
  if (mine.length === 0) return [];
  const client = seam ?? (await t3Seam());
  const out: T3SettleOutcome[] = [];
  for (const row of mine) {
    const threadId = row.t3_thread_id!;
    const settled = await settleThreadWithRetry(client, threadId);
    out.push({ ticket: itemId, threadId, ...settled });
  }
  return out;
}

/**
 * The one line a close prints when it settled NOTHING for a ticket that looks dispatched (1163). The
 * silent return this replaces is why the mismatch survived its own first land: `ob close 1134` printed its
 * id and nothing else while row 591 sat there un-settled.
 *
 * Null — deliberately, and in two cases. A machine with no T3 thread anywhere has never used the launcher,
 * so a close that finds nothing has nothing to report; and a plain `ob add` ticket's ref IS its id, so its
 * record names no other ref and a miss means it was never dispatched.
 */
export function unjoinedSettleLine(itemId: string, refs: readonly string[], anyThreads: boolean): string | null {
  const named = refs.filter((ref) => ref !== itemId);
  if (!anyThreads || named.length === 0) return null;
  const looked = [`"${itemId}"`, ...named.map((ref) => `"${ref}"`)].join(" or ");
  return `t3: ${itemId} closed, but no spinoff row serves it — looked for ${looked}, settled nothing`;
}

/**
 * `unjoinedSettleLine` for a caller holding the database: reads the item's refs and whether T3 has ever
 * launched anything here.
 *
 * A read that FAILED is its own line rather than being folded into "no row serves it" (1163): the two are
 * different facts, and only one of them means there was nothing to join. Silence on a failed read would be
 * the same silent no-op this change exists to remove. The row read itself is left to throw — the caller
 * names it, because "the spinoff rows could not be read" is about a different side.
 */
export async function unjoinedSettleWarning(db: Database | Store, itemId: string): Promise<string | null> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ t3_thread_id: s.t.spinoff.t3_thread_id })
    .from(s.t.spinoff)) as Array<{ t3_thread_id: string | null }>;
  if (!rows.some((r) => r.t3_thread_id)) return null; // nothing was ever launched here: silence is the answer
  try {
    return unjoinedSettleLine(itemId, itemDispatchRefs((await getItem(db, itemId)) ?? { id: itemId }), true);
  } catch (err) {
    return `t3: ${itemId} closed, but its spinoff rows could not be joined to it: ${(err as Error).message}`;
  }
}

// ---------------------------------------------------------------------------
// The cleanup guard — a worktree whose thread is mid-run
// ---------------------------------------------------------------------------

/**
 * Why a thread makes its worktree untouchable, or null when it does not. A LIVE RUN is one in flight: an
 * active run id, or one of T3's live statuses on a thread that is neither settled nor archived.
 *
 * The active run is checked FIRST, because `settled` is an ORGANISATIONAL fact (the thread left the active
 * list), not a statement that its run ended — and `--force` overrides git state, never a builder mid-run.
 * Pure.
 */
export function liveRunReason(thread: Pick<T3Thread, "status" | "settled" | "archived" | "activeRunId">): string | null {
  if (thread.activeRunId) return `its T3 thread has a live run (${thread.status}, ${thread.activeRunId})`;
  if (thread.settled || thread.archived) return null;
  if ((T3_LIVE_STATUSES as readonly string[]).includes(thread.status)) return `its T3 thread is ${thread.status}`;
  return null;
}

/**
 * The reason `spinoff cleanup` must skip a worktree, from T3's side, or null when T3 says it is clear.
 *
 * Returns a reason for "COULD NOT TELL" too (an unreachable server, a rejected credential): unknown is
 * skip rather than remove, the same rule the in-use probe follows — deleting a worktree out from under a
 * running builder is not recoverable, and a skipped worktree is not.
 */
export async function t3WorktreeHold(
  db: Database | Store,
  worktreePath: string,
  seam?: T3Seam,
): Promise<string | null> {
  const s = asStore(db);
  const want = canonicalPath(worktreePath);
  const rows = (await s.q
    .select({ threadId: s.t.spinoff.t3_thread_id, worktree: s.t.spinoff.worktree })
    .from(s.t.spinoff)
    .where(and(eq(s.t.spinoff.launcher, T3_LAUNCHER), isNotNull(s.t.spinoff.t3_thread_id)))) as Array<{
    threadId: string | null;
    worktree: string;
  }>;
  const mine = rows.filter((r) => r.threadId && canonicalPath(r.worktree) === want).map((r) => r.threadId!);
  return t3ThreadHold(mine, seam);
}

/**
 * The guard itself, over thread ids the caller has already found: the reason one of them blocks its
 * worktree, or null when T3 says every one of them is clear.
 *
 * Takes IDS rather than a store, because the two sweeps find them differently — the store-backed one
 * queries its own rows, and the API client reads the same rows over HTTP — while the QUESTION (is a run in
 * flight?) is one implementation, reached both ways. Could-not-tell is a reason, never a silent pass.
 */
export async function t3ThreadHold(threadIds: string[], seam?: T3Seam): Promise<string | null> {
  if (threadIds.length === 0) return null;
  let client: T3Seam;
  try {
    client = seam ?? (await t3Seam());
  } catch (err) {
    return `could not ask T3 whether its thread is still running: ${(err as Error).message}`;
  }
  for (const threadId of threadIds) {
    try {
      const reason = liveRunReason(await readThreadHeader(client, threadId));
      if (reason) return reason;
    } catch (err) {
      return `could not read T3 thread ${threadId}: ${(err as Error).message}`;
    }
  }
  return null;
}

/** The guard as `cleanup` consumes it: one database + T3 probe per candidate worktree. */
export function storeT3HoldProbe(db: Database | Store): (worktreePath: string) => Promise<string | null> {
  return (worktreePath) => t3WorktreeHold(db, worktreePath);
}

// ---------------------------------------------------------------------------
// The readying note, and the land reply (1133)
//
// Two writes into threads ob did not open a run on, and neither is a gate:
//
//   * `ob spinoff handoff` tells the ARCHITECT thread that a builder is waiting for one. That handoff
//     used to be a human pasting a note, and the note carried facts no gate can see — what was proven
//     live, what land time still owes, the review result. So it is COMPOSED here, from facts ob already
//     holds, and anything ob cannot know is printed as unreported rather than filled in.
//   * `ob close` (the land) tells the BUILDER's thread the sentence it otherwise has to infer: landed in
//     <sha>, thread settled. It rides beside the settle 1120 already does.
//
// Both are notifications. The verdict stays the `State:` line in git, read by `ob spinoff gateable` and
// ob-land — nothing here parses a thread for landability (the map settled that on 2026-10-17). A send
// that fails is a loud, named warning and never a rollback of the stamp or the close.
//
// Idempotence is the `clientRequestId`, which `t3_thread_send` really does declare (unlike
// `t3_thread_launch`): the ready note's key carries the row AND the branch's head SHA (OB-1805), so a
// handoff twice on one commit sends one note while a new commit — including an amended, force-pushed one
// after a send-back — sends a second, different one. (It used to key on the `State:` line, and a send-back
// fix that kept `State: landable` sent the SAME key: T3 dropped it and still answered `queued`.)
//
// T3 DOES NOT SAY WHEN IT DEDUPLICATES (probed live 2026-11-05, OB-1805): a second `t3_thread_send` with
// the same `clientRequestId` returns the SAME `messageId`/`runId`/`status: queued`/`delivery: queued` as
// the first, with no duplicate flag. So ob can never print "told" on the strength of the answer; it says
// the note was queued, at which commit, and that one note is sent per commit.
// ---------------------------------------------------------------------------

/** Everything the readying note is composed from. Every field is a fact ob holds; none is re-typed. */
export interface ReadyNoteFacts {
  ticket: string;
  branch: string;
  worktree: string;
  /** Commits the branch has that its captured base does not; null when the row has no base. */
  commitsAhead: number | null;
  /** OS-211: the branch has no commit past main (a scan or a measurement): nothing to gate or merge. */
  nothingToMerge?: boolean;
  /** The last `State:` line on the branch, verbatim. */
  state: string | null;
  /** The builder's own latest `agent register --status readying --note` text, or null. */
  builderNote: string | null;
  /** The spinoff ROW this note announces, so the reader can re-read it in one command (1267). */
  rowId: number;
  /**
   * The row's status WHEN THE NOTE WAS COMPOSED (1267). Required, and it is `ready-for-gate` (printed `handed-off`, 1513): the announce
   * runs after the stamp, so the note states the status it announced rather than a status ob did not read.
   */
  status: string;
  /**
   * When the note was composed, ISO (1267). Named `composed` and not `queued` on purpose: ob never learns
   * T3's acceptance time (the send answers with no timestamp ob records), and the two are milliseconds
   * apart against a staleness this exists to expose in tens of minutes.
   */
  composedAt: string;
  /** The `tier-fit:` line the builder recorded on handoff (1552), from `tierFitLine`, or null when it rated none. */
  tierFit?: string | null;
  /** OB-1992: the row's repo. A clean repo's verdict is the one recorded with `ob spinoff state`, not git's. */
  repo?: string;
}

const GATE_UNREPORTED = "(unreported — the builder registered no readying note)";
const REVIEW_UNREPORTED = "(unreported — no review line in that note)";
/** What the readying note prints when the builder rated no tier (1552). Exported so the tests pin ONE wording. */
export const TIER_FIT_UNREPORTED_LINE = "tier-fit: (unreported — the builder did not rate its tier)";

/**
 * The readying note's identifying line for a ticket — its first line, and the only thing ob matches a
 * QUEUED note by when it withdraws one (1205). Composed here and used by `readyingNote` itself, so the
 * message and the matcher cannot drift apart. Pure.
 */
export function readyNoteOpening(ticket: string): string {
  return `handed off: ${ticket}`;
}

/** The first words of a spike's answered note (OB-1826); `ob close` withdraws a queued one like a readying note (1205). */
function spikeNoteOpening(ticket: string): string {
  return `spike answered: ${ticket} `;
}

/** The opening every note before 1513 carried — still matched, so `ob close` withdraws a note queued before the rename. */
function legacyReadyNoteOpening(ticket: string): string {
  return `ready for the gate: ${ticket}`;
}

/**
 * Is this held message the readying note for `ticket`? Matched on the note's FIRST line, which names the
 * ticket and nothing else, so a queued note is identified by the same fact an architect reads at the top of
 * it — never by a substring some other message could carry. Pure.
 *
 * A `truncated` message is matched rather than skipped, deliberately, and the reasoning is measured rather
 * than assumed (2026-10-18, live): `t3_queue_list` previews each item at 1,000 characters and flags the
 * cut with `truncated: true` (`t3_queue_read` returns the message itself, up to 16,000), and the cut is a
 * SUFFIX — the live preview ended mid-word, well before the end of the message. So the first line is either
 * intact (an exact match) or, if a message were cut inside it, longer than the opening (not equal, so not
 * matched). The only failure mode of a non-suffix cut would be a NOTE WE FAIL TO WITHDRAW, never a wrong
 * cancellation, because the match is exact equality and not a substring; and skipping flagged entries
 * instead would give up a real note the moment a long builder register note pushed it past the preview.
 */
export function isReadyingNoteFor(text: string, ticket: string): boolean {
  const first = (text.split("\n")[0] ?? "").trim();
  return first === readyNoteOpening(ticket) || first === legacyReadyNoteOpening(ticket) || first.startsWith(spikeNoteOpening(ticket));
}

/**
 * The review line inside a builder's readying note (`skeptical-review: 3 cut, 0 open (sonnet: 3 + deepseek: 0 + luna: 1)`), or null.
 *
 * Read out of the SAME note the gate came from rather than from a second registry field: the skill has
 * the builder report both in one register, and inventing a second channel for one line is a second thing
 * to keep in sync. The note is commonly ONE line of semicolon-separated reports, so the split is on `;`
 * as well as on newlines — otherwise the whole gate reads back as the review line. Absent is
 * `unreported`, never "0 open". Pure.
 */
export function reviewLineFrom(note: string | null): string | null {
  const parts = (note ?? "")
    .split(/[\n;]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return parts.find((l) => /(^|\s)(ob-)?(skeptical-)?review\s*:/i.test(l)) ?? null;
}

/** Continuation lines of a multi-line block, indented under their label. Pure. */
function underLabel(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? line : `${pad}${line}`))
    .join("\n");
}

/**
 * The note `ob spinoff handoff` sends to the architect. Pure, so the shape is testable without a server.
 *
 * A DATED SNAPSHOT, not an undated declaration (1267): T3 holds a queued note until the architect's turn
 * ends, and its turns are long, so a note can arrive after the work it announces has already landed —
 * and no hook exists at delivery to drop it there. The header therefore states the row, the status it
 * had AT COMPOSE TIME and the moment it was queued, and the tail names the checks that answer "is this
 * still true?".
 *
 * EACH STALE FACT IS ATTRIBUTED TO THE COMMAND THAT ACTUALLY ANSWERS IT. `ob spinoff show` prints a
 * row's PERSISTED fields — its status, and the worktree PATH, never whether that path still exists —
 * so the note does not claim it reports a missing checkout; `ob spinoff gateable` is the command that
 * does (a merged row is gone from it, and a gone checkout is marked `worktree missing`), and it is what
 * ob-land itself reads.
 */
export function readyingNote(facts: ReadyNoteFacts): string {
  const commits =
    facts.commitsAhead === null
      ? "(unreported — the row captured no base commit)"
      : `${facts.commitsAhead} ahead of the base commit`;
  const gate = facts.builderNote?.trim();
  // OS-211: a run with no commit past main has no PR: its answer is the builder's note, and closing is the land.
  const ending = facts.nothingToMerge
    ? [
        "The branch has no commit past main and no PR: nothing to gate or merge. The work is the builder's note",
        `on the ticket (\`ob show ${facts.ticket}\`). Read it, then \`ob close ${facts.ticket}\`, and remove the worktree.`,
      ]
    : [
        facts.repo !== undefined && !isObRepo(facts.repo)
          ? "The recorded state is the verdict (`ob spinoff state`), not this note; the PR carries none. The builder never merges its own PR (OB-1686, #82):"
          : "The State: line in git is the verdict, not this note. The builder never merges its own PR (OB-1686, #82):",
        "gate the PR head (plus any visual gate the repo requires), then merge it with `gh pr merge --squash",
        "--delete-branch`, run `ob deploy run --sha <merge sha>` and `ob close`.",
      ];
  return [
    readyNoteOpening(facts.ticket),
    `  row:       ${facts.rowId} · ${spinoffStatusWord(facts.status)} (as composed)`,
    `  composed:  ${facts.composedAt} (T3 delivers a queued note when your turn ends)`,
    `  ticket:    ${facts.ticket}`,
    `  branch:    ${facts.branch}`,
    `  worktree:  ${facts.worktree}`,
    `  commits:   ${facts.nothingToMerge ? "none past main (nothing to merge)" : commits}`,
    ...stateDisplayLines(facts.state, "  ", undefined, true),
    `  gate:      ${gate ? underLabel(gate, "             ") : GATE_UNREPORTED}`,
    `  review:    ${reviewLineFrom(facts.builderNote) ?? REVIEW_UNREPORTED}`,
    `  ${facts.tierFit ?? TIER_FIT_UNREPORTED_LINE}`,
    "",
    "This note is a SNAPSHOT taken when it was queued, not a live status: T3 holds a queued note",
    "until your turn ends, so it can arrive after the work it announces has already landed.",
    `Re-read the row before you gate: \`ob spinoff show ${facts.rowId}\` prints its RECORDED status, and the`,
    "list ob-land reads — `ob spinoff gateable` — drops it once it has merged and marks `worktree missing`",
    "when the checkout went with the land. Either way there is nothing left to gate.",
    "",
    ...ending,
  ].join("\n");
}

/**
 * The note `ob spinoff handoff` sends the architect for a SPIKE (OB-1826). Nothing to gate: the answers are on
 * the parent ticket, and the architect's next steps are to read them and close the spike. Pure.
 */
export function spikeAnsweredNote(facts: {
  ticket: string;
  branch: string;
  worktree: string;
  rowId: number;
  composedAt: string;
  /** OB-2227: the branch carries a documentation commit. */
  committed?: boolean;
  /** OB-2227: the open PR for that commit, when one was found. */
  prUrl?: string | null;
}): string {
  const opening = !facts.committed
    ? "has no commit and no PR."
    : facts.prUrl
      ? `committed documentation only, in PR ${facts.prUrl}: merge it like a chart before the close.`
      : "committed documentation only, and no open PR was found for its branch.";
  return [
    `${spikeNoteOpening(facts.ticket)}${opening} Its answers are on the ticket it serves, as ob notes.`,
    `  row:       ${facts.rowId} · building (stays so until ob close; a spike is never gateable)`,
    `  composed:  ${facts.composedAt} (T3 delivers a queued note when your turn ends)`,
    `  branch:    ${facts.branch}`,
    `  worktree:  ${facts.worktree}`,
    "",
    "Read the notes on the parent (`ob show <parent>`), edit the parent with the findings, and score it again with a",
    `fresh blind check. Then close the spike: \`ob close ${facts.ticket}\` (it retires the row as a spike end, not a`,
    `landing), and remove its worktree: \`git worktree remove --force ${facts.worktree}\` and \`git branch -D ${facts.branch}\`.`,
  ].join("\n");
}

/** FNV-1a, 32-bit, base36. Only ever used to make a request key stable and short. Pure. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * The ready note's retry key: the row plus the HEAD SHA of its branch (OB-1805). A handoff twice on one
 * commit is one note; any new commit — and an amended, force-pushed one, which has a new SHA — is a second,
 * different one. A send-back fix usually keeps `State: landable`, so the State line cannot be the key.
 * With no SHA (git could not say) it falls back to the State line, the key this had before OB-1805. Pure.
 */
export function readyNoteRequestId(rowId: number, headSha: string | null, state: string | null = null): string {
  const sha = (headSha ?? "").trim();
  return sha ? `ob-ready-${rowId}-${sha}` : `ob-ready-${rowId}-state-${hashText(state ?? "no-state")}`;
}

/** The land reply's retry key: the row plus the commit that landed. Pure. */
export function landedNoteRequestId(rowId: number, sha: string | null): string {
  return `ob-landed-${rowId}-${sha ?? "no-sha"}`;
}

/** A T3 failure as one sentence, carrying the seam's own remedy when it has one. */
function t3Reason(prefix: string, err: unknown): string {
  const remedy = err instanceof T3Error && err.remedy ? ` — ${err.remedy}` : "";
  return `${prefix}: ${(err as Error).message}${remedy}`;
}

export interface ReadyNoteOutcome {
  ticket: string;
  /** The architect thread the note went to, or null when nothing was sent. */
  threadId: string | null;
  /** `sent` · `skipped` (nothing to send, and named) · `failed` (a named warning). */
  outcome: "sent" | "skipped" | "failed";
  /** One sentence naming why, for every outcome but `sent`. */
  reason: string | null;
  /** The commit the note was keyed on (OB-1805); null when git could not say or nothing was sent. */
  headSha?: string | null;
  /** True when the handoff was a repeat on an already handed-off row (OB-1805). */
  repeat?: boolean;
  /** OB-2172: a `failed` note the caller recorded on the row's `note_error`, so the warning says where to find it. */
  recordedOn?: number;
  /** OB-2172: the row's `note_error` could not be written (or cleared), and why; printed as its own warning. */
  recordError?: string;
  /** OS-56: what the delivery into the role's run did, printed instead of the seat send's line. */
  via?: string;
}

export interface ReadyNoteInput {
  row: { id: number; ticket_ref: string; branch: string; worktree: string; status: string; repo?: string };
  /**
   * Where the note goes (OB-2255, OS-181): the ticket's team's sentinel, started on delivery if it has none, or the
   * named reason there is none (`teamHandoffTarget`), resolved by the caller where the store or the API is.
   */
  route: HandoffRoute;
  /** The row's launcher: only a `t3` row has a thread to tell, and only it pays a credential read. */
  launcher: string | null;
  state: string | null;
  builderNote: string | null;
  commitsAhead: number | null;
  /** OS-211: no commit past main, so the note says there is nothing to merge. */
  nothingToMerge?: boolean;
  /** The `tier-fit:` line the handoff recorded (1552), or null when the builder rated none. */
  tierFit?: string | null;
  /** Head SHA of the builder's branch (OB-1805): the note's idempotence key. Null when git could not say. */
  headSha?: string | null;
  /** True when the row was ALREADY handed off, so this handoff is a repeat that T3 may have dropped as a duplicate. */
  repeat?: boolean;
  /** OB-1826: the row is a spike, so the note says its answers are on the parent and there is nothing to gate. */
  spike?: boolean;
  /** OB-2227: the spike's branch carries a documentation commit. */
  spikeCommitted?: boolean;
  /** OB-2227: a spike's open documentation PR, named in its note. */
  prUrl?: string | null;
  seam?: T3Seam;
  /** OB-2172: the sleep before the one retry; a test passes a fake to see the wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Store the note in the target role's inbox too (a `handoff` row), where the caller's store or API is. Its failure
   * never stops the T3 note: it is one stderr line (`inbox: handoff not stored (<reason>)`).
   */
  inbox?: (msg: Omit<HandoffMessage, "from">) => Promise<unknown>;
  /**
   * OS-56: deliver the role's inbox into its run (`deliverToRole`), starting one if none is open. Used instead of the
   * seat send whenever the inbox write took; a write that failed keeps the seat send, so no note is lost.
   */
  deliver?: (team: string, role: TeamRole, seam: () => Promise<T3Seam>) => Promise<DeliverOutcome>;
}

/** OB-2172: how long a failed readying note waits before its one retry. A guess: the first try may already have waited 15 s. */
export const READY_NOTE_RETRY_MS = 5_000;
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let readyNoteRetryMs = READY_NOTE_RETRY_MS;
/** Test hook (OB-2172): the retry wait the CLI paths use, which cannot pass `retryDelayMs`. Returns the restore. */
export function __setReadyNoteRetryMs(ms: number): () => void {
  const prev = readyNoteRetryMs;
  readyNoteRetryMs = ms;
  return () => {
    readyNoteRetryMs = prev;
  };
}

/**
 * Tell the team thread that a builder has handed off (1133, OB-2255).
 *
 * Takes the REGISTRY SEAM, not a database, for the same reason `ensureTeamThread` does: on this machine
 * the role row is in the store and on an API client it is behind `GET /agents`, while the question
 * (does a live team thread exist?) is one implementation reached both ways.
 *
 * NEVER THROWS, and never a gate: the stamp and the lease release have already happened by the time this
 * runs, so every outcome is returned for the caller to PRINT — a named skip for the two cases ob can
 * name (no thread to tell, a headless row) and a named warning for the one it cannot control (T3 down,
 * credential rejected, thread gone). Only a `sent` outcome is silence.
 */
export async function announceReadyNote(registry: AgentRegistry, input: ReadyNoteInput): Promise<ReadyNoteOutcome> {
  const { row } = input;
  const skipped = (reason: string): ReadyNoteOutcome => ({ ticket: row.ticket_ref, threadId: null, outcome: "skipped", reason });

  // A headless row has no thread anywhere: nothing to send, and no credential read to find that out.
  if (input.launcher !== T3_LAUNCHER) {
    return skipped(`${row.ticket_ref} ran under the ${input.launcher ?? "unknown"} launcher, so there is no sentinel thread to tell`);
  }

  const { route } = input;
  if (route.kind === "skip") return skipped(route.reason);
  if (route.kind === "failed") return { ticket: row.ticket_ref, threadId: null, outcome: "failed", reason: route.reason };
  const target = route.target;

  // Composed before the thread is looked up, so the role's inbox gets the note even when no thread is bound now.
  const composedAt = new Date().toISOString();
  const note = input.spike
    ? spikeAnsweredNote({
        ticket: row.ticket_ref,
        branch: row.branch,
        worktree: row.worktree,
        rowId: row.id,
        composedAt,
        committed: input.spikeCommitted === true,
        prUrl: input.prUrl ?? null,
      })
    : readyingNote({
        ticket: row.ticket_ref,
        branch: row.branch,
        worktree: row.worktree,
        commitsAhead: input.commitsAhead,
        ...(input.nothingToMerge ? { nothingToMerge: true } : {}),
        state: input.state,
        builderNote: input.builderNote,
        rowId: row.id,
        status: row.status,
        composedAt,
        tierFit: input.tierFit ?? null,
        ...(row.repo !== undefined ? { repo: row.repo } : {}),
      });
  const clientRequestId = readyNoteRequestId(row.id, input.headSha ?? null, input.state);
  const role = teamRoleOf(target.agentId);
  let stored = false;
  if (input.inbox && role) {
    const write = input.inbox;
    stored = await storeHandoffQuietly(() => write({ team: target.team, role, ref: row.ticket_ref, body: note, clientKey: clientRequestId }), warn);
  }
  if (stored && role && input.deliver) {
    const label = `${target.team} ${role}`;
    const deliver = input.deliver;
    const once = () => deliver(target.team, role, async () => input.seam ?? (await t3Seam()));
    try {
      let d: DeliverOutcome;
      try {
        d = await once();
      } catch (err) {
        // OB-2172's one retry: a credential problem cannot clear in 5 s; anything else may. Messages T3 took are already
        // marked read, so the retry sends only the rest, under the same request ids.
        // Only a T3 error is retried: a refusal from the run's start (an AppError) would only refuse again.
        const permanent = !(err instanceof T3Error) || err.kind === "credential_missing" || err.kind === "credential_expired" || err.kind === "credential_rejected";
        if (permanent) throw err;
        await (input.sleep ?? defaultSleep)(readyNoteRetryMs);
        d = await once();
      }
      if (d.kind === "other-host") return skipped(`${label}: ${renderDelivery(d)}`);
      if (d.kind === "started" && d.auto_settle_warning) warn(d.auto_settle_warning);
      // `idle` is a handoff already read by a run (stored on an earlier handoff, delivered then or by a later send): it
      // reached the role, so it counts as sent and clears any note failure the row still records.
      if (d.kind === "idle") {
        return { ticket: row.ticket_ref, threadId: null, outcome: "sent", reason: null, via: `${label}: nothing unread to deliver; this handoff was already given to its run` };
      }
      return {
        ticket: row.ticket_ref,
        threadId: d.thread_id,
        outcome: "sent",
        reason: null,
        headSha: input.headSha ?? null,
        repeat: input.repeat === true,
        via: `${label}: ${renderDelivery(d)}`,
      };
    } catch (err) {
      return { ticket: row.ticket_ref, threadId: null, outcome: "failed", reason: t3Reason(`the ${label} could not start or take the note (the handoff is stored, unread)`, err) };
    }
  }

  let targetRow: { session_id: string | null; launcher: string | null } | null;
  try {
    targetRow = await registry.read(target.agentId);
  } catch (err) {
    return { ticket: row.ticket_ref, threadId: null, outcome: "failed", reason: `could not read the registry row ${target.agentId}: ${(err as Error).message}` };
  }
  const threadId = teamThreadIdOf(targetRow);
  if (!threadId) {
    return skipped(`no ${target.label} thread: run \`ob role start ${target.team} sentinel\``);
  }
  // One try: the reason it failed, or null when T3 took the note.
  // `permanent` is a missing, expired or rejected credential: a retry 5 s later cannot fix it, so it is not tried.
  let permanent = false;
  const isPermanent = (err: unknown): boolean =>
    err instanceof T3Error && (err.kind === "credential_missing" || err.kind === "credential_expired" || err.kind === "credential_rejected");
  const attempt = async (): Promise<string | null> => {
    let seam: T3Seam;
    try {
      seam = input.seam ?? (await t3Seam());
    } catch (err) {
      permanent = isPermanent(err);
      return t3Reason("T3 is unreachable, so the sentinel was not told", err);
    }
    try {
      // `queue`, never `steer`: an architect mid-turn finishes its turn before this lands, and the human act
      // (`ob spinoff handoff`) is the first cause: nothing here can wake an architect on its own.
      await seam.send({ threadId, message: note, mode: "queue", clientRequestId });
      return null;
    } catch (err) {
      permanent = isPermanent(err);
      return t3Reason(`T3 refused the readying note (thread ${threadId})`, err);
    }
  };
  // OB-2172: one retry after a short wait. The SAME request id, so a first send that did arrive is not
  // delivered twice (T3 sends one note per key, OB-1805). A second failure is returned for the caller to
  // record on the row (`note_error`), where `ob spinoff gateable` and `show` print it.
  let reason = await attempt();
  if (reason !== null && !permanent) {
    await (input.sleep ?? defaultSleep)(readyNoteRetryMs);
    reason = await attempt();
  }
  if (reason !== null) return { ticket: row.ticket_ref, threadId, outcome: "failed", reason };
  return { ticket: row.ticket_ref, threadId, outcome: "sent", reason: null, headSha: input.headSha ?? null, repeat: input.repeat === true };
}

/**
 * A readying note still HELD by the architect's thread for a ticket ob has just landed, and what happened to
 * it (1205).
 */
export interface StaleReadyNoteOutcome {
  /** The repo whose architect was asked: a row's worktree resolves to its repo. */
  repo: string;
  /** The ticket refs searched for in that architect's queue (the ROWS' refs, not the closed item's). */
  tickets: string[];
  threadId: string | null;
  /** `cancelled` (withdrawn) · `none` (nothing held for these tickets) · `partial` (the read was bounded) · `skipped` · `failed`. */
  outcome: "cancelled" | "none" | "partial" | "skipped" | "failed";
  /** How many messages were withdrawn before the read/withdrawal ended — 0 on every path but `cancelled`. */
  cancelled: number;
  reason: string | null;
}

export interface StaleReadyNotesInput {
  /** The rows that served the landed item, so the architect of each row's repo is asked. */
  rows: Array<{ ticket_ref: string; worktree: string; repo?: string | null; launcher?: string | null }>;
  /**
   * The registry seam, not a database — the same reason `announceReadyNote` takes one: on this machine the
   * architect row is in the store, on an API client it is behind `GET /agents`, and the question is one
   * implementation reached both ways.
   */
  registry: AgentRegistry;
  /** Where a repo's rows sent their note (OB-2255, `teamHandoffTarget`), resolved by the caller. */
  targetFor: (repo: string) => Promise<HandoffRoute>;
  seam?: T3Seam;
}

/**
 * Withdraw the readying notes a LAND has just made moot (1205).
 *
 * `ob spinoff handoff` queues its note with `mode: queue`, which is the right vehicle, an architect mid-turn
 * finishes before the note lands — and that is exactly what makes a stale one possible: the note is
 * delivered when the architect's turn ENDS, and a land can happen inside that same turn (`ob-land`: the
 * human's "land it" arrives, the architect stamps, gates, squashes and closes without ever ending a turn).
 * The note then arrives minutes later announcing a gate for a ticket that is already on main. Last night
 * that cost a full turn re-verifying an already-landed ticket. 1188 stopped the SYNCHRONOUS announce for
 * landed work; this is the same guard applied to the QUEUED one, at the only moment ob can still act: the
 * land itself.
 *
 * Nothing here is a gate. Every outcome is returned for the caller to print — a withdrawal, or a named
 * warning: and a close's own result never depends on it. A ticket with no rows, or a repo whose architect
 * has no thread, asks T3 nothing.
 *
 * AN INCOMPLETE READ IS NOT AN EMPTY QUEUE. A read that did not come back in ONE live page is reported as
 * `partial` (a warning the caller prints), never as `none`: page offsets are recomputed per read against a
 * queue other turns are draining, so a scan can step over an item and still run out of cursor. A bounded
 * scan must never read as evidence that nothing is held — that is the whole class of failure this change
 * exists to remove.
 *
 * ONLY A `t3` ROW IS A CANDIDATE, and that is not a shortcut: the announce itself is skipped for a headless
 * row (`announceReadyNote`), so a headless row has never put a note in any architect's queue: and a
 * headless-only fleet must not start paying a config read, a registry read and a T3 queue read on every
 * land for a note that cannot exist. A ticket whose rows are all headless does nothing at all.
 *
 * Only the notes for THESE tickets are withdrawn: another ticket's queued note is a live declaration and
 * is left exactly where it is.
 */
export async function dropQueuedReadyNotes(input: StaleReadyNotesInput): Promise<StaleReadyNoteOutcome[]> {
  const rows = input.rows.filter((row) => row.launcher === T3_LAUNCHER);
  if (rows.length === 0) return [];
  // Group by repo first: one architect per repo, and the ticket refs are what the note's own first line
  // carries. `worktreeRepoOf` needs the sibling checkout to exist; the row's own `repo` is the fallback the
  // announce path uses, and a row that has neither is its own repo.
  const byRepo = new Map<string, string[]>();
  for (const row of rows) {
    const repo = worktreeRepoOf(row.worktree) ?? row.repo ?? row.worktree;
    const tickets = byRepo.get(repo) ?? [];
    if (!tickets.includes(row.ticket_ref)) tickets.push(row.ticket_ref);
    byRepo.set(repo, tickets);
  }
  const out: StaleReadyNoteOutcome[] = [];
  let seam: T3Seam | null = input.seam ?? null;
  let seamError: string | null = null;
  for (const [repo, tickets] of byRepo) {
    const base = { repo, tickets, threadId: null as string | null, cancelled: 0 };
    let route: HandoffRoute;
    try {
      route = await input.targetFor(repo);
    } catch (err) {
      out.push({ ...base, outcome: "failed", reason: `could not resolve the team thread for ${repo}: ${(err as Error).message}` });
      continue;
    }
    if (route.kind !== "team") {
      out.push({ ...base, outcome: route.kind === "skip" ? "skipped" : "failed", reason: route.reason });
      continue;
    }
    let threadId: string | null;
    try {
      threadId = teamThreadIdOf(await input.registry.read(route.target.agentId));
    } catch (err) {
      out.push({ ...base, outcome: "failed", reason: `could not read the registry row ${route.target.agentId}: ${(err as Error).message}` });
      continue;
    }
    if (!threadId) {
      out.push({ ...base, outcome: "skipped", reason: `no ${route.target.label} thread, so no note is held there` });
      continue;
    }
    if (!seam) {
      if (!seamError) {
        try {
          seam = await t3Seam();
        } catch (err) {
          seamError = t3Reason("T3 is unreachable, so a held readying note was not withdrawn", err);
        }
      }
      if (!seam) {
        out.push({ ...base, threadId, outcome: "failed", reason: seamError });
        continue;
      }
    }
    let cancelled = 0;
    try {
      const held = await seam.queue(threadId);
      for (const message of held.items) {
        if (!tickets.some((t) => isReadyingNoteFor(message.text, t))) continue;
        await seam.queueCancel(threadId, message.queuedRunId);
        cancelled++;
      }
      // A read that ran out of pages is `partial`, never `none` — AND that stands even when something was
      // withdrawn from the pages it did see: unseen pages may hold another note, so a cancellation must not
      // silence the fact that the scan was bounded.
      if (!held.complete) {
        out.push({
          ...base,
          threadId,
          cancelled,
          outcome: "partial",
          reason: `the queue did not come back in one live page, and T3 recomputes page offsets per read, so the scan may have stepped over an item`,
        });
      } else if (cancelled > 0) {
        out.push({ ...base, threadId, cancelled, outcome: "cancelled", reason: null });
      } else {
        out.push({ ...base, threadId, cancelled, outcome: "none", reason: null });
      }
    } catch (err) {
      out.push({ ...base, threadId, cancelled, outcome: "failed", reason: t3Reason(`T3 refused the queue read or the withdrawal (thread ${threadId})`, err) });
    }
  }
  return out;
}

/**
 * One line per withdrawal outcome, for the close's report — and NOTHING for `none` or `skipped` (1205).
 *
 * The ordinary land finds an empty architect queue, so a line for `none` would be noise on an output a human
 * reads; `skipped` names a repo with no sentinel thread, which is equally unremarkable at land time.
 * A withdrawal, a bounded read and a failure are the three facts worth saying. Null means "say nothing" —
 * the same shape `unjoinedSettleLine` uses. Pure.
 */
export function renderStaleNoteOutcome(outcome: StaleReadyNoteOutcome): { line: string; warning: boolean } | null {
  if (outcome.outcome === "cancelled") {
    const what = outcome.cancelled === 1 ? "a queued readying note" : `${outcome.cancelled} queued readying notes`;
    return { line: `  note:      withdrew ${what} for ${outcome.tickets.join(", ")} (queued before this land)`, warning: false };
  }
  if (outcome.outcome === "partial") {
    const what = outcome.cancelled === 1 ? "a queued readying note" : `${outcome.cancelled} queued readying notes`;
    const did = outcome.cancelled > 0 ? `withdrew ${what} for ${outcome.tickets.join(", ")}, but ` : "";
    return { line: `warning: ${did}a queued readying note may still arrive — ${outcome.reason}`, warning: true };
  }
  if (outcome.outcome === "failed") {
    return { line: `warning: a queued readying note was not withdrawn — ${outcome.reason}`, warning: true };
  }
  return null;
}

export interface LandReplyOutcome {
  ticket: string;
  /** The row this reply was for, so a skip can name the row rather than a thread it never had. */
  rowId: number;
  threadId: string | null;
  /** `sent` · `skipped` (nothing to send, and named) · `failed` (a named warning). */
  outcome: "sent" | "skipped" | "failed";
  /** True when the note's own turn was seen to end, which is what lets the settle that follows stick. */
  waited: boolean;
  reason: string | null;
  /** OB-1826: the row was a spike, told it is closed rather than that it landed. */
  spike?: boolean;
}

/**
 * How long the land reply waits for its own turn to end before giving the close back its settle (1133).
 * A builder reading one sentence is seconds; the bound exists so a builder that decides to do more work
 * cannot hold `ob close` open indefinitely — the note has landed either way.
 */
export const LAND_REPLY_WAIT_MS = 30_000;

/**
 * The sentence `ob close` sends to a builder's thread. Pure.
 *
 * AN EXPLICIT STOP, AND THAT IS LOAD-BEARING (1188). The first version said the fact and "nothing further
 * is needed from this thread" — and the message STARTS A TURN, so the finished builder was re-activated
 * and began its job again (measured at the 1163 land: "I'll start by loading the OmniSlash CLI surface…",
 * "Now let me make the schema changes."). The note is the only vehicle this build offers for telling a
 * thread anything (`t3_thread_send` has no note-only mode: every mode starts a run), so the note has to be
 * one an agent ends immediately — otherwise `ob close` buys a fresh work turn on every land, and the live
 * turn it just started is exactly what refuses the settle that follows.
 *
 * Deliberately ONE fact plus the instruction: at the moment this is sent, ob does not yet know whether the
 * settle that follows will stick, and a note is not allowed to claim something ob cannot know. The settle
 * is ob's bookkeeping and it is reported to the ARCHITECT (`ob close`), not asserted to the builder.
 */
export function spikeClosedNote(input: { ticket: string }): string {
  return [
    `closed: ${input.ticket} was a spike, and the sentinel has closed it. Nothing was merged.`,
    "  INFORMATIONAL — nothing further is needed from this thread.",
    "  Do not start or continue any work, do not reply, end your turn now.",
  ].join("\n");
}

export function landedNote(input: { ticket: string; sha: string | null }): string {
  const landed = input.sha
    ? `landed: ${input.ticket} is on main (squash ${input.sha}).`
    : `landed: ${input.ticket} is on main (the merge commit sha is unreported).`;
  return [
    landed,
    "  INFORMATIONAL — ob has landed this ticket, and nothing further is needed from this thread.",
    "  Do not start or continue any work, do not reply, end your turn now.",
  ].join("\n");
}

/**
 * The rows that SERVE an ob item, read from the store — the local twin of the API close's join, so both
 * close paths decide "which rows is this land about" the same way (1163).
 *
 * 1163's join is the IDENTITY, and 1226 fixed the ORDER the evidence is read in: the ticket PATH a row's
 * ref names, then the item the row RECORDS (`spinoff.item_id`), then the ref as an item id. The bare id is
 * last because the two numbering sequences COLLIDE — `ob add` ids and hand-charted wayfinder numbers
 * (row 595: ref "1133", which is both the strip mirror's id and the readying-note ticket's wayfinder
 * number, whose mirror is item 1135). Matching `ticket_ref` to the closed item id alone silently found
 * nothing for hand-charted tickets (row 591: ref "1124", item 1134), and letting the id win over the path
 * bound row 595 to the wrong item and told a finished builder it had landed.
 *
 * ONE resolution for EVERY consumer: the withdrawal of a note the land made moot (1205), the land reply
 * (1133) and the settle (1120) all act on these rows — a sweep that missed a row would leave exactly the
 * stale note it exists to withdraw, and a second selection would let the reply tell one builder it landed
 * while the settle left another alone. The rows the resolution could NOT settle travel back NAMED
 * (`unresolved`, 1226) rather than being dropped in silence.
 */
export interface ServingSpinoffRow {
  id: number;
  ticket_ref: string;
  item_id: string | null;
  worktree: string;
  repo: string | null;
  launcher: string | null;
  t3_thread_id: string | null;
  /** The stored status (`failed` for an abandoned row): a retired row is not told a later close landed (OB-1685). */
  status: string;
  /** The row's error: a `spike:` marker (OB-1826) tells a closed spike from a failed launch. Absent on a wire row an old host sent. */
  error?: string | null;
  /**
   * OB-1826: the row serves a spike-tagged item. The local close settles threads BEFORE it stamps the rows (the
   * emit runs first), so the row is not yet a `spike:` end when the land reply is composed; the item's own tag
   * is what tells the reply to say "closed", not "landed".
   */
  spike?: boolean;
}

export async function servingSpinoffRows(
  db: Database | Store,
  itemId: string,
): Promise<ServingRows<ServingSpinoffRow>> {
  const s = asStore(db);
  const rows = (await s.q
    .select({
      id: s.t.spinoff.id,
      ticket_ref: s.t.spinoff.ticket_ref,
      // `item_id` is read because it is the row's own half of the identity (1163): the join is not a string
      // match, so a projection that dropped it would silently unbind every row the identity column exists for.
      item_id: s.t.spinoff.item_id,
      worktree: s.t.spinoff.worktree,
      // 1205: the row's repo and launcher, so the close resolves the ARCHITECT for it exactly as the announce
      // path does (`worktreeRepoOf` first, the repo as the fallback) and skips a row that never announced.
      repo: s.t.spinoff.repo,
      launcher: s.t.spinoff.launcher,
      t3_thread_id: s.t.spinoff.t3_thread_id,
      status: s.t.spinoff.status,
      error: s.t.spinoff.error,
    })
    .from(s.t.spinoff)) as ServingSpinoffRow[];
  const item = (await getItem(db, itemId).catch(() => null)) ?? { id: itemId };
  const spike = isSpikeTagged(await getTags(db, itemId).catch(() => []));
  return spinoffRowsServingItem(db, spike ? rows.map((r) => ({ ...r, spike })) : rows, item);
}

/**
 * Tell each of a landed ticket's builder threads that it landed (1133), beside the settle 1120 does.
 *
 * Takes the ROWS, not a database: the local close reads them from the store and the API client's close
 * reads the same rows over the wire (it already has them for the settle), and everything after that —
 * which rows can be told, what the note says, what happens when T3 refuses — is one implementation.
 *
 * A row with no recorded `t3_thread_id` is a NAMED SKIP — the 1142 field drop is the live example — never
 * a failure and never a guess at which thread was meant. Nothing is asked of T3 when no row has a thread
 * id, so a headless-only fleet pays no credential read.
 *
 * THE ORDER MATTERS, AND IT IS MEASURED (pinned build, 0.1.0). A message re-activates a thread — `settle`
 * then `send` leaves the thread UNSETTLED (measured), and `send` then `settle` is REFUSED while the turn
 * the message started is still running ("Thread … is still running. Stop it before settling"). So the
 * reply goes FIRST and this function then WAITS (bounded) for that turn to end, which is what lets the
 * caller's settle stick: measured, a settle after the wait is accepted. A wait that times out is not a
 * failure of the note — the note landed — and the settle is the caller's report, with one retry over a
 * bounded window behind it (1188, `settleThreadWithRetry`).
 */
export async function replyLandedToBuilders(
  rows: Array<{ id: number; ticket_ref: string; worktree: string; t3_thread_id: string | null; status?: string | null; error?: string | null; spike?: boolean }>,
  ticketRef: string,
  opts: {
    /** The squash sha for a ROW, read off that row's own dispatch ref (a hand-charted ticket's squash names its wayfinder number, never its mirror's item id). */
    landShaFor?: (row: { id: number; ticket_ref: string; worktree: string }) => string | null;
    seam?: T3Seam;
    /** How long to wait for the note's own turn before giving the caller its settle back. */
    waitMs?: number;
  } = {},
): Promise<LandReplyOutcome[]> {
  if (rows.length === 0) return [];
  const waitMs = opts.waitMs ?? LAND_REPLY_WAIT_MS;
  const out: LandReplyOutcome[] = [];
  let seam: T3Seam | null = opts.seam ?? null;
  let seamError: string | null = null;
  for (const row of rows) {
    const threadId = row.t3_thread_id;
    if (!threadId) {
      out.push({
        ticket: ticketRef,
        rowId: row.id,
        threadId: null,
        outcome: "skipped",
        waited: false,
        reason: `spinoff #${row.id} recorded no T3 thread id (the stamp never carried one), so the land reply is skipped rather than guessed at`,
      });
      continue;
    }
    if (!seam) {
      try {
        seam = await t3Seam();
      } catch (err) {
        seamError = t3Reason("T3 is unreachable, so the builder was not told it landed", err);
        break;
      }
    }
    // OB-1826: a closed spike merged nothing, so it is told it is closed, never that it landed.
    const spike = row.spike === true || isSpikeEnd({ status: row.status ?? "", error: row.error ?? null });
    const sha = spike ? null : (opts.landShaFor?.(row) ?? null);
    const message = spike ? spikeClosedNote({ ticket: ticketRef }) : landedNote({ ticket: ticketRef, sha });
    try {
      await seam.send({ threadId, message, mode: "queue", clientRequestId: spike ? `ob-spike-closed-${row.id}` : landedNoteRequestId(row.id, sha) });
    } catch (err) {
      out.push({ ticket: ticketRef, rowId: row.id, threadId, outcome: "failed", waited: false, reason: t3Reason(`T3 refused the land reply (thread ${threadId})`, err) });
      continue;
    }
    // The note landed; the wait is only so the settle that follows can stick. A refused wait is not a
    // refused reply, so it never turns a `sent` into a `failed`.
    let waited = false;
    try {
      waited = !(await seam.wait(threadId, waitMs)).timedOut;
    } catch {
      waited = false;
    }
    out.push({ ticket: ticketRef, rowId: row.id, threadId, outcome: "sent", waited, reason: null, spike });
  }
  // A seam that could not be built fails every row still owed a reply, named once per row.
  if (seamError) {
    for (const row of rows) {
      if (!row.t3_thread_id) continue;
      if (out.some((o) => o.rowId === row.id)) continue;
      out.push({ ticket: ticketRef, rowId: row.id, threadId: row.t3_thread_id, outcome: "failed", waited: false, reason: seamError });
    }
  }
  return out;
}

/** One line per ready-note outcome, for the command's report. Pure. */
export function renderReadyNoteOutcome(outcome: ReadyNoteOutcome): { line: string; warning: boolean } {
  const rendered = renderReadyNoteLine(outcome);
  if (!outcome.recordError) return rendered;
  // OB-2172: a failure that could not be recorded is a second warning (gateable and show will not show it). A
  // delivered note whose old record could not be cleared is only named: the architect was told, so it is not exit 1.
  if (outcome.outcome === "failed") {
    return { line: `${rendered.line}\nwarning: could not record the failure on the row (note_error): ${outcome.recordError}`, warning: true };
  }
  return { line: `${rendered.line}\n  note:      could not clear the row's earlier note failure (note_error): ${outcome.recordError}`, warning: rendered.warning };
}

function renderReadyNoteLine(outcome: ReadyNoteOutcome): { line: string; warning: boolean } {
  if (outcome.outcome === "sent" && outcome.via) return { line: `  note:      ${outcome.via}`, warning: false };
  if (outcome.outcome === "sent") {
    // OB-1805: T3 answers a deduplicated send exactly like a fresh one, so "told" is a claim ob cannot make.
    const at = outcome.headSha ? ` for ${outcome.headSha.slice(0, 7)}` : "";
    const caveat = outcome.repeat
      ? `this row was already handed off, so if ${outcome.headSha ? outcome.headSha.slice(0, 7) : "this commit"} was announced before, T3 dropped this note as a duplicate without saying (push a new commit and hand off again to send a new one)`
      : `T3 sends one note per commit and does not say if this repeated one`;
    return { line: `  note:      queued${at} on ${outcome.threadId}; ${caveat}`, warning: false };
  }
  if (outcome.outcome === "skipped") {
    return { line: `  note:      ${outcome.reason}`, warning: false };
  }
  const recorded = outcome.recordedOn !== undefined
    ? `; recorded on row ${outcome.recordedOn}, so \`ob spinoff gateable\` and \`ob spinoff show\` show it`
    : "";
  return { line: `warning: the readying note did not reach the sentinel and is held (never sent to the architect): ${outcome.reason}${recorded}`, warning: true };
}

/**
 * The checkout `ob close` is running in: the nearest directory at or above `cwd` holding a `.git` (a
 * directory in a main checkout, a file in a linked worktree), canonicalised. Null outside a checkout.
 * Pure-ish (directory probes only, no process).
 */
export function checkoutRootOf(cwd: string = process.cwd()): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return canonicalPath(dir);
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Split a land's rows into the builder's OWN row and the rest (OB-1670, #80). Since #80 a builder could run
 * `ob close` from its own worktree (since #82 the architect does, and a builder no longer merges its own PR), and the close's T3 side was written for a ARCHITECT
 * closing someone else's work: it would tell the builder's own (running) thread that it landed and settle
 * the very thread doing the close. A row whose worktree IS the checkout the close runs in is that builder,
 * so it is left out of both and named once (`ownCloseLine`). The architect closes from `main`, never a builder worktree, so its close is
 * unchanged. A `failed` row (an abandoned spinoff, OB-1685) goes to `retired`: not told, not settled. Pure.
 */
export function splitOwnRows<R extends { worktree: string; status?: string | null; error?: string | null }>(
  rows: R[],
  here: string | null,
): { own: R[]; others: R[]; retired: R[] } {
  const own: R[] = [];
  const others: R[] = [];
  const retired: R[] = [];
  for (const row of rows) {
    // OB-1685: a `failed` row (an abandoned spinoff, or a launch that failed) was settled when it was retired.
    // A later `ob close` on its ticket must not tell that thread it landed (the note starts a turn and
    // re-activates it) or settle it a second time: the close marks only landable rows `landed`, and the
    // notify follows the same line. Its readying note is still withdrawn, which reads `rows`, not `others`.
    // OB-1826: a closed spike is `failed` too, but its thread is still running and is the close's to settle.
    if (row.status === "failed" && !isSpikeEnd({ status: row.status, error: row.error ?? null })) retired.push(row);
    else if (here && canonicalPath(row.worktree) === here) own.push(row);
    else others.push(row);
  }
  return { own, others, retired };
}

/** The named skip for a retired (failed or abandoned) row a close leaves alone (OB-1685). Pure. */
export function retiredCloseLine(ticketRef: string, row: { id: number }): string {
  return `t3: ${ticketRef} closed; spinoff #${row.id} is failed or abandoned, so its thread is neither told it landed nor settled`;
}

/** The named skip for a row `splitOwnRows` held back. Pure. */
export function ownCloseLine(ticketRef: string, row: { id: number }): string {
  return `t3: ${ticketRef} closed from its own builder's worktree (row ${row.id}): its thread is neither told it landed nor settled`;
}

/** One line per land-reply outcome, for the close's report. Pure. */
export function renderLandReplyOutcome(outcome: LandReplyOutcome): { line: string; warning: boolean } {
  if (outcome.outcome === "sent") {
    return { line: `  t3 thread ${outcome.threadId} told ${outcome.spike ? "the spike is closed" : "it landed"}`, warning: false };
  }
  if (outcome.outcome === "skipped") {
    return { line: `  land reply skipped: ${outcome.reason}`, warning: false };
  }
  return { line: `warning: the land reply did not reach the builder — ${outcome.reason}`, warning: true };
}


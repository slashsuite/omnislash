import { T3_LIVE_STATUSES, T3Error, type T3Project, type T3Thread, type T3ThreadRead, type T3ThreadSummary } from "./client.ts";
import { canonicalPath, readThreadHeader, type T3Seam } from "./dispatch.ts";
import { UsageError } from "../errors.ts";
import type { T3AgentRow, T3SpinoffRow } from "./read.ts";
import { teamRoleOf } from "../team.ts";
import { IN_FLIGHT, spinoffStatusWord } from "../../../../platform/cli-coord/src/spinoff-vocab.ts";
import { ticketLeaseKey } from "../../../../platform/cli-coord/src/lease.ts";
import { legRef, refKey } from "../../../../platform/cli-coord/src/clean-repo.ts";

// -----------------------------------------------------------------------------
// `ob t3 settle-sweep [--dry-run]` (OS-288): settle every unsettled T3 thread whose work is over, in every T3
// project. The close settles a builder's thread when its ticket lands, but that settle does not always take, and a
// thread Jacobus opened by hand is never settled by anything. The 30-minute `settle-sweep` client job runs this.
//
// A thread is settled only when no rule keeps it. The rules, cheapest first:
//   role      a thread recorded on an architect-*, sentinel-* or muse-* agent row (expired rows included), an open
//             role run's thread, or one titled as a team role thread (`… · architect`): T3 gives no pinned flag
//   row       a spinoff row for the thread that is still in flight (queued, launching, building, handed-off), or
//             an in-flight row with no thread stamped whose worktree is the thread's
//   lease     a live `ticket:<ref>` lease (`ticket:<ref>-b` for a trial's leg b) held by the thread's builder, or
//             any live ticket lease held by an agent row registered on the thread
//   run       a run in progress, in any live status (preparing, queued, starting, running)
//   pending   a pending question or approval, or a run waiting on the human
//   queue     messages queued for the thread (delivering them would unsettle it again), or a queue not read whole
//   recent    a message Jacobus wrote in the last 30 minutes, or one of his whose time T3 does not give
//   parent    a subagent whose parent is kept or has a live run: a subagent's run is its parent's
// An archived thread is skipped. A settle is asked once: a refusal is re-read, never waited out.
// -----------------------------------------------------------------------------

/** How long after Jacobus's last message a thread stays unsettled. */
const SETTLE_SWEEP_QUIET_MS = 30 * 60_000;

/** T3 pages a project's thread list, and a thread's messages, at most this many at a time. */
const PAGE = 100;

export type SweepRule = "role" | "row" | "lease" | "run" | "pending" | "queue" | "recent" | "parent";

export type SweepAction = "settled" | "would-settle" | "kept" | "failed";

export interface SweepRow {
  threadId: string;
  title: string;
  project: string;
  action: SweepAction;
  /** The rule that kept the thread; null when it was settled (or would be), or failed. */
  rule: SweepRule | null;
  /** Why it was settled or kept, or how it failed. */
  reason: string;
}

export interface SweepReport {
  dryRun: boolean;
  at: string;
  rows: SweepRow[];
  settled: number;
  wouldSettle: number;
  kept: number;
  failed: number;
}

/** A lease as the sweep reads it: `ob lease status`'s row. */
export interface SweepLease {
  resource: string;
  holder: string | null;
  expired: boolean;
}

/** The ob rows the keep rules read. */
export interface SweepRows {
  spinoffs: T3SpinoffRow[];
  agents: T3AgentRow[];
  leases: SweepLease[];
  /** The thread ids of every open `role_run` row, in every team: a role run's thread even when its seat row was not pointed at it. */
  roleThreads: string[];
}

/** `ob t3 settle-sweep` takes no arguments: a stray word (`dry-run` without its dashes) must not run a live sweep. */
export function refuseSweepArgs(args: string[]): void {
  if (args.length > 1) throw new UsageError(`t3 settle-sweep takes no arguments (use --dry-run), got: ${args.slice(1).join(" ")}`);
}

/** A team role thread's title (`teamThreadTitle`): `<icon> <name> · <role>`. */
const ROLE_TITLE = / · (architect|sentinel|muse)\s*$/;

type Keep = { rule: SweepRule; reason: string };

/** The keep rule that needs no T3 read: a role thread, a live spinoff row, a live ticket lease. Pure. */
function rowRuleFor(threadId: string, title: string, rows: SweepRows): Keep | null {
  for (const a of rows.agents) {
    if (a.session_id === threadId && teamRoleOf(a.id)) return { rule: "role", reason: `role thread (${a.id})` };
  }
  if (rows.roleThreads.includes(threadId)) return { rule: "role", reason: "an open role run's thread" };
  const titled = ROLE_TITLE.exec(title);
  if (titled) return { rule: "role", reason: `titled as a team ${titled[1]} thread` };
  const mine = rows.spinoffs.filter((s) => s.t3_thread_id === threadId);
  for (const s of mine) {
    if (IN_FLIGHT.has(s.status)) return { rule: "row", reason: `spinoff #${s.id} ${s.ticket_ref} is ${spinoffStatusWord(s.status)}` };
  }
  const live = (key: (resource: string) => boolean, holders: Set<string>) =>
    rows.leases.find((l) => key(l.resource) && !l.expired && l.holder !== null && holders.has(l.holder));
  for (const s of mine) {
    // As the launch takes it (`spinoffLeaseKeys`, `builderIdOf`): leg b's key and id carry `-b`, and a clean-repo
    // builder with no agent id holds it under its ref, an ob-repo one under its branch.
    const ref = legRef(s.ticket_ref, s.trial_leg);
    const key = ticketLeaseKey(ref);
    const hold = live((r) => r === key, new Set([s.agent_id, s.branch, refKey(ref)].filter((h): h is string => !!h)));
    if (hold) return { rule: "lease", reason: `${hold.resource} is still leased to ${hold.holder}` };
  }
  // A builder registered by hand on this thread, with no spinoff row: any live ticket lease it holds.
  for (const a of rows.agents) {
    if (a.session_id !== threadId) continue;
    const hold = live((r) => r.startsWith("ticket:"), new Set([a.id]));
    if (hold) return { rule: "lease", reason: `${hold.resource} is still leased to ${hold.holder}` };
  }
  return null;
}

/** An in-flight spinoff row whose thread id was never stamped (a launch that died before it), matched by worktree. Pure. */
function unstampedRowFor(worktreePath: string | null | undefined, rows: SweepRows): Keep | null {
  if (!worktreePath) return null;
  const at = canonicalPath(worktreePath);
  const s = rows.spinoffs.find((r) => !r.t3_thread_id && IN_FLIGHT.has(r.status) && canonicalPath(r.worktree) === at);
  return s ? { rule: "row", reason: `spinoff #${s.id} ${s.ticket_ref} is ${spinoffStatusWord(s.status)} in this worktree (no thread stamped)` } : null;
}

/** The keep rule a thread's own header gives: a live run in any state, a pending request. Pure. */
function headerRuleFor(thread: Pick<T3Thread, "activeRunId" | "status" | "pendingRequestCount">): Keep | null {
  if (thread.status === "waiting") return { rule: "pending", reason: "its run is waiting on you" };
  if (thread.activeRunId || (T3_LIVE_STATUSES as readonly string[]).includes(thread.status)) return { rule: "run", reason: `a run is in progress (${thread.status})` };
  const pending = thread.pendingRequestCount ?? 0;
  if (pending > 0) return { rule: "pending", reason: `${pending} pending request${pending === 1 ? "" : "s"}` };
  return null;
}

/** How many positions back the first tail window of the messages view reaches. */
const TAIL_SPAN = 300;

/** What the messages view says of Jacobus's messages: the newest one's time, and whether one had no readable time. */
interface UserMessages {
  last: number | null;
  undated: boolean;
}

/**
 * Did Jacobus write in the thread since `cutoff` (`createdBy: "user"` in the messages view)? A read from the first
 * item times out on a thread of thousands of items (OB-2192), so it reads a tail window of the last `span` positions
 * and widens it only while the window's first message is still newer than the cutoff and no recent message of his
 * was found: items are in order, so nothing before an older message can be newer. A message of his with no readable
 * time counts as recent (`undated`), so the sweep fails closed.
 */
async function lastUserMessageAt(seam: T3Seam, threadId: string, itemCount: number | undefined, cutoff: number): Promise<UserMessages> {
  for (let span = TAIL_SPAN; ; span *= 4) {
    const from = itemCount === undefined ? undefined : itemCount - span;
    const start = from !== undefined && from > 0 ? from : undefined;
    const { first, ...seen } = await userMessagesFrom(seam, threadId, start);
    if (seen.undated || (seen.last !== null && seen.last >= cutoff)) return seen;
    if (start === undefined || (first !== null && first < cutoff)) return seen;
  }
}

/** Jacobus's messages, and the first message's time, from `start` (exclusive) to the end, paged until T3 says no more. */
async function userMessagesFrom(seam: T3Seam, threadId: string, start: number | undefined): Promise<UserMessages & { first: number | null }> {
  let last: number | null = null;
  let first: number | null = null;
  let undated = false;
  let after = start;
  for (;;) {
    const page: T3ThreadRead = await seam.read(threadId, { view: "messages", limit: PAGE, ...(after === undefined ? {} : { afterPosition: after }) });
    for (const item of page.items) {
      const at = Date.parse(item.updatedAt ?? "");
      if (first === null && !Number.isNaN(at)) first = at;
      if (item.createdBy !== "user") continue;
      if (Number.isNaN(at)) undated = true;
      else if (last === null || at > last) last = at;
    }
    if (!page.hasMore) return { last, undated, first };
    // A position that does not move forward would page for ever: stop by name, which fails the thread closed.
    if (after !== undefined && page.nextPosition <= after) throw new T3Error("refused", `t3_thread_read: thread ${threadId} returned position ${page.nextPosition} after ${after}`);
    after = page.nextPosition;
  }
}

type Listed = T3ThreadSummary & { project: string };

/** Every unsettled thread T3 lists in every project, subagents included, paged to the end. */
async function unsettledThreads(seam: T3Seam, projects: T3Project[]): Promise<Listed[]> {
  const out: Listed[] = [];
  for (const p of projects) {
    let cursor: number | undefined;
    for (;;) {
      const page = await seam.list({ projectId: p.id, settled: false, limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
      for (const t of page.threads) if (!t.settled) out.push({ ...t, projectId: t.projectId ?? p.id, project: p.title });
      if (page.nextCursor === null || page.nextCursor === undefined || page.threads.length === 0) break;
      if (cursor !== undefined && page.nextCursor <= cursor) {
        throw new T3Error("refused", `t3_thread_list: project ${p.title} returned cursor ${page.nextCursor} after ${cursor}, so its list cannot be read to the end`);
      }
      cursor = page.nextCursor;
    }
  }
  return out;
}

function minutesAgo(nowMs: number, at: number): string {
  const m = Math.max(0, Math.round((nowMs - at) / 60_000));
  return `${m} min ago`;
}

/** One thread's verdict before anything is settled: kept by a rule, settleable with a reason, or failed. */
type Verdict = { kind: "kept"; keep: Keep } | { kind: "settle"; why: string } | { kind: "failed"; reason: string } | { kind: "gone" };

/** Every keep rule for one listed thread, reading T3 only as far as it must. */
async function judge(seam: T3Seam, t: Listed, rows: SweepRows, nowMs: number, cutoff: number): Promise<Verdict> {
  const byRow = rowRuleFor(t.threadId, t.title, rows);
  if (byRow) return { kind: "kept", keep: byRow };
  try {
    const head = await readThreadHeader(seam, t.threadId);
    // Settled since the list, or archived: T3 refuses to settle an archived thread, and it is out of the way already.
    if (head.settled || head.archived) return { kind: "gone" };
    const byHead = unstampedRowFor(head.worktreePath, rows) ?? headerRuleFor(head);
    if (byHead) return { kind: "kept", keep: byHead };
    const queue = await seam.queue(t.threadId);
    if (queue.items.length > 0) return { kind: "kept", keep: { rule: "queue", reason: `${queue.items.length} queued message${queue.items.length === 1 ? "" : "s"}` } };
    if (!queue.complete) return { kind: "kept", keep: { rule: "queue", reason: "its queue could not be read to the end" } };
    // A thread not touched since the cutoff cannot hold a newer message, so its messages are not read.
    const touched = Date.parse(head.updatedAt ?? t.updatedAt ?? "");
    if (Number.isNaN(touched) || touched >= cutoff) {
      const seen = await lastUserMessageAt(seam, t.threadId, head.itemCount, cutoff);
      if (seen.undated) return { kind: "kept", keep: { rule: "recent", reason: "you wrote a message whose time T3 does not give" } };
      if (seen.last !== null && seen.last >= cutoff) return { kind: "kept", keep: { rule: "recent", reason: `you wrote ${minutesAgo(nowMs, seen.last)}` } };
    }
    const owned = rows.spinoffs.find((s) => s.t3_thread_id === t.threadId);
    return { kind: "settle", why: owned ? `idle; spinoff #${owned.id} ${owned.ticket_ref} is ${spinoffStatusWord(owned.status)}` : "idle; no ob row" };
  } catch (err) {
    if (!(err instanceof T3Error)) throw err;
    return { kind: "failed", reason: `could not read: ${err.message}` };
  }
}

/**
 * A subagent's run is its parent's: T3 shows a working subagent as idle with no run of its own. So a subagent is kept
 * while its parent is kept, or, when its parent is not on the unsettled list, while the parent's header shows a live
 * run. Reads the parent only in that last case.
 */
async function parentKeep(seam: T3Seam, parentId: string, verdicts: Map<string, Verdict>): Promise<Keep | null> {
  const v = verdicts.get(parentId);
  if (v) {
    if (v.kind === "kept") return { rule: "parent", reason: `its parent ${parentId} is kept (${v.keep.rule})` };
    if (v.kind === "failed") return { rule: "parent", reason: `its parent ${parentId} could not be read` };
    return null;
  }
  try {
    const head = await readThreadHeader(seam, parentId);
    if (head.settled || head.archived) return null;
    const live = headerRuleFor(head);
    return live ? { rule: "parent", reason: `its parent ${parentId} is kept (${live.rule})` } : null;
  } catch (err) {
    if (!(err instanceof T3Error)) throw err;
    return { rule: "parent", reason: `its parent ${parentId} could not be read` };
  }
}

/**
 * Walk every unsettled thread, keep the ones a rule names, and settle the rest (or, on a dry run, say it would).
 * Every thread is judged first, then subagents are judged against their parents, then the rest are settled.
 * An unreachable T3 throws before any settle. One thread that cannot be read or settled is a `failed` row and the
 * sweep goes on. A settle is asked once and never waits out a run: T3 refuses to settle a thread with a live run,
 * so a run that started after the checks keeps the thread, which is re-read to say why.
 */
export async function settleSweep(opts: { seam: T3Seam; rows: SweepRows; dryRun?: boolean; nowMs?: number }): Promise<SweepReport> {
  const { seam, rows } = opts;
  const dryRun = opts.dryRun === true;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - SETTLE_SWEEP_QUIET_MS;
  const projects = (await seam.projects()).filter((p) => !p.deletedAt);
  const threads = await unsettledThreads(seam, projects);
  const verdicts = new Map<string, Verdict>();
  for (const t of threads) verdicts.set(t.threadId, await judge(seam, t, rows, nowMs, cutoff));
  for (const t of threads) {
    const v = verdicts.get(t.threadId)!;
    if (v.kind !== "settle" || !t.parentThreadId) continue;
    const keep = await parentKeep(seam, t.parentThreadId, verdicts);
    if (keep) verdicts.set(t.threadId, { kind: "kept", keep });
  }
  const out: SweepRow[] = [];
  for (const t of threads) {
    const v = verdicts.get(t.threadId)!;
    const base = { threadId: t.threadId, title: t.title, project: t.project };
    if (v.kind === "gone") continue;
    if (v.kind === "kept") {
      out.push({ ...base, action: "kept", rule: v.keep.rule, reason: v.keep.reason });
      continue;
    }
    if (v.kind === "failed") {
      out.push({ ...base, action: "failed", rule: null, reason: v.reason });
      continue;
    }
    if (dryRun) {
      out.push({ ...base, action: "would-settle", rule: null, reason: v.why });
      continue;
    }
    out.push({ ...base, ...(await settleOnce(seam, t.threadId, v.why)) });
  }
  const count = (a: SweepAction) => out.filter((r) => r.action === a).length;
  return { dryRun, at: new Date(nowMs).toISOString(), rows: out, settled: count("settled"), wouldSettle: count("would-settle"), kept: count("kept"), failed: count("failed") };
}

/** Settle once. A refusal is re-read: a run that started since the checks keeps the thread; anything else fails it. */
async function settleOnce(seam: T3Seam, threadId: string, why: string): Promise<Pick<SweepRow, "action" | "rule" | "reason">> {
  try {
    await seam.settle(threadId);
    return { action: "settled", rule: null, reason: why };
  } catch (err) {
    const refused = (err as Error).message;
    try {
      const head = await readThreadHeader(seam, threadId);
      const live = headerRuleFor(head);
      if (live) return { action: "kept", rule: live.rule, reason: `${live.reason}, started since the checks` };
    } catch {
      // The re-read failing leaves the refusal as the answer.
    }
    return { action: "failed", rule: null, reason: `settle refused: ${refused}` };
  }
}

const ACTION_WORD: Record<SweepAction, string> = { settled: "settled", "would-settle": "would settle", kept: "kept", failed: "FAILED" };

/** The human report: a summary line, then one line per thread, the ones settled (or to be) first. Pure. */
export function renderSettleSweep(r: SweepReport): string {
  const head = r.dryRun
    ? `settle-sweep ${r.at} (dry run): ${r.wouldSettle} would settle, ${r.kept} kept, ${r.failed} failed`
    : `settle-sweep ${r.at}: ${r.settled} settled, ${r.kept} kept, ${r.failed} failed`;
  const order: SweepAction[] = ["settled", "would-settle", "failed", "kept"];
  const lines = [head];
  for (const a of order) {
    for (const row of r.rows.filter((x) => x.action === a)) {
      const rule = row.rule ? `[${row.rule}] ` : "";
      lines.push(`  ${ACTION_WORD[a].padEnd(12)} ${row.project} · ${row.title}  ${row.threadId}  ${rule}${row.reason}`);
    }
  }
  return lines.join("\n");
}

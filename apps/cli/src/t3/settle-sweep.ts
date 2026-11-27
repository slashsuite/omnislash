import { T3Error, type T3Project, type T3Thread, type T3ThreadRead, type T3ThreadSummary } from "./client.ts";
import { readThreadHeader, settleThreadWithRetry, type T3Seam } from "./dispatch.ts";
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
//   role      a thread recorded on an architect-*, sentinel-* or muse-* agent row (expired rows included), or one
//             titled as a team role thread (`… · architect`): T3 gives no pinned flag, so the rows are the record
//   row       a spinoff row for the thread that is still in flight (queued, launching, building, handed-off)
//   lease     a live `ticket:<ref>` lease (`ticket:<ref>-b` for a trial's leg b) held by the thread's builder
//   run       a run in progress
//   pending   a pending question or approval, or a run waiting on the human
//   queue     messages queued for the thread (delivering them would unsettle it again), or a queue not read whole
//   recent    a message Jacobus wrote in the last 30 minutes
// -----------------------------------------------------------------------------

/** How long after Jacobus's last message a thread stays unsettled. */
const SETTLE_SWEEP_QUIET_MS = 30 * 60_000;

/** T3 pages a project's thread list, and a thread's messages, at most this many at a time. */
const PAGE = 100;

export type SweepRule = "role" | "row" | "lease" | "run" | "pending" | "queue" | "recent";

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
}

/** A team role thread's title (`teamThreadTitle`): `<icon> <name> · <role>`. */
const ROLE_TITLE = / · (architect|sentinel|muse)\s*$/;

/** The keep rule that needs no T3 read: a role thread, a live spinoff row, a live ticket lease. Pure. */
function rowRuleFor(threadId: string, title: string, rows: SweepRows): { rule: SweepRule; reason: string } | null {
  for (const a of rows.agents) {
    if (a.session_id === threadId && teamRoleOf(a.id)) return { rule: "role", reason: `role thread (${a.id})` };
  }
  const titled = ROLE_TITLE.exec(title);
  if (titled) return { rule: "role", reason: `titled as a team ${titled[1]} thread` };
  const mine = rows.spinoffs.filter((s) => s.t3_thread_id === threadId);
  for (const s of mine) {
    if (IN_FLIGHT.has(s.status)) return { rule: "row", reason: `spinoff #${s.id} ${s.ticket_ref} is ${spinoffStatusWord(s.status)}` };
  }
  for (const s of mine) {
    // As the launch takes it (`spinoffLeaseKeys`, `builderIdOf`): leg b's key and id carry `-b`, and a clean-repo
    // builder with no agent id holds it under its ref, an ob-repo one under its branch.
    const ref = legRef(s.ticket_ref, s.trial_leg);
    const key = ticketLeaseKey(ref);
    const holders = new Set([s.agent_id, s.branch, refKey(ref)].filter((h): h is string => !!h));
    const hold = rows.leases.find((l) => l.resource === key && !l.expired && l.holder !== null && holders.has(l.holder));
    if (hold) return { rule: "lease", reason: `${hold.resource} is still leased to ${hold.holder}` };
  }
  return null;
}

/** The keep rule a thread's own header gives: a run in progress, a pending request. Pure. */
function headerRuleFor(thread: Pick<T3Thread, "activeRunId" | "status" | "pendingRequestCount">): { rule: SweepRule; reason: string } | null {
  if (thread.activeRunId || thread.status === "running") return { rule: "run", reason: `a run is in progress (${thread.status})` };
  const pending = thread.pendingRequestCount ?? 0;
  if (pending > 0) return { rule: "pending", reason: `${pending} pending request${pending === 1 ? "" : "s"}` };
  if (thread.status === "waiting") return { rule: "pending", reason: "its run is waiting on you" };
  return null;
}

/**
 * When Jacobus last wrote in the thread since `cutoff` (`createdBy: "user"` in the messages view), or null. A read
 * from the first item times out on a thread of thousands of items (OB-2192), so it reads a tail window of the last
 * `span` positions and widens it only while the window's first message is still newer than the cutoff: items are
 * in order, so nothing before an older message can be newer.
 */
async function lastUserMessageAt(seam: T3Seam, threadId: string, itemCount: number | undefined, cutoff: number): Promise<number | null> {
  for (let span = TAIL_SPAN; ; span *= 4) {
    const from = itemCount === undefined ? undefined : itemCount - span;
    const start = from !== undefined && from > 0 ? from : undefined;
    const { last, first } = await userMessagesFrom(seam, threadId, start);
    if (start === undefined || (first !== null && first < cutoff)) return last;
  }
}

/** How many positions back the first tail window of the messages view reaches. */
const TAIL_SPAN = 300;

/** The newest user message, and the first message's time, from `after` (exclusive) to the end. */
async function userMessagesFrom(seam: T3Seam, threadId: string, start: number | undefined): Promise<{ last: number | null; first: number | null }> {
  let last: number | null = null;
  let first: number | null = null;
  let after = start;
  for (;;) {
    const page: T3ThreadRead = await seam.read(threadId, { view: "messages", limit: PAGE, ...(after === undefined ? {} : { afterPosition: after }) });
    for (const item of page.items) {
      const at = Date.parse(item.updatedAt ?? "");
      if (first === null && !Number.isNaN(at)) first = at;
      if (item.createdBy !== "user") continue;
      if (!Number.isNaN(at) && (last === null || at > last)) last = at;
    }
    if (!page.hasMore || page.items.length === 0) return { last, first };
    // A position that does not move forward would page for ever: stop by name.
    if (after !== undefined && page.nextPosition <= after) throw new T3Error("refused", `t3_thread_read: thread ${threadId} returned position ${page.nextPosition} after ${after}`);
    after = page.nextPosition;
  }
}

/** Every unsettled thread T3 lists in every project, subagents included, paged to the end. */
async function unsettledThreads(seam: T3Seam, projects: T3Project[]): Promise<Array<T3ThreadSummary & { project: string }>> {
  const out: Array<T3ThreadSummary & { project: string }> = [];
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

/**
 * Walk every unsettled thread, keep the ones a rule names, and settle the rest (or, on a dry run, say it would).
 * An unreachable T3 throws before any settle. One thread that cannot be read or settled is a `failed` row and
 * the sweep goes on.
 */
export async function settleSweep(opts: { seam: T3Seam; rows: SweepRows; dryRun?: boolean; nowMs?: number }): Promise<SweepReport> {
  const { seam, rows } = opts;
  const dryRun = opts.dryRun === true;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoff = nowMs - SETTLE_SWEEP_QUIET_MS;
  const projects = (await seam.projects()).filter((p) => !p.deletedAt);
  const threads = await unsettledThreads(seam, projects);
  const out: SweepRow[] = [];
  for (const t of threads) {
    const base = { threadId: t.threadId, title: t.title, project: t.project };
    const kept = (k: { rule: SweepRule; reason: string }) => out.push({ ...base, action: "kept", rule: k.rule, reason: k.reason });
    const byRow = rowRuleFor(t.threadId, t.title, rows);
    if (byRow) {
      kept(byRow);
      continue;
    }
    let why: string;
    try {
      const head = await readThreadHeader(seam, t.threadId);
      if (head.settled) continue;
      const byHead = headerRuleFor(head);
      if (byHead) {
        kept(byHead);
        continue;
      }
      const queue = await seam.queue(t.threadId);
      if (queue.items.length > 0) {
        kept({ rule: "queue", reason: `${queue.items.length} queued message${queue.items.length === 1 ? "" : "s"}` });
        continue;
      }
      if (!queue.complete) {
        kept({ rule: "queue", reason: "its queue could not be read to the end" });
        continue;
      }
      // A thread not touched since the cutoff cannot hold a newer message, so its messages are not read.
      const touched = Date.parse(head.updatedAt ?? t.updatedAt ?? "");
      if (Number.isNaN(touched) || touched >= cutoff) {
        const last = await lastUserMessageAt(seam, t.threadId, head.itemCount, cutoff);
        if (last !== null && last >= cutoff) {
          kept({ rule: "recent", reason: `you wrote ${minutesAgo(nowMs, last)}` });
          continue;
        }
      }
      const owned = rows.spinoffs.find((s) => s.t3_thread_id === t.threadId);
      why = owned ? `idle; spinoff #${owned.id} ${owned.ticket_ref} is ${spinoffStatusWord(owned.status)}` : "idle; no ob row";
    } catch (err) {
      if (!(err instanceof T3Error)) throw err;
      out.push({ ...base, action: "failed", rule: null, reason: `could not read: ${err.message}` });
      continue;
    }
    if (dryRun) {
      out.push({ ...base, action: "would-settle", rule: null, reason: why });
      continue;
    }
    const settled = await settleThreadWithRetry(seam, t.threadId, { attempts: 2 });
    out.push(
      settled.settled
        ? { ...base, action: "settled", rule: null, reason: why }
        : { ...base, action: "failed", rule: null, reason: `settle refused: ${settled.error ?? "unknown"}` },
    );
  }
  const count = (a: SweepAction) => out.filter((r) => r.action === a).length;
  return { dryRun, at: new Date(nowMs).toISOString(), rows: out, settled: count("settled"), wouldSettle: count("would-settle"), kept: count("kept"), failed: count("failed") };
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

import { createHash } from "node:crypto";
import { T3_THREAD_ENV } from "../../../../platform/cli-coord/src/lease-wait-title.ts";
import { T3Error, type T3Project, type T3ThreadSummary } from "./client.ts";
import { T3_LAUNCHER, readThreadHeader, stripLeaseMarkers, t3Seam, titleWithNeedsYou, type T3Seam } from "./dispatch.ts";

/** A team's architect row, `architect-<team>` (OB-2255): the only rows `broadcast architects` reaches. */
const ARCHITECT_ROW = /^architect-[a-z0-9][a-z0-9-]*$/;

// -----------------------------------------------------------------------------
// `ob t3 broadcast architects|threads <message>` (OB-2187, OB-2255): one message into every team's architect
// thread, or into every active T3 thread, instead of calling `t3_thread_send` once per thread by hand.
//
// "Active" is T3's own active list: not settled, not archived, top level (no subagents), in every project.
// An architect is an `architect-*` registry row's recorded thread, and nothing else: no title matching. The
// caller's own thread (`T3CODE_THREAD_ID`) is left out and named.
//
// Every send is `mode: "queue"`, so it arrives when the thread's current turn ends and never interrupts a
// run, and carries a clientRequestId keyed on the message text and the thread, so a re-run of the same
// broadcast is the same durable message to T3 rather than a second one.
// -----------------------------------------------------------------------------

export type BroadcastAudience = "architects" | "threads";

export const BROADCAST_AUDIENCES: readonly BroadcastAudience[] = ["architects", "threads"];

export type BroadcastAction = "sent" | "would-send" | "skipped" | "failed";

export interface BroadcastRow {
  threadId: string;
  title: string;
  project: string | null;
  action: BroadcastAction;
  /** Why it was skipped, or how the send failed. */
  reason: string | null;
}

export interface BroadcastReport {
  audience: BroadcastAudience;
  dryRun: boolean;
  /** The text as delivered: the sender line, then the message. */
  message: string;
  rows: BroadcastRow[];
  /** Threads the message was delivered to (on a dry run, would be): `sent` or `would-send` rows, no failures. */
  recipients: number;
  sent: number;
  skipped: number;
  failed: number;
}

/** The slice of an agent row the architect half reads. */
export interface BroadcastAgentRow {
  id: string;
  launcher: string | null;
  session_id: string | null;
}

/** T3 pages a project's thread list at most this many at a time. */
const LIST_PAGE = 100;

/**
 * The retry key of one broadcast to one thread: the same message (sender line included) to the same thread is
 * the same message to T3, so a re-run delivers it once, while two senders with the same text stay two. Pure.
 */
export function broadcastRequestId(message: string, threadId: string): string {
  const digest = createHash("sha256").update(message).digest("hex").slice(0, 12);
  return `broadcast:${digest}:${threadId}`;
}

/** A title as a person reads it: no lease markers, no needs-you marker. Pure. */
function plainTitle(title: string): string {
  return titleWithNeedsYou(stripLeaseMarkers(title), null).trim();
}

/** The message each thread receives: one line naming the sender, then the text as given. Pure. */
export function framedBroadcast(audience: BroadcastAudience, sender: string | null, text: string): string {
  return `Broadcast from ${sender ? plainTitle(sender) : "ob"} to all active ${audience}:\n\n${text}`;
}

/** Every unsettled, top-level thread T3 lists, in every project, paged until T3 says there is no more. */
async function activeThreads(seam: T3Seam, projects: T3Project[]): Promise<T3ThreadSummary[]> {
  const out: T3ThreadSummary[] = [];
  for (const p of projects) {
    let cursor: number | undefined;
    for (;;) {
      const page = await seam.list({ projectId: p.id, settled: false, includeSubagents: false, limit: LIST_PAGE, ...(cursor === undefined ? {} : { cursor }) });
      for (const t of page.threads) out.push({ ...t, projectId: t.projectId ?? p.id });
      if (page.nextCursor === null || page.nextCursor === undefined || page.threads.length === 0) break;
      // A cursor that does not move forward would page forever: stop by name instead.
      if (cursor !== undefined && page.nextCursor <= cursor) {
        throw new T3Error("refused", `t3_thread_list: project ${p.title} returned cursor ${page.nextCursor} after ${cursor}, so its list cannot be read to the end`);
      }
      cursor = page.nextCursor;
    }
  }
  return out;
}

/**
 * Send one message to every team's architect, or to every active thread (OB-2187, OB-2255).
 *
 * An unreachable T3 fails at the project read, before any send. Each candidate is then read on its own,
 * because T3's list rows carry no `archived` field: an archived or settled thread is dropped, one T3 cannot
 * find is a named skip. One thread's failed send is reported by name and the rest are still sent.
 */
export async function broadcast(opts: {
  audience: BroadcastAudience;
  text: string;
  /** The agent registry rows; the `architect-*` ones are the architect audience (OB-2255). */
  rows?: BroadcastAgentRow[];
  dryRun?: boolean;
  /** The caller's own thread, left out. Defaults to `T3CODE_THREAD_ID`. */
  self?: string | null;
  seam?: T3Seam;
}): Promise<BroadcastReport> {
  // Refused when empty, and otherwise sent exactly as given.
  const text = opts.text;
  if (!text.trim()) throw new Error("t3 broadcast: the message is empty");
  const seam = opts.seam ?? (await t3Seam());
  const dryRun = opts.dryRun === true;
  const self = opts.self === undefined ? (process.env[T3_THREAD_ENV]?.trim() || null) : opts.self;

  // A deleted project's threads are not on T3's active list (the read surface drops them the same way).
  const projects = (await seam.projects()).filter((p) => !p.deletedAt);
  const projectTitle = new Map(projects.map((p) => [p.id, p.title]));
  // `threads` reads T3's whole active list; `architects` needs only the rows, plus the list for the sender's title.
  const listed = await activeThreads(seam, projects);

  // The candidates, deduped by thread id, in the order they will be reported.
  const candidates = new Map<string, { title: string; projectId: string | null }>();
  const fromRegistry = new Map<string, string>();
  if (opts.audience === "threads") {
    for (const t of listed) {
      if (t.parentThreadId) continue;
      candidates.set(t.threadId, { title: t.title, projectId: t.projectId ?? null });
    }
  } else {
    for (const r of opts.rows ?? []) {
      if (!ARCHITECT_ROW.test(r.id) || r.launcher !== T3_LAUNCHER || !r.session_id) continue;
      const known = listed.find((t) => t.threadId === r.session_id);
      if (known) candidates.set(r.session_id, { title: known.title, projectId: known.projectId ?? null });
      else fromRegistry.set(r.session_id, r.id);
    }
  }

  const rows: BroadcastRow[] = [];
  const recipients: BroadcastRow[] = [];
  let senderTitle: string | null = self ? (listed.find((t) => t.threadId === self)?.title ?? null) : null;

  const projectOf = (id: string | null) => (id ? (projectTitle.get(id) ?? id) : null);
  const readable = async (threadId: string, agentId: string | null, title: string, projectId: string | null): Promise<{ title: string; projectId: string | null } | "inactive" | null> => {
    try {
      // Read from past the end of the timeline: the thread's flags come back with no items. A read from the
      // start makes T3 walk the whole timeline, which times out on a long-lived team thread (6,000+ items).
      const t = await readThreadHeader(seam, threadId);
      if (t.settled || t.archived || t.parentThreadId) return "inactive";
      return { title: t.title, projectId: t.projectId ?? null };
    } catch (err) {
      // Only T3's own "no such thread" is a skip; any other refusal or failure is this thread's failure.
      if (err instanceof T3Error && err.code === "thread_not_found") {
        rows.push({ threadId, title: agentId ?? threadId, project: null, action: "skipped", reason: `T3 cannot find this thread${agentId ? ` (recorded on ${agentId})` : ""}` });
        return null;
      }
      // Any other read failure (a timeout on a busy T3) is that thread's failure, named, and the rest go on.
      rows.push({ threadId, title, project: projectOf(projectId), action: "failed", reason: `could not read it to check it is not archived: ${err instanceof Error ? err.message : String(err)}` });
      return null;
    }
  };

  // Every candidate is read at once: T3 answers each read on its own, and a slow T3 makes N reads in a row
  // the cost of the whole broadcast.
  const toRead: Array<{ threadId: string; agentId: string | null; title: string; projectId: string | null }> = [
    ...[...candidates].map(([threadId, c]) => ({ threadId, agentId: null, ...c })),
    ...[...fromRegistry].map(([threadId, agentId]) => ({ threadId, agentId, title: agentId, projectId: null })),
  ];
  const reads = await Promise.all(
    toRead.map(async (c) => {
      if (c.threadId === self) {
        rows.push({ threadId: c.threadId, title: c.title, project: projectOf(c.projectId), action: "skipped", reason: "the caller's own thread" });
        return null;
      }
      const live = await readable(c.threadId, c.agentId, c.title, c.projectId);
      return live === null || live === "inactive" ? null : { threadId: c.threadId, ...live };
    }),
  );
  for (const live of reads) {
    if (live) recipients.push({ threadId: live.threadId, title: live.title, project: projectOf(live.projectId), action: "would-send", reason: null });
  }

  if (self && senderTitle === null) {
    senderTitle = await readThreadHeader(seam, self)
      .then((t) => t.title)
      .catch(() => null);
  }
  const message = framedBroadcast(opts.audience, senderTitle, text);

  const byPlace = (a: BroadcastRow, b: BroadcastRow) => (a.project ?? "").localeCompare(b.project ?? "") || a.title.localeCompare(b.title) || a.threadId.localeCompare(b.threadId);
  recipients.sort(byPlace);
  // The skips and read failures were pushed as reads finished: put them in a fixed order too.
  rows.sort(byPlace);
  for (const r of recipients) {
    if (!dryRun) {
      try {
        await seam.send({ threadId: r.threadId, message, mode: "queue", clientRequestId: broadcastRequestId(message, r.threadId) });
        r.action = "sent";
      } catch (err) {
        r.action = "failed";
        r.reason = err instanceof Error ? err.message : String(err);
      }
    }
    rows.push(r);
  }

  return {
    audience: opts.audience,
    dryRun,
    message,
    rows,
    recipients: rows.filter((r) => r.action === "sent" || r.action === "would-send").length,
    sent: rows.filter((r) => r.action === "sent").length,
    skipped: rows.filter((r) => r.action === "skipped").length,
    failed: rows.filter((r) => r.action === "failed").length,
  };
}

/** The human report: one line per thread, then the tally. Pure. */
export function renderBroadcast(r: BroadcastReport): string {
  const lines: string[] = [];
  for (const row of r.rows) {
    const where = `${row.title}${row.project ? `  [${row.project}]` : ""}  ${row.threadId}`;
    if (row.action === "sent") lines.push(`sent      ${where}`);
    else if (row.action === "would-send") lines.push(`would send  ${where}`);
    else if (row.action === "skipped") lines.push(`skipped   ${where}: ${row.reason}`);
    else lines.push(`FAILED    ${where}: ${row.reason}`);
  }
  lines.push(
    "",
    r.dryRun
      ? `dry run: ${r.recipients} active ${r.audience} would receive it, ${r.skipped} skipped, ${r.failed} failed; nothing was sent`
      : `${r.sent} sent, ${r.skipped} skipped, ${r.failed} failed (queued: each arrives when that thread's turn ends)`,
  );
  return lines.join("\n");
}

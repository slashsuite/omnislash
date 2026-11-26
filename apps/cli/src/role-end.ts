// Ending a role run (OS-57): `ob role tick` ends a run whose work is done and that has had nothing for 15 minutes, or
// whose context has passed 200k tokens at a quiet point. Before the end it asks the run for its successor note
// (`ob role note`, OS-55), then settles the thread, records the end and frees the role's lease.
//
// A run that is not quiet (a turn in flight, a question waiting on the owner, a message in its T3 queue) is never
// ended. Unread rows in the role's ob inbox keep an idle run (delivery is about to send them), but not one over the
// context cap: those rows stay unread for the successor. Under the good-night lock nothing is delivered, so unread
// rows do not keep a run then.
//
// One wait per pass: every run due to end is asked first, then the pass polls them together for at most 10 minutes.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { InboxBackend } from "./commands/inbox.ts";
import type { RoleBackend } from "./commands/role.ts";
import { roleNoteLines, type RoleRun, type RoleRunEndReason } from "./role-run.ts";
import { busyReason } from "./team-restart.ts";
import { PAST_THE_END, t3BaseUrl, T3Error, type T3Thread, type T3ThreadRun } from "./t3/client.ts";
import type { T3Seam } from "./t3/dispatch.ts";
import type { TeamRole } from "./team.ts";

/** A run with nothing for this long, after its last turn completed, ends. */
const ROLE_IDLE_END_MS = 15 * 60_000;
/** A run whose context reaches this many tokens ends at its next quiet point. */
export const ROLE_CONTEXT_END_TOKENS = 200_000;
/** How long one pass waits, in total, for the notes it asked for. */
const ROLE_NOTE_WAIT_MS = 10 * 60_000;
const ROLE_NOTE_POLL_MS = 5_000;
/** How long the pass lets a run finish its note turn before the settle (as `restartTeamRole`). */
const ROLE_END_IDLE_WAIT_MS = 5 * 60_000;

export type EndVerdict = { end: "idle" | "context" } | { keep: string };

export interface EndCheckInput {
  thread: Pick<T3Thread, "status" | "activeRunId" | "pendingRequestCount" | "settled" | "archived">;
  /** Messages held in the thread's T3 queue; null when the queue could not be read. */
  queued: number | null;
  /** The newest `recentRuns[].completedAt`, or null when no run has completed. */
  lastCompletedAt: string | null;
  /** The role run's `started_at`. */
  startedAt: string;
  /** Unread rows in the role's ob inbox. */
  unread: number;
  /** The thread's context size, or null when it could not be read. */
  contextTokens: number | null;
  nightLocked: boolean;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Whether a role run ends now, and why, or why it is kept. Pure. */
export function endCheck(input: EndCheckInput, now: Date): EndVerdict {
  // The thread is already gone: the end only records it, with no note to ask for.
  if (input.thread.settled || input.thread.archived) return { end: "idle" };
  const busy = busyReason(input.thread, input.queued);
  if (busy) return { keep: busy };
  if (input.contextTokens !== null && input.contextTokens >= ROLE_CONTEXT_END_TOKENS) return { end: "context" };
  if (!input.nightLocked && input.unread > 0) return { keep: `${plural(input.unread, "unread message")}` };
  const since = Date.parse(input.lastCompletedAt ?? input.startedAt);
  const idleMs = now.getTime() - since;
  if (idleMs >= ROLE_IDLE_END_MS) return { end: "idle" };
  return { keep: `active ${Math.max(0, Math.floor(idleMs / 60_000))}m ago` };
}

/** The newest `completedAt` among a thread's recent runs, or null. Pure. */
function newestCompletedAt(runs: readonly T3ThreadRun[]): string | null {
  let best: string | null = null;
  for (const r of runs) {
    if (r.completedAt && (best === null || Date.parse(r.completedAt) > Date.parse(best))) best = r.completedAt;
  }
  return best;
}

/** T3's own state db, where each provider turn records its token usage. */
function t3StateDbPath(home: string = process.env.HOME || homedir()): string {
  return join(home, ".t3", "userdata", "statev2.sqlite");
}

/**
 * The context tokens T3 recorded for the thread's newest provider turn, read-only from T3's state db. A missing file,
 * table or row, or a value that is not a number, is null (it never ends a run on context).
 */
export function contextTokens(threadId: string, dbPath: string = t3StateDbPath()): number | null {
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .query(
        "select json_extract(payload_json, '$.tokenUsage.usedTokens') as used from orchestration_v2_projection_provider_turns where thread_id = ? order by rowid desc limit 1",
      )
      .get(threadId) as { used: unknown } | null;
    const used = row?.used;
    return typeof used === "number" && Number.isFinite(used) ? used : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** What the tick queues into a run it is about to end. Pure. */
export function roleNoteRequestMessage(team: string, role: TeamRole, reason: "idle" | "context"): string {
  const why =
    reason === "idle"
      ? "it has had nothing to do for 15 minutes"
      : `its context has passed ${ROLE_CONTEXT_END_TOKENS / 1000}k tokens`;
  return [
    `ob is ending this ${team} ${role} run: ${why}.`,
    "",
    `Write your successor note now: \`ob role note ${team} ${role} --body-file <file>\`. Put in only what the next run needs and cannot read in ob (what you were in the middle of, what you were about to do, what you learned). The next run's start brief shows it.`,
    "",
    "Then end your turn. Do not start new work: this thread is settled once the note is stored.",
  ].join("\n");
}

/** What the pass did with one run. */
export interface EndPassResult {
  role: TeamRole;
  run_id: number;
  thread_id: string | null;
  result: "kept" | "ended" | "skipped" | "no-note" | "error";
  reason: string;
  end_reason: RoleRunEndReason | null;
  note_lines: number | null;
  context_tokens: number | null;
  /** True when the context size could not be read for this run's thread. */
  context_unknown: boolean;
}

/** The pass's seams: the clock, the sleep, the context reader and the night lock. */
export interface EndPassDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  contextTokens?: (threadId: string) => number | null;
  nightLocked: boolean;
  noteWaitMs?: number;
  pollMs?: number;
  /** Runs this pass's delivery just queued into: kept without a check, since T3 may not show the new turn yet. */
  justDelivered?: ReadonlySet<number>;
}

function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

interface Due {
  run: RoleRun;
  reason: "idle" | "context";
  noteBefore: string | null;
  result: EndPassResult;
}

/**
 * The end pass over a team's open role runs: check each, ask every run due to end for its note, wait for the notes
 * together (at most `noteWaitMs` in all), then end each run that wrote one. A run with no open runs makes no T3 call.
 */
export async function endPass(
  backend: RoleBackend,
  inbox: Pick<InboxBackend, "list">,
  seam: () => Promise<T3Seam>,
  team: string,
  deps: EndPassDeps,
): Promise<EndPassResult[]> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const readContext = deps.contextTokens ?? ((id: string) => contextTokens(id));
  const runs = await backend.open(team);
  if (runs.length === 0) return [];
  const { endRoleRun } = await import("./commands/role.ts");
  const local = t3BaseUrl();
  const results: EndPassResult[] = [];
  const due: Due[] = [];
  let s: T3Seam | null = null;

  for (const run of runs) {
    const r: EndPassResult = { role: run.role, run_id: run.id, thread_id: run.thread_id, result: "kept", reason: "", end_reason: null, note_lines: null, context_tokens: null, context_unknown: false };
    results.push(r);
    if (run.t3_host !== local) {
      r.result = "skipped";
      r.reason = `run on ${run.t3_host}`;
      continue;
    }
    if (!run.thread_id) {
      r.reason = "its thread is still launching";
      continue;
    }
    if (deps.justDelivered?.has(run.id)) {
      r.reason = "messages were just delivered to it";
      continue;
    }
    try {
      s ??= await seam();
      let read: Awaited<ReturnType<T3Seam["read"]>>;
      try {
        read = await s.read(run.thread_id, { afterPosition: PAST_THE_END, limit: 1 });
      } catch (err) {
        if (!(err instanceof T3Error && err.kind === "refused")) throw err;
        // T3 no longer knows the thread: the run ends as gone, with nothing to settle or ask.
        await endRoleRun(backend, team, run, "gone", null);
        r.result = "ended";
        r.end_reason = "gone";
        r.reason = `thread ${run.thread_id} is gone`;
        continue;
      }
      let queued: number | null;
      try {
        queued = (await s.queue(run.thread_id)).items.length;
      } catch {
        queued = null;
      }
      const tokens = readContext(run.thread_id);
      r.context_tokens = tokens;
      r.context_unknown = tokens === null;
      await backend.update(team, run.id, {
        context_tokens: tokens,
        ...(read.thread.itemCount === undefined ? {} : { item_count: read.thread.itemCount }),
        ...(read.thread.updatedAt ? { last_activity_at: read.thread.updatedAt } : {}),
      });
      const unread = deps.nightLocked ? 0 : (await inbox.list(team, run.role, false)).length;
      const verdict = endCheck(
        {
          thread: read.thread,
          queued,
          lastCompletedAt: newestCompletedAt(read.recentRuns ?? []),
          startedAt: run.started_at,
          unread,
          contextTokens: tokens,
          nightLocked: deps.nightLocked,
        },
        new Date(now()),
      );
      if ("keep" in verdict) {
        r.reason = verdict.keep;
        continue;
      }
      if (read.thread.settled || read.thread.archived) {
        await endRoleRun(backend, team, run, verdict.end, null);
        r.result = "ended";
        r.end_reason = verdict.end;
        r.reason = `thread ${run.thread_id} was already ${read.thread.archived ? "archived" : "settled"}`;
        continue;
      }
      await s.send({ threadId: run.thread_id, message: roleNoteRequestMessage(team, run.role, verdict.end), mode: "queue", clientRequestId: `ob-role-end-${run.id}-${now()}` });
      due.push({ run, reason: verdict.end, noteBefore: run.note_at, result: r });
    } catch (err) {
      r.result = "error";
      r.reason = oneLine(err);
    }
  }
  if (due.length === 0) return results;

  // One wait for every run asked: poll the open runs' notes until each has a new one, or the time is up.
  const waitMs = deps.noteWaitMs ?? ROLE_NOTE_WAIT_MS;
  const pollMs = deps.pollMs ?? ROLE_NOTE_POLL_MS;
  const start = now();
  const noted = new Map<number, RoleRun>();
  for (;;) {
    const open = await backend.open(team);
    for (const d of due) {
      if (noted.has(d.run.id)) continue;
      const cur = open.find((o) => o.id === d.run.id);
      if (cur && cur.note_at && cur.note_at !== d.noteBefore && cur.successor_note) noted.set(d.run.id, cur);
    }
    if (noted.size === due.length || now() - start >= waitMs) break;
    await sleep(pollMs);
  }

  for (const d of due) {
    if (noted.has(d.run.id)) continue;
    d.result.result = "no-note";
    d.result.reason = `no note within ${Math.round(waitMs / 60_000)}m, run kept`;
  }
  const ending = due.filter((d) => noted.has(d.run.id));
  // Let every noted run finish its note turn, together (not one after another), before the settles.
  await Promise.all(ending.map((d) => s!.wait(d.run.thread_id!, ROLE_END_IDLE_WAIT_MS).catch(() => null)));
  for (const d of ending) {
    const cur = noted.get(d.run.id)!;
    try {
      // the settle retries on the run ending, and says why when it cannot
      await endRoleRun(backend, team, cur, d.reason, s, { retrySettle: true });
      d.result.result = "ended";
      d.result.end_reason = d.reason;
      d.result.note_lines = roleNoteLines(cur.successor_note!);
      d.result.reason = "";
    } catch (err) {
      d.result.result = "error";
      d.result.reason = oneLine(err);
    }
  }
  return results;
}

/** The lines for what the pass did with a run: the result, and `context unknown` when the size could not be read. Pure. */
export function renderEndResult(team: string, r: EndPassResult): string[] {
  const lines: string[] = [];
  if (r.context_unknown && r.thread_id) lines.push(`role tick ${team} ${r.role}: context unknown for ${r.thread_id}`);
  const head = `role tick ${team} ${r.role}`;
  if (r.result === "skipped") lines.push(`skip ${team} ${r.role}: ${r.reason}`);
  else if (r.result === "ended") {
    const note = r.note_lines === null ? (r.reason ? `; ${r.reason}` : "") : `, note ${plural(r.note_lines, "line")}`;
    lines.push(`${head}: run ${r.run_id} ended (${r.end_reason})${note}`);
  } else if (r.result === "no-note") lines.push(`${head}: ${r.reason}`);
  else if (r.result === "error") lines.push(`${head}: run ${r.run_id} not checked (${r.reason})`);
  else lines.push(`${head}: kept (${r.reason})`);
  return lines;
}

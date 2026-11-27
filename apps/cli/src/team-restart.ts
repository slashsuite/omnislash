// OB-2257: `ob t3 team restart`. A team thread past about 1,000 items is slow to read, so the owner restarts it:
// ob asks the old thread for its handoff, holds it (`team_handoff`), settles the old thread, opens a fresh one in
// its seat and seeds it with the handoff so it carries on with the work. One role at a time, in role order.
//
// The T3 seam, the store and the clock are all passed in, so the whole procedure runs against fakes in tests.
import { T3_LIVE_STATUSES, type T3Thread } from "./t3/client.ts";
import { T3_THREAD_ENV } from "../../../platform/cli-coord/src/lease-wait-title.ts";
import {
  ensureTeamThread,
  readThreadHeader,
  teamHandoffRequestMessage,
  teamRestartSeedMessage,
  type AgentRegistry,
  type T3Seam,
} from "./t3/dispatch.ts";
import { teamRoleAgentId, teamThreadIdOf, TEAM_ROLES, type TeamRole, type TeamView } from "./team.ts";
import type { HandoffFilter, TeamHandoff } from "./team-handoff.ts";
import { teamRoleModelFrom } from "./model-routes-io.ts";
import type { ConfigIO } from "./review-readers.ts";

/** `{ roleModel }` for ensureTeamThread when route role.<role> names one, else nothing (the project default). */
export async function roleModelFor(io: ConfigIO | undefined, role: TeamRole): Promise<{ roleModel?: string }> {
  const model = await teamRoleModelFrom(io ?? null, role);
  return model ? { roleModel: model } : {};
}

/** The store half a restart reads and writes: the team, its role rows and its handoffs. */
export interface RestartBackend {
  show(name: string): Promise<TeamView | null>;
  list(): Promise<TeamView[]>;
  registry: AgentRegistry;
  /**
   * The role's newest handoff. `from` keeps only the ones that thread wrote, `createdBefore` only the ones recorded
   * at or before that moment (OB-2275).
   */
  handoffLatest(team: string, role: TeamRole, filter?: HandoffFilter): Promise<TeamHandoff | null>;
  handoffConsume(team: string, id: number, newThreadId: string): Promise<void>;
  /** Where a new thread opens when the old thread's T3 project cannot be read: the cwd's checkout. */
  cwdRepo(): Promise<string>;
  /** OS-145: the config `model_routes` is read from (absent: this machine's models file and the defaults only). */
  configIo?: ConfigIO;
}

export interface RestartOptions {
  seam: T3Seam;
  /** Only these roles; all three (those bound) when absent. */
  roles?: readonly TeamRole[];
  /** Interrupt a busy thread instead of skipping it. */
  force?: boolean;
  /** How long to wait for the old thread's handoff (default 15 minutes). */
  timeoutMs?: number;
  /** The caller's own thread, never restarted, even under --force. Defaults to `T3CODE_THREAD_ID`. */
  self?: string | null;
  /** One progress line: the role steps and the heartbeat while waiting. */
  log: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often the handoff is polled for (default 5s), and how often a heartbeat line is printed (default 60s). */
  pollMs?: number;
  heartbeatMs?: number;
  /**
   * OS-212: how long the retire step waits for the old thread's turn to end before it settles it (default 10 minutes).
   * The old thread's handoff turn, then its turn answering the retired notice, must end first: T3 refuses a settle
   * while a run is live.
   */
  retireTimeoutMs?: number;
}

export const RESTART_DEFAULT_TIMEOUT_MS = 15 * 60_000;
const RETIRE_DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** The first words of the retired notice, so a re-run's move can tell one still queued (OS-249). */
const RETIRED_NOTICE_PREFIX = "This thread is retired: the current ";

/**
 * OS-212: the line a retired seat thread is sent before it is settled, so whoever opens it later sees where the seat
 * went. The link is T3's documented shape for handing a human a thread. Pure.
 */
function retiredNoticeMessage(team: string, role: TeamRole, newThreadId: string, title: string): string {
  return [
    `${RETIRED_NOTICE_PREFIX}${team} ${role} is [${title}](t3-thread://v1/${newThreadId}).`,
    "",
    "Do no more work here and run nothing: reply with the one word `retired` and end your turn. ob settles this thread next.",
    `Anything meant for this seat goes to the current thread: \`ob t3 team forward ${team} --role ${role} --body-file <file>\`.`,
  ].join("\n");
}

/** The request id of a retired notice: one per retired thread, so a re-run that sends it again is one delivery. Pure. */
function retiredNoticeRequestId(oldThreadId: string): string {
  return `ob-retired-${oldThreadId}`;
}

type SettleWhenIdleOutcome = { settled: true; error: null } | { settled: false; error: string };

/**
 * OS-212: settle a thread once its turn has ended, waiting (bounded) for that. T3 refuses a settle while a run is live
 * ("Thread … is still running"), and a handoff turn, or the turn a notice starts, can run for minutes; the old fixed
 * retry window ran out first and failed the pass. This polls the header: a live run, or a message still queued, is waited out,
 * an idle thread is settled, and a refused settle is tried again on the next poll until `timeoutMs`. Never throws.
 */
async function settleWhenIdle(
  seam: Pick<T3Seam, "read" | "settle" | "queue">,
  threadId: string,
  opts: { timeoutMs: number; pollMs: number; now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<SettleWhenIdleOutcome> {
  const start = opts.now();
  let error = "its turn did not end";
  for (;;) {
    let busy = false;
    try {
      const t = await readThreadHeader(seam, threadId);
      if (t.settled) return { settled: true, error: null };
      busy = (T3_LIVE_STATUSES as readonly string[]).includes(t.status) || !!t.activeRunId;
      if (busy) error = `its turn was still running (${t.status})`;
      else if ((await seam.queue(threadId)).items.length > 0) {
        // A queued message (the retired notice, or one sent meanwhile) would start a run and unsettle it again.
        busy = true;
        error = "it still held queued messages";
      }
    } catch (err) {
      // Unread is not idle: settling blind could settle over a queued notice that then unsettles it. Poll again.
      busy = true;
      error = `its header or queue could not be read: ${(err as Error).message}`;
    }
    if (!busy) {
      try {
        await seam.settle(threadId);
        return { settled: true, error: null };
      } catch (err) {
        error = (err as Error).message;
      }
    }
    if (opts.now() - start >= opts.timeoutMs) return { settled: false, error: `${error}, after waiting ${minutes(opts.timeoutMs)}` };
    await opts.sleep(opts.pollMs);
  }
}

/**
 * OS-212: move what a retiring thread still holds queued to the seat's current thread, then withdraw it there, so a
 * message sent to the old seat is neither lost nor run by a thread that no longer holds it. Returns one line per
 * problem; never throws.
 *
 * OS-249: a queued handoff request (`handoffAsk`, the text step (b) sends) is withdrawn and never moved. One is still
 * queued when a second restart asked the same thread, or a --force re-run asked again; moved, it would tell the
 * replacement to hand off and delete its own scheduled tasks. TLC found this (model/TeamRestart.tla, NoStrayHandoff).
 * A queued retired notice stays where it is: an earlier run's notice is still queued when its settle ran out and a
 * re-run resumes the retire, and moved, it would tell the seat's current thread it is retired (NoNoticeToSeat).
 */
async function moveQueuedMessages(seam: T3Seam, fromThreadId: string, toThreadId: string, handoffAsk: string): Promise<{ moved: number; problems: string[] }> {
  const problems: string[] = [];
  let moved = 0;
  let items: Awaited<ReturnType<T3Seam["queue"]>>["items"];
  try {
    items = (await seam.queue(fromThreadId)).items;
  } catch (err) {
    return { moved, problems: [`could not read ${fromThreadId}'s queue (${(err as Error).message}); anything it holds stays there`] };
  }
  for (const m of items) {
    if (m.text === handoffAsk) {
      try {
        await seam.queueCancel(fromThreadId, m.queuedRunId);
      } catch (err) {
        problems.push(`queued handoff request ${m.queuedRunId} was not withdrawn from ${fromThreadId} (${(err as Error).message})`);
      }
      continue;
    }
    if (m.text.startsWith(RETIRED_NOTICE_PREFIX)) continue;
    if (m.truncated) {
      // T3 read it back cut short: it stays queued whole, and the retired thread forwards it (its skill says so).
      problems.push(`queued message ${m.queuedRunId} is longer than T3's queue read: left queued in ${fromThreadId}, which forwards it`);
      continue;
    }
    try {
      await seam.send({
        threadId: toThreadId,
        message: `Moved from the retired thread ${fromThreadId}:\n\n${m.text}`,
        mode: "queue",
        clientRequestId: `ob-retired-move-${fromThreadId}-${m.queuedRunId}`,
      });
    } catch (err) {
      problems.push(`queued message ${m.queuedRunId} was not moved to ${toThreadId} (${(err as Error).message}); it stays queued in ${fromThreadId}`);
      continue;
    }
    try {
      await seam.queueCancel(fromThreadId, m.queuedRunId);
      moved++;
    } catch (err) {
      problems.push(`queued message ${m.queuedRunId} was copied to ${toThreadId} but not withdrawn from ${fromThreadId} (${(err as Error).message})`);
    }
  }
  return { moved, problems };
}

export type RoleRestartOutcome = {
  team: string;
  role: TeamRole;
  oldThreadId: string | null;
  /**
   * `restarted`: a new thread is bound and seeded. `skipped`: nothing changed (the reason says why).
   * `failed`: a step broke part way; the reason says what stands and that a re-run resumes.
   */
  result: "restarted" | "skipped" | "failed";
  reason: string | null;
  newThreadId: string | null;
  handoffId: number | null;
  /** True for the one skip that is not a problem: the team has no thread in this role. */
  unbound?: boolean;
};

/** Why a live thread may not be disturbed, or null when it is idle. Pure. */
export function busyReason(thread: Pick<T3Thread, "status" | "pendingRequestCount" | "activeRunId">, queued: number | null): string | null {
  if ((thread.pendingRequestCount ?? 0) > 0) return `it has ${thread.pendingRequestCount} pending request(s) waiting on the owner`;
  if ((T3_LIVE_STATUSES as readonly string[]).includes(thread.status) || thread.activeRunId) return `it has a run in flight (${thread.status})`;
  if (queued === null) return "its queue could not be read, so it may be holding messages";
  if (queued > 0) return `it holds ${queued} queued message(s)`;
  return null;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)}m`;
}

/** The T3 project root the old thread lives in, so its replacement opens in the same project. */
async function repoPathFor(seam: T3Seam, old: T3Thread | null, backend: RestartBackend): Promise<string> {
  if (old) {
    try {
      const p = (await seam.projects()).find((x) => x.id === old.projectId && !x.deletedAt);
      if (p) return p.workspaceRoot;
    } catch {
      // fall back to the cwd's checkout below
    }
  }
  return backend.cwdRepo();
}

/** Read a thread's header; null when T3 no longer has it live (settled, archived, unknown). */
async function liveHeader(seam: T3Seam, threadId: string): Promise<{ thread: T3Thread | null; live: boolean }> {
  try {
    const thread = await readThreadHeader(seam, threadId);
    return { thread, live: !thread.settled && !thread.archived };
  } catch {
    return { thread: null, live: false };
  }
}

/** The message a late handoff is forwarded with (OB-2275). Pure. */
export function lateHandoffMessage(h: Pick<TeamHandoff, "id" | "body" | "old_thread_id">): string {
  return `Late report from replaced thread ${h.old_thread_id ?? "(unknown)"}, handoff ${h.id}:\n\n${h.body}`;
}

export type LateHandoffOutcome =
  /** The writer is the bound thread, no sender is known, or the role has no thread: nothing to forward. */
  | { kind: "kept" }
  | { kind: "forwarded"; boundThreadId: string }
  | { kind: "failed"; boundThreadId: string; reason: string };

/**
 * OB-2275: a handoff written by a thread that is no longer the role's bound thread (a replaced thread still
 * reporting) is queued to the bound thread and marked consumed with its id at once, so it is never stranded and
 * never seeds a later restart. A failed send leaves it unconsumed; a failed consume says so (the restart guard
 * still never seeds it, since its writer is not the thread a restart replaces).
 */
export async function forwardLateHandoff(
  backend: Pick<RestartBackend, "registry" | "handoffConsume">,
  h: TeamHandoff,
  sender: string | null,
  seam: () => Promise<T3Seam>,
): Promise<LateHandoffOutcome> {
  if (!sender) return { kind: "kept" };
  const bound = teamThreadIdOf(await backend.registry.read(teamRoleAgentId(h.team, h.role)));
  if (!bound || bound === sender) return { kind: "kept" };
  try {
    await (await seam()).send({ threadId: bound, message: lateHandoffMessage(h), mode: "queue", clientRequestId: `ob-late-handoff-${bound}-${h.id}` });
  } catch (err) {
    return { kind: "failed", boundThreadId: bound, reason: `handoff ${h.id} was recorded but not forwarded to ${bound}: ${(err as Error).message}` };
  }
  try {
    await backend.handoffConsume(h.team, h.id, bound);
  } catch (err) {
    return { kind: "failed", boundThreadId: bound, reason: `forwarded to ${bound}, but handoff ${h.id} was not marked consumed: ${(err as Error).message}` };
  }
  return { kind: "forwarded", boundThreadId: bound };
}

type RetireOptions = {
  team: string;
  role: TeamRole;
  oldThreadId: string;
  newThreadId: string;
  title: string;
  log: (line: string) => void;
  timeoutMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/**
 * OS-212: retire a seat thread that is still live, once its replacement holds the seat: move what it holds queued to
 * the replacement, post the retired notice (a link to the replacement), settle it once its turn has ended, unpin it.
 * Never throws; `settled: false` names why.
 */
async function retireThread(seam: T3Seam, o: RetireOptions): Promise<SettleWhenIdleOutcome> {
  const moved = await moveQueuedMessages(seam, o.oldThreadId, o.newThreadId, teamHandoffRequestMessage(o.team, o.role));
  if (moved.moved) o.log(`moved ${moved.moved} queued message(s) from ${o.oldThreadId} to ${o.newThreadId}`);
  for (const p of moved.problems) o.log(p);
  try {
    await seam.send({
      threadId: o.oldThreadId,
      message: retiredNoticeMessage(o.team, o.role, o.newThreadId, o.title),
      mode: "queue",
      clientRequestId: retiredNoticeRequestId(o.oldThreadId),
    });
    o.log(`told ${o.oldThreadId} it is retired and where the seat went`);
  } catch (err) {
    o.log(`the retired notice did not reach ${o.oldThreadId} (${(err as Error).message}); settling it anyway`);
  }
  const settled = await settleWhenIdle(seam, o.oldThreadId, o);
  if (settled.settled) await unpinQuietly(seam, o.oldThreadId, o.log);
  return settled;
}

/** Take a thread off the pinned list; a refusal is a log line, never a failure. */
async function unpinQuietly(seam: T3Seam, threadId: string, log: (line: string) => void): Promise<void> {
  try {
    await seam.unpin(threadId);
  } catch (err) {
    log(`${threadId} was not unpinned (${(err as Error).message})`);
  }
}

/** The outcome of finishing the retirement of a seat's previous thread, the current one already bound. */
async function finishRetiring(
  seam: T3Seam,
  o: Omit<RetireOptions, "oldThreadId" | "newThreadId" | "title"> & { retiredId: string; current: T3Thread; handoffId: number },
): Promise<Omit<RoleRestartOutcome, "team" | "role">> {
  const live = (await liveHeader(seam, o.retiredId)).live;
  let r: SettleWhenIdleOutcome = { settled: true, error: null };
  if (live) r = await retireThread(seam, { ...o, oldThreadId: o.retiredId, newThreadId: o.current.threadId, title: o.current.title });
  else await unpinQuietly(seam, o.retiredId, o.log);
  const base = { oldThreadId: o.retiredId, newThreadId: o.current.threadId, handoffId: o.handoffId };
  if (!r.settled) {
    return { ...base, result: "failed", reason: `${o.current.threadId} holds the seat, but the retired thread ${o.retiredId} would not settle (${r.error}); re-run to finish retiring it` };
  }
  return { ...base, result: "restarted", reason: `already replaced by ${o.current.threadId}; ${o.retiredId} retired${live ? " and settled" : ""}` };
}

/** Restart one role of one team. Never throws for a T3 or store failure: it is a `failed` outcome naming it. */
export async function restartTeamRole(backend: RestartBackend, team: TeamView, role: TeamRole, opts: RestartOptions): Promise<RoleRestartOutcome> {
  const { seam, log } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 5_000;
  const retireTimeoutMs = opts.retireTimeoutMs ?? RETIRE_DEFAULT_TIMEOUT_MS;
  const label = `${team.name} ${role}`;
  const roleLog = (l: string) => log(`${label}: ${l}`);
  const agentId = teamRoleAgentId(team.name, role);
  const out = (o: Omit<RoleRestartOutcome, "team" | "role">): RoleRestartOutcome => {
    log(`${label}: ${o.result}${o.reason ? `: ${o.reason}` : ""}`);
    return { team: team.name, role, ...o };
  };

  let oldThreadId: string | null = null;
  let handoff: TeamHandoff | null = null;
  let oldThread: T3Thread | null = null;
  /** True when the old thread was live at the start, so it is told where the seat went and settled; false on a resume. */
  let liveOld = false;
  /** When the wait for the old thread's turn began: (d) and the settle in (g) share one `retireTimeoutMs`. */
  let retireStart = 0;
  const self = opts.self === undefined ? process.env[T3_THREAD_ENV]?.trim() || null : opts.self;
  try {
    oldThreadId = teamThreadIdOf(await backend.registry.read(agentId));
    if (!oldThreadId) {
      return out({ oldThreadId: null, result: "skipped", reason: `no thread is bound (add one with \`ob t3 ${role} ${team.name}\`)`, newThreadId: null, handoffId: null, unbound: true });
    }
    if (self && self === oldThreadId) {
      // Even --force: interrupting the caller's own turn kills the shell running this command.
      return out({ oldThreadId, result: "skipped", reason: `thread ${oldThreadId} is the thread running this command, and a thread cannot restart itself: run it from a terminal or another thread`, newThreadId: null, handoffId: null });
    }
    const head = await liveHeader(seam, oldThreadId);
    oldThread = head.thread;
    // The NEWEST handoff, taken as pending only when it was never seeded: an older one left unconsumed (recorded
    // late, after a timed-out run) is history, never a reason to skip asking. OB-2275: a late report a replaced
    // thread sends after its replacement opened is forwarded and consumed but is still a row, so each check reads
    // only the rows it is about, or that report would hide the handoff it is looking for.
    const unseeded = (h: TeamHandoff | null) => (h && !h.consumed_at ? h : null);
    // (1) the seed for the bound thread itself: the newest handoff recorded at or before the bound thread opened.
    const seedFor = oldThread?.createdAt ? unseeded(await backend.handoffLatest(team.name, role, { createdBefore: oldThread.createdAt })) : null;
    // (2) a handoff the bound thread wrote: only that one seeds its replacement.
    const ownPending = unseeded(await backend.handoffLatest(team.name, role, { from: oldThreadId }));

    const replaced = seedFor?.old_thread_id;
    if (seedFor && replaced && replaced !== oldThreadId && head.live) {
      // A re-run after the seed went out but the retire or the consume did not finish: the bound thread, opened after
      // the handoff, is already the replacement. (A thread bound by hand before it is not, and is restarted as usual.)
      // OS-212: the old thread is retired first; the handoff is consumed only once it has settled, so a re-run after a
      // failed settle lands here again.
      const done = await finishRetiring(seam, { team: team.name, role, retiredId: replaced, current: oldThread!, handoffId: seedFor.id, log: roleLog, timeoutMs: retireTimeoutMs, pollMs, now, sleep });
      if (done.result === "restarted") {
        await backend.handoffConsume(team.name, seedFor.id, oldThreadId);
        roleLog(`handoff ${seedFor.id} marked consumed: ${oldThreadId} already replaced ${replaced}`);
      }
      return out(done);
    }

    if (ownPending && ownPending.old_thread_id === oldThreadId && !head.live) {
      // A re-run after the old thread was settled but before its replacement was seeded: resume from the handoff.
      log(`${label}: resuming: ${oldThreadId} is settled and its handoff ${ownPending.id} was not yet seeded`);
      handoff = ownPending;
    } else if (!head.live) {
      return out({ oldThreadId, result: "skipped", reason: `thread ${oldThreadId} is not live and left no handoff; open a new one with \`ob t3 ${role} ${team.name}\``, newThreadId: null, handoffId: null });
    } else {
      // (a) a thread mid-run, waiting on the owner or holding messages is not disturbed, unless --force.
      let queued: number | null;
      try {
        queued = (await seam.queue(oldThreadId)).items.length;
      } catch {
        queued = null;
      }
      const busy = busyReason(oldThread!, queued);
      if (busy && !opts.force) {
        return out({
          oldThreadId,
          result: "skipped",
          reason: `thread ${oldThreadId} is busy: ${busy}; re-run with --force to interrupt it (a thread cannot restart itself: run this from a terminal or another thread)`,
          newThreadId: null,
          handoffId: null,
        });
      }
      if (busy) {
        log(`${label}: --force: interrupting ${oldThreadId} (${busy})`);
        try {
          await seam.interrupt(oldThreadId);
        } catch (err) {
          log(`${label}: the interrupt was refused (${(err as Error).message}); asking for the handoff anyway`);
        }
      }

      // (b) ask for the handoff, queued so it lands after anything already in flight.
      const before = (await backend.handoffLatest(team.name, role, { from: oldThreadId }))?.id ?? 0;
      await seam.send({ threadId: oldThreadId, message: teamHandoffRequestMessage(team.name, role), mode: "queue" });
      log(`${label}: asked ${oldThreadId} for its handoff`);

      // (c) wait for a handoff newer than the ask, with a heartbeat line each minute.
      const timeoutMs = opts.timeoutMs ?? RESTART_DEFAULT_TIMEOUT_MS;
      const heartbeatMs = opts.heartbeatMs ?? 60_000;
      const start = now();
      let nextBeat = start + heartbeatMs;
      for (;;) {
        // OB-2275: the newest handoff the thread being replaced wrote; a late report from an earlier replaced thread
        // is forwarded by its own command, never seeded. (The writer check also holds against a server that
        // ignores `from`.)
        const latest = await backend.handoffLatest(team.name, role, { from: oldThreadId });
        if (latest && latest.id > before && latest.old_thread_id === oldThreadId) {
          handoff = latest;
          break;
        }
        const t = now();
        if (t - start >= timeoutMs) {
          return out({
            oldThreadId,
            result: "skipped",
            reason: `no handoff from ${oldThreadId} within ${minutes(timeoutMs)}; it stays bound and pinned (re-run, or raise --timeout)`,
            newThreadId: null,
            handoffId: null,
          });
        }
        if (t >= nextBeat) {
          log(`${label}: ${new Date(t).toISOString()} waiting for the handoff from ${oldThreadId} (${minutes(t - start)} of ${minutes(timeoutMs)})`);
          nextBeat += heartbeatMs;
        }
        await sleep(pollMs);
      }
      log(`${label}: handoff ${handoff.id} recorded (${handoff.body.length} characters)`);

      // (d) let the old thread finish its handoff turn (bounded), so a handoff it rewrites in that turn is the one seeded.
      retireStart = now();
      try {
        await seam.wait(oldThreadId, retireTimeoutMs);
      } catch {
        // the retire step below waits for the turn again, and says why when it cannot settle
      }
      // OB-2275: the thread may have written again before its turn ended (a rewrite, a late report); the replacement is
      // seeded with, and consumes, the newest one, so none is left behind to read as a seed later.
      const last = await backend.handoffLatest(team.name, role, { from: oldThreadId });
      if (last && last.id > handoff.id && !last.consumed_at) {
        roleLog(`${oldThreadId} wrote handoff ${last.id} after ${handoff.id}; seeding with the newer one`);
        handoff = last;
      }
      liveOld = true;
    }

    // (e) open the replacement in the same T3 project (bound, titled, pinned, auto-settle off), (f) seeded with the handoff.
    // OS-212: it opens BEFORE the old thread is settled, so the old one can be told where the seat went; binding the
    // new thread is what retires the old one, so the seat never has two threads.
    const repoPath = await repoPathFor(seam, oldThread, backend);
    const outcome = await ensureTeamThread(backend.registry, {
      team,
      role,
      members: team.members,
      repoPath,
      seam,
      seedMessage: teamRestartSeedMessage(team.name, role, team.members, repoPath, { body: handoff.body, oldThreadId }),
      replacing: oldThreadId,
      ...(await roleModelFor(backend.configIo, role)),
    });
    if (!outcome.created) {
      return out({ oldThreadId, result: "failed", reason: `no new thread was opened (${outcome.message}); handoff ${handoff.id} stays held, re-run to resume`, newThreadId: null, handoffId: handoff.id });
    }
    if (outcome.autoSettleWarning) log(`${label}: ${outcome.autoSettleWarning}`);

    // (g) retire the old thread: move what it holds queued, tell it where the seat went, settle it once its turn has
    // ended, unpin it. A thread already settled (a resumed run) is only unpinned: a message would unsettle it.
    let retired: SettleWhenIdleOutcome = { settled: true, error: null };
    if (liveOld) {
      const timeoutMs = Math.max(0, retireTimeoutMs - (now() - retireStart));
      retired = await retireThread(seam, { team: team.name, role, oldThreadId, newThreadId: outcome.threadId, title: outcome.title, log: roleLog, timeoutMs, pollMs, now, sleep });
    } else {
      await unpinQuietly(seam, oldThreadId, roleLog);
    }
    // (h) the handoff is consumed only once the old thread is retired, so a re-run after a failed settle resumes the retire.
    if (retired.settled) {
      try {
        await backend.handoffConsume(team.name, handoff.id, outcome.threadId);
      } catch (err) {
        log(`${label}: the seed went out, but handoff ${handoff.id} was not marked consumed (${(err as Error).message}); a re-run marks it`);
      }
    }
    if (!retired.settled) {
      return out({
        oldThreadId,
        result: "failed",
        reason: `${outcome.threadId} holds the seat (seeded with handoff ${handoff.id}), but the retired thread ${oldThreadId} would not settle (${retired.error}); re-run to finish retiring it`,
        newThreadId: outcome.threadId,
        handoffId: handoff.id,
      });
    }
    return out({
      oldThreadId,
      result: "restarted",
      reason: `${oldThreadId} → ${outcome.threadId} ('${outcome.title}', pinned, seeded with handoff ${handoff.id}); ${oldThreadId} retired and settled`,
      newThreadId: outcome.threadId,
      handoffId: handoff.id,
    });
  } catch (err) {
    const held = handoff ? `; handoff ${handoff.id} stays held, re-run to resume` : "";
    return out({ oldThreadId, result: "failed", reason: `${(err as Error).message}${held}`, newThreadId: null, handoffId: handoff?.id ?? null });
  }
}

/** Restart the roles of the named teams, one role at a time, architect first. */
export async function restartTeams(backend: RestartBackend, teams: readonly TeamView[], opts: RestartOptions): Promise<RoleRestartOutcome[]> {
  const roles = TEAM_ROLES.filter((r) => !opts.roles || opts.roles.includes(r));
  const outcomes: RoleRestartOutcome[] = [];
  for (const team of teams) {
    for (const role of roles) {
      // Re-read the team each role: an earlier role's restart rebinds a row.
      const fresh = (await backend.show(team.name)) ?? team;
      outcomes.push(await restartTeamRole(backend, fresh, role, opts));
    }
  }
  return outcomes;
}

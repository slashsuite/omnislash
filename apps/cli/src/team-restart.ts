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
  settleThreadWithRetry,
  teamHandoffRequestMessage,
  teamRestartSeedMessage,
  type AgentRegistry,
  type T3Seam,
} from "./t3/dispatch.ts";
import { teamRoleAgentId, teamThreadIdOf, TEAM_ROLES, type TeamRole, type TeamView } from "./team.ts";
import type { HandoffFilter, TeamHandoff } from "./team-handoff.ts";

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
  /**
   * OB-2275: the T3 thread ids of the spinoff rows at `building` that a member project of the team built (the rows
   * `ob spinoff list --team` keeps), so a restart can tell them a role's new thread.
   */
  buildingThreads(team: TeamView): Promise<string[]>;
  /** Where a new thread opens when the old thread's T3 project cannot be read: the cwd's checkout. */
  cwdRepo(): Promise<string>;
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
}

export const RESTART_DEFAULT_TIMEOUT_MS = 15 * 60_000;
const IDLE_WAIT_MS = 5 * 60_000;

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

/** The one queued line a restart sends the rest of the team (OB-2275). Pure. */
export function teamMovedMessage(team: string, role: TeamRole, oldThreadId: string, newThreadId: string): string {
  return `${team} ${role} moved to thread ${newThreadId} (was ${oldThreadId}). Send to ${newThreadId} from now on.`;
}

/**
 * OB-2275: after a role is replaced, queue the moved line to each other role thread of the team and each building
 * spinoff thread of its projects that T3 has live, never to the caller, the replaced thread or the new one. A
 * failed read or send is one log line and a name in the returned list; it never fails the restart.
 */
export async function tellTeamMoved(
  backend: RestartBackend,
  team: TeamView,
  role: TeamRole,
  ids: { oldThreadId: string; newThreadId: string; self: string | null },
  seam: T3Seam,
  log: (line: string) => void,
): Promise<{ told: string[]; failed: string[] }> {
  const label = `${team.name} ${role}`;
  const skip = new Set([ids.oldThreadId, ids.newThreadId, ...(ids.self ? [ids.self] : [])]);
  const targets: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && !skip.has(id) && !targets.includes(id)) targets.push(id);
  };
  for (const t of team.threads) if (t.role !== role) add(t.thread_id);
  try {
    for (const id of await backend.buildingThreads(team)) add(id);
  } catch (err) {
    log(`${label}: could not read the team's building spinoffs (${(err as Error).message}); they were not told the new thread`);
  }
  const message = teamMovedMessage(team.name, role, ids.oldThreadId, ids.newThreadId);
  const told: string[] = [];
  const failed: string[] = [];
  for (const id of targets) {
    if (!(await liveHeader(seam, id)).live) continue;
    try {
      await seam.send({ threadId: id, message, mode: "queue", clientRequestId: `ob-team-moved-${team.name}-${role}-${ids.newThreadId}-${id}` });
      told.push(id);
    } catch (err) {
      failed.push(id);
      log(`${label}: could not tell ${id} the new thread (${(err as Error).message})`);
    }
  }
  if (told.length > 0) log(`${label}: told ${told.join(", ")} the new thread`);
  return { told, failed };
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
    await (await seam()).send({ threadId: bound, message: lateHandoffMessage(h), mode: "queue", clientRequestId: `ob-late-handoff-${h.team}-${h.id}` });
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

/** Restart one role of one team. Never throws for a T3 or store failure: it is a `failed` outcome naming it. */
export async function restartTeamRole(backend: RestartBackend, team: TeamView, role: TeamRole, opts: RestartOptions): Promise<RoleRestartOutcome> {
  const { seam, log } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const label = `${team.name} ${role}`;
  const agentId = teamRoleAgentId(team.name, role);
  const out = (o: Omit<RoleRestartOutcome, "team" | "role">): RoleRestartOutcome => {
    log(`${label}: ${o.result}${o.reason ? `: ${o.reason}` : ""}`);
    return { team: team.name, role, ...o };
  };

  let oldThreadId: string | null = null;
  let handoff: TeamHandoff | null = null;
  let oldThread: T3Thread | null = null;
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
      // A re-run after the seed went out but the consume did not: the bound thread, opened after the handoff, is
      // already the replacement. (A thread bound by hand before it is not, and is restarted as usual.)
      await backend.handoffConsume(team.name, seedFor.id, oldThreadId);
      await tellTeamMoved(backend, team, role, { oldThreadId: replaced, newThreadId: oldThreadId, self }, seam, log);
      return out({ oldThreadId: replaced, result: "restarted", reason: `already replaced by ${oldThreadId}; handoff ${seedFor.id} marked consumed`, newThreadId: oldThreadId, handoffId: seedFor.id });
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
      const pollMs = opts.pollMs ?? 5_000;
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

      // (d) let the old thread finish its turn, then settle it and take it off the pinned list.
      try {
        await seam.wait(oldThreadId, IDLE_WAIT_MS);
      } catch {
        // the settle below retries on the run ending, and says why when it cannot
      }
      const settled = await settleThreadWithRetry(seam, oldThreadId);
      if (!settled.settled) {
        return out({
          oldThreadId,
          result: "failed",
          reason: `handoff ${handoff.id} is held, but thread ${oldThreadId} would not settle (${settled.error}); it stays bound. Settle it in T3 and re-run to resume`,
          newThreadId: null,
          handoffId: handoff.id,
        });
      }
      log(`${label}: settled ${oldThreadId}`);
      // OB-2275: the thread may have written again before it settled (a rewrite, a late report); the replacement is
      // seeded with, and consumes, the newest one, so none is left behind to read as a seed later.
      const last = await backend.handoffLatest(team.name, role, { from: oldThreadId });
      if (last && last.id > handoff.id && !last.consumed_at) {
        log(`${label}: ${oldThreadId} wrote handoff ${last.id} after ${handoff.id}; seeding with the newer one`);
        handoff = last;
      }
    }

    try {
      await seam.unpin(oldThreadId);
    } catch (err) {
      log(`${label}: could not unpin ${oldThreadId} (${(err as Error).message}); unpin it by hand`);
    }

    // (e) open the replacement in the same T3 project (bound, titled, pinned, auto-settle off), (f) seeded with the handoff.
    const repoPath = await repoPathFor(seam, oldThread, backend);
    const outcome = await ensureTeamThread(backend.registry, {
      team,
      role,
      members: team.members,
      repoPath,
      seam,
      seedMessage: teamRestartSeedMessage(team.name, role, team.members, repoPath, { body: handoff.body, oldThreadId }),
    });
    if (!outcome.created) {
      return out({ oldThreadId, result: "failed", reason: `no new thread was opened (${outcome.message}); handoff ${handoff.id} stays held, re-run to resume`, newThreadId: null, handoffId: handoff.id });
    }
    if (outcome.autoSettleWarning) log(`${label}: ${outcome.autoSettleWarning}`);
    try {
      await backend.handoffConsume(team.name, handoff.id, outcome.threadId);
    } catch (err) {
      log(`${label}: the seed went out, but handoff ${handoff.id} was not marked consumed (${(err as Error).message}); a re-run marks it`);
    }
    // (g) tell the rest of the team the new id, so nobody keeps sending to the settled one (OB-2275).
    const moved = await tellTeamMoved(backend, team, role, { oldThreadId, newThreadId: outcome.threadId, self }, seam, log);
    const notTold = moved.failed.length > 0 ? `; not told: ${moved.failed.join(", ")}` : "";
    return out({
      oldThreadId,
      result: "restarted",
      reason: `${oldThreadId} → ${outcome.threadId} ('${outcome.title}', pinned, seeded with handoff ${handoff.id})${notTold}`,
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

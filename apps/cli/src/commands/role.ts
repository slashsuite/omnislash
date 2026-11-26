// `ob role start|status|end`: one run per team role (see ../role-run.ts for the record and its guards).
//
// One procedure serves the store and the API client: each passes a `RoleBackend` for the data, and the T3 half (read
// the thread, launch, pin, settle) runs here, where T3 is. A run records the T3 it was opened on (`t3_host`); a machine
// whose T3 is another never reads that run's thread, so it never judges it gone.
import type { Ctx, Flags } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { print, warn, type Mode } from "../output.ts";
import {
  checkRoleNote,
  markRoleNoteShown,
  markRoleRun,
  openRoleRuns,
  parseEndReason,
  roleNoteLines,
  roleRunHolder,
  roleRunLeaseKey,
  updateRoleRun,
  writeRoleNote,
  type RoleRun,
  type RoleRunEndReason,
  type RoleRunPatch,
} from "../role-run.ts";
import { gatherRoleBrief, readPacing, renderRoleBrief, roleBriefStoreFacts, type BriefRow, type RoleBriefFacts, type RoleBriefStoreFacts } from "../role-brief.ts";
import { bodyFromFlags } from "./doc.ts";
import type { Database } from "bun:sqlite";
import type { Store } from "../db/store.ts";
import { markRoleMessagesRead } from "../inbox.ts";
import { pacingSource, t3Cache } from "./usage.ts";
import { resolveRoute } from "../model-routes.ts";
import { loadRouteInputs, storeConfigIo } from "../model-routes-io.ts";
import type { ConfigIO } from "../review-readers.ts";
import { existsSync } from "node:fs";
import { rowVerdictState } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { parseTeamRole } from "../team-handoff.ts";
import { teamRoleAgentId, teamThreadTitle, type TeamRole, type TeamView } from "../team.ts";
import { t3BaseUrl, T3Error } from "../t3/client.ts";
import {
  readTeamThread,
  readThreadHeader,
  resolveModelAndEffort,
  settleThreadWithRetry,
  t3ProjectFor,
  t3Seam,
  teamAutoSettleOff,
  T3_AGENT_TTL_S,
  T3_DEFAULT_RUNTIME_MODE,
  T3_LAUNCHER,
  type AgentRegistry,
  type T3Seam,
} from "../t3/dispatch.ts";
import { refuseUnreadFlags } from "./capture.ts";
import type { TeamBackend } from "./t3-team.ts";
import { storeTeamBackend } from "./t3.ts";
import { runRoleTick, type TickBackend } from "./role-tick.ts";
import { storeInboxBackend } from "./inbox.ts";
import { tickFindings } from "../role-tick.ts";
import { parseJsonMap, storeConflictSource } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { settingFor } from "../settings.ts";

/** Where the runs live: the store on this machine, or the API. The T3 half is the caller's. */
export interface RoleBackend {
  team: Pick<TeamBackend, "show" | "registry" | "cwdRepo" | "dropRow">;
  /** The team's open runs, one role's when `role` is named. An unknown team throws. */
  open(team: string, role?: TeamRole): Promise<RoleRun[]>;
  /** Insert the role's marker and take its lease, or answer the open run (`created` false). */
  mark(team: string, role: TeamRole, t3Host: string): Promise<{ run: RoleRun; created: boolean }>;
  update(team: string, id: number, patch: RoleRunPatch): Promise<RoleRun>;
  /** OS-55: the store half of a brief (a read: the note stays waiting). */
  briefFacts(team: string, role: TeamRole): Promise<RoleBriefStoreFacts>;
  /** OS-55: mark a run's note shown, once a brief or a start delivered it. */
  noteShown(team: string, runId: number): Promise<void>;
  /** OS-55: store the successor note on the role's open run, else its last ended one. */
  note(team: string, role: TeamRole, body: string): Promise<RoleRun>;
  /** OS-56: mark inbox messages read by a run, once its start brief listed them. */
  readMessages(team: string, role: TeamRole, ids: number[], by: string): Promise<unknown>;
  /** OS-145: the config `model_routes` is read from (absent: this machine's models file and the defaults only). */
  configIo?: ConfigIO;
}

export interface RoleRunCtx {
  mode: Mode;
  flags: Flags;
  /** The arguments after `role`: `["start", "acme", "architect"]`. */
  args: string[];
  exit?: number | undefined;
}

const ROLE_SUBCOMMANDS = "start|status|end|brief|note|tick";

/**
 * The model a role run opens on (OS-145): route `role.<role>` of the active models profile, whose default is the
 * profile's builder range covering 8 when one names it, else Claude Opus (`claudeAgent:claude-opus-5-5`), at the model's
 * default effort (no options sent). The provider is always named, so a run never depends on the T3 project's own
 * default model (a project may have none).
 */
const ROLE_RUN_COMPLEXITY = 8;

async function roleRunModel(backend: RoleBackend, role: TeamRole): Promise<string> {
  return resolveRoute(await loadRouteInputs(backend.configIo ?? null), `role.${role}`).chain[0]!;
}

/** The first message a new run's thread gets: the role's skill, a blank line, then the brief. Pure. */
function roleRunSeedMessage(role: TeamRole, brief: string): string {
  return [`/ob-${role}`, "", brief].join("\n");
}

/** The brief's seams on this machine: pacing from the local T3 cache, gate facts from the local worktrees. */
function briefSeams(backend: RoleBackend) {
  return {
    storeFacts: (team: string, role: TeamRole) => backend.briefFacts(team, role),
    pacing: (now: Date) => {
      const source = pacingSource();
      return readPacing(t3Cache(process.env, source), now, source);
    },
    gateFacts: (row: BriefRow) => (existsSync(row.worktree) ? { missing: false, state: rowVerdictState(row) } : { missing: true, state: null }),
  };
}

/**
 * The brief a new run is seeded with (its note is marked shown once the launch went through). A brief that cannot be built never blocks the start: the seed says so and names the command.
 */
async function seedBrief(backend: RoleBackend, team: string, role: TeamRole): Promise<{ text: string; noteRun: number | null; inboxIds: number[] }> {
  try {
    const facts = await gatherRoleBrief(briefSeams(backend), team, role, new Date());
    // Every unread message, not only the ones the rendered list shows: the run reads the rest with `ob inbox`.
    return { text: renderRoleBrief(facts), noteRun: facts.note?.run_id ?? null, inboxIds: facts.inbox.map((m) => m.id) };
  } catch (err) {
    const reason = (err as Error).message;
    warn(`role: the start brief could not be built (${reason})`);
    return { text: `The start brief could not be built (${reason}); run \`ob role brief ${team} ${role}\`.`, noteRun: null, inboxIds: [] };
  }
}

/** The refusal for a run another machine's T3 holds. Pure. */
function otherHostRefusal(run: Pick<RoleRun, "id" | "t3_host">, local: string): string {
  return `run ${run.id} was opened on ${run.t3_host}; this machine's T3 is ${local}`;
}

function flagsFor(sub: string): string[] {
  if (sub === "end") return ["reason"];
  if (sub === "brief") return ["peek"];
  if (sub === "note") return ["body", "body-file"];
  if (sub === "tick") return ["team"];
  return [];
}

async function requireTeam(backend: RoleBackend, name: string): Promise<TeamView> {
  const t = await backend.team.show(name);
  if (!t) throw new AppError(`no team '${name}' (see \`ob t3 team list\`, or add it with \`ob t3 team add ${name}\`)`);
  return t;
}

/** Point the role's agent row at the run's thread, so handoffs and notes reach the live run. */
async function pointSeat(registry: AgentRegistry, team: string, role: TeamRole, threadId: string, repoPath: () => Promise<string>): Promise<void> {
  const id = teamRoleAgentId(team, role);
  const row = await registry.read(id);
  if (row?.launcher === T3_LAUNCHER && row.session_id === threadId) return;
  await registry.register({ id, worktree: await repoPath(), status: "planning", launcher: T3_LAUNCHER, sessionId: threadId, ttlS: T3_AGENT_TTL_S });
}

/**
 * The role's seat thread when it is a live T3 thread, else null (no seat, another launcher, settled, archived or gone).
 * A T3 that cannot be reached throws, as a reuse does, so an outage never reads as "no seat" and launches over one.
 */
export async function liveSeatThread(backend: RoleBackend, team: string, role: TeamRole, seam: T3Seam): Promise<string | null> {
  const row = await backend.team.registry.read(teamRoleAgentId(team, role));
  if (row?.launcher !== T3_LAUNCHER || !row.session_id) return null;
  try {
    const thread = await readThreadHeader(seam, row.session_id);
    return thread.settled || thread.archived ? null : row.session_id;
  } catch (err) {
    // A thread T3 no longer knows is a dead seat, read quietly: the launch that follows moves the seat off it.
    if (err instanceof T3Error && err.kind === "refused") return null;
    throw err;
  }
}

/**
 * The T3 request id a run's launch carries. Unique across stores and launches: role_run ids start at 1 in every store,
 * and T3 dedups a launch on its request id (OB-2128), so `ob-role-run-<id>` alone handed a new run an old proof's
 * thread (OS-82). A retry never relaunches the same run (an open run with no thread refuses), so the time part loses
 * nothing. Pure.
 */
export function roleRunRequestId(team: string, role: TeamRole, runId: number, nowMs: number): string {
  return `ob-role-run-${team}-${role}-${runId}-${nowMs.toString(36)}`;
}

/**
 * What `start` did: reused the open run, opened a new one (`ended` is the run it replaced), or (`seat`, OS-82) found
 * the role's seat a live thread and opened nothing: until the OS-58 cut-over a live seat is used as it is.
 */
interface RoleStartOutcome {
  team: string;
  role: TeamRole;
  /** Null exactly when `seat` is true. */
  run: RoleRun | null;
  thread_id: string;
  created: boolean;
  /** OS-82: the thread is the role's live seat, used as it is; no run was opened, launched, pinned or moved. */
  seat: boolean;
  /** The run ended as gone on the way, when its thread was no longer live. */
  ended: RoleRun | null;
  auto_settle_warning: string | null;
  /** OS-56: the inbox messages a new run's start brief listed, marked read by `role-run-<id>`; empty on a reuse. */
  inbox_ids: number[];
}

function renderStart(o: RoleStartOutcome, mode: Mode): string {
  if (mode === "json") return JSON.stringify(o, null, 2);
  if (mode === "quiet") return o.thread_id;
  const lines: string[] = [];
  if (o.ended) lines.push(`${o.team} ${o.role}: run ${o.ended.id} ended (gone): its thread ${o.ended.thread_id ?? "(none)"} is no longer live`);
  if (!o.run) lines.push(`${o.team} ${o.role}: seat thread ${o.thread_id} is live; no run opened (the seat is used as it is until OS-58)`);
  else
    lines.push(
      o.created
        ? `${o.team} ${o.role}: run ${o.run.id} opened, thread ${o.thread_id} (pinned)`
        : `${o.team} ${o.role}: run ${o.run.id} is open, thread ${o.thread_id}; nothing launched`,
    );
  return lines.join("\n");
}

/** The refusal for an open run with no thread: being started elsewhere, or a launch that died. Pure. */
function noThreadRefusal(run: RoleRun, title: string): string {
  return (
    `run ${run.id} for ${run.team} ${run.role} has no thread yet: another start is launching it, or its launch died before T3 answered; ` +
    `if no '${title}' thread is in T3 (settle any orphan), clear it with \`ob role end ${run.team} ${run.role}\``
  );
}

/**
 * `ob role start`: reuse the role's open run while its thread is live; else use the role's live seat thread as it is
 * (OS-82, until OS-58); else open a run. Also the delivery path (OS-56).
 */
export async function startRoleRun(backend: RoleBackend, teamName: string, role: TeamRole, seam: T3Seam): Promise<RoleStartOutcome> {
  const team = await requireTeam(backend, teamName);
  const local = t3BaseUrl();
  const title = teamThreadTitle(team, role);
  const repoPath = () => backend.team.cwdRepo();
  let ended: RoleRun | null = null;

  const reuse = async (run: RoleRun): Promise<RoleStartOutcome | null> => {
    if (run.t3_host !== local) throw new AppError(otherHostRefusal(run, local));
    if (!run.thread_id) throw new AppError(noThreadRefusal(run, title));
    // An unreachable T3 throws here and nothing changes.
    const live = await readTeamThread(seam, run.thread_id);
    if (!live) {
      ended = await backend.update(team.name, run.id, { end_reason: "gone" });
      return null;
    }
    const touched = await backend.update(team.name, run.id, activityOf(live));
    // The run stands whatever this does: repointing the seat needs a checkout (the row's worktree), which the cwd may not be.
    await pointSeat(backend.team.registry, team.name, role, run.thread_id, repoPath).catch((err: unknown) =>
      warn(`role: ${teamRoleAgentId(team.name, role)} still points elsewhere: ${(err as Error).message}`),
    );
    return { team: team.name, role, run: touched, thread_id: run.thread_id, created: false, seat: false, ended, auto_settle_warning: null, inbox_ids: [] };
  };

  const [open] = await backend.open(team.name, role);
  if (open) {
    const reused = await reuse(open);
    if (reused) return reused;
  }

  // OS-82: a live seat (`ob t3 architect`, `ob t3 team restart`) is not launched over, moved or settled: no run is
  // opened for it, so the OS-57 end pass never settles it either. A run starts only for a role with no live seat.
  const seatThread = await liveSeatThread(backend, team.name, role, seam);
  if (seatThread) {
    return { team: team.name, role, run: null, thread_id: seatThread, created: false, seat: true, ended, auto_settle_warning: null, inbox_ids: [] };
  }

  // Everything that can refuse is resolved before the marker is written, so a refusal leaves nothing behind.
  const cwd = await repoPath();
  const project = t3ProjectFor(await seam.projects(), cwd);
  if (!project) throw new AppError(`no T3 project is registered for ${cwd}; register the checkout as a T3 project (\`t3 project add ${cwd}\`)`);
  const roleModel = await roleRunModel(backend, role);
  const resolved = await resolveModelAndEffort(seam, project, ROLE_RUN_COMPLEXITY, [{ from: 1, to: 10, model: roleModel }], undefined);
  if ("refusal" in resolved) {
    throw new AppError(`${resolved.refusal.reason}; a role run opens on ${roleModel}, which this machine's T3 must list (\`ob t3 doctor\`)`);
  }

  const marked = await backend.mark(team.name, role, local);
  if (!marked.created) {
    // Another start opened a run since the read above: report it, never launch a second.
    const reused = await reuse(marked.run);
    if (reused) return reused;
    throw new AppError(`run ${marked.run.id} for ${team.name} ${role} ended while this start read it; re-run`);
  }
  const run = marked.run;
  const brief = await seedBrief(backend, team.name, role);
  let threadId: string;
  try {
    const launched = await seam.launch({
      projectId: project.id,
      title,
      message: roleRunSeedMessage(role, brief.text),
      modelSelection: { instanceId: resolved.model.selection.instanceId, model: resolved.model.selection.model },
      runtimeMode: T3_DEFAULT_RUNTIME_MODE,
      workspaceStrategy: { type: "root" },
      clientRequestId: roleRunRequestId(team.name, role, run.id, Date.now()),
    });
    threadId = launched.threadId;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // T3 answered with a refusal, or was never asked (no usable credential): no thread exists, so the run ends and the
    // next start is free. `unreachable` also covers a request that timed out in flight, so a thread may exist: kept.
    if (err instanceof T3Error && (err.kind === "refused" || err.kind.startsWith("credential_"))) {
      await backend.update(team.name, run.id, { end_reason: "gone" });
      throw new AppError(`the launch of run ${run.id} failed (${reason}); no thread was made, so the run was ended`);
    }
    throw new AppError(`the launch of run ${run.id} failed (${reason}); the run stays open with no thread. ${noThreadRefusal(run, title)}`);
  }
  const recorded = await backend.update(team.name, run.id, { thread_id: threadId });
  if (recorded.ended_at) {
    // The run was ended (`ob role end`) while this launch was in flight: the new thread belongs to nothing, so it goes.
    await seam.settle(threadId);
    throw new AppError(`run ${run.id} was ended while its thread was launching; thread ${threadId} was settled. Re-run \`ob role start ${team.name} ${role}\``);
  }
  if (brief.noteRun !== null) {
    await backend.noteShown(team.name, brief.noteRun).catch((err: unknown) => warn(`role: the note was delivered but not marked shown: ${(err as Error).message}`));
  }
  if (brief.inboxIds.length > 0) {
    // A failed mark leaves the messages unread: a later delivery queues them into this run, so none is lost.
    await backend
      .readMessages(team.name, role, brief.inboxIds, roleRunHolder(run.id))
      .catch((err: unknown) => warn(`role: the start brief listed the inbox but it was not marked read: ${(err as Error).message}`));
  }
  // The run is recorded and its brief delivered (and marked read), so nothing after this fails the start: a refused pin
  // or seat is a warning, as on the reuse path.
  await seam.pin(threadId).catch((err: unknown) => warn(`role: thread ${threadId} is not pinned: ${(err as Error).message}`));
  const settle = await teamAutoSettleOff(seam, threadId);
  await pointSeat(backend.team.registry, team.name, role, threadId, async () => cwd).catch((err: unknown) =>
    warn(`role: ${teamRoleAgentId(team.name, role)} still points elsewhere: ${(err as Error).message}`),
  );
  return {
    team: team.name,
    role,
    run: recorded,
    thread_id: threadId,
    created: true,
    seat: false,
    ended,
    auto_settle_warning: settle.autoSettleWarning,
    inbox_ids: brief.inboxIds,
  };
}

/** The activity a thread header reports: its item count and when it last changed. Pure. */
function activityOf(thread: { itemCount?: number; updatedAt?: string }): RoleRunPatch {
  return {
    ...(thread.itemCount === undefined ? {} : { item_count: thread.itemCount }),
    ...(thread.updatedAt ? { last_activity_at: thread.updatedAt } : {}),
  };
}

/** One run in `status`: the record, and what its thread reads as now. */
interface RoleStatusEntry {
  run: RoleRun;
  /** T3's status word, `settled`, `archived`, `gone` (T3 no longer knows it), `launching` (no thread yet), or `other-host`. */
  thread: string;
  error: string | null;
}

async function statusOf(run: RoleRun, local: string, seam: () => Promise<T3Seam>, backend: RoleBackend): Promise<RoleStatusEntry> {
  if (run.t3_host !== local) return { run, thread: "other-host", error: otherHostRefusal(run, local) };
  if (!run.thread_id) return { run, thread: "launching", error: null };
  let header: Awaited<ReturnType<typeof readThreadHeader>>;
  try {
    header = await readThreadHeader(await seam(), run.thread_id);
  } catch (err) {
    if (err instanceof T3Error && err.kind === "refused") return { run, thread: "gone", error: null };
    return { run, thread: "unread", error: `could not read thread ${run.thread_id}: ${(err as Error).message}` };
  }
  const thread = header.archived ? "archived" : header.settled ? "settled" : header.status;
  return { run: await backend.update(run.team, run.id, activityOf(header)), thread, error: null };
}

function renderStatus(team: string, entries: readonly RoleStatusEntry[], mode: Mode): string {
  if (mode === "json") return JSON.stringify({ team, runs: entries }, null, 2);
  if (mode === "quiet") return entries.map((e) => e.run.thread_id ?? "").filter(Boolean).join("\n");
  if (entries.length === 0) return `${team}: no open role runs (start one with \`ob role start ${team} <role>\`)`;
  return entries
    .map((e) => {
      const r = e.run;
      const items = r.item_count === null ? "" : `, ${r.item_count} items`;
      const context = r.context_tokens === null ? "" : `, ${r.context_tokens} context tokens`;
      return `${team} ${r.role}: run ${r.id}, thread ${r.thread_id ?? "(none)"} ${e.thread}${items}${context}; started ${r.started_at}, last activity ${r.last_activity_at}`;
    })
    .join("\n");
}

async function end(backend: RoleBackend, teamName: string, role: TeamRole, reasonRaw: string | undefined, seam: () => Promise<T3Seam>): Promise<RoleRun> {
  const reason = parseEndReason(reasonRaw ?? "manual");
  const team = await requireTeam(backend, teamName);
  const [run] = await backend.open(team.name, role);
  if (!run) throw new AppError(`${team.name} ${role} has no open run`);
  const local = t3BaseUrl();
  if (run.t3_host !== local) throw new AppError(otherHostRefusal(run, local));
  return endRoleRun(backend, team.name, run, reason, run.thread_id ? await seam() : null);
}

/**
 * End one open run on this machine's T3: settle and unpin its thread, record the end (which releases the lease), and
 * drop the role's seat when it still points at the thread. `retrySettle` (the tick, OS-57) settles through
 * `settleThreadWithRetry`, so a run that is just finishing its turn does not fail the settle; `ob role end` settles once.
 */
export async function endRoleRun(
  backend: RoleBackend,
  team: string,
  run: RoleRun,
  reason: RoleRunEndReason,
  s: T3Seam | null,
  opts: { retrySettle?: boolean } = {},
): Promise<RoleRun> {
  if (run.thread_id && s) {
    if (opts.retrySettle) {
      const settled = await settleThreadWithRetry(s, run.thread_id);
      if (!settled.settled) throw new AppError(`thread ${run.thread_id} would not settle (${settled.error}); run ${run.id} stays open`);
    } else {
      try {
        await s.settle(run.thread_id);
      } catch (err) {
        // A thread T3 no longer knows needs no settle; anything else (T3 unreachable) changes nothing.
        if (!(err instanceof T3Error && err.kind === "refused")) throw err;
      }
    }
    try {
      await s.unpin(run.thread_id);
    } catch (err) {
      warn(`role: thread ${run.thread_id} is settled but still pinned: ${(err as Error).message}`);
    }
  }
  const ended = await backend.update(team, run.id, { end_reason: reason });
  // A seat left on the settled thread would keep catching handoff notes (a sentinel outranks the architect).
  const seat = teamRoleAgentId(team, run.role);
  if (run.thread_id && (await backend.team.registry.read(seat))?.session_id === run.thread_id) await backend.team.dropRow(seat);
  return ended;
}

/**
 * `ob role start <team> <role>`, `ob role status <team> [<role>]`, `ob role end <team> <role> [--reason <r>]`, and
 * `ob role tick [--team <t>]` (OS-67), which needs `tick`: its findings and inbox.
 */
export async function runRoleCommand(ctx: RoleRunCtx, backend: RoleBackend, seam?: T3Seam, tick?: TickBackend): Promise<void> {
  const sub = ctx.args[0];
  if (!sub) throw new UsageError(`role needs a subcommand: ${ROLE_SUBCOMMANDS}`);
  if (!["start", "status", "end", "brief", "note", "tick"].includes(sub)) throw new UsageError(`unknown role subcommand '${sub}' (${ROLE_SUBCOMMANDS})`);
  refuseUnreadFlags(`ob role ${sub}`, ctx.flags, flagsFor(sub));
  const lazySeam = async () => seam ?? (await t3Seam());
  if (sub === "tick") {
    if (ctx.args.length > 1) throw new UsageError(`role tick takes no arguments (name teams with --team), got: ${ctx.args.slice(1).join(" ")}`);
    if (!tick) throw new AppError("role tick has no findings source here");
    await runRoleTick(ctx, tick, lazySeam);
    return;
  }
  const team = ctx.args[1];
  if (!team) throw new UsageError(`role ${sub} requires a <team>`);
  const roleArg = ctx.args[2];
  if (ctx.args.length > 3) throw new UsageError(`role ${sub} takes <team> <role>, got: ${ctx.args.slice(1).join(" ")}`);

  if (sub === "status") {
    const role = roleArg === undefined ? undefined : parseTeamRole(roleArg, "<role>");
    await requireTeam(backend, team);
    const local = t3BaseUrl();
    const entries: RoleStatusEntry[] = [];
    for (const run of await backend.open(team, role)) entries.push(await statusOf(run, local, lazySeam, backend));
    print(renderStatus(team, entries, ctx.mode));
    for (const e of entries) {
      if (!e.error) continue;
      warn(`role: ${e.error}`);
      ctx.exit = 1;
    }
    return;
  }

  const role = parseTeamRole(roleArg, "<role>");
  if (sub === "brief") {
    const facts = await gatherRoleBrief(briefSeams(backend), team, role, new Date());
    print(renderBriefOutput(facts, ctx.mode));
    // Marked only after the print, so a brief that never reached the reader leaves the note waiting.
    if (facts.note && ctx.flags.peek !== true) await backend.noteShown(team, facts.note.run_id);
    return;
  }
  if (sub === "note") {
    const body = bodyFromFlags({ body: ctx.flags.body, "body-file": ctx.flags["body-file"] });
    if (body === undefined) throw new UsageError(`role note needs --body-file <path> or --body "<text>"`);
    // Refused here too, so a client never sends a note the server would refuse.
    checkRoleNote(body);
    const run = await backend.note(team, role, body);
    if (ctx.mode === "json") print(JSON.stringify({ team, role, run_id: run.id, note_at: run.note_at, lines: roleNoteLines(body) }, null, 2));
    else if (ctx.mode !== "quiet") print(`${team} ${role}: note stored on run ${run.id} (${roleNoteLines(body)} lines); the next \`ob role brief\` shows it once`);
    return;
  }
  if (sub === "start") {
    const outcome = await startRoleRun(backend, team, role, await lazySeam());
    print(renderStart(outcome, ctx.mode));
    if (outcome.auto_settle_warning) {
      warn(outcome.auto_settle_warning);
      ctx.exit = 1;
    }
    return;
  }

  const ended = await end(backend, team, role, ctx.flags.reason, lazySeam);
  if (ctx.mode === "json") print(JSON.stringify({ team, role, run: ended }, null, 2));
  else if (ctx.mode !== "quiet") {
    const thread = ended.thread_id ? `, thread ${ended.thread_id} settled` : "";
    print(`${team} ${role}: run ${ended.id} ended (${ended.end_reason})${thread}; lease ${roleRunLeaseKey(team, role)} released`);
  }
}

function renderBriefOutput(facts: RoleBriefFacts, mode: Mode): string {
  if (mode === "json") return JSON.stringify(facts, null, 2);
  return renderRoleBrief(facts);
}

/** The role backend on this machine: the runs, the team and the inbox from the store. */
export function storeRoleBackend(store: Database | Store): RoleBackend {
  return {
    team: storeTeamBackend(store),
    open: (team, role) => openRoleRuns(store, team, role),
    mark: (team, role, t3Host) => markRoleRun(store, { team, role, t3Host }),
    update: (team, id, patch) => updateRoleRun(store, team, id, patch),
    briefFacts: (team, role) => roleBriefStoreFacts(store, team, role),
    noteShown: (team, runId) => markRoleNoteShown(store, team, runId),
    note: (team, role, body) => writeRoleNote(store, team, role, body),
    readMessages: (team, role, ids, by) => markRoleMessagesRead(store, team, role, ids, by),
    configIo: storeConfigIo(store),
  };
}

/** `ob role tick` on this machine: the teams, the findings and the inbox from the store. */
export function storeTickBackend(store: Database | Store): TickBackend {
  const team = storeTeamBackend(store);
  return {
    role: storeRoleBackend(store),
    inbox: storeInboxBackend(store),
    teams: () => team.list(),
    checkouts: async () => parseJsonMap(await settingFor(store, "repo_checkouts")),
    findings: (name) => tickFindings(store, name),
    conflicts: async () => storeConflictSource(store),
  };
}

/** `ob role` on this machine: the runs and the team from the store. */
export async function cmdRole(ctx: Ctx): Promise<void> {
  const store = ctx.store ?? ctx.db;
  await runRoleCommand(ctx, storeRoleBackend(store), undefined, storeTickBackend(store));
}

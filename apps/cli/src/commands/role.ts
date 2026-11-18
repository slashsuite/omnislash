// `ob role start|status|end`: one run per team role (see ../role-run.ts for the record and its guards).
//
// One procedure serves the store and the API client: each passes a `RoleBackend` for the data, and the T3 half (read
// the thread, launch, pin, settle) runs here, where T3 is. A run records the T3 it was opened on (`t3_host`); a machine
// whose T3 is another never reads that run's thread, so it never judges it gone.
import type { Ctx, Flags } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { print, warn, type Mode } from "../output.ts";
import { markRoleRun, openRoleRuns, parseEndReason, roleRunLeaseKey, updateRoleRun, type RoleRun, type RoleRunPatch } from "../role-run.ts";
import { parseTeamRole } from "../team-handoff.ts";
import { teamRoleAgentId, teamThreadTitle, type TeamRole, type TeamView } from "../team.ts";
import { t3BaseUrl, T3Error } from "../t3/client.ts";
import {
  DEFAULT_TIER_MODELS,
  readTeamThread,
  readThreadHeader,
  resolveModelAndEffort,
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

/** Where the runs live: the store on this machine, or the API. The T3 half is the caller's. */
export interface RoleBackend {
  team: Pick<TeamBackend, "show" | "registry" | "cwdRepo">;
  /** The team's open runs, one role's when `role` is named. An unknown team throws. */
  open(team: string, role?: TeamRole): Promise<RoleRun[]>;
  /** Insert the role's marker and take its lease, or answer the open run (`created` false). */
  mark(team: string, role: TeamRole, t3Host: string): Promise<{ run: RoleRun; created: boolean }>;
  update(team: string, id: number, patch: RoleRunPatch): Promise<RoleRun>;
}

export interface RoleRunCtx {
  mode: Mode;
  flags: Flags;
  /** The arguments after `role`: `["start", "acme", "architect"]`. */
  args: string[];
  exit?: number;
}

const ROLE_SUBCOMMANDS = "start|status|end";

/**
 * The model a role run opens on: the complex tier at the model's default effort (no options sent). The provider is
 * named, so a run never depends on the T3 project's own default model (a project may have none).
 */
const ROLE_RUN_TIER = "complex";
const ROLE_RUN_MODELS = { ...DEFAULT_TIER_MODELS, [ROLE_RUN_TIER]: `claudeAgent:${DEFAULT_TIER_MODELS[ROLE_RUN_TIER]}` };

/** The first message a new run's thread gets: the role's skill, then one line naming the run. Pure. */
export function roleRunSeedMessage(team: string, role: TeamRole, runId: number): string {
  return [`/ob-${role}`, "", `Role run ${runId} for team ${team}. The start brief arrives with OS-55.`].join("\n");
}

/** The refusal for a run another machine's T3 holds. Pure. */
export function otherHostRefusal(run: Pick<RoleRun, "id" | "t3_host">, local: string): string {
  return `run ${run.id} was opened on ${run.t3_host}; this machine's T3 is ${local}`;
}

function flagsFor(sub: string): string[] {
  return sub === "end" ? ["reason"] : [];
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

/** What `start` did: reused the open run, or opened a new one (`ended` is the run it replaced). */
export interface RoleStartOutcome {
  team: string;
  role: TeamRole;
  run: RoleRun;
  thread_id: string;
  created: boolean;
  /** The run ended as gone on the way, when its thread was no longer live. */
  ended: RoleRun | null;
  auto_settle_warning: string | null;
}

function renderStart(o: RoleStartOutcome, mode: Mode): string {
  if (mode === "json") return JSON.stringify(o, null, 2);
  if (mode === "quiet") return o.thread_id;
  const lines: string[] = [];
  if (o.ended) lines.push(`${o.team} ${o.role}: run ${o.ended.id} ended (gone): its thread ${o.ended.thread_id ?? "(none)"} is no longer live`);
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

async function start(backend: RoleBackend, teamName: string, role: TeamRole, seam: T3Seam): Promise<RoleStartOutcome> {
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
    await pointSeat(backend.team.registry, team.name, role, run.thread_id, repoPath);
    return { team: team.name, role, run: touched, thread_id: run.thread_id, created: false, ended, auto_settle_warning: null };
  };

  const [open] = await backend.open(team.name, role);
  if (open) {
    const reused = await reuse(open);
    if (reused) return reused;
  }

  // Everything that can refuse is resolved before the marker is written, so a refusal leaves nothing behind.
  const cwd = await repoPath();
  const project = t3ProjectFor(await seam.projects(), cwd);
  if (!project) throw new AppError(`no T3 project is registered for ${cwd}; register the checkout as a T3 project (\`t3 project add ${cwd}\`)`);
  const resolved = await resolveModelAndEffort(seam, project, ROLE_RUN_TIER, ROLE_RUN_MODELS, undefined);
  if ("refusal" in resolved) throw new AppError(`${resolved.refusal.reason}; ${resolved.refusal.remedy}`);

  const marked = await backend.mark(team.name, role, local);
  if (!marked.created) {
    // Another start opened a run since the read above: report it, never launch a second.
    const reused = await reuse(marked.run);
    if (reused) return reused;
    throw new AppError(`run ${marked.run.id} for ${team.name} ${role} ended while this start read it; re-run`);
  }
  const run = marked.run;
  let threadId: string;
  try {
    const launched = await seam.launch({
      projectId: project.id,
      title,
      message: roleRunSeedMessage(team.name, role, run.id),
      modelSelection: { instanceId: resolved.model.selection.instanceId, model: resolved.model.selection.model },
      runtimeMode: T3_DEFAULT_RUNTIME_MODE,
      workspaceStrategy: { type: "root" },
      clientRequestId: `ob-role-run-${run.id}`,
    });
    threadId = launched.threadId;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new AppError(`the launch of run ${run.id} failed (${reason}); the run stays open with no thread. ${noThreadRefusal(run, title)}`);
  }
  const recorded = await backend.update(team.name, run.id, { thread_id: threadId });
  await seam.pin(threadId);
  const settle = await teamAutoSettleOff(seam, threadId);
  await pointSeat(backend.team.registry, team.name, role, threadId, async () => cwd);
  return { team: team.name, role, run: recorded, thread_id: threadId, created: true, ended, auto_settle_warning: settle.autoSettleWarning };
}

/** The activity a thread header reports: its item count and when it last changed. Pure. */
function activityOf(thread: { itemCount?: number; updatedAt?: string }): RoleRunPatch {
  return {
    ...(thread.itemCount === undefined ? {} : { item_count: thread.itemCount }),
    ...(thread.updatedAt ? { last_activity_at: thread.updatedAt } : {}),
  };
}

/** One run in `status`: the record, and what its thread reads as now. */
export interface RoleStatusEntry {
  run: RoleRun;
  /** T3's status word, `settled`, `archived`, `gone` (T3 no longer knows it), `launching` (no thread yet), or `other-host`. */
  thread: string;
  error: string | null;
}

async function statusOf(run: RoleRun, local: string, seam: () => Promise<T3Seam>, backend: RoleBackend): Promise<RoleStatusEntry> {
  if (run.t3_host !== local) return { run, thread: "other-host", error: otherHostRefusal(run, local) };
  if (!run.thread_id) return { run, thread: "launching", error: null };
  try {
    const header = await readThreadHeader(await seam(), run.thread_id);
    const thread = header.archived ? "archived" : header.settled ? "settled" : header.status;
    return { run: await backend.update(run.team, run.id, activityOf(header)), thread, error: null };
  } catch (err) {
    if (err instanceof T3Error && err.kind === "refused") return { run, thread: "gone", error: null };
    return { run, thread: "unread", error: `could not read thread ${run.thread_id}: ${(err as Error).message}` };
  }
}

function renderStatus(team: string, entries: readonly RoleStatusEntry[], mode: Mode): string {
  if (mode === "json") return JSON.stringify({ team, runs: entries }, null, 2);
  if (mode === "quiet") return entries.map((e) => e.run.thread_id ?? "").filter(Boolean).join("\n");
  if (entries.length === 0) return `${team}: no open role runs (start one with \`ob role start ${team} <role>\`)`;
  return entries
    .map((e) => {
      const r = e.run;
      const items = r.item_count === null ? "" : `, ${r.item_count} items`;
      return `${team} ${r.role}: run ${r.id}, thread ${r.thread_id ?? "(none)"} ${e.thread}${items}; started ${r.started_at}, last activity ${r.last_activity_at}`;
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
  if (run.thread_id) {
    const s = await seam();
    try {
      await s.settle(run.thread_id);
    } catch (err) {
      // A thread T3 no longer knows needs no settle; anything else (T3 unreachable) changes nothing.
      if (!(err instanceof T3Error && err.kind === "refused")) throw err;
    }
    try {
      await s.unpin(run.thread_id);
    } catch (err) {
      warn(`role: thread ${run.thread_id} is settled but still pinned: ${(err as Error).message}`);
    }
  }
  return backend.update(team.name, run.id, { end_reason: reason });
}

/** `ob role start <team> <role>`, `ob role status <team> [<role>]`, `ob role end <team> <role> [--reason <r>]`. */
export async function runRoleCommand(ctx: RoleRunCtx, backend: RoleBackend, seam?: T3Seam): Promise<void> {
  const sub = ctx.args[0];
  if (!sub) throw new UsageError(`role needs a subcommand: ${ROLE_SUBCOMMANDS}`);
  if (!["start", "status", "end"].includes(sub)) throw new UsageError(`unknown role subcommand '${sub}' (${ROLE_SUBCOMMANDS})`);
  refuseUnreadFlags(`ob role ${sub}`, ctx.flags, flagsFor(sub));
  const team = ctx.args[1];
  if (!team) throw new UsageError(`role ${sub} requires a <team>`);
  const roleArg = ctx.args[2];
  if (ctx.args.length > 3) throw new UsageError(`role ${sub} takes <team> <role>, got: ${ctx.args.slice(1).join(" ")}`);
  const lazySeam = async () => seam ?? (await t3Seam());

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
  if (sub === "start") {
    const outcome = await start(backend, team, role, await lazySeam());
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

/** `ob role` on this machine: the runs and the team from the store. */
export async function cmdRole(ctx: Ctx): Promise<void> {
  const store = ctx.store ?? ctx.db;
  await runRoleCommand(ctx, {
    team: storeTeamBackend(store),
    open: (team, role) => openRoleRuns(store, team, role),
    mark: (team, role, t3Host) => markRoleRun(store, { team, role, t3Host }),
    update: (team, id, patch) => updateRoleRun(store, team, id, patch),
  });
}

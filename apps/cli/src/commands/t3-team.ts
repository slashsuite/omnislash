// OB-2255: `ob t3 team …` and `ob t3 architect|sentinel|muse …`. A team is one or more projects with one
// architect thread and optionally a sentinel and a muse (see ../team.ts). One procedure serves the store and
// the API client: each passes a `TeamBackend`, and the T3 half (open, adopt, pin, unpin) runs here, where T3 is.
import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { Flags } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { print, warn, type Mode } from "../output.ts";
import type { Project } from "../project.ts";
import { parseProjectList, parseTeamLabel, TEAM_ROLES, teamRoleAgentId, type Team, type TeamRole, type TeamView } from "../team.ts";
import { unpinTeamThreads } from "../team-thread.ts";
import { parseTeamRole, type TeamHandoff } from "../team-handoff.ts";
import { forwardLateHandoff, RESTART_DEFAULT_TIMEOUT_MS, restartTeams, roleModelFor, type RestartBackend, type RoleRestartOutcome } from "../team-restart.ts";
import { T3_THREAD_ENV } from "../../../../platform/cli-coord/src/lease-wait-title.ts";
import { bodyFromFlags } from "./doc.ts";
import { ensureTeamThread, t3Seam, type AgentRegistry, type T3Seam, type TeamThreadOutcome } from "../t3/dispatch.ts";

const TEAM_SUBCOMMANDS = "add|edit|join|leave|list|show|rm|handoff|restart";

/** Where a team's data lives: the store on this machine, or the API. The T3 half is the caller's. */
export interface TeamBackend extends RestartBackend {
  list(): Promise<TeamView[]>;
  /** The team, or null when there is no such team. */
  show(name: string): Promise<TeamView | null>;
  add(input: { name: string; icon?: string; display_name?: string; projects?: string[] }): Promise<TeamView>;
  /** Null when there is no such team. */
  edit(name: string, patch: { icon?: string; display_name?: string }): Promise<TeamView | null>;
  join(name: string, projects: string[]): Promise<{ team: TeamView; joined: string[] }>;
  leave(projects: string[]): Promise<Array<{ project: string; team: string | null }>>;
  remove(name: string, force: boolean): Promise<{ team: Team; members: string[]; threads: string[] }>;
  /** Drop an agent row; false when there was none. */
  dropRow(agentId: string): Promise<boolean>;
  registry: AgentRegistry;
  /** The repo checkout the cwd belongs to (a `wt` worktree resolves to its repo). */
  cwdRepo(): Promise<string>;
  projects(): Promise<Project[]>;
  /** OB-2257: a role's handoff, recorded by the old thread and held through `team restart` (read via RestartBackend). */
  handoffRecord(team: string, role: TeamRole, body: string, fromThreadId?: string | null): Promise<TeamHandoff>;
}

export interface TeamRunCtx {
  mode: Mode;
  flags: Flags;
  /** The arguments after `t3`: `["team", "add", "x"]`, `["architect", "slash"]`. */
  args: string[];
  exit?: number;
}

/** Every flag an `ob t3` subcommand reads (OB-2255): anything else is refused by name, before any change. */
export function t3SubcommandReads(args: readonly string[]): string[] {
  const sub = args[0] ?? "doctor";
  switch (sub) {
    case "login":
      return ["base-url", "access", "ttl"];
    case "doctor":
    case "status":
      return ["base-url"];
    case "tree":
      return ["base-url", "subagents"];
    case "projects":
    case "open":
      return ["base-url"];
    case "broadcast":
      return ["message-file", "dry-run"];
    case "architect":
      return ["thread"];
    case "sentinel":
    case "muse":
      return ["thread", "remove"];
    case "team": {
      const t = args[1] ?? "list";
      if (t === "add") return ["icon", "display-name", "projects"];
      if (t === "edit") return ["icon", "display-name"];
      if (t === "rm") return ["force"];
      if (t === "handoff") return ["role", "body", "body-file", "show"];
      if (t === "restart") return ["role", "force", "timeout", "all"];
      return [];
    }
    default:
      return [];
  }
}

/** One tab-separated line per team: name, icon, display name, member ids, role threads as `role=thread`. Pure. */
function renderTeamList(teams: TeamView[]): string {
  return teams
    .map((t) =>
      [t.name, t.icon ?? "", t.display_name ?? "", t.members.join(",") || "-", t.threads.map((x) => `${x.role}=${x.thread_id}`).join(",") || "-"].join("\t"),
    )
    .join("\n");
}

/** `ob t3 team show`: the team, its members and each role's thread (pinned), or `none` with the command that adds it. Pure. */
function renderTeamShow(t: TeamView): string {
  const lines = [
    `team:      ${t.icon ? `${t.icon} ` : ""}${t.display_name ?? t.name} (${t.name})`,
    `members:   ${t.members.length > 0 ? t.members.join(", ") : "(none)"}`,
  ];
  for (const role of TEAM_ROLES) {
    const x = t.threads.find((y) => y.role === role);
    lines.push(`${`${role}:`.padEnd(11)}${x ? `${x.thread_id} (${x.agent_id}), pinned` : `none, add with \`ob t3 ${role} ${t.name}\``}`);
  }
  return lines.join("\n");
}

/** The human report of an open or adopt. The link is T3's own documented shape for handing a human a thread. Pure. */
export function renderTeamThread(o: TeamThreadOutcome, teamCreated: string | null): string {
  const lines = teamCreated ? [teamCreated] : [];
  lines.push(o.message, `  auto-settle ${o.autoSettleOff ? "off" : "NOT off"}`);
  if (o.created || o.adopted) lines.push(`  agent     ${o.agentId}`, `  thread    ${o.threadId}`, `  link      [${o.title}](t3-thread://v1/${o.threadId})`);
  return lines.join("\n");
}

function labelFlags(flags: Flags): { icon?: string; display_name?: string } {
  return {
    ...(flags.icon !== undefined ? { icon: parseTeamLabel("icon", flags.icon) } : {}),
    ...(flags["display-name"] !== undefined ? { display_name: parseTeamLabel("display-name", flags["display-name"]) } : {}),
  };
}

/**
 * The checkout a directory sits in (`git rev-parse --show-toplevel`), so `ob t3 architect` run from a subdirectory
 * of a checkout takes that checkout. A directory outside any checkout is returned as it is, for the resolver to name.
 */
export function checkoutOf(dir: string): string {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const top = r.status === 0 ? r.stdout.trim() : "";
  return top || dir;
}

function warnLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** The ob project a checkout belongs to: by id or name equal to its directory name, else by its git remote. Pure. */
function projectOfRepo(projects: readonly Project[], repoPath: string): Project | null {
  const slug = basename(repoPath.replace(/\/+$/, ""));
  return (
    projects.find((p) => p.id === slug) ??
    projects.find((p) => p.name === slug) ??
    projects.find((p) => !!p.git_remote && new RegExp(`[/:]${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.git)?$`).test(p.git_remote)) ??
    null
  );
}

async function requireTeam(backend: TeamBackend, name: string): Promise<TeamView> {
  const t = await backend.show(name);
  if (!t) throw new AppError(`no team '${name}' (see \`ob t3 team list\`, or add it with \`ob t3 team add ${name}\`)`);
  return t;
}

/** `--role a,b` for a restart: each a role, refused by name. Pure. */
export function parseRestartRoles(raw: string | undefined): TeamRole[] | undefined {
  if (raw === undefined) return undefined;
  const roles = raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => parseTeamRole(r));
  if (roles.length === 0) throw new UsageError(`--role needs at least one of ${TEAM_ROLES.join("|")}`);
  return roles;
}

/** `--timeout <minutes>` for a restart: a positive number of minutes. Pure. */
export function parseRestartTimeout(raw: string | undefined): number {
  if (raw === undefined) return RESTART_DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--timeout is minutes, a positive number (got '${raw}')`);
  return Math.round(n * 60_000);
}

/** The handoff as `--show` prints it: a header line, then the body as written. Pure. */
function renderHandoff(h: TeamHandoff): string {
  const seeded = h.consumed_at ? `seeded ${h.new_thread_id ?? "?"} at ${h.consumed_at}` : "not yet seeded";
  return [`handoff ${h.id}  ${h.team} ${h.role}  from ${h.old_thread_id ?? "(no thread)"}  ${h.created_at}  ${seeded}`, "", h.body].join("\n");
}

/** One line per role a restart touched. Pure. */
export function renderRestart(outcomes: readonly RoleRestartOutcome[]): string {
  if (outcomes.length === 0) return "nothing to restart";
  return outcomes.map((o) => `${o.result.padEnd(9)} ${o.team} ${o.role}${o.reason ? `: ${o.reason}` : ""}`).join("\n");
}

/**
 * `ob t3 team handoff <team> --role <r> (--body-file <f> | --body <text> | --show)`. Run inside a T3 thread, the
 * row names that thread as its writer; when the writer is no longer the role's bound thread (a replaced thread
 * still reporting), the body is queued to the bound thread and the row marked consumed at once (OB-2275).
 */
async function runHandoff(ctx: TeamRunCtx, backend: TeamBackend, name: string | undefined, seam?: T3Seam): Promise<void> {
  if (!name) throw new UsageError("t3 team handoff requires a <team>");
  if (ctx.args.length > 3) throw new UsageError(`t3 team handoff takes one <team>, got: ${ctx.args.slice(2).join(" ")}`);
  const role = parseTeamRole(ctx.flags.role);
  const team = await requireTeam(backend, name);
  if (ctx.flags.show === true) {
    if (ctx.flags.body !== undefined || ctx.flags["body-file"] !== undefined) throw new UsageError("--show prints the handoff; it takes no --body or --body-file");
    const h = await backend.handoffLatest(team.name, role);
    if (!h) {
      if (ctx.mode === "json") print(JSON.stringify({ handoff: null }, null, 2));
      else if (ctx.mode !== "quiet") print(`${team.name} ${role}: no handoff recorded`);
      ctx.exit = 1;
      return;
    }
    if (ctx.mode === "json") print(JSON.stringify({ handoff: h }, null, 2));
    else if (ctx.mode === "quiet") print(h.body);
    else print(renderHandoff(h));
    return;
  }
  const body = bodyFromFlags(ctx.flags);
  if (body === undefined) throw new UsageError("t3 team handoff needs --body-file <file> (or --body <text>) to record, or --show to print");
  const sender = process.env[T3_THREAD_ENV]?.trim() || null;
  const h = await backend.handoffRecord(team.name, role, body, sender);
  const fwd = await forwardLateHandoff(backend, h, sender, async () => seam ?? (await t3Seam()));
  if (ctx.mode === "json") print(JSON.stringify({ handoff: h, forward: fwd }, null, 2));
  else if (ctx.mode === "quiet") print(String(h.id));
  else {
    const lines = [`${team.name} ${role}: handoff ${h.id} recorded (${h.body.length} characters) from ${h.old_thread_id ?? "(no bound thread)"}`];
    if (fwd.kind === "forwarded") lines.push(`  ${h.old_thread_id} is no longer the ${role}: forwarded to ${fwd.boundThreadId} and marked consumed`);
    print(lines.join("\n"));
  }
  if (fwd.kind === "failed") {
    warn(fwd.reason);
    ctx.exit = 1;
  }
}

/** `ob t3 team restart <team> | --all [--role r[,r]] [--force] [--timeout <min>]`. */
async function runRestart(ctx: TeamRunCtx, backend: TeamBackend, name: string | undefined, seam?: T3Seam): Promise<void> {
  const all = ctx.flags.all === true;
  if (all && name) throw new UsageError("t3 team restart takes a <team> or --all, not both");
  if (!all && !name) throw new UsageError("t3 team restart requires a <team> (or --all)");
  if (ctx.args.length > 3) throw new UsageError(`t3 team restart takes one <team>, got: ${ctx.args.slice(2).join(" ")}`);
  const roles = parseRestartRoles(ctx.flags.role);
  const timeoutMs = parseRestartTimeout(ctx.flags.timeout);
  const teams = all ? await backend.list() : [await requireTeam(backend, name!)];
  // The progress lines are the watchable heartbeat: stdout in human mode, stderr otherwise, so -q and --json stay clean.
  const log = (line: string) => (ctx.mode === "human" ? print(line) : warnLine(line));
  const outcomes = await restartTeams(backend, teams, {
    seam: seam ?? (await t3Seam()),
    ...(roles ? { roles } : {}),
    force: ctx.flags.force === true,
    timeoutMs,
    log,
  });
  if (ctx.mode === "json") print(JSON.stringify({ outcomes }, null, 2));
  else if (ctx.mode === "quiet") print(outcomes.filter((o) => o.newThreadId).map((o) => o.newThreadId).join("\n"));
  else print(["", renderRestart(outcomes)].join("\n"));
  if (outcomes.some((o) => o.result === "failed" || (o.result === "skipped" && !o.unbound))) ctx.exit = 1;
}

/** `ob t3 team <sub>`. */
export async function runTeam(ctx: TeamRunCtx, backend: TeamBackend, seam?: T3Seam): Promise<void> {
  const sub = ctx.args[1] ?? "list";
  const name = ctx.args[2];
  const emitTeam = (t: { name: string }) => {
    if (ctx.mode === "json") print(JSON.stringify(t, null, 2));
    else print(t.name);
  };
  if (sub === "add") {
    if (!name) throw new UsageError("t3 team add requires a <name>");
    const projects = ctx.flags.projects !== undefined ? parseProjectList(ctx.flags.projects) : undefined;
    emitTeam(await backend.add({ name, ...labelFlags(ctx.flags), ...(projects ? { projects } : {}) }));
    return;
  }
  if (sub === "edit") {
    if (!name) throw new UsageError("t3 team edit requires a <name>");
    const t = await backend.edit(name, labelFlags(ctx.flags));
    if (!t) throw new AppError(`no team '${name}'`);
    emitTeam(t);
    return;
  }
  if (sub === "join") {
    const projects = ctx.args.slice(3);
    if (!name || projects.length === 0) throw new UsageError("t3 team join requires <team> <project>...");
    const res = await backend.join(name, projects);
    if (ctx.mode === "json") print(JSON.stringify(res, null, 2));
    else if (ctx.mode === "quiet") print(res.joined.join("\n"));
    else print(`${res.team.name}: ${res.joined.join(", ")} joined; members now ${res.team.members.join(", ")}`);
    return;
  }
  if (sub === "leave") {
    const projects = ctx.args.slice(2);
    if (projects.length === 0) throw new UsageError("t3 team leave requires <project>...");
    const left = await backend.leave(projects);
    if (ctx.mode === "json") print(JSON.stringify({ left }, null, 2));
    else if (ctx.mode === "quiet") print(left.map((l) => l.project).join("\n"));
    else print(left.map((l) => (l.team ? `${l.project}: left team ${l.team}` : `${l.project}: was in no team`)).join("\n"));
    return;
  }
  if (sub === "list") {
    const teams = await backend.list();
    if (ctx.mode === "json") print(JSON.stringify(teams, null, 2));
    else if (ctx.mode === "quiet") print(teams.map((t) => t.name).join("\n"));
    else print(renderTeamList(teams));
    return;
  }
  if (sub === "show") {
    if (!name) throw new UsageError("t3 team show requires a <name>");
    const t = await requireTeam(backend, name);
    if (ctx.mode === "json") print(JSON.stringify(t, null, 2));
    else if (ctx.mode === "quiet") print(t.members.join("\n"));
    else print(renderTeamShow(t));
    return;
  }
  if (sub === "handoff") return runHandoff(ctx, backend, name, seam);
  if (sub === "restart") return runRestart(ctx, backend, name, seam);
  if (sub === "rm") {
    if (!name) throw new UsageError("t3 team rm requires a <name>");
    const force = ctx.flags.force === true;
    // Read the bound threads first, so the ones the removal lets go of are unpinned after it.
    const bound = force ? ((await backend.show(name))?.threads.map((t) => t.thread_id) ?? []) : [];
    const res = await backend.remove(name, force);
    await unpinTeamThreads(bound, warnLine);
    emitTeam(res.team);
    return;
  }
  throw new UsageError(`unknown t3 team subcommand '${sub}' (${TEAM_SUBCOMMANDS})`);
}

/**
 * `ob t3 architect [<team>] [--thread <id>]` and `ob t3 sentinel|muse <team> [--thread <id>] | --remove`.
 *
 * With no team (architect only), the team is the cwd's project's; a project in no team gets a team of one named
 * by its id, with its icon and display name, and the command says so on stdout.
 */
export async function runRole(ctx: TeamRunCtx, backend: TeamBackend, role: TeamRole, seam?: T3Seam): Promise<void> {
  const teamArg = ctx.args[1];
  const thread = ctx.flags.thread;
  if (role !== "architect" && !teamArg) throw new UsageError(`t3 ${role} requires a <team>`);
  if (ctx.args.length > 2) throw new UsageError(`t3 ${role} takes one <team>, got: ${ctx.args.slice(1).join(" ")}`);

  if (ctx.flags.remove === true) {
    if (thread) throw new UsageError("--thread and --remove cannot be used together");
    const team = await requireTeam(backend, teamArg!);
    const agentId = teamRoleAgentId(team.name, role);
    const threadId = team.threads.find((t) => t.role === role)?.thread_id ?? null;
    const dropped = await backend.dropRow(agentId);
    if (dropped && threadId) await unpinTeamThreads([threadId], warnLine, seam);
    if (ctx.mode === "json") print(JSON.stringify({ team: team.name, role, agent_id: agentId, removed: dropped, thread_id: threadId }, null, 2));
    else if (ctx.mode !== "quiet") print(dropped ? `${team.name} ${role}: removed (${agentId} dropped${threadId ? `, thread ${threadId} unpinned` : ""})` : `${team.name} ${role}: there was none`);
    return;
  }

  const repoPath = await backend.cwdRepo();
  let team: TeamView;
  let writeTeam: (() => Promise<string>) | null = null;
  if (teamArg) {
    team = await requireTeam(backend, teamArg);
  } else {
    const project = projectOfRepo(await backend.projects(), repoPath);
    if (!project) {
      throw new AppError(`no ob project for ${repoPath}, so there is no team to take; name one (\`ob t3 architect <team>\`) or register the project (\`ob project add\`)`);
    }
    if (project.team_name) {
      team = await requireTeam(backend, project.team_name);
    } else {
      // Nothing is written until the thread is in place: a checkout T3 refuses must not leave a team behind.
      const existing = await backend.show(project.id);
      const join = project.id;
      team = existing
        ? { ...existing, members: [...existing.members, join] }
        : {
            name: join,
            icon: project.icon ?? null,
            display_name: project.display_name ?? null,
            created_at: "",
            members: [join],
            threads: [],
          };
      writeTeam = existing
        ? async () => {
            await backend.join(existing.name, [join]);
            return `${join} was in no team: joined the existing team '${existing.name}'`;
          }
        : async () => {
            await backend.add({
              name: join,
              ...(project.icon ? { icon: project.icon } : {}),
              ...(project.display_name ? { display_name: project.display_name } : {}),
              projects: [join],
            });
            return `${join} was in no team: made team '${join}' with it as the only member`;
          };
    }
  }

  const outcome = await ensureTeamThread(backend.registry, {
    team,
    role,
    members: team.members,
    repoPath,
    ...(thread ? { adoptThreadId: thread } : {}),
    ...(seam ? { seam } : {}),
    ...(thread ? {} : await roleModelFor(backend.configIo, role)),
  });
  const teamCreated = writeTeam ? await writeTeam() : null;
  if (ctx.mode === "json") print(JSON.stringify({ ...outcome, team_created: teamCreated !== null }, null, 2));
  else if (ctx.mode === "quiet") {
    // stdout stays the one thread id a caller captures; the team line goes to stderr
    if (teamCreated) warnLine(teamCreated);
    print(outcome.threadId);
  } else print(renderTeamThread(outcome, teamCreated));
  if (outcome.autoSettleWarning) {
    warn(outcome.autoSettleWarning);
    ctx.exit = 1;
  }
}

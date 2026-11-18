// OB-2255: teams (`ob t3 team`). A team is a named set of one or more projects with one architect thread, and
// optionally a sentinel and a muse. It replaces OB-2245's project groups and the per-project thread that came before teams.
//
// The data is migration 0046's, unchanged (the DB is additive-only): `project_group` holds the teams and
// `project.group_name` the membership, exported by both schemas under team names (`team`, `project.team_name`).
// A team's threads are agent rows `<role>-<team>` (`architect-acme`, `sentinel-slash`), launcher `t3`, with
// the thread id in `session_id`.
//
// Routing: a project's readying note goes to its team's sentinel when one is bound, else to its architect
// (`teamHandoffTarget`). A project in no team gets no note.
import type { Database } from "bun:sqlite";
import { asc, eq, inArray } from "drizzle-orm";
import { nowIso } from "./db.ts";
import { asStore, type Store } from "./db/store.ts";
import { AppError, UsageError } from "./errors.ts";
import { getProject, UnknownTeamError, type Project } from "./project.ts";
import { doneAgent, getAgent } from "../../../platform/cli-coord/src/agent.ts";
import type { AgentRegistry } from "./t3/dispatch.ts";

/** A row's T3 thread id: only a `t3` row's `session_id` is a thread. Pure. */
export function teamThreadIdOf(row: { session_id: string | null; launcher: string | null } | null): string | null {
  return row && row.launcher === "t3" && row.session_id ? row.session_id : null;
}

export interface Team {
  name: string;
  icon: string | null;
  display_name: string | null;
  created_at: string;
}

/** The roles, the architect first: it is the one every team has, and the one the owner talks to. */
export const TEAM_ROLES = ["architect", "sentinel", "muse"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** The agent row a team's role thread is recorded on: `<role>-<team>`. Pure. */
export function teamRoleAgentId(team: string, role: TeamRole): string {
  return `${role}-${team}`;
}

/** Whether an agent row id is a team role's (`architect-*`, `sentinel-*`, `muse-*`), never a builder's. Pure. */
export function isTeamRoleAgent(id: string): boolean {
  return /^(architect|sentinel|muse)-./.test(id);
}

/** The role of a team role agent id (`sentinel-slash` is `sentinel`), or null for any other id. Pure. */
export function teamRoleOf(id: string): TeamRole | null {
  const m = /^(architect|sentinel|muse)-./.exec(id);
  return m ? (m[1] as TeamRole) : null;
}

/** A team name: lowercase letters, digits and hyphens, starting with a letter or digit, at most 40. */
function teamNameProblem(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
    return `team name '${name}' must be lowercase letters, digits and hyphens (at most 40, starting with a letter or digit)`;
  }
  return null;
}

/** The thread title for a team role: `<icon> <display name or name> · <role>`. Pure. */
export function teamThreadTitle(team: Pick<Team, "name" | "icon" | "display_name">, role: TeamRole): string {
  const icon = team.icon?.trim();
  const name = team.display_name?.trim() || team.name;
  return `${icon ? `${icon} ` : ""}${name} · ${role}`;
}

export async function getTeam(db: Database | Store, name: string): Promise<Team | null> {
  const s = asStore(db);
  const rows = (await s.q.select().from(s.t.team).where(eq(s.t.team.name, name)).limit(1)) as Team[];
  return rows[0] ?? null;
}

export async function listTeams(db: Database | Store): Promise<Team[]> {
  const s = asStore(db);
  return (await s.q.select().from(s.t.team).orderBy(asc(s.t.team.name))) as Team[];
}

/** The team's member projects, by id. */
async function teamMembers(db: Database | Store, name: string): Promise<Project[]> {
  const s = asStore(db);
  return (await s.q.select().from(s.t.project).where(eq(s.t.project.team_name, name)).orderBy(asc(s.t.project.id))) as Project[];
}

/** One bound thread of a team: its role and thread id. */
export interface TeamThread {
  role: TeamRole;
  agent_id: string;
  thread_id: string;
}

/** The team's bound threads, in role order. A row with no t3 thread id is not bound. */
async function teamThreads(db: Database | Store, name: string): Promise<TeamThread[]> {
  const out: TeamThread[] = [];
  for (const role of TEAM_ROLES) {
    const id = teamRoleAgentId(name, role);
    const threadId = teamThreadIdOf(await getAgent(db, id));
    if (threadId) out.push({ role, agent_id: id, thread_id: threadId });
  }
  return out;
}

/** What `ob t3 team list|show` print, and the API returns: the team, its member ids and its bound threads. */
export interface TeamView extends Team {
  members: string[];
  threads: TeamThread[];
}

export async function teamView(db: Database | Store, team: Team): Promise<TeamView> {
  return {
    ...team,
    members: (await teamMembers(db, team.name)).map((p) => p.id),
    threads: await teamThreads(db, team.name),
  };
}

export async function listTeamViews(db: Database | Store): Promise<TeamView[]> {
  const out: TeamView[] = [];
  for (const t of await listTeams(db)) out.push(await teamView(db, t));
  return out;
}

/** `--icon` / `--display-name` for a team, trimmed; '' clears on edit. Same caps as a project's (OB-2116). */
export function parseTeamLabel(flag: "icon" | "display-name", value: string): string {
  const v = value.trim();
  const max = flag === "icon" ? 16 : 40;
  const len = flag === "icon" ? v.length : [...v].length;
  if (len > max) throw new UsageError(`--${flag} must be at most ${max} ${flag === "icon" ? "UTF-16 code units" : "characters"} (got ${len})`);
  return v;
}

/** `--projects a,b` as a list of project names, refusing an empty one. Pure. */
export function parseProjectList(raw: string): string[] {
  const out = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (out.length === 0) throw new UsageError("--projects needs at least one project (a,b)");
  return out;
}

/**
 * Put projects into a team, in the caller's transaction. Each must exist; a project already in ANOTHER team is
 * refused by name (leave it first), and one already in this team is a no-op. Refuses before writing anything.
 */
async function joinIn(s: Store, team: string, projects: string[]): Promise<string[]> {
  const found: Project[] = [];
  for (const name of projects) {
    const p = await getProject(s, name);
    if (!p) throw new AppError(`no project '${name}' (see \`ob project list\`)`);
    if (p.team_name && p.team_name !== team) {
      throw new AppError(`project '${p.id}' is already in team '${p.team_name}'; a project is in one team at most (\`ob t3 team leave ${p.id}\` first)`);
    }
    found.push(p);
  }
  const ids = [...new Set(found.map((p) => p.id))];
  if (ids.length > 0) await s.q.update(s.t.project).set({ team_name: team }).where(inArray(s.t.project.id, ids));
  return ids;
}

/**
 * Add a team, with its first projects. A name already taken is answered with that team when the asked-for
 * icon and display name agree with it (an idempotent re-add, which still joins `projects`), and refused naming
 * `ob t3 team edit` when they differ.
 */
export async function addTeam(
  db: Database | Store,
  input: { name: string; icon?: string | null; display_name?: string | null; projects?: string[] },
): Promise<Team> {
  const problem = teamNameProblem(input.name);
  if (problem) throw new UsageError(problem);
  return asStore(db).txn("add the team", async (s) => {
    const existing = await getTeam(s, input.name);
    if (existing) {
      const differs =
        (input.icon && input.icon !== existing.icon) || (input.display_name && input.display_name !== existing.display_name);
      if (differs) {
        throw new AppError(`team '${input.name}' already exists; change it with: ob t3 team edit ${input.name} [--icon <emoji>] [--display-name <text>]`);
      }
    } else {
      await s.q.insert(s.t.team).values({
        name: input.name,
        icon: input.icon || null,
        display_name: input.display_name || null,
        created_at: nowIso(),
      });
    }
    if (input.projects?.length) await joinIn(s, input.name, input.projects);
    return (await getTeam(s, input.name))!;
  });
}

/** Edit a team's icon or display name ('' clears). Null when there is no such team. */
export async function editTeam(
  db: Database | Store,
  name: string,
  patch: { icon?: string; display_name?: string },
): Promise<Team | null> {
  if (patch.icon === undefined && patch.display_name === undefined) {
    throw new UsageError("team edit needs at least one of --icon <emoji> or --display-name <text>");
  }
  return asStore(db).txn("edit the team", async (s) => {
    if (!(await getTeam(s, name))) return null;
    const set: { icon?: string | null; display_name?: string | null } = {};
    if (patch.icon !== undefined) set.icon = patch.icon || null;
    if (patch.display_name !== undefined) set.display_name = patch.display_name || null;
    await s.q.update(s.t.team).set(set).where(eq(s.t.team.name, name));
    return (await getTeam(s, name))!;
  });
}

/** Put projects into a team (`team join`). An unknown team throws `UnknownTeamError`; see `joinIn` for the rest. */
export async function joinTeam(db: Database | Store, name: string, projects: string[]): Promise<{ team: Team; joined: string[] }> {
  if (projects.length === 0) throw new UsageError("team join needs at least one <project>");
  return asStore(db).txn("join the team", async (s) => {
    const team = await getTeam(s, name);
    if (!team) throw new UnknownTeamError(name);
    return { team, joined: await joinIn(s, name, projects) };
  });
}

/** Take projects out of whatever team they are in (`team leave`). Unknown projects are refused before any write. */
export async function leaveTeam(db: Database | Store, projects: string[]): Promise<Array<{ project: string; team: string | null }>> {
  if (projects.length === 0) throw new UsageError("team leave needs at least one <project>");
  return asStore(db).txn("leave the team", async (s) => {
    const found: Project[] = [];
    for (const name of projects) {
      const p = await getProject(s, name);
      if (!p) throw new AppError(`no project '${name}' (see \`ob project list\`)`);
      found.push(p);
    }
    const ids = [...new Set(found.map((p) => p.id))];
    await s.q.update(s.t.project).set({ team_name: null }).where(inArray(s.t.project.id, ids));
    return found.map((p) => ({ project: p.id, team: p.team_name }));
  });
}

export type RemoveTeamResult =
  | { removed: false; reason: "unknown" }
  | { removed: false; reason: "in_use"; members: string[]; threads: string[] }
  | { removed: true; team: Team; members: string[]; threads: string[] };

/**
 * Remove a team. Refused while it has members or role rows, unless `force`, which clears both DB sides: every
 * member's team and the `<role>-<team>` agent rows. The caller unpins the threads it read first.
 */
export async function removeTeam(db: Database | Store, name: string, opts: { force?: boolean } = {}): Promise<RemoveTeamResult> {
  return asStore(db).txn("remove the team", async (s) => {
    const team = await getTeam(s, name);
    if (!team) return { removed: false, reason: "unknown" } as const;
    const members = (await teamMembers(s, name)).map((p) => p.id);
    const ids = TEAM_ROLES.map((r) => teamRoleAgentId(name, r));
    const threads = ((await s.q.select({ id: s.t.agent.id }).from(s.t.agent).where(inArray(s.t.agent.id, ids))) as Array<{ id: string }>).map(
      (r) => r.id,
    );
    if ((members.length > 0 || threads.length > 0) && !opts.force) {
      return { removed: false, reason: "in_use", members, threads } as const;
    }
    if (members.length > 0) await s.q.update(s.t.project).set({ team_name: null }).where(eq(s.t.project.team_name, name));
    for (const id of threads) await doneAgent(s, id);
    await s.q.delete(s.t.team).where(eq(s.t.team.name, name));
    return { removed: true, team, members, threads } as const;
  });
}

/** The refusal `team rm` gives while the team is in use. */
export function teamInUseRefusal(name: string, members: string[], threads: string[]): string {
  const parts: string[] = [];
  if (members.length > 0) parts.push(`members ${members.join(", ")}`);
  if (threads.length > 0) parts.push(`threads ${threads.join(", ")}`);
  return `team '${name}' still has ${parts.join(" and ")}; move them out (\`ob t3 team leave <project>\`, \`ob t3 <role> ${name} --remove\`), or re-run with --force`;
}

// --- handoff routing -------------------------------------------------------------------------------------

/** Where a handoff note goes: a team role's agent row, and the label its "no thread" skip says. */
export interface HandoffTarget {
  agentId: string;
  /** `<team> sentinel` or `<team> architect`. */
  label: string;
  /** The team, for the command a skip names. */
  team: string;
}

/** What `teamHandoffTarget` answers: a thread's row, or why there is none (a named skip or a failed read). */
export type HandoffRoute =
  | { kind: "team"; target: HandoffTarget }
  | { kind: "skip"; reason: string }
  | { kind: "failed"; reason: string };

/** The one line a project in no team prints at its handoff (OB-2255). Pure. */
function noTeamLine(project: string): string {
  return `${project} is in no team: ob t3 team join <team> ${project}, or ob t3 architect in its checkout`;
}

/**
 * Where a row's readying note goes (OB-2255), and where `ob close` looks for a held one: the ticket's project's
 * team's sentinel when one is bound, else its architect. A ticket with no project, or a project in no team, is a
 * named skip (no note). A read that FAILS is a failed route, so it is never mistaken for "no team".
 */
export async function teamHandoffTarget(input: {
  /** The ticket's project (id or name), null when the ticket names no item or the item has no project. */
  projectOf: () => Promise<string | null>;
  /** The project's team name, or null (also null for an unknown project). */
  teamOf: (project: string) => Promise<string | null>;
  registry: Pick<AgentRegistry, "read">;
  ticket: string;
}): Promise<HandoffRoute> {
  let project: string | null;
  try {
    project = await input.projectOf();
  } catch (err) {
    return { kind: "failed", reason: `could not read ${input.ticket}'s project: ${(err as Error).message}` };
  }
  if (!project) return { kind: "skip", reason: `${input.ticket} has no project, so there is no team thread to tell` };
  let team: string | null;
  try {
    team = await input.teamOf(project);
  } catch (err) {
    return { kind: "failed", reason: `could not read ${project}'s team: ${(err as Error).message}` };
  }
  if (!team) return { kind: "skip", reason: noTeamLine(project) };
  const sentinelId = teamRoleAgentId(team, "sentinel");
  let sentinelThread: string | null;
  try {
    sentinelThread = teamThreadIdOf(await input.registry.read(sentinelId));
  } catch (err) {
    return { kind: "failed", reason: `could not read ${sentinelId}: ${(err as Error).message}` };
  }
  if (sentinelThread) return { kind: "team", target: { agentId: sentinelId, label: `${team} sentinel`, team } };
  return { kind: "team", target: { agentId: teamRoleAgentId(team, "architect"), label: `${team} architect`, team } };
}

/** The store-backed `teamOf`: the project's team, looked up by id or name. */
export function storeTeamOf(db: Database | Store): (project: string) => Promise<string | null> {
  return async (project) => (await getProject(db, project))?.team_name ?? null;
}

/** The `teamOf` over a project list already read (the API client's `GET /projects`). Pure. */
export function teamOfIn(projects: Array<Pick<Project, "id" | "name"> & { team_name?: string | null }>): (project: string) => Promise<string | null> {
  return async (project) => projects.find((p) => p.id === project || p.name === project)?.team_name ?? null;
}

// --- the --team filters ----------------------------------------------------------------------------------

/**
 * The member projects of `team` out of a project list, refusing an unknown team by name. `teams` is the list of
 * known team names. One helper for `ob list --team`, `spinoff list --team` and `spinoff gateable --team`, local
 * and over the API. Pure.
 */
export function teamMembersIn(
  team: string,
  teams: readonly string[],
  projects: Array<Pick<Project, "id" | "name"> & { team_name?: string | null }>,
): Array<Pick<Project, "id" | "name">> {
  if (!teams.includes(team)) throw new UnknownTeamError(team);
  return projects.filter((p) => p.team_name === team);
}

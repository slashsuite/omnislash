// `ob role brief <team> <role>`: what a fresh role run needs, computed from what ob already holds, plus the one note
// the last run left (`ob role note`, stored on its `role_run` row; see role-run.ts).
//
// Three halves, so the API client and the store answer the same brief. `roleBriefStoreFacts` reads the store (served
// over the API: team, projects, rows, inbox, asks, the queue, the note). Pacing and the gate facts are read on the
// calling machine, since the T3 cache and the worktrees are local. `renderRoleBrief` is pure.
import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { Store } from "./db/store.ts";
import { complexityLabel, complexityOf } from "./models-file.ts";
import { asStore } from "./db/store.ts";
import { getFocusProject } from "./config.ts";
import { queryItems, type ItemRow } from "./items.ts";
import { listRoleMessages, type RoleMessage } from "./inbox.ts";
import { effectivePriority, priorityName } from "./priority.ts";
import { listProjects, UnknownTeamError } from "./project.ts";
import { pendingRoleNote, type RoleNote } from "./role-run.ts";
import { settingFor } from "./settings.ts";
import { DEFAULT_STAGE } from "./stage.ts";
import { getTeam, listTeams, teamMembersIn, teamRoleAgentId, teamView, TEAM_ROLES, type TeamRole, type TeamThread } from "./team.ts";
import { sortWorklist } from "./worklist.ts";
import { cacheCheckedAt, pacingSource, readWeeklyFromDoc, type PacingSource } from "./commands/usage.ts";
import { listAgents } from "../../../platform/cli-coord/src/agent.ts";
import { builderIdOf } from "../../../platform/cli-coord/src/clean-repo.ts";
import { listSpinoffs, parseJsonMap, rowsInTeam } from "../../../platform/cli-coord/src/commands/spinoff.ts";
import { spinoffStatusWord } from "../../../platform/cli-coord/src/spinoff-vocab.ts";

/** An inbox line's text: the body's first non-empty line, cut to 160 characters. Pure. */
function inboxFirstLine(body: string): string {
  const first = body.split("\n").find((l) => l.trim()) ?? "";
  const t = first.trim();
  return t.length <= 160 ? t : `${t.slice(0, 159)}…`;
}

/** Each list's cap; the rest is one `+N more` line. */
const BRIEF_LIST_CAP = 10;
/** The queue the brief shows. */
const BRIEF_NEXT_COUNT = 3;
/** Used this many points over the share of the week gone reads as `ahead`. */
const PACING_AHEAD_POINTS = 10;
/** A cache read longer ago than this is too old to pace by. */
const PACING_MAX_AGE_MS = 60 * 60 * 1000;

/** A spinoff row as the brief shows it (the stored status, so the gate filter reads the stored value). */
export interface BriefRow {
  id: number;
  ticket_ref: string;
  status: string;
  tier: string | null;
  /** OS-177: the row's score 1-10 (its tier's alias for an older row). */
  complexity: number | null;
  branch: string;
  worktree: string;
  repo: string;
  verdict?: string | null;
  verdict_reason?: string | null;
  gate_line?: string | null;
  base_sha?: string | null;
}

/** What the store holds for a brief: everything but pacing and the gate facts. */
export interface RoleBriefStoreFacts {
  team: { name: string; display_name: string | null; icon: string | null };
  role: TeamRole;
  projects: Array<{ id: string; name: string; stage: string }>;
  threads: TeamThread[];
  /** The team's rows whose status is not landed or failed, newest first. */
  rows: BriefRow[];
  /** Unread, not withdrawn, oldest first. */
  inbox: RoleMessage[];
  /** The team's role rows and its builders at `needs-human`. */
  asks: Array<{ id: string; note: string | null }>;
  /** Buildable items across the team's projects, in `ob next` order (the first ones only; `next_total` counts all). */
  next: Array<{ ref: string; priority: string; title: string }>;
  next_total: number;
  /** The newest note no brief has shown yet. */
  note: RoleNote | null;
}

export type Pacing =
  | { known: true; used_percent: number; elapsed_percent: number; resets_at: string; ahead: boolean }
  | { known: false; reason: string };

/** A handed-off row with what its worktree's last commit says. */
export interface GateEntry {
  ref: string;
  branch: string;
  /** The `State:` text with its label (a recorded verdict adds a `Gate:` line), null when none was read. */
  state: string | null;
  missing: boolean;
}

export interface RoleBriefFacts extends RoleBriefStoreFacts {
  pacing: Pacing;
  gate: GateEntry[];
}

const DONE_STATUSES = new Set(["merged", "failed"]);
const HANDED_OFF = "ready-for-gate";

/** Buildable: not blocked, and not already a row in flight. Pure. */
function isBuildable(item: ItemRow, inFlight: ReadonlySet<string>): boolean {
  if (item.status === "blocked") return false;
  return !inFlight.has(item.id) && !(item.ref !== null && inFlight.has(item.ref));
}

/**
 * The store half of a brief. A read only: the note stays waiting until the caller has printed it and calls
 * `markRoleNoteShown`, so a lost reply or a failed print never loses a note.
 */
export async function roleBriefStoreFacts(db: Database | Store, teamName: string, role: TeamRole): Promise<RoleBriefStoreFacts> {
  const s = asStore(db);
  const team = await getTeam(s, teamName);
  if (!team) throw new UnknownTeamError(teamName);
  const view = await teamView(s, team);
  const allProjects = await listProjects(s);
  const members = teamMembersIn(team.name, (await listTeams(s)).map((t) => t.name), allProjects);
  const memberIds = new Set(members.map((m) => m.id));
  const projects = allProjects
    .filter((p) => memberIds.has(p.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => ({ id: p.id, name: p.name, stage: p.stage ?? `${DEFAULT_STAGE} (not set)` }));

  const teamRows = rowsInTeam(await listSpinoffs(s), members, parseJsonMap(await settingFor(s, "repo_checkouts")));
  const active = teamRows.filter((r) => !DONE_STATUSES.has(r.status));
  const rows: BriefRow[] = active.map((r) => ({
      id: r.id,
      ticket_ref: r.ticket_ref,
      status: r.status,
      tier: r.tier,
      complexity: complexityOf(r.complexity, r.tier),
      branch: r.branch,
      worktree: r.worktree,
      repo: r.repo,
      verdict: r.verdict ?? null,
      verdict_reason: r.verdict_reason ?? null,
      gate_line: r.gate_line ?? null,
      base_sha: r.base_sha,
    }));

  const askIds = new Set<string>([...TEAM_ROLES.map((r) => teamRoleAgentId(team.name, r)), ...teamRows.map((r) => builderIdOf(r))]);
  const asks = (await listAgents(s))
    .filter((a) => a.status === "needs-human" && askIds.has(a.id))
    .map((a) => ({ id: a.id, note: a.note }));

  const inFlight = new Set<string>();
  for (const r of active) {
    inFlight.add(r.ticket_ref);
    if (r.item_id) inFlight.add(r.item_id);
  }
  const focus = await getFocusProject(s);
  const items: ItemRow[] = [];
  for (const p of members) items.push(...(await queryItems(s, { open: true, projectId: p.id })));
  const buildable = sortWorklist(items, focus).filter((i) => isBuildable(i, inFlight));
  const next = buildable.slice(0, BRIEF_NEXT_COUNT).map((i) => ({
    ref: i.ref ?? i.id,
    priority: priorityName(effectivePriority({ priority: i.priority, projectId: i.project_id, focusProject: focus })),
    title: i.title,
  }));

  const note = await pendingRoleNote(s, team.name, role);

  return {
    team: { name: team.name, display_name: team.display_name, icon: team.icon },
    role,
    projects,
    threads: view.threads,
    rows,
    inbox: await listRoleMessages(s, team.name, role),
    asks,
    next,
    next_total: buildable.length,
    note,
  };
}

/** Pacing from the T3 cache: unknown when the file is missing or unreadable, or its `checkedAt` is over an hour old. */
export function readPacing(file: string, now: Date, source: PacingSource = pacingSource()): Pacing {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { known: false, reason: `no readable usage cache at ${file}` };
  }
  const checkedAt = cacheCheckedAt(doc);
  const at = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  if (Number.isNaN(at)) return { known: false, reason: "the usage cache has no checkedAt" };
  if (now.getTime() - at > PACING_MAX_AGE_MS) return { known: false, reason: `the usage cache was last checked ${checkedAt!}, over an hour ago` };
  const w = readWeeklyFromDoc(doc, now, source.windowId);
  if (!w) return { known: false, reason: `the usage cache has no ${source.windowId} window` };
  if (Number.isNaN(w.elapsedPercent)) return { known: false, reason: "the usage cache has no readable resetsAt" };
  return {
    known: true,
    used_percent: w.usedPercent,
    elapsed_percent: w.elapsedPercent,
    resets_at: w.resetsAt,
    ahead: w.usedPercent - w.elapsedPercent > PACING_AHEAD_POINTS,
  };
}

/** What a brief reads through: the store (or the API), the pacing, and a handed-off row's worktree. */
export interface RoleBriefSeams {
  storeFacts(team: string, role: TeamRole): Promise<RoleBriefStoreFacts>;
  pacing(now: Date): Pacing;
  gateFacts(row: BriefRow): { missing: boolean; state: string | null };
}

/** The facts of a brief. Reads only: marking the note shown is the caller's, once it has delivered the brief. */
export async function gatherRoleBrief(seams: RoleBriefSeams, team: string, role: TeamRole, now: Date): Promise<RoleBriefFacts> {
  const store = await seams.storeFacts(team, role);
  const gate: GateEntry[] = store.rows
    .filter((r) => r.status === HANDED_OFF)
    .map((r) => ({ ref: r.ticket_ref, branch: r.branch, ...seams.gateFacts(r) }));
  return { ...store, pacing: seams.pacing(now), gate };
}

// --- the text ----------------------------------------------------------------------------------------------

/** A list capped at `cap`, with one `+N more` line for the rest. Pure. */
function capped<T>(items: readonly T[], line: (x: T) => string, cap = BRIEF_LIST_CAP, total = items.length): string[] {
  const out = items.slice(0, cap).map(line);
  if (total > Math.min(cap, items.length)) out.push(`+${total - Math.min(cap, items.length)} more`);
  return out;
}

function pacingLine(p: Pacing): string {
  if (!p.known) return `unknown (${p.reason})`;
  const lead = `${p.used_percent}% used, ${Math.round(p.elapsed_percent)}% of the week gone, resets ${p.resets_at}`;
  return p.ahead ? `${lead}; ahead` : lead;
}

/** The brief as text: nine sections in a fixed order. Pure. */
export function renderRoleBrief(f: RoleBriefFacts): string {
  const L: string[] = [];
  const section = (title: string, body: string[]) => {
    L.push("", `## ${title}`);
    L.push(...(body.length > 0 ? body : ["none"]));
  };
  const display = f.team.display_name?.trim() ? ` (${f.team.display_name.trim()})` : "";
  L.push(`# Brief for ${f.team.name} ${f.role}`);

  const threads = f.threads.length > 0 ? f.threads.map((t) => `${t.role} ${t.thread_id}`).join(", ") : "none bound";
  section("Team", [
    `${f.team.name}${display}; you are the ${f.role}`,
    `Threads: ${threads}`,
    ...capped(f.projects, (p) => `Project ${p.name}: ${p.stage}`),
  ]);
  section("Pacing", [pacingLine(f.pacing)]);
  section(
    "Rows in flight",
    capped(f.rows, (r) => `${r.ticket_ref} ${spinoffStatusWord(r.status)}, ${r.complexity === null ? "complexity -" : complexityLabel(r.complexity)}, branch ${r.branch}`),
  );
  section(
    "PRs to gate",
    // `state` already carries its `State:` label, and a recorded verdict adds a `Gate:` line: keep the first line only.
    capped(f.gate, (g) => `${g.ref} ${g.branch}: ${g.missing ? "worktree missing" : (g.state?.split("\n")[0] ?? "no State line")}`),
  );
  section("Unread inbox", capped(f.inbox, (m) => `#${m.id} from ${m.from_actor} (${m.kind}): ${inboxFirstLine(m.body)}`));
  section("Open asks for the owner", capped(f.asks, (a) => `${a.id}: ${a.note?.trim() || "(no note)"}`));
  section("Next three", capped(f.next, (n) => `${n.ref} ${n.priority}: ${n.title}`, BRIEF_NEXT_COUNT, f.next_total));
  section("Skill", [`Load /ob-${f.role}.`]);
  L.push("", "## Note from the last run");
  if (f.note) L.push(...f.note.body.replace(/\n$/, "").split("\n"));
  else L.push("none");
  return L.join("\n");
}

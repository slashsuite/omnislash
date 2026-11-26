// `ob role tick` (OS-67): a 15 minute client job that writes what needs a team's architect into its inbox and delivers
// it with `deliverToRole`. When nothing changed it does nothing: no T3 call, no run.
//
// The findings are read from the store only (`tickFindings`), here for the store and on the server for the API client.
// Each finding is one inbox message whose `client_key` carries the finding's stamp, so an unchanged finding writes
// nothing on the next pass and a changed one (a newer heartbeat, an edited item) writes again.
import type { Database } from "bun:sqlite";
import type { Store } from "./db/store.ts";
import { asStore } from "./db/store.ts";
import { listProjects } from "./project.ts";
import { isProjectHeld } from "./project-status.ts";
import { getTeam, teamMembersIn, listTeams } from "./team.ts";
import { UnknownTeamError } from "./project.ts";
import { nextWorklist } from "./worklist.ts";
import { PRIORITY_FLAKE } from "./priority.ts";
import { getAgent } from "../../../platform/cli-coord/src/agent.ts";
import { listSpinoffs, parseJsonMap, rowsInTeam } from "../../../platform/cli-coord/src/commands/spinoff.ts";
import { IN_FLIGHT } from "../../../platform/cli-coord/src/spinoff-vocab.ts";
import { spinoffRowsServingItem } from "../../../platform/cli-coord/src/spinoff-item.ts";
import { refuseUncheckedDispatch } from "../../../platform/cli-coord/src/spinoff-check.ts";
import { settingFor } from "./settings.ts";
import { AppError } from "./errors.ts";
import { T3_LAUNCHER } from "./t3/dispatch.ts";

/** A builder whose heartbeat (or, with no agent row, whose launch) is older than this is stale. */
const TICK_STALE_MS = 60 * 60 * 1000;

/** Who a tick's messages are from. */
export const TICK_FROM = "tick";

export type TickKind = "stale-builder" | "flake" | "idle-repo" | "builder-context";

/** One thing the architect should look at. `stamp` changes exactly when the finding does. */
export interface TickFinding {
  kind: TickKind;
  /** The ticket (stale-builder, flake, builder-context) or the project id (idle-repo). */
  ref: string;
  stamp: string;
  body: string;
}

/** The inbox key a finding is stored once under. Pure. */
export function tickClientKey(team: string, f: Pick<TickFinding, "kind" | "ref" | "stamp">): string {
  return `tick:${team}:${f.kind}:${f.ref}:${f.stamp}`;
}

function olderThan(iso: string | null | undefined, now: Date, ms: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && now.getTime() - t > ms;
}

/**
 * What needs the team's architect, from the store only: builders gone quiet, flake tickets nobody is fixing, and
 * member projects with nothing in flight whose top item would dispatch today. A paused or archived member is skipped (OS-134). An unknown team throws.
 */
export async function tickFindings(db: Database | Store, team: string, now: Date = new Date()): Promise<TickFinding[]> {
  const s = asStore(db);
  if (!(await getTeam(s, team))) throw new UnknownTeamError(team);
  const members = teamMembersIn(team, (await listTeams(s)).map((t) => t.name), await listProjects(s));
  const checkouts = parseJsonMap(await settingFor(s, "repo_checkouts"));
  const live = (await listSpinoffs(s)).filter((r) => IN_FLIGHT.has(r.status)).sort((a, b) => a.id - b.id);
  const teamLive = rowsInTeam(live, members, checkouts);
  const out: TickFinding[] = [];

  // A `building` row (stored `launched`) whose builder has not beaten for an hour.
  for (const row of teamLive) {
    if (row.status !== "launched") continue;
    // Only T3 builders beat or launch today: the store still holds `building` rows from the launchers retired in October
    // (omnishell, none), whose stored ticket refs are free text, and they would be reported stale forever (OS-82).
    if (row.launcher !== T3_LAUNCHER) continue;
    const agent = row.agent_id ? await getAgent(s, row.agent_id) : null;
    const at = agent ? agent.heartbeat_at : row.launched_at;
    if (!olderThan(at, now, TICK_STALE_MS)) continue;
    const mins = Math.floor((now.getTime() - Date.parse(at!)) / 60_000);
    const quiet = agent
      ? `its builder ${agent.id} has given no heartbeat for ${mins} minutes (last ${at})`
      : `it launched ${mins} minutes ago (${at}) and no builder has checked in`;
    out.push({
      kind: "stale-builder",
      ref: row.ticket_ref,
      stamp: `building@${at}`,
      body: `${row.ticket_ref} is building but ${quiet}; check its thread (spinoff row ${row.id}).`,
    });
  }

  for (const project of members) {
    // OS-134: a paused or archived project is not watched: no flake or idle-repo finding for it.
    if (isProjectHeld(project)) continue;
    const items = (await nextWorklist(s, { project: project.id })).items;
    for (const item of items) {
      if (item.priority !== PRIORITY_FLAKE) continue;
      if ((await spinoffRowsServingItem(s, live, item)).rows.length > 0) continue;
      const ref = item.ref ?? item.id;
      out.push({
        kind: "flake",
        ref,
        stamp: item.updated_at,
        body: `${ref} is a flake ticket in ${project.id} and no builder is on it: "${item.title}".`,
      });
    }
    if (rowsInTeam(live, [project], checkouts).length > 0) continue;
    for (const item of items) {
      if (item.status === "blocked") continue;
      const ref = item.ref ?? item.id;
      try {
        await refuseUncheckedDispatch(s, ref);
      } catch (err) {
        // A refusal means it would not dispatch; anything else (the store failing) fails the pass, never hides the finding.
        if (err instanceof AppError) continue;
        throw err;
      }
      out.push({
        kind: "idle-repo",
        ref: project.id,
        stamp: `${ref}@${item.updated_at}`,
        body: `${project.id} has nothing in flight, and its top dispatchable item ${ref} would dispatch today: "${item.title}".`,
      });
      break;
    }
  }
  return out;
}

/** A builder row as the context check reads it. */
export interface ContextRow {
  id: number;
  ticket_ref: string;
  status: string;
  branch: string;
  worktree: string;
  launcher?: string | null;
  t3_thread_id?: string | null;
}

/**
 * OS-213: a building T3 builder whose thread has passed `limit` context tokens, as one relaunch prompt for the
 * architect. The stamp is the thread the row records, so the prompt is written once per recorded thread however long it
 * stays over. A thread opened by hand is not on the row, so it is not watched (ob has no command to move a launched row
 * to a new thread), and the prompt says so. A thread whose context cannot be read gives no finding. Pure aside from
 * `readContext`.
 */
export function builderContextFindings(rows: readonly ContextRow[], readContext: (threadId: string) => number | null, limit: number): TickFinding[] {
  const out: TickFinding[] = [];
  for (const row of rows) {
    if (row.status !== "launched" || row.launcher !== T3_LAUNCHER || !row.t3_thread_id) continue;
    const tokens = readContext(row.t3_thread_id);
    if (tokens === null || tokens < limit) continue;
    const ref = row.ticket_ref;
    out.push({
      kind: "builder-context",
      ref,
      stamp: `context@${row.t3_thread_id}`,
      body: [
        `${ref}'s builder thread ${row.t3_thread_id} is at ${Math.round(tokens / 1000)}k context, past ${limit / 1000}k (spinoff row ${row.id}).`,
        `Relaunch it at its next quiet point: ask it for a handoff (\`ob note ${ref} "<where it is and what is next>"\`), settle the thread, then open a fresh thread on its worktree ${row.worktree} (branch ${row.branch}) seeded with that note and its brief (\`ob spinoff brief ${ref}\`).`,
        "ob does not relaunch it for you, and it does not watch a thread opened by hand: this prompt is once per recorded thread.",
      ].join(" "),
    });
  }
  return out;
}

// OB-2257: a team role thread's handoff, held by ob while `ob t3 team restart` replaces the thread.
//
// The old thread writes everything its replacement needs to carry on and records it with
// `ob t3 team handoff <team> --role <r> --body-file <f>`; the restart waits for that row, settles the old thread,
// opens the new one and seeds it with the body, then marks the row consumed with the new thread's id. The row
// lives in ob's store (and over the API), so a restart run from any machine reads the same handoff.
import type { Database } from "bun:sqlite";
import { and, desc, eq, lte } from "drizzle-orm";
import { nowIso } from "./db.ts";
import { asStore, type Store } from "./db/store.ts";
import { UsageError } from "./errors.ts";
import { UnknownTeamError } from "./project.ts";
import { getAgent } from "../../../platform/cli-coord/src/agent.ts";
import { getTeam, TEAM_ROLES, teamRoleAgentId, teamThreadIdOf, type TeamRole } from "./team.ts";

export interface TeamHandoff {
  id: number;
  team: string;
  role: TeamRole;
  /**
   * The thread that wrote it (OB-2275): the sender's own id when the recorder knew it (`T3CODE_THREAD_ID`, or the
   * API's `from_thread_id`), else the role's bound thread at record time. A thread replaced by a restart that
   * still reports writes its own id here, never its replacement's.
   */
  old_thread_id: string | null;
  body: string;
  created_at: string;
  /** Set once the replacement was seeded with this body. */
  consumed_at: string | null;
  new_thread_id: string | null;
}

/** A role name from a flag or a request, refused by name when it is not one. Pure. */
export function parseTeamRole(raw: string | undefined | null, flag = "--role"): TeamRole {
  if (raw && (TEAM_ROLES as readonly string[]).includes(raw)) return raw as TeamRole;
  throw new UsageError(`${flag} must be one of ${TEAM_ROLES.join("|")}${raw ? ` (got '${raw}')` : ""}`);
}

/**
 * The most a handoff body may hold: a thread's working state, not a transcript. T3 takes a launch message of at
 * most 120,000 characters, and the body rides in the seed, so a longer one would fail the launch AFTER the old
 * thread was settled; it is refused when recorded instead.
 */
export const HANDOFF_BODY_MAX = 64_000;

/** A body to record, trimmed; refused when empty or over the cap. Pure. */
export function parseHandoffBody(raw: string): string {
  const body = raw.trim();
  if (!body) throw new UsageError("the handoff body is empty");
  if (body.length > HANDOFF_BODY_MAX) throw new UsageError(`the handoff body is ${body.length} characters; at most ${HANDOFF_BODY_MAX}`);
  return body;
}

/**
 * Record a role's handoff. The team must exist. The writer is `fromThreadId` when the caller knows it (OB-2275);
 * otherwise it is read from the role's row, so a thread writing from a terminal never has to know its own id. A
 * role with no bound thread and no sender records with no old thread.
 */
export async function recordTeamHandoff(
  db: Database | Store,
  input: { team: string; role: TeamRole; body: string; fromThreadId?: string | null },
): Promise<TeamHandoff> {
  const body = parseHandoffBody(input.body);
  const s = asStore(db);
  if (!(await getTeam(s, input.team))) throw new UnknownTeamError(input.team);
  const from = input.fromThreadId?.trim() || null;
  const oldThread = from ?? teamThreadIdOf(await getAgent(s, teamRoleAgentId(input.team, input.role)));
  const rows = (await s.q
    .insert(s.t.teamHandoff)
    .values({ team: input.team, role: input.role, old_thread_id: oldThread, body, created_at: nowIso() })
    .returning()) as TeamHandoff[];
  return rows[0]!;
}

/** OB-2275: which of a role's handoffs `latestTeamHandoff` looks at: one writer's, and those recorded by a moment. */
export interface HandoffFilter {
  from?: string | null;
  /** An ISO time: only handoffs recorded at or before it. */
  createdBefore?: string | null;
}

/** The newest handoff a role recorded, or null, among those the filter keeps. */
export async function latestTeamHandoff(db: Database | Store, team: string, role: TeamRole, filter: HandoffFilter = {}): Promise<TeamHandoff | null> {
  const s = asStore(db);
  const t = s.t.teamHandoff;
  const from = filter.from?.trim() || null;
  const by = filter.createdBefore?.trim() || null;
  const where = and(eq(t.team, team), eq(t.role, role), ...(from ? [eq(t.old_thread_id, from)] : []), ...(by ? [lte(t.created_at, by)] : []));
  const rows = (await s.q.select().from(t).where(where).orderBy(desc(t.id)).limit(1)) as TeamHandoff[];
  return rows[0] ?? null;
}

/** Mark a team's handoff consumed by the thread it seeded. Null when the team has no such row. */
export async function consumeTeamHandoff(db: Database | Store, team: string, id: number, newThreadId: string): Promise<TeamHandoff | null> {
  const s = asStore(db);
  const t = s.t.teamHandoff;
  const rows = (await s.q.update(t).set({ consumed_at: nowIso(), new_thread_id: newThreadId }).where(and(eq(t.id, id), eq(t.team, team))).returning()) as TeamHandoff[];
  return rows[0] ?? null;
}

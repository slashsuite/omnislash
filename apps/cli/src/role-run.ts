// Role runs: one T3 thread per team role at a time, recorded in `role_run`.
//
// A run is opened by `ob role start <team> <role>`, which reuses the open run while its thread is live and otherwise
// opens a new thread (commands/role.ts, where T3 is). This module is the store half, served locally and over the API:
// the marker row, the thread id, the activity a read of the thread reports, and the end.
//
// Two guards keep it to one run per role. The partial unique index on (team, role) where `ended_at` is null refuses a
// second open row, so two starts at once insert one marker between them. The lease `role:<team>:<role>`, held by
// `role-run-<id>` so any ob process can release it, is the start mutex `ob lease status` shows; its long TTL is only a
// backstop, since nothing runs in a T3 thread to heartbeat it, so it is never read as liveness.
import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { nowIso } from "./db.ts";
import { asStore, type Store } from "./db/store.ts";
import { AppError, UsageError } from "./errors.ts";
import { UnknownTeamError } from "./project.ts";
import { getTeam, type TeamRole } from "./team.ts";
import { acquireLease, releaseLease } from "../../../platform/cli-coord/src/lease.ts";

export interface RoleRun {
  id: number;
  team: string;
  role: TeamRole;
  /** Null only while the launch is in flight, or when a launch died before T3 answered. */
  thread_id: string | null;
  /** The T3 base URL the run was opened on. */
  t3_host: string;
  started_at: string;
  last_activity_at: string;
  item_count: number | null;
  /** OS-57: the context tokens the last `ob role tick` read from T3's state db; null when never read or unknown. */
  context_tokens: number | null;
  ended_at: string | null;
  end_reason: RoleRunEndReason | null;
  /** OS-55: the note this run leaves its successor (`ob role note`); null when none was written. */
  successor_note: string | null;
  note_at: string | null;
  /** When a brief printed the note; null while it waits for the next run. */
  note_shown_at: string | null;
}

const ROLE_RUN_END_REASONS = ["idle", "context", "gone", "manual", "superseded"] as const;
export type RoleRunEndReason = (typeof ROLE_RUN_END_REASONS)[number];

/** The lease TTL: a day, a backstop for a run whose end was never recorded. */
const ROLE_RUN_LEASE_TTL_S = 86_400;

/** `role:<team>:<role>`. Pure. */
export function roleRunLeaseKey(team: string, role: TeamRole): string {
  return `role:${team}:${role}`;
}

/** `role-run-<id>`: the run's lease holder, and the reader of the messages it was given (OS-56). Pure. */
export function roleRunHolder(id: number): string {
  return `role-run-${id}`;
}

/** An end reason from a flag or a request, refused by name when it is not one. Pure. */
export function parseEndReason(raw: string | undefined | null, flag = "--reason"): RoleRunEndReason {
  if (raw && (ROLE_RUN_END_REASONS as readonly string[]).includes(raw)) return raw as RoleRunEndReason;
  throw new UsageError(`${flag} must be one of ${ROLE_RUN_END_REASONS.join("|")}${raw ? ` (got '${raw}')` : ""}`);
}

async function requireTeam(s: Store, team: string): Promise<void> {
  if (!(await getTeam(s, team))) throw new UnknownTeamError(team);
}

/** The team's open runs (one per role at most), in role-id order; `role` keeps one role's. */
export async function openRoleRuns(db: Database | Store, team: string, role?: TeamRole): Promise<RoleRun[]> {
  const s = asStore(db);
  await requireTeam(s, team);
  const t = s.t.roleRun;
  const where = and(eq(t.team, team), isNull(t.ended_at), ...(role ? [eq(t.role, role)] : []));
  return (await s.q.select().from(t).where(where).orderBy(asc(t.id))) as RoleRun[];
}

async function runById(s: Store, team: string, id: number): Promise<RoleRun | null> {
  const t = s.t.roleRun;
  const rows = (await s.q.select().from(t).where(and(eq(t.id, id), eq(t.team, team))).limit(1)) as RoleRun[];
  return rows[0] ?? null;
}

/** The run a lease holder `role-run-<id>` names, or null for any other holder. Pure. */
function runIdOfHolder(holder: string): number | null {
  const m = /^role-run-(\d+)$/.exec(holder);
  return m ? Number(m[1]) : null;
}

/**
 * Open a run's marker: a row with no thread yet, holding the role's lease. When the role already has an open run, that
 * run is answered instead and nothing is written (`created` false), which is how the second of two starts at once
 * learns of the first. The lease is taken over from a holder whose run has ended (an end that never released it);
 * any other live holder refuses by name and the marker is removed.
 */
export async function markRoleRun(
  db: Database | Store,
  input: { team: string; role: TeamRole; t3Host: string },
): Promise<{ run: RoleRun; created: boolean }> {
  const s = asStore(db);
  await requireTeam(s, input.team);
  const t = s.t.roleRun;
  const now = nowIso();
  const inserted = (await s.q
    .insert(t)
    .values({ team: input.team, role: input.role, t3_host: input.t3Host, started_at: now, last_activity_at: now })
    .onConflictDoNothing()
    .returning()) as RoleRun[];
  const run = inserted[0];
  if (!run) {
    const [open] = await openRoleRuns(s, input.team, input.role);
    if (!open) throw new AppError(`could not open a ${input.team} ${input.role} run, and no open one was found; re-run`);
    return { run: open, created: false };
  }
  const key = roleRunLeaseKey(input.team, input.role);
  const holder = roleRunHolder(run.id);
  let lease = await acquireLease(s, key, holder, ROLE_RUN_LEASE_TTL_S);
  if (!lease.ok) {
    const heldBy = runIdOfHolder(lease.holder);
    // The holder's run ended without releasing it, or is gone (a team removed with --force drops its runs).
    const held = heldBy === null ? null : await runById(s, input.team, heldBy);
    const stale = heldBy !== null && (held === null || held.ended_at !== null);
    if (stale) {
      await releaseLease(s, key, lease.holder, true);
      lease = await acquireLease(s, key, holder, ROLE_RUN_LEASE_TTL_S);
    }
  }
  if (!lease.ok) {
    await s.q.delete(t).where(eq(t.id, run.id));
    throw new AppError(`${key} is held by ${lease.holder}, so no ${input.team} ${input.role} run was opened; release it (\`ob lease release ${key} --holder ${lease.holder}\`) if that holder is gone`);
  }
  return { run, created: true };
}

/** What a run's update may carry: the thread a launch got, the activity a read saw, or the end. */
export interface RoleRunPatch {
  thread_id?: string;
  item_count?: number | null;
  /** OS-57: the context size the tick read (null when it could not be read). */
  context_tokens?: number | null;
  last_activity_at?: string;
  end_reason?: RoleRunEndReason;
}

/**
 * Update an open run. `end_reason` ends it (sets `ended_at`) and releases its lease. An ended run is answered as it is
 * and never changed again; an unknown one throws.
 */
export async function updateRoleRun(db: Database | Store, team: string, id: number, patch: RoleRunPatch): Promise<RoleRun> {
  const s = asStore(db);
  await requireTeam(s, team);
  const run = await runById(s, team, id);
  if (!run) throw new AppError(`no run ${id} for team '${team}'`);
  if (run.ended_at) return run;
  const set: Partial<RoleRun> = {};
  if (patch.thread_id !== undefined) set.thread_id = patch.thread_id;
  if (patch.item_count !== undefined) set.item_count = patch.item_count;
  if (patch.context_tokens !== undefined) set.context_tokens = patch.context_tokens;
  if (patch.last_activity_at !== undefined) set.last_activity_at = patch.last_activity_at;
  if (patch.end_reason !== undefined) {
    set.ended_at = nowIso();
    set.end_reason = patch.end_reason;
  }
  if (Object.keys(set).length === 0) return run;
  const t = s.t.roleRun;
  const rows = (await s.q.update(t).set(set).where(and(eq(t.id, id), isNull(t.ended_at))).returning()) as RoleRun[];
  if (patch.end_reason !== undefined) await releaseLease(s, roleRunLeaseKey(team, run.role), roleRunHolder(id));
  return rows[0] ?? (await runById(s, team, id))!;
}

// --- the successor note (OS-55) ---------------------------------------------------------------------------

/** A successor note's caps: a note over either is refused whole, never cut, so the writer trims it. */
const ROLE_NOTE_MAX_LINES = 40;
const ROLE_NOTE_MAX_CHARS = 4000;

/** The note's line count: a trailing newline does not start another line. Pure. */
export function roleNoteLines(body: string): number {
  const trimmed = body.endsWith("\n") ? body.slice(0, -1) : body;
  return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
}

/** Refuse an empty note, or one over either cap, naming both counts and both limits. Pure. */
export function checkRoleNote(body: string): void {
  if (!body.trim()) throw new UsageError("the note is empty");
  const lines = roleNoteLines(body);
  const chars = body.length;
  if (lines > ROLE_NOTE_MAX_LINES || chars > ROLE_NOTE_MAX_CHARS) {
    throw new UsageError(
      `the note is ${lines} lines and ${chars} characters; the limit is ${ROLE_NOTE_MAX_LINES} lines and ${ROLE_NOTE_MAX_CHARS} characters, so nothing was stored (trim it and write it again)`,
    );
  }
}

/** A note waiting for the next run: the run that wrote it, the text, and when. */
export interface RoleNote {
  run_id: number;
  body: string;
  note_at: string;
}

/**
 * Store the successor note on the role's open run, else on its most recently ended run. A second note on the same
 * run replaces the first and waits to be shown again. A role with no run at all refuses by name.
 */
export async function writeRoleNote(db: Database | Store, team: string, role: TeamRole, body: string): Promise<RoleRun> {
  checkRoleNote(body);
  const s = asStore(db);
  await requireTeam(s, team);
  const t = s.t.roleRun;
  const [open] = await openRoleRuns(s, team, role);
  const target =
    open ??
    ((await s.q.select().from(t).where(and(eq(t.team, team), eq(t.role, role))).orderBy(desc(t.ended_at), desc(t.id)).limit(1)) as RoleRun[])[0];
  if (!target) throw new AppError(`${team} ${role} has no run to leave a note on (start one with \`ob role start ${team} ${role}\`)`);
  const rows = (await s.q
    .update(t)
    .set({ successor_note: body, note_at: nowIso(), note_shown_at: null })
    .where(eq(t.id, target.id))
    .returning()) as RoleRun[];
  return rows[0]!;
}

/** The newest note on (team, role) that no brief has shown yet, or null. */
export async function pendingRoleNote(db: Database | Store, team: string, role: TeamRole): Promise<RoleNote | null> {
  const s = asStore(db);
  await requireTeam(s, team);
  const t = s.t.roleRun;
  const rows = (await s.q
    .select()
    .from(t)
    .where(and(eq(t.team, team), eq(t.role, role), isNotNull(t.successor_note), isNull(t.note_shown_at)))
    .orderBy(desc(t.note_at), desc(t.id))
    .limit(1)) as RoleRun[];
  const run = rows[0];
  return run ? { run_id: run.id, body: run.successor_note!, note_at: run.note_at! } : null;
}

/** Mark a run's note shown, so the next brief prints `none`. A note already shown keeps its first time. */
export async function markRoleNoteShown(db: Database | Store, team: string, runId: number): Promise<void> {
  const s = asStore(db);
  await requireTeam(s, team);
  const t = s.t.roleRun;
  await s.q.update(t).set({ note_shown_at: nowIso() }).where(and(eq(t.id, runId), eq(t.team, team), isNull(t.note_shown_at)));
}

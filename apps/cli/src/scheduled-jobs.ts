// OS-310: the scheduled job record (`ob schedule`). A job sends a prompt to a team role, or runs a shell command, on
// a schedule (see ./schedule.ts). This module stores the jobs and their runs; running them is OS-311.
//
// Every write is checked before anything is stored: the name, the schedule (an invalid one is refused and nothing
// is written), one target, and for a role job the team and role by `ob send`'s rules.
import type { Database } from "bun:sqlite";
import { and, asc, desc, eq } from "drizzle-orm";
import { nowIso } from "./db.ts";
import { asStore, type Store } from "./db/store.ts";
import { AppError, UsageError } from "./errors.ts";
import { requireRecipient } from "./inbox.ts";
import { computeNextRunAt, normalizeScheduleExpr, parseScheduleKind, type ScheduleKind } from "./schedule.ts";
import { parseTeamRole } from "./team-handoff.ts";
import type { TeamRole } from "./team.ts";

export const JOB_TARGET_KINDS = ["role", "command"] as const;
export type JobTargetKind = (typeof JOB_TARGET_KINDS)[number];

export const JOB_RUN_STATUSES = ["running", "succeeded", "failed", "skipped"] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

/** The most of a command's output a run keeps: the last this many characters. */
export const OUTPUT_TAIL_MAX = 4000;

export interface ScheduledJob {
  id: number;
  name: string;
  enabled: boolean;
  schedule_kind: ScheduleKind;
  schedule_expr: string;
  target_kind: JobTargetKind;
  team: string | null;
  role: TeamRole | null;
  prompt: string | null;
  command: string | null;
  cwd: string | null;
  host: string | null;
  respect_good_night: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduledJobRun {
  id: number;
  job_id: number;
  started_at: string;
  finished_at: string | null;
  status: JobRunStatus;
  host: string | null;
  exit_code: number | null;
  output_tail: string | null;
  role_message_id: number | null;
}

/** What a new job is. A role job names team, role and prompt; a command job names command, and may name cwd and host. */
export interface ScheduledJobInput {
  name: string;
  schedule_kind: string;
  schedule_expr: string;
  target_kind: string;
  team?: string | null | undefined;
  role?: string | null | undefined;
  prompt?: string | null | undefined;
  command?: string | null | undefined;
  cwd?: string | null | undefined;
  host?: string | null | undefined;
  respect_good_night?: boolean | undefined;
}

/** An edit: any field of the input but the name and the target kind, plus `enabled` (pause and resume). */
export interface ScheduledJobPatch {
  enabled?: boolean | undefined;
  schedule_kind?: string | undefined;
  schedule_expr?: string | undefined;
  team?: string | null | undefined;
  role?: string | null | undefined;
  prompt?: string | null | undefined;
  command?: string | null | undefined;
  cwd?: string | null | undefined;
  host?: string | null | undefined;
  respect_good_night?: boolean | undefined;
}

/** No job by that name or id. 404 over the API. */
export class ScheduledJobNotFoundError extends AppError {
  constructor(readonly ref: string) {
    super(`no scheduled job '${ref}' (see \`ob schedule list --all\`)`);
    this.name = "ScheduledJobNotFoundError";
  }
}

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

/** A job name: a lowercase slug that starts with a letter, so it is never read as an id. Pure. */
export function parseJobName(raw: string): string {
  const name = raw.trim();
  if (!NAME_RE.test(name)) throw new UsageError(`job name '${raw}' must be a lowercase slug (a-z, 0-9, -) that starts with a letter, at most 64 characters`);
  return name;
}

/** The last `max` characters of a command's output. Pure. */
export function tailOutput(output: string, max = OUTPUT_TAIL_MAX): string {
  return output.length <= max ? output : output.slice(output.length - max);
}

function blankToNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/** The checked, normalized columns of a job, before the team and role are looked up. Pure. */
interface CheckedJob {
  schedule_kind: ScheduleKind;
  schedule_expr: string;
  target_kind: JobTargetKind;
  team: string | null;
  role: TeamRole | null;
  prompt: string | null;
  command: string | null;
  cwd: string | null;
  host: string | null;
  respect_good_night: boolean;
}

function checkJob(input: Omit<ScheduledJobInput, "name">): CheckedJob {
  const kind = parseScheduleKind(input.schedule_kind);
  const expr = normalizeScheduleExpr(kind, input.schedule_expr);
  if (!(JOB_TARGET_KINDS as readonly string[]).includes(input.target_kind)) {
    throw new UsageError(`target kind must be one of ${JOB_TARGET_KINDS.join("|")} (got '${input.target_kind}')`);
  }
  const target = input.target_kind as JobTargetKind;
  const team = blankToNull(input.team);
  const prompt = input.prompt == null || input.prompt.trim().length === 0 ? null : input.prompt;
  const command = input.command == null || input.command.trim().length === 0 ? null : input.command;
  const cwd = blankToNull(input.cwd);
  const host = blankToNull(input.host);
  if (target === "role") {
    if (command !== null || cwd !== null || host !== null) throw new UsageError("a role job takes --team, --role and --prompt, not --cmd, --cwd or --host");
    if (team === null) throw new UsageError("a role job needs --team <team>");
    if (prompt === null) throw new UsageError("a role job needs --prompt <text>");
    return { schedule_kind: kind, schedule_expr: expr, target_kind: target, team, role: parseTeamRole(input.role, "--role"), prompt, command: null, cwd: null, host: null, respect_good_night: input.respect_good_night ?? true };
  }
  if (team !== null || (input.role != null && input.role !== "") || prompt !== null) throw new UsageError("a command job takes --cmd, --cwd and --host, not --team, --role or --prompt");
  if (command === null) throw new UsageError("a command job needs --cmd <shell>");
  return { schedule_kind: kind, schedule_expr: expr, target_kind: target, team: null, role: null, prompt: null, command, cwd, host, respect_good_night: input.respect_good_night ?? true };
}

type Row = Omit<ScheduledJob, "enabled" | "respect_good_night"> & { enabled: number | boolean; respect_good_night: number | boolean };

function toJob(row: Row): ScheduledJob {
  return { ...row, enabled: row.enabled === 1 || row.enabled === true, respect_good_night: row.respect_good_night === 1 || row.respect_good_night === true };
}

/** A job by id (digits) or name, or null. */
export async function getScheduledJob(db: Database | Store, ref: string): Promise<ScheduledJob | null> {
  const s = asStore(db);
  const t = s.t.scheduledJob;
  const raw = ref.trim();
  const where = /^\d+$/.test(raw) ? eq(t.id, Number(raw)) : eq(t.name, raw);
  const rows = (await s.q.select().from(t).where(where).limit(1)) as Row[];
  return rows[0] ? toJob(rows[0]) : null;
}

/** A job by id or name, or ScheduledJobNotFoundError. */
export async function requireScheduledJob(db: Database | Store, ref: string): Promise<ScheduledJob> {
  const job = await getScheduledJob(db, ref);
  if (!job) throw new ScheduledJobNotFoundError(ref);
  return job;
}

/** The enabled jobs by name, or every job with `all`. */
export async function listScheduledJobs(db: Database | Store, opts: { all?: boolean } = {}): Promise<ScheduledJob[]> {
  const s = asStore(db);
  const t = s.t.scheduledJob;
  const q = s.q.select().from(t);
  const rows = (await (opts.all ? q : q.where(eq(t.enabled, 1))).orderBy(asc(t.name))) as Row[];
  return rows.map(toJob);
}

/** Store a new job, due at the next time its schedule gives after `now`. A refused input writes nothing. */
export async function createScheduledJob(db: Database | Store, input: ScheduledJobInput, now: Date = new Date()): Promise<ScheduledJob> {
  const s = asStore(db);
  const name = parseJobName(input.name);
  const job = checkJob(input);
  const nextRunAt = computeNextRunAt(job.schedule_kind, job.schedule_expr, now);
  if (job.team !== null && job.role !== null) await requireRecipient(s, job.team, job.role);
  if (await getScheduledJob(s, name)) throw new AppError(`a scheduled job named '${name}' already exists (see \`ob schedule show ${name}\`)`);
  const stamp = nowIso();
  const t = s.t.scheduledJob;
  const rows = (await s.q
    .insert(t)
    .values({ name, enabled: 1, ...job, respect_good_night: job.respect_good_night ? 1 : 0, next_run_at: nextRunAt, created_at: stamp, updated_at: stamp })
    .returning()) as Row[];
  return toJob(rows[0]!);
}

/**
 * Edit a job: pause (`enabled: false`), resume (`enabled: true`) or change its fields. A changed schedule, or a
 * resume, recomputes `next_run_at` from `now`; a `once` job that has run stays done on a resume. A pause keeps it.
 */
export async function updateScheduledJob(db: Database | Store, ref: string, patch: ScheduledJobPatch, now: Date = new Date()): Promise<ScheduledJob> {
  const s = asStore(db);
  const cur = await requireScheduledJob(s, ref);
  const merged = checkJob({
    schedule_kind: patch.schedule_kind ?? cur.schedule_kind,
    schedule_expr: patch.schedule_expr ?? cur.schedule_expr,
    target_kind: cur.target_kind,
    team: patch.team !== undefined ? patch.team : cur.team,
    role: patch.role !== undefined ? patch.role : cur.role,
    prompt: patch.prompt !== undefined ? patch.prompt : cur.prompt,
    command: patch.command !== undefined ? patch.command : cur.command,
    cwd: patch.cwd !== undefined ? patch.cwd : cur.cwd,
    host: patch.host !== undefined ? patch.host : cur.host,
    respect_good_night: patch.respect_good_night ?? cur.respect_good_night,
  });
  const enabled = patch.enabled ?? cur.enabled;
  const rescheduled = merged.schedule_kind !== cur.schedule_kind || merged.schedule_expr !== cur.schedule_expr;
  const resumed = enabled && !cur.enabled;
  let nextRunAt = cur.next_run_at;
  if (rescheduled) nextRunAt = computeNextRunAt(merged.schedule_kind, merged.schedule_expr, now);
  else if (resumed) nextRunAt = merged.schedule_kind === "once" && cur.last_run_at !== null ? null : computeNextRunAt(merged.schedule_kind, merged.schedule_expr, now);
  if (merged.team !== null && merged.role !== null && (merged.team !== cur.team || merged.role !== cur.role)) await requireRecipient(s, merged.team, merged.role);
  const t = s.t.scheduledJob;
  const rows = (await s.q
    .update(t)
    .set({ ...merged, enabled: enabled ? 1 : 0, respect_good_night: merged.respect_good_night ? 1 : 0, next_run_at: nextRunAt, updated_at: nowIso() })
    .where(eq(t.id, cur.id))
    .returning()) as Row[];
  return toJob(rows[0]!);
}

/** Make a job due now (`ob schedule run`): its `next_run_at` becomes `now`. A paused job is refused: resume it first. */
export async function runScheduledJobNow(db: Database | Store, ref: string, now: Date = new Date()): Promise<ScheduledJob> {
  const s = asStore(db);
  const cur = await requireScheduledJob(s, ref);
  if (!cur.enabled) throw new AppError(`scheduled job '${cur.name}' is paused, so it would not run; resume it first (\`ob schedule resume ${cur.name}\`)`);
  const t = s.t.scheduledJob;
  const rows = (await s.q.update(t).set({ next_run_at: now.toISOString(), updated_at: nowIso() }).where(eq(t.id, cur.id)).returning()) as Row[];
  return toJob(rows[0]!);
}

/** Delete a job and its runs. Returns the job as it was. */
export async function deleteScheduledJob(db: Database | Store, ref: string): Promise<ScheduledJob> {
  const s = asStore(db);
  const cur = await requireScheduledJob(s, ref);
  // The runs go first rather than by the foreign key's cascade: SQLite enforces it only with foreign_keys on.
  await s.q.delete(s.t.scheduledJobRun).where(eq(s.t.scheduledJobRun.job_id, cur.id));
  await s.q.delete(s.t.scheduledJob).where(eq(s.t.scheduledJob.id, cur.id));
  return cur;
}

/** A job's runs, newest first, at most `limit`. */
export async function listScheduledJobRuns(db: Database | Store, ref: string, limit = 10): Promise<{ job: ScheduledJob; runs: ScheduledJobRun[] }> {
  const s = asStore(db);
  const job = await requireScheduledJob(s, ref);
  const t = s.t.scheduledJobRun;
  const runs = (await s.q.select().from(t).where(eq(t.job_id, job.id)).orderBy(desc(t.id)).limit(limit)) as ScheduledJobRun[];
  return { job, runs };
}

/** Open a run of a job (the runner, OS-311): status `running` unless given, on `host`. */
export async function startScheduledJobRun(
  db: Database | Store,
  jobId: number,
  opts: { host?: string | null; status?: JobRunStatus; startedAt?: string } = {},
): Promise<ScheduledJobRun> {
  const s = asStore(db);
  const t = s.t.scheduledJobRun;
  const rows = (await s.q
    .insert(t)
    .values({ job_id: jobId, started_at: opts.startedAt ?? nowIso(), status: opts.status ?? "running", host: opts.host ?? null })
    .returning()) as ScheduledJobRun[];
  return rows[0]!;
}

/**
 * Close a run with its outcome and stamp the job's last run: the output is cut to its last 4000 characters, and
 * `nextRunAt` (null for a `once` job that ran) becomes the job's next due time.
 */
export async function finishScheduledJobRun(
  db: Database | Store,
  runId: number,
  outcome: { status: Exclude<JobRunStatus, "running">; exitCode?: number | null; output?: string | null; roleMessageId?: number | null; error?: string | null; nextRunAt: string | null },
): Promise<ScheduledJobRun> {
  const s = asStore(db);
  const t = s.t.scheduledJobRun;
  const finished = nowIso();
  const rows = (await s.q
    .update(t)
    .set({
      finished_at: finished,
      status: outcome.status,
      exit_code: outcome.exitCode ?? null,
      output_tail: outcome.output == null ? null : tailOutput(outcome.output),
      role_message_id: outcome.roleMessageId ?? null,
    })
    .where(and(eq(t.id, runId), eq(t.status, "running")))
    .returning()) as ScheduledJobRun[];
  const run = rows[0];
  if (!run) throw new AppError(`scheduled job run ${runId} is not running, so it was not finished`);
  const j = s.t.scheduledJob;
  await s.q
    .update(j)
    .set({ last_run_at: run.started_at, last_status: outcome.status, last_error: outcome.error ?? null, next_run_at: outcome.nextRunAt, updated_at: finished })
    .where(eq(j.id, run.job_id));
  return run;
}

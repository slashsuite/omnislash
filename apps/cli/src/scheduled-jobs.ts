// OS-310: the scheduled job record (`ob schedule`). A job sends a prompt to a team role, or runs a shell command, on
// a schedule (see ./schedule.ts). This module stores the jobs and their runs, and (OS-311) claims the due ones:
// `tickScheduledJobs` enqueues a due role job's prompt into `role_inbox` and hands a due command job to the caller,
// which runs it on its own machine and records the outcome with `finishScheduledJobRun`. Nothing here runs a command.
//
// Every write is checked before anything is stored: the name, the schedule (an invalid one is refused and nothing
// is written), one target, and for a role job the team and role by `ob send`'s rules.
import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, isNotNull, lte } from "drizzle-orm";
import { nowIso } from "./db.ts";
import { asStore, type Store } from "./db/store.ts";
import { AppError, UsageError } from "./errors.ts";
import { requireRecipient, sendRoleMessage } from "./inbox.ts";
import { computeNextRunAt, normalizeScheduleExpr, parseScheduleKind, type ScheduleKind } from "./schedule.ts";
import { parseTeamRole } from "./team-handoff.ts";
import type { TeamRole } from "./team.ts";

const JOB_TARGET_KINDS = ["role", "command"] as const;
export type JobTargetKind = (typeof JOB_TARGET_KINDS)[number];

export type JobRunStatus = "running" | "succeeded" | "failed" | "skipped";

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

/** OS-311: names the API uses as literal path segments under /schedules, so no job may take them. */
const RESERVED_NAMES = new Set(["tick", "runs"]);

/** A job name: a lowercase slug that starts with a letter, so it is never read as an id. Pure. */
export function parseJobName(raw: string): string {
  const name = raw.trim();
  if (!NAME_RE.test(name)) throw new UsageError(`job name '${raw}' must be a lowercase slug (a-z, 0-9, -) that starts with a letter, at most 64 characters`);
  if (RESERVED_NAMES.has(name)) throw new UsageError(`job name '${name}' is reserved (the API serves /schedules/${name}); pick another`);
  return name;
}

const MAX_INT4 = 2_147_483_647;

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
  if (e.code === "23505" || e.code === "SQLITE_CONSTRAINT_UNIQUE" || e.errno === 2067) return true;
  if (typeof e.message === "string" && /UNIQUE constraint failed|duplicate key value violates unique constraint/i.test(e.message)) return true;
  return e.cause ? isUniqueViolation(e.cause) : false;
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
  let where;
  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id < 1 || id > MAX_INT4) return null;
    where = eq(t.id, id);
  } else {
    where = eq(t.name, raw);
  }
  const rows = (await s.q.select().from(t).where(where).limit(1)) as Row[];
  return rows[0] ? toJob(rows[0]) : null;
}

/** A job by id or name, or ScheduledJobNotFoundError. */
async function requireScheduledJob(db: Database | Store, ref: string): Promise<ScheduledJob> {
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
  const stamp = nowIso();
  const t = s.t.scheduledJob;
  try {
    const rows = (await s.q
      .insert(t)
      .values({ name, enabled: 1, ...job, respect_good_night: job.respect_good_night ? 1 : 0, next_run_at: nextRunAt, created_at: stamp, updated_at: stamp })
      .returning()) as Row[];
    return toJob(rows[0]!);
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError(`a scheduled job named '${name}' already exists (see \`ob schedule show ${name}\`)`);
    throw err;
  }
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

/** Delete a job; its runs go via `ON DELETE CASCADE`. Returns the job as it was. */
export async function deleteScheduledJob(db: Database | Store, ref: string): Promise<ScheduledJob> {
  const s = asStore(db);
  const cur = await requireScheduledJob(s, ref);
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


// --- OS-311: due evaluation and claim -------------------------------------------------------------------------

/** The most of a command's output a run keeps: its last 4000 characters. */
export const OUTPUT_TAIL_MAX = 4000;

/** The last `max` characters of `text`. Pure. */
export function boundTail(text: string, max: number = OUTPUT_TAIL_MAX): string {
  return text.length > max ? text.slice(text.length - max) : text;
}

/** Who a scheduled role job's inbox message is from. */
const SCHEDULE_FROM = "schedule";

/** The inbox key a role job's firing for one due time is stored once under. Pure. */
export function scheduleClientKey(jobId: number, dueAt: string): string {
  return `schedule:${jobId}:${dueAt}`;
}

export interface ScheduleTickInput {
  /** The calling machine: a command job with a `host` runs only on that host. */
  host: string;
  now?: Date | undefined;
  /** The caller's good-night lock is on. */
  night_locked?: boolean | undefined;
}

/** A command job handed to the caller to run, with the run row that records it. */
export interface ClaimedCommand {
  run_id: number;
  job_id: number;
  name: string;
  command: string;
  cwd: string | null;
  due_at: string;
}

export interface ScheduleTickResult {
  /** Role jobs fired: each prompt is one unread `role_inbox` message. */
  fired: Array<{ job_id: number; name: string; team: string; role: TeamRole; due_at: string; run_id: number; message_id: number }>;
  /** Command jobs claimed for the caller to run. */
  commands: ClaimedCommand[];
  /** Repeating jobs skipped under the good-night lock: their window is passed over, not fired at 07:00. */
  skipped: Array<{ job_id: number; name: string; due_at: string; next_run_at: string | null }>;
  /** `once` jobs held under the good-night lock: still due, they fire on the first pass after it. */
  deferred: Array<{ job_id: number; name: string; due_at: string }>;
  /** Jobs that could not fire (a role nobody can receive, a schedule with no next time); each recorded as a failed run. */
  failed: Array<{ job_id: number; name: string; due_at: string; error: string }>;
}

/** The next due time after a firing at `now`: none for `once` (the job is done), else the schedule's next from now. */
function nextAfter(job: ScheduledJob, now: Date): string | null {
  if (job.schedule_kind === "once") return null;
  return computeNextRunAt(job.schedule_kind, job.schedule_expr, now);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Move a job past the window it was due in, only if nobody else has: the update matches the `next_run_at` this pass
 * read, so of two concurrent callers exactly one wins (a compare-and-set, the same on SQLite and Postgres). A `once`
 * job is disabled. Returns whether this caller won.
 */
async function advance(tx: Store, job: ScheduledJob, next: string | null, set: Record<string, unknown>): Promise<boolean> {
  const t = tx.t.scheduledJob;
  const rows = await tx.q
    .update(t)
    .set({ next_run_at: next, ...(job.schedule_kind === "once" ? { enabled: 0 } : {}), ...set, updated_at: nowIso() })
    .where(and(eq(t.id, job.id), eq(t.enabled, 1), eq(t.next_run_at, job.next_run_at!)))
    .returning({ id: t.id });
  return rows.length === 1;
}

async function insertRun(tx: Store, values: Omit<ScheduledJobRun, "id">): Promise<ScheduledJobRun> {
  const rows = (await tx.q.insert(tx.t.scheduledJobRun).values(values).returning()) as ScheduledJobRun[];
  return rows[0]!;
}

/**
 * One due-evaluation pass (OS-311), run by `ob role tick` on each machine: every enabled job whose `next_run_at` is
 * at or before `now` is claimed once, however many callers race.
 *
 * - A role job enqueues its prompt into the team role's inbox (`from: schedule`, keyed `schedule:<id>:<due>`) and
 *   records a `succeeded` run naming the message. Delivering it is the tick's existing `deliverToRole` pass.
 * - A command job whose `host` is unset or the caller's is claimed: a `running` run on the caller's host, returned
 *   for the caller to run and finish. Another host's job is left due for that host.
 * - Under the good-night lock a job that respects it does not fire: a `once` job stays due and fires on the first
 *   pass after the lock; an `interval` or `cron` job records a `skipped` run and moves to its next time after now,
 *   so a night of missed windows is not a storm at 07:00. A job with `respect_good_night` off fires as usual (its
 *   inbox message still waits for the lock to end, since the tick delivers nothing under it).
 * - A repeating job's next time is computed from `now`, never from the missed due time: one firing per pass.
 *
 * Nothing here runs a command: the API server calls this and only ever returns the claim.
 */
export async function tickScheduledJobs(db: Database | Store, input: ScheduleTickInput): Promise<ScheduleTickResult> {
  const s = asStore(db);
  const now = input.now ?? new Date();
  const stamp = now.toISOString();
  const host = input.host.trim();
  if (!host) throw new UsageError("the schedule tick needs the caller's host");
  const t = s.t.scheduledJob;
  const due = ((await s.q
    .select()
    .from(t)
    .where(and(eq(t.enabled, 1), isNotNull(t.next_run_at), lte(t.next_run_at, stamp)))
    .orderBy(asc(t.next_run_at), asc(t.id))) as Row[]).map(toJob);
  const out: ScheduleTickResult = { fired: [], commands: [], skipped: [], deferred: [], failed: [] };
  for (const job of due) {
    try {
      await tickJob(s, job, now, host, input.night_locked === true, out);
    } catch (err) {      // A job whose own write failed (a database timeout) is left as it was, due for the next pass; the jobs already
      // claimed in this pass are still returned, so none is claimed and then lost.
      out.failed.push({ job_id: job.id, name: job.name, due_at: job.next_run_at!, error: errText(err) });
    }
  }
  return out;
}

/** One due job of a tick pass: skip, hold, fire or claim it, recording the outcome on `out`. */
async function tickJob(s: Store, job: ScheduledJob, now: Date, host: string, nightLocked: boolean, out: ScheduleTickResult): Promise<void> {
  const stamp = now.toISOString();
  const dueAt = job.next_run_at!;
  if (job.target_kind === "command" && job.host !== null && job.host !== host) return;
  if (nightLocked && job.respect_good_night) {
    if (job.schedule_kind === "once") {
      out.deferred.push({ job_id: job.id, name: job.name, due_at: dueAt });
      return;
    }
    let next: string | null;
    try {
      next = nextAfter(job, now);
    } catch (err) {
      await failJob(s, job, now, errText(err), out);
      return;
    }
    const won = await s.txn("schedule skip", async (tx) => {
      if (!(await advance(tx, job, next, { last_status: "skipped" }))) return false;
      await insertRun(tx, { job_id: job.id, started_at: stamp, finished_at: stamp, status: "skipped", host, exit_code: null, output_tail: "good night: skipped", role_message_id: null });
      return true;
    });
    if (won) out.skipped.push({ job_id: job.id, name: job.name, due_at: dueAt, next_run_at: next });
    return;
  }
  let next: string | null;
  try {
    next = nextAfter(job, now);
  } catch (err) {
    await failJob(s, job, now, errText(err), out);
    return;
  }
  if (job.target_kind === "role") {
    try {
      const fired = await s.txn("schedule fire", async (tx) => {
        if (!(await advance(tx, job, next, { last_run_at: stamp, last_status: "succeeded", last_error: null }))) return null;
        const { message } = await sendRoleMessage(tx, {
          team: job.team!,
          role: job.role!,
          from: SCHEDULE_FROM,
          kind: "message",
          // The prompt starts the first line: a role brief lists each unread message by its first line.
          body: `Scheduled job '${job.name}' (due ${dueAt}): ${job.prompt}`,
          clientKey: scheduleClientKey(job.id, dueAt),
        });
        const run = await insertRun(tx, { job_id: job.id, started_at: stamp, finished_at: stamp, status: "succeeded", host: null, exit_code: null, output_tail: null, role_message_id: message.id });
        return { run_id: run.id, message_id: message.id };
      });
      if (fired) out.fired.push({ job_id: job.id, name: job.name, team: job.team!, role: job.role!, due_at: dueAt, ...fired });
    } catch (err) {
      // The firing rolled back. A refusal (a role nobody can receive, a team gone) is recorded as failed and moved
      // on, so a bad job is one failed run per window, never an error on every pass. Anything else (a database
      // timeout) goes to the pass's catch, which leaves the job due: a once job is never disabled by a hiccup.
      if (!(err instanceof AppError)) throw err;
      await failJob(s, job, now, errText(err), out, next);
    }
    return;
  }
  const claimed = await s.txn("schedule claim", async (tx) => {
    if (!(await advance(tx, job, next, { last_run_at: stamp, last_status: "running", last_error: null }))) return null;
    return insertRun(tx, { job_id: job.id, started_at: stamp, finished_at: null, status: "running", host, exit_code: null, output_tail: null, role_message_id: null });
  });
  if (claimed) out.commands.push({ run_id: claimed.id, job_id: job.id, name: job.name, command: job.command!, cwd: job.cwd, due_at: dueAt });
}

/**
 * A job that cannot fire: one `failed` run, the error on the job, and the job moved past this window (to `next`, or
 * disabled when there is none, as a cron with no next time is), so it fails once per window and not every pass.
 */
async function failJob(s: Store, job: ScheduledJob, now: Date, error: string, out: ScheduleTickResult, next: string | null = null): Promise<void> {
  const stamp = now.toISOString();
  const won = await s.txn("schedule fail", async (tx) => {
    const t = tx.t.scheduledJob;
    const rows = await tx.q
      .update(t)
      .set({ next_run_at: next, ...(next === null ? { enabled: 0 } : {}), last_run_at: stamp, last_status: "failed", last_error: error, updated_at: nowIso() })
      .where(and(eq(t.id, job.id), eq(t.enabled, 1), eq(t.next_run_at, job.next_run_at!)))
      .returning({ id: t.id });
    if (rows.length !== 1) return false;
    await insertRun(tx, { job_id: job.id, started_at: stamp, finished_at: stamp, status: "failed", host: null, exit_code: null, output_tail: boundTail(error), role_message_id: null });
    return true;
  });
  if (won) out.failed.push({ job_id: job.id, name: job.name, due_at: job.next_run_at!, error });
}

export interface ScheduleRunFinish {
  status: string;
  exit_code?: number | null | undefined;
  output_tail?: string | null | undefined;
}

/** No run by that id. 404 over the API. */
export class ScheduledJobRunNotFoundError extends AppError {
  constructor(readonly runId: number) {
    super(`no scheduled job run ${runId}`);
    this.name = "ScheduledJobRunNotFoundError";
  }
}

/**
 * Record how a claimed command run ended (OS-311): `succeeded` or `failed`, its exit code and the last 4000
 * characters of its output, on the run and as the job's last run. Only a `running` run can finish, once.
 */
export async function finishScheduledJobRun(db: Database | Store, runId: number, input: ScheduleRunFinish, now: Date = new Date()): Promise<ScheduledJobRun> {
  const s = asStore(db);
  if (input.status !== "succeeded" && input.status !== "failed") throw new UsageError(`a run finishes as succeeded or failed (got '${input.status}')`);
  const status = input.status;
  if (!Number.isSafeInteger(runId) || runId < 1 || runId > MAX_INT4) throw new ScheduledJobRunNotFoundError(runId);
  const exit = input.exit_code ?? null;
  if (exit !== null && !Number.isSafeInteger(exit)) throw new UsageError("exit_code must be a whole number or null");
  const tail = input.output_tail == null ? null : boundTail(input.output_tail);
  const stamp = now.toISOString();
  return s.txn("schedule finish", async (tx) => {
    const r = tx.t.scheduledJobRun;
    const cur = ((await tx.q.select().from(r).where(eq(r.id, runId)).limit(1)) as ScheduledJobRun[])[0];
    if (!cur) throw new ScheduledJobRunNotFoundError(runId);
    const rows = (await tx.q
      .update(r)
      .set({ status, finished_at: stamp, exit_code: exit, output_tail: tail })
      .where(and(eq(r.id, runId), eq(r.status, "running")))
      .returning()) as ScheduledJobRun[];
    if (!rows[0]) throw new AppError(`scheduled job run ${runId} is already ${cur.status}`);
    const lastError = status === "failed" ? boundTail(`exit ${exit ?? "none"}${tail ? `: ${lastLine(tail)}` : ""}`, 500) : null;
    const t = tx.t.scheduledJob;
    await tx.q.update(t).set({ last_run_at: cur.started_at, last_status: status, last_error: lastError, updated_at: nowIso() }).where(eq(t.id, cur.job_id));
    return rows[0];
  });
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split("\n");
  return lines[lines.length - 1] ?? "";
}

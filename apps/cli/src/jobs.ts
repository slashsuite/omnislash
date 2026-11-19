import { homedir } from "node:os";
import { eq, sql } from "drizzle-orm";
import { nowIso } from "./db.ts";
import { readNumber, type Store } from "./db/store.ts";
import { settingFor, settingNumFor } from "./settings.ts";
import { daemonJobs, isClientJob, type PlistOpts } from "../../../platform/cli-coord/src/commands/coord.ts";
import { isSplitInvocation } from "./remote.ts";

// ---------------------------------------------------------------------------
// Per-job health (ob 218).
//
// Four daemon jobs each failed silently for weeks and every one was found by a person opening a log
// file: gmail dead 17 days while its 300s timer kept firing (152), slack erroring every 15 minutes with
// no token (208), `net pull` failing on every source (209), and ha-health never installed anywhere at
// all (212). The tracker whose job is to say what needs attention could not say that its own ingestion
// was dead, because nothing in the database knew what healthy looked like per job.
//
// This module is that knowledge: what the fleet is DECLARED to be (derived from daemonJobs(), the same
// declaration the plists and the systemd units are generated from, so there is no second hand-maintained
// list to drift), what each job has actually DONE (the job_run table), and the comparison of the two.
// `ob alerts` reads the comparison; `ob jobs` prints it.
// ---------------------------------------------------------------------------

const DAY_S = 86_400;

/** How much of a failure message is kept. Enough to recognise the failure, not a log file in a column. */
const ERROR_MAX = 500;

export interface DeclaredJob {
  job: string;
  /** Positional args the invocation must match exactly (`["gmail", "sync"]`). */
  positionals: string[];
  /** Boolean flags the declaration carries (`alerts --digest`); all must be set to match. */
  flags: string[];
  /**
   * How often the job is scheduled to run, in seconds. null for a job with no schedule at all: `web` and
   * `whatsapp-bridge` are KeepAlive processes that are supposed to stay up rather than to finish, so
   * "has it succeeded lately" is not a question with an answer for them.
   */
  cadence_s: number | null;
  /**
   * Whether a run of this job can be OBSERVED in this database at all. A split-class invocation
   * (`web`; `spinoff drain` was one until ob 1589 retired its job) performs its side effect on the machine in front of the owner and either has
   * an empty database half or dispatches it as DIFFERENT sub-invocations (`spinoff claim`/`stamp`), so
   * the absence of a job_run row proves nothing about whether it ran. Freshness is therefore not
   * asserted for these; a failure they record while running locally still counts.
   */
  trackable: boolean;
}

function cadenceSeconds(opts: PlistOpts): number | null {
  if (opts.interval !== undefined) return opts.interval;
  if (!opts.calendar) return null;
  // A calendar job's cadence is the LONGEST legitimate gap between runs, so a monthly job is 31 days
  // rather than 28: the threshold has to survive the longest month or January alerts every year.
  if (opts.dayOfMonth !== undefined) return 31 * DAY_S;
  if (opts.weekday !== undefined) return 7 * DAY_S;
  return DAY_S;
}

/** The declared fleet, derived from `daemonJobs()` so the schedule is never restated by hand. */
export function declaredJobs(): DeclaredJob[] {
  return daemonJobs(homedir()).map((j) => {
    const args = j.args.slice(1); // args[0] is the `ob` wrapper path
    const positionals = args.filter((a) => !a.startsWith("--"));
    const flags = args.filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, ""));
    return {
      job: j.job,
      positionals,
      flags,
      cadence_s: cadenceSeconds(j.opts),
      // OS-67: a client job (`role-tick`) runs on a laptop or desktop, so this database never sees its runs.
      trackable: !isSplitInvocation(positionals[0] ?? "", positionals.slice(1)) && !isClientJob(j.job),
    };
  });
}

/**
 * Which declared job (if any) this invocation IS. Matching is on the whole invocation, not the first
 * word: `ob alerts --digest` is the 08:00 job and a bare `ob alerts` typed by a human is not, so a
 * person reading their alerts does not silently stand in for the timer that stopped firing.
 */
export function jobForInvocation(
  command: string,
  args: string[],
  flags: Record<string, unknown> = {},
): string | null {
  const invocation = [command, ...args];
  for (const d of declaredJobs()) {
    if (d.positionals.length !== invocation.length) continue;
    if (!d.positionals.every((p, i) => invocation[i] === p)) continue;
    if (!d.flags.every((f) => flags[f] === true)) continue;
    return d.job;
  }
  return null;
}

// --- recording --------------------------------------------------------------
//
// 337: the whole seam takes a Store and is async. What each function DECIDES is still factored out into
// a pure function (`attemptPatch`, `resultPatch`, `computeJobHealth`, `staleThreshold`), because the
// interesting logic here -- when a run counts as interrupted, when silence counts as stale -- is worth
// being able to test at its real timescales without a database anywhere near it.

/** The values a fresh row starts at. Pure: shared by both engines so a first run means the same thing. */
function seedRow(job: string, at: string) {
  return {
    job,
    first_attempt_at: at,
    last_attempt_at: at,
    last_success_at: null,
    last_failure_at: null,
    last_error: null,
    consecutive_failures: 0,
    consecutive_interruptions: 0,
    updated_at: at,
  };
}

async function ensureRow(s: Store, job: string, at: string): Promise<void> {
  await s.q.insert(s.t.jobRun).values(seedRow(job, at)).onConflictDoNothing({ target: s.t.jobRun.job });
}

/**
 * Is this row's latest attempt still unresolved: an attempt written with no result of either kind after
 * it? That is the shape 221 exists for. The attempt is written BEFORE the handler and the result after,
 * so an unresolved attempt means the run never reached the seam again: killed, timed out, the machine
 * slept, or (for `web` and the bridge) it is still blocking, which is what those two are supposed to do.
 */
function unresolved(row: { last_attempt_at: string; last_success_at: string | null; last_failure_at: string | null }): boolean {
  const resolvedAt = [row.last_success_at, row.last_failure_at].filter((t): t is string => t !== null).sort().pop();
  return resolvedAt === undefined || row.last_attempt_at > resolvedAt;
}

/**
 * The job started. Written BEFORE the handler runs, so a job that is killed or that blocks forever
 * (`web`, the bridge) still leaves the evidence that something tried, and so first_attempt_at exists
 * from the first run rather than from the first SUCCESS a broken job may never reach.
 *
 * A new attempt arriving while the previous one is still unresolved is the PROOF that the previous run
 * died without recording anything: nothing else can have started this job while that one was live. That
 * is the only moment an interruption can be counted, so it is counted here.
 */
export async function recordJobAttempt(s: Store, job: string, at: string = nowIso()): Promise<void> {
  await ensureRow(s, job, at);
  const rows = (await s.q.select().from(s.t.jobRun).where(eq(s.t.jobRun.job, job)).limit(1)) as JobRunRow[];
  await s.q
    .update(s.t.jobRun)
    .set(attemptPatch(rows[0] ?? null, at, s.t.jobRun))
    .where(eq(s.t.jobRun.job, job));
}

/**
 * What an ATTEMPT does to the row, as a pure function of the row that was there. The interruption counter
 * is expressed as `column + 1` rather than a read-modify-write, so it is the database that increments and
 * two concurrent runs cannot lose a count; the column it names is passed in because the sqlite and the
 * pg-core table objects are different objects with the same keys.
 */
function attemptPatch(
  prior: JobRunRow | null,
  at: string,
  table: Store["t"]["jobRun"],
): Record<string, unknown> {
  const interrupted = prior !== null && prior.last_attempt_at !== at && unresolved(prior);
  return {
    last_attempt_at: at,
    ...(interrupted ? { consecutive_interruptions: sql`${table.consecutive_interruptions} + 1` } : {}),
    updated_at: at,
  };
}

/**
 * The job finished. `ok` is "the command exited 0", which is a narrower claim than "the job did useful
 * work": a run that exits 0 having ingested nothing still counts as a success here (see the module
 * header on what this signal does not cover).
 *
 * Either outcome clears the interruption streak: the run reached the seam, so whatever was killing this
 * job has stopped. A failure is then the failure counter's business.
 */
export async function recordJobResult(
  s: Store,
  job: string,
  outcome: { ok: boolean; error?: string | null },
  at: string = nowIso(),
): Promise<void> {
  await ensureRow(s, job, at);
  await s.q
    .update(s.t.jobRun)
    .set(resultPatch(outcome, at, s.t.jobRun))
    .where(eq(s.t.jobRun.job, job));
}

/** What a RESULT does to the row. Pure, and the single place either engine decides what an outcome means. */
function resultPatch(
  outcome: { ok: boolean; error?: string | null },
  at: string,
  table: Store["t"]["jobRun"],
): Record<string, unknown> {
  if (outcome.ok) {
    return { last_success_at: at, consecutive_failures: 0, consecutive_interruptions: 0, updated_at: at };
  }
  const message = (outcome.error ?? "").trim();
  return {
    last_failure_at: at,
    last_error: message.length > ERROR_MAX ? `${message.slice(0, ERROR_MAX)}…` : message || null,
    consecutive_failures: sql`${table.consecutive_failures} + 1`,
    consecutive_interruptions: 0,
    updated_at: at,
  };
}

// --- reading ----------------------------------------------------------------

export interface JobRunRow {
  job: string;
  first_attempt_at: string;
  last_attempt_at: string;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  consecutive_interruptions: number;
}

export async function jobRunRows(s: Store): Promise<JobRunRow[]> {
  return ((await s.q.select().from(s.t.jobRun)) as JobRunRow[]).map(normalizeRow);
}

/**
 * The counters are read as NUMBERS. Postgres hands integer shapes back through its driver, and a count
 * that arrives as a string turns `consecutive_failures >= failThreshold` into a string comparison
 * ("10" < "3") with no error anywhere -- a job failing ten times in a row reading as healthy. There is no
 * ORDER BY here at all (the caller sorts in JS), so the NULLS-first/last difference cannot reach this.
 */
function normalizeRow(row: JobRunRow): JobRunRow {
  return {
    ...row,
    consecutive_failures: readNumber(row.consecutive_failures),
    consecutive_interruptions: readNumber(row.consecutive_interruptions),
  };
}

/**
 * - `ok`          it has succeeded at least once, its latest completed run succeeded, and that success is
 *                 within its expected window.
 * - `failing`     N consecutive failures, N being the alert threshold (152, 208, 209).
 * - `degraded`    its latest completed run did not succeed, but fewer times in a row than that threshold,
 *                 or it has completed runs and has never once succeeded (222).
 * - `stale`       it has a record but no success within a multiple of its own cadence (152's other half).
 * - `interrupted` its latest attempt has been unresolved for longer than one whole cadence, so that run
 *                 is not still going: it was killed, timed out, or the machine slept through it (221).
 * - `running`     its latest attempt is unresolved and younger than one cadence, so it is plausibly in
 *                 flight right now.
 * - `never_ran`   it is declared, the fleet has been tracked for longer than its window, and this job
 *                 has no record at all (212, and the only shape that would have caught it).
 * - `untracked`   no record yet, and not long enough has passed to call that a problem.
 * - `unscheduled` no cadence to be late against, or a job whose runs this database cannot observe.
 * - `ignored`     deliberately silenced through `alert_job_ignore`.
 *
 * `running` and `interrupted` exist because the live tracker reported `sync` as `ok` an hour after 218
 * landed while it had never once succeeded (221): an attempt with no result read as zero failures, and
 * zero failures read as healthy. An UNRESOLVED attempt is now its own answer and can never be `ok`,
 * because "we have no idea how that run ended" is exactly the thing 218 exists to stop calling fine.
 *
 * `degraded` exists because the same shape came back a third time in two days (222): `ob jobs` printed
 * `slack-sync  ok  last success never  2 fail(s) in a row`, the word `ok` on the same line as the
 * evidence against it. The cause was not the alerting, which is right to wait for three failures before
 * shouting; it was that the LABEL had no input other than the alert threshold, so "not loud enough to
 * alert" and "working" had collapsed into one word.
 *
 * THE DISTINCTION TO KEEP: the state answers "is this working", the thresholds in `ob config` answer
 * "should this shout". They are different questions and they are allowed to disagree. A job that has
 * failed once is degraded and silent; only its third failure is worth waking anyone for. Deriving the
 * label from the alert rule is what put `ok` next to two failures, so nothing below reads the alert
 * threshold except the one branch (`failing`) that IS the alert.
 */
export type JobHealthState =
  | "ok"
  | "failing"
  | "degraded"
  | "stale"
  | "interrupted"
  | "running"
  | "never_ran"
  | "untracked"
  | "unscheduled"
  | "ignored";

export interface JobHealth {
  job: string;
  state: JobHealthState;
  cadence_s: number | null;
  /** How long without a success before this job is late. null when it cannot be late. */
  threshold_s: number | null;
  /** Seconds since the last success, or since this machine started tracking jobs when there is none. */
  quiet_s: number | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  consecutive_interruptions: number;
  /** Seconds the latest attempt has been unresolved, null when it resolved or there is no record. */
  unresolved_for_s: number | null;
}

/** Job names silenced by hand, e.g. one that ships installed-and-disabled until a later window. */
export async function ignoredJobs(s: Store): Promise<Set<string>> {
  return parseIgnored(await settingFor(s, "alert_job_ignore"));
}

function parseIgnored(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * How long a job may go without a success before it is late: a multiple of its own declared cadence,
 * but never less than a floor.
 *
 * The floor is the anti-cry-wolf half, and it is the whole reason gmail-sync does not alert at lunchtime:
 * three missed 300s runs is a closed laptop, a reboot or a flapping network, not a broken job, and an
 * alert that fires for those gets ignored and then the real one does too. A day of a 5-minute job
 * producing nothing is a different claim entirely.
 */
export async function staleThresholdS(s: Store, cadenceS: number): Promise<number> {
  return staleThreshold(
    cadenceS,
    await settingNumFor(s, "alert_job_stale_multiple"),
    await settingNumFor(s, "alert_job_stale_floor_hours"),
  );
}

/** The rule itself, pure, so both forms are late at exactly the same second. */
export function staleThreshold(cadenceS: number, multiple: number, floorHours: number): number {
  return Math.max(cadenceS * multiple, floorHours * 3600);
}

const secondsBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;

/**
 * Compare the declared fleet against what it has actually done. Pure: no network, no stdout.
 * `now` is injectable so the four reconstructed cases can be replayed at their real timescales.
 */
export async function jobHealth(s: Store, opts: { now?: string } = {}): Promise<JobHealth[]> {
  return computeJobHealth({
    now: opts.now ?? nowIso(),
    failThreshold: await settingNumFor(s, "alert_job_failures"),
    staleMultiple: await settingNumFor(s, "alert_job_stale_multiple"),
    staleFloorHours: await settingNumFor(s, "alert_job_stale_floor_hours"),
    ignored: await ignoredJobs(s),
    rows: await jobRunRows(s),
  });
}

export interface JobHealthInput {
  now: string;
  failThreshold: number;
  staleMultiple: number;
  staleFloorHours: number;
  ignored: Set<string>;
  rows: JobRunRow[];
}

/** The comparison itself: declared fleet vs recorded runs. Pure -- no database, no clock, no stdout. */
export function computeJobHealth(input: JobHealthInput): JobHealth[] {
  const { now, failThreshold, ignored } = input;
  const rows = new Map(input.rows.map((r) => [r.job, r]));

  // When this machine started tracking jobs at all. A job with NO record is only a problem relative to
  // this: on a fresh database, or on the first day after this shipped, nothing has recorded anything and
  // "never ran" would otherwise be true of all fourteen jobs at once. first_attempt_at never moves, so
  // this is a stable origin rather than a clock that keeps resetting as the fleet runs.
  const trackedFrom = input.rows.map((r) => r.first_attempt_at).sort()[0];

  const out: JobHealth[] = [];
  for (const d of declaredJobs()) {
    const row = rows.get(d.job) ?? null;
    const threshold =
      d.cadence_s !== null && d.trackable
        ? staleThreshold(d.cadence_s, input.staleMultiple, input.staleFloorHours)
        : null;
    const base = {
      job: d.job,
      cadence_s: d.cadence_s,
      threshold_s: threshold,
      last_attempt_at: row?.last_attempt_at ?? null,
      last_success_at: row?.last_success_at ?? null,
      last_error: row?.last_error ?? null,
      consecutive_failures: row?.consecutive_failures ?? 0,
      consecutive_interruptions: row?.consecutive_interruptions ?? 0,
      unresolved_for_s:
        row && unresolved(row) ? Math.max(0, secondsBetween(row.last_attempt_at, now)) : null,
    };
    const quietFrom = row?.last_success_at ?? row?.first_attempt_at ?? trackedFrom ?? null;
    const quiet_s = quietFrom ? Math.max(0, secondsBetween(quietFrom, now)) : null;

    // Its latest COMPLETED run did not succeed: either it is in a failure streak, or it has completed
    // runs and never once succeeded (a hand-edited or otherwise contradictory row). Both are "not
    // working", whatever the alert threshold has to say about volume.
    const notWorking =
      row !== null && (row.consecutive_failures > 0 || (!unresolved(row) && row.last_success_at === null));

    if (ignored.has(d.job)) {
      out.push({ ...base, state: "ignored", quiet_s });
      continue;
    }
    if (row && row.consecutive_failures >= failThreshold) {
      out.push({ ...base, state: "failing", quiet_s });
      continue;
    }
    if (threshold === null) {
      // A KeepAlive process or an unobservable job has no cadence to be late against, but a failure it
      // recorded here is still a failure: `failing` already outranks `unscheduled` and `degraded` gets
      // the same precedence, so "nothing to be late about" cannot swallow a run that came back broken.
      out.push({ ...base, state: notWorking ? "degraded" : "unscheduled", quiet_s });
      continue;
    }
    if (!row) {
      // The fleet has to have been demonstrably running for longer than this job's own window before its
      // silence means anything: a weekly job on a database three days old has not failed to run, it has
      // simply not come round yet.
      const trackedFor = trackedFrom ? secondsBetween(trackedFrom, now) : null;
      const state: JobHealthState = trackedFor !== null && trackedFor >= threshold ? "never_ran" : "untracked";
      out.push({ ...base, state, quiet_s });
      continue;
    }
    if (quiet_s !== null && quiet_s >= threshold) {
      // Staleness is checked before the unresolved states on purpose: a job that has produced no success
      // for a day is the claim 218 makes and the one whose alert already exists, and an interrupted run
      // must never be able to quiet it. `interrupted` is the EARLIER, more specific reading underneath.
      out.push({ ...base, state: "stale", quiet_s });
      continue;
    }
    // One whole cadence is the completion window: a periodic job whose next run is already due cannot
    // still be doing the previous one, so an attempt older than that with no result is a run that died.
    //
    // The unresolved states are read BEFORE `degraded` on purpose, and it is the one ordering here that
    // is not "worst first": a run in flight is the newest thing known about the job, and rule 10 counts
    // the runs that keep dying, so letting an older failure streak relabel them would silence that alert
    // for any job that fails once and is then killed every run after. Neither `running` nor `interrupted`
    // claims health, so nothing reads as fine either way.
    const late = base.unresolved_for_s !== null && d.cadence_s !== null && base.unresolved_for_s >= d.cadence_s;
    if (base.unresolved_for_s !== null) {
      out.push({ ...base, state: late ? "interrupted" : "running", quiet_s });
      continue;
    }
    // Everything above has been ruled out, so this run completed. `ok` is the ONLY label that claims the
    // job works, and it is reached only from here: a completed run, no failure streak, and a success
    // actually on record. Without one of those it is degraded, however quiet the alerting stays.
    out.push({ ...base, state: notWorking ? "degraded" : "ok", quiet_s });
  }
  out.sort((a, b) => a.job.localeCompare(b.job));
  return out;
}

// ob 337 pass 6: the job-health seam (218/221/222) on BOTH engines, and `ob jobs` / `ob daemon` served
// from Postgres through cli.ts's routing.
//
// WHY THIS ONE MATTERS BEYOND ITS SIZE. job_run is the table that answers "is my ingestion alive". Every
// other surface in ob is wrong loudly when it is wrong -- a missing item is a missing line on a screen --
// but this one is wrong QUIETLY by design: a job that stopped running looks exactly like a job that has
// nothing to say. That is the failure 218 exists for, and a cutover that left the counters behind on the
// old engine would recreate it with the tracker reporting `ok` for a fleet whose runs were being recorded
// somewhere nobody reads.
//
// The documented differences all have somewhere to bite here:
//   - consecutive_failures / consecutive_interruptions are compared against a threshold with `>=`. A
//     count that arrives as a STRING makes "10" >= 3 false, so a job failing ten times in a row reads as
//     healthy. Asserted by value AND by typeof.
//   - the counters are incremented as `column + 1` in SQL rather than read-modify-written, so the
//     increment has to mean the same thing on both dialects.
//   - booleans: none stored here, and this test is what says so rather than assuming it -- every state in
//     the table is DERIVED from timestamps.
//   - ORDER BY: there is none. jobRunRows has no ordering at all and the output is sorted in JS by job
//     name, so the NULLS-first/last split cannot reach this module. Asserted by comparing the order.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStore, openStore, resetStore, STORE_ENV, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { runCli, spawnBudget } from "../../../apps/cli/test/helpers.ts";
import {
  computeJobHealth,
  jobHealth,
  jobRunRows,
  recordJobAttempt,
  recordJobResult,
  staleThreshold,
  type JobRunRow,
} from "../../../apps/cli/src/jobs.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";

const PG_BUDGET = spawnBudget(3);

const T = (n: number) => new Date(Date.UTC(2026, 7, 18, 0, 0, 0) + n * 60_000).toISOString();

/** The row shape both engines must produce, minus the fields that are literally the timestamps fed in. */
function shape(row: JobRunRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    job: row.job,
    first_attempt_at: row.first_attempt_at,
    last_attempt_at: row.last_attempt_at,
    last_success_at: row.last_success_at,
    last_failure_at: row.last_failure_at,
    last_error: row.last_error,
    consecutive_failures: row.consecutive_failures,
    consecutive_interruptions: row.consecutive_interruptions,
    failureType: typeof row.consecutive_failures,
    interruptionType: typeof row.consecutive_interruptions,
  };
}

/**
 * One realistic life of a daemon job: it runs and succeeds, then fails twice, then is killed mid-run
 * twice (an attempt with no result, then another attempt on top of it), then recovers. Returns plain
 * JSON-able values so a mismatch reads as a diff of counters rather than "two big objects differ".
 */
async function exercise(store: Store): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // A first attempt CREATES the row, and first_attempt_at is set from that attempt rather than from a
  // success a broken job may never reach.
  await recordJobAttempt(store, "gmail-sync", T(0));
  out.afterFirstAttempt = shape((await jobRunRows(store))[0]);
  await recordJobResult(store, "gmail-sync", { ok: true }, T(1));
  out.afterFirstSuccess = shape((await jobRunRows(store))[0]);

  // Two failures in a row: the streak is incremented BY THE DATABASE (`column + 1`), which is the part
  // that has to survive the dialect change.
  await recordJobAttempt(store, "gmail-sync", T(2));
  await recordJobResult(store, "gmail-sync", { ok: false, error: "token expired" }, T(3));
  await recordJobAttempt(store, "gmail-sync", T(4));
  await recordJobResult(store, "gmail-sync", { ok: false, error: "token expired" }, T(5));
  out.afterTwoFailures = shape((await jobRunRows(store))[0]);

  // An over-long error is truncated to the same length by both engines: a log file in a column is the
  // thing ERROR_MAX exists to prevent, and a difference here is a difference in what is stored.
  await recordJobAttempt(store, "gmail-sync", T(6));
  await recordJobResult(store, "gmail-sync", { ok: false, error: "x".repeat(900) }, T(7));
  const truncated = (await jobRunRows(store))[0];
  out.truncatedLength = truncated?.last_error?.length;
  out.truncatedTail = truncated?.last_error?.slice(-1);
  out.failuresAfterThree = truncated?.consecutive_failures;

  // A run that never came back: the attempt is unresolved, and the NEXT attempt is the proof that it
  // died, so that is the moment the interruption is counted.
  await recordJobAttempt(store, "gmail-sync", T(8));
  out.afterUnresolved = shape((await jobRunRows(store))[0]);
  await recordJobAttempt(store, "gmail-sync", T(9));
  out.afterInterruption = shape((await jobRunRows(store))[0]);
  await recordJobAttempt(store, "gmail-sync", T(10));
  out.afterSecondInterruption = shape((await jobRunRows(store))[0]);

  // A success clears BOTH streaks: the run reached the seam, so whatever was killing it has stopped.
  await recordJobResult(store, "gmail-sync", { ok: true }, T(11));
  out.afterRecovery = shape((await jobRunRows(store))[0]);

  // A second job, so the read is a multi-row read and the ordering is comparable.
  await recordJobAttempt(store, "alerts", T(12));
  await recordJobResult(store, "alerts", { ok: false, error: "" }, T(13));
  await recordJobAttempt(store, "cert-renew", T(14));
  const rows = await jobRunRows(store);
  // jobRunRows has NO ORDER BY, so this is a statement about what an unordered read returns rather than
  // a promise; the health output below is the sorted one the CLI actually prints.
  out.rowJobs = rows.map((r) => r.job).sort();
  out.emptyErrorIsNull = rows.find((r) => r.job === "alerts")?.last_error;
  out.counterTypes = [
    ...new Set(rows.flatMap((r) => [typeof r.consecutive_failures, typeof r.consecutive_interruptions])),
  ];

  // --- `ob jobs`: the health comparison, read through the store --------------------------------------
  // The thresholds come from config, so this also exercises settingNumFor on both engines.
  await setConfig(store, "alert_job_failures", "3");
  await setConfig(store, "alert_job_ignore", "tunnel-check, ci-main");
  const health = await jobHealth(store, { now: T(20) });
  out.healthOrder = health.map((h) => h.job);
  out.healthStates = health.map((h) => [h.job, h.state]);
  out.ignored = health.filter((h) => h.state === "ignored").map((h) => h.job);
  out.gmail = health.find((h) => h.job === "gmail-sync");
  out.alerts = health.find((h) => h.job === "alerts");
  out.certRenew = health.find((h) => h.job === "cert-renew");

  // The threshold comparison itself, on a streak long enough to be a string-vs-number difference: "8"
  // compared with 3 as strings is LESS, so a failing job would read as merely degraded.
  for (let i = 0; i < 7; i++) {
    await recordJobAttempt(store, "alerts", T(30 + i * 2));
    await recordJobResult(store, "alerts", { ok: false, error: "still broken" }, T(31 + i * 2));
  }
  const failing = (await jobHealth(store, { now: T(50) })).find((h) => h.job === "alerts");
  out.tenFailures = failing?.consecutive_failures;
  out.tenFailuresType = typeof failing?.consecutive_failures;
  out.tenFailuresState = failing?.state;

  return out;
}

describe("apps/cli's job-health seam agrees across the two engines (337)", () => {
  test(
    "recording and reading job runs produces identical results on Postgres and on SQLite",
    async () => {
      const lease = await leaseRealPgDb();
      const dir = mkdtempSync(join(tmpdir(), "ob337-jobs-"));
      const previousCreate = process.env.OMNISLASH_DB_CREATE;
      process.env.OMNISLASH_DB_CREATE = "1";
      let pg: Store | undefined;
      let sqlite: Store | undefined;
      try {
        pg = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        sqlite = await openStore({ kind: "sqlite", path: join(dir, "omnislash.sqlite"), create: true });
        expect(pg.kind).toBe("postgres");
        expect(sqlite.kind).toBe("sqlite");

        const fromPg = await exercise(pg);
        const fromSqlite = await exercise(sqlite);

        for (const key of Object.keys(fromSqlite)) {
          expect({ [key]: fromPg[key] }).toEqual({ [key]: fromSqlite[key] });
        }

        // Absolute anchors, so a bug that broke BOTH engines identically still fails here.
        expect(fromSqlite.afterFirstAttempt).toMatchObject({
          job: "gmail-sync",
          first_attempt_at: T(0),
          last_attempt_at: T(0),
          last_success_at: null,
          consecutive_failures: 0,
          consecutive_interruptions: 0,
          failureType: "number",
          interruptionType: "number",
        });
        expect(fromSqlite.afterTwoFailures).toMatchObject({
          consecutive_failures: 2,
          last_error: "token expired",
          last_failure_at: T(5),
        });
        // ERROR_MAX is 500, plus the ellipsis that says it was cut.
        expect(fromSqlite.truncatedLength).toBe(501);
        expect(fromSqlite.truncatedTail).toBe("…");
        expect(fromSqlite.failuresAfterThree).toBe(3);
        // The unresolved attempt counts NOTHING on its own; the attempt that follows it is the proof.
        expect(fromSqlite.afterUnresolved).toMatchObject({ consecutive_interruptions: 0, last_attempt_at: T(8) });
        expect(fromSqlite.afterInterruption).toMatchObject({ consecutive_interruptions: 1 });
        expect(fromSqlite.afterSecondInterruption).toMatchObject({ consecutive_interruptions: 2 });
        expect(fromSqlite.afterRecovery).toMatchObject({
          consecutive_failures: 0,
          consecutive_interruptions: 0,
          last_success_at: T(11),
        });
        expect(fromSqlite.emptyErrorIsNull).toBeNull();
        expect(fromSqlite.counterTypes).toEqual(["number"]);
        // `first_attempt_at` is the only reason `cert-renew` is not `never_ran` here: it has an attempt.
        expect(fromSqlite.ignored).toEqual(["ci-main", "tunnel-check"]);
        expect((fromSqlite.gmail as { state: string }).state).toBe("ok");
        expect(fromSqlite.tenFailures).toBe(8); // the one before the loop, plus its seven
        expect(fromSqlite.tenFailuresType).toBe("number");
        expect(fromSqlite.tenFailuresState).toBe("failing");
        // The health list is sorted in JS, so the two engines return it in the same order by construction.
        expect(fromPg.healthOrder).toEqual(fromSqlite.healthOrder);
      } finally {
        await pg?.close();
        await sqlite?.close();
        await lease.release();
        if (previousCreate === undefined) delete process.env.OMNISLASH_DB_CREATE;
        else process.env.OMNISLASH_DB_CREATE = previousCreate;
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PG_BUDGET,
  );

  test("the health rule is pure: the same rows and thresholds give the same states, with no database", () => {
    const row = (over: Partial<JobRunRow>): JobRunRow => ({
      job: "gmail-sync",
      first_attempt_at: T(0),
      last_attempt_at: T(0),
      last_success_at: T(0),
      last_failure_at: null,
      last_error: null,
      consecutive_failures: 0,
      consecutive_interruptions: 0,
      ...over,
    });
    const health = (rows: JobRunRow[], now: string) =>
      new Map(
        computeJobHealth({
          now,
          failThreshold: 3,
          staleMultiple: 3,
          staleFloorHours: 6,
          ignored: new Set(),
          rows,
        }).map((h) => [h.job, h.state]),
      );

    // A job that has never had a record, on a fleet that has been tracked for longer than its window.
    expect(health([row({ job: "sync" })], T(60 * 24)).get("gmail-sync")).toBe("never_ran");
    // Three failures in a row is the alert, whatever the clock says.
    expect(health([row({ consecutive_failures: 3 })], T(1)).get("gmail-sync")).toBe("failing");
    // One failure is degraded and silent: the state answers "is this working", not "should this shout".
    expect(health([row({ consecutive_failures: 1 })], T(1)).get("gmail-sync")).toBe("degraded");
    // `web` is KeepAlive and has no cadence to be late against.
    expect(health([row({ job: "sync" })], T(1)).get("web")).toBe("unscheduled");
    // The floor is what stops a 300s job alerting over a closed laptop.
    expect(staleThreshold(300, 3, 6)).toBe(6 * 3600);
    expect(staleThreshold(31 * 86_400, 3, 6)).toBe(3 * 31 * 86_400);
  });
});

describe("ob 337 pass 6: `ob jobs` and `ob daemon` served from Postgres", () => {
  test(
    "both answer entirely on Postgres and never create the SQLite file",
    async () => {
      const lease = await leaseRealPgDb();
      const dir = mkdtempSync(join(tmpdir(), "ob337-cli-jobs-"));
      // A path that does NOT exist: anything falling back to SQLite has to create it to work, so its
      // continued absence at the end is the proof that nothing did.
      const dbPath = join(dir, "must-never-exist.sqlite");
      process.env[STORE_ENV] = "postgres";
      const ob = async (...args: string[]) => {
        await getStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        return runCli(dbPath, args);
      };
      try {
        // `ob daemon status` touches no database at all -- it reads launchd and the filesystem -- which is
        // exactly why it is servable. Under postgres it must still produce its table rather than refuse.
        const daemon = await ob("daemon", "status", "--json");
        expect(daemon.code).toBe(0);
        const jobs = JSON.parse(daemon.out) as { action: string; jobs: Array<{ job: string; schedule: string }> };
        expect(jobs.action).toBe("status");
        expect(jobs.jobs).toEqual([]); // no client job remains (1589)

        // `ob jobs` reads job_run plus three settings, both on Postgres.
        const empty = await ob("jobs", "--json");
        expect(empty.code).toBe(0);
        const health = JSON.parse(empty.out) as Array<{ job: string; state: string; consecutive_failures: number }>;
        expect(health.length).toBeGreaterThan(0);
        expect(health.every((h) => h.state === "untracked" || h.state === "unscheduled")).toBe(true);
        // The counters reach a --json consumer as NUMBERS, not as the strings Postgres hands back for
        // some integer shapes: a JSON payload carrying "0" is a difference a caller cannot see.
        expect([...new Set(health.map((h) => typeof h.consecutive_failures))]).toEqual(["number"]);

        // A recorded failure comes back through the same command.
        const store = await getStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        await recordJobAttempt(store, "gmail-sync");
        await recordJobResult(store, "gmail-sync", { ok: false, error: "token expired" });
        const after = await ob("jobs", "--json");
        expect(after.code).toBe(0);
        const gmail = (JSON.parse(after.out) as Array<{ job: string; state: string; last_error: string | null }>).find(
          (h) => h.job === "gmail-sync",
        );
        expect(gmail).toMatchObject({ state: "degraded", last_error: "token expired" });

        expect(existsSync(dbPath)).toBe(false);
      } finally {
        // 337j: sqlite by name, because unset now means postgres.
        process.env[STORE_ENV] = "sqlite";
        await resetStore();
        await lease.release();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    PG_BUDGET,
  );
});

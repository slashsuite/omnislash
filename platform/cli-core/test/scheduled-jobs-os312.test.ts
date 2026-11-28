// OS-312: scheduled job health. A job's failure streak counts its failed finished runs, newest first, passing over
// running and skipped ones; alert rule 13 fires for an enabled job failing two or more runs in a row, pinned to the
// latest failed run; `ob jobs` lists the jobs under the daemon table while its --json stays the daemon fleet.
// Fresh SQLite files only.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { hostname } from "node:os";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { computeAlerts, filterSnoozed, PUSH_RULES, snoozeAlert } from "../../../apps/cli/src/commands/alerts.ts";
import {
  createScheduledJob,
  failureStreak,
  finishScheduledJobRun,
  listSchedulesWithRuns,
  deleteScheduledJob,
  runScheduledJobNow,
  schedulesStamp,
  tickScheduledJobs,
  updateScheduledJob,
  type JobRunStatus,
  type ScheduledJobRun,
} from "../../../apps/cli/src/scheduled-jobs.ts";

const NOW = new Date("2026-11-28T10:00:00.000Z");
const HOST = hostname();
const paths: string[] = [];

afterEach(() => {
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});

function fresh(): { path: string; store: Store; close: () => void } {
  const path = freshDbPath();
  paths.push(path);
  const db = openDb(path);
  return { path, store: sqliteStoreFor(db), close: () => db.close() };
}

async function commandJob(s: Store, name: string) {
  return createScheduledJob(s, { name, schedule_kind: "interval", schedule_expr: "1h", target_kind: "command", command: "true" }, NOW);
}

/** Record a finished run straight on the table, at minute `i` after NOW. */
async function addRun(s: Store, jobId: number, status: JobRunStatus, i: number): Promise<void> {
  const at = new Date(NOW.getTime() + i * 60_000).toISOString();
  await s.q.insert(s.t.scheduledJobRun).values({ job_id: jobId, started_at: at, finished_at: status === "running" ? null : at, status, host: HOST, exit_code: status === "failed" ? 1 : 0, output_tail: null, role_message_id: null });
}

const run = (id: number, status: JobRunStatus): ScheduledJobRun => ({ id, job_id: 1, started_at: "", finished_at: null, status, host: null, exit_code: null, output_tail: null, role_message_id: null });

describe("failureStreak", () => {
  test("counts failed finished runs newest first, passing over running and skipped, until a success", () => {
    const cases: Array<[ScheduledJobRun[], number, number | null]> = [
      [[run(6, "running"), run(5, "skipped"), run(4, "failed"), run(3, "succeeded"), run(2, "failed")], 1, 4],
      [[run(5, "failed"), run(4, "skipped"), run(3, "failed"), run(2, "succeeded")], 2, 5],
      [[run(2, "succeeded"), run(1, "failed")], 0, null],
      [[], 0, null],
    ];
    for (const [runs, consecutive_failures, latest_failed_run_id] of cases) expect(failureStreak(runs)).toEqual({ consecutive_failures, latest_failed_run_id });
  });
});

describe("listSchedulesWithRuns (the /schedules list)", () => {
  test("every job, enabled and paused, by name, with its newest five runs and its streak", async () => {
    const { store, close } = fresh();
    const a = await commandJob(store, "alpha");
    await commandJob(store, "beta");
    await updateScheduledJob(store, "beta", { enabled: false }, NOW);
    for (let i = 0; i < 7; i++) await addRun(store, a.id, i < 4 ? "succeeded" : "failed", i);
    const list = await listSchedulesWithRuns(store);
    expect(list.map((j) => [j.name, j.enabled])).toEqual([["alpha", true], ["beta", false]]);
    expect(list[0]!.runs).toHaveLength(5);
    expect(list[0]!.runs.map((r) => r.status)).toEqual(["failed", "failed", "failed", "succeeded", "succeeded"]);
    expect(list[0]!.consecutive_failures).toBe(3);
    expect(list[1]!.runs).toEqual([]);
    close();
  });
});

describe("alert rule 13: schedule failing", () => {
  const rule13 = async (s: Store) => (await computeAlerts(s, { focusProject: null, now: NOW.toISOString() })).filter((a) => a.rule === 13);

  test("one failure is quiet; two in a row fire, pinned to the latest failed run", async () => {
    const { store, close } = fresh();
    const j = await commandJob(store, "nightly-sync");
    await addRun(store, j.id, "succeeded", 0);
    await addRun(store, j.id, "failed", 1);
    expect(await rule13(store)).toEqual([]);
    await addRun(store, j.id, "failed", 2);
    const [a, ...rest] = await rule13(store);
    expect(rest).toEqual([]);
    const latest = (await listSchedulesWithRuns(store))[0]!.runs[0]!.id;
    expect(a).toMatchObject({ key: "schedule_failing:nightly-sync", label: "schedule failing", entity: "nightly-sync", state_hash: `run:${latest}` });
    expect(a!.message).toContain("failed 2 runs in a row");
    close();
  });

  test("a paused job is quiet, and a success clears it", async () => {
    const { store, close } = fresh();
    const j = await commandJob(store, "nightly-sync");
    await addRun(store, j.id, "failed", 1);
    await addRun(store, j.id, "failed", 2);
    await updateScheduledJob(store, "nightly-sync", { enabled: false }, NOW);
    expect(await rule13(store)).toEqual([]);
    await updateScheduledJob(store, "nightly-sync", { enabled: true }, NOW);
    expect(await rule13(store)).toHaveLength(1);
    await addRun(store, j.id, "succeeded", 3);
    expect(await rule13(store)).toEqual([]);
    close();
  });

  test("a snooze holds while no new run fails, and the next failure brings it back", async () => {
    const { store, close } = fresh();
    const j = await commandJob(store, "nightly-sync");
    await addRun(store, j.id, "failed", 1);
    await addRun(store, j.id, "failed", 2);
    await snoozeAlert(store, "schedule_failing:nightly-sync", null);
    const visible = async () => (await filterSnoozed(store, await rule13(store))).map((a) => a.key);
    expect(await visible()).toEqual([]);
    await addRun(store, j.id, "running", 3);
    expect(await visible()).toEqual([]);
    await addRun(store, j.id, "failed", 4);
    expect(await visible()).toEqual(["schedule_failing:nightly-sync"]);
    close();
  });

  test("fires from real ticks: a command job claimed and finished failed twice", async () => {
    const { store, close } = fresh();
    await commandJob(store, "backup");
    for (const i of [1, 2]) {
      const now = new Date(NOW.getTime() + i * 3_600_000);
      await runScheduledJobNow(store, "backup", now);
      const { commands } = await tickScheduledJobs(store, { host: HOST, now });
      expect(commands).toHaveLength(1);
      await finishScheduledJobRun(store, commands[0]!.run_id, { status: "failed", exit_code: 2, output_tail: "disk full" }, now);
    }
    const [a] = await rule13(store);
    expect(a!.message).toContain("Last error: exit 2: disk full");
    close();
  });

  test("it may reach the phone, as a failing daemon job does", () => {
    expect(PUSH_RULES.has(13)).toBe(true);
  });
});

describe("ob jobs", () => {
  test("text lists the scheduled jobs under the daemon table; --json stays the daemon fleet", async () => {
    const { path, store, close } = fresh();
    const j = await commandJob(store, "db-copy");
    await addRun(store, j.id, "failed", 1);
    await addRun(store, j.id, "failed", 2);
    await store.q.update(store.t.scheduledJob).set({ last_status: "failed", last_run_at: NOW.toISOString() });
    await commandJob(store, "paused-one");
    await updateScheduledJob(store, "paused-one", { enabled: false }, NOW);
    close();
    const text = await runCli(path, ["jobs"]);
    expect(text.code).toBe(0);
    const [, section] = text.out.split("scheduled jobs (ob schedule)\n");
    expect(section).toBeDefined();
    const lines = section!.trim().split("\n");
    expect(lines[0]).toMatch(/^db-copy\s+failed\s+last run 2026-11-28T10:00:00.000Z, next .*\t2 fail\(s\) in a row$/);
    expect(lines[1]).toMatch(/^paused-one\s+paused\s+last run never$/);
    const json = await runCli(path, ["jobs", "--json"]);
    const rows = JSON.parse(json.out) as { job: string }[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.some((r) => r.job === "db-copy")).toBe(false);
  });

  test("with no scheduled jobs the text is the daemon table alone", async () => {
    const { path, close } = fresh();
    close();
    const text = await runCli(path, ["jobs"]);
    expect(text.out).not.toContain("scheduled jobs");
  });
});

describe("schedulesStamp (the live snapshot's schedules field)", () => {
  test("moves on a job write, a claimed run, a finished run and a delete", async () => {
    const { store, close } = fresh();
    const seen = [await schedulesStamp(store)];
    // Each write is its own step a few milliseconds apart, as CLI writes and the realtime poll are.
    const moves = async (write: () => Promise<unknown>) => {
      await Bun.sleep(2);
      await write();
      const s = await schedulesStamp(store);
      expect(s).not.toBe(seen.at(-1)); // a push compares with the last snapshot only
      seen.push(s);
    };
    await moves(() => commandJob(store, "backup"));
    await moves(() => updateScheduledJob(store, "backup", { enabled: false }, NOW));
    await moves(() => updateScheduledJob(store, "backup", { enabled: true }, NOW));
    await moves(() => runScheduledJobNow(store, "backup", NOW));
    let runId = 0;
    await moves(async () => (runId = (await tickScheduledJobs(store, { host: HOST, now: NOW })).commands[0]!.run_id));
    await moves(() => finishScheduledJobRun(store, runId, { status: "succeeded", exit_code: 0, output_tail: "" }, NOW));
    await moves(() => deleteScheduledJob(store, "backup"));
    close();
  });
});

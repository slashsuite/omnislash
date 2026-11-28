// OS-310 on Postgres: migration 0008_scheduled_job applies cleanly and scheduled job CRUD + runs work on Postgres.
// Real local cluster over a unix socket (the ob 325 harness), no network, no live DB.
import { expect, test } from "bun:test";
import { openStore } from "../../../apps/cli/src/db/store.ts";
import { addTeam } from "../../../apps/cli/src/team.ts";
import {
  createScheduledJob,
  deleteScheduledJob,
  finishScheduledJobRun,
  getScheduledJob,
  listScheduledJobRuns,
  listScheduledJobs,
  runScheduledJobNow,
  startScheduledJobRun,
  updateScheduledJob,
} from "../../../apps/cli/src/scheduled-jobs.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

test(
  "scheduled_job and scheduled_job_run CRUD round-trip on postgres (OS-310)",
  async () => {
    const lease = await leaseRealPgDb();
    const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
    try {
      await addTeam(store, { name: "core" });
      const now = new Date("2026-11-28T10:00:00.000Z");

      const roleJob = await createScheduledJob(
        store,
        {
          name: "pg-nightly",
          schedule_kind: "cron",
          schedule_expr: "0 3 * * *",
          target_kind: "role",
          team: "core",
          role: "architect",
          prompt: "Sweep open items",
        },
        now,
      );
      expect(roleJob.next_run_at).toBe("2026-11-29T03:00:00.000Z");

      const cmdJob = await createScheduledJob(
        store,
        {
          name: "pg-ping",
          schedule_kind: "interval",
          schedule_expr: "15m",
          target_kind: "command",
          command: "echo ok",
          host: "desk",
        },
        now,
      );
      expect(cmdJob.next_run_at).toBe("2026-11-28T10:15:00.000Z");

      await updateScheduledJob(store, "pg-ping", { enabled: false }, now);
      expect((await listScheduledJobs(store)).map((j) => j.name)).toEqual(["pg-nightly"]);
      expect((await listScheduledJobs(store, { all: true })).map((j) => j.name)).toEqual(["pg-nightly", "pg-ping"]);

      await updateScheduledJob(store, "pg-ping", { enabled: true }, now);
      const due = await runScheduledJobNow(store, "pg-ping", now);
      expect(due.next_run_at).toBe(now.toISOString());

      const runRow = await startScheduledJobRun(store, cmdJob.id, { host: "desk", startedAt: now.toISOString() });
      const doneRun = await finishScheduledJobRun(store, runRow.id, {
        status: "succeeded",
        exitCode: 0,
        output: "ok\n",
        nextRunAt: "2026-11-28T10:15:00.000Z",
      });
      expect(doneRun.status).toBe("succeeded");

      const detail = await listScheduledJobRuns(store, "pg-ping", 10);
      expect(detail.job.last_status).toBe("succeeded");
      expect(detail.runs).toHaveLength(1);

      await deleteScheduledJob(store, "pg-ping");
      expect(await getScheduledJob(store, "pg-ping")).toBeNull();
    } finally {
      await store.close();
      await lease.release();
    }
  },
  spawnBudget(2),
);

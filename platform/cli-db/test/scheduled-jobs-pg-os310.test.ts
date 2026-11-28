// OS-310 on Postgres: migration 0008_scheduled_job applies cleanly and scheduled job CRUD + cascade + concurrency work on Postgres.
// Real local cluster over a unix socket (the ob 325 harness), no network, no live DB.
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openStore } from "../../../apps/cli/src/db/store.ts";
import { addTeam } from "../../../apps/cli/src/team.ts";
import {
  createScheduledJob,
  deleteScheduledJob,
  getScheduledJob,
  listScheduledJobRuns,
  listScheduledJobs,
  runScheduledJobNow,
  updateScheduledJob,
} from "../../../apps/cli/src/scheduled-jobs.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

test(
  "scheduled_job and scheduled_job_run CRUD, int4 guard, cascade delete, and duplicate race on postgres (OS-310)",
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

      // Out-of-range int4 ref returns null instead of Postgres overflow error.
      expect(await getScheduledJob(store, "99999999999")).toBeNull();

      // Concurrent duplicate-name creates: one succeeds, the other gets the mapped "already exists" AppError.
      const race = await Promise.allSettled([
        createScheduledJob(store, { name: "pg-race", schedule_kind: "interval", schedule_expr: "5m", target_kind: "command", command: "true" }, now),
        createScheduledJob(store, { name: "pg-race", schedule_kind: "interval", schedule_expr: "5m", target_kind: "command", command: "true" }, now),
      ]);
      expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = race.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0]!.reason)).toContain("already exists");

      await updateScheduledJob(store, "pg-ping", { enabled: false }, now);
      expect((await listScheduledJobs(store)).map((j) => j.name)).toEqual(["pg-nightly", "pg-race"]);
      expect((await listScheduledJobs(store, { all: true })).map((j) => j.name)).toEqual(["pg-nightly", "pg-ping", "pg-race"]);

      await updateScheduledJob(store, "pg-ping", { enabled: true }, now);
      const due = await runScheduledJobNow(store, "pg-ping", now);
      expect(due.next_run_at).toBe(now.toISOString());

      await store.q.insert(store.t.scheduledJobRun).values({
        job_id: cmdJob.id,
        started_at: now.toISOString(),
        finished_at: now.toISOString(),
        status: "succeeded",
        host: "desk",
        exit_code: 0,
        output_tail: "ok\n",
      });
      const detail = await listScheduledJobRuns(store, "pg-ping", 10);
      expect(detail.runs).toHaveLength(1);

      await deleteScheduledJob(store, "pg-ping");
      expect(await getScheduledJob(store, "pg-ping")).toBeNull();
      expect(await store.q.select().from(store.t.scheduledJobRun).where(eq(store.t.scheduledJobRun.job_id, cmdJob.id))).toHaveLength(0);
    } finally {
      await store.close();
      await lease.release();
    }
  },
  spawnBudget(2),
);

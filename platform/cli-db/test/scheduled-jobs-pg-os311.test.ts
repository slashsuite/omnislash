// OS-311 on Postgres: concurrent due evaluation claims each due job once, the race separate machines' `ob role tick`
// passes run against the one store. Real local cluster over a unix socket (the ob 325 harness), no network.
import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { openStore } from "../../../apps/cli/src/db/store.ts";
import { addTeam } from "../../../apps/cli/src/team.ts";
import { createScheduledJob, finishScheduledJobRun, getScheduledJob, listScheduledJobRuns, tickScheduledJobs } from "../../../apps/cli/src/scheduled-jobs.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

test(
  "eight concurrent ticks from two hosts fire a due role job once and claim a due command job once (OS-311)",
  async () => {
    const lease = await leaseRealPgDb();
    const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
    try {
      await addTeam(store, { name: "core" });
      const made = new Date("2026-11-28T09:00:00.000Z");
      const now = new Date("2026-11-28T10:00:00.000Z");
      const role = await createScheduledJob(store, { name: "pg-sweep", schedule_kind: "interval", schedule_expr: "15m", target_kind: "role", team: "core", role: "architect", prompt: "Sweep" }, made);
      const cmd = await createScheduledJob(store, { name: "pg-ping", schedule_kind: "interval", schedule_expr: "15m", target_kind: "command", command: "echo ok" }, made);
      const t = store.t.scheduledJob;
      for (const id of [role.id, cmd.id]) await store.q.update(t).set({ next_run_at: "2026-11-28T09:59:00.000Z" }).where(eq(t.id, id));

      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => tickScheduledJobs(store, { host: i % 2 ? "desk" : "laptop", now })));
      expect(results.flatMap((r) => r.fired).map((f) => f.name)).toEqual(["pg-sweep"]);
      const claims = results.flatMap((r) => r.commands);
      expect(claims.map((c) => c.name)).toEqual(["pg-ping"]);
      expect(await store.q.select().from(store.t.roleMessage)).toHaveLength(1);
      expect((await listScheduledJobRuns(store, "pg-sweep")).runs).toHaveLength(1);
      expect((await listScheduledJobRuns(store, "pg-ping")).runs).toMatchObject([{ status: "running" }]);
      expect((await getScheduledJob(store, "pg-sweep"))!.next_run_at).toBe("2026-11-28T10:15:00.000Z");

      // Two finishes of one run race: one records it, the other is refused.
      const fin = await Promise.allSettled([
        finishScheduledJobRun(store, claims[0]!.run_id, { status: "succeeded", exit_code: 0, output_tail: "ok\n" }),
        finishScheduledJobRun(store, claims[0]!.run_id, { status: "failed", exit_code: 1, output_tail: "" }),
      ]);
      expect(fin.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await listScheduledJobRuns(store, "pg-ping")).runs).toHaveLength(1);
    } finally {
      await store.close();
      await lease.release();
    }
  },
  spawnBudget(2),
);

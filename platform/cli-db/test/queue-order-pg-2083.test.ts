// OB-2083: `setQueueOrder` on Postgres. READ COMMITTED lets two orders in one project both number a band from the
// same stale read; the project row lock makes them queue up, so the band always ends dense (1..n, no duplicate).
// Real local cluster over a unix socket (the ob 325 harness), no network, no live DB.
import { expect, test } from "bun:test";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { nextWorklist } from "../../../apps/cli/src/worklist.ts";
import { setQueueOrder } from "../../../apps/cli/src/workflow.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

test(
  "concurrent orders on two connections leave the band dense with no duplicate rank",
  async () => {
    const lease = await leaseRealPgDb();
    const stores: Store[] = [];
    try {
      const opts = { kind: "postgres" as const, connection: lease.options as unknown as Record<string, unknown> };
      stores.push(await openStore(opts), await openStore(opts));
      await registerProject(stores[0]!, { name: "alpha", kind: "side" });
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push(await createItem(stores[0]!, { type: "task", title: `t${i}`, projectId: "alpha", priority: 3 }));
      // Interleave moves from both connections, all into one band.
      await Promise.all([
        ...ids.slice(0, 3).map((id, i) => setQueueOrder(stores[i % 2]!, id, { top: true })),
        ...ids.slice(3).map((id, i) => setQueueOrder(stores[(i + 1) % 2]!, id, { top: true, priority: 3 })),
      ]);
      const band = (await nextWorklist(stores[0]!, { project: "alpha" })).items.filter((i) => i.priority === 3);
      expect(band).toHaveLength(6);
      const ranks = band.map((i) => i.queue_rank).sort((a, b) => Number(a) - Number(b));
      expect(ranks).toEqual(band.map((_, i) => i + 1));
      expect((await getItem(stores[0]!, ids[0]!))!.queue_rank).not.toBeNull();
    } finally {
      for (const s of stores) await s.close();
      await lease.release();
    }
  },
  spawnBudget(2),
);

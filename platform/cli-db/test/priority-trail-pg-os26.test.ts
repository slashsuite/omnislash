// OS-26 on Postgres: `editItem` and `setQueueOrder` leave one `priority_change` event in the same transaction
// as the update, a no-op leaves none, and `blockItem` keeps the owner on the transition. Real local cluster
// over a unix socket (the ob 325 harness), no network, no live DB.
import { expect, test } from "bun:test";
import { openStore } from "../../../apps/cli/src/db/store.ts";
import { createItem, editItem } from "../../../apps/cli/src/items.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { blockItem, setQueueOrder } from "../../../apps/cli/src/workflow.ts";
import { DECISION_TYPE, decisionsForItem, PRIORITY_CHANGE_TYPE } from "../../../apps/cli/src/decisions.ts";
import { eventsForItemFor, parsePayload } from "../../../apps/cli/src/events.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

test(
  "priority changes and the block owner land on the trail on postgres",
  async () => {
    const lease = await leaseRealPgDb();
    const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
    try {
      await registerProject(store, { name: "alpha", kind: "side" });
      const id = await createItem(store, { type: "task", title: "p", projectId: "alpha", priority: 3 });
      const h = await createItem(store, { type: "task", title: "h", projectId: "alpha", priority: 2 });

      await editItem(store, id, { priority: 3 });
      await editItem(store, id, { priority: 4 }, { actor: "architect-pg", note: "later" });
      await setQueueOrder(store, id, { before: h }, { actor: "dashboard" });
      await setQueueOrder(store, id, { top: true });

      const rows = await eventsForItemFor(store, id, 50, { source: "ob", type: PRIORITY_CHANGE_TYPE });
      expect(rows.map((r): Record<string, unknown> => ({ actor: r.actor, ...parsePayload<Record<string, unknown>>(r) }))).toEqual([
        { actor: "dashboard", from: "low", to: "high" },
        { actor: "architect-pg", from: "medium", to: "low", note: "later" },
      ]);

      await blockItem(store, id, "needs a key", "jacobus");
      const transitions = await eventsForItemFor(store, id, 50, { source: "ob", type: DECISION_TYPE });
      expect(transitions).toHaveLength(1);
      expect(parsePayload(transitions[0]!)).toMatchObject({ to: "blocked", block_owner: "jacobus" });
      expect((await decisionsForItem(store, id)).map((d) => d.kind)).toEqual(["transition", "priority", "priority"]);
    } finally {
      await store.close();
      await lease.release();
    }
  },
  spawnBudget(2),
);

// OB-1973: a ticket closed from the dashboard drawer lands its spinoff rows, like the CLI and API closes.
// The dashboard's transitionItem body is applyItemTransition(store, data); it runs here on a fresh store.
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { orm } from "../../../apps/cli/src/db/orm.ts";
import { spinoff } from "../../../apps/cli/src/db/schema.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { applyItemTransition } from "../../dashboard-kit/src/server/item-transition.ts";
import { enqueueSpinoff, getSpinoffRow } from "../src/commands/spinoff.ts";

async function seed() {
  const db = freshDb();
  const id = await createItem(db, { type: "task", title: "ship it" });
  const { row } = await enqueueSpinoff(db, { ticketRef: id, repo: "/r/acme", branch: `ob-${id}`, mode: "interactive", brief: "b" });
  orm(db).update(spinoff).set({ status: "launched", agent_id: `ob-${id}` }).where(eq(spinoff.id, row.id)).run();
  return { db, id, rowId: row.id };
}

describe("dashboard close lands the item's spinoff rows (OB-1973)", () => {
  test("close marks the building row landed (merged) and the item done", async () => {
    const { db, id, rowId } = await seed();
    await applyItemTransition(asStore(db), { id, action: "close" });
    expect((await getItem(db, id))!.status).toBe("done");
    expect((await getSpinoffRow(db, rowId))!.status).toBe("merged");
  });

  test("other actions leave the row alone", async () => {
    const { db, id, rowId } = await seed();
    await applyItemTransition(asStore(db), { id, action: "start" });
    expect((await getSpinoffRow(db, rowId))!.status).toBe("launched");
    await expect(applyItemTransition(asStore(db), { id, action: "block" })).rejects.toThrow("block requires a reason");
  });
});

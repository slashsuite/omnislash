// OB-1939: the dashboard drawer's transitions. The dashboard's transitionItem body is
// applyItemTransition(store, data); it runs here on a fresh store, so no server, no network.
import { describe, expect, test } from "bun:test";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { eq } from "drizzle-orm";
import { orm } from "../../../apps/cli/src/db/orm.ts";
import { spinoff } from "../../../apps/cli/src/db/schema.ts";
import { enqueueSpinoff, getSpinoffRow } from "../src/commands/spinoff.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { applyItemTransition } from "../../dashboard-kit/src/server/item-transition.ts";

async function blockedTask() {
  const db = freshDb();
  const id = await createItem(db, { type: "task", title: "stuck" });
  await applyItemTransition(asStore(db), { id, action: "start" });
  await applyItemTransition(asStore(db), { id, action: "block", reason: "waiting on a key", owner: "sam" });
  return { db, id };
}

describe("dashboard drawer transitions (OB-1939)", () => {
  test("start on a blocked item leaves it in_progress with the block cleared", async () => {
    const { db, id } = await blockedTask();
    expect((await getItem(db, id))!.block_reason).toBe("waiting on a key");
    await applyItemTransition(asStore(db), { id, action: "start" });
    const it = (await getItem(db, id))!;
    expect(it.status).toBe("in_progress");
    expect(it.block_reason).toBeNull();
    expect(it.block_owner).toBeNull();
  });

  test("ready on a blocked item clears the block too", async () => {
    const { db, id } = await blockedTask();
    await applyItemTransition(asStore(db), { id, action: "ready" });
    const it = (await getItem(db, id))!;
    expect(it.status).toBe("ready");
    expect(it.block_reason).toBeNull();
    expect(it.block_owner).toBeNull();
  });

  test("unblock restores the status the trail says it was blocked from", async () => {
    const { db, id } = await blockedTask(); // blocked from in_progress
    await applyItemTransition(asStore(db), { id, action: "unblock" });
    const it = (await getItem(db, id))!;
    expect(it.status).toBe("in_progress");
    expect(it.block_reason).toBeNull();
    expect(it.block_owner).toBeNull();
  });

  test("move to qa from qa_ready works on a linear_ref", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "linear_ref", title: "linear one", status: "qa_ready" });
    await applyItemTransition(asStore(db), { id, action: "move", to: "qa" });
    expect((await getItem(db, id))!.status).toBe("qa");
  });

  test("move along a forbidden edge throws and leaves the status unchanged", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "linear_ref", title: "linear two", status: "qa_ready" });
    await expect(applyItemTransition(asStore(db), { id, action: "move", to: "merged" })).rejects.toThrow();
    expect((await getItem(db, id))!.status).toBe("qa_ready");
  });

  test("move without a target throws", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "no target" });
    await expect(applyItemTransition(asStore(db), { id, action: "move" })).rejects.toThrow("target");
  });

  test("move to done closes through closeAndLand, so the spinoff row lands", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "ship it" });
    const { row } = await enqueueSpinoff(db, { ticketRef: id, repo: "/r/acme", branch: `ob-${id}`, mode: "interactive", brief: "b" });
    orm(db).update(spinoff).set({ status: "launched", agent_id: `ob-${id}` }).where(eq(spinoff.id, row.id)).run();
    await applyItemTransition(asStore(db), { id, action: "move", to: "done" });
    expect((await getItem(db, id))!.status).toBe("done");
    expect((await getSpinoffRow(db, row.id))!.status).toBe("merged");
  });
});

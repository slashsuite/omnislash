// OS-172 (spike OS-167 step 5): the item lifecycle machine is the item check. Pinned on BOTH engines:
//
//   * an illegal move (done to blocked) is `TransitionRefused` with why `machine`, on every door that can
//     take it (blockItem, moveItem, transitionTo), and writes nothing;
//   * a block with no reason (`ob state <id> blocked`, the API `/state` `set blocked`) is refused with why
//     `guard`;
//   * a retried close is a no-op that records no decision;
//   * an unknown stored status is refused by the machine, never thrown as a crash, and `repairItem` moves it
//     to `open` with `repair: <why>` and `repair: true` on the trail;
//   * a repair still goes through the guarded write, so a race refuses it with `StatusRaced`.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { DECISION_SOURCE, DECISION_TYPE, decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { eventsForItemFor, parsePayload } from "../../../apps/cli/src/events.ts";
import { StatusRaced, TransitionRefused } from "../../../apps/cli/src/errors.ts";
import {
  blockItem,
  closeItem,
  moveItem,
  repairItem,
  statusRaceSeam,
  transitionTo,
  validNextStatuses,
} from "../../../apps/cli/src/workflow.ts";

const PG_BUDGET = spawnBudget(3);

async function refusal(p: Promise<unknown>): Promise<TransitionRefused> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TransitionRefused);
  return err as TransitionRefused;
}

async function trailOf(store: Store, id: string): Promise<Array<Record<string, unknown>>> {
  const rows = await eventsForItemFor(store, id, 50, { source: DECISION_SOURCE, type: DECISION_TYPE });
  return rows.map((r) => parsePayload<Record<string, unknown>>(r));
}

async function exercise(store: Store): Promise<void> {
  // An illegal move: done -> blocked, on each door that can be asked for it.
  const doors: Array<[string, (id: string) => Promise<unknown>]> = [
    ["blockItem", (id) => blockItem(store, id, "waiting", null)],
    ["moveItem", (id) => moveItem(store, id, "blocked", { reason: "waiting" })],
    ["transitionTo", (id) => transitionTo(store, id, "blocked")],
  ];
  for (const [name, move] of doors) {
    const id = await createItem(store, { type: "task", title: `${name} illegal`, status: "done" });
    const label = (await getItem(store, id))!.ref ?? id;
    const err = await refusal(move(id));
    expect(err.why, name).toBe("machine");
    expect(err.machine, name).toBe("task");
    expect({ id: err.id, from: err.from, event: err.event }, name).toEqual({ id, from: "done", event: "to:blocked" });
    expect(err.message, name).toBe(`item '${label}' is done: 'to:blocked' is not a move from there`);
    expect((await getItem(store, id))?.status, name).toBe("done");
    expect(await decisionsForItem(store, id), name).toEqual([]);
  }

  // The block guard: a block needs a reason. `ob state <id> blocked` and `/state set blocked` reach it
  // through moveItem with no reason.
  for (const reason of [null, "", "   "]) {
    const id = await createItem(store, { type: "task", title: `block ${JSON.stringify(reason)}` });
    const err = await refusal(moveItem(store, id, "blocked", { reason }));
    expect(err.why).toBe("guard");
    expect({ machine: err.machine, from: err.from, event: err.event }).toEqual({ machine: "task", from: "open", event: "to:blocked" });
    expect(err.message).toContain("a block needs a reason");
    expect((await getItem(store, id))?.status).toBe("open");
    expect(await decisionsForItem(store, id)).toEqual([]);
  }

  // transitionTo takes no reason, so it cannot block either.
  const bare = await createItem(store, { type: "task", title: "bare block" });
  expect((await refusal(transitionTo(store, bare, "blocked"))).why).toBe("guard");
  expect((await getItem(store, bare))?.status).toBe("open");

  // A retried close is a no-op with no decision.
  const closed = await createItem(store, { type: "task", title: "closed twice" });
  await closeItem(store, closed);
  await closeItem(store, closed);
  expect((await getItem(store, closed))?.status).toBe("done");
  expect((await decisionsForItem(store, closed)).map((d) => `${d.from} -> ${d.to}`)).toEqual(["open -> done"]);

  // An unknown stored status: refused by the machine (not a crash), no next moves, and repaired to open.
  const legacy = await createItem(store, { type: "task", title: "legacy status" });
  await store.q.update(store.t.item).set({ status: "qa" }).where(eq(store.t.item.id, legacy));
  const stuck = await refusal(transitionTo(store, legacy, "open"));
  expect(stuck.why).toBe("machine");
  expect(stuck.message).toContain("not a state of 'task'");
  expect(stuck.message).toContain("--repair");
  expect(validNextStatuses("task", null, "qa")).toEqual([]);
  await repairItem(store, legacy, "open", "legacy qa status from the old tracker", { actor: "builder-1" });
  expect((await getItem(store, legacy))?.status).toBe("open");
  expect(await trailOf(store, legacy)).toEqual([
    { from: "qa", to: "open", note: "repair: legacy qa status from the old tracker", repair: true },
  ]);

  // A note given with a repair rides after the repair reason, never instead of it.
  const noted = await createItem(store, { type: "task", title: "repair with note" });
  await store.q.update(store.t.item).set({ status: "qa" }).where(eq(store.t.item.id, noted));
  await repairItem(store, noted, "open", "legacy", { note: "from the import" });
  expect((await trailOf(store, noted))[0]?.note).toBe("repair: legacy; from the import");

  // A repair checks the vocab, and refuses done, blocked and a blank reason.
  const r = await createItem(store, { type: "task", title: "repair limits" });
  await expect(repairItem(store, r, "qa_ready", "why")).rejects.toThrow("is not valid for this item");
  await expect(repairItem(store, r, "done", "why")).rejects.toThrow("repair to open, then close or block");
  await expect(repairItem(store, r, "blocked", "why")).rejects.toThrow("repair to open, then close or block");
  await expect(repairItem(store, r, "in_progress", "  ")).rejects.toThrow("a repair needs a reason");
  expect(await decisionsForItem(store, r)).toEqual([]);

  // A repair off `blocked` clears the block fields.
  const blocked = await createItem(store, { type: "task", title: "repair off blocked" });
  await blockItem(store, blocked, "waiting", "ops");
  await repairItem(store, blocked, "merged", "landed by hand");
  const after = await getItem(store, blocked);
  expect(after?.status).toBe("merged");
  expect(after?.block_reason ?? null).toBeNull();

  // A repair goes through the guarded write: a race refuses it and leaves no decision.
  const raced = await createItem(store, { type: "task", title: "repair raced" });
  await store.q.update(store.t.item).set({ status: "qa" }).where(eq(store.t.item.id, raced));
  const restore = statusRaceSeam.set(async (tx, id) => {
    const writer = store.kind === "postgres" ? store : tx;
    await writer.q.update(writer.t.item).set({ status: "in_progress" }).where(eq(writer.t.item.id, id));
  });
  let err: unknown;
  try {
    await repairItem(store, raced, "open", "race");
  } catch (e) {
    err = e;
  } finally {
    restore();
  }
  expect(err).toBeInstanceOf(StatusRaced);
  expect(await decisionsForItem(store, raced)).toEqual([]);
}

describe("the item machine is the item check (OS-172)", () => {
  test("on SQLite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os172-"));
    const store = await openStore({ kind: "sqlite", path: join(dir, "omnislash.sqlite"), create: true });
    try {
      await exercise(store);
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    "on Postgres",
    async () => {
      const lease = await leaseRealPgDb();
      let store: Store | undefined;
      try {
        store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        await exercise(store);
      } finally {
        await store?.close();
        await lease.release();
      }
    },
    PG_BUDGET,
  );
});

// OS-171 (spike OS-167 step 4): an item status write is one guarded `UPDATE ... WHERE status = <from>` in the
// same transaction as its decision row. Pinned on BOTH engines, per door (transitionTo, reopenItem, blockItem,
// unblockItem):
//
//   * the race seam moves the item after the door read `from` and before the write: the move is refused with
//     `StatusRaced`, the move's own status is never written, and no decision row is left;
//   * a decision write that throws inside the transaction leaves the status as it was.
//
// On Postgres the racer writes through the OUTER store, a second pooled connection, so its move commits and
// stands, as another process's would. On SQLite `BEGIN IMMEDIATE` already holds the write lock, so no other
// connection can write in that window; the racer writes through the transaction itself, and the refusal rolls
// its write back with the rest.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { StatusRaced } from "../../../apps/cli/src/errors.ts";
import { blockItem, reopenItem, statusRaceSeam, transitionTo, unblockItem } from "../../../apps/cli/src/workflow.ts";

const PG_BUDGET = spawnBudget(3);

interface Door {
  name: string;
  /** The status the item starts in. */
  start: string;
  /** Where the door would move it. */
  to: string;
  /** Where the racer moves it first. */
  racedTo: string;
  move: (s: Store, id: string) => Promise<void>;
}

const DOORS: Door[] = [
  { name: "transitionTo", start: "open", to: "in_progress", racedTo: "ready", move: (s, id) => transitionTo(s, id, "in_progress") },
  { name: "reopenItem", start: "done", to: "open", racedTo: "in_progress", move: (s, id) => reopenItem(s, id) },
  { name: "blockItem", start: "open", to: "blocked", racedTo: "in_progress", move: (s, id) => blockItem(s, id, "waiting", null) },
  { name: "unblockItem", start: "blocked", to: "done", racedTo: "open", move: (s, id) => unblockItem(s, id, {}, { to: "done" }) },
];

async function moveDirect(s: Store, id: string, status: string): Promise<void> {
  await s.q.update(s.t.item).set({ status }).where(eq(s.t.item.id, id));
}

async function statusOf(s: Store, id: string): Promise<string | undefined> {
  return (await getItem(s, id))?.status;
}

async function exercise(store: Store): Promise<void> {
  for (const door of DOORS) {
    const id = await createItem(store, { type: "task", title: `${door.name} raced`, status: door.start });
    const before = (await decisionsForItem(store, id)).length;
    let fired = 0;
    const restore = statusRaceSeam.set(async (tx, raceId, from, to) => {
      fired++;
      expect({ raceId, from, to }).toEqual({ raceId: id, from: door.start, to: door.to });
      await moveDirect(store.kind === "postgres" ? store : tx, raceId, door.racedTo);
    });
    let err: unknown;
    try {
      await door.move(store, id);
    } catch (e) {
      err = e;
    } finally {
      restore();
    }
    expect(fired, door.name).toBe(1);
    expect(err, door.name).toBeInstanceOf(StatusRaced);
    expect((err as StatusRaced).why).toBe("race");
    expect((err as StatusRaced).from).toBe(door.start);
    expect((err as StatusRaced).to).toBe(door.to);
    // The racer's move stands on Postgres; on SQLite it rolled back with the refused transaction.
    expect(await statusOf(store, id), door.name).toBe(store.kind === "postgres" ? door.racedTo : door.start);
    expect((await decisionsForItem(store, id)).length, `${door.name}: no decision row`).toBe(before);
  }

  // A decision write that throws inside the transaction rolls back the status write with it. A BigInt in the
  // payload is what makes `JSON.stringify` throw inside `recordDecision`, after the guarded UPDATE ran.
  const unwritable = { extra: { poison: 1n } as Record<string, unknown> };
  const cases: Array<[string, string, (id: string) => Promise<void>]> = [
    ["transitionTo", "open", (id) => transitionTo(store, id, "in_progress", unwritable)],
    ["reopenItem", "done", (id) => reopenItem(store, id, unwritable)],
    ["blockItem", "open", (id) => blockItem(store, id, "waiting", "ops", unwritable)],
    ["unblockItem", "blocked", (id) => unblockItem(store, id, unwritable, { to: "done" })],
  ];
  for (const [name, start, move] of cases) {
    const id = await createItem(store, { type: "task", title: `${name} decision throws`, status: start });
    const before = await getItem(store, id);
    await expect(move(id), name).rejects.toThrow();
    const after = await getItem(store, id);
    expect(after?.status, name).toBe(start);
    expect(after?.closed_at ?? null, name).toBe(before?.closed_at ?? null);
    expect(after?.block_reason ?? null, name).toBe(before?.block_reason ?? null);
    expect((await decisionsForItem(store, id)).length, name).toBe(0);
  }

  // The unraced path still writes both, in one go (a sanity anchor so the refusals above are not vacuous).
  const ok = await createItem(store, { type: "task", title: "not raced" });
  await transitionTo(store, ok, "in_progress");
  expect(await statusOf(store, ok)).toBe("in_progress");
  expect((await decisionsForItem(store, ok)).map((d) => `${d.from} -> ${d.to}`)).toEqual(["open -> in_progress"]);
}

describe("a raced item status write is refused and leaves no decision (OS-171)", () => {
  test("on SQLite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "os171-"));
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

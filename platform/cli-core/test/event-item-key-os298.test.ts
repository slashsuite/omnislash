// OS-298: an event's idempotency key names its item. Two items given the same decision in the same millisecond
// carry identical payloads; before the item joined the key, the second item's event was dropped as a duplicate.
import { describe, expect, test } from "bun:test";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { eventsBetween, recordEvent, recordEventFor } from "../../../apps/cli/src/events.ts";
import { createItem } from "../../../apps/cli/src/items.ts";

const TS = "2026-11-28T00:00:00.000Z";
const byId = (a: string | null, b: string | null) => (a ?? "").localeCompare(b ?? "");
const same = { ts: TS, source: "decision", type: "status_change", payload: { from: "spinoff-check", to: "go" } };

describe("event idempotency key (OS-298)", () => {
  test("recordEventFor keeps identical events on two items, and still drops a repeat on one", async () => {
    const db = openDb(freshDbPath());
    try {
      const a = await createItem(db, { type: "task", title: "a" });
      const b = await createItem(db, { type: "task", title: "b" });
      const store = asStore(db);
      await recordEventFor(store, { ...same, itemId: a });
      await recordEventFor(store, { ...same, itemId: b });
      await recordEventFor(store, { ...same, itemId: a });
      expect(eventsBetween(db, { source: "decision", type: "status_change" }).map((e) => e.item_id).sort(byId)).toEqual([a, b].sort(byId));
    } finally {
      db.close();
    }
  });

  test("recordEvent keys the item the same way, and a re-synced event with no item is still recorded once", async () => {
    const db = openDb(freshDbPath());
    try {
      const a = await createItem(db, { type: "task", title: "a" });
      const b = await createItem(db, { type: "task", title: "b" });
      recordEvent(db, { ...same, itemId: a });
      recordEvent(db, { ...same, itemId: b });
      recordEvent(db, { ...same, itemId: b });
      recordEvent(db, { ...same, source: "github", type: "pr_synced" });
      recordEvent(db, { ...same, source: "github", type: "pr_synced" });
      expect(eventsBetween(db, { source: "decision" }).map((e) => e.item_id).sort(byId)).toEqual([a, b].sort(byId));
      expect(eventsBetween(db, { source: "github" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

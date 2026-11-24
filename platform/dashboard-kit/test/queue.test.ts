// OS-25: the Queue page's read. Each band's order is `ob next --project`'s with Today set aside, every band shows
// (empty ones too), a Today item is marked in its place, and the kit's own write mapping (top with a priority,
// setPriority) moves items the way the page asks. The core order moves have their own tests. In-memory sqlite, no network.
import { describe, expect, test } from "bun:test";
import { eq } from "../../../apps/cli/src/db/orm.ts";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { addTags, createItem, itemsStamp } from "../../../apps/cli/src/items.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { setTodayRank } from "../../../apps/cli/src/workflow.ts";
import { nextWorklist } from "../../../apps/cli/src/worklist.ts";
import { queueView } from "../src/server/queue.ts";
import { setPriority, setQueueOrder } from "../src/server/writes.ts";

const same = new Request("http://127.0.0.1/_serverFn/x", { method: "POST", headers: { "sec-fetch-site": "same-origin" } });

async function world() {
  const store = sqliteStoreFor(freshDb());
  await registerProject(store, { name: "omnislash", kind: "side" });
  await registerProject(store, { name: "other", kind: "side" });
  let n = 0;
  const mk = async (title: string, priority: number | null, project = "omnislash") => {
    const id = await createItem(store, { type: "task", title, projectId: project, priority });
    const at = `2026-01-01T00:00:${String(++n).padStart(2, "0")}.000Z`;
    await store.q.update(store.t.item).set({ updated_at: at, created_at: at }).where(eq(store.t.item.id, id));
    return id;
  };
  return { store, mk, ctx: { request: same, store: async () => store } };
}

const titles = (v: Awaited<ReturnType<typeof queueView>>) => Object.fromEntries(v.bands.map((b) => [b.name, b.items.map((i) => i.title)]));

describe("queueView", () => {
  test("every band best first, each in ob next order with Today set aside", async () => {
    const { store, mk } = await world();
    await mk("m1", 3);
    await mk("h1", 2);
    const today = await mk("m2", 3);
    await mk("u1", 1);
    await mk("none-in-focus", null);
    await mk("elsewhere", 2, "other");
    await setConfig(store, "focus_project", "omnislash");
    await setTodayRank(store, today, 1);

    const v = await queueView(store);
    expect(v.project.id).toBe("omnislash");
    expect(v.itemsStamp).toBe(await itemsStamp(store));
    expect(v.bands.map((b) => b.name)).toEqual(["critical", "urgent", "flake", "high", "medium", "low", "none"]);
    // No priority in the focus project counts as high, as in ob next.
    expect(titles(v)).toEqual({ critical: [], urgent: ["u1"], flake: [], high: ["none-in-focus", "h1"], medium: ["m2", "m1"], low: [], none: [] });
    expect(v.bands.find((b) => b.name === "medium")!.items.map((i) => i.today)).toEqual([true, false]);

    // Parity: ob next's order with the Today items lifted out of the top is the page's order, band after band.
    const next = (await nextWorklist(store, { project: "omnislash" })).items.filter((i) => i.today_rank === null).map((i) => i.title);
    expect(v.bands.flatMap((b) => b.items.filter((i) => !i.today).map((i) => i.title))).toEqual(next);
  });

  test("names another project, carries tags, and refuses an unknown one", async () => {
    const { store, mk } = await world();
    const id = await mk("elsewhere", 4, "other");
    await addTags(store, id, ["ui", "dashboard"]);
    const v = await queueView(store, "other");
    expect(v.projects.map((p) => p.id).sort()).toEqual(["omnislash", "other"]);
    expect(v.bands.find((b) => b.name === "low")!.items[0]!.tags).toEqual(["dashboard", "ui"]);
    await expect(queueView(store, "nope")).rejects.toThrow("no project 'nope'");
  });
});

describe("the queue writes", () => {
  test("a drop on an empty band is top with its priority; setPriority moves the item's band", async () => {
    const { store, mk, ctx } = await world();
    const a = await mk("a", 3);
    await setQueueOrder(ctx, { id: a, move: { top: true, priority: 4 } });
    expect(titles(await queueView(store)).low).toEqual(["a"]);
    const d = await setPriority(ctx, { id: a, priority: 6 });
    expect(d.priority).toBe("critical");
    expect(titles(await queueView(store)).critical).toEqual(["a"]);
  });
});

describe("itemsStamp", () => {
  test("moves on an ob order and on an add, so the live snapshot pushes", async () => {
    const { store, mk, ctx } = await world();
    const a = await mk("a", 3);
    const b = await mk("b", 3);
    const before = await itemsStamp(store);
    expect(before).toBe("2@2026-01-01T00:00:02.000Z");
    await setQueueOrder(ctx, { id: a, move: { before: b } });
    const moved = await itemsStamp(store);
    expect(moved).not.toBe(before);
    await mk("c", 3);
    expect(await itemsStamp(store)).not.toBe(moved);
  });
});

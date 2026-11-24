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
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { nextWorklist } from "../../../apps/cli/src/worklist.ts";
import { addTeam } from "../../../apps/cli/src/team.ts";
import { DEFAULT_GROUP, OTHER_GROUP, projectGroups } from "../src/server/groups.ts";
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

    const v = await queueView(store, { project: "omnislash" });
    expect(v.project!.id).toBe("omnislash");
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
    const v = await queueView(store, { project: "other" });
    expect(v.group.projects.map((p) => p.id).sort()).toEqual(["omnislash", "other"]);
    expect(v.bands.find((b) => b.name === "low")!.items[0]!.tags).toEqual(["dashboard", "ui"]);
    await expect(queueView(store, { project: "nope" })).rejects.toThrow("no project 'nope'");
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

  test("OS-26: setPriority and a band-crossing order each leave one trail event as dashboard; a no-op none", async () => {
    const { store, mk, ctx } = await world();
    const a = await mk("a", 3);
    await setPriority(ctx, { id: a, priority: 3 });
    await setPriority(ctx, { id: a, priority: 1 });
    await setQueueOrder(ctx, { id: a, move: { top: true, priority: 4 } });
    const trail = (await decisionsForItem(store, a)).map((d) => `${d.kind} ${d.who} ${d.from}→${d.to}`);
    expect(trail).toEqual(["priority dashboard urgent→low", "priority dashboard medium→urgent"]);
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

// OS-185: the page opens on a group (a team), its projects merged, and drills into one project on request.
describe("queue by group", () => {
  async function teams() {
    const w = await world();
    await registerProject(w.store, { name: "taskslash", kind: "side" });
    await registerProject(w.store, { name: "budget", kind: "side" });
    await addTeam(w.store, { name: "slash", icon: "⚔️", display_name: "Slash", projects: ["omnislash", "taskslash"] });
    await addTeam(w.store, { name: "personal", icon: "🏠", display_name: "Personal", projects: ["budget"] });
    await addTeam(w.store, { name: "empty" });
    return w;
  }

  test("the groups are the teams with projects, by name, then Other for the projects in no team", async () => {
    const { store } = await teams();
    const groups = await projectGroups(store);
    expect(groups.map((g) => [g.id, g.label, g.projects.map((p) => p.id)])).toEqual([
      ["personal", "🏠 Personal", ["budget"]],
      ["slash", "⚔️ Slash", ["omnislash", "taskslash"]],
      [OTHER_GROUP, "Other", ["other"]],
    ]);
  });

  test("a group's queue merges its projects band by band, each row naming its project; others stay out", async () => {
    const { store, mk } = await teams();
    await mk("os-high", 2);
    await mk("ts-high", 2, "taskslash");
    await mk("ts-urgent", 1, "taskslash");
    await mk("budget-high", 2, "budget");
    await mk("other-high", 2, "other");
    const v = await queueView(store, { team: "slash" });
    expect(v.group.id).toBe("slash");
    expect(v.project).toBeNull();
    expect(titles(v)).toMatchObject({ urgent: ["ts-urgent"], high: ["ts-high", "os-high"] });
    expect(v.bands.flatMap((b) => b.items.map((i) => `${i.title}@${i.project.id}`)).sort()).toEqual(["os-high@omnislash", "ts-high@taskslash", "ts-urgent@taskslash"]);

    // The drill down: one project of the group, and an old `?project=` link alone finds its group.
    const one = await queueView(store, { team: "slash", project: "taskslash" });
    expect(one.project!.id).toBe("taskslash");
    expect(titles(one)).toMatchObject({ urgent: ["ts-urgent"], high: ["ts-high"] });
    expect((await queueView(store, { project: "budget" })).group.id).toBe("personal");
    // The projects in no team are their own group.
    expect(titles(await queueView(store, { team: OTHER_GROUP })).high).toEqual(["other-high"]);
  });

  test("a team called other does not swallow the projects in no team", async () => {
    const { store } = await teams();
    await registerProject(store, { name: "Lab Work", kind: "side" });
    await addTeam(store, { name: "other", projects: ["lab-work"] });
    const groups = await projectGroups(store);
    expect(groups.map((g) => [g.id, g.projects.map((p) => p.id)]).slice(-2)).toEqual([
      ["slash", ["omnislash", "taskslash"]],
      [OTHER_GROUP, ["other"]],
    ]);
    expect(groups.some((g) => g.id === "other")).toBe(true);
    expect((await queueView(store, { project: "other" })).group.id).toBe(OTHER_GROUP);
  });

  test("?project= finds a project by id or by name, not by its display name alone", async () => {
    const { store } = await teams();
    await registerProject(store, { name: "Task Board", kind: "side", displayName: "Board" });
    await addTeam(store, { name: "work", projects: ["task-board"] });
    expect((await queueView(store, { project: "Task Board" })).project!.id).toBe("task-board");
    expect((await queueView(store, { project: "task-board" })).group.id).toBe("work");
    await expect(queueView(store, { project: "nope" })).rejects.toThrow("no project 'nope'");
  });

  test("no team asked: the focus project's group, else Slash; an unknown team falls back the same way", async () => {
    const { store } = await teams();
    expect((await queueView(store)).group.id).toBe(DEFAULT_GROUP);
    expect((await queueView(store, { team: "nope" })).group.id).toBe(DEFAULT_GROUP);
    await setConfig(store, "focus_project", "budget");
    expect((await queueView(store)).group.id).toBe("personal");
    // A team with no projects is not a group, so asking for it falls back too.
    expect((await queueView(store, { team: "empty" })).group.id).toBe("personal");
  });
});

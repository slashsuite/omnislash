// OB-2083: a per-project execution order (item.queue_rank) that `ob next` follows and `ob order` sets.
// In-memory sqlite store, no network and no live DB. The API half goes through the real handler and, for
// the client, a stubbed transport.
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { existsSync, rmSync } from "node:fs";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { nextWorklist, sortWorklist } from "../../../apps/cli/src/worklist.ts";
import { setQueueOrder, setTodayRank, transitionTo } from "../../../apps/cli/src/workflow.ts";
import { appendNote, editItem } from "../../../apps/cli/src/items.ts";
import { order as orderHandler } from "../../../apps/cli/src/api/handlers.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";

const HIGH = 2;
const MEDIUM = 3;

async function world() {
  const db = freshDb();
  const store = sqliteStoreFor(db);
  await registerProject(store, { name: "alpha", kind: "side" });
  await registerProject(store, { name: "beta", kind: "side" });
  // Items are made inside one millisecond, so their updated_at would tie and the "newest first" order would
  // fall to the id. Stamp each a distinct, increasing time so the unranked order is the same on every run.
  let n = 0;
  const mk = async (title: string, project: string, priority: number | null) => {
    const id = await createItem(store, { type: "task", title, projectId: project, priority });
    const at = `2026-01-01T00:00:${String(++n).padStart(2, "0")}.000Z`;
    await store.q.update(store.t.item).set({ updated_at: at, created_at: at }).where(eq(store.t.item.id, id));
    return id;
  };
  return { db, store, mk };
}

async function queue(store: ReturnType<typeof sqliteStoreFor>, project: string): Promise<string[]> {
  const { items } = await nextWorklist(store, { project });
  return items.map((i) => i.title);
}

describe("sort (OB-2083)", () => {
  test("inside a band, ranked items come first ascending, then unranked by recency", async () => {
    const { store, mk } = await world();
    const a = await mk("a", "alpha", MEDIUM);
    const b = await mk("b", "alpha", MEDIUM);
    const c = await mk("c", "alpha", MEDIUM);
    const d = await mk("d", "alpha", MEDIUM);
    await store.q.update(store.t.item).set({ queue_rank: 2 }).where(eq(store.t.item.id, a));
    await store.q.update(store.t.item).set({ queue_rank: 1 }).where(eq(store.t.item.id, c));
    // d was touched last, so among the unranked it comes before b.
    await appendNote(store, d, "touched");
    expect(await queue(store, "alpha")).toEqual(["c", "a", "d", "b"]);
    void b;
  });

  test("a note or edit on a ranked item no longer moves it, while an unranked one jumps to the top of the band", async () => {
    const { store, mk } = await world();
    const a = await mk("a", "alpha", MEDIUM);
    const b = await mk("b", "alpha", MEDIUM);
    await mk("c", "alpha", MEDIUM);
    await setQueueOrder(store, a, { top: true });
    await setQueueOrder(store, b, { after: a });
    expect(await queue(store, "alpha")).toEqual(["a", "b", "c"]);
    await appendNote(store, b, "a fresh note");
    await editItem(store, b, { title: "b renamed" });
    expect(await queue(store, "alpha")).toEqual(["a", "b renamed", "c"]);
  });

  test("the band still decides first: a ranked medium item stays below an unranked high one", async () => {
    const { store, mk } = await world();
    const m = await mk("medium", "alpha", MEDIUM);
    await mk("high", "alpha", HIGH);
    await setQueueOrder(store, m, { top: true });
    expect(await queue(store, "alpha")).toEqual(["high", "medium"]);
  });

  test("sortWorklist is total: equal ranks fall to recency then id", async () => {
    const { store, mk } = await world();
    await mk("x", "alpha", MEDIUM);
    await mk("y", "alpha", MEDIUM);
    const { items } = await nextWorklist(store);
    const again = sortWorklist([...items].reverse(), null);
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });
});

describe("setQueueOrder (OB-2083)", () => {
  test("--top makes the item first of its band and keeps its priority", async () => {
    const { store, mk } = await world();
    await mk("a", "alpha", MEDIUM);
    await mk("b", "alpha", MEDIUM);
    const c = await mk("c", "alpha", MEDIUM);
    const res = await setQueueOrder(store, c, { top: true });
    expect(res).toMatchObject({ id: c, priority: MEDIUM, priorityChanged: false, rank: 1 });
    expect(await queue(store, "alpha")).toEqual(["c", "b", "a"]);
    expect((await getItem(store, c))!.priority).toBe(MEDIUM);
    // The band is numbered 1..n.
    const ranks = (await nextWorklist(store, { project: "alpha" })).items.map((i) => i.queue_rank);
    expect(ranks).toEqual([1, 2, 3]);
  });

  test("--before and --after place it right next to the target", async () => {
    const { store, mk } = await world();
    const a = await mk("a", "alpha", MEDIUM);
    const b = await mk("b", "alpha", MEDIUM);
    const c = await mk("c", "alpha", MEDIUM);
    const d = await mk("d", "alpha", MEDIUM);
    await setQueueOrder(store, a, { top: true });
    await setQueueOrder(store, b, { after: a });
    await setQueueOrder(store, c, { after: b });
    await setQueueOrder(store, d, { after: c });
    expect(await queue(store, "alpha")).toEqual(["a", "b", "c", "d"]);
    await setQueueOrder(store, d, { before: b });
    expect(await queue(store, "alpha")).toEqual(["a", "d", "b", "c"]);
    await setQueueOrder(store, a, { after: c });
    expect(await queue(store, "alpha")).toEqual(["d", "b", "c", "a"]);
  });

  test("a move across a band sets the priority and lands at the right index", async () => {
    const { store, mk } = await world();
    const h1 = await mk("h1", "alpha", HIGH);
    const h2 = await mk("h2", "alpha", HIGH);
    const m = await mk("m", "alpha", MEDIUM);
    await setQueueOrder(store, h1, { top: true });
    await setQueueOrder(store, h2, { after: h1 });
    const res = await setQueueOrder(store, m, { before: h2 });
    expect(res).toMatchObject({ priority: HIGH, priorityChanged: true, rank: 2 });
    expect((await getItem(store, m))!.priority).toBe(HIGH);
    expect(await queue(store, "alpha")).toEqual(["h1", "m", "h2"]);
    // The band it left is untouched (empty here); the band it joined is renumbered 1..3.
    expect((await nextWorklist(store, { project: "alpha" })).items.map((i) => i.queue_rank)).toEqual([1, 2, 3]);
  });

  test("the other bands keep their ranks when one band is renumbered", async () => {
    const { store, mk } = await world();
    const m1 = await mk("m1", "alpha", MEDIUM);
    const m2 = await mk("m2", "alpha", MEDIUM);
    const h1 = await mk("h1", "alpha", HIGH);
    await setQueueOrder(store, m1, { top: true });
    await setQueueOrder(store, m2, { top: true });
    const before = (await getItem(store, m1))!.queue_rank;
    await setQueueOrder(store, h1, { top: true });
    expect((await getItem(store, m1))!.queue_rank).toBe(before);
  });

  test("--top --priority takes the band first", async () => {
    const { store, mk } = await world();
    await mk("h", "alpha", HIGH);
    const m = await mk("m", "alpha", MEDIUM);
    const res = await setQueueOrder(store, m, { top: true, priority: HIGH });
    expect(res).toMatchObject({ priority: HIGH, priorityChanged: true, rank: 1 });
    expect(await queue(store, "alpha")).toEqual(["m", "h"]);
  });

  test("--top --priority into an EMPTY band: the item takes that priority explicitly and is first in the band", async () => {
    const { store, mk } = await world();
    const m = await mk("m", "alpha", MEDIUM);
    const low = await mk("low", "alpha", 4);
    await mk("m2", "alpha", MEDIUM);
    // Nothing is urgent, so that band is empty.
    const URGENT = 1;
    const res = await setQueueOrder(store, m, { top: true, priority: URGENT });
    expect(res).toMatchObject({ priority: URGENT, priorityChanged: true, rank: 1 });
    expect((await getItem(store, m))!.priority).toBe(URGENT);
    expect((await nextWorklist(store, { project: "alpha" })).items[0]!.title).toBe("m");
    // The same into an empty band for an item with no priority at all, outside the focus project.
    const none = await mk("none", "alpha", null);
    const res2 = await setQueueOrder(store, none, { top: true, priority: HIGH });
    expect(res2).toMatchObject({ priority: HIGH, priorityChanged: true, rank: 1 });
    expect((await getItem(store, none))!.priority).toBe(HIGH);
    expect(await queue(store, "alpha")).toEqual(["m", "none", "m2", "low"]);
  });

  test("an unset item in the focus project sits in the high band, and moving it there leaves it unset", async () => {
    const { store, mk } = await world();
    await setConfig(store, "focus_project", "alpha");
    const unset = await mk("unset", "alpha", null);
    const high = await mk("high", "alpha", HIGH);
    const medium = await mk("medium", "alpha", MEDIUM);
    expect((await queue(store, "alpha"))[2]).toBe("medium");
    const res = await setQueueOrder(store, unset, { after: high });
    expect(res).toMatchObject({ priority: HIGH, priorityChanged: false });
    expect((await getItem(store, unset))!.priority).toBeNull();
    expect(await queue(store, "alpha")).toEqual(["high", "unset", "medium"]);
    await setQueueOrder(store, unset, { top: true });
    expect((await getItem(store, unset))!.priority).toBeNull();
    expect(await queue(store, "alpha")).toEqual(["unset", "high", "medium"]);
    void medium;
  });

  test("--top --priority high on an unset item in the focus project writes the priority; a plain move never does", async () => {
    const { store, mk } = await world();
    await setConfig(store, "focus_project", "alpha");
    const unset = await mk("unset", "alpha", null);
    const res = await setQueueOrder(store, unset, { top: true, priority: HIGH });
    expect(res).toMatchObject({ priority: HIGH, priorityChanged: true });
    expect((await getItem(store, unset))!.priority).toBe(HIGH);
  });

  test("neighbours that shift a place keep their updated_at; only the moved item is stamped", async () => {
    const { store, mk } = await world();
    const a = await mk("a", "alpha", MEDIUM);
    const b = await mk("b", "alpha", MEDIUM);
    const c = await mk("c", "alpha", MEDIUM);
    const stamps = async () => Promise.all([a, b, c].map(async (i) => (await getItem(store, i))!.updated_at));
    const before = await stamps();
    await setQueueOrder(store, c, { top: true });
    const after = await stamps();
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect((await getItem(store, a))!.queue_rank).not.toBeNull();
  });

  test("an archived roadmap or an accepted decision is closed: it cannot be ordered or be a target", async () => {
    const { store, mk } = await world();
    const a = await mk("a", "alpha", MEDIUM);
    const road = await createItem(store, { type: "roadmap", title: "road", projectId: "alpha" });
    await store.q.update(store.t.item).set({ status: "archived" }).where(eq(store.t.item.id, road));
    await expect(setQueueOrder(store, road, { top: true })).rejects.toThrow(/not open/);
    await expect(setQueueOrder(store, a, { after: road })).rejects.toThrow(/not open/);
  });

  test("a bare number that names two different items is refused before the write", async () => {
    const { store, mk } = await world();
    const one = await mk("one", "alpha", MEDIUM);
    const two = await mk("two", "alpha", MEDIUM);
    // Bare `1` is the internal id of item one AND the key OB-1 of item two (the drift OB-1751 guards).
    await store.q.insert(store.t.itemRef).values({ ref: "OB-1", item_id: two, created_at: "2026-01-01T00:00:00.000Z" });
    expect(one).toBe("1");
    const handlerErr = await orderHandler(store, "1", { top: true }).catch((e) => e);
    expect(String(handlerErr.message)).toMatch(/ambiguous/);
    expect((await getItem(store, one))!.queue_rank).toBeNull();
    const targetErr = await orderHandler(store, two, { before: "1" }).catch((e) => e);
    expect(String(targetErr.message)).toMatch(/ambiguous/);
    expect((await getItem(store, two))!.queue_rank).toBeNull();
  });

  test("a target in another project, a closed target, a closed item and a self-target are refused and change nothing", async () => {
    const { store, mk } = await world();
    const a = await mk("a", "alpha", MEDIUM);
    const other = await mk("other", "beta", MEDIUM);
    const closed = await mk("closed", "alpha", MEDIUM);
    await transitionTo(store, closed, "done");
    await setQueueOrder(store, a, { top: true });
    const snapshot = async () => JSON.stringify((await nextWorklist(store)).items.map((i) => [i.id, i.priority, i.queue_rank]));
    const before = await snapshot();
    await expect(setQueueOrder(store, a, { before: other })).rejects.toThrow(/not alpha|per project/);
    await expect(setQueueOrder(store, a, { after: closed })).rejects.toThrow(/not open/);
    await expect(setQueueOrder(store, closed, { top: true })).rejects.toThrow(/not open/);
    await expect(setQueueOrder(store, a, { after: a })).rejects.toThrow(/itself/);
    await expect(setQueueOrder(store, a, { before: "999999" })).rejects.toThrow(/no item/);
    expect(await snapshot()).toBe(before);
  });

  test("closing and reopening leaves the rank, so a reopened item comes back to its place", async () => {
    const { store, mk } = await world();
    const a = await mk("a", "alpha", MEDIUM);
    const b = await mk("b", "alpha", MEDIUM);
    await setQueueOrder(store, a, { top: true });
    await setQueueOrder(store, b, { after: a });
    await transitionTo(store, a, "done");
    expect((await getItem(store, a))!.queue_rank).toBe(1);
    await transitionTo(store, a, "open");
    expect(await queue(store, "alpha")).toEqual(["a", "b"]);
  });

  test("an order leaves every today_rank as it was", async () => {
    const { store, mk } = await world();
    const a = await mk("a", "alpha", MEDIUM);
    const b = await mk("b", "alpha", MEDIUM);
    await mk("c", "alpha", MEDIUM);
    await setTodayRank(store, a, 2);
    await setTodayRank(store, b, 1);
    const todays = async () => (await nextWorklist(store)).items.map((i) => [i.id, i.today_rank]).sort();
    const before = await todays();
    await setQueueOrder(store, b, { top: true });
    await setQueueOrder(store, a, { after: b });
    expect(await todays()).toEqual(before);
    // Today still leads `ob next`: b (1), a (2), then the rest.
    expect((await nextWorklist(store)).items.slice(0, 2).map((i) => i.title)).toEqual(["b", "a"]);
  });
});

describe("ob next --project (OB-2083)", () => {
  test("returns only that project, in queue order; an unknown project is an error", async () => {
    const { store, mk } = await world();
    const a1 = await mk("a1", "alpha", MEDIUM);
    await mk("a2", "alpha", MEDIUM);
    await mk("b1", "beta", HIGH);
    await setQueueOrder(store, a1, { top: true });
    expect(await queue(store, "alpha")).toEqual(["a1", "a2"]);
    expect(await queue(store, "beta")).toEqual(["b1"]);
    await expect(nextWorklist(store, { project: "nope" })).rejects.toThrow(/no project 'nope'/);
    // An empty --project (an unset shell variable) is an error, never the whole worklist.
    await expect(nextWorklist(store, { project: "" })).rejects.toThrow(/no project ''/);
  });
});

describe("ob order, end to end (OB-2083)", () => {
  test("the command orders, ob next --project shows it first, ob show prints the rank", async () => {
    const path = freshDbPath();
    try {
      await runCli(path, ["project", "add", "alpha", "--kind", "side"]);
      const add = async (title: string, prio: string) => {
        const r = await runCli(path, ["add", title, "--project", "alpha", "--priority", prio, "-q"]);
        return r.out.trim();
      };
      const a = await add("first thing", "medium");
      const b = await add("second thing", "medium");
      const h = await add("urgent-ish thing", "high");
      const r = await runCli(path, ["order", b, "--top"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("queue rank 1 in medium");
      const next = await runCli(path, ["next", "--project", "alpha", "--json"]);
      expect(JSON.parse(next.out).map((i: { title: string }) => i.title)).toEqual(["urgent-ish thing", "second thing", "first thing"]);
      const cross = await runCli(path, ["order", a, "--before", h]);
      expect(cross.out).toContain("(priority changed)");
      const show = await runCli(path, ["show", a]);
      expect(show.out).toContain("priority:  high (explicit)");
      expect(show.out).toContain("queue:     rank 1");
      // --top --priority into a band nothing is in yet (low): explicit priority, first in that band.
      const toLow = await runCli(path, ["order", h, "--top", "--priority", "low"]);
      expect(toLow.out).toContain("queue rank 1 in low (priority changed)");
      expect((await runCli(path, ["show", h])).out).toContain("priority:  low (explicit)");
      const bad = await runCli(path, ["order", a]);
      expect(bad.code).not.toBe(0);
      const emptyPrio = await runCli(path, ["order", a, "--top", "--priority", ""]);
      expect(emptyPrio.code).not.toBe(0);
      expect((await runCli(path, ["show", a])).out).toContain("priority:  high (explicit)");
      const emptyProject = await runCli(path, ["next", "--project", ""]);
      expect(emptyProject.code).not.toBe(0);
      const bad2 = await runCli(path, ["order", a, "--top", "--before", b]);
      expect(bad2.code).not.toBe(0);
      expect(bad2.err).toContain("exactly one");
    } finally {
      if (existsSync(path)) rmSync(path, { force: true });
    }
  });
});

describe("POST /items/:id/order (OB-2083)", () => {
  test("the handler orders and answers the fresh detail with queue_rank and what the move did", async () => {
    const { store, mk } = await world();
    const a = await mk("a", "alpha", MEDIUM);
    const h = await mk("h", "alpha", HIGH);
    const res = await orderHandler(store, a, { before: h });
    expect(res.order).toEqual({ priority: "high", priority_changed: true, rank: 1 });
    expect(res.item.queue_rank).toBe(1);
    expect(res.item.priority).toBe("high");
    await expect(orderHandler(store, a, {})).rejects.toThrow(/exactly one/);
    await expect(orderHandler(store, a, { before: h, priority: "high" })).rejects.toThrow(/goes with 'top'/);
    await expect(orderHandler(store, a, { top: true, priority: "" })).rejects.toThrow(/must be one of/);
    await expect(orderHandler(store, a, { top: true, priority: "soonish" })).rejects.toThrow(/must be one of/);
    expect((await getItem(store, a))!.priority).toBe(HIGH);
  });

  test("the route takes { top: true, priority } for a drop onto an empty band, and refuses a bad priority", async () => {
    const { store, mk } = await world();
    const m = await mk("m", "alpha", MEDIUM);
    const api = createObApi({
      store: async () => store,
      token: () => ({ token: "t".repeat(24), path: "/nowhere", reason: null, message: null }),
    });
    const post = async (id: string, body: unknown) => {
      const res = await api(
        new Request(`http://ob.local${OB_API_PREFIX}/items/${id}/order`, {
          method: "POST",
          headers: { authorization: `Bearer ${"t".repeat(24)}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return { status: res.status, body: JSON.parse(await res.text()) };
    };
    const ok = await post(m, { top: true, priority: "urgent" });
    expect(ok.status).toBe(200);
    expect(ok.body.order).toEqual({ priority: "urgent", priority_changed: true, rank: 1 });
    expect(ok.body.item.priority).toBe("urgent");
    expect(ok.body.item.queue_rank).toBe(1);
    expect((await getItem(store, m))!.priority).toBe(1);
    const bad = await post(m, { top: true, priority: "soonish" });
    expect(bad.status).toBe(400);
    expect((await getItem(store, m))!.priority).toBe(1);
  });

  test("the client half sends the move and renders the answer (API mode)", async () => {
    const calls: ApiRequest[] = [];
    const transport: ApiTransport = async (req) => {
      calls.push(req);
      return {
        status: 200,
        body: JSON.stringify({
          item: { id: "7", ref: "OB-7", queue_rank: 2, priority: "high" },
          order: { priority: "high", priority_changed: true, rank: 2 },
        }),
      };
    };
    const r = await runCli(freshDbPath(), ["order", "OB-7", "--after", "OB-3"], {
      api: { base: "https://ob.example.test", token: "t".repeat(24), transport },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("OB-7  queue rank 2 in high (priority changed)");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe(`https://ob.example.test${OB_API_PREFIX}/items/OB-7/order`);
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ after: "OB-3" });
    const top = await runCli(freshDbPath(), ["order", "OB-7", "--top", "--priority", "high"], {
      api: { base: "https://ob.example.test", token: "t".repeat(24), transport },
    });
    expect(top.code).toBe(0);
    expect(JSON.parse(calls[1]!.body as string)).toEqual({ top: true, priority: "high" });
    const next = await runCli(freshDbPath(), ["next", "--project", "alpha"], {
      api: { base: "https://ob.example.test", token: "t".repeat(24), transport },
    });
    expect(calls[2]!.url).toBe(`https://ob.example.test${OB_API_PREFIX}/next?project=alpha`);
    void next;
  });
});

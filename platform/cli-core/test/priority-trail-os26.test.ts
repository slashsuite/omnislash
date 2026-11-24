// OS-26: a change to an item's stored priority leaves one `priority_change` event on the Decisions trail
// (from, to, actor, note), a no-op writes nothing, and `ob block --owner` keeps the owner on the blocked
// transition. The readers that filter on `transition` (lastBlockedFrom, the spinoff-check scans) never see a
// priority row. In-memory / temp sqlite, the real API handlers over a faked socket, no network.
import { afterEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { rmSync } from "node:fs";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openStore, sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { createItem, editItem, getItem } from "../../../apps/cli/src/items.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { DECISION_TYPE, decisionsForItem, PRIORITY_CHANGE_TYPE } from "../../../apps/cli/src/decisions.ts";
import { eventsForItemFor, parsePayload } from "../../../apps/cli/src/events.ts";
import { blockItem, setQueueOrder, startItem, unblockItem } from "../../../apps/cli/src/workflow.ts";
import { itemDetail } from "../../../apps/cli/src/detail.ts";
import { renderItemDetail } from "../../../apps/cli/src/api/render.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";
const URGENT = 1;
const HIGH = 2;
const MEDIUM = 3;

const paths: string[] = [];
function scratch(): string {
  const p = freshDbPath();
  paths.push(p);
  return p;
}
afterEach(() => {
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});

async function priorityRows(store: Store, id: string) {
  const rows = await eventsForItemFor(store, id, 50, { source: "ob", type: PRIORITY_CHANGE_TYPE });
  return rows.map((r): Record<string, unknown> => ({ actor: r.actor, ...parsePayload<Record<string, unknown>>(r) }));
}

describe("editItem records a priority change (OS-26)", () => {
  test("one event when the stored value differs, none for a no-op or for the priority set at create", async () => {
    const store = sqliteStoreFor(freshDb());
    const id = await createItem(store, { type: "task", title: "p", priority: MEDIUM });
    expect(await priorityRows(store, id)).toEqual([]);

    await editItem(store, id, { priority: MEDIUM }, { actor: "nobody" });
    await editItem(store, id, { title: "renamed" });
    expect(await priorityRows(store, id)).toEqual([]);

    await editItem(store, id, { priority: URGENT }, { actor: "architect-x", note: "prod is down" });
    expect(await priorityRows(store, id)).toEqual([{ actor: "architect-x", from: "medium", to: "urgent", note: "prod is down" }]);
  });

  test("clearing to unset records a change to none; no actor is a human", async () => {
    const store = sqliteStoreFor(freshDb());
    const id = await createItem(store, { type: "task", title: "p", priority: HIGH });
    await editItem(store, id, { priority: null });
    expect(await priorityRows(store, id)).toEqual([{ actor: "human", from: "high", to: "none" }]);
    expect((await getItem(store, id))!.priority).toBeNull();
  });

  test("unset to none (0) and back are named so the line is never none → none", async () => {
    const store = sqliteStoreFor(freshDb());
    const id = await createItem(store, { type: "task", title: "p", priority: null });
    await editItem(store, id, { priority: 0 });
    await editItem(store, id, { priority: null });
    expect(await priorityRows(store, id)).toEqual([
      { actor: "human", from: "none", to: "unset" },
      { actor: "human", from: "unset", to: "none" },
    ]);
  });

  test("the update and the event share a transaction: a failing write leaves neither", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const id = await createItem(store, { type: "task", title: "p", priority: MEDIUM });
    db.exec(`CREATE TRIGGER no_pc BEFORE INSERT ON event WHEN NEW.type = 'priority_change' BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    await expect(editItem(store, id, { priority: HIGH })).rejects.toThrow("refused");
    expect((await getItem(store, id))!.priority).toBe(MEDIUM);
  });
});

describe("ob edit --priority and ob order (OS-26)", () => {
  test("ob edit --priority --note --holder leaves exactly one event; repeating it leaves none", async () => {
    const dbPath = scratch();
    const store = await openStore({ kind: "sqlite", path: dbPath, create: true });
    try {
      const id = await createItem(store, { type: "task", title: "edit me", priority: MEDIUM });
      const r = await runCli(dbPath, ["edit", id, "--priority", "high", "--note", "Jacobus asked", "--holder", "architect-os"]);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(await runCli(dbPath, ["edit", id, "--priority", "high"])).toMatchObject({ code: 0 });
      expect(await priorityRows(store, id)).toEqual([{ actor: "architect-os", from: "medium", to: "high", note: "Jacobus asked" }]);

      const shown = await runCli(dbPath, ["show", id]);
      expect(shown.out).toContain("Decisions:");
      expect(shown.out).toContain("architect-os · priority medium → high · Jacobus asked");
    } finally {
      await store.close();
    }
  });

  test("ob order across a band records the band move once; a same-band move records nothing", async () => {
    const dbPath = scratch();
    const store = await openStore({ kind: "sqlite", path: dbPath, create: true });
    try {
      await registerProject(store, { name: "alpha", kind: "side" });
      const a = await createItem(store, { type: "task", title: "a", projectId: "alpha", priority: MEDIUM });
      const b = await createItem(store, { type: "task", title: "b", projectId: "alpha", priority: MEDIUM });
      const h = await createItem(store, { type: "task", title: "h", projectId: "alpha", priority: HIGH });

      expect(await runCli(dbPath, ["order", a, "--before", b])).toMatchObject({ code: 0 });
      expect(await priorityRows(store, a)).toEqual([]);

      const r = await runCli(dbPath, ["order", a, "--after", h, "--holder", "architect-os", "--note", "up a band"]);
      expect(r.err).toBe("");
      expect(await priorityRows(store, a)).toEqual([{ actor: "architect-os", from: "medium", to: "high", note: "up a band" }]);
    } finally {
      await store.close();
    }
  });

  test("ob order --top --priority on an unset focus item writes the band and records unset → high", async () => {
    const store = sqliteStoreFor(freshDb());
    await registerProject(store, { name: "alpha", kind: "side" });
    await setConfig(store, "focus_project", "alpha");
    const id = await createItem(store, { type: "task", title: "u", projectId: "alpha", priority: null });
    await setQueueOrder(store, id, { top: true, priority: HIGH }, { actor: "dashboard" });
    expect(await priorityRows(store, id)).toEqual([{ actor: "dashboard", from: "none", to: "high" }]);
  });
});

describe("over the API (OS-26)", () => {
  test("ob edit and ob order carry --note and --holder onto the trail, and the API render shows it", async () => {
    const path = scratch();
    const store = await openStore({ kind: "sqlite", path, create: true });
    const server = createObApi({
      store: async () => store,
      token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    });
    const wire: ApiTransport = async (req: ApiRequest) => {
      const res = await server(new Request(req.url, { method: req.method, headers: req.headers, ...(req.body === undefined ? {} : { body: req.body }) }));
      return { status: res.status, body: await res.text() };
    };
    const opts = { api: { base: BASE, token: TOKEN, transport: wire } };
    try {
      await registerProject(store, { name: "alpha", kind: "side" });
      const id = await createItem(store, { type: "task", title: "remote", projectId: "alpha", priority: MEDIUM });
      const u = await createItem(store, { type: "task", title: "u", projectId: "alpha", priority: URGENT });
      const edited = await runCli(scratch(), ["edit", id, "--priority", "low", "-m", "parked", "--holder", "architect-api"], opts);
      expect(edited.err).toBe("");
      const ordered = await runCli(scratch(), ["order", id, "--before", u, "--holder", "architect-api"], opts);
      expect(ordered.err).toBe("");
      expect(await priorityRows(store, id)).toEqual([
        { actor: "architect-api", from: "low", to: "urgent" },
        { actor: "architect-api", from: "medium", to: "low", note: "parked" },
      ]);

      const detail = await itemDetail(store, id);
      const rendered = renderItemDetail(JSON.parse(JSON.stringify(detail)), "human");
      expect(rendered).toContain("architect-api · priority medium → low · parked");
      expect(rendered).toContain("architect-api · priority low → urgent");
    } finally {
      await store.close();
    }
  });
});

describe("block owner and the transition readers (OS-26)", () => {
  test("ob block --owner stores the owner in the blocked transition payload", async () => {
    const dbPath = scratch();
    const store = await openStore({ kind: "sqlite", path: dbPath, create: true });
    try {
      const id = await createItem(store, { type: "task", title: "b" });
      const r = await runCli(dbPath, ["block", id, "--reason", "needs a key", "--owner", "jacobus"]);
      expect(r.err).toBe("");
      const rows = await eventsForItemFor(store, id, 50, { source: "ob", type: DECISION_TYPE });
      expect(parsePayload(rows[0]!)).toMatchObject({ from: "open", to: "blocked", block_owner: "jacobus", note: "needs a key" });

      const plain = await createItem(store, { type: "task", title: "no owner" });
      await blockItem(store, plain, "waiting", null);
      const plainRows = await eventsForItemFor(store, plain, 50, { source: "ob", type: DECISION_TYPE });
      expect(parsePayload(plainRows[0]!)).not.toHaveProperty("block_owner");
    } finally {
      await store.close();
    }
  });

  test("unblock still returns to the status before the block when priority changes sit on the trail", async () => {
    const store = sqliteStoreFor(freshDb());
    const id = await createItem(store, { type: "task", title: "b", priority: MEDIUM });
    await startItem(store, id);
    await blockItem(store, id, "waiting", "jacobus");
    await editItem(store, id, { priority: HIGH });
    await unblockItem(store, id);
    expect((await getItem(store, id))!.status).toBe("in_progress");

    const trail = await decisionsForItem(store, id);
    expect(trail.map((d) => `${d.kind}:${d.from}→${d.to}`)).toEqual([
      "transition:blocked→in_progress",
      "priority:medium→high",
      "transition:in_progress→blocked",
      "transition:open→in_progress",
    ]);
    // The transition-only readers never see the priority row.
    const transitions = await eventsForItemFor(store, id, 50, { source: "ob", type: DECISION_TYPE });
    expect(transitions).toHaveLength(3);
    const pc = await store.q.select().from(store.t.event).where(and(eq(store.t.event.item_id, id), eq(store.t.event.type, PRIORITY_CHANGE_TYPE)));
    expect(pc).toHaveLength(1);
  });
});

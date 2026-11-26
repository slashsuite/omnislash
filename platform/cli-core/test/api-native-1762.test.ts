// OB-1762 (OB-1760 phase 0a) -- the ob API endpoints the native app's Today screen, item sheet and Alerts
// screen need: snapshot, item transition / rank, alert ack + snooze, agenda. Real Postgres via the 325
// harness, no network (GitHub sync is skipped with `github: false`), no live DB.
import { describe, expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { saDayBounds } from "../../cli-sources/src/sa-time.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX, OB_API_ROUTES } from "../../../apps/cli/src/api/contract.ts";
import { eq } from "drizzle-orm";
import { createItem } from "../../../apps/cli/src/items.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

const TOKEN = "a-test-bearer-token-that-is-long-enough";
const README = cliDocs();

interface Ctx {
  store: Store;
  call: (path: string, opts?: { method?: string; body?: unknown; token?: string | null }) => Promise<{ status: number; body: any }>;
}

async function withApi(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const call: Ctx["call"] = async (path, opts = {}) => {
    const token = opts.token === undefined ? TOKEN : opts.token;
    const res = await api(
      new Request(`http://api-host.local${OB_API_PREFIX}${path}`, {
        method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
  };
  try {
    await fn({ store, call });
  } finally {
    await store.close();
    await lease.release();
  }
}

const NEW_PATHS = [
  "/api/ob/snapshot",
  "/api/ob/items/:id/transition",
  "/api/ob/items/:id/rank",
  "/api/ob/alerts/ack",
];

describe("contract + docs (1762)", () => {
  test("the new routes are served-surface entries and documented in the README", () => {
    for (const p of NEW_PATHS) {
      expect(OB_API_ROUTES.some((r) => `${OB_API_PREFIX}${r.path}` === p)).toBe(true);
      expect(README).toContain(p);
    }
  });
});

describe("auth (1762)", () => {
  test("every new route refuses a missing or wrong token", async () => {
    await withApi(async ({ call }) => {
      for (const [method, path, body] of [
        ["GET", "/snapshot", undefined],
        ["POST", "/items/1/transition", { action: "start" }],
        ["POST", "/items/1/rank", { rank: 1 }],
        ["POST", "/alerts/ack", { key: "x" }],
      ] as const) {
        expect((await call(path, { method, body, token: null })).status).toBe(401);
        expect((await call(path, { method, body, token: "wrong" })).status).toBe(401);
      }
    });
  });
});

describe("GET /snapshot (1762)", () => {
  test("answers the dashboard snapshot, with an item that has been ranked into Today", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "ship the native app" });
      await call(`/items/${id}/rank`, { body: { rank: 1 } });
      const res = await call("/snapshot");
      expect(res.status).toBe(200);
      const snap = res.body.snapshot;
      expect(snap).toBeDefined();
      expect(typeof snap.alertCount).toBe("number");
      expect(JSON.stringify(snap)).toContain("ship the native app");
    });
  });
});

describe("POST /items/:id/transition (1762)", () => {
  test("start -> ready -> block (reason) -> unblock, each answering the fresh item", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "walk the loop" });
      const started = await call(`/items/${id}/transition`, { body: { action: "start" } });
      expect(started.status).toBe(200);
      expect(started.body.item.status).toBe("in_progress");
      expect(started.body.tracker).toBeUndefined();

      const noReason = await call(`/items/${id}/transition`, { body: { action: "block" } });
      expect(noReason.status).toBe(400);

      const blocked = await call(`/items/${id}/transition`, { body: { action: "block", reason: "waiting on the keys" } });
      expect(blocked.status).toBe(200);
      expect(blocked.body.item.status).toBe("blocked");

      const unblocked = await call(`/items/${id}/transition`, { body: { action: "unblock" } });
      expect(unblocked.status).toBe(200);
      expect(unblocked.body.item.status).not.toBe("blocked");

      const ready = await call(`/items/${id}/transition`, { body: { action: "ready" } });
      expect(ready.status).toBe(200);
      expect(ready.body.item.status).toBe("ready");
    });
  });

  test("close and reopen answer the item plus the tracker outcome (github: false skips the mirror)", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "close me" });
      const closed = await call(`/items/${id}/transition`, { body: { action: "close", github: false, note: "done" } });
      expect(closed.status).toBe(200);
      expect(closed.body.item.status).toBe("done");
      expect(closed.body.tracker).toEqual(expect.objectContaining({ id, status: "done" }));
      const reopened = await call(`/items/${id}/transition`, { body: { action: "reopen", github: false } });
      expect(reopened.status).toBe(200);
      expect(reopened.body.item.status).not.toBe("done");
      expect(reopened.body.tracker).toBeDefined();
    });
  });

  test("refuses an unknown action (400), an unknown item (404) and an illegal move", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "bad moves" });
      expect((await call(`/items/${id}/transition`, { body: { action: "explode" } })).status).toBe(400);
      expect((await call(`/items/${id}/transition`, { body: {} })).status).toBe(400);
      expect((await call("/items/9999/transition", { body: { action: "start" } })).status).toBe(404);
      // unblock an item that is not blocked
      const illegal = await call(`/items/${id}/transition`, { body: { action: "unblock" } });
      expect(illegal.status).toBeGreaterThanOrEqual(400);
      expect(illegal.status).toBeLessThan(500);
    });
  });
});

describe("POST /items/:id/rank (1762)", () => {
  test("an explicit rank, the next slot, and clear", async () => {
    await withApi(async ({ store, call }) => {
      const a = await createItem(store, { type: "task", title: "first" });
      const b = await createItem(store, { type: "task", title: "second" });
      const ra = await call(`/items/${a}/rank`, { body: { rank: 3 } });
      expect(ra.status).toBe(200);
      expect(ra.body.item.id).toBe(a);
      const rb = await call(`/items/${b}/rank`, { body: {} });
      expect(rb.status).toBe(200);
      const before = JSON.stringify((await call("/snapshot")).body.snapshot);
      expect(before).toContain("second");
      const cleared = await call(`/items/${a}/rank`, { body: { clear: true } });
      expect(cleared.status).toBe(200);
      expect(cleared.body.item.id).toBe(a);
    });
  });

  test("refuses a non-integer rank (400) and an unknown item (404)", async () => {
    await withApi(async ({ store, call }) => {
      const id = await createItem(store, { type: "task", title: "ranked" });
      expect((await call(`/items/${id}/rank`, { body: { rank: "top" } })).status).toBe(400);
      expect((await call(`/items/${id}/rank`, { body: { rank: 1.5 } })).status).toBe(400);
      expect((await call("/items/9999/rank", { body: { rank: 1 } })).status).toBe(404);
    });
  });
});

describe("alerts ack + snooze (1762)", () => {
  test("both answer the fresh alert list without the acted-on key; an unknown key is a 404", async () => {
    await withApi(async ({ store, call }) => {
      // Rule 4 (blocked, no movement): block two items, then age them past alert_blocked_days.
      const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
      for (const title of ["stuck thing", "other stuck thing"]) {
        const id = await createItem(store, { type: "task", title });
        await call(`/items/${id}/transition`, { body: { action: "block", reason: "needs a decision" } });
        await store.q.update(store.t.item).set({ updated_at: old }).where(eq(store.t.item.id, id));
      }
      const listed = await call("/alerts");
      expect(listed.status).toBe(200);
      const keys: string[] = listed.body.alerts.map((a: { key: string }) => a.key);
      expect(keys.length).toBe(2);

      const acked = await call("/alerts/ack", { body: { key: keys[0] } });
      expect(acked.status).toBe(200);
      expect(acked.body.acked).toBe(keys[0]);
      expect(acked.body.alerts.map((a: { key: string }) => a.key)).not.toContain(keys[0]);

      const snoozed = await call("/alerts/snooze", { body: { key: keys[1] } });
      expect(snoozed.status).toBe(200);
      expect(snoozed.body.snoozed).toBe(keys[1]);
      expect(snoozed.body.alerts).toEqual([]);

      expect((await call("/alerts/ack", { body: { key: "no-such-alert" } })).status).toBe(404);
      expect((await call("/alerts/ack", { body: {} })).status).toBe(400);
    });
  });
});

describe("GET /cal/agenda (1762)", () => {
  test("answers {events} from the stored calendar", async () => {
    await withApi(async ({ store, call }) => {
      setSystemTime(new Date("2026-11-05T23:00:00.000Z"));
      try {
        const today = saDayBounds(new Date()).to.slice(0, 10);
        await store.q.insert(store.t.calendarEvent).values([
          { id: "e1", calendar_id: "primary", summary: "Public holiday", start_ts: today, all_day: 1 },
        ]);
        const res = await call("/cal/agenda");
        expect(res.status).toBe(200);
        expect(res.body.events.map((e: { id: string }) => e.id)).toEqual(["e1"]);
      } finally {
        setSystemTime();
      }
    });
  });
});

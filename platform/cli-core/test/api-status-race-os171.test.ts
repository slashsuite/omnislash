// OS-171: a raced item status write over the API is a 409, on every item status route (close, reopen, and
// /state's start, block, unblock and set), with the item left where the refused transaction found it and no
// decision row written. The race is the `statusRaceSeam`, which moves the item after the door read it.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { statusRaceSeam } from "../../../apps/cli/src/workflow.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

const paths: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});

async function withApi(fn: (store: Store, call: (path: string, body: unknown) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const path = freshDbPath();
  paths.push(path);
  const store = await openStore({ kind: "sqlite", path, create: true });
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const call = async (p: string, body: unknown) => {
    const res = await api(
      new Request(`${BASE}${OB_API_PREFIX}${p}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
  };
  try {
    await fn(store, call);
  } finally {
    await store.close();
  }
}

/** Another writer moves the item to `racedTo` after the door read it. */
function race(racedTo: string): void {
  restores.push(
    statusRaceSeam.set(async (tx, id) => {
      await tx.q.update(tx.t.item).set({ status: racedTo }).where(eq(tx.t.item.id, id));
    }),
  );
}

const ROUTES: Array<{ name: string; start: string; path: (id: string) => string; body: unknown }> = [
  { name: "close", start: "in_progress", path: (id) => `/items/${id}/close`, body: { github: false } },
  { name: "reopen", start: "done", path: (id) => `/items/${id}/reopen`, body: { github: false } },
  { name: "state start", start: "open", path: (id) => `/items/${id}/state`, body: { action: "start" } },
  { name: "state block", start: "open", path: (id) => `/items/${id}/state`, body: { action: "block", reason: "waiting" } },
  { name: "state unblock", start: "blocked", path: (id) => `/items/${id}/state`, body: { action: "unblock" } },
  { name: "state set", start: "open", path: (id) => `/items/${id}/state`, body: { action: "set", status: "ready" } },
];

describe("a raced item status write over the API is a 409 (OS-171)", () => {
  for (const route of ROUTES) {
    test(route.name, async () => {
      await withApi(async (store, call) => {
        const id = await createItem(store, { type: "task", title: `${route.name} raced`, status: route.start });
        race("qa_raced");
        const res = await call(route.path(id), route.body);
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(JSON.stringify(res.body)).toContain("no longer");
        // SQLite: the racer wrote inside the refused transaction, so its write rolled back with it.
        expect((await getItem(store, id))?.status).toBe(route.start);
        expect(await decisionsForItem(store, id)).toEqual([]);
      });
    });
  }
});

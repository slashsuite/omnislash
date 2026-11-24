// OS-172: the item lifecycle machine is the item check, seen from the two doors a person uses. The CLI exits 1
// on a refused move (machine or guard) and 2 on a bad `--repair`; the API answers 409 `refused`. A repair
// writes `repair: <why>` on the trail. The item shadow is gone: a checked move writes no
// `machine_would_refuse` event. The engine-level cases (both SQLite and Postgres) are in
// platform/cli-db/test/item-machine-os172.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { openDb } from "../../../apps/cli/src/db.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { eventsBetweenFor } from "../../../apps/cli/src/events.ts";
import { MACHINE_SHADOW_SOURCE, MACHINE_WOULD_REFUSE } from "../../../apps/cli/src/machine-shadow.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

const paths: string[] = [];
afterEach(() => {
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});

function dbPath(): string {
  const p = freshDbPath();
  paths.push(p);
  openDb(p, { create: true }).close();
  return p;
}

async function withStore<T>(path: string, fn: (s: Store) => Promise<T>): Promise<T> {
  const s = await openStore({ kind: "sqlite", path });
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

describe("ob state refuses what the item machine refuses (OS-172)", () => {
  test("done -> blocked exits 1 with the machine's message and writes nothing", async () => {
    const p = dbPath();
    const id = await withStore(p, (s) => createItem(s, { type: "task", title: "finished", status: "done" }));
    const res = await runCli(p, ["state", id, "blocked", "--reason", "waiting"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("is done: 'to:blocked' is not a move from there");
    await withStore(p, async (s) => {
      expect((await getItem(s, id))?.status).toBe("done");
      expect(await decisionsForItem(s, id)).toEqual([]);
      // The machine is the check now, not a shadow beside it: no disagreement event.
      expect(await eventsBetweenFor(s, { source: MACHINE_SHADOW_SOURCE, type: MACHINE_WOULD_REFUSE })).toEqual([]);
    });
  });

  test("ob state <id> blocked with no reason is refused by the guard", async () => {
    const p = dbPath();
    const id = await withStore(p, (s) => createItem(s, { type: "task", title: "no reason" }));
    const res = await runCli(p, ["state", id, "blocked"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("a block needs a reason");
    await withStore(p, async (s) => expect((await getItem(s, id))?.status).toBe("open"));
  });

  test("--repair moves an unknown status to open, with repair: <why> on the trail", async () => {
    const p = dbPath();
    const id = await withStore(p, async (s) => {
      const id = await createItem(s, { type: "task", title: "legacy" });
      await s.q.update(s.t.item).set({ status: "qa" }).where(eq(s.t.item.id, id));
      return id;
    });
    const stuck = await runCli(p, ["state", id, "open"]);
    expect(stuck.code).toBe(1);
    expect(stuck.err).toContain("not a state of 'task'");

    expect((await runCli(p, ["state", id, "open", "--repair", "  "])).code).toBe(2);
    const toDone = await runCli(p, ["state", id, "done", "--repair", "why"]);
    expect(toDone.code).toBe(2);
    expect(toDone.err).toContain("repair to open, then close or block");
    expect((await runCli(p, ["state", id, "blocked", "--repair", "why"])).code).toBe(2);

    const res = await runCli(p, ["state", id, "open", "--repair", "legacy qa status"]);
    expect(res.code, res.err).toBe(0);
    await withStore(p, async (s) => {
      expect((await getItem(s, id))?.status).toBe("open");
      const trail = await decisionsForItem(s, id);
      expect(trail.map((d) => [d.from, d.to, d.note])).toEqual([["qa", "open", "repair: legacy qa status"]]);
    });
  });
});

describe("the API answers a refused item move with 409 (OS-172)", () => {
  test("machine and guard refusals over /state", async () => {
    const p = dbPath();
    const store = await openStore({ kind: "sqlite", path: p });
    try {
      const api = createObApi({
        store: async () => store,
        token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
      });
      const call = async (path: string, body: unknown) => {
        const res = await api(
          new Request(`${BASE}${OB_API_PREFIX}${path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
        return { status: res.status, body: JSON.parse(await res.text()) as Record<string, unknown> };
      };
      const done = await createItem(store, { type: "task", title: "done", status: "done" });
      const illegal = await call(`/items/${done}/state`, { action: "block", reason: "waiting" });
      expect(illegal.status).toBe(409);
      expect(JSON.stringify(illegal.body)).toContain("'to:blocked' is not a move from there");

      const open = await createItem(store, { type: "task", title: "open" });
      const guard = await call(`/items/${open}/state`, { action: "set", status: "blocked" });
      expect(guard.status).toBe(409);
      expect(JSON.stringify(guard.body)).toContain("a block needs a reason");
      expect((await getItem(store, open))?.status).toBe("open");
    } finally {
      await store.close();
    }
  });
});

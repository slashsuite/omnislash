import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { freshDb, freshDbPath, spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { createSidecar, REALTIME_WS_PATH, sameSnapshot, snapshotFrom, type Snapshot } from "../../../apps/cli/src/realtime.ts";
import { createItem, setBlocked } from "../../../apps/cli/src/items.ts";
import { machineStamp } from "../../../apps/ob-dashboard/src/lib/machine.ts";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

// Inject an empty wayfinder-frontier fetcher (221) so the snapshot never hits GitHub in tests.
const noFrontier = async () => [];

/** The sidecar on a loopback Bun.serve of its own, the way the app's server mounts it (OS-214). */
function serveSidecar(store: ReturnType<typeof sqliteStoreFor>) {
  const sidecar = createSidecar({ store, pollMs: 60_000 });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const res = await sidecar.fetch(req, (r) => srv.upgrade(r, { data: undefined }));
      return res ?? new Response("not found", { status: 404 });
    },
    websocket: sidecar.websocket,
  });
  return {
    port: server.port!,
    poll: sidecar.poll,
    stop() {
      sidecar.stop();
      void server.stop(true);
    },
  };
}

describe("realtime snapshot (083)", () => {
  test("snapshotFrom returns the three surfaces + a timestamp, reflecting DB state", async () => {
    const db = freshDb();
    const empty = await snapshotFrom(sqliteStoreFor(db), noFrontier);
    expect(empty.at).toBeTruthy();
    expect(empty.spinoffs).toEqual([]);
    expect(empty.agents).toEqual([]);

    // a queued spinoff should show up in the next snapshot (the change a push carries)
    db.query(
      `INSERT INTO spinoff(ticket_ref,repo,branch,worktree,mode,brief,status,request_at)
       VALUES('CUE-1','r','b','w','agent','x','pending','t')`,
    ).run();

    const after = await snapshotFrom(sqliteStoreFor(db), noFrontier);
    expect(after.spinoffs).toHaveLength(1);
    expect(after.spinoffs[0]!.ticket_ref).toBe("CUE-1");
  });

  test("carries the un-acked alertCount for the header bell (#45)", async () => {
    const db = freshDb();
    expect((await snapshotFrom(sqliteStoreFor(db), noFrontier)).alertCount).toBe(0);

    // A blocked, no-movement high-pri item raises one alert.
    const blocked = await createItem(db, { type: "task", title: "stuck", priority: 2 });
    await setBlocked(db, blocked, "open", "waiting", null);
    db.query("UPDATE item SET updated_at = ? WHERE id = ?").run(daysAgo(10), blocked);
    expect((await snapshotFrom(sqliteStoreFor(db), noFrontier)).alertCount).toBe(1);
  });
});

// ob 337: change detection is a POLL, not fs.watch on the database file.
//
// The failure being designed out is the quietest one available. fs.watch on a path nothing writes never
// fires AND never errors, so under Postgres the dashboard would have kept serving, kept its socket open,
// and silently stopped live-updating -- nobody files that as a bug, they refresh the page. The poll is
// driven directly here rather than waited on, so the test asserts the BEHAVIOUR (push only on change)
// instead of sleeping through an interval.
describe("the realtime sidecar pushes on change, not on a file event (337)", () => {
  test("a poll with nothing connected does nothing, and a poll with no change pushes nothing", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const rt = serveSidecar(sqliteStoreFor(db));
    try {
      // No client: the read is skipped entirely, which is what keeps a poll affordable on a dashboard
      // nobody is looking at.
      expect(await rt.poll()).toBe(false);

      const ws = new WebSocket(`ws://127.0.0.1:${rt.port}${REALTIME_WS_PATH}`);
      const first = await new Promise<string>((resolve, reject) => {
        ws.addEventListener("message", (e) => resolve(String(e.data)), { once: true });
        ws.addEventListener("error", () => reject(new Error("ws failed")), { once: true });
      });
      expect(JSON.parse(first).type).toBe("snapshot");

      // Connected, but nothing has moved. `at` is nowIso() on every read so the payloads are never
      // byte-equal; the comparison strips it, which is the whole reason an idle dashboard is quiet.
      expect(await rt.poll()).toBe(false);

      // Now something moves.
      const pushed = new Promise<string>((resolve) => {
        ws.addEventListener("message", (e) => resolve(String(e.data)), { once: true });
      });
      // A queued spinoff, because it rides the snapshot directly. The point of the assertion is the
      // out-of-process write reaching a connected client, not which surface carries it.
      db.query(
        `INSERT INTO spinoff(ticket_ref,repo,branch,worktree,mode,brief,status,request_at)
         VALUES('CUE-337','r','b','w','agent','x','pending','t')`,
      ).run();
      expect(await rt.poll()).toBe(true);
      const next = JSON.parse(await pushed);
      expect(next.type).toBe("snapshot");

      ws.close();
    } finally {
      rt.stop();
      db.close();
    }
  }, spawnBudget(2));
});

// OB-1617: the dashboard hands its own `getStore({ migrate: false })` thunk to the mounted sidecar, so the
// sidecar never falls back to the default `getStore()`, which would open (and migrate) with migrate=true.
describe("the mounted sidecar resolves its store through a host thunk (OB-1617)", () => {
  test("a thunk store is called on use instead of the default singleton", async () => {
    const db = freshDb();
    let calls = 0;
    const sidecar = createSidecar({
      store: async () => {
        calls++;
        return sqliteStoreFor(db);
      },
      pollMs: 60_000,
    });
    try {
      const res = await sidecar.fetch(new Request("http://x/not-a-sidecar-path"), () => false);
      expect(res).toBeNull();
      expect(calls).toBeGreaterThan(0);
    } finally {
      sidecar.stop();
    }
  });
});

// OB-1944: a new client must not hide a change from the clients already connected, reads must not overlap,
// and the comparison must see a nested `at` as data.
// The sidecar reads through snapshotFrom with no fetcher seam, so keep these off GitHub the same way the
// e2e harness does: with the frontier disabled the read is local and quick.
let priorFrontier: string | undefined;
beforeAll(() => {
  priorFrontier = process.env.OMNISLASH_DISABLE_FRONTIER;
  process.env.OMNISLASH_DISABLE_FRONTIER = "1";
});
afterAll(() => {
  if (priorFrontier === undefined) delete process.env.OMNISLASH_DISABLE_FRONTIER;
  else process.env.OMNISLASH_DISABLE_FRONTIER = priorFrontier;
});

const insertSpinoff = (db: ReturnType<typeof freshDb>, ref: string) =>
  db
    .query(
      `INSERT INTO spinoff(ticket_ref,repo,branch,worktree,mode,brief,status,request_at)
       VALUES(?,'r','b','w','agent','x','pending','t')`,
    )
    .run(ref);

/** A client that records every snapshot it is sent, and can wait for the n-th. */
function listen(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_WS_PATH}`);
  const got: Snapshot[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (e) => {
    got.push(JSON.parse(String(e.data)).data);
    for (const w of waiters.splice(0)) w();
  });
  const nth = async (n: number) => {
    while (got.length < n) await new Promise<void>((r) => waiters.push(r));
    return got[n - 1]!;
  };
  return { ws, got, nth };
}

describe("a new client does not hide a change from the others (OB-1944)", () => {
  test("two clients connected, a change, a third connects: the next poll delivers it to both", async () => {
    const db = openDb(freshDbPath());
    const rt = serveSidecar(sqliteStoreFor(db));
    try {
      const a = listen(rt.port);
      await a.nth(1);
      const b = listen(rt.port);
      await b.nth(1);
      insertSpinoff(db, "CUE-1944");
      const c = listen(rt.port);
      expect((await c.nth(1)).spinoffs).toHaveLength(1); // the newcomer reads the change itself
      expect(await rt.poll()).toBe(true); // ...and that does not use it up for the others
      expect((await a.nth(2)).spinoffs).toHaveLength(1);
      expect((await b.nth(2)).spinoffs).toHaveLength(1);
      expect(await rt.poll()).toBe(false); // now everyone has it
      for (const x of [a, b, c]) x.ws.close();
    } finally {
      rt.stop();
      db.close();
    }
  }, spawnBudget(2));
});

describe("the sidecar runs one read at a time (OB-1944)", () => {
  test("a second poll starts no second read until the first finishes, and pushes arrive in read order", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const gates: Array<() => void> = [];
    let started = 0;
    let running = 0;
    let maxRunning = 0;
    const sidecar = createSidecar({
      store: async () => {
        started++;
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise<void>((r) => gates.push(r));
        running--;
        return store;
      },
      pollMs: 60_000,
    });
    const sent: Snapshot[] = [];
    const ws = { send: (m: string) => sent.push(JSON.parse(m).data) } as never;
    const settle = () => new Promise((r) => setTimeout(r, 20));
    try {
      sidecar.websocket.open(ws); // read 1: the connect snapshot, held open
      await settle();
      const p1 = sidecar.poll();
      const p2 = sidecar.poll();
      await settle();
      expect(started).toBe(1); // neither poll has started a read
      gates.shift()!(); // finish the connect read
      await settle();
      expect(started).toBe(2); // the first poll's read starts only now
      insertSpinoff(db, "CUE-A");
      gates.shift()!();
      expect(await p1).toBe(true);
      await settle();
      expect(started).toBe(3);
      insertSpinoff(db, "CUE-B");
      gates.shift()!();
      expect(await p2).toBe(true);
      expect(maxRunning).toBe(1);
      // connect snapshot, then A's one spinoff, then B's two: oldest first.
      expect(sent.map((s) => s.spinoffs.length)).toEqual([0, 1, 2]);
    } finally {
      sidecar.stop();
    }
  }, spawnBudget(2));
});

describe("sameSnapshot (OB-1944)", () => {
  const base = async () => await snapshotFrom(sqliteStoreFor(freshDb()), noFrontier);

  test("snapshots that differ only in the top-level at are the same", async () => {
    const a = await base();
    expect(sameSnapshot(a, { ...a, at: "2099-01-01T00:00:00.000Z" })).toBe(true);
  });

  test("snapshots that differ only in a nested at are not", async () => {
    const a = await base();
    const withAt = (at: string) =>
      ({ ...a, whatsapp: [{ chat_jid: "x", ts: "t", at }] }) as unknown as Snapshot;
    expect(sameSnapshot(withAt("2026-11-12T08:00:00Z"), withAt("2026-11-12T09:00:00Z"))).toBe(false);
    expect(sameSnapshot(withAt("2026-11-12T08:00:00Z"), withAt("2026-11-12T08:00:00Z"))).toBe(true);
  });
});

// OS-316: the snapshot used to carry every spinoff row ever dispatched, brief and all (23 MB live, pushed to every
// open dashboard and stringified on every poll tick). It carries the in-flight rows only, cut to what a page reads.
describe("realtime snapshot size (OS-316)", () => {
  const PROMPT = "PROMPT-OS316-".padEnd(20_000, "x");
  const insert = (db: ReturnType<typeof freshDb>, ref: string, status: string, extra = "") =>
    db.query(
      `INSERT INTO spinoff(ticket_ref,repo,branch,worktree,mode,brief,status,request_at,error${extra ? ",phase" : ""})
       VALUES(?,?,?,?,?,?,?,?,?${extra ? ",?" : ""})`,
    ).run(...([ref, "r", ref.toLowerCase(), "/w", "agent", PROMPT, status, "t", status === "failed" ? PROMPT : null, ...(extra ? [extra] : [])] as string[]));

  test("hundreds of historical rows with 20 KB prompts make a small snapshot that leaks no prompt", async () => {
    const db = freshDb();
    for (let i = 0; i < 200; i++) insert(db, `OS-${i}`, i % 4 === 0 ? "failed" : "merged");
    insert(db, "OS-900", "launched", "reviewing");
    insert(db, "OS-901", "ready-for-gate");
    const snap = await snapshotFrom(sqliteStoreFor(db), noFrontier);
    const frame = JSON.stringify(snap);
    expect(frame.length).toBeLessThan(50_000);
    expect(frame).not.toContain("PROMPT-OS316");
    expect(snap.spinoffs.map((s) => [s.ticket_ref, s.status, s.phase])).toEqual([
      ["OS-901", "ready-for-gate", null],
      ["OS-900", "launched", "reviewing"],
    ]);
    expect("completed_spinoffs" in snap.status).toBe(false);
  });

  test("the machine stamp still moves on an in-flight row's status, phase or verdict, and on a land", async () => {
    const db = freshDb();
    for (let i = 0; i < 20; i++) insert(db, `OS-${i}`, "merged");
    insert(db, "OS-900", "launched");
    const store = sqliteStoreFor(db);
    const stamp = async () => {
      const s = await snapshotFrom(store, noFrontier);
      return machineStamp(s.spinoffs, s.agents, s.itemsStamp, s.decisionsStamp);
    };
    const id = (db.query("SELECT id FROM spinoff WHERE ticket_ref='OS-900'").get() as { id: number }).id;
    const seen = new Set([await stamp()]);
    const step = async (sql: string) => {
      db.query(sql).run();
      const next = await stamp();
      expect(seen.has(next)).toBe(false);
      seen.add(next);
    };
    await step(`UPDATE spinoff SET phase='reviewing' WHERE id=${id}`);
    await step(`UPDATE spinoff SET status='ready-for-gate', phase=NULL WHERE id=${id}`);
    await step(`UPDATE spinoff SET verdict='landable' WHERE id=${id}`);
    await step(`UPDATE spinoff SET status='merged' WHERE id=${id}`);
  });
});

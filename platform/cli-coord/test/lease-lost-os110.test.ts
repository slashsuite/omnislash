// OS-110: a builder whose ticket lease lapsed and was taken by another session is told on its next heartbeat,
// and its handoff is refused while that session holds the lease live. Found by the OS-104 TLA+ model
// (LeaseNoStaleAct). Lease rows are written directly with an old heartbeat_at, so expiry needs no sleeping.
// Fresh temp sqlite only: no live network, no live DB.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { agent } from "../../../apps/cli/src/api/handlers.ts";
import { registerAgent } from "../src/agent.ts";
import { acquireLease } from "../src/lease.ts";
import { enqueueSpinoff, listSpinoffs } from "../src/commands/spinoff.ts";
import { __setSh } from "./sh-no-pr.ts";

/** `ticketLeaseKey("OS-1")`: lease keys are stored lowercase, so the row names it `ticket:os-1`. */
const TICKET = "ticket:os-1";

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

type Db = ReturnType<typeof openDb>;

function seedLease(db: Db, resource: string, holder: string, ttlS: number, beatAgoMs: number): void {
  const at = ago(beatAgoMs);
  db.query("INSERT INTO lease(resource, holder, acquired_at, ttl_s, heartbeat_at) VALUES(?, ?, ?, ?, ?)").run(resource, holder, at, ttlS, at);
}

/** Steps 1 and 2 of the trace: `os-1` registered on OS-1 holds `ticket:OS-1`, last beaten 1000 s ago with TTL 900. */
async function lapsedBuilder(db: Db, worktree: string | null = null): Promise<void> {
  await registerAgent(db, { id: "os-1", ticket: "OS-1", branch: "os-1", worktree, status: "working", ttlS: 900 });
  seedLease(db, TICKET, "os-1", 900, 1_000_000);
}

describe("a heartbeat tells the builder its lease was taken (OS-110)", () => {
  test("the trace: os-1-b takes the lapsed ticket:OS-1, and `ob agent heartbeat os-1` exits 1 naming it", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    await lapsedBuilder(db);
    expect(await acquireLease(db, TICKET, "os-1-b", 900)).toEqual({ ok: true, holder: "os-1-b" });
    db.close();

    const r = await runCli(dbPath, ["agent", "heartbeat", "os-1"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^lost: ticket:os-1 is now held by os-1-b since \S+; stop work on this ticket and ask the architect$/m);
    expect(r.out).toContain("beat os-1"); // the beat is still recorded
  });

  test("the same through the API: the heartbeat response carries lost_leases", async () => {
    const db = openDb(freshDbPath());
    await lapsedBuilder(db);
    await acquireLease(db, TICKET, "os-1-b", 900);
    const res = await agent(asStore(db), { action: "heartbeat", id: "os-1" });
    expect(res.lost_leases).toEqual([{ resource: TICKET, holder: "os-1-b", since: expect.any(String) }]);
    db.close();
  });

  test("a lease still the agent's: exit 0, no lost line, and an empty lost_leases", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    await registerAgent(db, { id: "os-1", ticket: "OS-1", branch: "os-1", status: "working", ttlS: 900 });
    seedLease(db, TICKET, "os-1", 900, 60_000);
    expect((await agent(asStore(db), { action: "heartbeat", id: "os-1" })).lost_leases).toEqual([]);
    db.close();
    const r = await runCli(dbPath, ["agent", "heartbeat", "os-1"]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("lost:");
  });

  test("a lease that expired with nobody taking it: exit 0 and no lost line", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    await lapsedBuilder(db);
    db.close();
    const r = await runCli(dbPath, ["agent", "heartbeat", "os-1"]);
    expect(r.code).toBe(0);
    expect(r.err).not.toContain("lost:");
  });

  test("a team role hold is never lost: one the builder registered under, or one taken after it lapsed", async () => {
    for (const seed of [
      async (db: Db) => {
        seedLease(db, TICKET, "architect-omnislash", 1800, 60_000);
        await registerAgent(db, { id: "os-1", ticket: "OS-1", branch: "os-1", status: "working", ttlS: 900 });
      },
      async (db: Db) => {
        await lapsedBuilder(db);
        await acquireLease(db, TICKET, "architect-omnislash", 1800);
      },
    ]) {
      const dbPath = freshDbPath();
      const db = openDb(dbPath);
      await seed(db);
      db.close();
      const r = await runCli(dbPath, ["agent", "heartbeat", "os-1"]);
      expect(r.code).toBe(0);
      expect(r.err).not.toContain("lost:");
    }
  });
});

describe("`ob spinoff handoff` is fenced on the lease (OS-110)", () => {
  async function launchedRow(db: Db, worktree: string): Promise<void> {
    const { row } = await enqueueSpinoff(db, { ticketRef: "OS-1", repo: "/r/omnislash", branch: "os-1", worktree, mode: "interactive", brief: "lease fence" });
    db.query("UPDATE spinoff SET status = 'launched', agent_id = 'os-1' WHERE id = ?").run(row.id);
    await lapsedBuilder(db, worktree);
  }

  test("refused naming os-1-b while it holds ticket:OS-1 live; the row is still launched", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-os110-"));
    await launchedRow(db, wt);
    await acquireLease(db, TICKET, "os-1-b", 900);
    const restore = __setSh((cmd) =>
      cmd.includes("--porcelain") ? { ok: true, err: "", out: "" } : { ok: true, err: "", out: "State: landable\n" },
    );
    try {
      const r = await runCli(dbPath, ["spinoff", "handoff", "OS-1"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("cannot hand off OS-1: ticket:os-1 is now held by os-1-b");
      expect((await listSpinoffs(db)).map((x) => x.status)).toEqual(["launched"]);
    } finally {
      restore();
      db.close();
      rmSync(wt, { recursive: true, force: true });
    }
  });

  test("an architect hold passes the fence and the handoff goes through", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-os110-"));
    await launchedRow(db, wt);
    await acquireLease(db, TICKET, "architect-omnislash", 1800);
    const restore = __setSh((cmd) =>
      cmd.includes("--porcelain") ? { ok: true, err: "", out: "" } : { ok: true, err: "", out: "State: landable\n" },
    );
    try {
      const r = await runCli(dbPath, ["spinoff", "handoff", "OS-1"]);
      expect(r.err).not.toContain("cannot hand off");
      expect((await listSpinoffs(db)).map((x) => x.status)).toEqual(["ready-for-gate"]);
    } finally {
      restore();
      db.close();
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

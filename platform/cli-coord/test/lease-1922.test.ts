// OB-1922: a heartbeat never revives an expired lease, a same-holder re-acquire keeps the lease's age,
// `lease status` sweeps rows expired for over a day, and the spinoff claim is a registered key class.
// Fresh temp sqlite only: no live network, no live DB.
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { acquire, agent, leases, sweepLeases } from "../../../apps/cli/src/api/handlers.ts";
import { registerAgent } from "../src/agent.ts";
import {
  acquireLease,
  acquireLeases,
  heartbeatLease,
  heartbeatLeasesByHolder,
  heartbeatOrReacquire,
  LEASE_KEY_CLASSES,
  LEASE_SWEEP_AFTER_MS,
  LeaseExpiredError,
  leaseKeyClass,
  leaseStatus,
  normalizeLeaseResource,
  sweepExpiredLeases,
} from "../src/lease.ts";
import { spinoffClaimKey } from "../src/commands/spinoff.ts";

function freshDb() {
  return openDb(join(tmpdir(), `ob-test-1922-${randomUUID()}.sqlite`));
}

function seed(
  db: ReturnType<typeof freshDb>,
  resource: string,
  holder: string,
  ttlS: number,
  acquiredAt: string,
  heartbeatAt: string = acquiredAt,
): void {
  db.query("INSERT INTO lease(resource, holder, acquired_at, ttl_s, heartbeat_at) VALUES(?, ?, ?, ?, ?)").run(
    resource,
    holder,
    acquiredAt,
    ttlS,
    heartbeatAt,
  );
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("a heartbeat never revives an expired lease (OB-1922)", () => {
  test("the holder's own expired lease: heartbeat fails with LeaseExpiredError and writes nothing", async () => {
    const db = freshDb();
    const beatAt = ago(60_000);
    seed(db, "ticket:7", "A", 1, beatAt); // ttl 1s, beaten 60s ago: expired
    const err = await heartbeatLease(db, "ticket:7", "A").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseExpiredError);
    expect((err as Error).name).toBe("LeaseExpiredError");
    expect((err as Error).message).toContain("acquire it again");
    const row = (await leaseStatus(db))[0]!;
    expect(row.heartbeat_at).toBe(beatAt);
    expect(row.expired).toBe(true);
  });

  test("a live lease still beats", async () => {
    const db = freshDb();
    seed(db, "ticket:7", "A", 300, ago(60_000));
    expect(await heartbeatLease(db, "ticket:7", "A")).toBe(true);
    expect((await leaseStatus(db))[0]!.expired).toBe(false);
  });

  test("another holder acquires the lapsed lease, and the first holder's heartbeat then fails", async () => {
    const db = freshDb();
    seed(db, "ticket:7", "A", 1, ago(60_000)); // A let it expire
    const got = await acquireLease(db, "ticket:7", "B", 300);
    expect(got).toEqual({ ok: true, holder: "B" });
    expect(await heartbeatLease(db, "ticket:7", "A")).toBe(false);
    const row = (await leaseStatus(db))[0]!;
    expect(row.holder).toBe("B");
    expect(row.expired).toBe(false);
  });

  test("agent heartbeat (by holder) beats live leases and acquires expired ones afresh, never revived", async () => {
    const db = freshDb();
    const old = ago(60_000);
    seed(db, "ticket:7", "A", 300, old); // live
    seed(db, "worktree:/w", "A", 1, old); // expired, still names A
    expect(await heartbeatLeasesByHolder(db, "A")).toEqual({ beat: ["ticket:7"], reacquired: ["worktree:/w"] });
    const rows = await leaseStatus(db);
    const w = rows.find((r) => r.resource === "worktree:/w")!;
    expect(w.expired).toBe(false);
    expect(w.acquired_at).not.toBe(old); // a fresh lease: new acquired_at
    expect(rows.find((r) => r.resource === "ticket:7")!.acquired_at).toBe(old); // a beat keeps the age
  });

  test("agent heartbeat does not touch a lease another holder took after it lapsed", async () => {
    const db = freshDb();
    seed(db, "ticket:7", "A", 1, ago(60_000));
    expect((await acquireLease(db, "ticket:7", "B", 300)).ok).toBe(true);
    expect(await heartbeatLeasesByHolder(db, "A")).toEqual({ beat: [], reacquired: [] });
    expect((await leaseStatus(db))[0]!.holder).toBe("B");
  });

  test("over the API: a heartbeat on the caller's own expired lease is refused, recorded says expired", async () => {
    const db = freshDb();
    seed(db, "ticket:7", "A", 1, ago(60_000));
    const res = await acquire(asStore(db), { resource: "ticket:7", holder: "A", ttl_s: 300, heartbeat: true });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("LeaseExpiredError");
    expect(res.recorded?.holder).toBe("A");
    expect(res.recorded?.expired).toBe(true);
  });

  test("over the API: agent heartbeat names the expired leases it acquired again", async () => {
    const db = freshDb();
    await registerAgent(db, { id: "A", ttlS: 900 });
    seed(db, "ticket:7", "A", 1, ago(60_000));
    const res = await agent(asStore(db), { action: "heartbeat", id: "A" });
    expect(res.reacquired_leases).toEqual(["ticket:7"]);
    expect((await leaseStatus(db))[0]!.expired).toBe(false);
  });

  test("heartbeatOrReacquire: beats a live lease, takes an expired one afresh, never one held live by another", async () => {
    const db = freshDb();
    const old = ago(60_000);
    seed(db, "ticket:live", "A", 300, old);
    seed(db, "ticket:lapsed", "A", 1, old);
    seed(db, "ticket:theirs", "B", 300, old);
    expect(await heartbeatOrReacquire(db, "ticket:live", "A", 300)).toBe(true);
    expect(await heartbeatOrReacquire(db, "ticket:lapsed", "A", 300)).toBe(true);
    expect(await heartbeatOrReacquire(db, "ticket:theirs", "A", 300)).toBe(false);
    const rows = await leaseStatus(db);
    expect(rows.find((r) => r.resource === "ticket:live")!.acquired_at).toBe(old);
    expect(rows.find((r) => r.resource === "ticket:lapsed")!.acquired_at).not.toBe(old);
    expect(rows.find((r) => r.resource === "ticket:theirs")!.holder).toBe("B");
  });
});

describe("a same-holder re-acquire keeps acquired_at (OB-1922)", () => {
  test("acquireLease: acquired_at kept, heartbeat_at and ttl moved", async () => {
    const db = freshDb();
    const since = ago(120_000);
    seed(db, "ticket:7", "A", 300, since, ago(30_000));
    expect((await acquireLease(db, "ticket:7", "A", 900)).ok).toBe(true);
    const row = (await leaseStatus(db))[0]!;
    expect(row.acquired_at).toBe(since);
    expect(row.ttl_s).toBe(900);
    expect(new Date(row.heartbeat_at!).getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  test("acquireLeases: the same for every key in the set", async () => {
    const db = freshDb();
    const since = ago(120_000);
    seed(db, "ticket:7", "A", 300, since);
    expect((await acquireLeases(db, ["ticket:7", "worktree:/w"], "A", 300)).ok).toBe(true);
    const rows = await leaseStatus(db);
    expect(rows.find((r) => r.resource === "ticket:7")!.acquired_at).toBe(since);
    expect(rows.find((r) => r.resource === "worktree:/w")!.acquired_at).not.toBe(since);
  });

  test("re-acquiring your own EXPIRED lease is a fresh lease with a new acquired_at", async () => {
    const db = freshDb();
    const since = ago(120_000);
    seed(db, "ticket:7", "A", 1, since);
    expect((await acquireLease(db, "ticket:7", "A", 300)).ok).toBe(true);
    expect((await leaseStatus(db))[0]!.acquired_at).not.toBe(since);
  });

  test("another holder taking an expired lease starts a new acquired_at", async () => {
    const db = freshDb();
    const since = ago(120_000);
    seed(db, "ticket:7", "A", 1, since);
    expect((await acquireLease(db, "ticket:7", "B", 300)).ok).toBe(true);
    expect((await leaseStatus(db))[0]!.acquired_at).not.toBe(since);
  });
});

describe("lease status sweeps rows expired for over a day (OB-1922)", () => {
  test("sweepExpiredLeases deletes only rows expired longer than a day", async () => {
    const db = freshDb();
    const day = LEASE_SWEEP_AFTER_MS;
    seed(db, "ticket:old", "A", 60, ago(day + 120_000)); // expired a day and a minute ago
    seed(db, "ticket:recent", "A", 60, ago(3_600_000)); // expired about an hour ago
    seed(db, "ticket:live", "A", 300, ago(1_000));
    expect(await sweepExpiredLeases(db)).toEqual(["ticket:old"]);
    expect((await leaseStatus(db)).map((r) => r.resource)).toEqual(["ticket:live", "ticket:recent"]);
  });

  test("the cut-off is measured from the expiry, not from the last beat", async () => {
    const db = freshDb();
    // beaten 25h ago with a 2h TTL: expired 23h ago, so it stays
    seed(db, "ticket:7", "A", 2 * 3600, ago(25 * 3_600_000));
    expect(await sweepExpiredLeases(db)).toEqual([]);
  });

  test("GET /leases stays a pure read; POST /leases/sweep sweeps and names what it swept", async () => {
    const db = freshDb();
    seed(db, "ticket:old", "A", 60, ago(LEASE_SWEEP_AFTER_MS + 120_000));
    seed(db, "ticket:live", "A", 300, ago(1_000));
    expect((await leases(asStore(db))).leases).toHaveLength(2);
    expect(await sweepLeases(asStore(db))).toEqual({ swept: ["ticket:old"] });
    expect((await leases(asStore(db))).leases.map((r) => r.resource)).toEqual(["ticket:live"]);
  });
});

describe("the spinoff claim is a registered key class (OB-1922)", () => {
  test("spinoff:<id> classifies as spinoff and passes through normalisation unchanged", () => {
    expect(LEASE_KEY_CLASSES).toContain("spinoff");
    expect(leaseKeyClass(spinoffClaimKey(42))).toBe("spinoff");
    expect(normalizeLeaseResource(spinoffClaimKey(42))).toBe("spinoff:42");
  });
});

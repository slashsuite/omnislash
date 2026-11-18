import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../../../apps/cli/src/db.ts";
import {
  acquireLease,
  DEFAULT_LEASE_TTL_S,
  heartbeatLease,
  isLeaseExpired,
  leaseStatus,
  releaseLease,
  waitUntilAcquired,
} from "../src/lease.ts";
import { getAgent, listAgents, registerAgent } from "../src/agent.ts";
import { renderPlist } from "../src/commands/coord.ts";
import { ApiError } from "../../../apps/cli/src/api/client.ts";

// Open the DB directly rather than via test/helpers.ts: helpers imports cli.ts,
// which imports sibling command modules (report/alerts/audit) still being built
// in parallel. This test only needs the schema + lease logic.
function freshDb() {
  return openDb(join(tmpdir(), `ob-test-${randomUUID()}.sqlite`));
}

function insertLease(
  db: ReturnType<typeof freshDb>,
  resource: string,
  holder: string,
  ttlS: number,
  heartbeatAt: string,
): void {
  db.query(
    "INSERT INTO lease(resource, holder, acquired_at, ttl_s, heartbeat_at) VALUES(?, ?, ?, ?, ?)",
  ).run(resource, holder, heartbeatAt, ttlS, heartbeatAt);
}

describe("lease acquire/release", () => {
  test("acquire on a free resource succeeds", async () => {
    const db = freshDb();
    const r = (await acquireLease(db, "port:3000", "A", 300));
    expect(r.ok).toBe(true);
    expect(r.holder).toBe("A");
    const status = (await leaseStatus(db));
    expect(status).toHaveLength(1);
    expect(status[0]!.holder).toBe("A");
    expect(status[0]!.expired).toBe(false);
  });

  test("a second holder is blocked while the lease is live", async () => {
    const db = freshDb();
    expect((await acquireLease(db, "port:3000", "A", 300)).ok).toBe(true);
    const r = (await acquireLease(db, "port:3000", "B", 300));
    expect(r.ok).toBe(false);
    expect(r.holder).toBe("A");
  });

  test("re-acquire by the same holder refreshes and succeeds", async () => {
    const db = freshDb();
    (await acquireLease(db, "port:3000", "A", 300));
    const r = (await acquireLease(db, "port:3000", "A", 300));
    expect(r.ok).toBe(true);
    expect(r.holder).toBe("A");
  });

  test("an expired lease is reclaimable by another holder", async () => {
    const db = freshDb();
    const old = new Date(Date.now() - 60_000).toISOString(); // 60s ago
    insertLease(db, "port:3000", "A", 1, old); // ttl 1s, beaten 60s ago -> expired
    expect((await leaseStatus(db))[0]!.expired).toBe(true);
    const r = (await acquireLease(db, "port:3000", "B", 300));
    expect(r.ok).toBe(true);
    expect(r.holder).toBe("B");
    expect((await leaseStatus(db))[0]!.expired).toBe(false);
  });

  test("release by the wrong holder fails; by the right holder succeeds", async () => {
    const db = freshDb();
    (await acquireLease(db, "port:3000", "A", 300));
    expect((await releaseLease(db, "port:3000", "B"))).toBe(false);
    expect((await leaseStatus(db))).toHaveLength(1);
    expect((await releaseLease(db, "port:3000", "A"))).toBe(true);
    expect((await leaseStatus(db))).toHaveLength(0);
  });

  test("force release deletes regardless of holder", async () => {
    const db = freshDb();
    (await acquireLease(db, "port:3000", "A", 300));
    expect((await releaseLease(db, "port:3000", "B", true))).toBe(true);
    expect((await leaseStatus(db))).toHaveLength(0);
  });

  test("release of a nonexistent resource is false, not a throw", async () => {
    expect((await releaseLease(freshDb(), "port:3000", "A"))).toBe(false);
  });

  // #75: release is symmetric with acquire, and acquire already grants over an expired row to anyone,
  // so an expired lease protects nothing and tidying one must not need --force (which exists for LIVE
  // holders only). A live foreign lease is still untouchable without it.
  test("an EXPIRED lease is releasable by anyone; a LIVE foreign one is not", async () => {
    const db = freshDb();
    const old = new Date(Date.now() - 60_000).toISOString();
    insertLease(db, "port:3000", "A", 1, old); // ttl 1s, beaten 60s ago -> expired
    expect((await releaseLease(db, "port:3000", "B"))).toBe(true);
    expect((await leaseStatus(db))).toHaveLength(0);

    (await acquireLease(db, "port:3000", "A", 300));
    expect((await releaseLease(db, "port:3000", "B"))).toBe(false);
    expect((await leaseStatus(db))).toHaveLength(1);
  });

  test("heartbeat extends a lease and rejects a non-holder", async () => {
    const db = freshDb();
    const old = new Date(Date.now() - 60_000).toISOString();
    insertLease(db, "port:3000", "A", 120, old); // beaten 60s ago, ttl 120 -> still live
    expect((await leaseStatus(db))[0]!.expired).toBe(false);
    expect((await heartbeatLease(db, "port:3000", "B"))).toBe(false);
    expect((await heartbeatLease(db, "port:3000", "A"))).toBe(true);
    const beat = (await leaseStatus(db))[0]!.heartbeat_at!;
    expect(new Date(beat).getTime()).toBeGreaterThan(new Date(old).getTime());
  });

  test("default TTL is 20 minutes (ob 561)", () => {
    expect(DEFAULT_LEASE_TTL_S).toBe(1200);
  });

  test("acquire without heartbeat is free after 20m (ob 561)", async () => {
    const db = freshDb();
    const ago = new Date(Date.now() - 20 * 60 * 1000 - 1).toISOString();
    insertLease(db, "port:3000", "A", DEFAULT_LEASE_TTL_S, ago);
    const row = (await leaseStatus(db))[0]!;
    expect(isLeaseExpired(row, Date.now())).toBe(true);
    const r = await acquireLease(db, "port:3000", "B", DEFAULT_LEASE_TTL_S);
    expect(r.ok).toBe(true);
    expect(r.holder).toBe("B");
  });

  test("heartbeat at 10m is still held at 19m (ob 561)", async () => {
    const db = freshDb();
    const t0 = Date.now() - 19 * 60 * 1000;
    const beatAt10m = new Date(t0 + 10 * 60 * 1000).toISOString();
    insertLease(db, "port:3000", "A", DEFAULT_LEASE_TTL_S, beatAt10m);
    const row = (await leaseStatus(db))[0]!;
    expect(isLeaseExpired(row, Date.now())).toBe(false);
    expect((await acquireLease(db, "port:3000", "B", DEFAULT_LEASE_TTL_S)).ok).toBe(false);
  });

  test("--wait succeeds after release, not after 60s (ob 561)", async () => {
    const db = freshDb();
    expect((await acquireLease(db, "port:3000", "A", DEFAULT_LEASE_TTL_S)).ok).toBe(true);
    let elapsed = 0;
    const r = await waitUntilAcquired(() => acquireLease(db, "port:3000", "B", DEFAULT_LEASE_TTL_S), {
      pollMs: 1500,
      sleep: async (ms) => {
        elapsed += ms;
        if (elapsed >= 61_000) await releaseLease(db, "port:3000", "A");
      },
    });
    expect(r.ok).toBe(true);
    expect(r.holder).toBe("B");
    expect(elapsed).toBeGreaterThanOrEqual(61_000);
  });

  test("an expired lease expires the holder's agent row without agent done (ob 561)", async () => {
    const db = freshDb();
    await registerAgent(db, { id: "A", ticket: "561", ttlS: 900 });
    const ago = new Date(Date.now() - 20 * 60 * 1000 - 1).toISOString();
    insertLease(db, "ticket:561", "A", DEFAULT_LEASE_TTL_S, ago);
    expect((await listAgents(db)).map((a) => a.id)).toEqual([]);
    const stale = (await listAgents(db, { includeExpired: true }))[0]!;
    expect(stale.id).toBe("A");
    expect(stale.expired).toBe(true);
    expect(await getAgent(db, "A")).not.toBeNull();
  });

  test("a holder with any live lease is not staled by a leftover expired one (ob 561)", async () => {
    const db = freshDb();
    await registerAgent(db, { id: "A", ticket: "561", ttlS: 900 });
    const ago = new Date(Date.now() - 20 * 60 * 1000 - 1).toISOString();
    insertLease(db, "ticket:old", "A", DEFAULT_LEASE_TTL_S, ago);
    expect((await acquireLease(db, "ticket:561", "A", DEFAULT_LEASE_TTL_S)).ok).toBe(true);
    expect((await listAgents(db)).map((a) => a.id)).toEqual(["A"]);
  });
});

describe("renderPlist", () => {
  test("interval job contains label, program args, and StartInterval", () => {
    const xml = renderPlist("com.omnislash.sync", ["/home/x/.local/bin/ob", "sync"], {
      logPath: "/home/x/.local/share/omnislash/logs/sync.log",
      interval: 3600,
      runAtLoad: false,
    });
    expect(xml).toContain("<string>com.omnislash.sync</string>");
    expect(xml).toContain("<string>/home/x/.local/bin/ob</string>");
    expect(xml).toContain("<string>sync</string>");
    expect(xml).toContain("<key>StartInterval</key>");
    expect(xml).toContain("<integer>3600</integer>");
    expect(xml).toContain("<false/>");
    expect(xml).toContain(
      "<string>/home/x/.local/share/omnislash/logs/sync.log</string>",
    );
  });

  test("calendar job contains StartCalendarInterval hour/minute", () => {
    const xml = renderPlist("com.omnislash.alerts", ["/home/x/.local/bin/ob", "alerts", "--digest"], {
      logPath: "/home/x/.local/share/omnislash/logs/alerts.log",
      calendar: { hour: 8, minute: 0 },
    });
    expect(xml).toContain("<key>StartCalendarInterval</key>");
    expect(xml).toContain("<key>Hour</key>");
    expect(xml).toContain("<integer>8</integer>");
    expect(xml).toContain("<key>Minute</key>");
    expect(xml).toContain("<string>--digest</string>");
    expect(xml).not.toContain("StartInterval</key>");
  });
});

describe("lease acquire --wait: an unreachable ob API is waited out (OB-2157)", () => {
  test("an attempt that throws unreachable twice, then grants, returns the grant", async () => {
    let calls = 0;
    const log: string[] = [];
    const r = await waitUntilAcquired(
      async () => {
        if (calls++ < 2) throw new ApiError("could not reach the ob API", 0, { unreachable: true });
        return { ok: true, holder: "B" };
      },
      { pollMs: 1, sleep: () => {}, resource: "port:3000", log: (l) => log.push(l) },
    );
    expect(r).toEqual({ ok: true, holder: "B" });
    expect(calls).toBe(3);
    expect(log).toEqual(["ob API unreachable, still waiting for port:3000", "ob API back"]);
  });

  test("any other error still ends the wait", async () => {
    await expect(
      waitUntilAcquired(
        async () => {
          throw new ApiError("the ob API answered 500", 500);
        },
        { sleep: () => {}, log: () => {} },
      ),
    ).rejects.toThrow("answered 500");
  });
});

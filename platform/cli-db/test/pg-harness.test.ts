import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { SQL } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgClusterRoot, pgDefaultParent, resolvePgBinDir, sweepStalePgClusters } from "../../../apps/cli/test/pg/cluster.ts";
import { freshPgDatabase, freshPgDb, pgClusterDir, pgHarnessStarted } from "../../../apps/cli/test/pg/harness.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

/**
 * The Postgres test harness (325). The four properties it has to have, each proved rather than asserted in
 * a comment: real isolation, a cost the suite can afford (guarded by pool identity, not by timing), no
 * network, and no leaks.
 *
 * These are the tests that actually start a postmaster, so they carry a spawn budget. The budget matters
 * more than usual here: bun's test runner kills a timed-out test's spawned children, and a run that does
 * that to the postmaster loses the cluster mid-suite.
 */

const PG_BUDGET = spawnBudget(3);

describe("isolation", () => {
  test("two leases held at once cannot see each other's rows", async () => {
    const a = await freshPgDb();
    const b = await freshPgDb();
    try {
      expect(a.name).not.toBe(b.name);

      await a.sql.unsafe(`INSERT INTO item (title, project) VALUES ('only-in-a', 'a')`);
      await b.sql.unsafe(`INSERT INTO item (title, project) VALUES ('only-in-b', 'b')`);

      const inA = (await a.sql.unsafe(`SELECT title FROM item ORDER BY title`)) as { title: string }[];
      const inB = (await b.sql.unsafe(`SELECT title FROM item ORDER BY title`)) as { title: string }[];

      expect(inA.map((r) => r.title)).toEqual(["only-in-a"]);
      expect(inB.map((r) => r.title)).toEqual(["only-in-b"]);
    } finally {
      await a.release();
      await b.release();
    }
  }, PG_BUDGET);

  test("a lease cannot reach another lease's database even deliberately", async () => {
    const a = await freshPgDb();
    const b = await freshPgDb();
    try {
      await b.sql.unsafe(`INSERT INTO item (title) VALUES ('b-secret')`);
      let reason = "";
      try {
        await a.sql.unsafe(`SELECT title FROM ${b.name}.public.item`);
      } catch (err) {
        reason = (err as Error).message;
      }
      // The boundary is Postgres's own: a connection cannot address a second database at all.
      expect(reason).toContain("cross-database references are not implemented");
    } finally {
      await a.release();
      await b.release();
    }
  }, PG_BUDGET);

  test("a released lease hands the next test an empty database", async () => {
    const first = await freshPgDb();
    const name = first.name;
    await first.sql.unsafe(`INSERT INTO item (title) VALUES ('leftover')`);
    await first.sql.unsafe(`INSERT INTO fixture_0 (name) VALUES ('leftover')`);
    await first.release();

    // The pool hands back the first free slot, so this is the database just released -- the case that
    // matters, since a fresh one would be empty whatever the reset did.
    const second = await freshPgDb();
    try {
      expect(second.name).toBe(name);
      const items = (await second.sql.unsafe(`SELECT count(*)::int AS n FROM item`)) as { n: number }[];
      const others = (await second.sql.unsafe(`SELECT count(*)::int AS n FROM fixture_0`)) as { n: number }[];
      expect(items[0]!.n).toBe(0);
      expect(others[0]!.n).toBe(0);
    } finally {
      await second.release();
    }
  }, PG_BUDGET);

  test("identity sequences restart, so ids are stable test to test", async () => {
    const first = await freshPgDb();
    const firstId = (await first.sql.unsafe(
      `INSERT INTO item (title) VALUES ('a') RETURNING id`,
    )) as { id: number }[];
    await first.release();

    const second = await freshPgDb();
    try {
      const secondId = (await second.sql.unsafe(
        `INSERT INTO item (title) VALUES ('a') RETURNING id`,
      )) as { id: number }[];
      expect(secondId[0]!.id).toBe(firstId[0]!.id);
    } finally {
      await second.release();
    }
  }, PG_BUDGET);

  test("a write made by ANOTHER backend is still cleaned up", async () => {
    const lease = await freshPgDb();
    const name = lease.name;
    // Taking `options` (or `url`) is what a test does to hand the database to a second connection. It marks
    // the lease, because that backend's statistics are not this one's to read, so the reset stops trusting
    // them and truncates every table instead.
    const other = new SQL({ ...lease.options, max: 1 });
    await other.unsafe(`INSERT INTO item (title) VALUES ('from-another-backend')`);
    await other.end();
    await lease.release();

    const next = await freshPgDb();
    try {
      expect(next.name).toBe(name);
      const rows = (await next.sql.unsafe(`SELECT count(*)::int AS n FROM item`)) as { n: number }[];
      expect(rows[0]!.n).toBe(0);
    } finally {
      await next.release();
    }
  }, PG_BUDGET);

  test("the URL handed to a subprocess names the socket, never a host", async () => {
    const lease = await freshPgDb();
    try {
      expect(lease.url).toStartWith("postgresql://ob@/");
      expect(lease.url).toContain(`host=${encodeURIComponent(pgClusterDir()!)}`);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("freshPgDatabase gives a database nothing else in the run shares", async () => {
    const own = await freshPgDatabase();
    const lease = await freshPgDb();
    try {
      expect(own.name).not.toBe(lease.name);
      await own.sql.unsafe(`INSERT INTO item (title) VALUES ('private')`);
      const inLease = (await lease.sql.unsafe(`SELECT count(*)::int AS n FROM item`)) as { n: number }[];
      expect(inLease[0]!.n).toBe(0);
    } finally {
      await lease.release();
      await own.drop();
    }
  }, PG_BUDGET);

  test("freshPgDatabase({ empty: true }) has no schema, for the migration-machinery tests", async () => {
    const own = await freshPgDatabase({ empty: true });
    try {
      const tables = (await own.sql.unsafe(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`,
      )) as { n: number }[];
      expect(tables[0]!.n).toBe(0);
    } finally {
      await own.drop();
    }
  }, PG_BUDGET);
});

describe("cost", () => {
  // No wall-clock bound is asserted: runner load moves timings and a timing bound flakes (OB-1978). Reuse is
  // proven by identity: each leased database's oid must already exist before the rounds. That also catches a
  // drop-and-recreate under the same name, which keeps the name but changes the oid.
  test("acquiring a database reuses a pooled database and never creates one", async () => {
    let pooledOids: Set<number>;
    const warm = await freshPgDb();
    try {
      const pool = (await warm.sql.unsafe(`SELECT oid::int AS oid FROM pg_database`)) as { oid: number }[];
      pooledOids = new Set(pool.map((r) => r.oid));
    } finally {
      await warm.release();
    }

    for (let i = 0; i < 30; i++) {
      const lease = await freshPgDb();
      try {
        const [row] = (await lease.sql.unsafe(
          `SELECT oid::int AS oid FROM pg_database WHERE datname = current_database()`,
        )) as { oid: number }[];
        expect(pooledOids.has(row!.oid)).toBe(true);
        await lease.sql.unsafe(`INSERT INTO item (title) VALUES ('x')`);
        await lease.sql.unsafe(`INSERT INTO note (item_id, body) VALUES (1, 'x')`);
      } finally {
        await lease.release();
      }
    }
  }, spawnBudget(6));
});

describe("hermetic", () => {
  test("the binaries are a local package, not something fetched at test time", () => {
    const binDir = resolvePgBinDir();
    expect(existsSync(join(binDir, "initdb"))).toBe(true);
    expect(existsSync(join(binDir, "postgres"))).toBe(true);
  });

  test("the cluster listens on a unix socket only, so no live database is reachable", async () => {
    const lease = await freshPgDb();
    try {
      // An empty `listen_addresses` means no TCP listener at all: there is no host and no port to point at
      // the Mac's Postgres or the server's, by accident or otherwise.
      const rows = (await lease.sql.unsafe(`SHOW listen_addresses`)) as { listen_addresses: string }[];
      expect(rows[0]!.listen_addresses).toBe("");
      const local = (await lease.sql.unsafe(`SELECT inet_server_addr() IS NULL AS local`)) as {
        local: boolean;
      }[];
      expect(local[0]!.local).toBe(true);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("the cluster's data directory is this process's own throwaway tree", async () => {
    const lease = await freshPgDb();
    try {
      const rows = (await lease.sql.unsafe(`SHOW data_directory`)) as { data_directory: string }[];
      expect(rows[0]!.data_directory).toBe(join(pgClusterDir()!, "data"));
      expect(rows[0]!.data_directory.startsWith(pgClusterRoot())).toBe(true);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);
});

describe("teardown", () => {
  test("the sweep removes an orphaned tree whose postmaster is gone", () => {
    const root = mkdtempSync(join(tmpdir(), "ob-pg-sweep-"));
    const prev = process.env.OMNISLASH_TEST_PG_ROOT;
    process.env.OMNISLASH_TEST_PG_ROOT = root;
    try {
      const orphan = join(pgClusterRoot(), "ob-pg-orphan");
      mkdirSync(join(orphan, "data"), { recursive: true });
      // A pid file naming a process that is not a postgres: what `kill -9` leaves behind.
      writeFileSync(join(orphan, "data", "postmaster.pid"), `999999\n${join(orphan, "data")}\n`);

      // Nothing is removed while it is young, so a sibling run still inside initdb is never deleted from
      // underneath it.
      expect(sweepStalePgClusters(0, 60_000)).toEqual([]);
      expect(existsSync(orphan)).toBe(true);

      expect(sweepStalePgClusters(0, 0)).toEqual([orphan]);
      expect(existsSync(orphan)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.OMNISLASH_TEST_PG_ROOT;
      else process.env.OMNISLASH_TEST_PG_ROOT = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the sweep leaves a young tree alone, whatever the grace period", () => {
    const root = mkdtempSync(join(tmpdir(), "ob-pg-sweep-"));
    const prev = process.env.OMNISLASH_TEST_PG_ROOT;
    process.env.OMNISLASH_TEST_PG_ROOT = root;
    try {
      const live = join(pgClusterRoot(), "ob-pg-live");
      mkdirSync(join(live, "data"), { recursive: true });
      writeFileSync(join(live, "data", "postmaster.pid"), `999999\n${join(live, "data")}\n`);
      expect(sweepStalePgClusters(60_000, 60_000)).toEqual([]);
      expect(existsSync(live)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OMNISLASH_TEST_PG_ROOT;
      else process.env.OMNISLASH_TEST_PG_ROOT = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("this run's cluster lives under the shared parent, not inside the run scratch", async () => {
    await (await freshPgDb()).release();
    expect(pgHarnessStarted()).toBe(true);
    const mine = pgClusterDir()!;
    expect(existsSync(mine)).toBe(true);
    // Inside the run scratch it would be removed by that tree's `rmSync`, which deletes an orphaned
    // postmaster's data directory while leaving the postmaster itself running: a leaked Postgres per
    // killed run, and the exact thing the sweep exists to catch.
    expect(mine.startsWith(pgClusterRoot())).toBe(true);
    expect(mine.startsWith(process.env.TMPDIR ?? "\0")).toBe(false);
    expect(readdirSync(pgClusterRoot())).toContain(mine.slice(pgClusterRoot().length + 1));
  }, PG_BUDGET);

  test("stopping the harness removes the cluster tree and its postmaster", async () => {
    const { stopPgHarness } = await import("../../../apps/cli/test/pg/harness.ts");
    await (await freshPgDb()).release();
    const dir = pgClusterDir()!;
    expect(existsSync(dir)).toBe(true);
    await stopPgHarness();
    expect(pgHarnessStarted()).toBe(false);
    expect(existsSync(dir)).toBe(false);
    // And it comes back, so a stop mid-run is survivable rather than terminal.
    const again = await freshPgDb();
    try {
      expect(pgClusterDir()).not.toBe(dir);
    } finally {
      await again.release();
    }
  }, spawnBudget(6));
});

// OB-2029. On a disk filesystem the cluster's checkpoints wait in writeback under load (a first lease took
// up to 10.8s on btrfs), so the cluster goes on tmpfs where the machine has a usable one.
describe("pgDefaultParent (OB-2029)", () => {
  const TMPFS = 0x01021994;
  const BTRFS = 0x9123683e;
  const roomy = { type: TMPFS, freeBytes: 8 * 1024 ** 3, noexec: false };

  test("a tmpfs /dev/shm with room holds the clusters, noexec or not", () => {
    expect(pgDefaultParent(roomy)).toBe("/dev/shm");
    expect(pgDefaultParent({ ...roomy, noexec: true })).toBe("/dev/shm");
  });

  test("no usable tmpfs keeps /tmp", () => {
    expect(pgDefaultParent({ ...roomy, type: BTRFS })).toBe("/tmp");
    expect(pgDefaultParent({ ...roomy, freeBytes: 64 * 1024 ** 2 })).toBe("/tmp");
    expect(pgDefaultParent(null)).toBe("/tmp");
  });
});

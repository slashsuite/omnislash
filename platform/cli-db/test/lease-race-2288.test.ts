// OB-2288: two acquirers racing for a one-slot lease. Exactly one holds it, the other is denied.
//
// TK-8 saw two `ob lease run cpu:browser` runs started together both take the slot. The cause was
// acquireLease reading the row and then upserting it under READ COMMITTED with no row lock: two
// acquirers that both read the row absent or expired both passed the check, and the second upsert
// overwrote the first. Each round here starts two acquirers at once on two separate Postgres
// connections (the pg harness, a real local cluster over a unix socket; no network, no live database),
// so the second statement genuinely runs while the first transaction is open.
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { freshPgDatabase } from "../../../apps/cli/test/pg/harness.ts";
import { acquireLease, acquireLeases } from "../../cli-coord/src/lease.ts";

const ROUNDS = 200;
/** 200 rounds on two connections, plus migrating a fresh database: well under this on an idle machine. */
const BUDGET = 60_000;

async function holderOf(store: Store, resource: string): Promise<string | null> {
  const rows = (await store.q
    .select({ holder: store.t.lease.holder })
    .from(store.t.lease)
    .where(eq(store.t.lease.resource, resource))) as Array<{ holder: string | null }>;
  return rows[0]?.holder ?? null;
}

/** acquireLease: a fresh resource each round, two holders at once. */
async function raceSingle(a: Store, b: Store, tag: string): Promise<string[]> {
  const bad: string[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    const resource = `cpu:race-${tag}-${i}`;
    const [ra, rb] = await Promise.all([
      acquireLease(a, resource, "holder-a", 600),
      acquireLease(b, resource, "holder-b", 600),
    ]);
    const winners = [ra.ok && "holder-a", rb.ok && "holder-b"].filter(Boolean);
    const row = await holderOf(a, resource);
    if (winners.length !== 1 || row !== winners[0]) {
      bad.push(`round ${i}: a=${JSON.stringify(ra)} b=${JSON.stringify(rb)} row=${row}`);
    }
  }
  return bad;
}

/**
 * acquireLeases: racer a asks for two keys, racer b only for the second, both at once. When a writes the
 * first key and then loses the second to b, a must hold neither afterwards (its write rolled back).
 *
 * A loss can also come at a's read, before it wrote anything, and from outside the two cannot be told
 * apart. That the write-then-lose path is reached was shown by a mutation run (the PR has it): with the
 * rollback throw in acquireLeases swapped for a plain return, this test fails with a holding k1.
 */
async function raceSet(a: Store, b: Store, tag: string): Promise<{ bad: string[]; aLost: number }> {
  const bad: string[] = [];
  let aLost = 0;
  for (let i = 0; i < ROUNDS; i++) {
    const k1 = `ticket:race-${tag}-${i}`;
    const k2 = `worktree:/race-${tag}-${i}`;
    const [ra, rb] = await Promise.all([
      acquireLeases(a, [k1, k2], "holder-a", 600),
      acquireLeases(b, [k2], "holder-b", 600),
    ]);
    const rows = [await holderOf(a, k1), await holderOf(a, k2)];
    const want = ra.ok && !rb.ok ? ["holder-a", "holder-a"] : !ra.ok && rb.ok ? [null, "holder-b"] : null;
    if (!ra.ok) aLost++;
    if (!want || rows[0] !== want[0] || rows[1] !== want[1]) {
      bad.push(`round ${i}: a=${JSON.stringify(ra)} b=${JSON.stringify(rb)} rows=${JSON.stringify(rows)}`);
    }
  }
  return { bad, aLost };
}

/** Two stores on one fresh Postgres database (two separate connections), dropped afterwards. */
async function withTwoPgStores(body: (a: Store, b: Store) => Promise<void>): Promise<void> {
  const db = await freshPgDatabase({ empty: true });
  const connection = db.options as unknown as Record<string, unknown>;
  let a: Store | undefined;
  let b: Store | undefined;
  try {
    a = await openStore({ kind: "postgres", connection });
    b = await openStore({ kind: "postgres", connection, migrate: false });
    await body(a, b);
  } finally {
    await a?.close();
    await b?.close();
    await db.drop();
  }
}

/**
 * Two handles on one SQLite file. busy_timeout is set to 0 on both so a contended BEGIN IMMEDIATE comes
 * back BUSY at once and the store's async retry waits it out: the default 5s busy_timeout blocks the one
 * thread both handles share, so the holder could never commit.
 */
async function withTwoSqliteStores(body: (a: Store, b: Store) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ob-2288-"));
  const path = join(dir, "ob.db");
  const previousCreate = process.env.OMNISLASH_DB_CREATE;
  process.env.OMNISLASH_DB_CREATE = "1";
  let a: Store | undefined;
  let b: Store | undefined;
  try {
    a = await openStore({ kind: "sqlite", path });
    b = await openStore({ kind: "sqlite", path });
    for (const s of [a, b]) s.sqlite?.exec("PRAGMA busy_timeout = 0;");
    await body(a, b);
  } finally {
    await a?.close();
    await b?.close();
    if (previousCreate === undefined) delete process.env.OMNISLASH_DB_CREATE;
    else process.env.OMNISLASH_DB_CREATE = previousCreate;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("OB-2288: concurrent lease acquire on Postgres", () => {
  test(
    "acquireLease: two acquirers started together, exactly one holds the slot",
    () =>
      withTwoPgStores(async (a, b) => {
        expect(await raceSingle(a, b, "pg")).toEqual([]);
      }),
    BUDGET,
  );

  test(
    "acquireLeases: a racer that loses one key holds neither",
    () =>
      withTwoPgStores(async (a, b) => {
        const { bad, aLost } = await raceSet(a, b, "pg");
        expect(bad).toEqual([]);
        // Both racers must win some rounds, or the race was never run.
        expect(aLost).toBeGreaterThan(0);
        expect(aLost).toBeLessThan(ROUNDS);
      }),
    BUDGET,
  );
});

describe("OB-2288: concurrent lease acquire on SQLite", () => {
  test(
    "acquireLease: exactly one holds the slot",
    () =>
      withTwoSqliteStores(async (a, b) => {
        expect(await raceSingle(a, b, "sqlite")).toEqual([]);
      }),
    BUDGET,
  );

  test(
    "acquireLeases: a racer that loses one key holds neither",
    () =>
      withTwoSqliteStores(async (a, b) => {
        expect((await raceSet(a, b, "sqlite")).bad).toEqual([]);
      }),
    BUDGET,
  );
});

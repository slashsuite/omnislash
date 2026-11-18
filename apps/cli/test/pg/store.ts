// ob 337: a Postgres `Store` for a module test, on the real migration chain.
//
// The connector tests used to open an in-memory bun:sqlite database with `freshDb()`. Their modules read
// and write through a `Store` now, and the SQLite path is gone, so they need the equivalent: a database
// of this test's own, with the REAL chain in it, reachable through the same seam the CLI uses.
//
// OB-2022: it leases a pooled copy of a real-schema template (`leaseRealPgDb`) rather than creating a
// database and replaying the chain per test, which was the gate's IO flake under load.
//
// NEVER THE LIVE DATABASE: the harness cluster has no TCP listener at all, so a test can only reach it
// through a unix socket in a directory the test process just created. There is no host on which the
// Mac's Postgres or the server's could be dialled by accident.
import type { SQL } from "bun";
import { freshPgDatabase, trackPgRelease } from "./harness.ts";
import { applyPgChain, leaseRealPgDb } from "./real-schema.ts";
import { openStore, type Store } from "../../src/db/store.ts";

export interface PgStoreLease {
  store: Store;
  /** The raw Bun SQL connection, for a test that asserts on rows directly rather than through a module. */
  sql: SQL;
  /** Close the store and hand the database back, emptied. Safe to call twice. */
  release(): Promise<void>;
}

/**
 * A Store backed by a pooled Postgres database with the real chain in it, empty.
 *
 * `openStore` rather than `getStore`: the per-process singleton is what cli.ts uses, and a module test
 * that took it would leak its connection into the next test file.
 *
 * `{ changesSchema: true }` is for a test that adds a function, trigger, column or table: a pooled database
 * cannot be reset past that (its release fails, naming this), so such a test gets a database of its own,
 * built and dropped the slow way.
 */
export async function freshPgStore(opts: { changesSchema?: boolean } = {}): Promise<PgStoreLease> {
  const lease = opts.changesSchema ? await ownRealPgDatabase() : await leaseRealPgDb();
  const store = await openStore({
    kind: "postgres",
    // `max: 2` is not a tuning knob, it is a correctness one. Bun's SQL client pools ~10 connections by
    // DEFAULT and the cluster's max_connections is 100, so a file taking a database per test ran the
    // cluster out of backend slots and its later tests HUNG waiting for one rather than failing --
    // measured on whatsapp-send.test.ts, where tests 11 and 12 stalled and everything before them passed.
    // Two is what a module test needs: one query at a time, plus the connection `store.txn` reserves.
    connection: { ...(lease.options as unknown as Record<string, unknown>), max: 2 },
  });
  let released = false;
  let untrack = () => {};
  const release = async () => {
    if (released) return;
    released = true;
    untrack();
    // Here it has to be RELEASE FIRST, then close. `release()` ends every other backend on the database
    // before it resets it (it used to be `DROP DATABASE ... WITH (FORCE)`, which did the same);
    // `store.close()` is `client.end()`, which WAITS for the pool to drain and does not return while a
    // connection is still reserved, as a store under test can leave one. Measured: closing first hung
    // whatsapp-send.test.ts from its seventh test onward -- each release stalled, and the stall was
    // reported as a timeout in the NEXT test. A test holding no reserved connection may close first.
    try {
      await lease.release();
    } finally {
      await store.close().catch(() => {});
    }
  };
  // OB-1960: the harness's `afterEach` releases the lease of a test that threw or timed out, which resets
  // the database under this store; its client was never closed and was left holding dead connections. The
  // harness now runs this release too (after the lease's own, which is already registered, so the order
  // above holds). A test that releases itself untracks it first.
  untrack = trackPgRelease(release);
  return { store, sql: lease.sql, release };
}

/** A database of the test's own with the real chain in it, released by dropping it. */
async function ownRealPgDatabase(): Promise<{ sql: SQL; options: unknown; release(): Promise<void> }> {
  const db = await freshPgDatabase({ empty: true });
  try {
    await applyPgChain(db.sql);
  } catch (err) {
    await db.drop();
    throw err;
  }
  return { sql: db.sql, options: db.options, release: () => db.drop() };
}

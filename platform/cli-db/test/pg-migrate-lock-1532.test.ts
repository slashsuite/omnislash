import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import {
	applyPgMigrations,
	PgMigrationError,
	PgMigrationLockError,
	type PgPool,
	type PgSql,
} from "../../../apps/cli/src/db/pg/migrate.ts";
import { freshPgDatabase, type PgDatabase } from "../../../apps/cli/test/pg/harness.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const PG_BUDGET = spawnBudget(3);
const LOCK_KEY = 587336;

/** Sessions in THIS database still holding the migration lock, read from pg_locks. */
async function lockHolders(db: PgDatabase): Promise<number[]> {
	const rows = (await db.sql.unsafe(
		`SELECT l.pid FROM pg_locks l JOIN pg_database d ON d.oid = l.database
      WHERE l.locktype = 'advisory' AND l.objid = ${LOCK_KEY} AND l.granted AND d.datname = current_database()`,
	)) as { pid: number }[];
	return rows.map((r) => r.pid);
}

function pool(db: PgDatabase, max: number): SQL {
	return new SQL({ ...db.options, max } as unknown as string);
}

describe("ob 1532: the migration lock cannot leak across a pool", () => {
	test(
		"concurrent openers on pools of 3 all succeed and no session keeps 587336",
		async () => {
			const db = await freshPgDatabase({ empty: true });
			const pools = [pool(db, 3), pool(db, 3), pool(db, 3)];
			try {
				await Promise.all(pools.map((p) => applyPgMigrations(p)));
				// Every pool still has its connections open, so a leaked lock would still show here.
				await Promise.all(pools.map((p) => p.unsafe("SELECT 1")));
				expect(await lockHolders(db)).toEqual([]);
				// And the lock is free to take again at once, from any of them.
				await applyPgMigrations(pools[0]!, { lockTimeoutMs: 1000 });
				expect(await lockHolders(db)).toEqual([]);
			} finally {
				await Promise.all(pools.map((p) => p.end().catch(() => {})));
				await db.drop();
			}
		},
		PG_BUDGET,
	);

	test(
		"a failing migration still releases the lock and leaves lock_timeout reset",
		async () => {
			const db = await freshPgDatabase({ empty: true });
			const p = pool(db, 1);
			try {
				// 0000 is not applied (most of its objects are missing), so it runs and collides on "agent".
				await p.unsafe(`CREATE TABLE "agent" (x int)`);
				await expect(applyPgMigrations(p)).rejects.toBeInstanceOf(PgMigrationError);
				await p.unsafe("SELECT 1");
				expect(await lockHolders(db)).toEqual([]);
				const rows = (await p.unsafe("SHOW lock_timeout")) as { lock_timeout: string }[];
				expect(rows[0]?.lock_timeout).toBe("0");
			} finally {
				await p.end().catch(() => {});
				await db.drop();
			}
		},
		PG_BUDGET,
	);

	test(
		"a held lock fails fast with an error naming it, instead of waiting forever",
		async () => {
			const db = await freshPgDatabase({ empty: true });
			const holder = pool(db, 1);
			const opener = pool(db, 2);
			try {
				await holder.unsafe(`SELECT pg_advisory_lock(${LOCK_KEY})`);
				const started = Date.now();
				const err = await applyPgMigrations(opener, { lockTimeoutMs: 300 }).catch((e: unknown) => e);
				expect(err).toBeInstanceOf(PgMigrationLockError);
				expect(String((err as Error).message)).toContain(`pg_advisory_lock(${LOCK_KEY})`);
				expect(Date.now() - started).toBeLessThan(10_000);
				await holder.unsafe(`SELECT pg_advisory_unlock(${LOCK_KEY})`);
				await applyPgMigrations(opener, { lockTimeoutMs: 1000 });
				expect(await lockHolders(db)).toEqual([]);
			} finally {
				await holder.end().catch(() => {});
				await opener.end().catch(() => {});
				await db.drop();
			}
		},
		PG_BUDGET,
	);

	test(
		"an unlock that lands on another session (the 1532 leak) throws instead of passing silently",
		async () => {
			const db = await freshPgDatabase({ empty: true });
			const p = pool(db, 2);
			const a = await p.reserve();
			const b = await p.reserve();
			// A "pinned" connection that routes the unlock to a different backend, as an unpinned pool could.
			const pinned: PgSql & { release(): void } = {
				unsafe: (q) => (q.includes("pg_advisory_unlock") ? b.unsafe(q) : a.unsafe(q)),
				begin: (fn) => a.begin((tx) => fn(tx as unknown as PgSql)),
				release: () => {},
			};
			const split: PgPool = { ...pinned, reserve: async () => pinned };
			try {
				const err = await applyPgMigrations(split).catch((e: unknown) => e);
				expect(err).toBeInstanceOf(PgMigrationLockError);
				expect(String((err as Error).message)).toContain("released nothing");
			} finally {
				await Promise.allSettled([a.release(), b.release()]);
				await p.end().catch(() => {});
				await db.drop();
			}
		},
		PG_BUDGET,
	);
});

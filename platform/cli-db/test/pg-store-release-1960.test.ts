// OB-1960 -- a test that throws or times out while holding a `freshPgStore` never calls its `release()`, and the
// harness's afterEach (`releasePgLeases`) used to give back only the LEASE: it reset the database under the
// store, whose own client was left open on dead connections. A later query on it then failed with
// "Connection closed" as an unhandled error between tests, named for no test. The harness now closes the
// store as well.
import type { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { releasePgLeases } from "../../../apps/cli/test/pg/harness.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import { freshPgStore } from "../../../apps/cli/test/pg/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";

/** Run SQL through the store's own client (a Postgres store's `q` has `execute`; the Store type is the SQLite one). */
function run(store: Store, query: ReturnType<typeof sql>): Promise<unknown> {
	return (store.q as unknown as { execute(q: unknown): Promise<unknown> }).execute(query);
}

/** Settles with how the promise ended, or "hung" if it did not end within `ms`. */
async function outcome(p: Promise<unknown>, ms = 3000): Promise<"resolved" | "rejected" | "hung"> {
	return Promise.race([
		p.then(
			() => "resolved" as const,
			() => "rejected" as const,
		),
		Bun.sleep(ms).then(() => "hung" as const),
	]);
}

/**
 * Resolves once another backend on this database is running `text` (pg_stat_activity says `active`). Polled
 * on the lease's own connection, which the store under test does not share. Gives up well inside the test's
 * budget, so a query that never starts fails the test here rather than leaving this loop polling after it.
 */
async function queryRunning(conn: SQL, text: string, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const rows = (await conn.unsafe(
			`SELECT 1 FROM pg_stat_activity
			  WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active' AND position($1 in query) > 0`,
			[text],
		)) as unknown[];
		if (rows.length > 0) return;
		await Bun.sleep(10);
	}
	throw new Error(`no backend was running ${text} after ${ms}ms`);
}

const PG_BUDGET = spawnBudget(3);

describe("freshPgStore under the harness's afterEach (OB-1960)", () => {
	test("a store its test never released is closed by releasePgLeases, and its slot is free", async () => {
		const held = await freshPgStore();
		const name = ((await held.sql.unsafe(`SELECT current_database() AS d`)) as { d: string }[])[0]!.d;
		// Works while it is open.
		expect(await outcome(run(held.store, sql`select 1`))).toBe("resolved");

		// What the afterEach does for a test that threw or timed out before releasing.
		await releasePgLeases();

		// Closed: a query on it rejects promptly rather than hanging on a dead connection.
		expect(await outcome(run(held.store, sql`select 1`))).toBe("rejected");

		// The slot is free again: the next lease takes the same pooled database.
		const next = await leaseRealPgDb();
		try {
			expect(next.name).toBe(name);
		} finally {
			await next.release();
		}
	}, PG_BUDGET);

	test("a store with a query still in flight is closed too, and the harness says whose it is", async () => {
		const held = await freshPgStore();
		const stderr: string[] = [];
		const write = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let slow: Promise<unknown>;
		try {
			slow = run(held.store, sql`select pg_sleep(30)`);
			slow.catch(() => {}); // the orphaned body's await, which fails once the harness ends its backend
			// OB-2029: wait until Postgres itself says the query is running. A fixed sleep here raced under load:
			// the query had not reached its backend yet, so the harness ended an idle backend and said nothing.
			await queryRunning(held.sql, "pg_sleep(30)");
			await releasePgLeases();
		} finally {
			process.stderr.write = write;
		}
		expect(await outcome(slow)).toBe("rejected");
		expect(stderr.join("")).toContain("ended 1 backend(s) mid-query");
		expect(stderr.join("")).toContain("pg_sleep(30)");
	}, PG_BUDGET);
});

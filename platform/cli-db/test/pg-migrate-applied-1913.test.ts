import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { type Migration, PgMigrationError, readMigrations, runMigrations } from "../../../apps/cli/src/db/pg/migrate.ts";
import { freshPgDatabase } from "../../../apps/cli/test/pg/harness.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

// OB-1913: applied means recorded, per migration, on the postgres chain too. Fixture chains go straight
// to runMigrations on a throwaway database (the test seam); applyPgMigrations keeps the real journal.

const PG_BUDGET = spawnBudget(3);

type Sql = { unsafe(q: string): Promise<unknown> };

function fixture(tag: string, when: number, sql: string): Migration {
	return {
		tag,
		when,
		hash: createHash("sha256").update(sql).digest("hex"),
		statements: sql.split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => s.length > 0),
	};
}

async function bookkeep(sql: Sql, m: Migration): Promise<void> {
	await sql.unsafe(`CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
	await sql.unsafe(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('${m.hash}', ${m.when})`);
}

async function isRecorded(sql: Sql, m: Migration): Promise<boolean> {
	const rows = (await sql.unsafe(`SELECT 1 AS n FROM "__drizzle_migrations" WHERE created_at = ${m.when}`)) as unknown[];
	return rows.length > 0;
}

async function tableExists(sql: Sql, name: string): Promise<boolean> {
	const rows = (await sql.unsafe(`SELECT to_regclass('public.${name}') AS r`)) as { r: string | null }[];
	return rows[0]?.r != null;
}

async function stderrOf(body: () => Promise<void>): Promise<string[]> {
	const spy = spyOn(console, "error").mockImplementation(() => {});
	try {
		await body();
		return spy.mock.calls.map((c) => c.map(String).join(" "));
	} finally {
		spy.mockRestore();
	}
}

describe("OB-1913: postgres migrations are applied by their own row", () => {
	test(
		"a migration with no row of its own while a later one is recorded is applied, and says so",
		async () => {
			const db = await freshPgDatabase({ empty: true });
			try {
				const a = fixture("0001_fixture_gap", 1000, `CREATE TABLE "gap_a" ("x" integer)`);
				const b = fixture("0002_fixture_later", 2000, `CREATE TABLE "gap_b" ("x" integer)`);
				await db.sql.unsafe(`CREATE TABLE "gap_b" ("x" integer)`);
				await bookkeep(db.sql, b);
				const lines = await stderrOf(() => runMigrations(db.sql, [a, b]));
				expect(await tableExists(db.sql, "gap_a")).toBe(true);
				expect(await isRecorded(db.sql, a)).toBe(true);
				expect(lines).toHaveLength(1);
				expect(lines[0]).toContain("0001_fixture_gap");
				expect(lines[0]).not.toContain("repaired");
			} finally {
				await db.drop();
			}
		},
		PG_BUDGET,
	);

	test(
		"an orphan whose tag is in REPLAY_DATA_ON_REPAIR gets its backfill run before it is recorded",
		async () => {
			const db = await freshPgDatabase({ empty: true });
			try {
				const m = fixture(
					"0015_per_project_refs",
					1000,
					`CREATE TABLE "replay_t" ("x" integer)\n--> statement-breakpoint\nUPDATE "replay_t" SET "x" = 1`,
				);
				await db.sql.unsafe(`CREATE TABLE "replay_t" ("x" integer)`);
				await db.sql.unsafe(`INSERT INTO "replay_t" VALUES (0)`);
				const lines = await stderrOf(() => runMigrations(db.sql, [m]));
				expect((await db.sql.unsafe(`SELECT "x" FROM "replay_t"`)) as { x: number }[]).toEqual([{ x: 1 }]);
				expect(await isRecorded(db.sql, m)).toBe(true);
				expect(lines.join("\n")).toContain("repaired migration 0015_per_project_refs");
			} finally {
				await db.drop();
			}
		},
		PG_BUDGET,
	);

	test(
		"an orphan with an unguarded data statement is refused by tag, and the database is unchanged",
		async () => {
			const db = await freshPgDatabase({ empty: true });
			try {
				const m = fixture(
					"0001_fixture_backfill",
					1000,
					`CREATE TABLE "unguarded_t" ("x" integer)\n--> statement-breakpoint\nUPDATE "unguarded_t" SET "x" = 1`,
				);
				await db.sql.unsafe(`CREATE TABLE "unguarded_t" ("x" integer)`);
				await db.sql.unsafe(`INSERT INTO "unguarded_t" VALUES (0)`);
				let thrown: unknown;
				const lines = await stderrOf(async () => {
					try {
						await runMigrations(db.sql, [m]);
					} catch (err) {
						thrown = err;
					}
				});
				expect(thrown).toBeInstanceOf(PgMigrationError);
				expect((thrown as PgMigrationError).tag).toBe("0001_fixture_backfill");
				expect((thrown as Error).message).toContain("backfill is not known safe to re-run");
				expect((await db.sql.unsafe(`SELECT "x" FROM "unguarded_t"`)) as { x: number }[]).toEqual([{ x: 0 }]);
				expect(await isRecorded(db.sql, m)).toBe(false);
				expect(lines).toEqual([]);
			} finally {
				await db.drop();
			}
		},
		PG_BUDGET,
	);

	test(
		"a data-only migration applies normally and is recorded",
		async () => {
			const db = await freshPgDatabase({ empty: true });
			try {
				const m = fixture("0001_fixture_data_only", 1000, `INSERT INTO "data_t" VALUES (5)`);
				await db.sql.unsafe(`CREATE TABLE "data_t" ("x" integer)`);
				const lines = await stderrOf(() => runMigrations(db.sql, [m]));
				expect((await db.sql.unsafe(`SELECT "x" FROM "data_t"`)) as { x: number }[]).toEqual([{ x: 5 }]);
				expect(await isRecorded(db.sql, m)).toBe(true);
				expect(lines).toEqual([]);
			} finally {
				await db.drop();
			}
		},
		PG_BUDGET,
	);

	test(
		"only the baseline recorded: the rest of the real chain applies through the ordinary path, no repair note",
		async () => {
			const db = await freshPgDatabase({ empty: true });
			try {
				const chain = readMigrations();
				await runMigrations(db.sql, chain.slice(0, 1));
				const lines = await stderrOf(() => runMigrations(db.sql));
				expect(lines).toEqual([]);
				for (const m of chain) expect(await isRecorded(db.sql, m)).toBe(true);
			} finally {
				await db.drop();
			}
		},
		PG_BUDGET,
	);
});

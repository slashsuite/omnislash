import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyPgMigrations, PG_MIGRATIONS_FOLDER } from "../../../apps/cli/src/db/pg/migrate.ts";
import { freshPgDatabase } from "../../../apps/cli/test/pg/harness.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const PG_BUDGET = spawnBudget(3);

function journal(): { tag: string; when: number }[] {
	return (
		JSON.parse(readFileSync(join(PG_MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
			entries: { tag: string; when: number }[];
		}
	).entries;
}

async function searchVecExpr(sql: { unsafe(q: string): Promise<unknown> }): Promise<string> {
	const rows = (await sql.unsafe(
		`SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
     FROM pg_attrdef d
     JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     JOIN pg_class c ON c.oid = d.adrelid
     WHERE c.relname = 'whatsapp_message' AND a.attname = 'search_vec'`,
	)) as { expr: string }[];
	return rows[0]?.expr ?? "";
}

async function indexOid(sql: { unsafe(q: string): Promise<unknown> }, name: string): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT c.oid::int AS oid FROM pg_class c WHERE c.relname = '${name.replace(/'/g, "''")}'`,
	)) as { oid: number }[];
	return rows[0]?.oid ?? 0;
}

async function hasSplits(sql: { unsafe(q: string): Promise<unknown> }): Promise<boolean> {
	const rows = (await sql.unsafe(`SELECT to_regclass('public.business_transaction_splits') AS r`)) as {
		r: string | null;
	}[];
	return rows[0]?.r != null;
}

async function recorded(sql: { unsafe(q: string): Promise<unknown> }, tag: string): Promise<boolean> {
	const when = journal().find((e) => e.tag === tag)?.when;
	if (when === undefined) throw new Error(`no journal entry ${tag}`);
	const rows = (await sql.unsafe(
		`SELECT 1 AS n FROM "__drizzle_migrations" WHERE created_at = ${when}`,
	)) as { n: number }[];
	return rows.length > 0;
}

describe("ob 587: postgres apply-on-open", () => {

	test(
		"second open is a no-op: 0006 is not replayed (index oid unchanged)",
		async () => {
			const db = await freshPgDatabase({ empty: true });
			try {
				await applyPgMigrations(db.sql);
				const oid = await indexOid(db.sql, "idx_whatsapp_message_search_vec");
				const expr = await searchVecExpr(db.sql);
				await applyPgMigrations(db.sql);
				expect(await indexOid(db.sql, "idx_whatsapp_message_search_vec")).toBe(oid);
				expect(await searchVecExpr(db.sql)).toBe(expr);
			} finally {
				await db.drop();
			}
		},
		PG_BUDGET,
	);

});

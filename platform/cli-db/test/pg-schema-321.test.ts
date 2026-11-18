import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as pgSchema from "../../../apps/cli/src/db/pg/schema.ts";
import * as sqliteSchema from "../../../apps/cli/src/db/schema.ts";

// 321: the Postgres port of the schema, guarded WITHOUT a database. SQLite stays authoritative until
// phase 6 (ob 326), so nothing here touches the live path -- these assertions exist because the port is
// the trunk phases 322/323/324 build on, and a drifted pg schema would be discovered three phases later.
//
// Four guards, each for a failure this migration can actually have:
//   * the ob 204 snapshot rule, re-armed for the pg chain (generate writes .sql + journal + snapshot).
//   * the ob 223 one-statement-per-chunk rule (a second statement in a chunk silently never runs).
//   * parity with the sqlite schema, so a table or column cannot be dropped in the retype.
//   * the MECHANICAL-TYPE rule (map decision 5): no timestamptz / boolean / jsonb may appear yet. That
//     modernisation is ob 327, and this test is what stops it leaking in early and making the port
//     unreviewable.

const PG_MIGRATIONS_DIR = join(import.meta.dir, "../../../apps/cli/src/db/pg/migrations");
const PG_META_DIR = join(PG_MIGRATIONS_DIR, "meta");

// The fts5 virtual tables and their shadow tables, deliberately NOT ported: Postgres full-text is a
// tsvector column with a GIN index on the source table, so none of this has an analogue. ob 322 built
// that side; these table names stay absent here forever.
const FTS_SEAM = new Set(
	["item", "pr_comment", "email", "slack", "whatsapp"].flatMap((base) => [
		`${base}_fts`,
		`${base}_fts_data`,
		`${base}_fts_idx`,
		`${base}_fts_content`,
		`${base}_fts_docsize`,
		`${base}_fts_config`,
	]),
);

type JournalEntry = { idx: number; tag: string };

function journalEntries(): JournalEntry[] {
	const raw = JSON.parse(readFileSync(join(PG_META_DIR, "_journal.json"), "utf8")) as {
		dialect: string;
		entries: JournalEntry[];
	};
	return [...raw.entries].sort((a, b) => a.idx - b.idx);
}

function snapshotPath(idx: number): string {
	return join(PG_META_DIR, `${String(idx).padStart(4, "0")}_snapshot.json`);
}

function pgTables(): Map<string, string[]> {
	const tables = new Map<string, string[]>();
	for (const value of Object.values(pgSchema)) {
		if (is(value, PgTable)) tables.set(getTableName(value), Object.keys(getTableColumns(value)).sort());
	}
	return tables;
}

function sqliteTables(): Map<string, string[]> {
	const tables = new Map<string, string[]>();
	for (const value of Object.values(sqliteSchema)) {
		if (is(value, SQLiteTable)) tables.set(getTableName(value), Object.keys(getTableColumns(value)).sort());
	}
	return tables;
}

function migrationSql(): { file: string; sql: string }[] {
	return readdirSync(PG_MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort()
		.map((file) => ({ file, sql: readFileSync(join(PG_MIGRATIONS_DIR, file), "utf8") }));
}

describe("postgres migration chain (321)", () => {
	test("the chain is a postgres chain that restarts at 0000", () => {
		const raw = JSON.parse(readFileSync(join(PG_META_DIR, "_journal.json"), "utf8")) as {
			dialect: string;
			entries: JournalEntry[];
		};
		expect(raw.dialect).toBe("postgresql");
		expect(raw.entries[0]?.idx).toBe(0);
	});

	test("the newest journal entry has a snapshot beside it (204)", () => {
		const entries = journalEntries();
		expect(entries.length).toBeGreaterThan(0);
		const last = entries[entries.length - 1]!;
		expect({ tag: last.tag, hasSnapshot: existsSync(snapshotPath(last.idx)) }).toEqual({
			tag: last.tag,
			hasSnapshot: true,
		});
	});

	test("that snapshot describes the tables the pg schema declares today (204)", () => {
		const entries = journalEntries();
		const last = entries[entries.length - 1]!;
		const snapshot = JSON.parse(readFileSync(snapshotPath(last.idx), "utf8")) as {
			tables: Record<string, unknown>;
		};
		// pg snapshots key tables as "<schema>.<table>"; the schema half is always public here.
		const snapshotNames = Object.keys(snapshot.tables)
			.map((k) => k.split(".").pop()!)
			.sort();
		expect(snapshotNames).toEqual([...pgTables().keys()].sort());
	});

	test("no snapshot is filed ahead of the journal", () => {
		const entries = journalEntries();
		const last = entries[entries.length - 1]!;
		expect(existsSync(snapshotPath(last.idx + 1))).toBe(false);
	});

	test("one statement per --> statement-breakpoint chunk (223)", () => {
		const offenders: string[] = [];
		for (const { file, sql } of migrationSql()) {
			for (const chunk of sql.split("--> statement-breakpoint")) {
				const body = chunk.trim().replace(/;\s*$/, "");
				if (body && body.includes(";")) offenders.push(`${file}: ${body.slice(0, 60)}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no constraint name collides once Postgres truncates it to 63 bytes", () => {
		// Postgres silently truncates identifiers at 63 bytes, so two long generated FK names can collide
		// into one. SQLite has no such limit, which is why this can only bite on this side.
		const seen = new Map<string, string>();
		const collisions: string[] = [];
		for (const { sql } of migrationSql()) {
			for (const match of sql.matchAll(/CONSTRAINT "([^"]+)"/g)) {
				const name = match[1]!;
				const truncated = name.slice(0, 63);
				const prior = seen.get(truncated);
				if (prior && prior !== name) collisions.push(`${prior} vs ${name}`);
				else seen.set(truncated, name);
			}
		}
		expect(collisions).toEqual([]);
	});
});

// ob 322: the ONE column the pg side has that sqlite does not. It is not a ported column, it is the
// replacement for a whole fts5 virtual table, so the parity check subtracts it rather than failing on it.
const SEARCH_COLUMN = "search_vec";

// The 5 corpora that had an fts5 virtual table on the sqlite side and now carry a generated tsvector
// column instead. Named explicitly so ADDING a sixth is a deliberate edit here, not a silent drift.
const SEARCH_TABLES = ["item", "pr_comment", "email_message", "slack_message", "whatsapp_message"];

describe("postgres schema parity with sqlite (321)", () => {
	test("every ported table keeps its sqlite name and columns", () => {
		const pg = pgTables();
		const sqlite = sqliteTables();
		const mismatches: string[] = [];
		for (const [name, allColumns] of pg) {
			const columns = allColumns.filter((c) => c !== SEARCH_COLUMN);
			const sqliteColumns = sqlite.get(name);
			if (!sqliteColumns) {
				mismatches.push(`${name}: no sqlite table of that name`);
				continue;
			}
			if (JSON.stringify(columns) !== JSON.stringify(sqliteColumns)) {
				mismatches.push(`${name}: ${JSON.stringify(columns)} vs sqlite ${JSON.stringify(sqliteColumns)}`);
			}
		}
		expect(mismatches).toEqual([]);
	});

	test("only the 5 fts5 corpora carry the extra search_vec column (322)", () => {
		const carriers = [...pgTables()]
			.filter(([, columns]) => columns.includes(SEARCH_COLUMN))
			.map(([name]) => name)
			.sort();
		expect(carriers).toEqual([...SEARCH_TABLES].sort());
	});

	test("every sqlite table is ported, except the fts seam left to 322", () => {
		const pg = pgTables();
		const missing = [...sqliteTables().keys()].filter((name) => !pg.has(name) && !FTS_SEAM.has(name)).sort();
		expect(missing).toEqual([]);
	});

	test("the fts5 tables are absent, replaced by tsvector columns (322)", () => {
		// This was 321's seam guard, and it stays: a fts5 shadow table appearing on the pg side would mean
		// someone translated the SQLite storage internals instead of using Postgres full-text. What CHANGED
		// with 322 is the other half of the assertion -- the replacement now has to be there too, because a
		// search_vec column without the fts5 tables is the finished state and neither one alone is.
		expect([...pgTables().keys()].filter((name) => FTS_SEAM.has(name))).toEqual([]);
		const tables = pgTables();
		const missing = SEARCH_TABLES.filter((name) => !tables.get(name)?.includes(SEARCH_COLUMN));
		expect(missing).toEqual([]);
	});
});

describe("mechanical 1:1 types only (321, map decision 5)", () => {
	test("no timestamptz, boolean, jsonb or bytea column has crept in", () => {
		// Modernising storage types is ob 327. Doing it here would mix a mechanical change with a semantic
		// one across 65 tables, which is exactly what the phase plan refuses.
		const offenders: string[] = [];
		for (const { file, sql } of migrationSql()) {
			for (const line of sql.split("\n")) {
				if (/\b(timestamp|timestamptz|boolean|jsonb|json|bytea|date|numeric)\b(?!.*to_char)/.test(line)) {
					// a column definition line looks like: "\t"col" <type> ..."
					if (/^\s*"[a-z0-9_]+"\s+(timestamp|timestamptz|boolean|jsonb|json|bytea|date|numeric)\b/.test(line)) {
						offenders.push(`${file}: ${line.trim()}`);
					}
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("every column is text or integer, plus 322's tsvector", () => {
		// tsvector is the one non-mechanical type in the schema and it is allowed here for the same reason
		// the parity check subtracts search_vec: it is not a retyped column, it is what an fts5 virtual
		// table becomes. Nothing else may join it -- timestamptz/boolean/jsonb is still ob 327.
		const types = new Set<string>();
		for (const table of Object.values(pgSchema)) {
			if (!is(table, PgTable)) continue;
			for (const column of Object.values(getTableColumns(table))) types.add(column.getSQLType());
		}
		expect([...types].sort()).toEqual(["integer", "text", "tsvector"]);
	});
});

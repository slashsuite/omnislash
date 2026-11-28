import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import { openDb } from "../../../apps/cli/src/db.ts";
import { type ExportReport, type PgClient, runExport } from "../../../apps/cli/src/pgexport.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";

// ob 323, the same exporter against a REAL Postgres carrying the REAL ob 321 baseline, with the source
// built by the REAL SQLite migration chain. This is the rehearsal the ob 326 cutover is judged against.
//
// It runs in the ordinary gate rather than behind an environment variable, because ob 325's harness puts
// an embedded Postgres 17 in reach with no server to point at and nothing to install: `leaseRealPgDb`
// hands back a database no other running test shares, inside a throwaway cluster, emptied again when the
// test ends (OB-2022: a pooled copy of a migrated template, no longer one built per test).
// So everything below is proof about a real server, produced offline, with no live instance in reach.
//
// A lease per TEST rather than per file, because the harness releases a lease after every test; each
// test therefore starts from the empty baseline and does its own load, which also makes them independent.

const OPTIONS = {
	sourcePath: "/fixture",
	dryRun: false,
	verifyOnly: false,
	truncate: false,
	allowMissingTargetTables: false,
	allowMissingTargetColumns: false,
};

/** The same seam the command wires to Bun's client, over the harness's connection. */
function client(sql: SQL): PgClient {
	return {
		async query(statement: string, params: unknown[] = []) {
			const rows = await sql.unsafe(statement, params);
			return (rows ?? []) as unknown as Record<string, unknown>[];
		},
	};
}

describe("the export against a real Postgres 17 (323)", () => {
	let pg: PgClient;
	let sourcePath: string;

	beforeAll(() => {
		sourcePath = join(mkdtempSync(join(tmpdir(), "ob323-live-")), "source.sqlite");
		const db = openDb(sourcePath, { create: true });
		const now = "2026-08-18 01:00:00";
		db.run(`INSERT INTO project (id, name, kind, created_at) VALUES ('side', 'Side work', 'side', ?)`, [now]);
		db.run(`INSERT INTO project (id, name, kind, created_at) VALUES ('home', 'Home', 'home', ?)`, [now]);
		db.run(
			`INSERT INTO item (id, type, title, body, status, project_id, priority, created_at, updated_at) VALUES
			 ('a', 'task', 'first', '', 'open', 'side', 1, ?, ?),
			 ('b', 'task', 'unicode ✈ 日本語 😀', NULL, 'open', 'home', NULL, ?, ?),
			 ('c', 'task', 'large', ?, 'done', NULL, 3, ?, ?)`,
			[now, now, now, now, "x".repeat(500000), now, now],
		);
		// Ids well past 1, so a sequence that was not re-set collides on the very next insert.
		db.run(`INSERT INTO tag (id, name) VALUES (7, 'alpha'), (4100, 'omega')`);
		db.run(`INSERT INTO item_tag (item_id, tag_id) VALUES ('a', 7), ('b', 4100)`);
		db.run(
			`INSERT INTO person (id, real_name, role, notes, created_at, updated_at) VALUES (91, 'Ada', NULL, '', ?, ?)`,
			[now, now],
		);
		db.run(
			`INSERT INTO event (id, ts, source, type, item_id, payload) VALUES (5000, ?, 'test', 'created', 'a', '{"k":"v ✈"}')`,
			[now],
		);
		db.close();
	});

	beforeEach(async () => {
		// No migration ledger: the exporter's target is a database `ob` has never opened (OB-2022).
		const database = await leaseRealPgDb({ ledger: false });
		pg = client(database.sql);
		// A pooled copy of a template holding the real 321 baseline plus its forward migrations (OB-2022),
		// applied exactly as the server ships the chain, one statement per chunk (the ob 223 rule). This is also the first time it has met Postgres 17: 321
		// was verified against 16, and the server the cutover targets runs 17.11. The full chain (not the
		// bare 0000 baseline) matters because the SQLite source the exporter reads is also fully migrated,
		// so the target must carry every column the source verifies — including the engine pickup.
	}, 120_000);

	async function load(overrides: Partial<typeof OPTIONS> = {}): Promise<ExportReport> {
		const db = openDb(sourcePath);
		try {
			return await runExport({ db, pg, options: { ...OPTIONS, sourcePath, ...overrides } });
		} finally {
			db.close();
		}
	}

	test("the 321 baseline applies to Postgres 17, which is the version the server actually runs", async () => {
		const version = await pg.query("SELECT current_setting('server_version') AS v");
		expect(String(version[0]!.v).startsWith("17.")).toBe(true);
		const tables = await pg.query(
			`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
		);
		expect(tables[0]!.n).toBe(46);
	}, 60_000);

	test("every one of the 46 ported tables is planned, loaded and verified on both sides", async () => {
		const report = await load();
		expect(report.failures).toEqual([]);
		expect(report.ok).toBe(true);
		expect(report.tables).toHaveLength(46);
		for (const table of report.tables) {
			expect({ table: table.table, rows: table.sourceRows, hash: table.sourceHash }).toEqual({
				table: table.table,
				rows: table.targetRows!,
				hash: table.targetHash!,
			});
		}
		const byName = new Map(report.tables.map((t) => [t.table, t]));
		expect(byName.get("item")!.targetRows).toBe(3);
		expect(byName.get("project")!.targetRows).toBe(2);
		expect(byName.get("item_tag")!.targetRows).toBe(2);
		// The seam, measured against the real chain rather than asserted: 94 SQLite tables, 62 ported (ob 1638 dropped the 8 Cue tables), 32
		// skipped (5 fts5 tables, their 25 shadow tables, sqlite_sequence and __drizzle_migrations).
		expect(report.expectedSkips).toHaveLength(32);
		expect(report.unexpectedSkips).toEqual([]);
	}, 60_000);

	test("the values themselves survive a real round trip, including the awkward ones", async () => {
		await load();
		const rows = await pg.query(`SELECT id, title, body, priority FROM item ORDER BY id`);
		expect(rows[0]).toMatchObject({ id: "a", title: "first", body: "", priority: 1 });
		expect(rows[1]).toMatchObject({ id: "b", title: "unicode ✈ 日本語 😀", body: null, priority: null });
		expect(String((rows[2] as { body: string }).body)).toHaveLength(500000);
		const events = await pg.query(`SELECT payload FROM event WHERE id = 5000`);
		expect(events[0]!.payload).toBe('{"k":"v ✈"}');
	}, 60_000);

	test("the foreign keys still resolve, which is why the ids were inserted rather than regenerated", async () => {
		await load();
		const joined = await pg.query(
			`SELECT i.id AS item_id, t.name AS tag FROM item_tag it
			 JOIN item i ON i.id = it.item_id JOIN tag t ON t.id = it.tag_id ORDER BY i.id`,
		);
		expect(joined).toEqual([
			{ item_id: "a", tag: "alpha" },
			{ item_id: "b", tag: "omega" },
		]);
	}, 60_000);

	test("THE 321 OBLIGATION: every identity sequence clears the ids that were inserted", async () => {
		await load();
		const identities = await pg.query(
			`SELECT c.relname AS table_name, a.attname AS column_name,
			        pg_get_serial_sequence(c.relname, a.attname) AS seq
			 FROM pg_class c
			 JOIN pg_namespace n ON n.oid = c.relnamespace
			 JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
			 WHERE n.nspname = 'public' AND c.relkind = 'r'
			   AND pg_get_serial_sequence(c.relname, a.attname) IS NOT NULL`,
		);
		expect(identities).toHaveLength(17);
		const collisions: string[] = [];
		for (const row of identities) {
			const table = String(row.table_name);
			const column = String(row.column_name);
			const state = await pg.query(`SELECT last_value, is_called FROM ${String(row.seq)}`);
			const last = Number(state[0]!.last_value);
			const next = state[0]!.is_called === true ? last + 1 : last;
			const max = await pg.query(`SELECT coalesce(max("${column}"), 0)::bigint AS m FROM "${table}"`);
			if (next <= Number(max[0]!.m)) collisions.push(`${table}.${column} would hand out ${next}`);
		}
		expect(collisions).toEqual([]);
	}, 60_000);

	test("and the next real insert therefore gets a fresh id rather than colliding", async () => {
		// tag already holds 4100. Postgres itself decides the id here; nothing supplies one, which is
		// exactly the shape of the first `ob add` after the cutover.
		await load();
		const inserted = await pg.query(`INSERT INTO tag (name) VALUES ('proof') RETURNING id`);
		expect(Number(inserted[0]!.id)).toBeGreaterThan(4100);
	}, 60_000);

	test("a second run against the loaded target refuses, and --truncate reloads it without doubling", async () => {
		await load();
		await expect(load()).rejects.toThrow(/already holds rows/);
		const again = await load({ truncate: true });
		expect(again.ok).toBe(true);
		expect(again.truncated).toBe(true);
		const counted = await pg.query(`SELECT count(*)::int AS n FROM item`);
		expect(counted[0]!.n).toBe(3);
		// Re-set again after the reload: RESTART IDENTITY had put every sequence back to 1.
		expect(again.sequences.filter((s) => !s.ok)).toEqual([]);
	}, 60_000);

	test("verify-only re-reads a target it did not load and agrees with it", async () => {
		await load();
		const report = await load({ verifyOnly: true });
		expect(report.mode).toBe("verify-only");
		expect(report.ok).toBe(true);
		expect(report.failures).toEqual([]);
	}, 60_000);

	test("verify-only catches a single changed character, which a row count never would", async () => {
		await load();
		await pg.query(`UPDATE item SET title = 'firsT' WHERE id = 'a'`);
		const report = await load({ verifyOnly: true });
		expect(report.ok).toBe(false);
		const item = report.tables.find((t) => t.table === "item")!;
		expect(item.sourceRows).toBe(item.targetRows!);
		expect(item.sourceHash).not.toBe(item.targetHash!);
		expect(report.failures.join(" ")).toContain("item:");
	}, 60_000);

	test("a dry run against a real target reads everything and leaves it empty", async () => {
		const report = await load({ dryRun: true });
		expect(report.ok).toBe(true);
		expect(report.tables).toHaveLength(46);
		const counted = await pg.query(`SELECT count(*)::int AS n FROM item`);
		expect(counted[0]!.n).toBe(0);
	}, 60_000);
});

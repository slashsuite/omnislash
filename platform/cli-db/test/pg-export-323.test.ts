import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CellError,
	Coercions,
	ExportRefusal,
	RowHash,
	batchSize,
	buildPlan,
	canonicalRow,
	coerceRow,
	describeSource,
	expectedSkip,
	hashTarget,
	loadOrder,
	readSequences,
	renderReport,
	runExport,
	sourceSelect,
	type PgClient,
	type TablePlan,
	type TargetTable,
} from "../../../apps/cli/src/pgexport.ts";
import { redactUrl, resolveTargetUrl } from "../../../apps/cli/src/commands/pgexport.ts";

// ob 323, the SQLite -> Postgres data move, guarded WITHOUT a Postgres at all. The live half of the proof
// is test/pg-export-live-323.test.ts, which runs the same exporter against a real embedded Postgres 17
// carrying the real 321 baseline; this file is the fast one, and it is where the refusals and the
// value-by-value judgements are pinned down.
//
// The fake below is not a Postgres emulator: it answers exactly the statements this exporter emits, all
// of which this repo generates, so matching them is deterministic rather than hopeful. What it DOES model
// faithfully is the three behaviours the exporter's correctness rests on -- transactional rollback, cursor
// reads, and identity sequences -- because those are the ones a test that stubbed them would prove nothing
// about.

interface FakeColumn {
	name: string;
	dataType: string;
	sequence?: string;
}

interface FakeSpec {
	[table: string]: { columns: FakeColumn[]; fks?: { column: string; parent: string }[] };
}

class FakePg implements PgClient {
	readonly rows = new Map<string, Record<string, unknown>[]>();
	readonly sequences = new Map<string, { last: number; isCalled: boolean }>();
	/** every table an INSERT touched, in order, so FK load order is assertable. */
	readonly insertOrder: string[] = [];
	readonly statements: string[] = [];
	/** set to a table name to make its next INSERT fail, which is how the rollback proof is staged. */
	failInsertOn: string | null = null;

	private snapshot: Map<string, Record<string, unknown>[]> | null = null;
	private cursor: { rows: Record<string, unknown>[]; pos: number } | null = null;

	constructor(private readonly spec: FakeSpec) {
		for (const [table, def] of Object.entries(spec)) {
			this.rows.set(table, []);
			for (const column of def.columns) {
				if (column.sequence) this.sequences.set(column.sequence, { last: 1, isCalled: false });
			}
		}
	}

	seed(table: string, rows: Record<string, unknown>[]): void {
		this.rows.set(table, [...rows]);
	}

	async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
		this.statements.push(sql);
		const text = sql.trim();

		if (text.includes("information_schema.columns")) {
			const out: Record<string, unknown>[] = [];
			for (const [table, def] of Object.entries(this.spec)) {
				for (const column of def.columns) {
					out.push({ t: table, c: column.name, d: column.dataType, seq: column.sequence ?? null });
				}
			}
			return out;
		}
		if (text.includes("pg_constraint")) {
			const out: Record<string, unknown>[] = [];
			for (const [table, def] of Object.entries(this.spec)) {
				for (const fk of def.fks ?? []) out.push({ child: table, parent: fk.parent });
			}
			return out;
		}
		if (text === "BEGIN" || text === "BEGIN READ ONLY") {
			this.snapshot = new Map([...this.rows].map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
			return [];
		}
		if (text === "COMMIT") {
			this.snapshot = null;
			return [];
		}
		if (text === "ROLLBACK") {
			if (this.snapshot) for (const [k, v] of this.snapshot) this.rows.set(k, v);
			this.snapshot = null;
			return [];
		}
		if (text.startsWith("TRUNCATE TABLE")) {
			for (const table of text
				.slice("TRUNCATE TABLE".length, text.indexOf(" RESTART IDENTITY"))
				.split(",")
				.map((t) => t.trim().replaceAll('"', ""))) {
				this.rows.set(table, []);
			}
			for (const value of this.sequences.values()) {
				value.last = 1;
				value.isCalled = false;
			}
			return [];
		}
		if (text.startsWith("INSERT INTO")) {
			const table = text.slice(text.indexOf('"') + 1, text.indexOf('"', text.indexOf('"') + 1));
			if (this.failInsertOn === table) throw new Error(`fake postgres: refusing the insert into ${table}`);
			const columns = text
				.slice(text.indexOf("(") + 1, text.indexOf(")"))
				.split(",")
				.map((c) => c.trim().replaceAll('"', ""));
			if (this.insertOrder[this.insertOrder.length - 1] !== table) this.insertOrder.push(table);
			const target = this.rows.get(table)!;
			for (let i = 0; i < params.length; i += columns.length) {
				const row: Record<string, unknown> = {};
				columns.forEach((name, j) => {
					row[name] = params[i + j];
				});
				target.push(row);
			}
			return [];
		}
		if (text.startsWith("SELECT 1 AS x FROM")) {
			const table = text.slice(text.indexOf('"') + 1, text.lastIndexOf('"'));
			return this.rows.get(table)!.length > 0 ? [{ x: 1 }] : [];
		}
		if (text.startsWith("SELECT count(*)::int")) {
			const table = text.slice(text.indexOf('"') + 1, text.lastIndexOf('"'));
			return [{ n: this.rows.get(table)!.length }];
		}
		if (text.startsWith("SELECT max(")) {
			const column = text.slice(text.indexOf('"') + 1, text.indexOf('"', text.indexOf('"') + 1));
			const table = text.slice(text.lastIndexOf('FROM "') + 6, text.lastIndexOf('"'));
			const values = this.rows
				.get(table)!
				.map((r) => r[column])
				.filter((v): v is number => typeof v === "number");
			return [{ max_id: values.length === 0 ? null : String(Math.max(...values)) }];
		}
		if (text.startsWith("SELECT setval(")) {
			const [sequence, value] = params as [string, number];
			this.sequences.set(sequence, { last: value, isCalled: false });
			return [{ setval: String(value) }];
		}
		if (text.startsWith("SELECT last_value")) {
			const sequence = text.slice(text.indexOf("FROM ") + 5).trim();
			const state = this.sequences.get(sequence);
			if (!state) throw new Error(`fake postgres: no sequence ${sequence}`);
			return [{ last_value: String(state.last), is_called: state.isCalled }];
		}
		if (text.startsWith("DECLARE")) {
			const columns = text
				.slice(text.indexOf("SELECT ") + 7, text.lastIndexOf(" FROM "))
				.split(",")
				.map((c) => c.trim().replaceAll('"', ""));
			const table = text.slice(text.lastIndexOf('FROM "') + 6, text.lastIndexOf('"'));
			this.cursor = {
				rows: this.rows.get(table)!.map((row) => {
					const out: Record<string, unknown> = {};
					for (const name of columns) out[name] = row[name] ?? null;
					return out;
				}),
				pos: 0,
			};
			return [];
		}
		if (text.startsWith("FETCH")) {
			const size = Number(text.split(" ")[1]);
			const cursor = this.cursor!;
			const slice = cursor.rows.slice(cursor.pos, cursor.pos + size);
			cursor.pos += slice.length;
			return slice;
		}
		if (text.startsWith("CLOSE")) {
			this.cursor = null;
			return [];
		}
		throw new Error(`fake postgres: unhandled statement ${text.slice(0, 80)}`);
	}
}

const temps: string[] = [];

function tempDb(statements: string[]): { db: Database; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "ob323-"));
	temps.push(dir);
	const path = join(dir, "source.sqlite");
	const db = new Database(path);
	for (const statement of statements) db.run(statement);
	return { db, path };
}

afterEach(() => {
	while (temps.length > 0) rmSync(temps.pop()!, { recursive: true, force: true });
});

/**
 * The fixture. Deliberately not a copy of anything live: it is synthesised to carry the awkward shapes a
 * 62 MB tracker plausibly holds -- a foreign key that forces a load order, an identity column whose ids
 * must survive, NULLs, empty strings, unicode, a large text value, and a table the target does not have.
 */
function fixture(): { db: Database; path: string; pg: FakePg } {
	const { db, path } = tempDb([
		`CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT NOT NULL, rank INTEGER)`,
		`CREATE TABLE item (id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id), title TEXT NOT NULL, body TEXT, triage INTEGER)`,
		`CREATE TABLE note (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT REFERENCES item(id), text TEXT)`,
		`CREATE TABLE item_fts (x)`,
		`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT)`,
	]);
	db.run(`INSERT INTO project VALUES ('side', 'Side work', 1), ('home', 'Home', NULL)`);
	db.run(
		`INSERT INTO item VALUES ('a', 'side', 'first', '', 0), ('b', 'home', 'unicode ✈ 日本語 😀', NULL, 1), ('c', NULL, 'orphan', ?, 0)`,
		["x".repeat(200000)],
	);
	db.run(`INSERT INTO note (id, item_id, text) VALUES (7, 'a', 'seven'), (41, 'b', NULL)`);
	db.run(`INSERT INTO item_fts VALUES ('ignored')`);
	db.run(`INSERT INTO __drizzle_migrations VALUES (1, 'deadbeef')`);

	const pg = new FakePg({
		project: { columns: [c("id", "text"), c("name", "text"), c("rank", "integer")] },
		item: {
			columns: [c("id", "text"), c("project_id", "text"), c("title", "text"), c("body", "text"), c("triage", "integer")],
			fks: [{ column: "project_id", parent: "project" }],
		},
		note: {
			columns: [
				{ name: "id", dataType: "integer", sequence: "public.note_id_seq" },
				c("item_id", "text"),
				c("text", "text"),
			],
			fks: [{ column: "item_id", parent: "item" }],
		},
	});
	return { db, path, pg };
}

function c(name: string, dataType: string): FakeColumn {
	return { name, dataType };
}

const OPTIONS = {
	sourcePath: "/fixture",
	dryRun: false,
	verifyOnly: false,
	truncate: false,
	allowMissingTargetTables: false,
	allowMissingTargetColumns: false,
};

describe("the command refuses to guess either end (323)", () => {
	test("the target is never defaulted, and never read from the environment", async () => {
		await expect(resolveTargetUrl({})).rejects.toThrow(/There is no default, on purpose/);
		await expect(resolveTargetUrl({ to: "postgres://x", "to-file": "/tmp/y" })).rejects.toThrow(/not both/);
	});

	test("a connection file keeps the password out of the shell history (ob 320's token file)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ob323-url-"));
		temps.push(dir);
		const path = join(dir, "pgurl");
		writeFileSync(path, "postgres://ob:secret@10.0.0.32/omnislash\n");
		expect(await resolveTargetUrl({ "to-file": path })).toBe("postgres://ob:secret@10.0.0.32/omnislash");
		await expect(resolveTargetUrl({ "to-file": join(dir, "absent") })).rejects.toThrow(/no such connection file/);
		writeFileSync(path, "\n");
		await expect(resolveTargetUrl({ "to-file": path })).rejects.toThrow(/is empty/);
	});

	test("the password is redacted wherever the target is echoed", () => {
		expect(redactUrl("postgres://ob:pa55word@10.0.0.32:5432/omnislash")).toBe(
			"postgres://ob:***@10.0.0.32:5432/omnislash",
		);
		expect(redactUrl("not a url at all")).toBe("<unparseable connection url>");
	});
});

describe("load order (323)", () => {
	test("a table is loaded only after everything it references", () => {
		const { order, cycle } = loadOrder(
			["note", "item", "project"],
			[
				{ child: "item", parent: "project" },
				{ child: "note", parent: "item" },
			],
		);
		expect(cycle).toEqual([]);
		expect(order).toEqual(["project", "item", "note"]);
	});

	test("a self-reference is not an ordering problem between tables", () => {
		const { order, cycle } = loadOrder(["item"], [{ child: "item", parent: "item" }]);
		expect({ order, cycle }).toEqual({ order: ["item"], cycle: [] });
	});

	test("a cycle is reported by name rather than worked around", () => {
		const { order, cycle } = loadOrder(
			["a", "b", "c"],
			[
				{ child: "a", parent: "b" },
				{ child: "b", parent: "a" },
				{ child: "c", parent: "a" },
			],
		);
		expect(order).toEqual([]);
		expect(cycle).toEqual(["a", "b", "c"]);
	});

	test("the order is deterministic, so two reports are diffable", () => {
		const edges = [{ child: "z", parent: "m" }];
		const first = loadOrder(["z", "m", "a", "b"], edges).order;
		const second = loadOrder(["b", "a", "m", "z"], edges).order;
		expect(first).toEqual(second);
	});
});

describe("the skip seam (323)", () => {
	test("fts5 tables, their shadow tables and sqlite's own bookkeeping are expected skips", () => {
		const skipped = [
			"item_fts",
			"item_fts_data",
			"whatsapp_fts_docsize",
			"pr_comment_fts_config",
			"sqlite_sequence",
			"__drizzle_migrations",
		].filter(expectedSkip);
		expect(skipped).toHaveLength(6);
	});

	test("an ordinary table is NOT an expected skip, so forgetting one is loud", () => {
		expect(["item", "person", "event"].filter(expectedSkip)).toEqual([]);
	});
});

describe("the content hash (323)", () => {
	test("null, the empty string, the string '5' and the integer 5 all digest differently", () => {
		const of = (value: string | number | null) => {
			const hash = new RowHash();
			hash.add(canonicalRow(["a"], new Map([["a", value]])));
			return hash.hex();
		};
		expect(new Set([of(null), of(""), of("5"), of(5)]).size).toBe(4);
	});

	test("row ORDER does not change the hash", () => {
		const rows = [1, 2, 3].map((n) => canonicalRow(["a"], new Map([["a", n]])));
		const forwards = new RowHash();
		for (const row of rows) forwards.add(row);
		const backwards = new RowHash();
		for (const row of [...rows].reverse()) backwards.add(row);
		expect(forwards.hex()).toBe(backwards.hex());
	});

	test("duplicate rows do NOT cancel out, which XOR would have let happen", () => {
		const row = canonicalRow(["a"], new Map([["a", 1]]));
		const once = new RowHash();
		once.add(row);
		const twice = new RowHash();
		twice.add(row);
		twice.add(row);
		const none = new RowHash();
		expect(twice.hex()).not.toBe(none.hex());
		expect(twice.hex()).not.toBe(once.hex());
	});

	test("a lost row changes the hash, so a right-count-wrong-content copy cannot pass", () => {
		const full = new RowHash();
		for (const n of [1, 2, 3]) full.add(canonicalRow(["a"], new Map([["a", n]])));
		const swapped = new RowHash();
		for (const n of [1, 2, 4]) swapped.add(canonicalRow(["a"], new Map([["a", n]])));
		expect(full.hex()).not.toBe(swapped.hex());
		expect(full.count).toBe(swapped.count);
	});

	test("column declaration order on either side cannot change the result", () => {
		const values = new Map<string, string | number | null>([
			["b", 2],
			["a", "x"],
		]);
		expect(canonicalRow(["a", "b"], values)).toBe(canonicalRow(["b", "a"], values));
	});
});

describe("batching (323)", () => {
	test("a batch never approaches Postgres's 65535 bind-parameter ceiling", () => {
		for (const columns of [1, 5, 17, 64, 300]) {
			expect(batchSize(columns) * columns).toBeLessThan(65535);
			expect(batchSize(columns)).toBeGreaterThan(0);
		}
	});
});

describe("SQLite's loose typing (323)", () => {
	const plan = (kind: "integer" | "text"): TablePlan => ({
		table: "t",
		columns: [{ name: "v", kind }],
		targetOnlyColumns: [],
		sourceOnlyColumns: [],
		sequences: [],
		hasRowid: true,
	});

	function cell(kind: "integer" | "text", storage: string, value: unknown, rendered?: unknown) {
		const coercions = new Coercions();
		const row = { __rowid: 12, __t0: storage, __v0: value, __s0: rendered ?? value };
		return { result: () => coerceRow(plan(kind), row, coercions), coercions };
	}

	test("NULL survives as NULL on both column kinds", () => {
		expect(cell("integer", "null", null).result()).toEqual([null]);
		expect(cell("text", "null", null, null).result()).toEqual([null]);
	});

	test("the empty string is not confused with NULL", () => {
		expect(cell("text", "text", "", "").result()).toEqual([""]);
	});

	test("unicode and a very large text value pass through untouched", () => {
		const big = `${"日本語 ✈ 😀".repeat(10)}${"x".repeat(500000)}`;
		expect(cell("text", "text", big, big).result()).toEqual([big]);
	});

	test("an integer too wide for int4 is REFUSED, never truncated (the *_cents columns)", () => {
		expect(() => cell("integer", "integer", 3000000000).result()).toThrow(CellError);
		expect(() => cell("integer", "integer", 3000000000).result()).toThrow(/does not fit a Postgres integer/);
	});

	test("a real with no lossless integer form is refused", () => {
		expect(() => cell("integer", "real", 3.7).result()).toThrow(/no lossless integer form/);
	});

	test("a real that IS an integer is taken, and counted as a coercion", () => {
		const { result, coercions } = cell("integer", "real", 4);
		expect(result()).toEqual([4]);
		expect(coercions.all()[0]).toMatchObject({ table: "t", column: "v", from: "real", count: 1 });
	});

	test("a numeric string in an integer column is taken and counted; a non-numeric one is refused", () => {
		const numeric = cell("integer", "text", "42");
		expect(numeric.result()).toEqual([42]);
		expect(numeric.coercions.all()[0]?.from).toBe("text");
		expect(() => cell("integer", "text", "abc").result()).toThrow(/is not an integer/);
	});

	test("a blob in a text column is refused, naming the row", () => {
		expect(() => cell("text", "blob", new Uint8Array([1, 2]), null).result()).toThrow(/rowid 12/);
		expect(() => cell("text", "blob", new Uint8Array([1, 2]), null).result()).toThrow(/blob/);
	});

	test("a NUL byte is refused HERE, where the table and row are still known", () => {
		const nul = `a${String.fromCharCode(0)}b`;
		expect(() => cell("text", "text", nul, nul).result()).toThrow(/NUL byte/);
		expect(() => cell("text", "text", nul, nul).result()).toThrow(/t\.v rowid 12/);
	});

	test("text is rendered by SQLite's own CAST, not JavaScript's String()", () => {
		// String(3.0) is "3" where SQLite writes "3.0"; the exporter takes the rendered column, so a
		// one-character content change cannot slip through a text column.
		expect(sourceSelect(plan("text"))).toContain("CAST(\"v\" AS TEXT)");
		expect(cell("text", "real", 3, "3.0").result()).toEqual(["3.0"]);
	});

	test("the select carries a storage type for every column, which is what makes all of the above possible", () => {
		expect(sourceSelect(plan("integer"))).toBe(
			'SELECT rowid AS __rowid, typeof("v") AS __t0, "v" AS __v0 FROM "t"',
		);
	});
});

describe("planning against the real target shape (323)", () => {
	test("a target-only column is left to its default rather than copied (ob 322's tsvector)", () => {
		const { db, pg } = fixture();
		try {
			const target: TargetTable[] = [
				{
					name: "project",
					columns: [
						{ name: "id", dataType: "text", sequence: null },
						{ name: "name", dataType: "text", sequence: null },
						{ name: "rank", dataType: "integer", sequence: null },
						{ name: "search_vec", dataType: "USER-DEFINED", sequence: null },
					],
				},
			];
			const plan = buildPlan({ source: describeSource(db), target, edges: [] });
			expect(plan.problems).toEqual([]);
			expect(plan.tables[0]!.columns.map((c) => c.name)).toEqual(["id", "name", "rank"]);
			expect(plan.tables[0]!.targetOnlyColumns).toEqual(["search_vec"]);
			expect(pg.statements).toEqual([]);
		} finally {
			db.close();
		}
	});

	test("a target column this exporter cannot fill from SQLite is a problem, not a guess", () => {
		const { db } = fixture();
		try {
			const plan = buildPlan({
				source: describeSource(db),
				target: [
					{
						name: "project",
						columns: [
							{ name: "id", dataType: "text", sequence: null },
							{ name: "rank", dataType: "timestamp with time zone", sequence: null },
						],
					},
				],
				edges: [],
			});
			expect(plan.problems.join(" ")).toContain("neither integer nor text");
		} finally {
			db.close();
		}
	});
});

describe("the export end to end (323)", () => {
	test("every table matches on row count AND content hash, and the report says so per table", async () => {
		const { db, pg } = fixture();
		try {
			const report = await runExport({ db, pg, options: { ...OPTIONS } });
			expect(report.failures).toEqual([]);
			expect(report.ok).toBe(true);
			expect(report.tables.map((t) => [t.table, t.sourceRows, t.targetRows])).toEqual([
				["project", 2, 2],
				["item", 3, 3],
				["note", 2, 2],
			]);
			for (const table of report.tables) {
				expect(table.sourceHash).toBe(table.targetHash!);
				expect(table.sourceHash).toHaveLength(64);
				expect(table.ok).toBe(true);
			}
		} finally {
			db.close();
		}
	});

	test("foreign keys decide the load order, so no insert lands before its parent", async () => {
		const { db, pg } = fixture();
		try {
			await runExport({ db, pg, options: { ...OPTIONS } });
			expect(pg.insertOrder).toEqual(["project", "item", "note"]);
		} finally {
			db.close();
		}
	});

	test("the existing ids are inserted unchanged, so the foreign keys still resolve", async () => {
		const { db, pg } = fixture();
		try {
			await runExport({ db, pg, options: { ...OPTIONS } });
			expect(pg.rows.get("note")!.map((r) => r.id)).toEqual([7, 41]);
			expect(pg.rows.get("item")!.map((r) => r.project_id)).toEqual(["side", "home", null]);
		} finally {
			db.close();
		}
	});

	test("empty strings, NULLs and unicode survive the round trip byte for byte", async () => {
		const { db, pg } = fixture();
		try {
			await runExport({ db, pg, options: { ...OPTIONS } });
			const items = pg.rows.get("item")!;
			expect(items[0]!.body).toBe("");
			expect(items[1]!.body).toBe(null);
			expect(items[1]!.title).toBe("unicode ✈ 日本語 😀");
			expect(String(items[2]!.body)).toHaveLength(200000);
			expect(pg.rows.get("project")!.map((r) => r.rank)).toEqual([1, null]);
		} finally {
			db.close();
		}
	});

	test("fts5 tables and __drizzle_migrations are skipped by design and SAID SO in the report", async () => {
		const { db, pg } = fixture();
		try {
			const report = await runExport({ db, pg, options: { ...OPTIONS } });
			// sqlite_sequence is SQLite's own AUTOINCREMENT bookkeeping, and the Postgres side keeps that
			// state in the identity sequences instead, so it is skipped for the same reason.
			expect(report.expectedSkips.sort()).toEqual(["__drizzle_migrations", "item_fts", "sqlite_sequence"]);
			expect(report.unexpectedSkips).toEqual([]);
		} finally {
			db.close();
		}
	});
});

describe("THE SEQUENCE OBLIGATION ob 321 handed 323", () => {
	test("each identity sequence is re-set past the largest id that was inserted", async () => {
		const { db, pg } = fixture();
		try {
			const report = await runExport({ db, pg, options: { ...OPTIONS } });
			expect(report.sequences).toHaveLength(1);
			const sequence = report.sequences[0]!;
			expect(sequence).toMatchObject({ table: "note", column: "id", maxId: 41, nextValue: 42, ok: true });
		} finally {
			db.close();
		}
	});

	test("the very next insert therefore does NOT collide with a row that is already there", async () => {
		const { db, pg } = fixture();
		try {
			await runExport({ db, pg, options: { ...OPTIONS } });
			const state = pg.sequences.get("public.note_id_seq")!;
			const nextId = state.isCalled ? state.last + 1 : state.last;
			expect(pg.rows.get("note")!.some((r) => r.id === nextId)).toBe(false);
		} finally {
			db.close();
		}
	});

	test("a sequence left un-reset FAILS verification instead of passing quietly", async () => {
		// The whole point of reporting the sequence: this is the shape the cutover would have shipped if
		// resetSequences() were ever dropped, and it must be a failure rather than a silent success.
		const pg = new FakePg({ note: { columns: [{ name: "id", dataType: "integer", sequence: "s" }] } });
		pg.sequences.set("s", { last: 1, isCalled: false });
		const checked = await readSequences(pg, [
			{ table: "note", column: "id", sequence: "s", maxId: 41, nextValue: 0, ok: false },
		]);
		expect(checked[0]).toMatchObject({ nextValue: 1, ok: false });
		expect(renderReport({
			mode: "load",
			source: "/fixture",
			startedAt: "t0",
			finishedAt: "t1",
			tables: [],
			sequences: checked,
			coercions: [],
			expectedSkips: [],
			unexpectedSkips: [],
			targetOnlyTables: [],
			targetOnlyColumns: [],
			truncated: false,
			ok: false,
			failures: ["note.id would collide"],
		})).toContain("WOULD COLLIDE");
	});
});

describe("idempotency: it refuses a target it did not empty (323)", () => {
	test("a second run against a loaded target REFUSES, naming the tables that already hold rows", async () => {
		const { db, pg } = fixture();
		try {
			await runExport({ db, pg, options: { ...OPTIONS } });
			const before = pg.rows.get("item")!.length;
			await expect(runExport({ db, pg, options: { ...OPTIONS } })).rejects.toThrow(ExportRefusal);
			await expect(runExport({ db, pg, options: { ...OPTIONS } })).rejects.toThrow(/already holds rows/);
			expect(pg.rows.get("item")!.length).toBe(before);
		} finally {
			db.close();
		}
	});

	test("--truncate is the deliberate opposite, and re-running does not double the rows", async () => {
		const { db, pg } = fixture();
		try {
			await runExport({ db, pg, options: { ...OPTIONS } });
			const second = await runExport({ db, pg, options: { ...OPTIONS, truncate: true } });
			expect(second.truncated).toBe(true);
			expect(second.ok).toBe(true);
			expect(second.tables.map((t) => t.targetRows)).toEqual([2, 3, 2]);
			expect(pg.rows.get("item")!).toHaveLength(3);
			expect(second.sequences[0]).toMatchObject({ maxId: 41, nextValue: 42, ok: true });
		} finally {
			db.close();
		}
	});

	test("a failure part way through leaves the target exactly as it was, never half loaded", async () => {
		const { db, pg } = fixture();
		try {
			pg.failInsertOn = "note";
			await expect(runExport({ db, pg, options: { ...OPTIONS } })).rejects.toThrow(/refusing the insert/);
			expect(pg.rows.get("project")!).toHaveLength(0);
			expect(pg.rows.get("item")!).toHaveLength(0);
			expect(pg.rows.get("note")!).toHaveLength(0);
		} finally {
			db.close();
		}
	});
});

describe("dry run and verify-only (323)", () => {
	test("a dry run reads and hashes every row and writes NOTHING", async () => {
		const { db, pg } = fixture();
		try {
			const report = await runExport({ db, pg, options: { ...OPTIONS, dryRun: true } });
			expect(report.mode).toBe("dry-run");
			expect(report.tables.map((t) => t.sourceRows)).toEqual([2, 3, 2]);
			expect(report.tables.every((t) => t.targetRows === null && t.ok === null)).toBe(true);
			expect(report.ok).toBe(true);
			expect(pg.insertOrder).toEqual([]);
			expect(pg.statements.some((s) => s.startsWith("INSERT") || s.startsWith("TRUNCATE"))).toBe(false);
			expect(renderReport(report)).toContain("Nothing was written.");
		} finally {
			db.close();
		}
	});

	test("a dry run surfaces a type refusal BEFORE the window, at no risk", async () => {
		const { db, path } = tempDb([`CREATE TABLE project (id TEXT PRIMARY KEY, rank INTEGER)`]);
		try {
			db.run(`INSERT INTO project VALUES ('a', ?)`, [3.7]);
			const pg = new FakePg({ project: { columns: [c("id", "text"), c("rank", "integer")] } });
			await expect(
				runExport({ db, pg, options: { ...OPTIONS, sourcePath: path, dryRun: true } }),
			).rejects.toThrow(/no lossless integer form/);
		} finally {
			db.close();
		}
	});

	test("verify-only catches a target whose content has drifted, with the row count still right", async () => {
		const { db, pg } = fixture();
		try {
			await runExport({ db, pg, options: { ...OPTIONS } });
			pg.rows.get("item")![0]!.title = "quietly changed";
			const report = await runExport({ db, pg, options: { ...OPTIONS, verifyOnly: true } });
			expect(report.ok).toBe(false);
			const item = report.tables.find((t) => t.table === "item")!;
			expect(item.sourceRows).toBe(item.targetRows!);
			expect(item.sourceHash).not.toBe(item.targetHash!);
			expect(item.ok).toBe(false);
			expect(report.failures.join(" ")).toContain("item:");
			expect(renderReport(report)).toContain("MISMATCH");
		} finally {
			db.close();
		}
	});

	test("verify-only catches missing rows too, which is the failure rsync and zfs both hid", async () => {
		const { db, pg } = fixture();
		try {
			await runExport({ db, pg, options: { ...OPTIONS } });
			pg.rows.get("item")!.pop();
			const report = await runExport({ db, pg, options: { ...OPTIONS, verifyOnly: true } });
			expect(report.ok).toBe(false);
			expect(report.tables.find((t) => t.table === "item")).toMatchObject({ sourceRows: 3, targetRows: 2, ok: false });
		} finally {
			db.close();
		}
	});
});

describe("shape drift is refused, not absorbed (323)", () => {
	test("a source table with no target table refuses unless it is deliberately allowed", async () => {
		const { db, path } = tempDb([
			`CREATE TABLE project (id TEXT PRIMARY KEY)`,
			`CREATE TABLE forgotten (id TEXT PRIMARY KEY)`,
		]);
		try {
			db.run(`INSERT INTO project VALUES ('a')`);
			db.run(`INSERT INTO forgotten VALUES ('x')`);
			const spec = { project: { columns: [c("id", "text")] } };
			await expect(
				runExport({ db, pg: new FakePg(spec), options: { ...OPTIONS, sourcePath: path } }),
			).rejects.toThrow(/forgotten/);
			const allowed = await runExport({
				db,
				pg: new FakePg(spec),
				options: { ...OPTIONS, sourcePath: path, allowMissingTargetTables: true },
			});
			expect(allowed.unexpectedSkips).toEqual(["forgotten"]);
			expect(allowed.ok).toBe(true);
		} finally {
			db.close();
		}
	});

	test("a source column with no target column refuses, because those values would just be dropped", async () => {
		const { db, path } = tempDb([`CREATE TABLE project (id TEXT PRIMARY KEY, dropped TEXT)`]);
		try {
			db.run(`INSERT INTO project VALUES ('a', 'this would vanish')`);
			const spec = { project: { columns: [c("id", "text")] } };
			await expect(
				runExport({ db, pg: new FakePg(spec), options: { ...OPTIONS, sourcePath: path } }),
			).rejects.toThrow(/project\.dropped/);
			const allowed = await runExport({
				db,
				pg: new FakePg(spec),
				options: { ...OPTIONS, sourcePath: path, allowMissingTargetColumns: true },
			});
			expect(allowed.ok).toBe(true);
		} finally {
			db.close();
		}
	});

	test("a target with no tables at all is refused: this moves data and never creates schema", async () => {
		const { db, path } = tempDb([`CREATE TABLE project (id TEXT PRIMARY KEY)`]);
		try {
			await expect(
				runExport({ db, pg: new FakePg({}), options: { ...OPTIONS, sourcePath: path } }),
			).rejects.toThrow(/Apply the ob 321 baseline first/);
		} finally {
			db.close();
		}
	});

	test("a run that processed no table at all is a FAILURE, however cleanly it exited", async () => {
		const { db, path } = tempDb([`CREATE TABLE unrelated (id TEXT PRIMARY KEY)`]);
		try {
			const pg = new FakePg({ other: { columns: [c("id", "text")] } });
			const report = await runExport({
				db,
				pg,
				options: { ...OPTIONS, sourcePath: path, allowMissingTargetTables: true },
			});
			expect(report.tables).toEqual([]);
			expect(report.ok).toBe(false);
			expect(report.failures.join(" ")).toContain("no table was processed");
		} finally {
			db.close();
		}
	});
});

describe("the report artifact (323)", () => {
	test("it carries rows and hash for BOTH sides on one line per table", async () => {
		const { db, pg } = fixture();
		try {
			const rendered = renderReport(await runExport({ db, pg, options: { ...OPTIONS } }));
			expect(rendered).toContain("rows(src)");
			expect(rendered).toContain("rows(dst)");
			expect(rendered).toContain("hash(src)");
			expect(rendered).toContain("hash(dst)");
			const line = rendered.split("\n").find((l) => l.startsWith("item "))!;
			expect(line).toMatch(/item\s+3\s+3\s+[0-9a-f]{16}\s+[0-9a-f]{16}\s+OK/);
			expect(rendered).toContain("3 tables, 7 source rows");
			expect(rendered).toContain("VERIFIED");
		} finally {
			db.close();
		}
	});

	test("it names the sequence reset as evidence, not as a claim", async () => {
		const { db, pg } = fixture();
		try {
			const rendered = renderReport(await runExport({ db, pg, options: { ...OPTIONS } }));
			expect(rendered).toContain("identity sequences");
			expect(rendered).toMatch(/note\.id\s+max id\s+41\s+next\s+42\s+OK/);
		} finally {
			db.close();
		}
	});

	test("a coercion is counted and sampled rather than applied silently", async () => {
		// A column declared with NO type has BLOB affinity, so SQLite stores whatever it is handed without
		// converting it. That is the shape where loose typing genuinely survives to the export: an
		// INTEGER-affinity column has already coerced a numeric string on the way in, which is why the real
		// schema should produce very few of these and why an unexpected count here is worth reading.
		const { db, path } = tempDb([`CREATE TABLE project (id TEXT PRIMARY KEY, rank)`]);
		try {
			db.run(`INSERT INTO project VALUES ('a', ?), ('b', ?)`, ["17", 4]);
			const pg = new FakePg({ project: { columns: [c("id", "text"), c("rank", "integer")] } });
			const report = await runExport({ db, pg, options: { ...OPTIONS, sourcePath: path } });
			expect(report.ok).toBe(true);
			expect(report.coercions.map((entry) => [entry.column, entry.from, entry.count, entry.samples])).toEqual([
				["rank", "text", 1, ["17"]],
			]);
			expect(pg.rows.get("project")!.map((r) => r.rank)).toEqual([17, 4]);
			expect(renderReport(report)).toContain("did not match the target column");
		} finally {
			db.close();
		}
	});
});

// ob 324 (Postgres migration, phase 4) — the invariants the ported consumers rest on.
//
// Phase 4 writes every consumer ONCE and runs it against either engine, which only works because two
// things hold. Both are cheap to assert and expensive to discover in production, so they are asserted
// here rather than trusted:
//
//   1. The Postgres schema exposes the SAME table names and the SAME column keys as the SQLite schema
//      (ob 321's promise). The store types `q` and `t` against the SQLite modules and hands the pg-core
//      objects over at runtime, so the day the two barrels drift is the day a query silently addresses a
//      column that is not there. This test is what makes that a failing test instead.
//   2. No ported consumer calls `.all()` / `.get()` / `.run()`. Those are the SQLite dialect's synchronous
//      terminators; pg-core has no such methods, so one of them reaching Postgres is a TypeError at
//      request time. They typecheck fine (the types are the SQLite ones), so only a scan catches them.
//
// Plus the value-shape helpers, which are where the two engines disagree about what a row contains.
// No live database and no network: this reads source files and pure functions.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { PgTable } from "drizzle-orm/pg-core";
import * as sqliteSchema from "../../../apps/cli/src/db/schema.ts";
import * as pgSchema from "../../../apps/cli/src/db/pg/schema.ts";
import {
	encodeBool,
	encodeJson,
	readBool,
	readJson,
	readNumber,
	resolveStoreKind,
	sqliteStoreFor,
	STORE_ENV,
} from "../../../apps/cli/src/db/store.ts";
import { freshDb } from "../../../apps/cli/test/helpers.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The files ob 324 ported: they run against either engine, so they may not use a dialect terminator. */
const PORTED = [
	"apps/cli/src/db/store.ts",
];

function tableColumns(mod: Record<string, unknown>, table: (v: unknown) => boolean): Map<string, string[]> {
	const out = new Map<string, string[]>();
	for (const [name, value] of Object.entries(mod)) {
		if (!table(value)) continue;
		const columns = Object.keys(getTableColumns(value as never)).sort();
		out.set(name, columns);
	}
	return out;
}

describe("the two schemas agree (ob 321's promise, which ob 324's single code path depends on)", () => {
	const lite = tableColumns(sqliteSchema as Record<string, unknown>, (v) => is(v, SQLiteTable));
	const pg = tableColumns(pgSchema as Record<string, unknown>, (v) => is(v, PgTable));

	it("exports the same table names, apart from the sqlite-only FTS artifacts", () => {
		// The 5 fts5 virtual tables and their shadow tables have no Postgres analogue at all (ob 321's
		// header records the decision); search is ob 322's tsvector work, not a table with the same name.
		const liteNames = [...lite.keys()].filter((n) => !/fts/i.test(n)).sort();
		expect([...pg.keys()].sort()).toEqual(liteNames);
	});

	it("gives every shared table every column key the sqlite schema has", () => {
		// The invariant ob 324 needs is a SUPERSET, not an exact match: consumer code is typed against the
		// SQLite modules, so it can only ever name a column SQLite has, and a Postgres-only column is
		// unreachable from it. What would break a consumer is a column SQLite has and Postgres does not.
		const missing: string[] = [];
		for (const [name, columns] of pg) {
			const liteColumns = lite.get(name);
			if (!liteColumns) {
				missing.push(`${name}: absent from the sqlite schema`);
				continue;
			}
			const absent = liteColumns.filter((c) => !columns.includes(c));
			if (absent.length > 0) missing.push(`${name}: postgres is missing ${absent.join(",")}`);
		}
		expect(missing).toEqual([]);
	});

	it("adds nothing on the postgres side but ob 322's search vectors", () => {
		// A pg-only column is harmless to a consumer but it is still drift, so the extras are enumerated
		// rather than waved through: today the only legitimate one is the tsvector that replaced fts5.
		const extras: string[] = [];
		for (const [name, columns] of pg) {
			const liteColumns = lite.get(name) ?? [];
			for (const c of columns) {
				if (!liteColumns.includes(c) && c !== "search_vec") extras.push(`${name}.${c}`);
			}
		}
		expect(extras).toEqual([]);
	});
});

describe("no ported consumer uses a sqlite-only terminator", () => {
	for (const rel of PORTED) {
		it(`${rel} awaits its builders`, () => {
			const src = readFileSync(join(REPO, rel), "utf8");
			// Strip comments so the prose explaining the rule does not trip the rule.
			const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
			const hits = [...code.matchAll(/\.(all|get|run)\(\s*\)/g)].map((m) => m[0]);
			expect(hits).toEqual([]);
		});
	}
});

describe("the engine is chosen by configuration, and defaults to POSTGRES (337j)", () => {
	// The default flipped after the cutover. It is asserted rather than assumed because the whole point of
	// the change is that a process with NOTHING set reaches Postgres: an unset variable used to mean the
	// SQLite file, which is now a frozen copy that answers confidently and wrongly.
	it("treats unset and empty as postgres, because a fresh shell must not land on the frozen sqlite file", () => {
		// `undefined` means "read the environment" (the sqlite the suite's preload pins), so the unset case
		// is the one below; these two are the empty-string forms, which bypass it.
		expect(resolveStoreKind("")).toBe("postgres");
		expect(resolveStoreKind("   ")).toBe("postgres");
	});

	it("accepts the postgres spellings", () => {
		expect(resolveStoreKind("postgres")).toBe("postgres");
		expect(resolveStoreKind("postgresql")).toBe("postgres");
		expect(resolveStoreKind("PG")).toBe("postgres");
	});

	it("keeps sqlite reachable by NAME, which the unported commands and the foreign sqlite files need", () => {
		expect(resolveStoreKind("sqlite")).toBe("sqlite");
		expect(resolveStoreKind("SQLite")).toBe("sqlite");
		expect(resolveStoreKind(" sqlite ")).toBe("sqlite");
	});

	it("refuses a value it does not recognise rather than guessing an engine", () => {
		expect(() => resolveStoreKind("mysql")).toThrow(/not a store/);
		expect(() => resolveStoreKind("mysql")).toThrow(new RegExp(STORE_ENV));
	});

	it("reads the environment when no value is passed", () => {
		const before = process.env[STORE_ENV];
		try {
			delete process.env[STORE_ENV];
			expect(resolveStoreKind()).toBe("postgres");
			process.env[STORE_ENV] = "sqlite";
			expect(resolveStoreKind()).toBe("sqlite");
		} finally {
			if (before === undefined) delete process.env[STORE_ENV];
			else process.env[STORE_ENV] = before;
		}
	});
});

describe("the value shapes the two engines disagree about", () => {
	it("encodes a flag as a boolean for sqlite and 0/1 for postgres", () => {
		expect(encodeBool("sqlite", true)).toBe(true as unknown as boolean);
		expect(encodeBool("sqlite", false)).toBe(false as unknown as boolean);
		expect(encodeBool("postgres", true) as unknown).toBe(1);
		expect(encodeBool("postgres", false) as unknown).toBe(0);
	});

	it("reads a flag back as a real boolean from either engine", () => {
		expect(readBool(true)).toBe(true);
		expect(readBool(false)).toBe(false);
		expect(readBool(1)).toBe(true);
		expect(readBool(0)).toBe(false);
		expect(readBool(null)).toBe(false);
		expect(readBool(undefined)).toBe(false);
	});

	it("encodes json as a value for sqlite and a string for postgres, and reads either back parsed", () => {
		const rules = { categories: ["Groceries"], descriptionGlobs: ["PNP*"] };
		expect(encodeJson("sqlite", rules)).toEqual(rules);
		expect(encodeJson("postgres", rules) as unknown).toBe('{"categories":["Groceries"],"descriptionGlobs":["PNP*"]}');
		expect(readJson(rules)).toEqual(rules);
		expect(readJson(encodeJson("postgres", rules))).toEqual(rules);
	});

	it("coerces an aggregate, because postgres returns sum() and count() as strings", () => {
		// The failure this prevents: "1000" + "2500" is "10002500", which is a balance that is wrong by
		// four orders of magnitude and raises no error anywhere.
		expect(readNumber(3500)).toBe(3500);
		expect(readNumber("3500")).toBe(3500);
		expect(readNumber(null)).toBe(0);
		expect(readNumber(undefined)).toBe(0);
		expect(readNumber("1000") + readNumber("2500")).toBe(3500);
	});
});

describe("sqliteStoreFor wraps a handle without opening anything else", () => {
	it("reports sqlite, keeps the handle reachable, and runs an awaited query", async () => {
		const db = freshDb();
		const store = sqliteStoreFor(db);
		expect(store.kind).toBe("sqlite");
		expect(store.sqlite).toBe(db);
		const rows = await store.q.select().from(store.t.item);
		expect(rows).toEqual([]);
	});
});

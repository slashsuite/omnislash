import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "../../errors.ts";

export const PG_MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

const BOOKKEEPING = "__drizzle_migrations";
const LOCK_KEY = 587336;

/** How long an opener waits for another opener's migration lock before failing (1532). */
const PG_MIGRATION_LOCK_TIMEOUT_MS = 60_000;

export type PgSql = {
	unsafe(query: string): Promise<unknown>;
	begin<T>(fn: (tx: PgSql) => Promise<T>): Promise<T>;
};

/** A pool that can pin one connection: the lock must not be taken on anything that cannot (1532). */
export type PgPool = PgSql & { reserve(): Promise<PgSql & { release(): void }> };

export interface Migration {
	tag: string;
	when: number;
	hash: string;
	statements: string[];
}

export class PgMigrationError extends AppError {
	readonly tag: string;
	constructor(tag: string, cause: unknown) {
		super(
			[
				`migration ${tag} could not be applied: ${cause instanceof Error ? cause.message : String(cause)}`,
				`  the database is unchanged (the migration rolled back), and ob cannot open it until this is resolved`,
			].join("\n"),
		);
		this.tag = tag;
		this.cause = cause;
	}
}

function journal(): { tag: string; when: number }[] {
	const raw = JSON.parse(readFileSync(join(PG_MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
		entries: { tag: string; when: number }[];
	};
	return raw.entries;
}

export function readMigrations(): Migration[] {
	return journal().map((entry) => {
		const sqlText = readFileSync(join(PG_MIGRATIONS_FOLDER, `${entry.tag}.sql`), "utf8");
		return {
			tag: entry.tag,
			when: entry.when,
			hash: createHash("sha256").update(sqlText).digest("hex"),
			statements: sqlText.split("--> statement-breakpoint").map((s) => s.trim()).filter((s) => s.length > 0),
		};
	});
}

async function query<T extends Record<string, unknown>>(sql: PgSql, text: string): Promise<T[]> {
	return (await sql.unsafe(text)) as T[];
}

async function scalar<T>(sql: PgSql, text: string, field: string): Promise<T | null> {
	const rows = await query<Record<string, T>>(sql, text);
	const row = rows[0];
	return row ? (row[field] ?? null) : null;
}

function ident(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

async function tableExists(sql: PgSql, name: string): Promise<boolean> {
	const r = await scalar<string>(sql, `SELECT to_regclass('public.${name.replace(/'/g, "''")}') AS r`, "r");
	return r != null;
}

async function columnExists(sql: PgSql, table: string, column: string): Promise<boolean> {
	const r = await scalar<number>(
		sql,
		`SELECT 1 AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table.replace(/'/g, "''")}' AND column_name = '${column.replace(/'/g, "''")}' LIMIT 1`,
		"n",
	);
	return r != null;
}

async function generatedExpr(sql: PgSql, table: string, column: string): Promise<string | null> {
	return scalar<string>(
		sql,
		`SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
     FROM pg_attrdef d
     JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     JOIN pg_class c ON c.oid = d.adrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = '${table.replace(/'/g, "''")}' AND a.attname = '${column.replace(/'/g, "''")}'`,
		"expr",
	);
}

async function indexRow(
	sql: PgSql,
	name: string,
): Promise<{ indexdef: string; indisunique: boolean } | null> {
	const rows = await query<{ indexdef: string; indisunique: boolean }>(
		sql,
		`SELECT i.indexdef, x.indisunique
     FROM pg_indexes i
     JOIN pg_class c ON c.relname = i.indexname
     JOIN pg_index x ON x.indexrelid = c.oid
     WHERE i.schemaname = 'public' AND i.indexname = '${name.replace(/'/g, "''")}'
     LIMIT 1`,
	);
	return rows[0] ?? null;
}

async function constraintExists(sql: PgSql, name: string): Promise<boolean> {
	const truncated = name.slice(0, 63);
	const r = await scalar<number>(
		sql,
		`SELECT 1 AS n FROM pg_constraint WHERE conname = '${truncated.replace(/'/g, "''")}' LIMIT 1`,
		"n",
	);
	return r != null;
}

async function extensionExists(sql: PgSql, name: string): Promise<boolean> {
	const r = await scalar<number>(
		sql,
		`SELECT 1 AS n FROM pg_extension WHERE extname = '${name.replace(/'/g, "''")}' LIMIT 1`,
		"n",
	);
	return r != null;
}

async function tsConfigExists(sql: PgSql, name: string): Promise<boolean> {
	const r = await scalar<number>(
		sql,
		`SELECT 1 AS n FROM pg_ts_config WHERE cfgname = '${name.replace(/'/g, "''")}' LIMIT 1`,
		"n",
	);
	return r != null;
}

function hasToken(haystack: string, token: string): boolean {
	return haystack.toLowerCase().includes(token.toLowerCase());
}

// 1638: what a LATER migration drops. A migration that ran and was then undone by a later DROP (the Cue
// tables 0013 removed, which 0000 created) no longer has its objects present, so checking for them would
// call the baseline UNAPPLIED on a database built by the chain without bookkeeping, re-run it and collide
// with the tables that survived. Those objects are skipped, not required.
interface LaterDrops {
	tables: Set<string>;
	columns: Set<string>;
	constraints: Set<string>;
}

function stripNote(raw: string): string {
	return raw.trim().replace(/^(?:--[^\n]*\n?)+/, "").trim();
}

function laterDrops(later: Migration[]): LaterDrops {
	const drops: LaterDrops = { tables: new Set(), columns: new Set(), constraints: new Set() };
	for (const m of later) {
		for (const raw of m.statements) {
			const t = stripNote(raw);
			let match: RegExpMatchArray | null;
			if ((match = t.match(/^DROP TABLE(?: IF EXISTS)? "([^"]+)"/i))) drops.tables.add(match[1]!);
			else if ((match = t.match(/^ALTER TABLE "([^"]+)"\s+DROP COLUMN "([^"]+)"/i))) drops.columns.add(`${match[1]}.${match[2]}`);
			else if ((match = t.match(/^ALTER TABLE "([^"]+)"\s+DROP CONSTRAINT "([^"]+)"/i))) drops.constraints.add(match[2]!);
		}
	}
	return drops;
}

async function alreadyApplied(sql: PgSql, m: Migration, later: LaterDrops = laterDrops([])): Promise<boolean> {
	const droppedIndex = new Set<string>();
	const droppedColumn = new Set<string>();
	type Check = () => Promise<boolean>;
	const checks: Check[] = [];

	for (const raw of m.statements) {
		// A chunk may OPEN with the migration's own `--` note — the convention 0006 and 0009 follow, mirrored
		// from the SQLite chain. Those lines are prose: a parser that matches `^ALTER TABLE` against them reads
		// a one-statement migration as UNAPPLIED, which re-runs it and collides (measured: 0010 against a
		// database built by applyPgChain). Strip the leading note, then read the DDL.
		const t = stripNote(raw);
		let match: RegExpMatchArray | null;
		if ((match = t.match(/^DROP INDEX "([^"]+)"/i))) {
			droppedIndex.add(match[1]!);
			continue;
		}
		if ((match = t.match(/^ALTER TABLE "([^"]+)"\s+DROP COLUMN "([^"]+)"/i))) {
			droppedColumn.add(`${match[1]}.${match[2]}`);
			continue;
		}
		// 1638: a DROP migration is applied when what it drops is gone. Without these it has no checks at
		// all, so a chain-built database re-runs it and fails on the constraint it already dropped.
		if ((match = t.match(/^DROP TABLE(?: IF EXISTS)? "([^"]+)"/i))) {
			const name = match[1]!;
			checks.push(async () => !(await tableExists(sql, name)));
			continue;
		}
		if ((match = t.match(/^ALTER TABLE "([^"]+)"\s+DROP CONSTRAINT "([^"]+)"/i))) {
			const name = match[2]!;
			checks.push(async () => !(await constraintExists(sql, name)));
			continue;
		}
		if ((match = t.match(/^CREATE TABLE "([^"]+)"/i))) {
			const name = match[1]!;
			if (later.tables.has(name)) continue;
			checks.push(() => tableExists(sql, name));
			continue;
		}
		if ((match = t.match(/^ALTER TABLE "([^"]+)"\s+ADD COLUMN "([^"]+)"/i))) {
			const table = match[1]!;
			const column = match[2]!;
			if (later.tables.has(table) || later.columns.has(`${table}.${column}`)) continue;
			const replaced = droppedColumn.has(`${table}.${column}`);
			const gen = t.match(/GENERATED ALWAYS AS \((.*)\) STORED/is)?.[1];
			checks.push(async () => {
				if (!(await columnExists(sql, table, column))) return false;
				if (!replaced || !gen) return true;
				const live = await generatedExpr(sql, table, column);
				if (!live) return false;
				if (hasToken(gen, "transcript") && !hasToken(live, "transcript")) return false;
				if (hasToken(gen, "media_desc") && !hasToken(live, "media_desc")) return false;
				return true;
			});
			continue;
		}
		if ((match = t.match(/^ALTER TABLE "([^"]+)"\s+ADD CONSTRAINT "([^"]+)"/i))) {
			const name = match[2]!;
			// A DROP TABLE ... CASCADE takes the foreign keys that point at it along with it.
			const references = t.match(/REFERENCES "[^"]+"\."([^"]+)"/i)?.[1];
			if (later.tables.has(match[1]!) || later.constraints.has(name)) continue;
			if (references && later.tables.has(references)) continue;
			checks.push(() => constraintExists(sql, name));
			continue;
		}
		if ((match = t.match(/^CREATE( UNIQUE)? INDEX "([^"]+)"/i))) {
			const on = t.match(/\sON "([^"]+)"/i)?.[1];
			if (on && later.tables.has(on)) continue;
			const unique = Boolean(match[1]);
			const name = match[2]!;
			const replaced = droppedIndex.has(name);
			const wantsWhere = /\bWHERE\b/i.test(t);
			const wantsTranscript = hasToken(t, "transcript");
			checks.push(async () => {
				const live = await indexRow(sql, name);
				if (!live) return false;
				if (!replaced) return true;
				if (unique && !live.indisunique) return false;
				if (wantsWhere && !hasToken(live.indexdef, "where")) return false;
				if (wantsTranscript && !hasToken(live.indexdef, "transcript")) return false;
				return true;
			});
			continue;
		}
		if ((match = t.match(/^CREATE EXTENSION(?: IF NOT EXISTS)?\s+(\w+)/i))) {
			const name = match[1]!;
			checks.push(() => extensionExists(sql, name));
			continue;
		}
		if ((match = t.match(/^CREATE TEXT SEARCH CONFIGURATION\s+(\w+)/i))) {
			const name = match[1]!;
			checks.push(() => tsConfigExists(sql, name));
		}
	}

	// A dropped column the migration does not add back must be gone (0006 drops search_vec and re-adds it,
	// which its ADD COLUMN check covers).
	for (const key of droppedColumn) {
		const [table, column] = key.split(".") as [string, string];
		if (m.statements.some((s) => new RegExp(`ADD COLUMN "${column}"`, "i").test(s) && s.includes(`"${table}"`))) continue;
		checks.push(async () => !(await columnExists(sql, table, column)));
	}

	if (checks.length === 0) return false;
	for (const check of checks) {
		if (!(await check())) return false;
	}
	return true;
}

/** Migrations whose data statements are guarded, so the repair may re-run them (1949). */
const REPLAY_DATA_ON_REPAIR = new Set(["0015_per_project_refs"]);

/** UPDATE / INSERT / DELETE, once the chunk's leading `--` note is stripped. */
function isDataStatement(statement: string): boolean {
	const body = statement.trim().replace(/^(?:--[^\n]*\n?)+/, "").trim();
	return /^(UPDATE|INSERT|DELETE)\b/i.test(body);
}

async function newestApplied(sql: PgSql): Promise<number> {
	if (!(await tableExists(sql, BOOKKEEPING))) return -1;
	const newest = await scalar<number | string>(sql, `SELECT MAX(created_at) AS newest FROM ${ident(BOOKKEEPING)}`, "newest");
	if (newest === null || newest === undefined) return -1;
	return Number(newest);
}

/** Applied means recorded, per migration (OB-1913): a bookkeeping row carries this migration's own
 *  journal `when`, or its sha256 (the same SQL bytes already ran). Replaces newest-recorded >= `when`,
 *  which skipped forever any migration with no row of its own once anything newer was recorded. */
async function isRecorded(sql: PgSql, m: Migration): Promise<boolean> {
	const rows = await query<{ n: number }>(
		sql,
		`SELECT 1 AS n FROM ${ident(BOOKKEEPING)} WHERE created_at = ${m.when} OR hash = '${m.hash.replace(/'/g, "''")}' LIMIT 1`,
	);
	return rows.length > 0;
}

async function recordApplied(sql: PgSql, m: Migration): Promise<void> {
	await sql.unsafe(
		`INSERT INTO ${ident(BOOKKEEPING)} ("hash", "created_at") VALUES ('${m.hash.replace(/'/g, "''")}', ${m.when})`,
	);
}

async function applyOne(sql: PgSql, m: Migration, later: LaterDrops): Promise<void> {
	try {
		await sql.begin(async (tx) => {
			if (await isRecorded(tx, m)) return;
			if (await alreadyApplied(tx, m, later)) {
				// alreadyApplied checks objects only, so a backfill may never have run: re-run it where that is
				// known to be safe (1949), and refuse by tag where it is not (OB-1913), rather than record the
				// migration with its backfill unrun.
				const replay = REPLAY_DATA_ON_REPAIR.has(m.tag);
				if (!replay && m.statements.some(isDataStatement)) {
					throw new PgMigrationError(
						m.tag,
						new Error(
							"every object it creates is already present but it is not recorded, and its backfill is not known safe to re-run, so it was not repaired",
						),
					);
				}
				if (replay) for (const statement of m.statements) if (isDataStatement(statement)) await tx.unsafe(statement);
				await recordApplied(tx, m);
				console.error(
					`ob: repaired migration ${m.tag}: every object it creates was already present but it was not recorded as applied, so it has been recorded ${replay ? "after re-running only its data statements" : "without re-running it"}.`,
				);
				return;
			}
			if ((await newestApplied(tx)) > m.when) {
				console.error(
					`ob: applying migration ${m.tag}: it was never recorded as applied although a later migration is, so it was skipped until now.`,
				);
			}
			for (const statement of m.statements) {
				await tx.unsafe(statement);
			}
			await recordApplied(tx, m);
		});
	} catch (err) {
		if (err instanceof PgMigrationError) throw err;
		throw new PgMigrationError(m.tag, err);
	}
}

export class PgMigrationLockError extends AppError {
	constructor(message: string, cause?: unknown) {
		super(message);
		this.cause = cause;
	}
}

function lockTimeoutError(err: unknown): boolean {
	const e = err as { code?: unknown; errno?: unknown; message?: unknown };
	return e?.errno === "55P03" || e?.code === "55P03" || /lock timeout/i.test(String(e?.message ?? ""));
}

/** Apply `migrations` in order. Exported with the chain as a default parameter as the test seam
 *  (OB-1913); applyPgMigrations always passes the real chain, under the advisory lock. */
export async function runMigrations(conn: PgSql, migrations: Migration[] = readMigrations()): Promise<void> {
	await conn.unsafe(
		`CREATE TABLE IF NOT EXISTS ${ident(BOOKKEEPING)} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
	);
	for (const [i, m] of migrations.entries()) {
		await applyOne(conn, m, laterDrops(migrations.slice(i + 1)));
	}
}

/**
 * Apply the chain under the session-scoped advisory lock 587336.
 *
 * 1532: lock and unlock must run on the SAME backend. On a pooled client two `unsafe()` calls can land on
 * different sessions, so the unlock released nothing and the lock stayed held by an idle pooled connection
 * while every other opener queued behind it forever. The whole sequence runs on one reserved connection,
 * the wait is bounded by `lock_timeout`, and an unlock that releases nothing throws.
 */
export async function applyPgMigrations(
	sql: PgPool,
	opts: { lockTimeoutMs?: number } = {},
): Promise<void> {
	const timeoutMs = opts.lockTimeoutMs ?? PG_MIGRATION_LOCK_TIMEOUT_MS;
	const conn = await sql.reserve();
	try {
		await conn.unsafe(`SET lock_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
		try {
			await conn.unsafe(`SELECT pg_advisory_lock(${LOCK_KEY})`);
		} catch (err) {
			if (!lockTimeoutError(err)) throw err;
			throw new PgMigrationLockError(
				[
					`ob: timed out after ${timeoutMs}ms waiting for the postgres migration lock pg_advisory_lock(${LOCK_KEY})`,
					`  another session holds it; find it with: SELECT pid, state, application_name FROM pg_locks JOIN pg_stat_activity USING (pid) WHERE locktype = 'advisory' AND objid = ${LOCK_KEY}`,
				].join("\n"),
				err,
			);
		} finally {
			await conn.unsafe(`RESET lock_timeout`);
		}
		let failure: unknown;
		try {
			await runMigrations(conn);
		} catch (err) {
			failure = err;
		}
		const released = await scalar<boolean>(conn, `SELECT pg_advisory_unlock(${LOCK_KEY}) AS released`, "released");
		if (failure !== undefined) throw failure;
		if (released !== true) {
			throw new PgMigrationLockError(
				`ob: pg_advisory_unlock(${LOCK_KEY}) released nothing after migrating: the lock was not held by this session, so another session may still hold it`,
			);
		}
	} finally {
		conn.release();
	}
}

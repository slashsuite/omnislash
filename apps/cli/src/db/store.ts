// ob 324 (Postgres migration, phase 4): the store seam the non-CLI consumers open the database through.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A HARDCODED SWITCH TO POSTGRES.
//
// Map decision 3: SQLite stays authoritative until the cutover window. So the engine is chosen by
// CONFIGURATION, the SQLite path keeps working unchanged, and the cutover is one setting going forward
// and the SAME setting going back. A revert must not need a code change, because a revert happens at the
// moment nobody wants to be writing code.
//
//   OMNISLASH_STORE=postgres   the DEFAULT since ob 337j, and what an unset variable now means. Needs a
//                            connection URL, see resolvePgUrl below.
//   OMNISLASH_STORE=sqlite     the escape hatch, and what the test suites run on (they set it in their
//                            preloads rather than inheriting it, so a test is never one env var away
//                            from a live cluster).
//
// The default flipped in ob 337j, AFTER the cutover, and for a reason that is not tidiness: Postgres now
// holds the data, the SQLite file is a frozen copy nothing writes, and ~/.zshrc is not writable on this
// machine -- so a default of sqlite meant every fresh shell silently answering from a stale database.
// Configuration was the right home for the choice while both stores were live; it is the wrong home for
// it once one of them is a fossil.
//
// The connection URL cannot live in `ob secret` -- the secret store is a table INSIDE the database being
// migrated, so reading it would require the connection it is meant to provide. Map phase 0 records that
// circularity and its answer: a token file outside the repo, chmod 600, exactly like ~/.google_token.
//
// WHY ONE CODE PATH RATHER THAN TWO.
//
// ob 321 built the Postgres schema with export names and column keys IDENTICAL to the SQLite modules.
// That makes a single set of query-builder calls valid against both dialects, so consumers are written
// once. `q` and `t` are therefore TYPED against the SQLite modules and, in postgres mode, hold the
// pg-core equivalents at runtime. That is a deliberate, narrow lie and it is checked rather than trusted:
// test/pg-store-324.test.ts asserts the two barrels expose the same table names and the same column keys,
// so the day they diverge is the day the test fails rather than the day a query does.
//
// The one thing the shared path may NOT use is `.all()` / `.get()` / `.run()`. Those are the SQLite
// dialect's synchronous terminators and do not exist on pg-core, where a builder is awaited instead.
// Awaiting works on BOTH (drizzle's bun-sqlite builders are thenable and resolve to the same row arrays),
// so every ported consumer awaits, and test/pg-store-324.test.ts fails if a terminator comes back.
import type { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppError } from "../errors.ts";
import { openDb, resolveDbPath, type OpenDbOptions } from "../db.ts";
import * as sqliteSchema from "./schema.ts";
import { orm, unionAll as unionAllSqlite } from "./orm.ts";
import { withBusyRetryAsync } from "./busy.ts";
import { timeoutFromEnv, withDeadline } from "../deadline.ts";

// ob 337 moved these three into store-kind.ts so db.ts's two-live-stores guard can ask the same question
// from the same place without a cycle (store.ts imports db.ts). They are re-exported here because this is
// where every consumer already imports them from, and one setting must have exactly one parser.
export { resolveStoreKind, STORE_ENV, SQLITE_ESCAPE_HATCH, type StoreKind } from "./store-kind.ts";
import { resolveStoreKind, SQLITE_ESCAPE_HATCH, type StoreKind } from "./store-kind.ts";

/** The table namespace a consumer builds queries from. Typed sqlite; pg-core at runtime in postgres mode. */
export type StoreTables = typeof sqliteSchema;

/** The query-builder root. Typed sqlite; a BunSQLDatabase at runtime in postgres mode. */
export type StoreQuery = BunSQLiteDatabase<StoreTables>;

/** `unionAll` is dialect-scoped in drizzle (sqlite-core vs pg-core), so it travels on the store. */
export type StoreUnionAll = typeof unionAllSqlite;

export interface Store {
	/** Which engine is actually behind `q` and `t`. Read it rather than inferring it from the environment. */
	readonly kind: StoreKind;
	/** Query-builder root. Await every builder; never call .all()/.get()/.run(). */
	readonly q: StoreQuery;
	/** Tables. */
	readonly t: StoreTables;
	/** Dialect-correct unionAll. */
	readonly unionAll: StoreUnionAll;
	/**
	 * The raw bun:sqlite handle, ONLY in sqlite mode, and null in postgres mode. It exists because a few
	 * apps/cli call sites still take a Database directly; a consumer that reaches for it is a consumer
	 * that has not been ported, and in postgres mode it gets null rather than a handle to a dead file.
	 */
	readonly sqlite: Database | null;
	/**
	 * Encode a boolean for one of the 0/1 flag columns (ob 321 kept the storage as `integer` on purpose;
	 * the TS-level boolean is ob 327's work). SQLite's `{ mode: "boolean" }` column wants a real boolean,
	 * plain Postgres `integer` wants 0 or 1, and `eq(col, false)` against an int4 column is an outright
	 * Postgres error rather than a wrong answer. The declared return type is the SQLITE-facing one so
	 * consumer code stays typed; at runtime this returns 0/1 in postgres mode. Read the value back with
	 * readBool, never by `=== true`.
	 */
	bool(value: boolean): boolean;
	/**
	 * Encode a value for one of the json-in-text columns. SQLite's `{ mode: "json" }` column serialises
	 * for you and hands back a parsed object; ob 321 made the Postgres column plain `text` rather than
	 * annotate a `$type` that would lie about the runtime value, so it wants the serialised string and
	 * hands back a string. Same declared-type convention as bool: typed as the value, a string at runtime
	 * in postgres mode. Read it back with readJson.
	 */
	json<T>(value: T): T;
	/**
	 * Run `body` as ONE write transaction, on whichever engine is behind this store (337).
	 *
	 * apps/cli's existing seam is `writeTxn` (317), and it cannot be reused here: it is built on
	 * `db.transaction(...)`, which bun:sqlite requires to have a SYNCHRONOUS body, and every ported call
	 * site awaits. So the transaction moves onto the store, where each engine can express it properly:
	 *
	 *   sqlite   -- BEGIN IMMEDIATE / COMMIT / ROLLBACK issued by hand on the one handle. IMMEDIATE for
	 *               317's reason: a deferred transaction that reads and then writes has to upgrade its
	 *               lock, and sqlite refuses that upgrade instantly with SQLITE_BUSY without ever
	 *               consulting busy_timeout. Taking the write lock up front puts the wait back under it.
	 *   postgres -- the driver's own transaction, and the body is handed a store bound to the
	 *               transaction's connection rather than the pool. That last part is not a detail: Bun's
	 *               SQL client POOLS connections, so a hand-issued `BEGIN` would open a transaction on
	 *               one connection while the body's statements went out on others, producing a
	 *               transaction that wraps nothing and rolls back nothing.
	 *
	 * The body therefore MUST use the store it is passed, never the outer one, or its writes land outside
	 * the transaction on Postgres. Contention retries wrap the whole thing, which is safe for the same
	 * reason it is in 317: a busy failure happens at the BEGIN, before the body has run at all.
	 */
	txn<T>(what: string, body: (tx: Store) => Promise<T>): Promise<T>;
	/**
	 * Postgres NOTIFY on `channel`. No-op on sqlite (ob 606): the Mac never LISTENs, and sqlite tests
	 * inject a wrapper when they need the signal. Callers notify AFTER the write commits so a listener
	 * cannot read the pre-commit row. Channel must be a simple identifier; anything else is ignored.
	 */
	notify(channel: string): Promise<void>;
	close(): Promise<void>;
}

/**
 * Decode a 0/1 flag column into a real boolean, whichever engine produced it. SQLite gives `true`/`false`
 * (mode: boolean), Postgres gives 1/0. Both are truthy-correct, but `=== true` is not, and neither is
 * handing a 0/1 to something that JSON-serialises a flag into an API response.
 */
export function readBool(value: boolean | number | null | undefined): boolean {
	return value === true || value === 1;
}

/**
 * Decode a json-in-text column, whichever engine produced it. SQLite (mode: json) already parsed it;
 * Postgres hands back the raw string. A malformed value throws here rather than three frames later, where
 * the symptom is an undefined property on an object that was never an object.
 */
export function readJson<T>(value: T): T {
	if (typeof value !== "string") return value;
	return JSON.parse(value) as T;
}

/**
 * Decode a numeric AGGREGATE (sum, count, min/max over a number column).
 *
 * THIS ONE IS NOT COSMETIC. `sum(int4)` in Postgres is `bigint` and `count(*)` is `bigint`, and Bun's SQL
 * client hands both back as STRINGS, where bun:sqlite hands back numbers. Un-coerced, `opening + txns`
 * stops being addition and becomes string concatenation: two balances of 1000 and 2500 add up to
 * "10002500" instead of 3500, with no error anywhere. Every aggregate a consumer reads goes through here.
 */
export function readNumber(value: unknown): number {
	if (value == null) return 0;
	if (typeof value === "number") return value;
	return Number(value);
}

/**
 * The encoders behind Store.bool / Store.json, as pure functions of the engine so they can be tested
 * without a Postgres server. The declared return types are the SQLITE-facing ones (see Store.bool).
 */
export function encodeBool(kind: StoreKind, value: boolean): boolean {
	return (kind === "postgres" ? (value ? 1 : 0) : value) as unknown as boolean;
}

export function encodeJson<T>(kind: StoreKind, value: T): T {
	return (kind === "postgres" ? JSON.stringify(value) : value) as unknown as T;
}

export const PG_URL_ENV = "OMNISLASH_PG_URL";
export const PG_URL_FILE_ENV = "OMNISLASH_PG_URL_FILE";

/** Default location of the connection-URL token file (phase 0's answer to the bootstrap circularity). */
export function defaultPgUrlPath(): string {
	return join(homedir(), ".omnislash_pg_url");
}

/** The expected mode of the token file, stated in the error rather than left to be guessed at. */
export const PG_URL_FILE_MODE = 0o600;

/**
 * The refusal when there is no connection url (337j).
 *
 * This is now the FIRST thing a new machine hits, because Postgres is the built-in default rather than
 * something a shell opts into. So it has to be a setup guide and not a complaint: the exact path that was
 * looked for, the mode that path must have, the two commands that create it, and the escape hatch. It
 * names no password and prints no url.
 */
export function missingPgUrlMessage(path: string): string {
	return [
		`no Postgres connection url, and Postgres is the store ob uses (it is the built-in default since the ob 337 cutover).`,
		`  looked for it in: ${path}`,
		`  that file holds ONE line, the url, and nothing else. Mode 0${PG_URL_FILE_MODE.toString(8)}.`,
		`  write it with:`,
		`      printf '%s\\n' 'postgres://ob:ENCODED_PASSWORD@HOST:5432/omnislash' > ${path}`,
		`      chmod 0${PG_URL_FILE_MODE.toString(8)} ${path}`,
		`  PERCENT-ENCODE the password. 'openssl rand -base64' emits +, / and =, which are url syntax, so a`,
		`  raw password ends the url early and the connection fails with "cannot be parsed as a URL":`,
		`      bun -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' '<password>'`,
		`  a one-off somewhere else, without touching the file: ${PG_URL_ENV}=postgres://...`,
		`  a different file: ${PG_URL_FILE_ENV}=<path>`,
		`  to use the local SQLite database instead -- the ~30 commands not ported yet, and the foreign`,
		`  sqlite files ob reads: ${SQLITE_ESCAPE_HATCH}`,
	].join("\n");
}

/**
 * The refusal when the url is present but unusable (337j).
 *
 * It cost real time during the cutover, and it cost it twice, so the diagnosis is spelled out rather than
 * left to be rediscovered: a base64 password contains +, / and =, every one of which is url syntax, and
 * Bun reports the result as a flat "cannot be parsed as a URL" that names nothing.
 *
 * `source` is a path or a variable NAME. The url itself is never in this message and never will be: it
 * carries the password, and an error is the single most likely thing to be pasted into a chat window.
 */
export function unusablePgUrlMessage(source: string, reason: string): string {
	return [
		`the Postgres connection url from ${source} is unusable: ${reason}.`,
		`  the url is not shown here, deliberately -- it carries the password.`,
		`  shape: postgres://USER:ENCODED_PASSWORD@HOST:5432/omnislash`,
		`  overwhelmingly the cause is a password that is not PERCENT-ENCODED. 'openssl rand -base64' emits`,
		`  +, / and =, which are url syntax, so a raw password ends the url early. Encode just the password:`,
		`      bun -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' '<password>'`,
		`  to use the local SQLite database instead: ${SQLITE_ESCAPE_HATCH}`,
	].join("\n");
}

/**
 * Parse-check a connection url before it reaches the driver, so the failure names its own cause.
 *
 * Bun's SQL client rejects a malformed url with "cannot be parsed as a URL" and nothing else -- not the
 * field, not the character, not the fix. That is the message the cutover lost time to. Checking here is
 * the cheap place: it happens once, before any connection, and it can say what the driver cannot.
 */
export function checkPgUrl(url: string, source: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new AppError(unusablePgUrlMessage(source, "it cannot be parsed as a URL"));
	}
	if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
		throw new AppError(
			unusablePgUrlMessage(source, `its scheme is '${parsed.protocol.replace(":", "")}', not postgres`),
		);
	}
	return url;
}

/**
 * The Postgres connection URL: the environment variable first (so a one-off command can point somewhere
 * else without editing a file), then the token file at its default path. Neither present is an error that
 * names both, because the failure mode being avoided is a process quietly opening the wrong database.
 */
export function resolvePgUrl(): string {
	const env = process.env[PG_URL_ENV]?.trim();
	if (env) return checkPgUrl(env, PG_URL_ENV);
	const path = process.env[PG_URL_FILE_ENV]?.trim() || defaultPgUrlPath();
	if (existsSync(path)) {
		warnLoosePgUrlFileMode(path);
		const contents = readFileSync(path, "utf8").trim();
		if (contents.length > 0) return checkPgUrl(contents, path);
	}
	throw new AppError(missingPgUrlMessage(path));
}

/**
 * A group- or world-readable token file is a password sitting in the open, and it is the kind of thing a
 * `cp` or a restore quietly undoes. stderr rather than a refusal: the connection still works, and turning
 * a permissions slip into an outage is its own failure. Silent when the mode is right, which is normal.
 */
export function warnLoosePgUrlFileMode(path: string): void {
	try {
		const mode = statSync(path).mode & 0o777;
		if ((mode & 0o077) === 0) return;
		process.stderr.write(
			`warning: ${path} is mode 0${mode.toString(8)} and holds the Postgres password; expected 0${PG_URL_FILE_MODE.toString(8)}. fix: chmod 0${PG_URL_FILE_MODE.toString(8)} ${path}\n`,
		);
	} catch {
		// unreadable metadata is not this function's problem; the read below will report it properly
	}
}

export interface OpenStoreOptions extends OpenDbOptions {
	/** Override the configured engine (tests, and the migration tooling that must address one engine). */
	kind?: StoreKind;
	/** sqlite only: the database file, defaulting to resolveDbPath(). */
	path?: string;
	/** postgres only: the connection url, defaulting to resolvePgUrl(). */
	url?: string;
	/**
	 * postgres only: connection settings passed straight to Bun's SQL client instead of a url. The ob 325
	 * test harness addresses its cluster over a unix socket, which is a shape a url cannot carry, so a test
	 * hands the harness's own options through here rather than the seam inventing a second url format.
	 */
	connection?: Record<string, unknown>;
	/**
	 * postgres only: apply the pg migration chain on open (ob 587). Default true for `ob`.
	 * The dashboard SSR bundle rewrites import.meta.url, so apply-on-open looks for
	 * _journal.json under dist/server/assets and 500s (ob 593). Page loaders pass false.
	 */
	migrate?: boolean;
	/**
	 * postgres only: Bun SQL idle-out in seconds. Default `PG_POOL_IDLE_TIMEOUT_S`. `0` disables it.
	 * Connection-object `idleTimeout` is still ignored (401); only this option can disable it, and
	 * only oneshot CLI commands do (594).
	 */
	idleTimeout?: number;
}

/**
 * Cap every `getStore()` / `openStore()` Postgres client at this many pooled connections (ob 431).
 *
 * Bun's SQL client pools ~10 by default. The database host sets `max_connections = 50`. Four live processes
 * (`ob web`, the WhatsApp bridge, cal-sync, one more server) × 10 = 40, plus reserved superuser slots, so a fifth
 * opener dies with `53300`. Do not raise `max_connections` as the fix — that hides the leak. A caller
 * that already asked for fewer (the test harness pins `max: 2` so `txn` has one spare) keeps the
 * smaller number; nothing is allowed above this.
 */
export const PG_POOL_MAX = 3;

/**
 * Close a pooled connection that has sat unused this many seconds (ob 401).
 *
 * 431 capped the width; it did not stop a long-running supervisor from HOLDING that width forever.
 * The live database host on 2026-08-24: `ob whatsapp bridge run` (started Aug 18, pre-431) still held 10 idle
 * backends five days later. `ob web` holds two processes × 3. Combined with overlapping jobs that
 * is how `max_connections=50` / `superuser_reserved=3` ran out (53300) and killed db-snapshot +
 * cal-sync. Idle-out returns unused slots without shrinking the cap a burst still needs.
 *
 * Oneshot CLI commands do NOT use this (ob 594). They close the pool on exit (`resetStore` in
 * cli.ts finally), so they cannot leak slots. Bun's SQL client THROWS `Idle timeout reached after
 * 30s` when a pooled connection sits unused that long, instead of silently recycling it — and
 * `ob whatsapp sync` reads the bridge's SQLite between Postgres queries. A slow or locked
 * messages.db lets the pool idle-out and fail the systemd unit (590/594, ~1-min cadence). `ob web`
 * keeps the 30s idle-out because realtime holds the store for the process lifetime.
 */
export const PG_POOL_IDLE_TIMEOUT_S = 30;

/**
 * Seconds a new connection may take to establish before the client gives up (1532). Set explicitly so a
 * full server (53300) or an unreachable host fails a scheduled job with an error instead of wedging it.
 */
export const PG_CONNECT_TIMEOUT_S = 10;

/**
 * How long one Postgres store call (a transaction, a NOTIFY) may take before it fails with a named
 * `CallTimeoutError` (1616). On 2026-10-20 a leaked Bun SQL pool slot left every write waiting 43 minutes
 * for a connection that never came back, with no error. `OMNISLASH_STORE_TIMEOUT_MS` overrides it. The
 * query keeps running underneath (Bun SQL has no abort); this bounds the WAIT, not the work.
 */
export const PG_STORE_CALL_TIMEOUT_MS = 30_000;

export interface PostgresPoolOptions {
	max: number;
	idleTimeout: number;
	connectionTimeout: number;
}

/**
 * The pool size actually handed to Bun's SQL client. A positive explicit `max` is honoured only when
 * it is smaller than the cap; anything else (missing, zero, huge) becomes `PG_POOL_MAX`.
 */
export function postgresPoolMax(requested?: unknown): number {
	if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) {
		return Math.min(Math.floor(requested), PG_POOL_MAX);
	}
	return PG_POOL_MAX;
}

/**
 * Idle-out actually handed to Bun's SQL client. `0` disables it (oneshot CLI, ob 594). Anything
 * else — missing, negative, a connection object trying to sneak `idleTimeout: 1` — stays 30s (401).
 */
export function postgresPoolIdleTimeout(requested?: unknown): number {
	return requested === 0 ? 0 : PG_POOL_IDLE_TIMEOUT_S;
}

/**
 * Long-running `ob web` keeps the 30s idle-out (realtime holds the store). Every other CLI command
 * is oneshot and disables it (594). `ob whatsapp bridge run` already `resetStore()` after spawn.
 */
export function postgresIdleTimeoutForCommand(command: string): number {
	return command === "web" ? PG_POOL_IDLE_TIMEOUT_S : 0;
}

/** Options object every postgres store constructs. `max` is capped; idle-out is 30s unless 0. */
export function postgresPoolOptions(requestedMax?: unknown, idleTimeout?: unknown): PostgresPoolOptions {
	return {
		max: postgresPoolMax(requestedMax),
		idleTimeout: postgresPoolIdleTimeout(idleTimeout),
		connectionTimeout: PG_CONNECT_TIMEOUT_S,
	};
}

/**
 * Construct the Bun SQL client every postgres store opens. Extracted so a test can inject the
 * constructor and assert the options object without opening a database.
 *
 * Bun's published types only name the url form (`string | URL`). The object form is what the 325
 * harness already uses (unix socket) and what `new SQL(connection as string)` used to paper over.
 */
export function createPostgresSqlClient<T extends { end(): Promise<void> }>(
	SQL: new (connection: string, options?: PostgresPoolOptions) => T,
	connection: string | Record<string, unknown>,
	idleTimeout?: number,
): T {
	const options = postgresPoolOptions(
		typeof connection === "object" ? connection.max : undefined,
		idleTimeout,
	);
	if (typeof connection === "string") return new SQL(connection, options);
	return new SQL({ ...connection, ...options } as unknown as string);
}

function sqliteStore(db: Database): Store {
	const store: Store = {
		kind: "sqlite",
		q: orm(db),
		t: sqliteSchema,
		unionAll: unionAllSqlite,
		sqlite: db,
		bool: (value) => encodeBool("sqlite", value),
		json: (value) => encodeJson("sqlite", value),
		txn(what, body) {
			// Nested calls join the transaction already open rather than issuing a second BEGIN, which
			// sqlite rejects outright ("cannot start a transaction within a transaction"). A ported
			// function that both writes in its own transaction and is called from inside another one is
			// the normal case (createItem calls addTags), so this is the difference between composable
			// and not.
			if (db.inTransaction) return body(store);
			return withBusyRetryAsync(what, async () => {
				db.exec("BEGIN IMMEDIATE");
				try {
					const result = await body(store);
					db.exec("COMMIT");
					return result;
				} catch (err) {
					// Best-effort: if the transaction is already gone the original error is the one worth
					// reporting, and a throw from the rollback would replace it with a worse one.
					try {
						if (db.inTransaction) db.exec("ROLLBACK");
					} catch {}
					throw err;
				}
			});
		},
		async notify() {},
		async close() {
			db.close();
		},
	};
	return store;
}

async function postgresStore(
	connection: string | Record<string, unknown>,
	migrate = true,
	idleTimeout?: number,
): Promise<Store> {
	const callTimeoutMs = timeoutFromEnv("OMNISLASH_STORE_TIMEOUT_MS", PG_STORE_CALL_TIMEOUT_MS);
	// Imported lazily and only on this branch: a sqlite process must never pay for, or fail on, a
	// Postgres driver it is not using. Bun's built-in SQL client is the driver, so this adds no dependency.
	const { SQL } = await import("bun");
	const { drizzle } = await import("drizzle-orm/bun-sql");
	const pgSchema = await import("./pg/schema.ts");
	const { unionAll } = await import("drizzle-orm/pg-core");
	const client = createPostgresSqlClient(SQL, connection, idleTimeout);
	if (migrate) {
		const { applyPgMigrations } = await import("./pg/migrate.ts");
		await applyPgMigrations(client);
	}
	const q = drizzle({ client, schema: pgSchema as unknown as Record<string, unknown> });
	const bind = (query: StoreQuery): Store => ({
		kind: "postgres",
		q: query,
		t: pgSchema as unknown as StoreTables,
		unionAll: unionAll as unknown as StoreUnionAll,
		sqlite: null,
		bool: (value) => encodeBool("postgres", value),
		json: (value) => encodeJson("postgres", value),
		txn(what, body) {
			// Postgres has real nested transactions via savepoints and drizzle issues them, so unlike the
			// sqlite branch this needs no re-entrancy special case.
			return withDeadline(`store txn '${what}'`, callTimeoutMs, () =>
				withBusyRetryAsync(what, () =>
					(query as unknown as { transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> })
						.transaction(async (tx) => body(bind(tx as StoreQuery))) as Promise<never>,
				),
			);
		},
		async notify(channel: string) {
			if (!/^[a-z][a-z0-9_]*$/.test(channel)) return;
			await withDeadline(`store notify '${channel}'`, callTimeoutMs, () =>
				(client as { unsafe(query: string): Promise<unknown> }).unsafe(`SELECT pg_notify('${channel}', '')`),
			);
		},
		async close() {
			await client.end();
		},
	});
	// The narrow, checked cast this file's header documents: identical names and column keys (ob 321),
	// asserted by test/pg-store-324.test.ts.
	return bind(q as unknown as StoreQuery);
}

/**
 * Wrap an ALREADY-OPEN bun:sqlite handle as a store, without opening the file a second time.
 *
 * This is the bridge for code that still holds a raw handle: apps/cli's own commands (which are still
 * SQLite-native until ob 326) and the test helpers that open an in-memory database. It is deliberately
 * SQLite-only -- there is no Postgres equivalent of "a handle someone else opened", and pretending there
 * were is how a consumer ends up talking to the wrong engine.
 */
export function sqliteStoreFor(db: Database): Store {
	return sqliteStore(db);
}

/**
 * Accept either a store or a raw bun:sqlite handle, and give back a store (337).
 *
 * This is what lets apps/cli be ported a piece at a time instead of all at once. Every one of the ~265
 * call sites currently takes `db: Database`, and its callers reach it through a long chain of other
 * functions that also take `db: Database`. Requiring a Store at each ported signature would mean
 * converting that entire chain, plus every test that passes a handle, in ONE change -- which is exactly
 * the all-or-nothing shape that cannot survive being interrupted, and which lands nothing when it does.
 *
 * With this, a ported function's signature widens instead of changing: existing callers and existing
 * tests keep passing the handle they already have, and the sqlite behaviour is identical because the
 * store it gets wraps that same handle (`orm` is memoised per handle, so nothing is opened or rebuilt).
 * Callers that HAVE a store pass it through and reach Postgres. The seam is one-way on purpose: there is
 * no Store -> Database direction, because that is how a ported caller would silently end up back on the
 * file.
 */
export function asStore(db: Database | Store): Store {
	return "kind" in db ? db : sqliteStore(db);
}

/**
 * The store a CLI command should use, given the handle it was already passed.
 *
 * In sqlite mode this wraps that handle, so nothing opens twice and nothing changes. In postgres mode it
 * returns the configured Postgres store and IGNORES the handle, so a command that reaches the store this
 * way follows the cutover switch rather than
 * carrying on against a file that is no longer authoritative. That is the ob 237 lesson applied to the
 * CLI: a consumer that keeps its own private path to the database is a consumer that keeps writing to
 * the dead one. The REST of `ob` is still SQLite until ob 326 ports it -- see the README.
 */
export async function commandStore(db: Database, opts: OpenStoreOptions = {}): Promise<Store> {
	if (resolveStoreKind() === "sqlite") return sqliteStore(db);
	return getStore(opts);
}

/** Open a store. Each call is a new connection; use getStore() for the per-process singleton. */
export async function openStore(opts: OpenStoreOptions = {}): Promise<Store> {
	const kind = opts.kind ?? resolveStoreKind();
	if (kind === "postgres") {
		return postgresStore(
			opts.connection ?? opts.url ?? resolvePgUrl(),
			opts.migrate !== false,
			opts.idleTimeout,
		);
	}
	const { kind: _kind, path, url: _url, migrate: _migrate, idleTimeout: _idle, connection: _conn, ...openOpts } = opts;
	// deliberateSqlite: this branch is only reached when sqlite is what was asked for -- either the
	// configured engine or an explicit opts.kind (the migration tooling, which must be able to read the
	// SQLite source while OMNISLASH_STORE already says postgres). 337's guard is for the callers that did
	// NOT choose; this one did.
	return sqliteStore(openDb(resolveDbPath(path), { ...openOpts, deliberateSqlite: true }));
}

let singleton: Promise<Store> | null = null;

/**
 * The per-process store. Server processes (the dashboard) want ONE connection for their
 * lifetime, and the module-level `const db = openDb(...)` they used to have was exactly that -- minus the
 * ability to be anything but a SQLite file.
 */
export function getStore(opts: OpenStoreOptions = {}): Promise<Store> {
	if (!singleton) singleton = openStore(opts);
	return singleton;
}

/** Drop the singleton (tests, and any process that reconfigures itself). Closes the old store first. */
export async function resetStore(): Promise<void> {
	const current = singleton;
	singleton = null;
	if (current) await (await current).close();
}

// 337: the ported-command registry and the stand-in handle live in servable.ts for the same reason
// store-kind.ts exists -- db.ts's guard names the servable commands in its refusal, and db.ts cannot
// import this file (store.ts imports db.ts). They are re-exported here because this is the seam every
// consumer already imports from.
export {
	POSTGRES_SERVABLE_COMMANDS,
	isPostgresServable,
	unusableSqliteHandle,
} from "./servable.ts";

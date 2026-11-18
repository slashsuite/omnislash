// ob 324 — the REAL Postgres schema as a source the ob 325 harness can build a database from.
//
// 325 left this seam open in schema-source.ts and named phase 4 as the caller: "`apply` becomes the real
// migration chain [...] and `id` becomes the migration journal's last tag." This is that, and nothing
// more — the harness keeps its fixture as the DEFAULT so 325's own cost measurements stay comparable and
// its tests keep the table shapes they were written against. A test that wants the real schema asks for
// it explicitly (see pg-consumers-324.test.ts).
//
// The chain is applied exactly the way `applyMigrations` applies the SQLite one: journal order, then one
// statement per `--> statement-breakpoint` chunk (the ob 223 rule, which survived the move).
import type { SQL } from "bun";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freshPgDb, type PgLease } from "./harness.ts";
import type { PgSchemaSource } from "./schema-source.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "db", "pg", "migrations");

interface Journal {
	entries: { idx: number; tag: string }[];
}

function journal(): Journal {
	return JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as Journal;
}

/** Apply the pg chain to an EMPTY database, chunk by chunk in journal order. */
export async function applyPgChain(sql: SQL): Promise<void> {
	for (const entry of [...journal().entries].sort((a, b) => a.idx - b.idx)) {
		const text = readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8");
		for (const chunk of text.split("--> statement-breakpoint")) {
			const statement = chunk.trim();
			if (statement.length === 0) continue;
			await sql.unsafe(statement);
		}
	}
}

/**
 * `ob`'s own migrator on the empty template, which applies the chain AND records it in its ledger
 * (`__drizzle_migrations`), exactly as the first `openStore` on a fresh database does. A pooled database is
 * then what `ob` sees after its first open, so each test's `openStore` finds nothing outstanding instead of
 * recording the whole chain again (78ms a test, measured, OB-2022).
 */
async function applyRecordedChain(sql: SQL): Promise<void> {
	const { applyPgMigrations } = await import("../../src/db/pg/migrate.ts");
	await applyPgMigrations(sql as unknown as Parameters<typeof applyPgMigrations>[0]);
}

export const REAL_SCHEMA: PgSchemaSource = {
	// The journal's last tag, so a new migration invalidates a cached template automatically.
	get id() {
		const entries = [...journal().entries].sort((a, b) => a.idx - b.idx);
		return `pg-chain-${entries[entries.length - 1]?.tag ?? "empty"}`;
	},
	apply: applyRecordedChain,
};

/**
 * A pooled database with the real chain in it (OB-2022): the cheap replacement for
 * `freshPgDatabase({ empty: true })` + `applyPgChain`, which built and dropped a whole database per test and
 * was the gate's IO flake under load.
 *
 * The chain is applied once per test process, to a template; each lease is a copy reused across tests and
 * emptied on release (harness.ts, `probeReset`). Open stores on `lease.options` freely: the release ends
 * their backends before it resets. A test that changes the schema (ALTER, CREATE, DROP) or asserts on
 * migration state takes its own database (`freshPgStore({ changesSchema: true })`) instead; the release fails loudly if one does not.
 *
 * `{ ledger: false }` leases the chain without the ledger (see `BARE_CHAIN_SCHEMA`).
 */
export function leaseRealPgDb(opts: { ledger?: boolean } = {}): Promise<PgLease> {
	return freshPgDb({ schema: opts.ledger === false ? BARE_CHAIN_SCHEMA : REAL_SCHEMA });
}

/**
 * The chain alone, with no migration ledger: what a target looks like before `ob` has ever opened it. For
 * the exporter test (pg-export-live-323), which loads a target table by table and must not meet the
 * ledger. A test that opens a store on it creates the ledger, which its release then refuses.
 */
const BARE_CHAIN_SCHEMA: PgSchemaSource = {
	get id() {
		return `${REAL_SCHEMA.id}-bare`;
	},
	apply: applyPgChain,
};

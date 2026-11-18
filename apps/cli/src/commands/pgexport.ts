// --- ob 323: `ob pg-export`, the command wrapper around src/pgexport.ts ---
//
// The engine is deliberately free of Bun's SQL client and of any path-resolution defaults; this file is
// where the two live connections are made, and it is the only place that can point at something real.
//
// NO DEFAULTS. `--from` and one of `--to` / `--to-file` are REQUIRED. `ob` resolves a database path for
// every other command, and inheriting that here is exactly how an exporter ends up pointed at the live
// tracker by accident, so it is not inherited: the source is the path typed on the command line and
// nothing else. The target is likewise never guessed and never read from the environment.
//
// The source is opened READONLY. This command cannot write to SQLite even if it is wrong.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Ctx } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { print, warn } from "../output.ts";
import {
	ExportRefusal,
	type PgClient,
	renderReport,
	runExport,
	type ExportReport,
} from "../pgexport.ts";

/**
 * Bun's built-in Postgres client, pinned to ONE connection. The exporter issues BEGIN / DECLARE / FETCH /
 * COMMIT as ordinary statements, and every one of those is connection-scoped: a pool would happily run
 * the FETCH on a connection that never saw the DECLARE.
 */
export async function connect(url: string): Promise<{ client: PgClient; close: () => Promise<void> }> {
	const { SQL } = await import("bun");
	const sql = new SQL(url, { max: 1 });
	return {
		client: {
			async query(statement: string, params: unknown[] = []) {
				const rows = await sql.unsafe(statement, params);
				return (rows ?? []) as unknown as Record<string, unknown>[];
			},
		},
		close: async () => {
			await sql.end();
		},
	};
}

/** Everything after the password is what a person needs to recognise the target; the password is not. */
export function redactUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.password) parsed.password = "***";
		return parsed.toString();
	} catch {
		return "<unparseable connection url>";
	}
}

export async function resolveTargetUrl(flags: { to?: string; "to-file"?: string }): Promise<string> {
	const inline = flags.to?.trim();
	const file = flags["to-file"]?.trim();
	if (inline && file) throw new UsageError("pass --to or --to-file, not both");
	if (file) {
		// ob 320's bootstrap trap: the connection secret cannot live in the secret store, because the
		// secret store is inside the database being migrated. It lives in a chmod 600 token file, and
		// reading it here keeps the password out of the shell history and out of the process table.
		const path = resolve(file);
		if (!existsSync(path)) throw new UsageError(`no such connection file: ${path}`);
		const contents = (await readFile(path, "utf8")).trim();
		if (!contents) throw new UsageError(`the connection file ${path} is empty`);
		return contents.split("\n")[0]!.trim();
	}
	if (inline) return inline;
	throw new UsageError(
		"pg-export needs an explicit target: --to <postgres-url> or --to-file <path>. There is no default, on purpose.",
	);
}

export async function cmdPgExport(ctx: Ctx): Promise<void> {
	const from = ctx.flags.from?.trim();
	if (!from) {
		throw new UsageError(
			"pg-export needs an explicit source: --from <path-to-sqlite-db>. It does not inherit ob's own database path, on purpose.",
		);
	}
	const sourcePath = resolve(from);
	if (!existsSync(sourcePath)) throw new UsageError(`no such SQLite database: ${sourcePath}`);

	const url = await resolveTargetUrl(ctx.flags);
	const dryRun = ctx.flags["dry-run"] === true;
	const verifyOnly = ctx.flags["verify-only"] === true;
	if (dryRun && verifyOnly) throw new UsageError("pass --dry-run or --verify-only, not both");

	const source = new Database(sourcePath, { readonly: true });
	const target = await connect(url);
	let report: ExportReport;
	try {
		if (ctx.mode !== "json") {
			warn(`pg-export: ${sourcePath} -> ${redactUrl(url)}${dryRun ? " (dry run, nothing is written)" : ""}`);
		}
		report = await runExport({
			db: source,
			pg: target.client,
			options: {
				sourcePath,
				dryRun,
				verifyOnly,
				truncate: ctx.flags.truncate === true,
				allowMissingTargetTables: ctx.flags["allow-missing-target-tables"] === true,
				allowMissingTargetColumns: ctx.flags["allow-missing-target-columns"] === true,
			},
		});
	} catch (err) {
		if (err instanceof ExportRefusal) throw new AppError((err as Error).message);
		throw err;
	} finally {
		source.close();
		await target.close();
	}

	// The report is written BEFORE the exit code is decided, and written whether or not it passed: the
	// artifact is the point, and one that only appears on success proves nothing about a failure.
	const out = ctx.flags.out?.trim();
	if (out) {
		const path = resolve(out);
		await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		if (ctx.mode !== "json") warn(`pg-export: report written to ${path}`);
	}
	if (ctx.mode === "json") print(JSON.stringify(report));
	else print(renderReport(report));
	if (!report.ok) ctx.exit = 1;
}

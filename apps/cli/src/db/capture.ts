// ob 337: how a copy of the database is TAKEN, now that Postgres is the database.
//
// WHY THIS IS ITS OWN MODULE, AND WHY IT WAS THE PIECE THAT BLOCKED THE CUTOVER.
//
// `ob backup` and `ob db snapshot` are the only two commands whose whole job is to produce a second copy
// of the database, and both were written against SQLite so completely that the engine was not even
// named: `VACUUM INTO` is a SQLite statement with no Postgres form at all. A cutover that left them
// unported would not have FAILED -- that was the entire problem. `ob backup` would have kept running
// monthly, kept uploading a release, kept exiting 0, and kept backing up the SQLite file that Postgres
// had replaced. The monthly job would report success while the thing being protected drifted further
// from the thing being copied, and it would be found the way ob 237 was found: at restore time.
//
// THE FORM, and why it is this one. `pg_dump --format=custom` is the same choice
// the database host's own dump script already made, and for its reason: a custom-format dump
// is the one `pg_restore` can pull a SINGLE table out of, which is what a "one table got wrecked"
// incident actually needs. A plain .sql dump can only be replayed whole. Artifacts are named `.dump`, not
// `.sqlite`, and that is not cosmetic: a restore begins with a human finding a file in a GitHub release a
// year later and deciding what to do with it, so the name has to carry the format.
//
// WHAT THIS IS AND IS NOT, same as the server-side script. The dump is the copy that survives a bad
// migration, a bad write or a dropped table, and it restores by `pg_restore`. It does NOT survive losing
// the volume -- that is the host-side vzdump onto a separate disk -- and it is not point-in-time
// recovery, which is the basebackup plus the WAL archive on the database host.
//
// HOW THE CONNECTION REACHES pg_dump, and why not through the argv. `resolvePgUrl()` returns a url with
// a password in it, and an argv is world-readable in `ps` for as long as the dump runs -- on the machine
// that also serves the dashboard. libpq reads the same connection from PGHOST/PGPORT/PGUSER/PGPASSWORD/
// PGDATABASE, so the parts travel as ENV and the argv carries no connection information whatsoever. Both
// halves are pure functions here, so the whole decision is testable without a server, which is what lets
// this be gated without ever connecting to the database host.
import { AppError } from "../errors.ts";
import { resolvePgUrl, STORE_ENV } from "./store.ts";

/** The artifact suffix. A restore reads the format off the name. */
export const ARTIFACT_SUFFIX = ".dump";

/**
 * The pg_dump argv. It carries NO connection information -- see the module header. `--no-password` is
 * not a convenience: this runs from a launchd/systemd timer with no terminal, and without it a missing
 * password makes pg_dump block on a prompt forever instead of failing the job. Pure.
 */
export function pgDumpArgv(dest: string): string[] {
	return ["pg_dump", "--format=custom", "--compress=9", "--no-password", `--file=${dest}`];
}

/**
 * The table-of-contents read that proves a dump is RESTORABLE. Cheap, and it catches a truncated or
 * corrupt file on the night it happens rather than on the night it is needed -- the same check
 * pg-dump.sh runs on the server, for the same reason. Pure.
 */
export function pgRestoreListArgv(dest: string): string[] {
	return ["pg_restore", "--list", dest];
}

/** The libpq environment carrying the connection. Pure, so the parsing is tested without a server. */
export function pgDumpEnv(url: string): Record<string, string> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new AppError(
			`the Postgres connection url is not a url: pg_dump needs host, database and user, and this cannot be parsed`,
		);
	}
	const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
	if (!database) {
		throw new AppError(`the Postgres connection url names no database, so there is nothing for pg_dump to dump`);
	}
	const env: Record<string, string> = { PGDATABASE: database };
	if (parsed.hostname) env.PGHOST = decodeURIComponent(parsed.hostname);
	if (parsed.port) env.PGPORT = parsed.port;
	if (parsed.username) env.PGUSER = decodeURIComponent(parsed.username);
	if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
	// A unix-socket connection is spelled `?host=/var/run/postgresql` by libpq, which URL parsing leaves
	// in the query string rather than in hostname. It wins: a socket path is never a TCP host.
	const socket = parsed.searchParams.get("host");
	if (socket) env.PGHOST = socket;
	return env;
}

/** How a human restores this artifact, printed beside it so the answer is not a year of archaeology. */
export function restoreHint(artifact: string): string {
	return `restore with: pg_restore --clean --if-exists --dbname omnislash ${artifact}  (or --table <name> for one table)`;
}

/** What a capture WOULD do, for `--dry-run`. The password is NEVER printed, here or anywhere. */
export function describeCapture(dest: string, url?: string): string {
	const env = pgDumpEnv(url ?? resolvePgUrl());
	return `${pgDumpArgv(dest).join(" ")}  (PGHOST=${env.PGHOST ?? "(default)"} PGDATABASE=${env.PGDATABASE} PGUSER=${env.PGUSER ?? "(default)"})`;
}

export interface CaptureRun {
	ok: boolean;
	stderr: string;
}

export type CaptureSpawn = (cmd: string[], env: Record<string, string>) => CaptureRun;

export interface CaptureRequest {
	/** Where the artifact is written. */
	dest: string;
	/** The connection url, defaulting to resolvePgUrl(). */
	url?: string;
	/** Injectable so a test can assert the argv and the env without a server. */
	spawn?: CaptureSpawn;
	/** Skip the pg_restore --list verification (it needs the file the dump just wrote). */
	verify?: boolean;
}

function spawnLocal(cmd: string[], env: Record<string, string>): CaptureRun {
	const proc = Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
	return { ok: proc.exitCode === 0, stderr: new TextDecoder().decode(proc.stderr).trim() };
}

/**
 * Take the copy. The one place a capture is performed, so `ob backup` and `ob db snapshot` cannot end up
 * disagreeing about what they copied or how it is restored.
 *
 * A failure THROWS rather than returning false, and the message says outright that there is no backup.
 * The whole class of bug this module exists for is a backup command that reports success having copied
 * nothing worth having, so the one thing it may never do is fail quietly.
 */
export function capture(req: CaptureRequest): void {
	const env = pgDumpEnv(req.url ?? resolvePgUrl());
	const spawn = req.spawn ?? spawnLocal;
	const dumped = spawn(pgDumpArgv(req.dest), env);
	if (!dumped.ok) {
		throw new AppError(
			[
				`pg_dump failed, so there is NO backup: ${dumped.stderr || "no output"}`,
				`  check that pg_dump is on PATH and that ${env.PGUSER ?? "the configured user"} can reach ${env.PGHOST ?? "the configured host"}/${env.PGDATABASE}.`,
				`  the connection comes from ${STORE_ENV}'s url (OMNISLASH_PG_URL or ~/.omnislash_pg_url).`,
			].join("\n"),
		);
	}
	if (req.verify === false) return;
	const listed = spawn(pgRestoreListArgv(req.dest), env);
	if (!listed.ok) {
		throw new AppError(
			[
				`${req.dest} is not readable by pg_restore, so it is NOT a backup: ${listed.stderr || "no output"}`,
				`  the file is kept for inspection rather than deleted, but do not count it as a copy of anything.`,
			].join("\n"),
		);
	}
}

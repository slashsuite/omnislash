// OB-1808: the client half of `ob db|backup|cert`, which the API host runs as a job (see host-jobs.ts).
//
// Two shapes, and each command is one or the other for a stated reason:
//   FOLLOW (default): start, poll, print the child's output and pass its exit code through. For a command whose
//     point is its answer: `cert status`, `db snapshot --list` and any `--dry-run`.
//   KICK: start, say so and return, `--wait` follows instead. For a command whose point is its effect and which
//     can take many minutes: `backup`, `db backup`, `db snapshot` (pg_dump) and `cert renew` (lego DNS-01).
// Neither holds an HTTP request open: a poll is a short GET, and the job outlives a client that goes away.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseSnapshotName } from "../commands/db.ts";
import { AppError, UsageError } from "../errors.ts";
import { expandHome } from "../net.ts";
import { print, warn } from "../output.ts";
import { renderJobs } from "../commands/jobs.ts";
import { ApiError } from "./client.ts";
import type { ApiCtx } from "./client-handlers.ts";
import type { HostJobKind, HostJobOptions, HostJobRow } from "./contract.ts";
import { hostJobArgv, hostJobLostReason, renderHostJob, renderHostJobs } from "./host-jobs.ts";

const POLL_MS = 1500;
const DEFAULT_WAIT_LIMIT_MS = 15 * 60 * 1000;

/** Test seam: a test does not sit through a real poll. */
export interface HostJobWait {
	sleep?: (ms: number) => Promise<void>;
	limitMs?: number;
	pollMs?: number;
}

/**
 * Poll until the job finishes. A network failure mid-poll is not the job's failure, so it keeps asking until the
 * limit; a refusal from the server is an answer and stops it. Giving up says the job is still going and how to
 * find it: it is not cancelled, and the caller must not read this as a failure and start another.
 */
async function followJob(ctx: ApiCtx, started: HostJobRow): Promise<HostJobRow> {
	const wait = ctx.hostJobWait;
	const sleep = wait?.sleep ?? ((ms: number) => Bun.sleep(ms));
	const limit = wait?.limitMs ?? DEFAULT_WAIT_LIMIT_MS;
	const deadline = Date.now() + limit;
	const later = `it may still be running on the host: ob jobs host ${started.id}`;
	for (;;) {
		try {
			const { job } = await ctx.client.hostJob(started.id);
			if (job.status !== "running") return job;
		} catch (err) {
			if (!(err instanceof ApiError)) throw err;
			if (err.status !== 0) throw new AppError(`could not read host job ${started.id}: ${err.message}\n  ${later}`);
		}
		if (Date.now() >= deadline) {
			throw new AppError(`stopped waiting for ${started.command} (${started.id}) after ${Math.round(limit / 1000)}s\n  ${later}`);
		}
		await sleep(wait?.pollMs ?? POLL_MS);
	}
}

/** The child's own output on the caller's own streams, and its exit code as ours. */
function finish(ctx: ApiCtx, job: HostJobRow): void {
	if (job.status === "lost") {
		throw new AppError(`${job.command} (${job.id}) on the host: ${hostJobLostReason(job.kind)}`);
	}
	if (job.stdout) print(job.stdout.replace(/\n$/, ""));
	if (job.stderr) warn(job.stderr);
	if (job.truncated) warn(`${job.id}: output cut to its last 64 KiB`);
	ctx.exit = job.exit_code ?? 1;
}

function modeOptions(ctx: ApiCtx): HostJobOptions {
	if (ctx.mode === "json") return { json: true };
	if (ctx.mode === "quiet") return { quiet: true };
	return {};
}

async function start(ctx: ApiCtx, kind: HostJobKind, options: HostJobOptions): Promise<HostJobRow> {
	const full = { ...options, ...modeOptions(ctx) };
	// A bad option is exit 2 here, before any request, the same as a bad flag on the host.
	hostJobArgv({ kind, options: full });
	return (await ctx.client.hostJobStart({ kind, options: full })).job;
}

async function runFollowed(ctx: ApiCtx, kind: HostJobKind, options: HostJobOptions = {}): Promise<void> {
	finish(ctx, await followJob(ctx, await start(ctx, kind, options)));
}

/** KICK, unless `--wait` asks to follow. A dry run is always followed: its only product is what it prints. */
async function runKicked(ctx: ApiCtx, kind: HostJobKind, options: HostJobOptions = {}): Promise<void> {
	const job = await start(ctx, kind, options);
	if (ctx.flags.wait === true || options.dryRun === true) {
		finish(ctx, await followJob(ctx, job));
		return;
	}
	if (ctx.mode === "json") print(JSON.stringify(job, null, 2));
	else if (ctx.mode === "quiet") print(job.id);
	else {
		print(`${job.reused ? "already running on the API host" : "started on the API host"}: ${job.command} (${job.id})`);
		print(`  follow: ob jobs host ${job.id}`);
	}
}

const dryRun = (ctx: ApiCtx): HostJobOptions => (ctx.flags["dry-run"] === true ? { dryRun: true } : {});

/** OB-1809: `ob whatsapp sync` reads the bridge's messages.db, which lives on the host. Followed: its product is the count it prints. */
export async function apiWhatsappSync(ctx: ApiCtx): Promise<void> {
	return runFollowed(ctx, "whatsapp-sync", {
		backfill: ctx.flags.backfill === true,
		since: ctx.flags.since,
		days: ctx.flags.days,
		max: ctx.flags.max,
	});
}

export async function apiWhatsappBridgeStatus(ctx: ApiCtx): Promise<void> {
	return runFollowed(ctx, "whatsapp-bridge-status");
}

export async function apiBackup(ctx: ApiCtx): Promise<void> {
	await runKicked(ctx, "backup", dryRun(ctx));
}

export async function apiDb(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === "backup") return runKicked(ctx, "db-backup", dryRun(ctx));
	if (sub === "fetch") return dbFetch(ctx);
	if (sub !== "snapshot") throw new UsageError(`unknown db subcommand '${sub ?? ""}' (backup, snapshot, fetch)`);
	// --dir names a path ON THE HOST that a snapshot would write to and PRUNE. A caller cannot see that directory,
	// and rotation deleting from a path typed on another machine is not a thing to allow by accident.
	if (ctx.flags.dir !== undefined) {
		throw new UsageError("db snapshot --dir is not available through the ob API: it names a directory on the API host, which rotation prunes. The host's own snapshot directory is used.");
	}
	// Rotation prunes before it writes, so these would delete the host's real history from another machine, in a job
	// nobody is watching. The host's own retention applies.
	for (const flag of ["keep-hourly", "keep-daily", "max-bytes"] as const) {
		if (ctx.flags[flag] !== undefined) {
			throw new UsageError(`db snapshot --${flag} is not available through the ob API: it changes what rotation deletes on the API host. The host's own retention is used.`);
		}
	}
	if (ctx.flags.list === true) return runFollowed(ctx, "db-snapshot-list");
	return runKicked(ctx, "db-snapshot", dryRun(ctx));
}

/** The dump comes back to this machine. It holds secrets only as ciphertext, and is written 0600 regardless. */
async function dbFetch(ctx: ApiCtx): Promise<void> {
	const name = ctx.args[1];
	if (!name) throw new UsageError("db fetch requires a <snapshot> name (ob db snapshot --list)");
	if (parseSnapshotName(name) === null) throw new UsageError(`'${name}' is not a snapshot name (ob db snapshot --list)`);
	const out = typeof ctx.flags.out === "string" ? resolve(ctx.cwd, expandHome(ctx.flags.out)) : join(tmpdir(), "ob-db-snapshots");
	mkdirSync(out, { recursive: true, mode: 0o700 });
	const dest = join(out, name);
	if (existsSync(dest) && ctx.flags.force !== true) {
		throw new AppError(`${dest} already exists; pass --force to replace it`);
	}
	const bytes = await ctx.client.dbSnapshotFetch(name, dest);
	if (ctx.mode === "json") print(JSON.stringify({ name, path: dest, bytes }));
	else print(dest);
}

export async function apiCert(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0] ?? "status";
	if (sub === "status") return runFollowed(ctx, "cert-status");
	if (sub === "renew") {
		return runKicked(ctx, "cert-renew", { force: ctx.flags.force === true, staging: ctx.flags.staging === true });
	}
	throw new UsageError(`unknown cert subcommand '${sub}' (status|renew)`);
}

/** `ob jobs`, plus `ob jobs host [<id>]`: what the host is running or ran for a client. */
export async function apiJobs(ctx: ApiCtx): Promise<void> {
	if (ctx.args[0] === "host") return apiJobsHost(ctx);
	const res = await ctx.client.jobs();
	if (ctx.mode === "json") print(JSON.stringify(res.jobs, null, 2));
	else if (ctx.mode === "quiet") print(res.jobs.map((r) => r.job).join("\n"));
	else print(renderJobs(res.jobs));
}

async function apiJobsHost(ctx: ApiCtx): Promise<void> {
	const first = ctx.args[1];
	if (first) {
		const { job } = await ctx.client.hostJob(first);
		if (ctx.mode === "json") print(JSON.stringify(job, null, 2));
		else if (ctx.mode === "quiet") print(job.status);
		else print(renderHostJob(job));
		return;
	}
	const { jobs } = await ctx.client.hostJobList();
	if (ctx.mode === "json") print(JSON.stringify(jobs, null, 2));
	else if (ctx.mode === "quiet") print(jobs.map((j) => j.id).join("\n"));
	else print(renderHostJobs(jobs));
}

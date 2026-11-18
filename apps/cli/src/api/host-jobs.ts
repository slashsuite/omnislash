// OB-1808: the API host runs `ob db|backup|cert|whatsapp` for a client, so none of them needs ssh.
//
// EVERY RUN IS A JOB. These commands shell out to pg_dump, lego, gh and ssh, several of them synchronously
// (Bun.spawnSync), and some take minutes. In the web process that would stall every other request; on the
// request it would hit the 120s deadline. So the server spawns a child `ob`, answers with the job's id, and a
// client polls. No HTTP request stays open while one of these works.
//
// THE CLIENT NAMES A KIND, NEVER AN ARGV. `hostJobArgv` builds the child's argv from a closed table and typed
// options, and there is no shell between it and the child, so nothing a caller sends can become a command.
//
// STATE IS FILES ON THE HOST, no migration: <root>/<id>/{job.json,stdout,stderr,exit}. The `exit` file is
// written by the wrapper around the child, not by the web process, so a job that finishes reports truthfully
// after a dashboard restart. A restart that KILLS the job (systemd stops the whole cgroup, so a deploy does)
// leaves no exit file and a dead pid, which reads `lost`: an honest answer, and the caller re-runs it.
//
// A PID ALONE IS NOT AN IDENTITY (OB-1932). After a reboot or a long uptime the recorded pid can belong to an
// unrelated process, so the record also keeps the process's start identity (`processStart`) and a job is only
// `running` while the process at that pid is the one that was started.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Store } from "../db/store.ts";
import { UsageError } from "../errors.ts";
import { API_BASE_ENV, API_BASE_FILE_ENV } from "./config.ts";
import { defaultMasterKey, getSecret, listSecrets, type MasterKey } from "../secrets.ts";
import { stripUrlCredentials } from "../network/sanitize.ts";
import type { HostJobKind, HostJobOptions, HostJobRequest, HostJobRow, HostJobStatus } from "./contract.ts";

type FlagSpec = { [K in keyof HostJobOptions]?: string };

interface KindSpec {
	base: readonly string[];
	flags: FlagSpec;
}

const DRY: FlagSpec = { dryRun: "--dry-run" };

const KINDS: Record<HostJobKind, KindSpec> = {
	backup: { base: ["backup"], flags: DRY },
	"db-backup": { base: ["db", "backup"], flags: DRY },
	"db-snapshot": { base: ["db", "snapshot"], flags: DRY },
	"db-snapshot-list": { base: ["db", "snapshot", "--list"], flags: {} },
	"cert-status": { base: ["cert", "status"], flags: {} },
	"cert-renew": { base: ["cert", "renew"], flags: { force: "--force", staging: "--staging" } },
	"whatsapp-bridge-status": { base: ["whatsapp", "bridge", "status"], flags: {} },
	"whatsapp-sync": {
		base: ["whatsapp", "sync"],
		flags: { backfill: "--backfill", since: "--since", days: "--days", max: "--max" },
	},
};

/** The options that carry a value. It goes to the child as one `--flag=value` token, and its format is the child's to check. */
const VALUE_OPTIONS = new Set(["since", "days", "max"]);

/** Output modes apply to every kind; the child's own --json IS the job's output. */
const COMMON: FlagSpec = { json: "--json", quiet: "--quiet" };

/** The argv after `ob`. Refuses an unknown kind or an option that kind does not take. Pure. */
export function hostJobArgv(req: HostJobRequest): string[] {
	const spec = KINDS[req.kind];
	if (!spec) throw new UsageError(`unknown host job kind '${String(req.kind)}' (${Object.keys(KINDS).join(", ")})`);
	const allowed: FlagSpec = { ...spec.flags, ...COMMON };
	const argv = [...spec.base];
	for (const [name, value] of Object.entries(req.options ?? {})) {
		if (value === undefined || value === false) continue;
		const flag = allowed[name as keyof HostJobOptions];
		if (!flag) throw new UsageError(`host job ${req.kind} does not take '${name}'`);
		if (VALUE_OPTIONS.has(name)) {
			if (typeof value !== "string") throw new UsageError(`'${name}' must be a string`);
			argv.push(`${flag}=${value}`);
			continue;
		}
		if (value !== true) throw new UsageError(`'${name}' must be a boolean`);
		argv.push(flag);
	}
	return argv;
}

/** A request body off the wire, checked. Everything past the shape is `hostJobArgv`'s. */
export function parseHostJobRequest(body: Record<string, unknown>): HostJobRequest {
	const options = body.options ?? {};
	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		throw new UsageError("'options' must be an object");
	}
	const req: HostJobRequest = { kind: body.kind as HostJobKind, options: options as HostJobOptions };
	hostJobArgv(req);
	return req;
}

// --- the host side ------------------------------------------------------------------------------------

export interface HostJobSpawn {
	argv: readonly string[];
	/** The job's directory: the wrapper writes stdout, stderr and exit here. */
	dir: string;
	env: Record<string, string | undefined>;
}

export interface HostJobDeps {
	root?: string;
	/** Starts the job and returns its pid. Tests inject a fake; production runs the wrapper below. */
	spawn?: (spec: HostJobSpawn) => number;
	/**
	 * The start identity of the process at `pid`: null when there is none, `""` when there is one whose identity
	 * cannot be read (no /proc, as on macOS), otherwise a string that differs for any other process that ever
	 * holds the same pid.
	 */
	processStart?: (pid: number) => string | null;
	env?: Record<string, string | undefined>;
	now?: () => Date;
}

/** Where the live snapshot timer writes (omnislash-db-snapshot.service); see `hostJobEnv`. */
export const LIVE_SNAPSHOT_DIR = "/var/lib/omnislash/snapshots";

/** The same ceiling omnislash-backup.service gives its own run: a hung pg_dump cannot hold a job forever. */
const HOST_JOB_TIMEOUT_S = 3600;
const KEEP_FINISHED = 20;
/** The tail a caller sees of each stream. Read wider than shown, so a secret the cut splits is still scrubbed. */
const OUTPUT_SHOWN_BYTES = 64 * 1024;
const OUTPUT_READ_BYTES = 128 * 1024;

const ID_RE = /^hj-\d{14}-[0-9a-f]{6}$/;

/** A job id, checked before it reaches a path. */
export function isHostJobId(id: string): boolean {
	return ID_RE.test(id);
}

function rootOf(deps: HostJobDeps): string {
	return deps.root ?? join(homedir(), ".local", "state", "omnislash", "host-jobs");
}

/** A pidless record younger than this is a job that is starting; older, it is a spawn that never finished. */
const STARTING_GRACE_MS = 15_000;
/** Stored as `pid_start` when the process was already gone as `spawn` returned: it matches nothing. */
const GONE = "gone";

/**
 * `<boot_id>:<starttime>` on Linux: the boot id changes across a reboot and field 22 of /proc/<pid>/stat
 * (clock ticks since boot) changes for every process that takes the pid, so together they name one process.
 * The command name (field 2) can hold spaces and parentheses, so the fields are counted after the last `)`.
 */
export function defaultProcessStart(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const starttime = fields[19]; // field 22 overall; fields[0] is field 3 (state)
		const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		return starttime && boot ? `${boot}:${starttime}` : "";
	} catch {
		try {
			process.kill(pid, 0);
			return "";
		} catch {
			return null;
		}
	}
}

/**
 * The wrapper. It is `sh`, not this process, that records the exit, so the record survives us. It takes the
 * argv as positional parameters and only ever expands them quoted: nothing in it is interpolated.
 */
const WRAPPER = `d=$1; shift; timeout -k 30 ${HOST_JOB_TIMEOUT_S} "$@" >"$d/stdout" 2>"$d/stderr" </dev/null; echo $? >"$d/exit.tmp"; mv "$d/exit.tmp" "$d/exit"`;

function defaultSpawn(spec: HostJobSpawn): number {
	const proc = Bun.spawn(["sh", "-c", WRAPPER, "sh", spec.dir, ...spec.argv], {
		env: spec.env as Record<string, string>,
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	proc.unref();
	return proc.pid;
}

/**
 * The child's environment: the web service's own, which already carries the master key file and PATH.
 * - OMNISLASH_DB goes: it names the frozen SQLite leftover (ob 550), and these all run on the Postgres store.
 * - The API base goes too, variable and file: a child that found one would be an API client, and would ask this
 *   very server to start itself.
 * - OMNISLASH_UNATTENDED=1: nobody can answer a prompt, and it has to be said so (`isUnattended`).
 * - The snapshot dir is the timer's, which omnislash-web.service does not set, or `--list` would read an empty
 *   directory beside the real one and call that the answer.
 */
function hostJobEnv(deps: HostJobDeps): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...(deps.env ?? process.env), OMNISLASH_UNATTENDED: "1" };
	delete env.OMNISLASH_DB;
	delete env[API_BASE_ENV];
	env[API_BASE_FILE_ENV] = "/dev/null";
	const snapshots = hostSnapshotDirOverride(env);
	if (snapshots) env.OMNISLASH_SNAPSHOT_DIR = snapshots;
	return env;
}

function hostSnapshotDirOverride(env: Record<string, string | undefined>): string | undefined {
	if (env.OMNISLASH_SNAPSHOT_DIR) return env.OMNISLASH_SNAPSHOT_DIR;
	return existsSync(LIVE_SNAPSHOT_DIR) ? LIVE_SNAPSHOT_DIR : undefined;
}

/** The directory a job's `db snapshot` uses on this host, so the fetch endpoint serves from the same place. */
export function hostSnapshotDir(deps: HostJobDeps = {}): string | undefined {
	return hostSnapshotDirOverride(deps.env ?? process.env);
}

interface JobRecord {
	id: string;
	kind: HostJobKind;
	argv: string[];
	started_at: string;
	pid: number | null;
	/** The pid's start identity, read right after spawn. Absent or null on a record written before OB-1932. */
	pid_start?: string | null;
}

function readRecord(dir: string): JobRecord | null {
	try {
		return JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as JobRecord;
	} catch {
		return null;
	}
}

function jobStatus(dir: string, record: JobRecord, deps: HostJobDeps): { status: HostJobStatus; code: number | null; finished: string | null } {
	const exitFile = join(dir, "exit");
	if (existsSync(exitFile)) {
		const code = Number(readFileSync(exitFile, "utf8").trim());
		return { status: code === 0 ? "ok" : "failed", code, finished: statSync(exitFile).mtime.toISOString() };
	}
	return { status: isRunning(record, deps) ? "running" : "lost", code: null, finished: null };
}

/** No exit file: is the process this record started still the one at its pid? */
function isRunning(record: JobRecord, deps: HostJobDeps): boolean {
	if (record.pid === null) {
		// Starting: the record is written before the spawn. The wire has no `starting`, so it reads as running.
		const age = (deps.now ?? (() => new Date()))().getTime() - Date.parse(record.started_at);
		return age < STARTING_GRACE_MS;
	}
	const current = (deps.processStart ?? defaultProcessStart)(record.pid);
	if (current === null) return false;
	const recorded = record.pid_start;
	if (recorded === undefined || recorded === null) return true; // legacy record: the pid-only rule
	if (recorded === GONE) return false;
	if (recorded === "" || current === "") return true; // identity unreadable on one side: the pid-only rule
	return recorded === current;
}

/** job.json is replaced whole, so a reader in another process never sees half a file. */
function writeRecordAtomic(dir: string, record: JobRecord): void {
	const tmp = join(dir, "job.json.tmp");
	writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
	renameSync(tmp, join(dir, "job.json"));
}

function rowOf(dir: string, record: JobRecord, deps: HostJobDeps): HostJobRow {
	const { status, code, finished } = jobStatus(dir, record, deps);
	return {
		id: record.id,
		kind: record.kind,
		command: `ob ${record.argv.join(" ")}`,
		status,
		exit_code: code,
		started_at: record.started_at,
		finished_at: finished,
	};
}

function jobDirs(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.filter(isHostJobId)
		.sort()
		.reverse();
}

function prune(root: string, deps: HostJobDeps): void {
	let finished = 0;
	for (const id of jobDirs(root)) {
		const dir = join(root, id);
		const record = readRecord(dir);
		if (record && jobStatus(dir, record, deps).status === "running") continue;
		finished += 1;
		if (finished > KEEP_FINISHED) rmSync(dir, { recursive: true, force: true });
	}
}

function timestamp(d: Date): string {
	return d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * Start a job, or hand back the identical one already running: a double-kick of `ob backup` or a retried POST
 * must not run two pg_dumps. Only a job with the same argv counts, so `--dry-run` never joins a real run.
 *
 * The dedup holds because the check above and the start below are synchronous within one process. Two processes
 * that share this root (the live and dev web services on one host do) could still start the same job twice, which
 * is accepted. A future `await` between the check and the start must add a lock first.
 */
export function startHostJob(req: HostJobRequest, deps: HostJobDeps = {}): HostJobRow {
	const argv = hostJobArgv(req);
	const root = rootOf(deps);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	for (const id of jobDirs(root)) {
		const dir = join(root, id);
		const record = readRecord(dir);
		if (!record || record.argv.join("\0") !== argv.join("\0")) continue;
		if (jobStatus(dir, record, deps).status === "running") return { ...rowOf(dir, record, deps), reused: true };
	}
	prune(root, deps);

	const now = (deps.now ?? (() => new Date()))();
	const id = `hj-${timestamp(now)}-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true, mode: 0o700 });

	const record: JobRecord = {
		id,
		kind: req.kind,
		argv,
		started_at: now.toISOString(),
		pid: null,
	};
	writeRecordAtomic(dir, record);
	const env = hostJobEnv(deps);
	const bin = env.OMNISLASH_OB_BIN ?? "ob";
	try {
		record.pid = (deps.spawn ?? defaultSpawn)({ argv: [bin, ...argv], dir, env });
	} catch (error) {
		// A failed spawn leaves nothing: a pidless record would read `lost` for good.
		rmSync(dir, { recursive: true, force: true });
		throw error;
	}
	record.pid_start = (deps.processStart ?? defaultProcessStart)(record.pid) ?? GONE;
	writeRecordAtomic(dir, record);
	return rowOf(dir, record, deps);
}

export function listHostJobs(deps: HostJobDeps = {}): HostJobRow[] {
	const root = rootOf(deps);
	const rows: HostJobRow[] = [];
	for (const id of jobDirs(root)) {
		const dir = join(root, id);
		const record = readRecord(dir);
		if (record) rows.push(rowOf(dir, record, deps));
	}
	return rows;
}

function tail(path: string): { text: string; cut: boolean } {
	if (!existsSync(path)) return { text: "", cut: false };
	const size = statSync(path).size;
	const length = Math.min(size, OUTPUT_READ_BYTES);
	const buf = Buffer.alloc(length);
	const fd = openSync(path, "r");
	try {
		readSync(fd, buf, 0, length, size - length);
	} finally {
		closeSync(fd);
	}
	return { text: buf.toString("utf8"), cut: size > OUTPUT_READ_BYTES };
}

const CREDENTIAL_SHAPES: readonly RegExp[] = [
	/\bgh[pousr]_[A-Za-z0-9_]{20,}/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{20,}/gi,
	/\b(access_token|refresh_token|client_secret|password|CF_DNS_API_TOKEN)=[^&\s"']+/g,
];

/**
 * What a job's output may say. The commands do not print credentials by design; this is the belt to that braces,
 * because the output also carries what gh, lego, ssh and pg_dump chose to say. `values` are this host's known
 * secret values; the shapes catch a credential the store does not hold. Values under 4 characters are skipped:
 * scrubbing those would shred the output and protect nothing.
 */
export function scrubHostOutput(text: string, values: readonly string[]): string {
	let out = stripUrlCredentials(text);
	for (const value of values) {
		if (value.length < 4) continue;
		out = out.split(value).join("<redacted>");
	}
	for (const shape of CREDENTIAL_SHAPES) out = out.replace(shape, "<redacted>");
	return out;
}

/**
 * Every stored secret's value, for scrubbing a job's output and for nothing else. A host with no master key gets an
 * empty list: its child could not have read those secrets either, and the shape-based scrub still runs. Any other
 * failure throws, so the output is withheld rather than sent half scrubbed. Never logged.
 */
export async function hostOutputSecretValues(store: Store, masterKey?: MasterKey): Promise<string[]> {
	let key: ReturnType<MasterKey["get"]>;
	try {
		key = (masterKey ?? defaultMasterKey()).get();
	} catch {
		return [];
	}
	const values: string[] = [];
	for (const { name } of await listSecrets(store)) {
		const value = await getSecret(store, name, key);
		if (value) values.push(value);
	}
	return values;
}

/**
 * One job, with its output once it has finished. A running job has none: polling must stay cheap, and a caller
 * following it gets the whole of it at the end.
 */
export function readHostJob(id: string, secretValues: readonly string[], deps: HostJobDeps = {}): HostJobRow | null {
	if (!isHostJobId(id)) return null;
	const dir = join(rootOf(deps), id);
	const record = readRecord(dir);
	if (!record) return null;
	const row = rowOf(dir, record, deps);
	if (row.status === "running") return row;
	const stdout = tail(join(dir, "stdout"));
	const stderr = tail(join(dir, "stderr"));
	const shown = (text: string) => {
		const clean = scrubHostOutput(text, secretValues);
		return clean.length > OUTPUT_SHOWN_BYTES ? clean.slice(-OUTPUT_SHOWN_BYTES) : clean;
	};
	return {
		...row,
		stdout: shown(stdout.text),
		stderr: shown(stderr.text),
		truncated: stdout.cut || stderr.cut || stdout.text.length > OUTPUT_SHOWN_BYTES || stderr.text.length > OUTPUT_SHOWN_BYTES,
	};
}


export function renderHostJobs(rows: HostJobRow[]): string {
	if (rows.length === 0) return "no host jobs yet";
	return rows
		.map((r) => `${r.id}  ${r.status.padEnd(7)} ${r.exit_code === null ? " " : String(r.exit_code)}  ${r.started_at}  ${r.command}`)
		.join("\n");
}

/**
 * Why a `lost` job died. A renewal that installs a new certificate fires omnislash-cert-reload.path, which restarts the
 * web service this job runs under, so a lost renewal has probably succeeded and --force would spend Let's Encrypt quota.
 */
export function hostJobLostReason(kind: HostJobKind): string {
	if (kind === "cert-renew") {
		return "it died without recording an exit. Installing a new certificate restarts the host, which ends this job, so check 'ob cert status' before running it again.";
	}
	return "it died without recording an exit: the host restarted under it (a deploy does that). Run it again.";
}

export function renderHostJob(row: HostJobRow): string {
	const lines = [
		`${row.id}  ${row.status}${row.exit_code === null ? "" : ` (exit ${row.exit_code})`}  ${row.command}`,
		`  started ${row.started_at}${row.finished_at ? `, finished ${row.finished_at}` : ""}`,
	];
	if (row.status === "lost") {
		lines.push(`  ${hostJobLostReason(row.kind)}`);
	}
	if (row.truncated) lines.push("  output cut to its last 64 KiB");
	if (row.stdout) lines.push(row.stdout.trimEnd());
	if (row.stderr) lines.push(row.stderr.trimEnd());
	return lines.join("\n");
}

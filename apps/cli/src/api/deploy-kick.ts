// OB-1809: POST /deploys/run, the API's way to start a live deploy, so `ob deploy run` needs no ssh.
//
// The API is the thing a deploy restarts, so nothing here may run the deploy as this process's child: a
// child lives in omnislash-web's cgroup and dies on the restart. It asks systemd to start
// omnislash-deploy.service instead, the unit that runs the same ob-deploy.sh in its own cgroup, and returns
// without waiting (--no-block). The deploy outlives the restart it causes, and its own record retries
// outlast the API coming back.
//
// A unit cannot take an argument from `systemctl start`, and the sudoers rule allows one exact command
// line, so the pin travels in a request file the script reads and deletes. The script still decides: a pin
// that is not origin/main's tip refuses there, exactly as it does for the ssh kick.
import { randomUUID } from "node:crypto";
import { writeFileSync, renameSync } from "node:fs";
import type { Store } from "../db/store.ts";
import { DEPLOY_SHA_RE, LIVE_DEPLOY_TARGET, listDeploys, recordDeploy, recordLiveRefused } from "../commands/deploy.ts";
import { ApiFault } from "./fault.ts";
import type { DeployRunRequest, DeployRunResponse } from "./contract.ts";

/** Set only by omnislash-web.service. The dev instance and a laptop's `ob web` serve this API too, and must not restart production. */
export const DEPLOY_ENABLED_ENV = "OMNISLASH_API_DEPLOY_ENABLED";
/** Must match REQUEST_FILE in the server's deploy script, which honours the same override. */
export const DEPLOY_REQUEST_FILE_ENV = "OMNISLASH_DEPLOY_REQUEST_FILE";
const DEFAULT_REQUEST_FILE = "/var/lib/omnislash/deploy-request";
const DEPLOY_UNIT = "omnislash-deploy.service";
/** Exactly the server's sudoers line for the deploy unit: sudoers matches the whole command line. */
export const DEPLOY_START_ARGV = ["sudo", "-n", "/usr/bin/systemctl", "start", "--no-block", DEPLOY_UNIT] as const;
const COMMAND_TIMEOUT_MS = 8_000;

export interface DeployCommandResult {
	code: number;
	stdout: string;
	stderr: string;
	/** OB-1926: set when defaultRun's timer killed the process, so a partial stdout is never read as an answer. */
	timedOut?: boolean;
}

/** OB-1926: every state `systemctl is-active` can print. Anything else (empty, garbage, a timeout) is not an answer. */
const UNIT_STATES = new Set(["active", "inactive", "failed", "activating", "deactivating", "reloading", "maintenance", "refreshing"]);

export interface DeployKickDeps {
	/** Runs systemctl. Tests inject a fake so nothing reaches systemd. */
	run?: (argv: readonly string[]) => Promise<DeployCommandResult>;
	env?: Record<string, string | undefined>;
}

async function defaultRun(argv: readonly string[]): Promise<DeployCommandResult> {
	const p = Bun.spawn({ cmd: [...argv], stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		p.kill();
	}, COMMAND_TIMEOUT_MS);
	try {
		const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
		return { code, stdout, stderr, ...(timedOut ? { timedOut } : {}) };
	} finally {
		clearTimeout(timer);
	}
}

function writeRequest(path: string, sha: string | undefined): void {
	// Always written, empty for no pin, so an unpinned kick cannot inherit a pin an older kick left behind.
	const tmp = `${path}.${randomUUID()}.tmp`;
	writeFileSync(tmp, sha === undefined ? "" : `${sha}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

// OB-1926: one kick at a time. Two concurrent kicks could both read `inactive` before either start registered, and
// both answer `kicked`. The API is one process, so a module-level promise chain serialises the check, the request
// write and the start: the second kick runs its is-active after the first start has returned.
let kickChain: Promise<unknown> = Promise.resolve();

export function kickLiveDeploy(store: Store, req: DeployRunRequest, deps: DeployKickDeps = {}): Promise<DeployRunResponse> {
	const next = kickChain.then(() => kickLiveDeployLocked(store, req, deps));
	kickChain = next.catch(() => undefined);
	return next;
}

async function kickLiveDeployLocked(store: Store, req: DeployRunRequest, deps: DeployKickDeps): Promise<DeployRunResponse> {
	const { sha } = req;
	if (sha !== undefined && !DEPLOY_SHA_RE.test(sha)) {
		throw new ApiFault("invalid_request", 400, "'sha' must be a commit id (7-40 lowercase hex)");
	}
	const env = deps.env ?? process.env;
	if (env[DEPLOY_ENABLED_ENV] !== "1") {
		throw new ApiFault("refused", 409, `this ob API does not run live deploys: only the live omnislash-web.service does, with ${DEPLOY_ENABLED_ENV}=1. On the live server, run the install script as root and restart omnislash-web; until then the last resort is ob deploy run --ssh`);
	}
	const run = deps.run ?? defaultRun;
	const requestFile = env[DEPLOY_REQUEST_FILE_ENV] || DEFAULT_REQUEST_FILE;

	let reason: string;
	try {
		// `is-active` exits non-zero for every state but active, so its answer is stdout, not the code. A oneshot
		// is `activating` for its whole run; a second start would be swallowed, so say so rather than claim a kick.
		// OB-1926: and since it exits non-zero for `inactive` too, the code cannot tell a refusal from a hang. Only a run
		// that finished and printed a known state is an answer; a timeout, a spawn error or unknown output refuses.
		const checked = await run(["systemctl", "is-active", DEPLOY_UNIT]);
		const state = checked.stdout.trim();
		if (checked.timedOut) throw new Error(`systemctl is-active ${DEPLOY_UNIT} timed out after ${COMMAND_TIMEOUT_MS / 1000}s`);
		if (!UNIT_STATES.has(state)) throw new Error(`systemctl is-active ${DEPLOY_UNIT} gave no known state (${JSON.stringify(state)}${checked.stderr.trim() ? `, ${checked.stderr.trim()}` : ""})`);
		if (state === "activating" || state === "deactivating") {
			throw new ApiFault("refused", 409, "a live deploy is already running; run this again after it finishes (ob deploy status)");
		}
		writeRequest(requestFile, sha);
		const started = await run(DEPLOY_START_ARGV);
		if (started.code === 0) return { kicked: true, target: LIVE_DEPLOY_TARGET, ...(sha === undefined ? {} : { sha }) };
		reason = started.stderr.trim() || `exit ${started.code}`;
	} catch (e) {
		if (e instanceof ApiFault) throw e;
		reason = (e as Error).message;
	}
	// The request stays: a start that timed out may still have been queued, and a missing file means "no pin". A pin left behind can only refuse, and the next API kick overwrites it.
	await recordLiveRefused({ list: () => listDeploys(store), record: (input) => recordDeploy(store, input) });
	throw new ApiFault(
		"refused",
		409,
		`could not start ${DEPLOY_UNIT}: ${reason}. Recorded refused for live. If the sudoers rule is missing, run the install script on the server; the last resort is ob deploy run --ssh`,
	);
}

// ob 353: what `ob` does when this machine is an API client.
//
// This is the whole of the client's routing, and it runs BEFORE any database is opened. A known HANDLER
// has two outcomes (416 killed the unrouted third class):
//
//   1. the command is routed  -> its API handler makes one typed call and renders the answer.
//   2. it is local-only       -> it runs here (`daemon`, which touches no tracker data) or refuses BY NAME.
// unroutedRefusal is the safety net for a HANDLER added without classification.
//
// No branch below asks where the machine is, and none of them opens a store. That is map decision D2: one
// data path, or a loud refusal.
import type { Database } from "bun:sqlite";
import type { Ctx, Flags } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { modeFromFlags, printedBytes, type Mode } from "../output.ts";
import type { Store } from "../db/store.ts";
import { ApiClient, type ApiDownload, type ApiTransport } from "./client.ts";
import { resolveApiToken } from "./config.ts";
import { API_HANDLERS, type ApiCtx } from "./client-handlers.ts";
import { isApiRouted, localOnly, localOnlyRefusal, localStoreRefusal, unroutedRefusal } from "./routing.ts";

export interface RunApiOptions {
	command: string;
	args: string[];
	flags: Flags;
	base: string;
	/** Injected by tests so the suite reaches no network; production uses fetch. */
	transport?: ApiTransport;
	/** OB-1808: the byte-stream seam for files. Tests inject; production omits. */
	download?: ApiDownload;
	/** Injected by tests so a token file is never needed to exercise the routing. */
	token?: string;
	cwd?: string;
	git?: (cwd: string) => { branch?: string; worktree?: string };
	/** The local handler for a LOCAL_ONLY "run" command, injected so this module imports no command. */
	localHandler?: (ctx: Ctx) => void | Promise<void>;
	/** 420: google-auth seams. Tests inject; production omits and the real loopback runs. */
	googleAuth?: ApiCtx["googleAuth"];
	/** ob 636: ssh seam for `ob deploy run`. Tests inject; production omits. */
	deploySsh?: ApiCtx["deploySsh"];
	cloudflareFetch?: ApiCtx["cloudflareFetch"];
	/** OB-1808: how a client waits on a host job. Tests inject; production omits. */
	hostJobWait?: ApiCtx["hostJobWait"];
}

/**
 * A handle and a store that CANNOT be used, for the local-only commands that run on an API client.
 *
 * `daemon` renders launchd plists and shells out to launchctl; it reads no tracker data, which is why it
 * still runs here. It is handed these rather than a real connection so that if it (or anything it grows
 * into) ever reaches for the data, it says so by name instead of opening a second path to it. Same device
 * as ob 337's unusableSqliteHandle, for the same reason.
 */
export function unreachableStore(command: string): Store {
	const refuse = (prop: string): never => {
		throw new AppError(localStoreRefusal(command, `store.${prop}`));
	};
	return new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "kind") return "api-client";
				if (prop === "close") return async () => {};
				if (prop === Symbol.toStringTag) return "UnreachableStore";
				return refuse(String(prop));
			},
			has() {
				return false;
			},
			set(_t, prop) {
				return refuse(String(prop));
			},
		},
	) as unknown as Store;
}

export function unreachableDatabase(command: string): Database {
	const refuse = (prop: string): never => {
		throw new AppError(localStoreRefusal(command, `db.${prop}`));
	};
	return new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "close") return () => {};
				if (prop === "inTransaction") return false;
				if (prop === Symbol.toStringTag) return "UnreachableDatabase";
				return refuse(String(prop));
			},
			has() {
				return false;
			},
			set(_t, prop) {
				return refuse(String(prop));
			},
		},
	) as unknown as Database;
}

function defaultGit(cwd: string): { branch?: string; worktree?: string } {
	const read = (args: string[]): string | undefined => {
		try {
			const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
			if (p.exitCode !== 0) return undefined;
			const out = new TextDecoder().decode(p.stdout).trim();
			return out.length > 0 ? out : undefined;
		} catch {
			return undefined;
		}
	};
	return { branch: read(["rev-parse", "--abbrev-ref", "HEAD"]), worktree: read(["rev-parse", "--show-toplevel"]) };
}

/** Run one invocation against the API. Returns the process exit code; never opens a database. */
export async function runApi(options: RunApiOptions): Promise<number> {
	const { command, args, flags, base } = options;
	const mode: Mode = modeFromFlags(flags);

	const local = localOnly(command);
	if (local && local.disposition === "refuse") {
		process.stderr.write(`error: ${localOnlyRefusal(command, local.reason, local.where)}\n`);
		return 1;
	}
	if (!local && !isApiRouted(command)) {
		process.stderr.write(`error: ${unroutedRefusal(command, base)}\n`);
		return 1;
	}

	if (local) {
		// A local-only command that needs no tracker data. It gets handles that refuse by name rather than
		// a connection, so "runs locally" can never quietly become "opened a second path to the data".
		const handler = options.localHandler;
		if (!handler) {
			process.stderr.write(`error: ${localOnlyRefusal(command, local.reason, local.where)}\n`);
			return 1;
		}
		const ctx: Ctx = {
			db: unreachableDatabase(command),
			store: unreachableStore(command),
			dbPath: "",
			mode,
			flags,
			args,
		};
		try {
			await handler(ctx);
			return ctx.exit ?? 0;
		} catch (err) {
			process.stderr.write(`error: ${(err as Error).message}\n`);
			return err instanceof UsageError ? 2 : 1;
		}
	}

	let client: ApiClient;
	try {
		client = new ApiClient({
			base,
			token: options.token ?? resolveApiToken(),
			transport: options.transport,
			download: options.download,
		});
	} catch (err) {
		process.stderr.write(`error: ${(err as Error).message}\n`);
		return 1;
	}

	const ctx: ApiCtx = {
		client,
		mode,
		flags,
		args,
		cwd: options.cwd ?? process.cwd(),
		git: options.git ?? defaultGit,
		googleAuth: options.googleAuth,
		deploySsh: options.deploySsh,
		cloudflareFetch: options.cloudflareFetch,
		hostJobWait: options.hostJobWait,
	};
	try {
		await API_HANDLERS[command]!(ctx);
		const code = ctx.exit ?? 0;
		// The same guarantee the local path gives (149): a `--json` invocation either prints parseable JSON
		// or exits non-zero with a reason, never both silent and successful.
		if (mode === "json" && code === 0 && printedBytes() === 0) {
			process.stderr.write(`error: '${command}' produced no --json output (this is a bug in ob, not in the caller)\n`);
			return 1;
		}
		return code;
	} catch (err) {
		process.stderr.write(`error: ${(err as Error).message}\n`);
		if (err instanceof UsageError) return 2;
		return 1;
	}
}

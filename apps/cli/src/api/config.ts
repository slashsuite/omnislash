// ob 353: where the client's API address comes from, and how it reads the token ob 352 already defined.
//
// The token PATH and its environment override are 352's (`api/token.ts`): one definition of where the
// credential lives, shared by the server that checks it and the client that presents it. What is here is
// the half 352 has no use for -- which host to call, and the setup guide a machine with no token needs.
//
// Map decision D2: there is ONE data path. This module decides whether `ob` is an API client at all, and
// it decides it from configuration rather than from where the machine happens to be. A client that can
// reach the data two ways eventually reaches it the wrong way and says nothing (ob 237, ob 324), so there
// is no "LAN? then Postgres" branch anywhere below, and no fallback to Postgres when the API is down: an
// unreachable API is an error, not a reason to open a database.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AppError } from "../errors.ts";
import { OB_API_TOKEN_FILE_ENV, tokenPath } from "./token.ts";

export const API_BASE_ENV = "OMNISLASH_API";
export const API_BASE_FILE_ENV = "OMNISLASH_API_URL_FILE";
/** A one-off token without touching a file. Tests use it; so does a first call from a new shell. */
export const API_TOKEN_ENV = "OMNISLASH_API_TOKEN";

// Cloudflare Access sits in FRONT of the API when it is reached over the tunnel (ob 354), and it
// speaks its own pair of headers rather than the Authorization header the API itself authenticates
// with. Both layers are required off-LAN: Access decides whether the request reaches the API host at all,
// the bearer token decides whether the API answers it. A LAN client sets neither of these and is
// unaffected -- which is why they are read separately and are optional.
export const ACCESS_CLIENT_ID_ENV = "OMNISLASH_API_ACCESS_CLIENT_ID";
export const ACCESS_CLIENT_SECRET_ENV = "OMNISLASH_API_ACCESS_CLIENT_SECRET";
export const ACCESS_FILE_ENV = "OMNISLASH_API_ACCESS_FILE";

/** The Access service-token pair, or null when none is configured (the LAN case). */
export function resolveAccessCredentials(): { id: string; secret: string } | null {
	const id = process.env[ACCESS_CLIENT_ID_ENV]?.trim();
	const secret = process.env[ACCESS_CLIENT_SECRET_ENV]?.trim();
	if (id && secret) return { id, secret };
	const path = process.env[ACCESS_FILE_ENV]?.trim() || join(homedir(), ".ob_access_service_token.json");
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { client_id?: string; client_secret?: string };
		if (!raw.client_id || !raw.client_secret) return null;
		return { id: raw.client_id, secret: raw.client_secret };
	} catch {
		// A malformed file is treated as absent rather than fatal: on the LAN the request succeeds
		// without Access, and off-LAN Cloudflare's own 403 says far more than a parse error would.
		return null;
	}
}

/** The expected mode of the token file, stated in every message rather than left to be guessed at. */
export const API_TOKEN_FILE_MODE = 0o600;

/** Default location of the base-url file, for a machine that would rather not set a variable. */
export function defaultApiBasePath(): string {
	return join(homedir(), ".omnislash_api_url");
}

/**
 * The API base url this process talks to, or null when this machine is not an API client.
 *
 * Null is what keeps phase B landable while phase C is still unbuilt: with nothing configured `ob` behaves
 * exactly as it does today (ob 337's Postgres path), and configuring a base url moves EVERY data command
 * onto HTTP at once. There is no per-command and no per-location choice -- that is the whole of D2.
 */
export function resolveApiBase(raw?: string): string | null {
	const env = (raw ?? process.env[API_BASE_ENV] ?? "").trim();
	if (env) return normalizeBase(env, API_BASE_ENV);
	const path = process.env[API_BASE_FILE_ENV]?.trim() || defaultApiBasePath();
	if (existsSync(path)) {
		const contents = readFileSync(path, "utf8").trim();
		if (contents.length > 0) return normalizeBase(contents, path);
	}
	return null;
}

/** Is this process an API client (D2: all of the data, or none of it)? */
export function isApiClient(raw?: string): boolean {
	return resolveApiBase(raw) !== null;
}

function normalizeBase(value: string, source: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new AppError(
			[
				`${source} is not a url: '${value}'`,
				`  it must be the API's origin, for example https://ob.example.org or http://10.0.0.130:5050`,
			].join("\n"),
		);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new AppError(`${source} must be http or https, not '${url.protocol}' (${value})`);
	}
	if (url.username || url.password) {
		// A credential in a url ends up in shell history, in `ps`, and in every error that prints the url.
		throw new AppError(
			[
				`${source} carries a username or password in the url, and ob will not use it.`,
				`  the API credential is a bearer token in ${tokenPath()}, never part of the address.`,
			].join("\n"),
		);
	}
	return url.origin + (url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, ""));
}

/**
 * The refusal when there is no API token.
 *
 * This is the FIRST thing a new machine hits, so it is a setup guide rather than a complaint: the exact
 * path that was looked for, the mode that path must have, the command that writes it, and where the token
 * comes from. It prints no token, and it never echoes the value of the environment variable.
 */
export function missingApiTokenMessage(path: string, why: string | null): string {
	return [
		`no usable ob API token, and ob talks to the API for all of its data (there is no direct database path).`,
		...(why ? [`  ${why}`] : []),
		`  looked for it in: ${path}`,
		`  that file holds ONE line, the token, and nothing else. Mode 0${API_TOKEN_FILE_MODE.toString(8)}.`,
		`  write it with:`,
		`      printf '%s\\n' '<token>' > ${path}`,
		`      chmod 0${API_TOKEN_FILE_MODE.toString(8)} ${path}`,
		`  the token is issued by the API host, not by ob: it is the SAME file that host authenticates`,
		`  against (ob 354 deploys it). It is NOT an 'ob secret' -- the secret store lives inside the`,
		`  database the API fronts, which is the circular bootstrap ob 320 hit.`,
		`  a one-off somewhere else, without touching the file: ${API_TOKEN_ENV}=<token>`,
		`  a different file: ${OB_API_TOKEN_FILE_ENV}=<path>`,
	].join("\n");
}

/**
 * A group- or world-readable token file is a credential sitting in the open, and a `cp` or a restore is all
 * it takes. The SERVER refuses to serve on a loose mode (352); the client warns and carries on, because
 * turning a permissions slip into an outage on the laptop is its own failure and the server's refusal is
 * the one that matters. Silent when the mode is right.
 */
export function warnLooseApiTokenFileMode(path: string): void {
	try {
		const mode = statSync(path).mode & 0o777;
		if ((mode & 0o077) === 0) return;
		process.stderr.write(
			`warning: ${path} is mode 0${mode.toString(8)} and holds the ob API token; the API host REFUSES to serve on that mode. fix: chmod 0${API_TOKEN_FILE_MODE.toString(8)} ${path}\n`,
		);
	} catch {
		// unreadable metadata is not this function's problem; the read below reports it properly
	}
}

/**
 * The bearer token, from the environment or from 352's token file. Throws the setup guide above when there
 * is none. The value is handed straight to an Authorization header and is never logged, never put in a
 * url, and never included in an error message.
 */
export function resolveApiToken(): string {
	const env = process.env[API_TOKEN_ENV]?.trim();
	if (env) return env;
	const path = tokenPath();
	if (existsSync(path)) {
		warnLooseApiTokenFileMode(path);
		const contents = readFileSync(path, "utf8").trim();
		if (contents.length > 0) return contents;
		throw new AppError(missingApiTokenMessage(path, "that file exists but is empty."));
	}
	throw new AppError(missingApiTokenMessage(path, null));
}

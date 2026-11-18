// ob 352 -- the API's bearer token (map D5).
//
// The token lives in a `chmod 600` file OUTSIDE the repo, in the same shape as every other secret here
// (`~/.google_token`, `~/.ha_token`). It is deliberately NOT in the ob secret store: that store lives
// inside the database this API fronts, so a server that had to read it in order to authenticate a request
// could never answer the first request after a restart. ob 320 hit exactly that circular bootstrap.
//
// Three rules the rest of this file exists to keep:
//   1. The token NEVER appears in argv, in a URL, in a log line or in an error message. Everything below
//      reports the PATH and never the contents; the only comparison is timing-safe and returns a boolean.
//   2. A missing token file DISABLES the API rather than opening it. An API that serves when it cannot
//      authenticate is worse than one that is down, because it looks like it is working.
//   3. A token file the rest of the machine can read is REFUSED, naming the path and the chmod. A secret
//      that is group- or world-readable is not a secret, and the failure is silent until it isn't.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { OB_API_AUTH_HEADER } from "./contract.ts";

/** Point the server at a different token file (tests, and a non-default deployment). */
export const OB_API_TOKEN_FILE_ENV = "OB_API_TOKEN_FILE";

/** The default location, outside the repo and outside the database. */
export function defaultTokenPath(): string {
  return join(homedir(), ".ob_api_token");
}

export function tokenPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[OB_API_TOKEN_FILE_ENV]?.trim();
  return explicit ? explicit : defaultTokenPath();
}

/**
 * Why the API is not serving, when it is not serving. `absent` is the ordinary "not configured on this
 * host" case; `permissions` and `empty` are misconfigurations that must be shouted about rather than
 * treated as absent, because both look like a working deployment from the outside.
 */
export type TokenLoadFailure = "absent" | "permissions" | "empty" | "unreadable";

export interface TokenLoad {
  /** The token, or null when the API must refuse to serve. */
  token: string | null;
  path: string;
  reason: TokenLoadFailure | null;
  /** A sentence for the operator. It names the PATH and never the token. */
  message: string | null;
}

/** Mode bits any principal other than the owner can read or write through. */
const GROUP_OR_OTHER = 0o077;

/**
 * Read the bearer token from its file. Never throws: a server that cannot read its token must start and
 * refuse requests with a named reason, not fail to start and leave the dashboard down with it.
 */
export function loadApiToken(path: string = tokenPath()): TokenLoad {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return {
      token: null,
      path,
      reason: "absent",
      message: `no API token file at ${path}, so the ob API is disabled (set ${OB_API_TOKEN_FILE_ENV} or create it, chmod 600)`,
    };
  }
  if ((mode & GROUP_OR_OTHER) !== 0) {
    return {
      token: null,
      path,
      reason: "permissions",
      message: `${path} is readable beyond its owner (mode ${(mode & 0o777).toString(8)}); refusing to serve the ob API until it is 'chmod 600'`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return {
      token: null,
      path,
      reason: "unreadable",
      message: `could not read ${path}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const token = raw.trim();
  if (!token) {
    return { token: null, path, reason: "empty", message: `${path} is empty; the ob API is disabled until it holds a token` };
  }
  return { token, path, reason: null, message: null };
}

/**
 * The bearer token off a request, or null. Only the `Authorization: Bearer <t>` header is read -- never a
 * query parameter, because a URL is the one place a secret is certain to be logged, by the proxy in front
 * as much as by us.
 */
export function bearerFrom(req: Request): string | null {
  const header = req.headers.get(OB_API_AUTH_HEADER);
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const value = match[1]!.trim();
  return value.length > 0 ? value : null;
}

/**
 * Constant-time comparison. `timingSafeEqual` throws on a length mismatch, which would leak the token's
 * LENGTH through the difference between a throw and a false, so both operands are hashed to a fixed width
 * first -- the standard shape, and the reason this is a function rather than an `===`.
 */
export function tokenMatches(presented: string | null, expected: string | null): boolean {
  if (presented === null || expected === null) return false;
  const a = new Bun.CryptoHasher("sha256").update(presented).digest();
  const b = new Bun.CryptoHasher("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

// OS-178 -- per-user scoped API tokens.
//
// The admin token (`~/.ob_api_token`, token.ts) reaches everything. A SCOPED token reaches only the route
// families and the projects its entry in `~/.ob_api_tokens.json` names. The file holds the sha256 of each
// token, never the token: the token is printed once, by `ob api-token add`, and lives only with its user.
//
// The rules are token.ts's rules, for the same reasons:
//   1. No token and no hash appears in a log line or an error. Messages name the PATH.
//   2. A file readable beyond its owner is refused, naming the path and the chmod.
//   3. An ABSENT file means no scoped users, and the API behaves exactly as it did before OS-178.
//
// The file is re-read on every request that is not the admin's, so `ob api-token revoke` takes effect on the
// next request without a restart.
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { tokenMatches } from "./token.ts";

const OB_API_TOKENS_FILE_ENV = "OB_API_TOKENS_FILE";

function defaultTokensPath(): string {
  return join(homedir(), ".ob_api_tokens.json");
}

export function tokensPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[OB_API_TOKENS_FILE_ENV]?.trim();
  return explicit ? explicit : defaultTokensPath();
}

/** One entry in the tokens file. */
export interface ScopedTokenEntry {
  user: string;
  sha256: string;
  projects: string[];
  families: string[];
}

/** Who a request is. The admin token is `all`; a scoped one carries its projects and families. */
export type Principal =
  | { user: "admin"; all: true }
  | { user: string; all: false; projects: readonly string[]; families: readonly string[] };

export const ADMIN_PRINCIPAL: Principal = { user: "admin", all: true };

export interface TokensLoad {
  entries: ScopedTokenEntry[];
  path: string;
  /** Null when the file is absent or fine. A sentence naming the PATH, never a hash. */
  message: string | null;
}

const GROUP_OR_OTHER = 0o077;
const HEX64 = /^[0-9a-f]{64}$/;

export class TokensFileError extends Error {}

function refuse(path: string, why: string): TokensLoad {
  return { entries: [], path, message: `${path} ${why}; scoped API tokens are refused until it is fixed` };
}

function parseEntries(raw: string): ScopedTokenEntry[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new TokensFileError("is not valid JSON");
  }
  if (!Array.isArray(data)) throw new TokensFileError("must hold a JSON array of token entries");
  return data.map((e, i) => {
    const o = e as Record<string, unknown>;
    const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
    if (!o || typeof o !== "object" || typeof o.user !== "string" || !o.user || typeof o.sha256 !== "string" || !HEX64.test(o.sha256) || !strings(o.projects) || !strings(o.families)) {
      // The entry index and the user (if any), never the hash.
      throw new TokensFileError(`entry ${i} must be { user, sha256 (64 hex), projects: string[], families: string[] }`);
    }
    return { user: o.user, sha256: o.sha256, projects: o.projects as string[], families: o.families as string[] };
  });
}

/** Read the tokens file. Never throws: a broken file refuses scoped tokens with a named reason. */
export function loadScopedTokens(path: string = tokensPath()): TokensLoad {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return { entries: [], path, message: null };
  }
  if ((mode & GROUP_OR_OTHER) !== 0) return refuse(path, `is readable beyond its owner (mode ${(mode & 0o777).toString(8)}), 'chmod 600' it`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return refuse(path, `could not be read (${e instanceof Error ? e.message : String(e)})`);
  }
  try {
    return { entries: parseEntries(raw), path, message: null };
  } catch (e) {
    return refuse(path, e instanceof TokensFileError ? e.message : "could not be parsed");
  }
}

export function sha256Hex(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

/**
 * The scoped entry a presented token matches, or null. Every entry is compared (no early exit), each in
 * constant time over the fixed-width digest.
 */
function matchScoped(presented: string | null, entries: readonly ScopedTokenEntry[]): ScopedTokenEntry | null {
  if (presented === null) return null;
  const digest = new Bun.CryptoHasher("sha256").update(presented).digest();
  let found: ScopedTokenEntry | null = null;
  for (const e of entries) {
    const expected = Buffer.from(e.sha256, "hex");
    if (expected.length === digest.length && timingSafeEqual(digest, expected) && found === null) found = e;
  }
  return found;
}

type AuthResult = { ok: true; principal: Principal } | { ok: false; disabledMessage: string | null };

/**
 * Who presented this token. The admin token wins any match. A tokens file that is refused (permissions,
 * unparseable) comes back as `disabledMessage` so the server can say so, naming the path, instead of a 401
 * that would send a scoped user looking for a token problem of their own.
 */
export function authenticate(presented: string | null, adminToken: string, scoped: () => TokensLoad): AuthResult {
  if (tokenMatches(presented, adminToken)) return { ok: true, principal: ADMIN_PRINCIPAL };
  if (presented === null) return { ok: false, disabledMessage: null };
  const load = scoped();
  if (load.message) return { ok: false, disabledMessage: load.message };
  const entry = matchScoped(presented, load.entries);
  if (!entry) return { ok: false, disabledMessage: null };
  return { ok: true, principal: { user: entry.user, all: false, projects: entry.projects, families: entry.families } };
}

// --- the issuing side (`ob api-token`) -------------------------------------------------------------------

/** Read the file for editing: absent is empty, a broken file is a thrown error naming the path. */
export function readTokensForEdit(path: string = tokensPath()): ScopedTokenEntry[] {
  if (!existsSync(path)) return [];
  const load = loadScopedTokens(path);
  if (load.message) throw new TokensFileError(load.message);
  return load.entries;
}

/** Write atomically, 0600 from the first byte. */
export function writeTokens(entries: readonly ScopedTokenEntry[], path: string = tokensPath()): void {
  const tmp = join(dirname(path), `.ob_api_tokens.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** A fresh token: 32 random bytes, base64url. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

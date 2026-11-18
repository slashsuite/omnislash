// ob 1305 -- the HOSTED half of Google OAuth: a browser-reachable authorize + callback on the API host,
// so a phone with no 127.0.0.1 can finish a re-auth. The DESKTOP flow is untouched
// (`commands/google.ts` still runs its loopback receiver); this module only adds the receiver that lives
// on the server.
//
// The state store is the CSRF guard. A LAN caller reaches this host without Cloudflare Access, so nothing
// but `state` stands between an attacker-supplied `code` and the store's refresh token: it is minted on
// the BEARER-authenticated `auth-url` endpoint (never by a browser route — a state proves a callback
// matches a flow, it cannot say who was allowed to start one), single-use, short-lived, and bound to the
// redirect_uri that was used to mint it (Google requires the same redirect_uri at exchange time, and a
// callback arriving on a different host must not get to choose a different one). Given a file path (the
// server passes GOOGLE_OAUTH_STATE_FILE), the store is persisted there and every mint and burn re-reads it
// under an exclusive flock, so a restart or a second process sees the same burns (OB-1935). Without a path
// it lives in memory and is lost on restart, which costs a re-tap and cannot resurrect a burned state.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { acquireFileLock, type AcquireOptions } from "../../../apps/cli/src/file-lock.ts";

/** The path the browser is sent back to. Also the string that must be registered in the Google console. */
export const GOOGLE_CALLBACK_PATH = "/api/ob/google/callback";
/** The path that resumes a minted state and 302s to Google. */
export const GOOGLE_AUTH_PATH = "/api/ob/google/auth";

/** The config key that pins the redirect_uri (must be a URI registered in the Google console). */
export const GOOGLE_REDIRECT_URI_KEY = "google_oauth_redirect_uri";

/** Default file path for persisted OAuth state (survives API restarts). */
export const GOOGLE_OAUTH_STATE_FILE = join(homedir(), ".omnislash", "google-oauth-state.json");

/** Ten minutes is long enough to read a notification and tap it, and short enough to matter. */
export const STATE_TTL_MS = 10 * 60_000;
/** Records outlive the TTL so an expired tap can be REFUSED AS EXPIRED rather than as unknown. */
const STATE_RETAIN_MS = STATE_TTL_MS * 4;
/** A mint is unauthenticated (a browser has no bearer token), so the pending set is bounded. */
const MAX_STATES = 256;

export type StateRefusal = "missing" | "expired" | "reused" | "unknown" | "busy";

/**
 * Thrown by `mint` when the persisted store cannot be locked, read or saved (OB-1935). The API answers it
 * with a 503 and this sentence rather than minting a state that no callback could ever find.
 */
export class GoogleStateBusyError extends Error {
  constructor() {
    super(stateRefusalSentence("busy"));
    this.name = "GoogleStateBusyError";
  }
}

export type BurnState =
  | { ok: true; redirectUri: string; issuedAt: number }
  | { ok: false; reason: StateRefusal };

export interface GoogleStateStore {
  /** Mint a fresh single-use state bound to `redirectUri`. */
  mint(redirectUri: string, now?: number): string;
  /**
   * Look at a state WITHOUT burning it: the browser auth route needs the bound redirect_uri to build the
   * consent URL, and the callback is the only place that burns. Same named reasons either way.
   */
  inspect(state: string | null | undefined, now?: number): BurnState;
  /** Verify and BURN a state. Never throws: every refusal is a named reason. */
  burn(state: string | null | undefined, now?: number): BurnState;
}

interface StateRecord {
  issuedAt: number;
  redirectUri: string;
  burned: boolean;
}

/**
 * The state store. Given `filePath`, it is persisted to that file and shared across processes: every mint
 * and burn takes an exclusive flock on `<filePath>.lock`, re-reads the file, acts and saves before it
 * releases, so a state one process burned reads as burned in every other. It fails CLOSED: a lock held
 * elsewhere past the wait, a file it cannot read or parse, or a save that fails makes `burn` refuse as
 * `busy` and `mint` throw `GoogleStateBusyError`. A missing file is an empty set; a corrupt one, or one
 * with a malformed record, is never treated as empty, since the next save would wipe every burn record.
 * No flock, or a lock file that cannot be opened, is busy too (`strict`): the store never runs unlocked.
 * Without `filePath` the store lives in this process's memory.
 */
export function createGoogleStateStore(
  ttlMs: number = STATE_TTL_MS,
  filePath?: string,
  lockOpts: Pick<AcquireOptions, "flock" | "waitMs"> = {},
): GoogleStateStore {
  const persistPath = filePath ?? null;
  const memory = new Map<string, StateRecord>();

  /** The persisted set, or `null` when the file exists but cannot be read or parsed. */
  function loadStates(path: string): Map<string, StateRecord> | null {
    const map = new Map<string, StateRecord>();
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      // Only a file that is not there is empty; any other read failure is unreadable.
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? map : null;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      for (const [key, rec] of Object.entries(parsed as Record<string, StateRecord>)) {
        // One malformed record makes the whole file unreadable: skipping it would drop it on the next save.
        if (!rec || typeof rec.issuedAt !== "number" || typeof rec.redirectUri !== "string" || typeof rec.burned !== "boolean") {
          return null;
        }
        map.set(key, { issuedAt: rec.issuedAt, redirectUri: rec.redirectUri, burned: rec.burned });
      }
      return map;
    } catch {
      return null;
    }
  }

  /** Write through tmp + rename. Returns false when the save failed. */
  function saveStates(path: string, states: Map<string, StateRecord>): boolean {
    try {
      const obj: Record<string, StateRecord> = {};
      for (const [key, rec] of states) obj[key] = rec;
      const tmp = path + ".tmp";
      writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      renameSync(tmp, path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Run `fn` on the current set. In memory that is the one map. With a file it is a fresh read under the
   * exclusive lock, saved afterwards when `fn` changed it. `null` means busy: no lock, unreadable, or the
   * save failed.
   */
  function withStates<T>(fn: (states: Map<string, StateRecord>) => { value: T; dirty: boolean }): { value: T } | null {
    if (!persistPath) return { value: fn(memory).value };
    const hold = acquireFileLock(persistPath + ".lock", "exclusive", { ...lockOpts, strict: true });
    if (!hold) return null;
    try {
      const states = loadStates(persistPath);
      if (!states) return null;
      const { value, dirty } = fn(states);
      if (dirty && !saveStates(persistPath, states)) return null;
      return { value };
    } finally {
      hold.release();
    }
  }

  function prune(states: Map<string, StateRecord>, now: number): void {
    for (const [key, rec] of states) {
      if (now - rec.issuedAt > STATE_RETAIN_MS) states.delete(key);
    }
    if (states.size < MAX_STATES) return;
    // At the cap, drop by issue time, oldest first. Every expired record is older than every live one, so
    // the expired go first and a live state is dropped only when nothing expired is left.
    const byAge = [...states.entries()].sort((a, b) => a[1].issuedAt - b[1].issuedAt);
    for (const [key] of byAge) {
      if (states.size < MAX_STATES) return;
      states.delete(key);
    }
  }

  function check(rec: StateRecord | undefined, now: number): BurnState {
    if (!rec) return { ok: false, reason: "unknown" };
    if (rec.burned) return { ok: false, reason: "reused" };
    // Expired is refused WITHOUT burning, so a retry still reads as expired. Time only moves forward, so
    // an expired state never becomes usable again.
    if (now - rec.issuedAt > ttlMs) return { ok: false, reason: "expired" };
    return { ok: true, redirectUri: rec.redirectUri, issuedAt: rec.issuedAt };
  }

  return {
    mint(redirectUri, now = Date.now()) {
      const state = randomBytes(16).toString("hex");
      const done = withStates((states) => {
        prune(states, now);
        states.set(state, { issuedAt: now, redirectUri, burned: false });
        return { value: state, dirty: true };
      });
      if (!done) throw new GoogleStateBusyError();
      return done.value;
    },
    inspect(state, now = Date.now()) {
      if (!state) return { ok: false, reason: "missing" };
      // Read-only, so no lock: a burn racing this read is still decided by the callback's locked burn.
      const states = persistPath ? loadStates(persistPath) : memory;
      if (!states) return { ok: false, reason: "busy" };
      return check(states.get(state), now);
    },
    burn(state, now = Date.now()) {
      if (!state) return { ok: false, reason: "missing" };
      const done = withStates<BurnState>((states) => {
        const rec = states.get(state);
        const verdict = check(rec, now);
        if (!verdict.ok || !rec) return { value: verdict, dirty: false };
        rec.burned = true;
        return { value: verdict, dirty: true };
      });
      return done ? done.value : { ok: false, reason: "busy" };
    },
  };
}

/** The sentence a refused callback renders. Names the reason; never repeats the state or the code. */
export function stateRefusalSentence(reason: StateRefusal): string {
  switch (reason) {
    case "missing":
      return "no state on the callback — refusing to exchange a code without one";
    case "expired":
      return "state expired — start the authorization again";
    case "reused":
      return "state already used — a replay is refused, start the authorization again";
    case "unknown":
      return "state was not minted by this server — start the authorization again";
    case "busy":
      return "the sign-in state store is busy or unreadable, try again";
  }
}

/**
 * `scheme://host` as the BROWSER sees it. Behind the Cloudflare tunnel the local Bun.serve speaks http,
 * so `X-Forwarded-Proto` is what makes the derived callback an https URL that matches the registered one.
 */
export function requestOrigin(req: Request, url: URL): string {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || url.host;
  return `${proto}://${host}`;
}

/**
 * The redirect_uri for this flow. A configured value wins — Google only accepts a URI registered in the
 * console, and the public one is usually NOT the address the CLI happened to call. Unconfigured, the
 * request's own origin is correct for a LAN tap.
 */
export function hostedRedirectUri(configured: string | null | undefined, req: Request, url: URL): string {
  const explicit = configured?.trim();
  if (explicit) return explicit;
  return requestOrigin(req, url) + GOOGLE_CALLBACK_PATH;
}

/** Google's `error` parameter is attacker-supplied text; it is escaped before it reaches the page. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** The one-line page the callback renders. Static text only — no code, no state, no token ever enters it. */export function hostedCallbackPage(outcome: { refreshToken: boolean } | { reason: string }): string {
  const head =
    "<!doctype html><meta charset=utf-8><title>ob google auth</title>" +
    '<body style="font-family:system-ui;padding:3rem;text-align:center;max-width:40rem;margin:0 auto">';
  if ("reason" in outcome) {
    return `${head}<h1>Google authorization refused</h1><p>${escapeHtml(outcome.reason)}</p>`;
  }
  const detail = outcome.refreshToken
    ? "Refresh token issued ✓ — mail and calendar sync can run again."
    : "No refresh token was issued — Google did not re-issue one; run it again to retry.";
  return (
    `${head}<h1>done — you can close this</h1><p>${detail}</p>` +
    "<p>Token stored as the encrypted secret <code>google</code>.</p>"
  );
}

import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { Ctx, Flags } from "../../../../apps/cli/src/ctx.ts";
import { AppError, UsageError } from "../../../../apps/cli/src/errors.ts";
import { sqliteStoreFor } from "../../../../apps/cli/src/db/store.ts";
import { print } from "../../../../apps/cli/src/output.ts";
import { expandHome } from "../../../../apps/cli/src/net.ts";
import { setting } from "../../../../apps/cli/src/settings.ts";
import { clearCredentialCheck, getSecret, masterKeyForWrite, setSecret, type MasterKey } from "../../../../apps/cli/src/secrets.ts";
import { mergeGoogleToken, previousGoogleToken, type GoogleToken } from "../google.ts";

// -----------------------------------------------------------------------------
// `ob google auth` (129): installed-app loopback OAuth 2.0 flow that mints the
// GoogleToken JSON the Gmail/Calendar connectors (126/127) read from
// google_token_path. The human authorizes in their own browser; the only network
// call this makes is the code→token exchange, which lives behind an injectable
// seam (TokenExchanger) so tests never touch Google. Secrets land ONLY in the
// token file (chmod 600) — they are never logged or printed.
// -----------------------------------------------------------------------------

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const SCOPE_PREFIX = "https://www.googleapis.com/auth/";

export const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
];

/** Expand a short scope name (e.g. "gmail.modify") to its full URL; pass full URLs through. */
export function expandScope(s: string): string {
  return /^https?:\/\//.test(s) ? s : SCOPE_PREFIX + s;
}

/** Merge --scopes (comma/space separated, short names expanded) into the defaults, de-duplicated. */
export function resolveScopes(flag?: string): string[] {
  const merged = [...DEFAULT_SCOPES];
  for (const raw of (flag ?? "").split(/[,\s]+/).filter(Boolean)) {
    const full = expandScope(raw);
    if (!merged.includes(full)) merged.push(full);
  }
  return merged;
}

/** Build Google's consent URL for the installed-app loopback flow. */
export function buildAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: opts.scopes.join(" "),
  });
  if (opts.state) params.set("state", opts.state);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

export interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

/** Parse a Google Cloud "Desktop app" client_secret.json (installed.* preferred, web.* accepted). */
export function parseClientSecretJson(text: string): ClientCreds {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError("OAuth client file is not valid JSON");
  }
  const root = json as { installed?: Record<string, string>; web?: Record<string, string> };
  const node = root.installed ?? root.web;
  if (!node?.client_id || !node?.client_secret) {
    throw new AppError("OAuth client file missing installed.client_id / installed.client_secret");
  }
  return { clientId: node.client_id, clientSecret: node.client_secret };
}

function readClientSecretFile(path: string): ClientCreds {
  let text: string;
  try {
    text = readFileSync(expandHome(path), "utf8");
  } catch {
    throw new AppError(`cannot read OAuth client file at ${path}`);
  }
  return parseClientSecretJson(text);
}

/**
 * Flags-only creds (420): `--client` / `--client-id` + `--client-secret`. No sqlite.
 * Used on the API-client path, which has no `ctx.db` for `google_oauth_client_path`.
 * Returns null when neither flag form is present so the local path can fall through.
 */
export function resolveClientCredsFromFlags(flags: Flags): ClientCreds | null {
  if (flags.client) return readClientSecretFile(flags.client);
  if (flags["client-id"] || flags["client-secret"]) {
    if (!flags["client-id"] || !flags["client-secret"]) {
      throw new UsageError("both --client-id and --client-secret are required");
    }
    return { clientId: flags["client-id"], clientSecret: flags["client-secret"] };
  }
  return null;
}

/** API-client path: flags only. Missing creds names those flags, not the config key. */
export function requireClientCredsFromFlags(flags: Flags): ClientCreds {
  const creds = resolveClientCredsFromFlags(flags);
  if (creds) return creds;
  throw new UsageError(
    "no OAuth client credentials — pass --client <client_secret.json>, or --client-id/--client-secret",
  );
}

export const API_CLIENT_CREDS_USAGE =
  "no OAuth client credentials — pass --client <client_secret.json>, or --client-id/--client-secret, or store secret google with client_id/client_secret from a prior auth";

export function clientCredsFromStoredGoogleJson(text: string): ClientCreds | null {
  if (!text.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || typeof json !== "object") return null;
  const rec = json as { client_id?: unknown; client_secret?: unknown };
  if (typeof rec.client_id !== "string" || !rec.client_id) return null;
  if (typeof rec.client_secret !== "string" || !rec.client_secret) return null;
  return { clientId: rec.client_id, clientSecret: rec.client_secret };
}

/**
 * Resolve OAuth client creds in priority order:
 *   1. --client <client_secret.json>
 *   2. --client-id + --client-secret
 *   3. google_oauth_client_path setting → a client_secret.json
 * Clean error when none is provided.
 */
export function resolveClientCreds(ctx: Ctx): ClientCreds {
  const fromFlags = resolveClientCredsFromFlags(ctx.flags);
  if (fromFlags) return fromFlags;
  // 337: settings.ts's synchronous sqlite-only read, not config.ts's async getConfig. resolveClientCreds
  // is a sync throw-or-return that google-auth.test.ts asserts with expect(() => ...).toThrow, and this
  // command is not ported. The key has no DEFAULTS entry, so an unset row reads as "".
  const settingPath = setting(ctx.db, "google_oauth_client_path");
  if (settingPath) return readClientSecretFile(settingPath);
  throw new UsageError(
    "no OAuth client credentials — pass --client <client_secret.json>, or --client-id/--client-secret, or set config google_oauth_client_path",
  );
}

// --- token exchange (the ONLY network seam; injected as a fake in tests) --------

export interface TokenExchangeParams {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  tokenUri?: string;
}

export interface TokenExchangeResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

export type TokenExchanger = (p: TokenExchangeParams) => Promise<TokenExchangeResponse>;

/** Default exchanger: POST the authorization code to Google's token endpoint. Never called in tests. */
export const httpExchangeAuthCode: TokenExchanger = async (p) => {
  const res = await fetch(p.tokenUri ?? TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
    }),
  });
  if (!res.ok) throw new AppError(`Google token exchange failed (${res.status})`);
  return (await res.json()) as TokenExchangeResponse;
};

/** Map a token-endpoint response → the GoogleToken shape the connectors read (expiry from expires_in). */
export function tokenResponseToGoogleToken(
  resp: TokenExchangeResponse,
  creds: ClientCreds,
  now: number = Date.now(),
): GoogleToken {
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expiry: new Date(now + (resp.expires_in ?? 3600) * 1000).toISOString(),
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    token_uri: TOKEN_URI,
  };
}

/** Write the token JSON (pretty) then chmod 600. Returns the absolute path written. */
export function writeGoogleTokenFile(path: string, token: GoogleToken): string {
  const abs = expandHome(path);
  writeFileSync(abs, JSON.stringify(token, null, 2));
  chmodSync(abs, 0o600);
  return abs;
}

const CLOSE_TAB_HTML =
  "<!doctype html><meta charset=utf-8><title>ob google auth</title>" +
  "<body style=\"font-family:system-ui;padding:3rem;text-align:center\">" +
  "<h1>Authorized ✓</h1><p>You can close this tab and return to the terminal.</p></body>";

function defaultOpenUrl(url: string): void {
  try {
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* best-effort — the URL is also printed as a fallback */
  }
}

export interface CallbackResult {
  code?: string;
  error?: string;
  state?: string;
}

/** Parse a loopback callback request URL into its OAuth result (pure — no I/O). */
export function callbackFromUrl(reqUrl: string): CallbackResult {
  const p = new URL(reqUrl).searchParams;
  return {
    code: p.get("code") ?? undefined,
    error: p.get("error") ?? undefined,
    state: p.get("state") ?? undefined,
  };
}

/** The loopback receiver: where Google redirects with `?code=`. A seam so tests never open a socket. */
export interface Loopback {
  /** `http://127.0.0.1:<port>` — the OAuth redirect_uri. */
  redirectUri: string;
  /** Resolves once the browser hits the callback (or errors). */
  waitForCode(): Promise<CallbackResult>;
  /** Shut the server down. */
  close(): void;
}

/** Real loopback: a Bun.serve on 127.0.0.1 at an ephemeral port. The only non-test implementation. */
export function startLoopback(): Loopback {
  let resolveCallback!: (v: CallbackResult) => void;
  const callback = new Promise<CallbackResult>((res) => {
    resolveCallback = res;
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const result = callbackFromUrl(req.url);
      if (result.code || result.error) {
        resolveCallback(result);
        return new Response(CLOSE_TAB_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      return new Response("waiting for authorization…", { headers: { "content-type": "text/plain" } });
    },
  });
  return {
    redirectUri: `http://127.0.0.1:${server.port}`,
    waitForCode: () => callback,
    close: () => server.stop(true),
  };
}

export interface GoogleAuthDeps {
  /** Token exchanger — defaults to the real HTTP call; tests inject a fixture. */
  exchange?: TokenExchanger;
  /** Browser opener — defaults to `open <url>`; tests inject a spy. */
  openUrl?: (url: string) => void | Promise<void>;
  /** Loopback receiver factory — defaults to the real Bun.serve loopback; tests inject a fake. */
  startLoopback?: () => Loopback;
  /** Master key provider for encrypting the token into the store — defaults to the Keychain. */
  masterKey?: MasterKey;
  /** Already-resolved creds. When set, `resolveClientCreds` is not called (no sqlite). */
  creds?: ClientCreds;
  /**
   * Persist the minted token JSON. Local path encrypts into the store; the API-client path
   * POSTs via `secret set google` so the host store gets it. Never prints the value.
   */
  persist?: (json: string) => Promise<void>;
}

/**
 * Run the loopback OAuth flow end-to-end: start a 127.0.0.1 receiver, open the consent URL, receive
 * the code on the callback, exchange it (injectable seam), and write the token file (chmod 600).
 */
export async function runGoogleAuth(ctx: Ctx, deps: GoogleAuthDeps = {}): Promise<{ scopes: string[] }> {
  const creds = deps.creds ?? resolveClientCreds(ctx);
  const scopes = resolveScopes(ctx.flags.scopes);
  const exchange = deps.exchange ?? httpExchangeAuthCode;
  const openUrl = deps.openUrl ?? defaultOpenUrl;
  const state = randomBytes(16).toString("hex");

  const loopback = (deps.startLoopback ?? startLoopback)();
  const { redirectUri } = loopback;
  try {
    const authUrl = buildAuthUrl({ clientId: creds.clientId, redirectUri, scopes, state });
    print("Opening your browser to authorize with Google (offline access)…");
    print(`If it doesn't open, visit this URL:\n${authUrl}`);
    await openUrl(authUrl);

    const result = await loopback.waitForCode();
    if (result.error) throw new AppError(`Google authorization failed: ${result.error}`);
    if (result.state !== state) throw new AppError("OAuth state mismatch — aborting");
    if (!result.code) throw new AppError("no authorization code received on the loopback callback");

    const resp = await exchange({
      code: result.code,
      redirectUri,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    });
    if (!resp.access_token) throw new AppError("token exchange returned no access_token");

    const token = tokenResponseToGoogleToken(resp, creds);
    // Store the token encrypted (secret `google`) — never a loose ~/.google_token file.
    // 420: the API-client path injects persist → POST /secrets (it merges itself). Local path still uses
    // the store, merged over the stored token so a response with no refresh_token keeps it (OB-1916).
    if (deps.persist) {
      await deps.persist(JSON.stringify(token, null, 2));
    } else {
      const store = ctx.store ?? sqliteStoreFor(ctx.db);
      const masterKey = deps.masterKey ?? (await masterKeyForWrite(store));
      let prevRaw: string | null = null;
      try {
        prevRaw = await getSecret(store, "google", masterKey.get());
      } catch {
        prevRaw = null; // no readable previous token means no merge, never an error
      }
      const merged = mergeGoogleToken(previousGoogleToken(prevRaw), token);
      await setSecret(store, "google", JSON.stringify(merged, null, 2), masterKey.get());
      await clearCredentialCheck(store, "google");
    }
    return { scopes };
  } finally {
    loopback.close();
  }
}

export async function cmdGoogle(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  if (sub === "auth") {
    const { scopes } = await runGoogleAuth(ctx);
    print(`stored Google token as secret \`google\` (scopes: ${scopes.join(", ")}). Run \`ob gmail sync\`.`);
    return;
  }
  if (sub === "auth-url") {
    // 1305: the hosted flow's receiver lives on the API host, so this half needs the API client. The
    // desktop loopback flow above is untouched and remains the answer for a machine with a browser.
    throw new UsageError(
      "google auth-url prints the HOSTED authorize URL and needs the API (set OMNISLASH_API / ~/.omnislash_api_url); use `ob google auth` for the desktop loopback flow",
    );
  }
  throw new UsageError(`unknown google subcommand '${sub ?? ""}' (auth|auth-url)`);
}

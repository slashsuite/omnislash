import { existsSync, statSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { AppError } from "./errors.ts";
import { nowIso } from "./db.ts";
import type { Store } from "./db/store.ts";
import { readBool } from "./db/store.ts";
import { expandHome } from "./net.ts";
import { settingFor } from "./settings.ts";
import {
  clearCredentialCheck,
  defaultMasterKey,
  masterKeyForWrite,
  getSecret,
  hasSecret,
  listSecrets,
  masterKeyFilePath,
  MASTER_KEY_FILE_ENV,
  setSecret,
  type MasterKey,
} from "./secrets.ts";
import { parseGoogleToken, type GoogleToken } from "../../../platform/cli-sources/src/google.ts";
import { bridgeConfig, bridgeStatus, bridgeStatusHeadline, type BridgeDeps } from "../../../platform/cli-whatsapp/src/whatsapp/bridge.ts";
import { readBridgeToken } from "../../../platform/cli-whatsapp/src/whatsapp/send.ts";

// -----------------------------------------------------------------------------
// The credential inventory (ob 219).
//
// Four credential failures surfaced in two days: gmail's token gone (152), slack's token never stored
// (208), the router password absent (209), and github only ever living in the Mac's Keychain rather
// than the store (185's audit). Every one was invisible until somebody read a log, and THREE of the
// four were credentials the encrypted store does not hold, which is why this module is an inventory of
// what ob DEPENDS ON rather than a listing of `ob secret list`.
//
// 208 then answered its own case differently, and the answer is a rule for this list: the fix was not
// to obtain the Slack token, it was to retire the job that wanted one, so `slack` is NOT in the
// inventory any more. 425 applied the same rule to `router-password` and `claude`: the weekly net pull
// already skips the router, and the API host has no `claude` CLI, so both sat permanently FAILED and
// taught the reader to ignore the inventory. `ob net pull --router` stays; it is not this list. A
// credential nothing depends on would sit here permanently absent, and an inventory
// that shows a missing credential nobody should ever create teaches the reader to ignore it.
//
// Each credential answers three questions: is it there, is it valid, and how do I refresh it. Presence
// is free and always reads. Validity costs a provider call, so it happens ONLY when a person asks for
// it (a click, or `ob creds check`), never on a page load and never on a timer; the verdict is recorded
// in `credential_check` so the page can say "checked 3 minutes ago" without calling again. Refresh is
// deliberately not one action: a static token is a paste, google is an OAuth loopback round trip,
// and the page says which.
//
// A VALUE never leaves this module. Presence reads existence and size, never content; a check holds a
// token only long enough to send it, and every detail string it produces is passed through
// `redactDetail` with that token so a provider that echoes a credential back cannot put it on a page.
// -----------------------------------------------------------------------------

/** Where the credential actually lives, which is the thing that decides how it is refreshed. */
export type CredentialHome = "store" | "keychain" | "file" | "external";

/**
 * What refreshing it costs a human. Paste is the only one a web page can complete on its own — except
 * `qr` (274), which a web page completes by DISPLAYING rather than by collecting: the tokens page renders
 * the pairing QR and the phone does the rest, so no secret is ever typed into the browser.
 */
export type RefreshKind = "paste" | "oauth" | "login" | "file" | "keychain" | "qr";

export interface CredentialSpec {
  /** Stable id. For a store credential this IS the `ob secret` name. */
  name: string;
  label: string;
  home: CredentialHome;
  refresh: RefreshKind;
  /** The exact command that refreshes it, shown on the page to be copied. */
  command: string;
  /** What stops working without it. */
  purpose: string;
}

/**
 * Every credential ob depends on. The ones outside the encrypted store are the point of the inventory:
 * they are the ones that went missing while `ob secret list` still looked fine.
 */
export const CREDENTIALS: CredentialSpec[] = [
  {
    name: "google",
    label: "Google (Gmail + Calendar)",
    home: "store",
    refresh: "oauth",
    command: "ob google auth",
    purpose: "Gmail ingestion and the calendar agenda. This is the one that died for 17 days (ob 152).",
  },
  {
    name: "github",
    label: "GitHub",
    home: "store",
    refresh: "paste",
    command: "ob secret set github",
    purpose: "PR + issue sync, `ob issue`, and the wayfinder issue mirror.",
  },
  {
    name: "ha",
    label: "Home Assistant",
    home: "store",
    refresh: "paste",
    command: "ob secret set ha",
    purpose: "Home Assistant: the alert digest push (ob alerts --notify) and the gate cards.",
  },
  {
    name: "cloudflare-api-token",
    label: "Cloudflare API token",
    home: "store",
    refresh: "paste",
    command: "ob secret set cloudflare-api-token",
    purpose: "Cloudflare DNS for the tunnel, and the DNS-01 certificate renewal ob 220 needs.",
  },
  {
    name: "cloudflare-account-id",
    label: "Cloudflare account id",
    home: "store",
    refresh: "paste",
    command: "ob secret set cloudflare-account-id",
    purpose: "Names the Cloudflare account the API token acts on. Not secret, but nothing works without it.",
  },
  {
    name: "opencode-go",
    label: "OpenCode Go",
    home: "store",
    refresh: "paste",
    command: "ob secret set opencode-go",
    purpose:
      "The skeptical-review legs (DeepSeek, Luna) and the headless runs. An expired key or a used-up plan fails them silently (ob 1618).",
  },
  {
    name: "opencode-zen",
    label: "OpenCode Zen",
    home: "store",
    refresh: "paste",
    command: "ob secret set opencode-zen",
    purpose: "The paid jev-1.13 calls (ob jev). Zen exposes no balance endpoint, so the check proves the key only.",
  },
  {
    name: "master-key",
    label: "Secret-store master key",
    home: "keychain",
    refresh: "keychain",
    command: "security find-generic-password -s omnislash-master-key -a omnislash -w",
    purpose:
      "The 32-byte key that decrypts everything above. macOS Keychain here; a 0600 file named by $OMNISLASH_MASTER_KEY_FILE on the server (ob 182).",
  },
  {
    name: "whatsapp",
    label: "WhatsApp session (linked device)",
    home: "file",
    refresh: "qr",
    // A real command, because this field is rendered as one: the pairing window only opens when the
    // bridge starts, so restarting it is the actionable half and the scan happens on the Tokens page.
    command: "ob whatsapp bridge start  # then scan the QR on the dashboard Tokens page",
    purpose:
      "The whatsmeow pairing in the bridge's store. Everything WhatsApp depends on it: ingest, the feed, the drafts, the family update. It drops roughly every 20 days and re-pairing is a QR scan (274).",
  },
];

export const CREDENTIAL_NAMES = CREDENTIALS.map((c) => c.name);

export function credentialSpec(name: string): CredentialSpec {
  const spec = CREDENTIALS.find((c) => c.name === name);
  if (!spec) throw new AppError(`unknown credential '${name}' (${CREDENTIAL_NAMES.join(", ")})`);
  return spec;
}

/** The store credentials a pasted value can refresh: everything the store holds except the OAuth one. */
export function isPasteRefreshable(spec: CredentialSpec): boolean {
  return spec.home === "store" && spec.refresh === "paste";
}

const KEYCHAIN_SERVICE = "omnislash-master-key";
const KEYCHAIN_ACCOUNT = "omnislash";

// --- probes (the seam every non-store presence read goes through) -------------

export interface FileState {
  exists: boolean;
  /** Byte length, so "the file is there but empty" is a different answer from "it is there". */
  bytes: number;
  /** Permission bits, or null when they could not be read. */
  mode: number | null;
}

/**
 * Everything presence needs from outside the database. A seam because three of the four out-of-store
 * credentials are read by shelling out, and a test must never spawn `security` against the developer's
 * login keychain to find out whether a file exists.
 */
export interface Probes {
  fileState(path: string): FileState;
  /** Whether a Keychain item exists. Metadata only: it never asks for the value, so it never prompts. */
  keychainItem(service: string, account: string): boolean;
  onPath(command: string): boolean;
  env(name: string): string | undefined;
}

export const realProbes: Probes = {
  fileState(path: string): FileState {
    const abs = expandHome(path);
    if (!existsSync(abs)) return { exists: false, bytes: 0, mode: null };
    try {
      const st = statSync(abs);
      return { exists: true, bytes: st.size, mode: st.mode & 0o777 };
    } catch {
      return { exists: true, bytes: 0, mode: null };
    }
  },
  keychainItem(service: string, account: string): boolean {
    if (process.platform !== "darwin") return false;
    const found = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-a", account], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return found.exitCode === 0;
  },
  onPath(command: string): boolean {
    return Bun.which(command) !== null;
  },
  env(name: string): string | undefined {
    return process.env[name];
  },
};

// --- presence ----------------------------------------------------------------

export interface CredentialCheckRow {
  name: string;
  checked_at: string;
  ok: boolean;
  detail: string | null;
}

export interface CredentialStatus extends CredentialSpec {
  present: boolean;
  /** Where it was found, or what is missing. Never a value. */
  presence_detail: string;
  /** When the stored credential last changed, for store credentials that have one. */
  updated_at: string | null;
  /** Whether the tokens page's paste box applies to this one. */
  writable: boolean;
  /** Whether a live check exists for it at all. */
  checkable: boolean;
  /** The last recorded check, or null for never checked, which is NOT the same as checked and bad. */
  last_check: CredentialCheckRow | null;
}

async function storePresence(
  store: Store,
  name: string,
): Promise<{ present: boolean; detail: string; updated_at: string | null }> {
  const row = (await listSecrets(store)).find((r) => r.name === name);
  if (row) return { present: true, detail: "in the encrypted store", updated_at: row.updated_at };
  return { present: false, detail: "not in the encrypted store", updated_at: null };
}

/**
 * GitHub is the one credential with several legitimate homes, and the audit that started this ticket
 * found it living in only one of them: the Mac's Keychain via the `gh` CLI, which is not a thing the
 * server will have. So its presence names WHERE it was found rather than answering yes or no.
 */
async function githubPresence(
  store: Store,
  probes: Probes,
): Promise<{ present: boolean; detail: string; updated_at: string | null }> {
  const stored = await storePresence(store, "github");
  if (stored.present) return stored;
  if (probes.env("GITHUB_TOKEN") || probes.env("GH_TOKEN")) {
    return { present: true, detail: "in $GITHUB_TOKEN only, not in the store", updated_at: null };
  }
  if (probes.onPath("gh")) {
    return { present: true, detail: "the `gh` CLI's own login only, not in the store (ob 185)", updated_at: null };
  }
  const path = await settingFor(store, "github_key_path");
  const file = probes.fileState(path);
  if (file.exists && file.bytes > 0) {
    return { present: true, detail: `a plaintext file at ${path}, not in the store`, updated_at: null };
  }
  return { present: false, detail: "nowhere: not the store, not $GITHUB_TOKEN, not `gh`, not a file", updated_at: null };
}

function masterKeyPresence(probes: Probes): { present: boolean; detail: string } {
  const path = masterKeyFilePath({ [MASTER_KEY_FILE_ENV]: probes.env(MASTER_KEY_FILE_ENV) });
  if (path) {
    const file = probes.fileState(path);
    if (!file.exists) return { present: false, detail: `no key file at ${path} (${MASTER_KEY_FILE_ENV} names it)` };
    if (file.mode !== null && (file.mode & 0o077) !== 0) {
      return { present: true, detail: `key file at ${path} is mode 0${file.mode.toString(8)}, needs chmod 600` };
    }
    return { present: true, detail: `key file at ${path}` };
  }
  if (probes.keychainItem(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)) {
    return { present: true, detail: "macOS Keychain item omnislash-master-key" };
  }
  return {
    present: false,
    detail: `no Keychain item and no ${MASTER_KEY_FILE_ENV} file: every stored secret is unreadable here`,
  };
}

/**
 * The WhatsApp session (274). Presence is the whatsmeow pairing store beside the bridge's messages.db,
 * and it deliberately says LESS than the other rows: a pairing row survives the "invalid use of deleted
 * device" rejection that #119 chased, so the file existing cannot prove the session still works. Only the
 * live check (which reads the bridge's own log and health) can speak to that, so presence names the file
 * and says so.
 */
async function whatsappPresence(
  store: Store,
  probes: Probes,
): Promise<{ present: boolean; detail: string }> {
  const path = (await bridgeConfig(store)).pairingDbPath;
  const file = probes.fileState(path);
  if (!file.exists) return { present: false, detail: `no pairing store at ${path} — never linked` };
  if (file.bytes === 0) return { present: false, detail: `the pairing store at ${path} is empty — never linked` };
  return {
    present: true,
    detail:
      `a pairing store at ${path}. A session was stored once; WhatsApp deleting the device LEAVES that` +
      ` row, so this cannot prove the pairing still works — check it`,
  };
}

/** Every credential with presence, age and the last recorded verdict. Reads only; no provider is called. */
export async function credentialInventory(
  store: Store,
  probes: Probes = realProbes,
): Promise<CredentialStatus[]> {
  const checks = new Map((await lastCredentialChecks(store)).map((c) => [c.name, c]));
  const out: CredentialStatus[] = [];
  for (const spec of CREDENTIALS) {
    let presence: { present: boolean; detail: string; updated_at?: string | null };
    if (spec.name === "github") presence = await githubPresence(store, probes);
    else if (spec.home === "store") presence = await storePresence(store, spec.name);
    else if (spec.name === "master-key") presence = masterKeyPresence(probes);
    else if (spec.name === "whatsapp") presence = await whatsappPresence(store, probes);
    else throw new AppError(`no presence probe for credential '${spec.name}'`);
    out.push({
      ...spec,
      present: presence.present,
      presence_detail: presence.detail,
      updated_at: presence.updated_at ?? null,
      writable: isPasteRefreshable(spec),
      checkable: spec.name in CHECKERS,
      last_check: checks.get(spec.name) ?? null,
    });
  }
  return out;
}

// --- recorded verdicts -------------------------------------------------------

/**
 * How much of a check detail is kept. A reason to act, not a response body.
 *
 * 700 rather than 300 (1347): measured on 2026-10-18, every WhatsApp verdict is a headline plus a remedy
 * that names the fix, and at 300 the store kept the head of the sentence and dropped the end - the
 * deleted-device remedy lost its "scan the QR", and the outdated-client one would have lost the rebuild
 * command. Truncating a remedy mid-instruction is the same class of failure as not having one: the page
 * shows the cause and hides the cure.
 */
const DETAIL_MAX = 700;

export async function recordCredentialCheck(
  store: Store,
  name: string,
  result: { ok: boolean; detail: string },
  at: string = nowIso(),
): Promise<CredentialCheckRow> {
  const detail = result.detail.trim().slice(0, DETAIL_MAX) || null;
  // `ok` is a plain `integer` column on both sides of the port, not a drizzle `{ mode: "boolean" }` one,
  // so the 0/1 written here is the literal stored value. It is read back through `readBool` rather than
  // `=== 1`, because that is the comparison that survives the driver handing an integer back as a string.
  await store.q
    .insert(store.t.credentialCheck)
    .values({ name, checked_at: at, ok: result.ok ? 1 : 0, detail })
    .onConflictDoUpdate({
      target: store.t.credentialCheck.name,
      set: { checked_at: sql`excluded.checked_at`, ok: sql`excluded.ok`, detail: sql`excluded.detail` },
    });
  return { name, checked_at: at, ok: result.ok, detail };
}

/** The check detail for a refresh token Google refused (OB-1950). */
const GOOGLE_INVALID_GRANT_DETAIL = "Google refused the refresh token (invalid_grant): run `ob google auth`";

/**
 * The `onInvalidGrant` hook for an HttpGoogleClient (OB-1950): records the google credential as failing,
 * so alert rule 11 fires from a sync. google.ts cannot import this module (this one imports it).
 */
export function googleInvalidGrantRecorder(store: Store): () => Promise<void> {
  return async () => {
    await recordCredentialCheck(store, "google", { ok: false, detail: GOOGLE_INVALID_GRANT_DETAIL });
  };
}

export async function lastCredentialChecks(store: Store): Promise<CredentialCheckRow[]> {
  const rows = (await store.q.select().from(store.t.credentialCheck)) as Array<{
    name: string;
    checked_at: string;
    ok: number | boolean | null;
    detail: string | null;
  }>;
  return rows.map((r) => ({
    name: r.name,
    checked_at: r.checked_at,
    ok: readBool(r.ok),
    detail: r.detail,
  }));
}

export async function lastCredentialCheck(
  store: Store,
  name: string,
): Promise<CredentialCheckRow | null> {
  const rows = (await store.q
    .select()
    .from(store.t.credentialCheck)
    .where(eq(store.t.credentialCheck.name, name))
    .limit(1)) as Array<{
    name: string;
    checked_at: string;
    ok: number | boolean | null;
    detail: string | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  return { name: row.name, checked_at: row.checked_at, ok: readBool(row.ok), detail: row.detail };
}

// --- live checks -------------------------------------------------------------

export interface CheckResult {
  ok: boolean;
  detail: string;
}

export interface CheckDeps {
  /** The HTTP seam. Tests inject; nothing else in this module reaches the network. */
  http?: typeof fetch;
  probes?: Probes;
  masterKey?: MasterKey;
  now?: string;
  /**
   * Seams for the WhatsApp bridge read (274). `bridgeStatus` reads a pidfile, shells `lsof`, tails a log
   * and opens the bridge's own SQLite stores, so the `http` seam alone is not enough to keep a test off
   * this machine. Left undefined in production, where the real probes are what is wanted.
   */
  bridgeDeps?: BridgeDeps;
}

/**
 * Replace any occurrence of a secret value in a detail string. The details here are written by hand from
 * fixed text, HTTP statuses and account names, so this is belt and braces rather than the primary
 * defence: it is what stands between a provider that echoes the credential back in an error and a token
 * rendered onto the page. Short values are not matched, because a two-character "token" would blank half
 * the sentence and a value that short is not a credential.
 */
export function redactDetail(detail: string, values: Array<string | null | undefined>): string {
  let out = detail;
  for (const v of values) {
    const value = (v ?? "").trim();
    if (value.length < 8) continue;
    while (out.includes(value)) out = out.replace(value, "[redacted]");
  }
  return out;
}

/**
 * A thrown fetch can name the URL it failed on, and the Google checker puts the access token in that URL's
 * query. The catch in runCredentialCheck does not know the secret values, so it blanks the query token.
 */
function redactQueryTokens(message: string): string {
  return message.replace(/(access_token|refresh_token|client_secret|token)=[^&\s"']+/g, "$1=[redacted]");
}

/** The value of a store credential, or null when it is not there. Never logged, never returned upward. */
async function storedValue(store: Store, name: string, masterKey: MasterKey): Promise<string | null> {
  if (!(await hasSecret(store, name))) return null;
  return getSecret(store, name, masterKey.get());
}

const STATUS_OK = (status: number) => status >= 200 && status < 300;

const OPENCODE_GO_BASE = "https://opencode.ai/zen/go/v1";
const OPENCODE_ZEN_BASE = "https://opencode.ai/zen/v1";
const OPENCODE_GO_WINDOWS = ["rolling", "weekly", "monthly"] as const;
/** Weekly or monthly use at or above this is a WARNING (ok stays true): it shows in `creds check` output and the job journal, not as an alert. */
const OPENCODE_GO_LOW_PERCENT = 90;

/** Why OpenCode refused a key: its own error code when it gives one (`api_key_expired`), else the HTTP status. */
async function opencodeRejection(who: string, res: Response, token: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  const code = typeof body?.error?.code === "string" ? ` (${body.error.code})` : "";
  return redactDetail(`${who} answered HTTP ${res.status}${code}`, [token]);
}

/**
 * The bridge's bearer token, or an empty string. `readBridgeToken` throws when the file is absent, which
 * inside `bridgeStatus` would be swallowed into probe "unreachable" — and an unauthenticated probe of a
 * bridge that answers unauthenticated reads is still a better answer than "we learned nothing".
 */
async function softBridgeToken(store: Store): Promise<string> {
  try {
    return await readBridgeToken(store);
  } catch {
    return "";
  }
}

interface ResolvedDeps {
  http: typeof fetch;
  probes: Probes;
  masterKey: MasterKey;
  now?: string;
  bridgeDeps: BridgeDeps;
}

type Checker = (store: Store, deps: ResolvedDeps) => Promise<CheckResult>;

const CHECKERS: Record<string, Checker> = {
  async github(store, { http, masterKey, probes }) {
    const token = await storedValue(store, "github", masterKey);
    if (!token) {
      const where = probes.onPath("gh") ? " (the `gh` CLI may still have one, which the server will not)" : "";
      return { ok: false, detail: `not in the store${where}` };
    }
    const res = await http("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "omnislash" },
    });
    if (!STATUS_OK(res.status)) return { ok: false, detail: redactDetail(`GitHub answered HTTP ${res.status}`, [token]) };
    const body = (await res.json()) as { login?: string };
    return { ok: true, detail: redactDetail(`authenticated to GitHub as ${body.login ?? "an unnamed user"}`, [token]) };
  },

  async ha(store, { http, masterKey }) {
    const token = await storedValue(store, "ha", masterKey);
    if (!token) return { ok: false, detail: "not in the store" };
    const host = await settingFor(store, "ha_host");
    if (!host) return { ok: false, detail: "ha_host is not set" };
    const res = await http(`http://${host}:8123/api/`, { headers: { authorization: `Bearer ${token}` } });
    if (!STATUS_OK(res.status)) {
      return { ok: false, detail: redactDetail(`Home Assistant at ${host} answered HTTP ${res.status}`, [token]) };
    }
    return { ok: true, detail: redactDetail(`Home Assistant at ${host} accepted the token`, [token]) };
  },

  async "cloudflare-api-token"(store, { http, masterKey }) {
    const token = await storedValue(store, "cloudflare-api-token", masterKey);
    if (!token) return { ok: false, detail: "not in the store (ob 220's certificate renewal needs it)" };
    const res = await http("https://api.cloudflare.com/client/v4/user/tokens/verify", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!STATUS_OK(res.status)) return { ok: false, detail: redactDetail(`Cloudflare answered HTTP ${res.status}`, [token]) };
    const body = (await res.json()) as { result?: { status?: string } };
    const status = body.result?.status ?? "unknown";
    return { ok: status === "active", detail: redactDetail(`Cloudflare reports the token ${status}`, [token]) };
  },

  async "cloudflare-account-id"(store, { http, masterKey }) {
    const id = await storedValue(store, "cloudflare-account-id", masterKey);
    if (!id) return { ok: false, detail: "not in the store" };
    const token = await storedValue(store, "cloudflare-api-token", masterKey);
    if (!token) return { ok: false, detail: "stored, but unverifiable until cloudflare-api-token is stored too" };
    const res = await http(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!STATUS_OK(res.status)) {
      return { ok: false, detail: redactDetail(`Cloudflare answered HTTP ${res.status} for that account id`, [id, token]) };
    }
    const body = (await res.json()) as { result?: { name?: string } };
    return { ok: true, detail: redactDetail(`Cloudflare account ${body.result?.name ?? "resolved"}`, [id, token]) };
  },

  async google(store, { http, masterKey, now }) {
    const raw = await storedValue(store, "google", masterKey);
    if (!raw) return { ok: false, detail: "not in the store (run `ob google auth`)" };
    let token: GoogleToken;
    try {
      token = parseGoogleToken(raw, "secret google");
    } catch (err) {
      return { ok: false, detail: `the stored token is unusable: ${(err as Error).message}` };
    }
    // A grant Google already refused (OB-1950) is dead until a re-auth: no tokeninfo, no refresh POST.
    if (token.refresh_invalid_at) return { ok: false, detail: GOOGLE_INVALID_GRANT_DETAIL };
    const at = now ? Date.parse(now) : Date.now();
    const expiry = token.expiry ? Date.parse(token.expiry) : token.expiry_ms ?? null;
    const values = [token.access_token, token.refresh_token, token.client_secret];
    // An unexpired access token answers the question outright, and tokeninfo neither mutates nor costs
    // quota. An expired one does not mean broken: the connectors refresh, so the real question becomes
    // whether the refresh token still works, which the refresh grant answers without persisting anything.
    if (token.access_token && (expiry === null || expiry > at)) {
      const res = await http(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token.access_token)}`);
      if (STATUS_OK(res.status)) {
        const body = (await res.json()) as { scope?: string };
        const scopes = (body.scope ?? "").split(/\s+/).filter(Boolean).length;
        return { ok: true, detail: redactDetail(`Google accepted the access token (${scopes} scopes)`, values) };
      }
      if (!token.refresh_token) {
        return { ok: false, detail: redactDetail(`Google rejected the access token (HTTP ${res.status}) and there is no refresh token`, values) };
      }
    }
    if (!token.refresh_token) {
      return { ok: false, detail: "the access token has expired and there is no refresh token: run `ob google auth`" };
    }
    if (!token.client_id || !token.client_secret) {
      return { ok: false, detail: "a refresh token with no client credentials beside it: run `ob google auth`" };
    }
    const res = await http(token.token_uri ?? "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: token.client_id,
        client_secret: token.client_secret,
      }),
    });
    if (!STATUS_OK(res.status)) {
      return { ok: false, detail: redactDetail(`Google refused to refresh the token (HTTP ${res.status}): run \`ob google auth\``, values) };
    }
    return { ok: true, detail: redactDetail("the access token had expired and the refresh token still works", values) };
  },

  async "opencode-go"(store, { http, masterKey }) {
    const token = await storedValue(store, "opencode-go", masterKey);
    if (!token) return { ok: false, detail: "not in the store" };
    // Go is a subscription with three usage windows rather than a prepaid balance, and /usage is the one
    // authenticated read that reports them (found by probing, 1656). It is a GET, so it spends nothing.
    const res = await http(`${OPENCODE_GO_BASE}/usage`, { headers: { authorization: `Bearer ${token}` } });
    if (!STATUS_OK(res.status)) return { ok: false, detail: await opencodeRejection("OpenCode Go", res, token) };
    const body = (await res.json().catch(() => null)) as {
      usage?: Record<string, { status?: string; percent?: number; resetsAt?: string }>;
    } | null;
    const windows = OPENCODE_GO_WINDOWS.map((w) => ({ name: w, ...body?.usage?.[w] }));
    // Fail closed: a missing window or a non-numeric percent would otherwise hide an exhausted plan.
    if (windows.some((w) => typeof w.percent !== "number")) {
      return { ok: false, detail: redactDetail("OpenCode Go accepted the key but /usage did not report all of rolling, weekly and monthly (the shape changed?)", [token]) };
    }
    const summary = windows.map((w) => `${w.name} ${w.percent}% used`).join(", ");
    const spent = windows.filter((w) => w.status !== "ok" || w.percent! >= 100);
    if (spent.length > 0) {
      return { ok: false, detail: redactDetail(`OpenCode Go plan used up (${spent.map((w) => `${w.name}: ${w.status}`).join(", ")}); ${summary}`, [token]) };
    }
    const low = windows.filter((w) => w.name !== "rolling" && w.percent! >= OPENCODE_GO_LOW_PERCENT);
    if (low.length > 0) {
      const resets = low.map((w) => `${w.name} resets ${w.resetsAt ?? "at an unknown time"}`).join(", ");
      // Running low is a warning, not a failure (OB-1843): the key works and the plan has room left.
      return { ok: true, detail: redactDetail(`WARNING: OpenCode Go running low (>= ${OPENCODE_GO_LOW_PERCENT}% used, the key still works); ${summary}; ${resets}`, [token]) };
    }
    return { ok: true, detail: redactDetail(`OpenCode Go accepted the key; ${summary}`, [token]) };
  },

  async "opencode-zen"(store, { http, masterKey }) {
    const token = await storedValue(store, "opencode-zen", masterKey);
    if (!token) return { ok: false, detail: "not in the store" };
    // Zen has no balance or usage endpoint (probed 2026-10-27: /balance /usage /billing /credits /me all
    // 404), so this proves the KEY and nothing about the credit left. Listing models is free.
    const res = await http(`${OPENCODE_ZEN_BASE}/models`, { headers: { authorization: `Bearer ${token}` } });
    if (!STATUS_OK(res.status)) return { ok: false, detail: await opencodeRejection("OpenCode Zen", res, token) };
    return { ok: true, detail: redactDetail("OpenCode Zen accepted the key; it exposes no balance endpoint, so the credit left is not checked", [token]) };
  },

  async "master-key"(store, { masterKey, probes }) {
    const presence = masterKeyPresence(probes);
    if (!presence.present) return { ok: false, detail: presence.detail };
    const stored = await listSecrets(store);
    if (stored.length === 0) return { ok: true, detail: `${presence.detail}, with no stored secret to decrypt as proof` };
    // The only honest test of a master key is whether it still opens the store, so decrypt one secret
    // and throw the plaintext away without looking at it.
    try {
      const value = await getSecret(store, stored[0]!.name, masterKey.get());
      if (value === null) return { ok: false, detail: `${stored[0]!.name} is in the store but read back as nothing` };
      return { ok: true, detail: `${presence.detail}: it still decrypts the store (${stored.length} secrets)` };
    } catch {
      return { ok: false, detail: `${presence.detail}, but it does NOT decrypt \`${stored[0]!.name}\`: wrong key` };
    }
  },

  async whatsapp(store, { http, bridgeDeps }) {
    // The same read `ob whatsapp bridge status` prints, verdict and all, rather than a second opinion on
    // the same signals: the bridge exposes no login-state endpoint, so the honest answer is assembled from
    // its log, its health probe and its stores, and that assembly already exists. Loopback only — the one
    // "check" on this page that does not leave the machine.
    const cfg = await bridgeConfig(store);
    const status = await bridgeStatus(cfg, {
      readToken: () => softBridgeToken(store),
      ...bridgeDeps,
      fetch: bridgeDeps.fetch ?? http,
    });
    const headline = bridgeStatusHeadline(status);
    // `health` is taken as given rather than re-derived with a stricter rule of this module's own: it
    // already refuses to call a connected websocket an authenticated session (#119), and it already keeps
    // "unknown" separate from both. A local rule that demanded whatsmeow's logged-in line would fail every
    // bridge whose log had rotated past it, and a failed check raises an alert (rule 11).
    const ok = status.health === "healthy";
    const remedy = status.remedy ? ` — ${status.remedy}` : "";
    return { ok, detail: ok ? headline : `${headline}${remedy}` };
  },
};

/**
 * Run one credential's live check and record the verdict. This is the ONLY path in the module that
 * leaves the machine, it runs exactly once per explicit request, and it never returns a value: the
 * result is a boolean and a sentence. A checker that throws is recorded as a FAILED check rather than
 * swallowed, because "the check itself broke" is a thing the page has to be able to say.
 */
export async function runCredentialCheck(
  store: Store,
  name: string,
  deps: CheckDeps = {},
): Promise<CredentialCheckRow> {
  const spec = credentialSpec(name);
  const checker = CHECKERS[spec.name];
  if (!checker) throw new AppError(`\`${name}\` has no live check: ${spec.purpose}`);
  const resolved = {
    http: deps.http ?? fetch,
    probes: deps.probes ?? realProbes,
    masterKey: deps.masterKey ?? defaultMasterKey(),
    now: deps.now,
    bridgeDeps: deps.bridgeDeps ?? {},
  };
  let result: CheckResult;
  try {
    result = await checker(store, resolved);
  } catch (err) {
    result = { ok: false, detail: `the check could not complete: ${redactQueryTokens((err as Error).message)}` };
  }
  return recordCredentialCheck(store, spec.name, result, deps.now ?? nowIso());
}

// --- the write path ----------------------------------------------------------

export interface RequestOrigin {
  /** "https:" or "http:", the protocol of the connection the request actually arrived on. */
  proto: string;
  hostname: string;
}

export type WriteGate =
  | { allowed: true; via: "tls" | "loopback"; reason: string }
  | { allowed: false; reason: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0:0:0:0:0:0:0:1"]);

/**
 * Whether a pasted credential may be accepted over this connection. Two ways through and one refusal:
 *
 *  - TLS, which is what ob 220 is building, and the case the owner chose over a read-only page.
 *  - Loopback, where the value never reaches a network at all.
 *  - Anything else is refused, and says why. The dashboard binds to a LAN address over plain HTTP
 *    (ob 192), so this refusal is what stops a token crossing the house network in the clear. It is
 *    checked here rather than assumed from 220 having landed, so the two tickets can land in either
 *    order without a window where the page takes a paste over cleartext.
 */
export function writeGate(origin: RequestOrigin): WriteGate {
  const host = origin.hostname.toLowerCase();
  if (origin.proto === "https:") return { allowed: true, via: "tls", reason: "the connection is TLS" };
  if (LOOPBACK_HOSTS.has(host)) {
    return { allowed: true, via: "loopback", reason: "the connection is loopback, so the value never reaches a network" };
  }
  return {
    allowed: false,
    reason: `refusing to accept a credential over ${origin.proto}//${origin.hostname}: a pasted token would cross the network in the clear. Reach the dashboard over https (ob 220), or paste it on the machine itself with \`ob secret set\``,
  };
}

/** Read a request's real origin. Deliberately the connection's own URL, never x-forwarded-proto, which
 *  anyone on the LAN can set. A TLS-terminating proxy in front of this needs its own decision. */
export function originFromRequest(req: { url: string }): RequestOrigin {
  const url = new URL(req.url);
  return { proto: url.protocol, hostname: url.hostname };
}

export interface StoredCredentialWrite {
  name: string;
  updated_at: string;
}

/**
 * Store a pasted credential. Refuses over a cleartext connection, refuses a credential that a paste
 * cannot refresh (google's OAuth round trip, the master key, a QR pairing), and
 * refuses an empty value. Never logs, prints or returns the value.
 */
export async function storeCredential(
  store: Store,
  name: string,
  value: string,
  opts: { origin: RequestOrigin; masterKey?: MasterKey; now?: string },
): Promise<StoredCredentialWrite> {
  const spec = credentialSpec(name);
  const gate = writeGate(opts.origin);
  if (!gate.allowed) throw new AppError(gate.reason);
  if (!isPasteRefreshable(spec)) {
    throw new AppError(`\`${spec.name}\` cannot be refreshed by pasting a value: run \`${spec.command}\``);
  }
  const trimmed = value.trim();
  if (!trimmed) throw new AppError(`no value given for \`${spec.name}\``);
  // setSecret is the same write `ob secret set` uses; the value goes straight into AES-256-GCM.
  await setSecret(store, spec.name, trimmed, (opts.masterKey ?? (await masterKeyForWrite(store))).get());
  await clearCredentialCheck(store, spec.name);
  return {
    name: spec.name,
    updated_at:
      (await listSecrets(store)).find((r) => r.name === spec.name)?.updated_at ?? opts.now ?? nowIso(),
  };
}

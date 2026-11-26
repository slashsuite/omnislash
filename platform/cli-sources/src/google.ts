import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { AppError } from "../../../apps/cli/src/errors.ts";
import { expandHome } from "../../../apps/cli/src/net.ts";
import { warn } from "../../../apps/cli/src/output.ts";
import { settingFor } from "../../../apps/cli/src/settings.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import { defaultMasterKey, getSecret, hasSecret, setSecret, type MasterKey } from "../../../apps/cli/src/secrets.ts";

// -----------------------------------------------------------------------------
// Auth (STUBBED, 125/126/127): the OAuth *flow* is out of scope. We read a stored
// token JSON from a `*_path` setting (google_token_path → ~/.google_token, like
// ha_token_path / github_key_path). If the token is expired and a refresh_token +
// client credentials are present, HttpGoogleClient refreshes it via the token_uri
// and persists the result. That refresh is a network call — it lives behind the
// injectable GoogleClient, so tests (which inject a fake) never touch the network.
// -----------------------------------------------------------------------------

export interface GoogleToken {
  access_token: string;
  refresh_token?: string | undefined;
  /** Absolute expiry as ISO-8601 (preferred) … */
  expiry?: string | undefined;
  /** … or epoch millis. Either is accepted; ISO wins if both are set. */
  expiry_ms?: number | undefined;
  client_id?: string | undefined;
  client_secret?: string | undefined;
  token_uri?: string | undefined;
  /** ISO time Google refused the refresh token (invalid_grant, OB-1950). Cleared by a re-auth. */
  refresh_invalid_at?: string | undefined;
}

/** The error for a refresh token Google refused (OB-1950). Names no token and no response body. */
const GOOGLE_INVALID_GRANT_MESSAGE =
  "Google refused the refresh token (invalid_grant: revoked or expired): run `ob google auth`";

/** Parse + validate a GoogleToken from its JSON text. `where` names the source for clean errors. */
export function parseGoogleToken(text: string, where: string): GoogleToken {
  let token: GoogleToken;
  try {
    token = JSON.parse(text) as GoogleToken;
  } catch {
    throw new AppError(`Google token (${where}) is not valid JSON`);
  }
  if (!token.access_token && !token.refresh_token) {
    throw new AppError(`Google token (${where}) has neither access_token nor refresh_token`);
  }
  return token;
}

/** Read + parse the stored Google OAuth token FILE. Throws a clean AppError when absent/invalid. */
export function readGoogleToken(path: string): GoogleToken {
  let text: string;
  try {
    text = readFileSync(expandHome(path), "utf8");
  } catch {
    throw new AppError(
      `cannot read Google token at ${path} (run \`ob google auth\`, or set config google_token_path to a token file)`,
    );
  }
  return parseGoogleToken(text, path);
}

/** A resolved Google token plus a `persist` sink that writes a refreshed token back to its source. */
export interface ResolvedGoogleToken {
  token: GoogleToken;
  /**
   * Write a refreshed token back to its source. Widened for 337: the store-backed sink is a database
   * write, which is asynchronous on Postgres, so this may return a promise and every caller awaits it.
   * The file-backed sink stays synchronous and returns undefined, so nothing about the SQLite path
   * changes.
   */
  persist: (t: GoogleToken) => void | Promise<void>;
}

/**
 * Resolve the Google token for the connectors: the encrypted store (`google`) first, then — during the
 * transition — the legacy google_token_path FILE (with a nudge). `persist` writes a refreshed token
 * back to the SAME source (store→re-encrypt; file→rewrite chmod 600). The Keychain master key is only
 * fetched when the store actually holds the token.
 */
// --- resolving the token (337) ------------------------------------------------------------------------
//
// `googleTokenFromFile` holds the legacy file source (its nudge, its chmod 600 rewrite, its best-effort
// swallow) and `parseGoogleToken` the ciphertext one, so the ladder is stated once. The encryption, the
// master key and the token file itself are untouched: only where the ciphertext row is read changed.

/** The legacy google_token_path FILE source, with its nudge and its write-back sink. Shared by both forms. */
export function googleTokenFromFile(path: string): ResolvedGoogleToken {
  const token = readGoogleToken(path); // throws a clean AppError when the file is absent
  warn(`google: still a file (${path}) — run \`ob secret import\` to move it into the encrypted store`);
  return {
    token,
    persist: (t) => {
      try {
        writeFileSync(expandHome(path), JSON.stringify(t, null, 2));
        chmodSync(expandHome(path), 0o600);
      } catch (err) {
        // Best-effort persistence; the refreshed in-memory token still works this run. Say so, naming
        // the path and the reason only (never the token), so a stale file is not a silent surprise.
        warn(`google: could not save the refreshed token to ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/**
 * Resolve the Google token for the connectors: the encrypted store (`google`) first, then — during the
 * transition — the legacy google_token_path FILE (with a nudge). `persist` writes a refreshed token back
 * to the SAME source (store→re-encrypt; file→rewrite chmod 600). The Keychain master key is only fetched
 * when the store actually holds the token. The store-backed `persist` is a database write, so it is
 * AWAITED by its caller rather than dropped (ob 338).
 */
export async function getGoogleToken(
  store: Store,
  masterKey: MasterKey = defaultMasterKey(),
): Promise<ResolvedGoogleToken> {
  if (await hasSecret(store, "google")) {
    const raw = await getSecret(store, "google", masterKey.get());
    if (raw !== null) {
      return {
        token: parseGoogleToken(raw, "secret google"),
        persist: (t) => setSecret(store, "google", JSON.stringify(t, null, 2), masterKey.get()),
      };
    }
  }
  return googleTokenFromFile(await settingFor(store, "google_token_path"));
}

/**
 * Merge a freshly issued token over the stored one (OB-1916). Google may omit `refresh_token` on a
 * re-auth; saving that response as is would lose the stored grant. `next` keeps `prev.refresh_token`
 * only when `next` has none, `prev` has one, and both belong to the same OAuth client (a different
 * client never inherits an old grant), and never when `prev` is marked `refresh_invalid_at` (OB-1950).
 * The result never carries `refresh_invalid_at`.
 */
export function mergeGoogleToken(prev: GoogleToken | null | undefined, next: GoogleToken): GoogleToken {
  // A refused grant (OB-1950) is never carried forward, and a re-auth always clears the marker.
  let fresh = next;
  if (next.refresh_invalid_at !== undefined) {
    const { refresh_invalid_at: _drop, ...rest } = next;
    fresh = rest;
  }
  if (fresh.refresh_token || !prev?.refresh_token || prev.refresh_invalid_at || prev.client_id !== fresh.client_id) {
    return fresh;
  }
  return { ...fresh, refresh_token: prev.refresh_token };
}

/** Parse a previously stored token for a merge: missing, empty or unparseable means none, never an error. */
export function previousGoogleToken(raw: string | null | undefined): GoogleToken | null {
  if (!raw) return null;
  try {
    return parseGoogleToken(raw, "previous google");
  } catch {
    return null;
  }
}

/** ms until the token expires (negative when already expired). +Infinity when no expiry is recorded. */
function msUntilExpiry(t: GoogleToken): number {
  if (t.expiry) {
    const ms = new Date(t.expiry).getTime();
    if (Number.isFinite(ms)) return ms - Date.now();
  }
  if (typeof t.expiry_ms === "number") return t.expiry_ms - Date.now();
  return Number.POSITIVE_INFINITY;
}

// -----------------------------------------------------------------------------
// Google API surface used by the connectors — the injection seam. Fixtures in
// tests implement this; HttpGoogleClient is the only thing that touches Google.
// -----------------------------------------------------------------------------

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePart {
  mimeType?: string;
  /** Set on an attachment part (or an inline file); empty on the text body parts. */
  filename?: string;
  headers?: GmailHeader[];
  /** `attachmentId` is set when the bytes live behind `messages.attachments.get` rather than inline in `data`. */
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string; // epoch millis as a string (Gmail's format)
  historyId?: string; // advances the sync cursor after a messages.list backfill
  payload?: GmailMessagePart;
}

export interface GmailListResponse {
  messages?: Array<{ id: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GmailHistoryResponse {
  /** Records after `startHistoryId`, oldest first. `id` is the record's own historyId (OB-1949). */
  history?: Array<{ id?: string; messagesAdded?: Array<{ message: { id: string; threadId?: string } }> }>;
  historyId?: string;
  nextPageToken?: string;
}

export interface CalendarEventResource {
  id: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string; self?: boolean }>;
  recurringEventId?: string;
  recurrence?: string[];
  updated?: string;
}

export interface CalendarListResponse {
  items?: CalendarEventResource[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/** A 410 GONE from Calendar's incremental sync — the stored syncToken is stale, do a full resync. */
export class SyncTokenExpiredError extends Error {}

/**
 * A non-OK Google HTTP status. Message shape is stable (`Google API request failed (N) for <url>`) so
 * job-health text that already names a 404 still matches. Callers decide skip vs abort from `status`.
 */
export class GoogleHttpError extends AppError {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string) {
    super(`Google API request failed (${status}) for ${url}`);
    this.status = status;
    this.url = url;
  }
}

/** 404/403 on one message GET: the id is gone (deleted/unreadable). Skip it; do not abort the run. */
export function isGoneGoogleMessage(err: unknown): boolean {
  return err instanceof GoogleHttpError && (err.status === 404 || err.status === 403);
}

/**
 * Gmail history.list 404: startHistoryId is too old (kept ~a week). Fall back to a bounded
 * messages.list backfill — same class of recovery as Calendar's 410 GONE.
 */
export function isExpiredGmailHistory(err: unknown): boolean {
  return err instanceof GoogleHttpError && err.status === 404 && /\/history(?:\?|$)/.test(err.url);
}

/** Bound every Google HTTP call so a wedged socket cannot hold a launchd/systemd job forever (177). */
export const GOOGLE_HTTP_TIMEOUT_MS = 30_000;

/** Call signature only — `typeof fetch` also has `preconnect` and is a pain to fake. */
export type GoogleFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export interface GoogleClient {
  gmailListMessages(opts: { q?: string; pageToken?: string | undefined; maxResults?: number }): Promise<GmailListResponse>;
  gmailGetMessage(id: string): Promise<GmailMessage>;
  gmailHistoryList(opts: { startHistoryId: string; pageToken?: string | undefined }): Promise<GmailHistoryResponse>;
  /** OB-1914: `users/me/profile`; its historyId is where a backfill hands over to the history poll. */
  gmailGetProfile(): Promise<{ historyId?: string }>;
  calendarListEvents(opts: {
    calendarId: string;
    syncToken?: string | undefined;
    pageToken?: string | undefined;
    timeMin?: string;
  }): Promise<CalendarListResponse>;
}

/**
 * 1757: Gmail DRAFTS — a separate seam from GoogleClient so the sync fixtures do not have to fake it.
 * `gmailCreateDraft` only ever makes a draft; `gmailSendDraft` sends an EXISTING draft and is reached
 * only through `ob gmail send-draft <id> --confirm --hash <hex>` (a human's word). There is no one-shot send.
 */
export interface GmailDraft {
  id: string;
  message?: GmailMessage;
}

/** `drafts.list`: ids only (no headers); `nextPageToken` is absent on the last page. */
export interface GmailDraftListResponse {
  drafts?: Array<{ id: string; message?: { id: string; threadId?: string } }>;
  nextPageToken?: string;
}

export interface GmailAttachmentBody {
  size?: number;
  data?: string;
}

/** One entry of Gmail's Send-as list (`settings.sendAs`): an address the account may send mail as. */
export interface GmailSendAs {
  sendAsEmail: string;
  displayName?: string;
  isPrimary?: boolean;
  isDefault?: boolean;
  /** Absent on the primary address; `accepted` once a non-primary alias is verified, `pending` before. */
  verificationStatus?: string;
}

export interface GmailDraftClient {
  /** OB-1961: the account's Send-as addresses (`settings/sendAs`), the only addresses a draft may be From. Read-only. */
  gmailListSendAs(): Promise<GmailSendAs[]>;
  /** Fetch one message (for `--reply-to`: its Message-ID, References, Subject and threadId). */
  gmailGetMessage(id: string): Promise<GmailMessage>;
  /** 1680: one attachment's bytes (`data` is base64url), read-only. */
  gmailGetAttachment(messageId: string, attachmentId: string): Promise<GmailAttachmentBody>;
  gmailCreateDraft(req: { raw: string; threadId?: string | undefined }): Promise<GmailDraft>;
  gmailGetDraft(id: string): Promise<GmailDraft>;
  gmailSendDraft(id: string): Promise<GmailMessage>;
  /** OB-1750: the newest drafts first. Ids only: `gmailGetDraft` has the headers. */
  gmailListDrafts(opts: { maxResults?: number; pageToken?: string; includeSpamTrash?: boolean }): Promise<GmailDraftListResponse>;
  /** OB-1750: replace a draft's message in place (`drafts.update`); the draft id is kept. Never sends. */
  gmailUpdateDraft(id: string, req: { raw: string; threadId?: string | undefined }): Promise<GmailDraft>;
  /** OB-1750: `drafts.delete` removes the draft outright (it does not go to Trash). */
  gmailDeleteDraft(id: string): Promise<void>;
}

/** Whether a refused token response is `invalid_grant`. An unreadable body is a plain failure. */
async function isInvalidGrant(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    return body?.error === "invalid_grant";
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Real client — the ONLY code path that reaches Google. Never constructed in tests.
// -----------------------------------------------------------------------------

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

export class HttpGoogleClient implements GoogleClient, GmailDraftClient {
  private token: GoogleToken;
  private readonly persist?: ((t: GoogleToken) => void | Promise<void>) | undefined;
  private readonly fetchImpl: GoogleFetch;
  private readonly timeoutMs: number;
  /** Called when Google refuses the refresh token (invalid_grant), to record the failing credential. */
  private readonly onInvalidGrant?: (() => void | Promise<void>) | undefined;
  /** The in-flight refresh, shared by concurrent callers (single flight); cleared when it settles. */
  private refreshing: Promise<string> | undefined;
  /** A pre-emptive refresh of a token with no recorded expiry was rejected; do not try it again. */
  private noExpiryRefreshFailed = false;

  /**
   * `persist` writes a refreshed token back to its source (store/file).
   * `opts.fetch` / `opts.timeoutMs` are the HTTP seam: production uses global fetch + 30s;
   * tests inject a fake fetch (and a short timeout) so they never touch the network.
   * `opts.onInvalidGrant` records a refused refresh token (OB-1950); a failure in it only warns.
   */
  constructor(
    token: GoogleToken,
    persist?: (t: GoogleToken) => void | Promise<void>,
    opts: { fetch?: GoogleFetch | undefined; timeoutMs?: number; onInvalidGrant?: () => void | Promise<void> } = {},
  ) {
    this.token = token;
    this.persist = persist;
    this.onInvalidGrant = opts.onInvalidGrant;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? GOOGLE_HTTP_TIMEOUT_MS;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      if (isAbortError(err)) {
        throw new AppError(`Google API request timed out after ${this.timeoutMs}ms for ${url}`);
      }
      throw err;
    }
  }

  /** Whether the token can be refreshed at all (a refresh token plus client credentials). */
  private canRefresh(): boolean {
    if (this.token.refresh_invalid_at) return false; // Google refused it; never POST it again (OB-1950)
    return Boolean(this.token.refresh_token && this.token.client_id && this.token.client_secret);
  }

  /** Record the refused grant through `onInvalidGrant`; a failure there warns and never masks the error. */
  private async reportInvalidGrant(): Promise<void> {
    try {
      await this.onInvalidGrant?.();
    } catch (err) {
      warn(`could not record the refused Google refresh token: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** A marked token that would need a refresh: record it again and throw, with no token POST. */
  private async refusedGrant(): Promise<never> {
    await this.reportInvalidGrant();
    throw new AppError(GOOGLE_INVALID_GRANT_MESSAGE);
  }

  /**
   * The access token to send. Refreshes first when it is within 60s of expiry, or when no expiry is
   * recorded at all (OB-1916: an unknown expiry is treated as expired, once per instance).
   */
  private async ensureFreshToken(): Promise<string> {
    const noExpiry = !this.token.expiry && typeof this.token.expiry_ms !== "number";
    if (!this.refreshing) {
      if (noExpiry) {
        if (this.token.access_token && (this.noExpiryRefreshFailed || !this.canRefresh())) return this.token.access_token;
      } else if (msUntilExpiry(this.token) > 60_000 && this.token.access_token) {
        return this.token.access_token;
      }
      if (!this.canRefresh()) {
        if (this.token.refresh_invalid_at) return this.refusedGrant(); // expired, and its grant is dead
        if (this.token.access_token) return this.token.access_token; // no way to refresh; try as-is
        throw new AppError("Google token expired and has no refresh_token/client credentials to refresh");
      }
    }
    try {
      return await this.refresh(); // joins an in-flight refresh when there is one
    } catch (err) {
      // A rejected pre-emptive refresh of a token with no recorded expiry falls back to the access token
      // as today, for every waiter, and is not tried again on this instance; a later 401 still takes the
      // 401 path. Only when the token was not replaced: a failed save after a good refresh still throws.
      const stillNoExpiry = !this.token.expiry && typeof this.token.expiry_ms !== "number";
      if (noExpiry && stillNoExpiry && this.token.access_token) {
        this.noExpiryRefreshFailed = true;
        return this.token.access_token;
      }
      throw err;
    }
  }

  /** Single-flight refresh: concurrent callers on this instance share one in-flight token POST. */
  private refresh(): Promise<string> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    const { refresh_token, client_id, client_secret } = this.token;
    if (!refresh_token || !client_id || !client_secret) {
      throw new AppError("Google token expired and has no refresh_token/client credentials to refresh");
    }
    const tokenUri = this.token.token_uri ?? DEFAULT_TOKEN_URI;
    let res: Response;
    try {
      res = await this.request(tokenUri, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id, client_secret }),
      });
    } catch (err) {
      if (err instanceof AppError && err.message.includes("timed out")) {
        throw new AppError(`Google token refresh timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    }
    if (!res.ok) {
      if (res.status === 400 && (await isInvalidGrant(res))) {
        await this.reportInvalidGrant();
        try {
          this.token = { ...this.token, refresh_invalid_at: new Date().toISOString() };
          await this.persist?.(this.token);
        } catch (err) {
          warn(`could not save the refused Google token marker: ${err instanceof Error ? err.message : String(err)}`);
        }
        throw new AppError(GOOGLE_INVALID_GRANT_MESSAGE);
      }
      throw new AppError(`Google token refresh failed (${res.status})`);
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string };
    this.token = {
      ...this.token,
      access_token: json.access_token,
      // Google may rotate the refresh token; keep the new one when it sends one (OB-1916).
      refresh_token: json.refresh_token || this.token.refresh_token,
      expiry: new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString(),
    };
    // Awaited, not dropped: the store-backed sink is a database write and a discarded promise would
    // leave the refreshed token unsaved with nothing to show for it (ob 338).
    await this.persist?.(this.token);
    return this.token.access_token;
  }

  /**
   * Send one authorised request; on a 401 refresh once and repeat it once (OB-1916). The refresh is
   * forced only when the rejected access token is still the current one; if a concurrent refresh has
   * already replaced it, the repeat uses the current token. A second 401 is returned to the caller.
   */
  private async authorised(url: string, init: (access: string) => RequestInit): Promise<Response> {
    const access = await this.ensureFreshToken();
    const res = await this.request(url, init(access));
    if (res.status !== 401) return res;
    let retryAccess: string;
    if (this.refreshing) retryAccess = await this.refreshing;
    else if (this.token.access_token !== access) retryAccess = this.token.access_token;
    else if (this.canRefresh()) retryAccess = await this.refresh();
    else if (this.token.refresh_invalid_at) return this.refusedGrant();
    else return res;
    return this.request(url, init(retryAccess));
  }

  private async get<T>(url: string): Promise<T> {
    const res = await this.authorised(url, (access) => ({ headers: { authorization: `Bearer ${access}` } }));
    if (res.status === 410) throw new SyncTokenExpiredError("410 GONE");
    if (!res.ok) throw new GoogleHttpError(res.status, url);
    return (await res.json()) as T;
  }

  private async send<T>(method: "POST" | "PUT" | "DELETE", url: string, body?: unknown): Promise<T> {
    const res = await this.authorised(url, (access) => ({
      method,
      headers: { authorization: `Bearer ${access}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }));
    if (!res.ok) throw new GoogleHttpError(res.status, url);
    return (method === "DELETE" ? undefined : await res.json()) as T;
  }

  private post<T>(url: string, body: unknown): Promise<T> {
    return this.send<T>("POST", url, body);
  }

  gmailCreateDraft(req: { raw: string; threadId?: string | undefined }): Promise<GmailDraft> {
    const message: { raw: string; threadId?: string } = { raw: req.raw };
    if (req.threadId) message.threadId = req.threadId;
    return this.post<GmailDraft>(`${GMAIL_BASE}/drafts`, { message });
  }

  gmailGetDraft(id: string): Promise<GmailDraft> {
    return this.get<GmailDraft>(`${GMAIL_BASE}/drafts/${encodeURIComponent(id)}?format=full`);
  }

  gmailSendDraft(id: string): Promise<GmailMessage> {
    return this.post<GmailMessage>(`${GMAIL_BASE}/drafts/send`, { id });
  }

  gmailListDrafts(opts: { maxResults?: number; pageToken?: string; includeSpamTrash?: boolean }): Promise<GmailDraftListResponse> {
    const p = new URLSearchParams();
    if (opts.pageToken) p.set("pageToken", opts.pageToken);
    // Gmail's default is false, and a draft discarded in Gmail is only labelled TRASH: drafts.get still reads it.
    if (opts.includeSpamTrash) p.set("includeSpamTrash", "true");
    p.set("maxResults", String(opts.maxResults ?? 20));
    return this.get<GmailDraftListResponse>(`${GMAIL_BASE}/drafts?${p.toString()}`);
  }

  gmailUpdateDraft(id: string, req: { raw: string; threadId?: string | undefined }): Promise<GmailDraft> {
    const message: { raw: string; threadId?: string } = { raw: req.raw };
    if (req.threadId) message.threadId = req.threadId;
    return this.send<GmailDraft>("PUT", `${GMAIL_BASE}/drafts/${encodeURIComponent(id)}`, { id, message });
  }

  gmailDeleteDraft(id: string): Promise<void> {
    return this.send<void>("DELETE", `${GMAIL_BASE}/drafts/${encodeURIComponent(id)}`);
  }

  async gmailListSendAs(): Promise<GmailSendAs[]> {
    const res = await this.get<{ sendAs?: GmailSendAs[] }>(`${GMAIL_BASE}/settings/sendAs`);
    return res.sendAs ?? [];
  }

  gmailListMessages(opts: { q?: string; pageToken?: string | undefined; maxResults?: number }): Promise<GmailListResponse> {
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    if (opts.pageToken) p.set("pageToken", opts.pageToken);
    p.set("maxResults", String(opts.maxResults ?? 100));
    return this.get<GmailListResponse>(`${GMAIL_BASE}/messages?${p.toString()}`);
  }

  gmailGetMessage(id: string): Promise<GmailMessage> {
    return this.get<GmailMessage>(`${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=full`);
  }

  gmailGetAttachment(messageId: string, attachmentId: string): Promise<GmailAttachmentBody> {
    return this.get<GmailAttachmentBody>(
      `${GMAIL_BASE}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
  }

  gmailHistoryList(opts: { startHistoryId: string; pageToken?: string | undefined }): Promise<GmailHistoryResponse> {
    const p = new URLSearchParams({ startHistoryId: opts.startHistoryId, historyTypes: "messageAdded" });
    if (opts.pageToken) p.set("pageToken", opts.pageToken);
    return this.get<GmailHistoryResponse>(`${GMAIL_BASE}/history?${p.toString()}`);
  }

  gmailGetProfile(): Promise<{ historyId?: string }> {
    return this.get<{ historyId?: string }>(`${GMAIL_BASE}/profile`);
  }

  calendarListEvents(opts: {
    calendarId: string;
    syncToken?: string | undefined;
    pageToken?: string | undefined;
    timeMin?: string;
  }): Promise<CalendarListResponse> {
    const p = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
    if (opts.syncToken) p.set("syncToken", opts.syncToken);
    else {
      p.set("orderBy", "startTime");
      if (opts.timeMin) p.set("timeMin", opts.timeMin);
    }
    if (opts.pageToken) p.set("pageToken", opts.pageToken);
    return this.get<CalendarListResponse>(
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(opts.calendarId)}/events?${p.toString()}`,
    );
  }
}

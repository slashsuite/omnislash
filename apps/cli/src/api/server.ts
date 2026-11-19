// ob 352 -- the router. Auth, validation, dispatch, and the error shape.
//
// A plain `(Request) => Promise<Response>`, deliberately: it is mounted inside the dashboard's Bun.serve
// (map D4) rather than started as a second service, and it is exercised in tests by CALLING it with a
// Request rather than by binding a port. No framework, and nothing here that needs one -- fifteen routes.
//
// The order of business on every request is fixed and worth stating, because getting it wrong is how an
// API leaks: AUTH FIRST, before the path is looked at, before a body is read, before the store is
// touched. An unauthenticated request must not be able to tell a real route from a typo, and must not be
// able to make the server do work.
import { join } from "node:path";
import type { Store } from "../db/store.ts";
import { AppError, UsageError } from "../errors.ts";
import { reportError } from "../sentry/report.ts";
import { CallTimeoutError, timeoutFromEnv, withDeadline } from "../deadline.ts";
import { parsePriority, PRIORITY_OPTIONS } from "../priority.ts";
import { DEFAULT_LEASE_TTL_S, normalizeLeaseResource } from "../../../../platform/cli-coord/src/lease.ts";
import { AGENT_STATUSES, parseAgentStatus } from "../../../../platform/cli-coord/src/agent.ts";
import {
  LAUNCHER_NAMES,
  SPINOFF_MODES,
  SPINOFF_STATUSES,
  type LauncherName,
  type SpinoffMode,
} from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { SPINOFF_EFFORTS, SPINOFF_TIERS, type SpinoffEffort, type SpinoffTier } from "../t3/dispatch.ts";
import type { TokenUsage } from "../../../../platform/cli-coord/src/spinoff-tokens.ts";
import { VALID_TYPES, isValidStatus, statusVocab } from "../status.ts";
import {
  describeRoutes,
  OB_API_AGENT_ACTIONS,
  OB_API_LOCAL_ONLY,
  OB_API_PREFIX,
  apiTimeoutFor,
  OB_API_STATE_ACTIONS,
  OB_API_TRANSITION_ACTIONS,
  WHATSAPP_PREF_ACTIONS,
  type AcquireLeaseRequest,
  type AgentRequest,
  type ObApiAgentAction,
  type ObApiErrorBody,
  type ObApiErrorCode,
  type ObApiStateAction,
  type ObApiTransitionAction,
  type SpinoffPlannedFilesRequest,
} from "./contract.ts";
import { ApiFault } from "./fault.ts";
import { bearerFrom, loadApiToken, tokenMatches, type TokenLoad } from "./token.ts";
import type { RoleMessageRequest } from "./contract.ts";
import type { ItemQuery, ItemSort } from "../worklist.ts";
import type { GmailDraftAttachmentInput } from "../../../../platform/cli-sources/src/gmail-draft.ts";
import type { GmailDraftClient, GoogleClient } from "../../../../platform/cli-sources/src/google.ts";
import {
  GOOGLE_AUTH_PATH,
  GOOGLE_CALLBACK_PATH,
  createGoogleStateStore,
  GOOGLE_OAUTH_STATE_FILE,
  STATE_TTL_MS,
  hostedCallbackPage,
  type GoogleStateStore,
} from "../../../../platform/cli-sources/src/google-hosted.ts";
import type { TokenExchanger } from "../../../../platform/cli-sources/src/commands/google.ts";
import * as h from "./handlers.ts";
import { kickLiveDeploy, type DeployKickDeps } from "./deploy-kick.ts";
import {
  hostOutputSecretValues,
  hostSnapshotDir,
  listHostJobs,
  parseHostJobRequest,
  readHostJob,
  startHostJob,
  type HostJobDeps,
} from "./host-jobs.ts";
import { parseSnapshotName, snapshotDirFor } from "../commands/db.ts";
import { GITHUB_WEBHOOK_PATH, handleRun, receiveWebhook } from "../ci-main.ts";

/** How long one request may run before the server answers 504 (1616). `OB_API_REQUEST_TIMEOUT_MS` overrides it. */
const API_REQUEST_TIMEOUT_MS = timeoutFromEnv("OB_API_REQUEST_TIMEOUT_MS", 120_000);

export interface ObApiDeps {
  /** Per-request deadline in ms (1616); tests inject a short one. Default API_REQUEST_TIMEOUT_MS. */
  requestTimeoutMs?: number;
  /** The store the API fronts. A thunk so the host's per-process singleton is reused, not reopened. */
  store: () => Promise<Store>;
  /** The loaded token. A thunk so a deployment can re-read the file without rebuilding the handler. */
  token: () => TokenLoad;
  /**
   * ob 357: the master key the secret endpoints decrypt against. Left undefined in production, where the
   * real provider reads the Keychain (or the 0600 file on the API host). Injected by tests, which are FORBIDDEN
   * from touching the real Keychain, so without this seam the secret path could not be exercised at all.
   */
  secrets?: h.SecretDeps;
  /** ob 357: the probe/HTTP seams the credential inventory and its live checks read the machine through. */
  creds?: h.CredsDeps;
  /**
   * 415: the Google client gmail/cal sync use. Left undefined in production, where ingest builds
   * HttpGoogleClient from secret `google` (or the host token file). Tests inject a fixture so a
   * POST /gmail/sync never leaves the machine.
   */
  google?: GoogleClient;
  /**
   * 1757: the Gmail drafts client. Left undefined in production (built from secret `google` on this host);
   * tests inject a fixture so creating or sending a draft never leaves the machine.
   */
  gmailDrafts?: GmailDraftClient;
  /**
   * 1305: the hosted Google OAuth half. Left undefined in production so the state store is the shared
   * GOOGLE_OAUTH_STATE_FILE (OB-1935) and the token exchange is the real Google one; tests inject a fixture
   * and a frozen clock.
   */
  googleHosted?: {
    states?: GoogleStateStore;
    exchange?: TokenExchanger;
    now?: () => number;
  };
  /** The WhatsApp bridge fetch a send uses. Left undefined in production (global fetch); tests inject a fixture. */
  whatsappSend?: h.WhatsappSendDeps;
  /** OB-1808: where host jobs live and how they start. Left undefined in production; tests inject a fake spawn. */
  hostJobs?: HostJobDeps;
  /** OB-1809: what POST /deploys/run runs. Left undefined in production; tests inject a fake so nothing reaches systemd. */
  deployKick?: DeployKickDeps;
  /**
   * OB-2276: the retry wait and the deferral the webhook uses. Left undefined in production (the run is handled after
   * the 202); tests inject them. The REST client and the T3 seam are the module seams `__setGithubRest`, `__setT3Seam`.
   */
  ci?: h.CiApiDeps;
}

/** `ob agent active --within` defaults to 20 minutes; the endpoint takes the same default (098). */
const DEFAULT_ACTIVE_WITHIN_MIN = 20;

/** Bodies above this are refused unread. An `ob` request is a few hundred bytes; a note is the outlier. */
const MAX_BODY_BYTES = 1_000_000;
/** OB-1763: a till-slip upload, base64 of a ~5MB file (MAX_ATTACHMENT_BASE64_LEN) plus the JSON around it. */
const MAX_ATTACHMENT_BODY_BYTES = 7_000_000;
/** 1680: a draft's files ride in the body as base64: 18 MiB of files is 24 MiB, plus the text. */
const MAX_DRAFT_BODY_BYTES = 16_000_000;

/** Does this URL belong to the ob API? The host delegates everything else to its own routes. */
export function isObApiPath(pathname: string): boolean {
  return pathname === OB_API_PREFIX || pathname.startsWith(OB_API_PREFIX + "/");
}

/**
 * 1305: the two BROWSER routes, which carry NO bearer token because a browser tap cannot send one.
 *
 * They are matched by EXACT path and exact method, and nothing else qualifies: `/google/auth-url` (the
 * authenticated mint `ob google auth-url` calls) is deliberately not here. Their guard is the one-time
 * `state` the server minted, and the callback burns it before it looks at the code.
 */
function isGoogleBrowserPath(pathname: string, method: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  const rest = pathname.slice(OB_API_PREFIX.length).replace(/\/+$/, "");
  const auth = GOOGLE_AUTH_PATH.slice(OB_API_PREFIX.length);
  const callback = GOOGLE_CALLBACK_PATH.slice(OB_API_PREFIX.length);
  return rest === auth || rest === callback;
}

/**
 * OB-2276: GitHub's webhook receiver, the other route with no bearer token: GitHub cannot send one. Matched by
 * exact path and method. Its guard is the X-Hub-Signature-256 HMAC over the body, checked in the handler before
 * anything is recorded.
 */
function isGithubWebhookPath(pathname: string, method: string): boolean {
  return method.toUpperCase() === "POST" && pathname.replace(/\/+$/, "") === GITHUB_WEBHOOK_PATH;
}

/** OB-2276: a webhook body is read whole before its signature can be checked, so it is capped first. */
const MAX_WEBHOOK_BODY_BYTES = 5_000_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Nothing here is ever cacheable, and an intermediary that cached a worklist would serve one
      // session's answer to another.
      "cache-control": "no-store",
    },
  });
}

/** 1305: the callback's page. Not JSON -- a phone browser is the client. */
function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 1305: the 302 into Google's consent screen. The URL carries a state, never a secret. */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

function fail(code: ObApiErrorCode, status: number, message: string, served?: string[]): Response {
  const body: ObApiErrorBody = { error: served ? { code, message, served } : { code, message } };
  return json(body, status);
}

/**
 * The 401. IDENTICAL for a missing token and a wrong one (D5): telling the two apart tells an attacker
 * whether a guessed token was the right shape, and there is no caller for whom the distinction is useful.
 * `WWW-Authenticate` is the one thing it says, and it names the scheme, never the token or its file.
 */
function unauthorized(): Response {
  const body: ObApiErrorBody = { error: { code: "unauthorized", message: "a valid bearer token is required" } };
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": 'Bearer realm="ob"',
    },
  });
}

// --- validation ---------------------------------------------------------------------------------------
//
// Each endpoint validates its OWN inputs (D1). These are the primitives, and they all fail the same way:
// an `invalid_request` naming the field, never a coercion. `Boolean("0")` is true and `"10" >= 3` is
// false, so a value that arrives as the wrong type is refused rather than quietly reinterpreted.

function bad(message: string): never {
  throw new ApiFault("invalid_request", 400, message);
}

function asObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) bad("the request body must be a JSON object");
  return body as Record<string, unknown>;
}

function reqString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim().length === 0) bad(`'${key}' must be a non-empty string`);
  return (v as string).trim();
}

function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") bad(`'${key}' must be a string`);
  return v as string;
}

function optBool(o: Record<string, unknown>, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") bad(`'${key}' must be a boolean (true/false, not "0"/"1")`);
  return v as boolean;
}

function optStringArray(o: Record<string, unknown>, key: string): string[] | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.trim().length === 0)) {
    bad(`'${key}' must be an array of non-empty strings`);
  }
  return (v as string[]).map((s) => s.trim());
}

/** 1680: a draft's files, each `{ filename, mime?, data_base64 }`. Size and header safety are checked in gmail-draft. */
function optAttachments(o: Record<string, unknown>): GmailDraftAttachmentInput[] | undefined {
  const v = o.attachments;
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) bad("'attachments' must be an array of { filename, mime?, data_base64 }");
  return (v as unknown[]).map((raw, i) => {
    const a = asObject(raw);
    const where = `attachments[${i}]`;
    const filename = a.filename;
    const data = a.data_base64;
    if (typeof filename !== "string" || filename.trim().length === 0) bad(`'${where}.filename' must be a non-empty string`);
    if (typeof data !== "string") bad(`'${where}.data_base64' must be a base64 string`);
    return { filename: filename as string, mime: optString(a, "mime"), data_base64: data as string };
  });
}

/** A required positive integer: a spinoff row id (360). A numeric STRING is refused, never coerced. */
function reqPositiveInt(o: Record<string, unknown>, key: string): number {
  const v = optPositiveInt(o, key);
  if (v === undefined) bad(`'${key}' must be a positive integer`);
  return v;
}

/**
 * The token totals a `land` records (360). Every field is a non-negative NUMBER and a missing one is 0,
 * because a transcript that could not be read is honestly zero rather than absent -- but a string is
 * refused, since these go straight into stored integer columns and `"0"` there is a wrong number later.
 */
function tokenUsageFrom(o: Record<string, unknown>, key: string): TokenUsage {
  const raw = o[key];
  if (raw === undefined || raw === null) return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };
  const obj = raw as Record<string, unknown>;
  if (typeof raw !== "object" || Array.isArray(raw)) bad(`'${key}' must be an object of token counts`);
  const count = (field: string): number => {
    const v = obj[field];
    if (v === undefined || v === null) return 0;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) bad(`'${key}.${field}' must be a non-negative number`);
    return v as number;
  };
  return {
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
    cacheCreationTokens: count("cacheCreationTokens"),
    cacheReadTokens: count("cacheReadTokens"),
    totalTokens: count("totalTokens"),
  };
}

/** OB-1993: `tokensById` on a close, `{ "<row id>": TokenUsage }`. Absent is an empty map (an older client). */
function tokensByIdFrom(o: Record<string, unknown>, key: string): Record<number, TokenUsage> {
  const raw = o[key];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) bad(`'${key}' must be an object of row id to token counts`);
  const out: Record<number, TokenUsage> = {};
  for (const [id, usage] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) bad(`'${key}' keys must be spinoff row ids`);
    out[n] = tokenUsageFrom({ usage }, "usage");
  }
  return out;
}

function optPositiveInt(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  // Deliberately NOT Number(v): a numeric STRING is the shape a client that forgot to type its request
  // sends, and accepting it here is how "10" ends up in arithmetic somewhere further down.
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) bad(`'${key}' must be a positive integer`);
  return v as number;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], key: string): T {
  if (!(allowed as readonly string[]).includes(value)) bad(`'${key}' must be one of ${allowed.join("|")}`);
  return value as T;
}

async function readJson(req: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new ApiFault("invalid_request", 413, `request body exceeds ${maxBytes} bytes`);
  }
  const text = await req.text();
  if (text.length > maxBytes) {
    throw new ApiFault("invalid_request", 413, `request body exceeds ${maxBytes} bytes`);
  }
  if (text.trim().length === 0) return {};
  try {
    return asObject(JSON.parse(text));
  } catch (e) {
    if (e instanceof ApiFault) throw e;
    bad("the request body must be valid JSON");
  }
}

/** A positive integer query param. Absent is undefined; present-but-not-positive is a 400. */
function queryPositiveInt(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key)?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) bad(`'${key}' must be a positive integer`);
  return n;
}

/** `?open=true` etc. A query STRING is the one place a boolean legitimately arrives as text. */
function queryBool(params: URLSearchParams, key: string): boolean | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  bad(`'${key}' must be true or false`);
}

/** A positive integer path segment (`/transactions/12/splits`). Anything else is a 400, never a coerced guess. */
function pathPositiveInt(segment: string | undefined, key: string): number {
  const n = Number(segment);
  if (segment === undefined || !/^\d+$/.test(segment) || !Number.isSafeInteger(n) || n <= 0) bad(`'${key}' must be a positive integer`);
  return n;
}

/** An integer that may be null (clears a nullable column) or absent (leaves it alone). Returns undefined when absent. */
function optNullableInt(o: Record<string, unknown>, key: string): number | null | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) bad(`'${key}' must be an integer or null`);
  return v as number;
}

function optNullableString(o: Record<string, unknown>, key: string): string | null | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") bad(`'${key}' must be a string or null`);
  return v as string;
}

function optInt(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) bad(`'${key}' must be an integer`);
  return v as number;
}

function itemQueryFrom(params: URLSearchParams): ItemQuery {
  const query: ItemQuery = {};
  const open = queryBool(params, "open");
  if (open !== undefined) query.open = open;
  for (const key of ["status", "type", "project", "team", "tag", "kind", "since"] as const) {
    const v = params.get(key)?.trim();
    if (v) query[key] = v;
  }
  const updatedAfter = params.get("updated_after")?.trim();
  if (updatedAfter) query.updatedAfter = updatedAfter;
  const priority = params.get("priority")?.trim();
  if (priority) {
    const parsed = parsePriority(priority);
    if (parsed === null) bad(`'priority' must be one of ${PRIORITY_OPTIONS}`);
    query.priority = parsed;
  }
  const by = params.get("by")?.trim();
  if (by) query.by = oneOf<ItemSort>(by, ["priority", "created", "updated"], "by");
  const limit = params.get("limit")?.trim();
  if (limit) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 0) bad(`'limit' must be a non-negative integer`);
    query.limit = n;
  }
  return query;
}

// --- OB-2276: the GitHub webhook ----------------------------------------------------------------------

/**
 * The body as text, read in chunks and abandoned the moment it passes `max` bytes, so a chunked body with no
 * content-length cannot make this unauthenticated route buffer more than the cap. Null when it is over.
 */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Receive one GitHub delivery. The signature is checked before anything is recorded; a good one answers at once
 * (GitHub gives a hook 10 seconds) and a red or green run on main is acted on after the answer, through
 * `deps.ci.defer`. A failure there is reported and leaves no notice row, so the hourly catch-up retries it.
 */
async function githubWebhook(store: Store, req: Request, deps: ObApiDeps): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_WEBHOOK_BODY_BYTES) return fail("invalid_request", 413, `a webhook body over ${MAX_WEBHOOK_BODY_BYTES} bytes is refused unread`);
  const body = await readCapped(req, MAX_WEBHOOK_BODY_BYTES);
  if (body === null) return fail("invalid_request", 413, `a webhook body over ${MAX_WEBHOOK_BODY_BYTES} bytes is refused`);
  const result = await receiveWebhook(
    store,
    {
      event: req.headers.get("x-github-event"),
      delivery: req.headers.get("x-github-delivery"),
      signature: req.headers.get("x-hub-signature-256"),
      body,
    },
    await h.webhookSecret(store, deps.secrets),
  );
  const run = result.run;
  if (run) {
    const work = async () => {
      const outcome = await handleRun(store, run, h.ciDeps(store, deps.secrets, deps.ci));
      if (outcome.action === "failed") reportError(new Error(`ci main notice failed for ${run.repo} run ${run.runId}: ${outcome.reason}`), { daemon: "omnislash-web", route: "github-webhook" });
    };
    const defer = deps.ci?.defer ?? ((w: () => Promise<void>) => void w().catch((e) => reportError(e, { daemon: "omnislash-web", route: "github-webhook" })));
    defer(work);
  }
  return json(result.body, result.status);
}

// --- dispatch -----------------------------------------------------------------------------------------

/**
 * Build the API's fetch handler.
 *
 * It answers EVERY request under the prefix, including the ones it does not serve: an unknown path gets a
 * 404 that LISTS what is served (D1's "refuse by name"), so a client that has drifted finds out from the
 * server rather than from a silent empty result.
 */
export function createObApi(deps: ObApiDeps): (req: Request) => Promise<Response> {
  // 1305: the mint routes and the callback must share one state store or every callback would read as "not
  // minted by this server". In production it is the state file under a flock, shared across processes (OB-1935).
  const googleStates = deps.googleHosted?.states ?? createGoogleStateStore(STATE_TTL_MS, GOOGLE_OAUTH_STATE_FILE);
  return async function obApiFetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // 1. AUTH, before anything else looks at the request.
    const load = deps.token();
    if (load.token === null) {
      // Not configured (or misconfigured) is a 503, not a 401: this is the SERVER's problem, and a client
      // told "unauthorized" would go looking for its own token. The message names the path and the fix and
      // never the token, because there is no token to name.
      return fail("api_disabled", 503, load.message ?? "the ob API is not configured on this host");
    }
    // 1305: the two hosted-Google browser routes are the ONE exception, and it is deliberate: a phone's
    // browser cannot send a bearer token, and a 401 here is a flow a phone can never complete. They are
    // guarded by the one-time state instead (see isGoogleBrowserPath). Everything else still authenticates.
    const browserRoute = isGoogleBrowserPath(url.pathname, req.method) || isGithubWebhookPath(url.pathname, req.method);
    if (!browserRoute && !tokenMatches(bearerFrom(req), load.token)) return unauthorized();

    // 2. Route.
    const rest = url.pathname.slice(OB_API_PREFIX.length).replace(/\/+$/, "");
    const method = req.method.toUpperCase();

    try {
      // decodeURIComponent THROWS on a malformed escape (`/leases/%`), so it is inside the try: outside
      // it the rejection would escape this handler entirely and the host would answer with a bare 500
      // carrying none of our error shape. A lease resource is percent-encoded, so this is a live path.
      let segments: string[];
      try {
        segments = rest.split("/").filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
      } catch {
        throw new ApiFault("invalid_request", 400, `the path ${url.pathname} is not valid percent-encoding`);
      }
      // 1616: the store call has no timeout of its own (a leaked pool slot waits forever), so the request
      // does. The 504 names the call and the budget instead of the connection sitting open for 43 minutes.
      const response = await withDeadline(`${method} ${url.pathname}`, apiTimeoutFor(rest, deps.requestTimeoutMs ?? API_REQUEST_TIMEOUT_MS), async () =>
        route(await deps.store(), req, url, method, segments, deps, googleStates),
      );
      if (response) return response;
      // A local-only command (map D3) refuses BY NAME with its reason rather than as a generic miss, so a
      // client that tried to route one here is told it asked the wrong machine, not that it typo'd.
      const localOnly = segments[0] !== undefined ? OB_API_LOCAL_ONLY[segments[0]] : undefined;
      if (localOnly) {
        return fail(
          "unknown_endpoint",
          404,
          `'${segments[0]}' is a LOCAL-ONLY command and is deliberately not served: it ${localOnly}. Run it on the machine in front of you.`,
          describeRoutes(),
        );
      }
      return fail(
        "unknown_endpoint",
        404,
        `${method} ${url.pathname} is not served by the ob API`,
        describeRoutes(),
      );
    } catch (e) {
      if (e instanceof CallTimeoutError) {
        reportError(e, { daemon: "omnislash-web", route: "ob-api" }); // a stalled store is a server fault
        return fail("timeout", 504, `the ob API did not finish ${e.call} within ${e.ms}ms (the store may be stalled)`);
      }
      if (e instanceof ApiFault) {
        if (e.status >= 500) reportError(e, { daemon: "omnislash-web", route: "ob-api" });
        return fail(e.code, e.status, e.message);
      }
      // A UsageError is the domain saying the REQUEST was wrong (an illegal transition, a bad state
      // name); an AppError is it saying the request was refused. Both are the client's business and both
      // carry a written message; anything else is ours, and only its message crosses the wire.
      if (e instanceof UsageError) return fail("invalid_request", 400, e.message);
      if (e instanceof AppError) return fail("refused", 409, e.message);
      // ob 1657: this catch-all keeps the error from `Bun.serve`, so the server faults (5xx) are reported here; a no-op unless Sentry is on.
      reportError(e, { daemon: "omnislash-web", route: "ob-api" });
      return fail("internal", 500, e instanceof Error ? e.message : String(e));
    }
  };
}

/** Returns null when nothing matched, so the caller can render the self-documenting 404. */
async function route(
  store: Store,
  req: Request,
  url: URL,
  method: string,
  segments: string[],
  deps: ObApiDeps,
  googleStates: GoogleStateStore,
): Promise<Response | null> {
  const [head, second, third] = segments;

  if (head === "health" && segments.length === 1 && method === "GET") {
    return json(await h.health(store));
  }

  if (head === "config" && segments.length === 1) {
    if (method === "GET") {
      const key = url.searchParams.get("key")?.trim() ?? null;
      return json(await h.configRead(store, key));
    }
    if (method === "POST") {
      const body = await readJson(req);
      return json(await h.configSet(store, { key: reqString(body, "key"), value: body.value === null ? null : reqString(body, "value") }));
    }
    return null;
  }

  if (head === "issues") {
    if (segments.length === 1 && method === "GET") {
      return json(await h.issueLinks(store));
    }
    if (second === "link" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.issueLink(store, {
          item_id: reqString(body, "item_id"),
          number: reqPositiveInt(body, "number"),
          repo: optString(body, "repo") ?? null,
        }),
      );
    }
    if (second === "unlink" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.issueUnlink(store, { item_id: reqString(body, "item_id") }));
    }
    if (second === "pairing" && segments.length === 2 && method === "GET") {
      return json(await h.issuePairing(store));
    }
    if (second === "github" && segments.length === 2 && method === "GET") {
      return json(await h.githubIssues(store));
    }
    if (second === "reconcile" && segments.length === 2 && method === "GET") {
      const raw = url.searchParams.get("limit");
      let limit = 25;
      if (raw !== null && raw !== "") {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) bad(`'limit' must be a positive number`);
        limit = n;
      }
      return json(await h.issueReconcile(store, limit));
    }
    return null;
  }

  if (head === "triage") {
    if (segments.length === 1 && method === "GET") {
      return json(await h.triageInbox(store));
    }
    // The id travels in the path like every other item id, not like a secret name (357): it is not
    // itself a credential, and `/items/:id/close` set the same precedent.
    if (second !== undefined && segments.length === 3 && method === "POST") {
      if (third === "clear") return json(await h.triageClear(store, second));
      if (third === "reject") return json(await h.triageReject(store, second));
      return null;
    }
    return null;
  }

  if (head === "next" && segments.length === 1 && method === "GET") {
    return json(await h.next(store, url.searchParams.get("project") ?? undefined));
  }

  if (head === "items") {
    if (segments.length === 1 && method === "GET") {
      return json(await h.items(store, itemQueryFrom(url.searchParams)));
    }
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(req);
      const priorityRaw = optString(body, "priority");
      let priorityValue: number | null = null;
      if (priorityRaw !== undefined && priorityRaw.trim() !== "") {
        const parsed = parsePriority(priorityRaw);
        if (parsed === null) bad(`'priority' must be one of ${PRIORITY_OPTIONS}`);
        priorityValue = parsed;
      }
      // The same two refusals `ob add` makes. The status one matters more here than in the CLI, which
      // has no `--status` at all: item.status is free TEXT in the schema, so an unvalidated value would
      // be stored happily and then match no filter, no vocabulary and no transition.
      const type = reqString(body, "type");
      if (!VALID_TYPES.includes(type)) bad(`'type' must be one of ${VALID_TYPES.join("|")}`);
      const status = optString(body, "status");
      if (status !== undefined && !isValidStatus(status, type, null)) {
        bad(`'status' must be one of ${statusVocab(type, null).join("|")} for a ${type}`);
      }
      return json(
        await h.create(store, {
          type,
          title: reqString(body, "title"),
          body: optString(body, "body") ?? null,
          status,
          project: optString(body, "project") ?? null,
          tags: optStringArray(body, "tags"),
          triage: optBool(body, "triage"),
          origin_repo: optString(body, "origin_repo") ?? null,
          issue: optBool(body, "issue"),
          map: optString(body, "map") ?? null,
          exec: optString(body, "exec") ?? null,
          link_url: optString(body, "link_url") ?? null,
          priorityValue,
        }),
        201,
      );
    }
    if (second !== undefined && segments.length === 2 && method === "GET") {
      return json(await h.item(store, second));
    }
    if (second !== undefined && segments.length === 2 && method === "DELETE") {
      return json(await h.remove(store, second));
    }
    if (second !== undefined && segments.length === 3) {
      if (third === "close" && method === "POST") {
        const body = await readJson(req);
        return json(
          await h.close(store, second, {
            github: optBool(body, "github"),
            note: optString(body, "note"),
            actor: optString(body, "actor"),
            tokensById: tokensByIdFrom(body, "tokensById"),
          }),
        );
      }
      if (third === "reopen" && method === "POST") {
        const body = await readJson(req);
        return json(await h.reopen(store, second, { github: optBool(body, "github"), note: optString(body, "note"), actor: optString(body, "actor") }));
      }
      if (third === "state" && method === "POST") {
        const body = await readJson(req);
        const action = oneOf<ObApiStateAction>(reqString(body, "action"), OB_API_STATE_ACTIONS, "action");
        return json(
          await h.state(store, second, {
            action,
            reason: optString(body, "reason"),
            owner: optString(body, "owner"),
            status: optString(body, "status"),
            note: optString(body, "note"),
            actor: optString(body, "actor"),
          }),
        );
      }
      if (third === "transition" && method === "POST") {
        const body = await readJson(req);
        return json(
          await h.transition(store, second, {
            action: oneOf<ObApiTransitionAction>(reqString(body, "action"), OB_API_TRANSITION_ACTIONS, "action"),
            reason: optString(body, "reason"),
            owner: optString(body, "owner"),
            github: optBool(body, "github"),
            note: optString(body, "note"),
            actor: optString(body, "actor"),
          }),
        );
      }
      if (third === "rank" && method === "POST") {
        const body = await readJson(req);
        const rankRaw = body.rank;
        let rank: number | undefined;
        if (rankRaw !== undefined && rankRaw !== null) {
          if (typeof rankRaw !== "number" || !Number.isInteger(rankRaw)) bad(`'rank' must be an integer`);
          rank = rankRaw as number;
        }
        return json(await h.rank(store, second, { rank, clear: optBool(body, "clear") === true }));
      }
      if (third === "order" && method === "POST") {
        const body = await readJson(req);
        return json(
          await h.order(store, second, {
            top: optBool(body, "top"),
            before: optString(body, "before"),
            after: optString(body, "after"),
            priority: optString(body, "priority"),
          }),
        );
      }
      if (third === "notes" && method === "POST") {
        const body = await readJson(req);
        return json(await h.note(store, second, { text: reqString(body, "text") }));
      }
      if (third === "tags" && method === "POST") {
        const body = await readJson(req);
        const add = optStringArray(body, "add");
        const remove = optStringArray(body, "remove");
        if (!add?.length && !remove?.length) bad("give at least one of 'add' or 'remove'");
        return json(await h.tags(store, second, { add, remove }));
      }
      if (third === "links" && method === "POST") {
        const body = await readJson(req);
        return json(await h.itemLink(store, second, { rel: reqString(body, "rel"), to: reqString(body, "to") }));
      }
      if (third === "edit" && method === "POST") {
        const body = await readJson(req);
        const priorityRaw = optString(body, "priority");
        let priorityValue: number | null | undefined;
        if (priorityRaw !== undefined) {
          if (priorityRaw.trim() === "") priorityValue = null;
          else {
            const parsed = parsePriority(priorityRaw);
            if (parsed === null) bad(`'priority' must be one of ${PRIORITY_OPTIONS}`);
            priorityValue = parsed;
          }
        }
        return json(
          await h.edit(store, second, {
            title: optString(body, "title"),
            body: optString(body, "body"),
            project: optString(body, "project") ?? undefined,
            priorityValue,
          }),
        );
      }
    }
    return null;
  }

  if (head === "today" && segments.length === 1 && method === "POST") {
    const body = await readJson(req);
    const rankRaw = body.rank;
    let rank: number | undefined;
    if (rankRaw !== undefined && rankRaw !== null) {
      if (typeof rankRaw !== "number" || !Number.isInteger(rankRaw)) bad(`'rank' must be an integer`);
      rank = rankRaw as number;
    }
    return json(await h.today(store, { id: optString(body, "id") ?? null, rank, clear: optBool(body, "clear") === true }));
  }

  if (head === "focus" && segments.length === 1) {
    if (method === "GET") return json(await h.focusRead(store));
    if (method === "POST") {
      const body = await readJson(req);
      return json(await h.focusSet(store, { project: optString(body, "project") ?? null, clear: optBool(body, "clear") === true }));
    }
    return null;
  }

  if (head === "whatsapp") {
    if (second === "search" && segments.length === 2 && method === "GET") {
      const q = url.searchParams.get("q")?.trim() ?? "";
      if (!q) bad("'q' is required");
      const limit = queryPositiveInt(url.searchParams, "limit");
      return json(await h.whatsappSearch(store, { q, limit }));
    }
    if (second === "recent" && segments.length === 2 && method === "GET") {
      const limit = queryPositiveInt(url.searchParams, "limit");
      const since = url.searchParams.get("since")?.trim() || undefined;
      return json(await h.whatsappRecent(store, { limit, since }));
    }
    // OB-1765: the native WhatsApp screen's reads (Status tray + history, the chat list). Read-only.
    if (second === "status" && segments.length === 2 && method === "GET") {
      const limit = queryPositiveInt(url.searchParams, "limit");
      const before = url.searchParams.get("before")?.trim() || undefined;
      if (before && !Number.isFinite(Date.parse(before))) bad("'before' must be an ISO timestamp");
      const sender = url.searchParams.get("sender")?.trim() || undefined;
      return json(await h.whatsappStatus(store, { limit, before, sender }));
    }
    if (second === "chats" && segments.length === 2 && method === "GET") {
      const limit = queryPositiveInt(url.searchParams, "limit");
      return json(await h.whatsappChats(store, { limit, hidden: queryBool(url.searchParams, "hidden") }));
    }
    // OB-1809: the rest of `ob whatsapp`. The cap is the draft one: a base64 attachment is not a small JSON body.
    if (second === "send" && segments.length === 2 && method === "POST") {
      const body = await readJson(req, MAX_DRAFT_BODY_BYTES);
      const file = body.file === undefined || body.file === null ? undefined : asObject(body.file);
      return json(
        await h.whatsappSend(
          store,
          {
            to: reqString(body, "to"),
            body: optString(body, "body") ?? "",
            confirm: body.confirm === true,
            file: file && { name: reqString(file, "name"), data_base64: reqString(file, "data_base64") },
            ...(body.resend === true ? { resend: true } : {}),
          },
          deps.whatsappSend,
        ),
      );
    }
    if (second === "prefs") {
      if (segments.length === 2 && method === "POST") {
        const body = await readJson(req);
        return json(
          await h.whatsappPref(store, {
            chat_jid: reqString(body, "chat_jid"),
            action: oneOf(reqString(body, "action"), WHATSAPP_PREF_ACTIONS, "action"),
          }),
        );
      }
      if (segments.length === 3 && method === "GET" && (segments[2] === "hidden" || segments[2] === "favorites")) {
        return json(await h.whatsappPrefChats(store, segments[2]));
      }
    }
    return null;
  }

  if (head === "gmail") {
    if (second === "search" && segments.length === 2 && method === "GET") {
      const q = url.searchParams.get("q")?.trim() ?? "";
      if (!q) bad("'q' is required");
      const limit = queryPositiveInt(url.searchParams, "limit");
      return json(await h.gmailSearch(store, { q, limit }));
    }
    if (second === "list" && segments.length === 2 && method === "GET") {
      const limit = queryPositiveInt(url.searchParams, "limit");
      const since = url.searchParams.get("since")?.trim() || undefined;
      return json(await h.gmailList(store, { limit, since }));
    }
    if (second === "sync" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.gmailSync(
          store,
          {
            backfill: optBool(body, "backfill"),
            query: optString(body, "query"),
            days: optPositiveInt(body, "days"),
            since: optString(body, "since"),
            max: optPositiveInt(body, "max"),
          },
          deps.google,
        ),
      );
    }
    // 1757: drafts. Create never sends; send needs `confirm: true` in the body and an EXISTING draft id.
    if (second === "messages" && segments.length === 3 && method === "GET") {
      return json(await h.gmailMessageRead(store, segments[2]!, deps.gmailDrafts));
    }
    if (second === "messages" && segments.length === 4 && segments[3] === "attachments" && method === "GET") {
      const name = url.searchParams.get("name") ?? undefined;
      return json(await h.gmailMessageAttachments(store, segments[2]!, name, deps.gmailDrafts));
    }
    if (second === "drafts" && segments.length === 2 && method === "POST") {
      const body = await readJson(req, MAX_DRAFT_BODY_BYTES);
      return json(
        await h.gmailDraftCreate(
          store,
          {
            to: reqString(body, "to"),
            subject: optString(body, "subject"),
            body: optString(body, "body") ?? "", // not trimmed: the text is the human's, as written
            cc: optString(body, "cc"),
            from: optString(body, "from"),
            reply_to: optString(body, "reply_to"),
            attachments: optAttachments(body),
          },
          deps.gmailDrafts,
        ),
      );
    }
    // OB-1750: list, edit in place, delete (needs ?confirm=true). None of them sends.
    if (second === "drafts" && segments.length === 2 && method === "GET") {
      return json(await h.gmailDraftList(store, queryPositiveInt(url.searchParams, "limit"), deps.gmailDrafts));
    }
    if (second === "drafts" && segments.length === 4 && segments[3] === "edit" && method === "POST") {
      const body = await readJson(req, MAX_DRAFT_BODY_BYTES);
      return json(
        await h.gmailDraftEdit(
          store,
          segments[2]!,
          {
            to: optString(body, "to"),
            from: optString(body, "from"),
            cc: optString(body, "cc"),
            subject: optString(body, "subject"),
            body: optString(body, "body"),
            attachments: optAttachments(body),
          },
          deps.gmailDrafts,
        ),
      );
    }
    if (second === "drafts" && segments.length === 3 && method === "DELETE") {
      return json(await h.gmailDraftDelete(store, segments[2]!, url.searchParams.get("confirm") === "true", deps.gmailDrafts));
    }
    if (second === "drafts" && segments.length === 3 && method === "GET") {
      return json(await h.gmailDraftShow(store, segments[2]!, deps.gmailDrafts));
    }
    if (second === "drafts" && segments.length === 4 && segments[3] === "send" && method === "POST") {
      const body = await readJson(req);
      // OB-1910: a send names the hash of the draft the human read; missing or not a string is a 400 before Gmail.
      const hash = reqString(body, "hash");
      return json(await h.gmailSendDraft(store, segments[2]!, optBool(body, "confirm") === true, hash, deps.gmailDrafts));
    }
    return null;
  }

  if (head === "cal") {
    if (second === "agenda" && segments.length === 2 && method === "GET") {
      return json(await h.calAgenda(store));
    }
    if (second === "sync" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.calSync(
          store,
          {
            backfill: optBool(body, "backfill"),
            since: optString(body, "since"),
            max: optPositiveInt(body, "max"),
          },
          deps.google,
        ),
      );
    }
    return null;
  }

  if (head === "google") {
    if (segments.length !== 2) return null;
    const hostedDeps: h.GoogleHostedDeps = {
      states: googleStates,
      exchange: deps.googleHosted?.exchange,
      now: deps.googleHosted?.now,
      secrets: deps.secrets,
    };
    // GET /google/auth: the browser entry point (no bearer). It RESUMES a state minted by `auth-url` —
    // it never mints one, because an unauthenticated mint would let anyone on this host start a flow and
    // overwrite the stored token with their own account.
    if (second === "auth" && method === "GET") {
      const resumed = await h.googleAuthRedirect(store, url.searchParams.get("state"), hostedDeps);
      if (resumed.ok) return redirect(resumed.url);
      return html(hostedCallbackPage({ reason: resumed.reason }), 400);
    }
    // GET /google/callback: the browser return (no bearer). Burns the state, then exchanges and stores.
    if (second === "callback" && method === "GET") {
      const outcome = await h.googleCallback(
        store,
        {
          state: url.searchParams.get("state"),
          code: url.searchParams.get("code"),
          error: url.searchParams.get("error"),
        },
        hostedDeps,
      );
      if (outcome.ok) return html(hostedCallbackPage({ refreshToken: outcome.refreshToken }));
      return html(hostedCallbackPage({ reason: outcome.reason }), 400);
    }
    // POST /google/auth-url: authenticated (bearer), the mint `ob google auth-url` calls.
    if (second === "auth-url" && method === "POST") {
      return json(await h.googleAuthStart(store, await h.googleRedirectUri(store, req, url), hostedDeps));
    }
    return null;
  }

  if (head === "search" && segments.length === 1 && method === "GET") {
    const q = url.searchParams.get("q")?.trim() ?? "";
    if (!q) bad("'q' is required");
    return json(await h.search(store, q));
  }

  if (head === "status" && segments.length === 1 && method === "GET") {
    return json(await h.status(store));
  }

  if (head === "agents") {
    if (segments.length === 1 && method === "GET") {
      return json(await h.agents(store, queryBool(url.searchParams, "all") === true));
    }
    if (second === "reset" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.agentsReset(store, optBool(body, "dry_run") === true));
    }
    if (second === "active" && segments.length === 2 && method === "GET") {
      const raw = url.searchParams.get("within_min")?.trim();
      let withinMin = DEFAULT_ACTIVE_WITHIN_MIN;
      if (raw) {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) bad("'within_min' must be a positive number of minutes");
        withinMin = n;
      }
      return json(await h.agentActive(store, withinMin));
    }
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(req);
      const action = oneOf<ObApiAgentAction>(reqString(body, "action"), OB_API_AGENT_ACTIONS, "action");
      const rawStatus = optString(body, "status");
      const status = rawStatus === undefined ? undefined : parseAgentStatus(rawStatus);
      if (rawStatus !== undefined && !status) {
        bad(`'status' must be one of ${AGENT_STATUSES.join("|")}`);
      }
      if (action === "set-run" && optString(body, "run") === undefined) bad("'run' is required for action set-run");
      const request: AgentRequest = {
        action,
        id: reqString(body, "id"),
        ticket: optString(body, "ticket") ?? null,
        worktree: optString(body, "worktree") ?? null,
        branch: optString(body, "branch") ?? null,
        status: status ?? null,
        // 1189: T3's run word, written only by the run-state mirror. Deliberately not enum-checked HERE:
        // the one writer reads it off T3's own thread (and skips a status this build does not know), while
        // ob's `--status` gate above is what keeps the agent's own vocabulary to the five.
        run: optString(body, "run") ?? null,
        note: optString(body, "note") ?? null,
        launcher: optString(body, "launcher") ?? null,
        session_id: optString(body, "session_id") ?? null,
        ttl_s: optPositiveInt(body, "ttl_s"),
        no_lease: optBool(body, "no_lease"),
        holder: optString(body, "holder") ?? null,
      };
      return json(await h.agent(store, request));
    }
    return null;
  }

  if (head === "leases") {
    if (segments.length === 1 && method === "GET") {
      return json(await h.leases(store));
    }
    if (second === "sweep" && segments.length === 2 && method === "POST") {
      return json(await h.sweepLeases(store));
    }
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(req);
      const request: AcquireLeaseRequest = {
        resource: normalizeLeaseResource(reqString(body, "resource")),
        holder: reqString(body, "holder"),
        ttl_s: optPositiveInt(body, "ttl_s") ?? DEFAULT_LEASE_TTL_S,
        heartbeat: optBool(body, "heartbeat"),
      };
      return json(await h.acquire(store, request));
    }
    if (second !== undefined && segments.length === 2 && method === "DELETE") {
      const holder = url.searchParams.get("holder")?.trim();
      if (!holder) bad("'holder' is required");
      // `force` is the only way past a LIVE foreign holder and it stays explicit, here as in the CLI.
      const force = queryBool(url.searchParams, "force") === true;
      return json(await h.release(store, normalizeLeaseResource(second), holder, force));
    }
    return null;
  }

  // The secret endpoints (357). EVERY request that names ONE secret is a POST carrying that name in the
  // BODY. Never a path segment, never a query parameter.
  //
  // The secret name never goes in the URL, because a URL can be logged. A url
  // is logged in places a body is not -- Cloudflare's own request logging, any proxy in front, an access
  // log the host keeps. A NAME is not as sensitive as a value, but it tells an attacker exactly what
  // exists and what to go after, and it persists in those logs long after the request is over.
  //
  // Checked rather than assumed on the host side (apps/dashboard/serve.ts): the dashboard logs one line
  // at startup and nothing per request, and an API path is answered HERE before the static layer and
  // before SSR, so no other handler sees the request at all. If a request logger is ever added there,
  // this decision is undone by it and the body must stay out of it.
  //
  // `GET /secrets` is the sole GET, and it names nothing -- it takes no argument and asks for the list.
  if (head === "secrets") {
    if (segments.length === 1 && method === "GET") {
      return json(await h.secrets(store));
    }
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(req);
      // `value` goes through reqString like every other field, so an empty or non-string value is refused
      // by NAME. It is the one validation message in this file that must never quote what it rejected.
      return json(
        await h.setSecretValue(
          store,
          { name: reqString(body, "name"), value: reqString(body, "value") },
          deps.secrets,
        ),
      );
    }
    if (second === "read" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.readSecret(store, { name: reqString(body, "name") }, deps.secrets));
    }
    if (second === "remove" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.removeSecretByName(store, { name: reqString(body, "name") }));
    }
    return null;
  }

  // The spinoff queue (360). Every path here is the DATA half; the launch stays on the client. An id, a
  // holder and a branch travel in POST bodies rather than in the path, following 357's rule -- a url is
  // logged in Cloudflare's own request logging, in any proxy in front and in whatever the host keeps, none
  // of which this repo controls.
  if (head === "spinoffs") {
    if (segments.length === 1 && method === "GET") {
      const status = url.searchParams.get("status")?.trim();
      if (status && !(SPINOFF_STATUSES as readonly string[]).includes(status)) {
        bad(`'status' must be one of ${SPINOFF_STATUSES.join("|")}`);
      }
      return json(await h.spinoffs(store, { status: status || undefined }));
    }
    // 1226: the rows that SERVE one item, resolved on this host because it holds the store. A POST body,
    // like every other id on this route: a url is logged in Cloudflare's own request logging, in any proxy
    // in front and in whatever the host keeps.
    if (second === "serving" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.spinoffServing(store, { item_id: reqString(body, "item_id") }));
    }
    // OB-1825: the measure-twice verdict is computed and recorded here; the client only read the inputs.
    if (second === "check" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      // OB-2131: an older client still sends the bare yes; say what replaced it rather than dropping it into a no-go.
      if (body.questions_resolved !== undefined) {
        throw new UsageError("questions_resolved is replaced by resolutions (one entry per checker question): update ob on this client and pass --resolutions");
      }
      return json(
        await h.spinoffCheck(store, {
          ticket_ref: reqString(body, "ticket_ref"),
          architect: body.architect,
          checker: body.checker,
          resolutions: body.resolutions,
          actor: optString(body, "actor") ?? null,
        }),
      );
    }
    // OB-2131: the go check's planned files live on the trail, which `ob show --json` keeps from a client.
    if (second === "planned-files" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.spinoffPlannedFiles(store, { rows: Array.isArray(body.rows) ? (body.rows as SpinoffPlannedFilesRequest["rows"]) : [] }));
    }
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(req);
      const mode = oneOf<SpinoffMode>(reqString(body, "mode"), SPINOFF_MODES, "mode");
      const launcher = optString(body, "launcher")?.trim();
      // An unknown launcher is refused BY NAME, never defaulted: the flag exists to say WHERE this one
      // agent goes, and quietly sending it elsewhere is the failure it was added to prevent (#135).
      if (launcher) oneOf<LauncherName>(launcher, LAUNCHER_NAMES, "launcher");
      // 1480: an unknown tier is refused by name too — a guessed tier is a guessed model.
      const tier = optString(body, "tier")?.trim();
      if (tier) oneOf<SpinoffTier>(tier, SPINOFF_TIERS, "tier");
      // OB-1815: and an unknown effort level, by name.
      const effort = optString(body, "effort")?.trim();
      if (effort) oneOf<SpinoffEffort>(effort, SPINOFF_EFFORTS, "effort");
      return json(
        await h.enqueue(store, {
          ticket_ref: reqString(body, "ticket_ref"),
          repo: reqString(body, "repo"),
          branch: reqString(body, "branch"),
          worktree: optString(body, "worktree") ?? null,
          mode,
          brief: reqString(body, "brief"),
          launcher: launcher || null,
          tier: tier || null,
          effort: effort || null,
          note: optString(body, "note") ?? null,
          no_check: optString(body, "no_check") ?? null,
          no_flake_slot: optString(body, "no_flake_slot") ?? null,
          flake_box: typeof body.flake_box === "boolean" ? body.flake_box : null,
          actor: optString(body, "actor") ?? null,
          trial_leg: trialLegOf(optString(body, "trial_leg")),
          trial_model: optString(body, "trial_model")?.trim() || null,
        }),
        201,
      );
    }
    if (second === "config" && segments.length === 2 && method === "GET") {
      return json(await h.spinoffConfig(store));
    }
    if (second === "launchable" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.spinoffLaunchable(store, {
          holder: optString(body, "holder") ?? null,
          caller: optString(body, "caller") ?? null,
        }),
      );
    }
    if (second === "claim" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.spinoffClaim(store, {
          id: reqPositiveInt(body, "id"),
          holder: optString(body, "holder") ?? null,
        }),
      );
    }
    if (second === "stamp" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.spinoffStamp(store, {
          id: reqPositiveInt(body, "id"),
          outcome: oneOf<"launched" | "failed">(reqString(body, "outcome"), ["launched", "failed"], "outcome"),
          worktree: optString(body, "worktree") ?? null,
          base_sha: optString(body, "base_sha") ?? null,
          launcher: optString(body, "launcher") ?? null,
          session_id: optString(body, "session_id") ?? null,
          engine: optString(body, "engine") ?? null,
          // 1142: the T3 ids are CLIENT facts and this route is the only way they reach the row. Rebuilding
          // the request field by field silently dropped them, which left every row a t3 launch created with
          // null thread ids -- and settle-on-close, adoption and the cleanup guard all read those columns.
          t3_thread_id: optString(body, "t3_thread_id") ?? null,
          t3_run_id: optString(body, "t3_run_id") ?? null,
          model: optString(body, "model") ?? null,
          effort: optString(body, "effort") ?? null,
          raised: optBool(body, "raised") ?? false,
          error: optString(body, "error") ?? null,
        }),
      );
    }
    if (second === "land" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.spinoffLand(store, {
          id: reqPositiveInt(body, "id"),
          tokens: tokenUsageFrom(body, "tokens"),
          holder: optString(body, "holder") ?? null,
          caller: optString(body, "caller") ?? null,
        }),
      );
    }
    if (second === "tokens" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.spinoffTokens(store, { id: reqPositiveInt(body, "id"), tokens: tokenUsageFrom(body, "tokens") }));
    }
    if (second === "ready" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.spinoffReady(store, {
          id: body.id === undefined ? undefined : reqPositiveInt(body, "id"),
          ticket_ref: optString(body, "ticket_ref"),
          tier_fit: optString(body, "tier_fit") ?? null,
          tier_fit_why: optString(body, "tier_fit_why") ?? null,
          note: optString(body, "note") ?? null,
        }),
      );
    }
    if (second === "reopen" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.spinoffReopen(store, { id: reqPositiveInt(body, "id"), note: optString(body, "note") ?? "" }));
    }
    if (second === "sendback" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.spinoffSendBack(store, {
          id: reqPositiveInt(body, "id"),
          note: optString(body, "note") ?? "",
          restore: body.restore === true,
        }),
      );
    }
    if (second === "note-error" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      const outcome = body.outcome;
      if (outcome !== "sent" && outcome !== "failed") throw new ApiFault("invalid_request", 400, "a note-error request needs 'outcome' of sent or failed");
      return json(await h.spinoffNoteError(store, { id: reqPositiveInt(body, "id"), outcome, reason: optString(body, "reason") ?? null }));
    }
    if (second === "verdict" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.spinoffVerdict(store, {
          id: reqPositiveInt(body, "id"),
          verdict: optString(body, "verdict") ?? "",
          reason: optString(body, "reason") ?? null,
          gate: optString(body, "gate") ?? null,
        }),
      );
    }
    if (second === "trial" && segments.length === 2 && method === "POST") {
      // OB-1991: the body IS the operation; runTrialOp validates each field and refuses a bad one by name.
      const body = await readJson(req);
      if (typeof body.op !== "string") throw new ApiFault("invalid_request", 400, "a trial request needs a string 'op'");
      for (const k of ["ref", "label", "note", "notes", "forfeit", "reason", "ticket_ref", "repo"] as const) {
        if (body[k] !== undefined && body[k] !== null && typeof body[k] !== "string") throw new ApiFault("invalid_request", 400, `trial '${k}' must be a string`);
      }
      return json(await h.spinoffTrial(store, body as unknown as Parameters<typeof h.spinoffTrial>[1]));
    }
    if (second === "reclaim" && segments.length === 2 && method === "POST") {
      return json(await h.spinoffReclaim(store));
    }
    if (second === "cleanup-guard" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.spinoffCleanupGuard(store, {
          branch: optString(body, "branch") ?? null,
          path: optString(body, "path") ?? null,
          caller: optString(body, "caller") ?? null,
        }),
      );
    }
    return null;
  }

  if (head === "creds") {
    if (segments.length === 1 && method === "GET") {
      return json(await h.creds(store, deps.creds));
    }
    if (second === "check" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      const all = optBool(body, "all") === true;
      const name = optString(body, "name")?.trim();
      // One or the other, never both and never neither: `{}` would silently check nothing and answer 200
      // with an empty list, which reads exactly like "everything is fine".
      if (all && name) bad("give 'name' or 'all', not both");
      if (!all && !name) bad("give 'name' or 'all'");
      return json(await h.credsCheck(store, { name, all }, deps.creds));
    }
    return null;
  }

  // 416: already-servable store commands. Purpose-built endpoints, not POST /rpc.
  if (head === "projects" && segments.length === 1) {
    if (method === "GET") return json(await h.projects(store));
    if (method === "POST") {
      const body = await readJson(req);
      return json(await h.projectCreate(store, { name: reqString(body, "name"), kind: reqString(body, "kind"), remote: optString(body, "remote") ?? null, key: optString(body, "key") ?? null, icon: optString(body, "icon") ?? null, display_name: optString(body, "display_name") ?? null }), 201);
    }
    return null;
  }
  if (head === "projects" && second !== undefined) {
    if (segments.length === 3 && third === "edit" && method === "POST") {
      const body = await readJson(req);
      return json(await h.projectEdit(store, second, { remote: optString(body, "remote"), kind: optString(body, "kind"), key: optString(body, "key"), icon: optString(body, "icon"), display_name: optString(body, "display_name"), stage: optString(body, "stage") }));
    }
    if (segments.length === 3 && third === "rename" && method === "POST") {
      const body = await readJson(req);
      return json(await h.projectRename(store, second, reqString(body, "name")));
    }
    if (segments.length === 2 && method === "DELETE") {
      return json(await h.projectRemove(store, second, queryBool(url.searchParams, "force") === true));
    }
    return null;
  }

  // OB-2255: teams.
  if (head === "teams" && segments.length === 1) {
    if (method === "GET") return json(await h.teams(store));
    if (method === "POST") {
      const body = await readJson(req);
      const projects = optStringArray(body, "projects");
      return json(
        await h.teamCreate(store, {
          name: reqString(body, "name"),
          icon: optString(body, "icon") ?? null,
          display_name: optString(body, "display_name") ?? null,
          ...(projects ? { projects } : {}),
        }),
        201,
      );
    }
    return null;
  }
  // `POST /teams/leave` names no team (a project leaves whatever team it is in); a team's own POSTs are 3 segments.
  if (head === "teams" && second === "leave" && segments.length === 2 && method === "POST") {
    const body = await readJson(req);
    return json(await h.teamLeave(store, { projects: optStringArray(body, "projects") ?? [] }));
  }
  if (head === "teams" && second !== undefined) {
    if (segments.length === 2 && method === "GET") return json(await h.teamRead(store, second));
    if (segments.length === 3 && third === "edit" && method === "POST") {
      const body = await readJson(req);
      return json(await h.teamEdit(store, second, { icon: optString(body, "icon"), display_name: optString(body, "display_name") }));
    }
    if (segments.length === 3 && third === "join" && method === "POST") {
      const body = await readJson(req);
      return json(await h.teamJoin(store, second, { projects: optStringArray(body, "projects") ?? [] }));
    }
    if (segments.length === 2 && method === "DELETE") {
      return json(await h.teamRemove(store, second, queryBool(url.searchParams, "force") === true));
    }
    // A team role's inbox (`ob send`, `ob inbox`).
    if (third === "inbox") {
      if (segments.length === 3 && method === "POST") {
        const body = await readJson(req);
        const text = optString(body, "body");
        if (text === undefined || text.trim().length === 0) bad("'body' must be a non-empty string");
        const kind = optString(body, "kind");
        const res = await h.roleMessageSend(store, second, {
          role: reqString(body, "role"),
          from: reqString(body, "from"),
          ...(kind === undefined ? {} : { kind: kind as RoleMessageRequest["kind"] }),
          ref: optString(body, "ref") ?? null,
          body: text as string,
          client_key: optString(body, "client_key") ?? null,
        });
        return json(res, res.created ? 201 : 200);
      }
      if (segments.length === 3 && method === "GET") {
        return json(await h.roleMessagesList(store, second, url.searchParams.get("role"), queryBool(url.searchParams, "unread") !== false));
      }
      if (segments.length === 4 && segments[3] === "read" && method === "POST") {
        const body = await readJson(req);
        const ids = body.ids;
        if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => !Number.isInteger(x) || (x as number) <= 0)) bad("'ids' must be a non-empty array of positive integers");
        return json(await h.roleMessagesRead(store, second, { role: reqString(body, "role"), ids: ids as number[], by: reqString(body, "by") }));
      }
    }
    // A role's start brief and successor note (`ob role brief`, `ob role note`, OS-55).
    if (third === "brief" && segments.length === 3 && method === "GET") {
      return json(await h.roleBriefFacts(store, second, url.searchParams.get("role")));
    }
    if (third === "notes" && segments.length === 3 && method === "POST") {
      const body = await readJson(req);
      return json(await h.roleNoteWrite(store, second, { role: reqString(body, "role"), body: reqString(body, "body") }));
    }
    if (third === "runs" && segments.length === 5 && segments[4] === "note-shown" && method === "POST") {
      const id = Number(segments[3]);
      if (!Number.isInteger(id) || id <= 0) throw new ApiFault("invalid_request", 400, `run id '${segments[3]}' is not a positive integer`);
      return json(await h.roleNoteShown(store, second, id));
    }
    // Role runs (`ob role`).
    if (third === "runs") {
      if (segments.length === 3 && method === "GET") return json(await h.roleRunsOpen(store, second, url.searchParams.get("role")));
      if (segments.length === 3 && method === "POST") {
        const body = await readJson(req);
        const res = await h.roleRunMark(store, second, { role: reqString(body, "role"), t3_host: reqString(body, "t3_host") });
        return json(res, res.created ? 201 : 200);
      }
      if (segments.length === 4 && method === "POST") {
        const id = Number(segments[3]);
        if (!Number.isInteger(id) || id <= 0) throw new ApiFault("invalid_request", 400, `run id '${segments[3]}' is not a positive integer`);
        const body = await readJson(req);
        const threadId = optString(body, "thread_id");
        const itemCount = optNullableInt(body, "item_count");
        const lastActivity = optString(body, "last_activity_at");
        const endReason = optString(body, "end_reason");
        return json(
          await h.roleRunUpdate(store, second, id, {
            ...(threadId === undefined ? {} : { thread_id: threadId }),
            ...(itemCount === undefined ? {} : { item_count: itemCount }),
            ...(lastActivity === undefined ? {} : { last_activity_at: lastActivity }),
            ...(endReason === undefined ? {} : { end_reason: endReason }),
          }),
        );
      }
    }
    // OB-2257: a role thread's handoff for `ob t3 team restart`.
    if (third === "handoffs") {
      if (segments.length === 3 && method === "POST") {
        const body = await readJson(req);
        const from = optString(body, "from_thread_id");
        return json(await h.teamHandoffCreate(store, second, { role: reqString(body, "role"), body: reqString(body, "body"), ...(from ? { from_thread_id: from } : {}) }), 201);
      }
      if (segments.length === 4 && segments[3] === "latest" && method === "GET") {
        return json(
          await h.teamHandoffLatest(store, second, url.searchParams.get("role"), { from: url.searchParams.get("from"), createdBefore: url.searchParams.get("created_before") }),
        );
      }
      if (segments.length === 5 && segments[4] === "consume" && method === "POST") {
        const id = Number(segments[3]);
        if (!Number.isInteger(id) || id <= 0) throw new ApiFault("invalid_request", 400, `handoff id '${segments[3]}' is not a positive integer`);
        const body = await readJson(req);
        return json(await h.teamHandoffConsume(store, second, id, { new_thread_id: reqString(body, "new_thread_id") }));
      }
    }
    return null;
  }

  if (head === "brief" && segments.length === 1 && method === "GET") {
    const q = url.searchParams.get("q")?.trim() || null;
    const inFlight = queryBool(url.searchParams, "in_flight") === true;
    return json(await h.briefRead(store, q, inFlight));
  }

  if (head === "log" && segments.length === 1) {
    if (method === "GET") {
      const type = url.searchParams.get("type")?.trim() || undefined;
      const since = url.searchParams.get("since")?.trim() || undefined;
      return json(await h.logList(store, { type: type as never, since }));
    }
    if (method === "POST") {
      const body = await readJson(req);
      return json(
        await h.logCreate(store, {
          type: reqString(body, "type") as never,
          text: reqString(body, "text"),
          about: optString(body, "about") ?? null,
          item: optString(body, "item") ?? null,
        }),
        201,
      );
    }
    return null;
  }

  if (head === "jobs" && segments.length === 1 && method === "GET") {
    return json(await h.jobsRead(store));
  }

  // OB-1808: a host job answers at once; the child does the work and a client polls. Nothing here waits on it.
  if (head === "host-jobs") {
    if (segments.length === 1 && method === "POST") {
      return json({ job: startHostJob(parseHostJobRequest(await readJson(req)), deps.hostJobs) });
    }
    if (segments.length === 1 && method === "GET") return json({ jobs: listHostJobs(deps.hostJobs) });
    const id = segments[1];
    if (id !== undefined && segments.length === 2 && method === "GET") {
      const known = listHostJobs(deps.hostJobs).find((j) => j.id === id);
      if (!known) throw new ApiFault("not_found", 404, `no host job '${id}' on this host`);
      // Only a finished job carries output, so only then are the store's secrets read to scrub it.
      const values = known.status === "running" ? [] : await hostOutputSecretValues(store, deps.secrets?.masterKey);
      const token = deps.token().token;
      const job = readHostJob(id, token ? [token, ...values] : values, deps.hostJobs);
      if (!job) throw new ApiFault("not_found", 404, `no host job '${id}' on this host`);
      return json({ job });
    }
  }

  // OB-1808: the name is checked against the snapshot pattern before it reaches a path, so it cannot walk out.
  if (head === "db" && second === "snapshots" && segments.length === 3 && method === "GET") {
    const name = segments[2]!;
    if (parseSnapshotName(name) === null) throw new ApiFault("invalid_request", 400, `'${name}' is not a snapshot name`);
    const file = Bun.file(join(snapshotDirFor(hostSnapshotDir(deps.hostJobs)), name));
    if (!(await file.exists())) throw new ApiFault("not_found", 404, `no snapshot '${name}' on this host (ob db snapshot --list)`);
    return new Response(file, { headers: { "content-type": "application/octet-stream" } });
  }

  if (head === "deploys") {
    if (segments.length === 1 && method === "GET") return json(await h.deploysRead(store));
    if (second === "run" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await kickLiveDeploy(store, { sha: body.sha === undefined ? undefined : reqString(body, "sha") }, deps.deployKick));
    }
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.deployRecord(store, {
          target: reqString(body, "target"),
          host: reqString(body, "host"),
          unit: reqString(body, "unit"),
          sha: reqString(body, "sha"),
          at: optString(body, "at") ?? undefined,
          result: reqString(body, "result") as "ok" | "rolled-back" | "refused",
        }),
        201,
      );
    }
    return null;
  }

  if (head === "snapshot" && segments.length === 1 && method === "GET") return json(await h.snapshot(store));

  // OB-2276: the webhook receiver (no bearer: see isGithubWebhookPath), `ob ci main` and `ob github hooks`.
  if (head === "github") {
    if (second === "webhook" && segments.length === 2 && method === "POST") return githubWebhook(store, req, deps);
    if (second === "hooks" && segments.length === 2 && method === "GET") return json(await h.githubHooksRead(store, deps.secrets));
    if (second === "hooks" && segments.length === 2 && method === "POST") return json(await h.githubHooksApply(store, deps.secrets));
    return null;
  }
  if (head === "ci" && second === "main") {
    if (segments.length === 2 && method === "GET") {
      return json(await h.ciMainRead(store, url.searchParams.get("project")?.trim() || undefined, deps.secrets));
    }
    if (third === "notify" && segments.length === 3 && method === "POST") {
      const body = await readJson(req);
      return json(await h.ciMainNotifyRun(store, optString(body, "project")?.trim() || undefined, deps.secrets, deps.ci));
    }
    return null;
  }

  if (head === "alerts") {
    if (segments.length === 1 && method === "GET") return json(await h.alertsRead(store));
    if (second === "ack" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.alertsAck(store, { key: reqString(body, "key") }));
    }
    if (second === "snooze" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.alertsSnooze(store, { key: reqString(body, "key") }));
    }
    return null;
  }

  if (head === "docs") {
    if (segments.length === 1 && method === "GET") {
      return json(await h.docsList(store, url.searchParams.get("project")?.trim() || undefined));
    }
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.docCreateHandler(store, {
          title: reqString(body, "title"),
          project: reqString(body, "project"),
          // optString, not reqString: reqString trims, and a document's body is kept byte for byte.
          body: optString(body, "body") ?? bad("'body' must be a string"),
        }),
        201,
      );
    }
    if (second !== undefined && segments.length === 3 && segments[2] === "set" && method === "POST") {
      const body = await readJson(req);
      return json(await h.docSetHandler(store, second, { title: optString(body, "title"), body: optString(body, "body") }));
    }
    if (second !== undefined && segments.length === 2 && method === "GET") {
      return json(await h.docShow(store, second));
    }
    return null;
  }

  if (head === "decisions") {
    if (segments.length === 1 && method === "GET") {
      return json(await h.decisionsList(store, url.searchParams.get("status")?.trim() || undefined));
    }
    if (second === "supersede" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.decisionSupersede(store, { new_id: reqString(body, "new_id"), old_id: reqString(body, "old_id") }));
    }
    if (second !== undefined && segments.length === 2 && method === "GET") {
      return json(await h.decisionShow(store, second));
    }
    return null;
  }

  if (head === "learnings") {
    if (segments.length === 1 && method === "GET") {
      return json(await h.learningsList(store, url.searchParams.get("status")?.trim() || undefined));
    }
    if (second !== undefined && segments.length === 2 && method === "GET") {
      return json(await h.learningShow(store, second));
    }
    return null;
  }

  if (head === "roadmaps") {
    if (segments.length === 1 && method === "GET") return json(await h.roadmapsList(store));
    if (second !== undefined && segments.length === 2 && method === "GET") {
      return json(await h.roadmapShow(store, second));
    }
    if (second !== undefined && third === "members" && segments.length === 3 && method === "POST") {
      const body = await readJson(req);
      const position = optPositiveInt(body, "position");
      return json(await h.roadmapAddMember(store, second, { item_id: reqString(body, "item_id"), position }), 201);
    }
    return null;
  }

  if (head === "standup") {
    if (second === "latest" && segments.length === 2 && method === "GET") {
      return json(await h.standupLatest(store));
    }
    if (second === "save" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.standupSave(store, { md: reqString(body, "md"), date: optString(body, "date") }));
    }
    if (second === "set" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.standupSet(store, { md: reqString(body, "md"), date: optString(body, "date") }));
    }
    if (second === "posted" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.standupPosted(store, optString(body, "date")));
    }
    return null;
  }

  if (head === "slack" && second === "unread" && segments.length === 2 && method === "GET") {
    return json(await h.slackUnread(store, { limit: queryPositiveInt(url.searchParams, "limit") }));
  }

  // 456: remaining DATA commands.
  if (head === "people") {
    if (segments.length === 1 && method === "GET") return json(await h.peopleList(store));
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(req);
      return json(await h.peopleCreate(store, { real_name: reqString(body, "real_name"), fields: (body.fields as never) ?? {} }), 201);
    }
    if (second === "show" && segments.length === 2 && method === "GET") {
      const q = url.searchParams.get("q")?.trim() ?? "";
      if (!q) bad("'q' is required");
      return json(await h.peopleShow(store, q, queryBool(url.searchParams, "reveal") === true));
    }
    if (second === "set" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      const id = optPositiveInt(body, "id");
      if (!id) bad("'id' must be a positive integer");
      return json(await h.peopleSet(store, { id, fields: (body.fields as never) ?? {} }));
    }
    if (second === "rm" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      const id = optPositiveInt(body, "id");
      if (!id) bad("'id' must be a positive integer");
      return json(await h.peopleRm(store, { id }));
    }
    return null;
  }

  if (head === "whois" && segments.length === 1 && method === "GET") {
    const handle = url.searchParams.get("handle")?.trim() ?? "";
    if (!handle) bad("'handle' is required");
    return json(await h.whoisLookup(store, handle));
  }

  // OB-2271: persona tournaments. A match file arrives parsed, in the body; the core validates it.
  if (head === "tournaments") {
    if (segments.length === 1 && method === "GET") {
      return json(await h.tournamentList(store, { repo: url.searchParams.get("repo")?.trim() || undefined }));
    }
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.tournamentAdd(store, {
          subject: reqString(body, "subject"),
          repo: reqString(body, "repo"),
          criteria: optStringArray(body, "criteria") ?? [],
          ref: optNullableString(body, "ref") ?? null,
        }),
        201,
      );
    }
    if (second === undefined) return null;
    const id = Number(second);
    if (!Number.isInteger(id) || id <= 0) throw new ApiFault("invalid_request", 400, `tournament id '${second}' is not a positive integer`);
    if (segments.length === 2 && method === "GET") return json(await h.tournamentShow(store, id));
    if (segments.length === 3 && method === "POST") {
      const body = await readJson(req);
      if (third === "candidates") {
        return json(
          await h.tournamentCandidate(store, id, {
            key: reqString(body, "key"),
            label: optNullableString(body, "label") ?? null,
            images: optStringArray(body, "images") ?? null,
            revises: optNullableString(body, "revises") ?? null,
          }),
        );
      }
      if (third === "matches") {
        if (!("match" in body)) throw new ApiFault("invalid_request", 400, "'match' is required");
        return json(await h.tournamentRecord(store, id, { match: body.match, replace: body.replace === true }), 201);
      }
      if (third === "pick") {
        return json(await h.tournamentPick(store, id, { candidate: reqString(body, "candidate"), note: optNullableString(body, "note") ?? null }));
      }
    }
    return null;
  }

  // OB-2097: the overnight decision log. The project is always in the body (resolved on the caller's machine).
  if (head === "overnight" && segments.length === 2) {
    if (second === "start" && method === "POST") {
      const body = await readJson(req);
      return json(await h.overnightStart(store, { project: reqString(body, "project"), date: reqString(body, "date") }));
    }
    if (second === "decide" && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.overnightDecide(store, {
          // title, what and why are checked by the core, so a refusal reads the same as locally.
          title: optString(body, "title") ?? "",
          what: optString(body, "what") ?? "",
          why: optString(body, "why") ?? "",
          doubt: optNullableString(body, "doubt") ?? null,
          undo: optNullableString(body, "undo") ?? null,
          context: optNullableString(body, "context") ?? null,
          project: reqString(body, "project"),
          night: optNullableString(body, "night") ?? null,
        }),
      );
    }
    if (second === "summary" && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.overnightSummary(store, {
          project: reqString(body, "project"),
          date: optString(body, "date"),
          section: optString(body, "section") ?? "",
          line: optString(body, "line") ?? "",
        }),
      );
    }
    if (second === "show" && method === "POST") {
      const body = await readJson(req);
      return json(await h.overnightShow(store, { project: reqString(body, "project"), date: optString(body, "date") }));
    }
    if (second === "runs" && method === "GET") {
      return json(
        await h.overnightRuns(store, {
          project: url.searchParams.get("project")?.trim() || undefined,
          since: url.searchParams.get("since")?.trim() || undefined,
        }),
      );
    }
    return null;
  }

  if (head === "review-misses") {
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.reviewMissAdd(store, {
          pr: reqString(body, "pr"),
          class: reqString(body, "class"),
          finding: reqString(body, "finding"),
          scope: optString(body, "scope"),
        }),
        201,
      );
    }
    if (second === "top" && segments.length === 2 && method === "GET") {
      return json(
        await h.reviewMissTop(store, {
          scope: url.searchParams.get("scope")?.trim() || undefined,
          limit: queryPositiveInt(url.searchParams, "limit"),
        }),
      );
    }
    return null;
  }

  if (head === "cursors") {
    if (segments.length === 1 && method === "GET") {
      const skill = url.searchParams.get("skill")?.trim() ?? "";
      const key = url.searchParams.get("key")?.trim() ?? "";
      if (!skill || !key) bad("'skill' and 'key' are required");
      return json(await h.cursorGet(store, skill, key));
    }
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(req);
      return json(await h.cursorSet(store, { skill: reqString(body, "skill"), key: reqString(body, "key"), value: reqString(body, "value") }));
    }
    return null;
  }

  if (head === "test-users") {
    if (segments.length === 1 && method === "GET") {
      return json(
        await h.testUsersList(store, {
          role: url.searchParams.get("role")?.trim() || undefined,
          env: url.searchParams.get("env")?.trim() || undefined,
        }),
      );
    }
    if (segments.length === 1 && method === "POST") {
      const body = await readJson(req);
      return json(
        await h.testUserCreate(
          store,
          {
            label: reqString(body, "label"),
            value: reqString(body, "value"),
            role: optString(body, "role") ?? null,
            email: optString(body, "email") ?? null,
            workspace: optString(body, "workspace") ?? null,
            env: optString(body, "env") ?? null,
            secret_ref: optString(body, "secret_ref") ?? null,
            notes: optString(body, "notes") ?? null,
          },
          deps.secrets,
        ),
        201,
      );
    }
    if (second === "show" && segments.length === 2 && method === "GET") {
      const label = url.searchParams.get("label")?.trim() ?? "";
      if (!label) bad("'label' is required");
      return json(await h.testUserShow(store, label));
    }
    if (second === "check" && segments.length === 2 && method === "POST") {
      const body = await readJson(req);
      return json(await h.testUserCheck(store, { label: reqString(body, "label") }));
    }
    return null;
  }

  if (head === "sync" && segments.length === 1 && method === "POST") {
    const body = await readJson(req);
    const source = optString(body, "source");
    if (source && source !== "github") bad("'source' must be github");
    return json(
      await h.syncRun(store, {
        source: source as "github" | undefined,
        since: optString(body, "since"),
        backfill: optBool(body, "backfill"),
      }),
    );
  }

  return null;
}

/**
 * The handler the dashboard mounts, with the token read from its file once at startup.
 *
 * Reading it ONCE is deliberate: re-reading per request would let a token file deleted by accident take
 * the API down mid-session, and would put a filesystem call in front of every request. A rotated token
 * takes a restart of the dashboard, which is the same cost every other secret here has.
 */
export function obApiForStore(store: () => Promise<Store>): (req: Request) => Promise<Response> {
  const load = loadApiToken();
  if (load.message) {
    // The PATH and the reason, never the token. This is the one line an operator gets when the API is not
    // serving, so it says what to do about it.
    console.warn(`ob api: ${load.message}`);
  }
  return createObApi({ store, token: () => load });
}

/** OB-1991: a trial leg is `a` or `b`; anything else is refused by name rather than recorded. */
function trialLegOf(v: string | undefined): "a" | "b" | null {
  const leg = v?.trim();
  if (!leg) return null;
  if (leg === "a" || leg === "b") return leg;
  throw new ApiFault("invalid_request", 400, `trial_leg must be a or b (got '${leg}')`);
}

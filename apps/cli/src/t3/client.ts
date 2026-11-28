/**
 * ob → T3 Code write transport: the ONE seam (ticket 1102).
 *
 * EVERY call ob makes into T3 goes through this file. There is no second place
 * that knows the endpoint, the credential or the protocol: if T3's transport
 * changes, this is the only module that changes.
 *
 * ── The chosen transport: MCP over OAuth (authorization-code + PKCE) ──────────
 *
 * Measured on this machine, build `0.1.0` (see `docs/t3-integration.md`):
 *
 *   • `t3 auth session issue` mints a scoped bearer that T3's own HTTP API
 *     (`/api/orchestration/*` with `x-t3-orchestration-protocol: 2`) accepts —
 *     but `/mcp` answers `401 invalid_mcp_credential`. A session bearer is not
 *     an MCP credential. (Reproduced in the probe transcript; the map's warning
 *     is correct and permanent for the session-bearer path.)
 *   • `POST /mcp` wants a credential minted through the environment's MCP OAuth
 *     flow: dynamic client registration → `/oauth/mcp/authorize` consent →
 *     `authorization_code` + PKCE `S256` → `/oauth/mcp/token`. The token is a
 *     30-day bearer (`MCP_CLIENT_SESSION_TTL = days(30)`), and the metadata
 *     advertises NO refresh grant — renewal is re-minting.
 *   • Consent is completed from a script by approving with a one-time pairing
 *     code (`t3 auth pairing create`), the same code the browser's
 *     `/connect-agent` page would type. No browser is needed at runtime.
 *
 * Result: the MCP tool surface (`t3_thread_launch`, `t3_thread_read`,
 * `t3_thread_update`, `t3_thread_organize`, `t3_thread_wait`,
 * `t3_thread_interrupt`, …) is reachable from a Bun process with `fetch` alone.
 *
 * ── The one exception: `thread.auto-settle.set` (OB-1845) ─────────────────────
 *
 * MCP has no tool for a thread's auto-settle opt-out, so `turnAutoSettleOff` below is the narrow way
 * round it: the session bearer MCP refuses, a one-use ticket, and one command over T3's WebSocket RPC.
 * It is the only command ob sends that way, and the bearer is never stored.
 *
 * ── Rules this module enforces ───────────────────────────────────────────────
 *
 *   1. The credential lives OUTSIDE the repo, `chmod 600`, and nothing is ever
 *      committed. `credentialPath()` is the single source of that path.
 *   2. A missing / expired / revoked credential fails with a NAMED error and a
 *      one-line remedy — never a silent no-op.
 *   3. A tool that fails with `isError: true` surfaces the upstream message
 *      (`{_tag, code, message}`) verbatim. A provider's policy refusal must
 *      arrive as text, not as a swallowed result.
 */

import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AppError } from "../errors.ts";

// ---------------------------------------------------------------------------
// Constants — the pinned surface
// ---------------------------------------------------------------------------

/** Where a locally-run T3 server listens unless `T3_BASE_URL` overrides it. */
export const T3_DEFAULT_BASE_URL = "http://127.0.0.1:3773";

/** Env override for the server base URL (tests + a remote/Tailnet environment). */
export const T3_BASE_URL_ENV = "T3_BASE_URL";

/** Env override for the credential file path (tests never touch the real one). */
export const T3_CREDENTIAL_ENV = "OB_T3_CREDENTIAL_FILE";

/** Env override for the `t3` CLI binary the pairing step shells out to. */
export const T3_BIN_ENV = "T3_BIN";

/** Default credential home: `~/.omnislash/t3-mcp-credential.json`, mode 600. */
export const T3_CREDENTIAL_DIR = ".omnislash";
export const T3_CREDENTIAL_BASENAME = "t3-mcp-credential.json";

/** Build/channel the map pins (decision: "Pinned channel: preview"). Drift is reported, not fatal. */
export const T3_PINNED_BUILD = "0.1.1-preview.20261017.3254";
export const T3_PINNED_CHANNEL = "preview";

/** The MCP protocol revision this seam speaks. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * A thread's durable run status — T3's OWN vocabulary, read off the pinned build's tool schema
 * (`t3_thread_list`'s `statuses` enum). ob MIRRORS these strings onto its agent rows rather than
 * inventing a parallel vocabulary (the settled status answer), so this list
 * is a transcription, never a design.
 */
export const T3_THREAD_STATUSES = [
  "idle",
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
] as const;
export type T3ThreadStatus = (typeof T3_THREAD_STATUSES)[number];

export function isT3ThreadStatus(s: string): s is T3ThreadStatus {
  return (T3_THREAD_STATUSES as readonly string[]).includes(s);
}

/**
 * The statuses that mean "a run is in flight right now": a thread holding one of these is doing work or
 * waiting on the human, and is never safe to disturb (the cleanup guard) nor finished (the mirror).
 * `idle` is excluded on purpose: an idle thread has no run, which is what a fresh architect thread is.
 */
export const T3_LIVE_STATUSES: readonly T3ThreadStatus[] = ["preparing", "queued", "starting", "running", "waiting"];

/**
 * The delivery modes `t3_thread_send` accepts, transcribed from its schema (docs/t3-integration.md).
 * `queue` is the one that leaves a busy thread alone — ob only ever queues (a note is a notification,
 * never a steer), which is what makes it safe to write into the pinned architect mid-turn.
 */
export const T3_SEND_MODES = ["auto", "queue", "steer", "restart"] as const;
export type T3SendMode = (typeof T3_SEND_MODES)[number];

/**
 * MCP access level we approve. `full-access` is the only one whose scopes
 * (`orchestration:read|operate`, `settings:write`, `source-control:write`)
 * cover launch + update, and the map decides builders run with full access.
 */
export const T3_ACCESS = "full-access";

/** TTL requested for the one-time pairing code used to approve consent. */
export const T3_PAIRING_TTL = "10m";

// ---------------------------------------------------------------------------
// Errors — named, with the upstream reason and a remedy
// ---------------------------------------------------------------------------

export type T3FailureKind =
  | "unreachable"
  /** OS-203: T3 accepted the connection but did not answer inside the limit. Slow, not down. */
  | "timeout"
  | "credential_missing"
  | "credential_expired"
  | "credential_rejected"
  | "refused"
  | "protocol";

/** A failure in the ob → T3 seam. `kind` is the doctor stage; `remedy` is one line. */
export class T3Error extends AppError {
  readonly kind: T3FailureKind;
  readonly remedy: string | undefined;
  /**
   * T3's own tool-error code (`thread_not_found`, `invalid_request`, `orchestration_error`,
   * `unavailable`), when the failure came back as a tool refusal. A caller that needs to tell ONE
   * upstream condition from the rest reads this rather than matching the message text — the read
   * surface tolerates a deleted thread and propagates everything else.
   */
  readonly code: string | undefined;
  constructor(kind: T3FailureKind, message: string, remedy?: string, code?: string) {
    super(message);
    this.name = "T3Error";
    this.kind = kind;
    this.remedy = remedy;
    this.code = code;
  }
}

/** OS-203: the error for a T3 call we gave up waiting on: what was asked, and how long it waited. */
export function t3Timeout(label: string, elapsedMs: number, limitMs: number): T3Error {
  return new T3Error(
    "timeout",
    `T3 slow: ${label} did not answer within ${limitMs}ms (gave up after ${elapsedMs}ms)`,
    "T3 is up but busy; retry once the load drops",
  );
}

/** OS-203: is this a T3 call that timed out (T3 slow), rather than one that failed? */
export function isT3Timeout(err: unknown): err is T3Error {
  return err instanceof T3Error && err.kind === "timeout";
}

// ---------------------------------------------------------------------------
// Credential — shape, path, read/write, status
// ---------------------------------------------------------------------------

export interface T3Credential {
  version: 1;
  baseUrl: string;
  accessToken: string;
  tokenType: string;
  /** MCP access level the token was approved at (`full-access`). */
  access: string;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
  /** The registered OAuth client id (stateless, signed by the server). */
  clientId?: string;
  environmentId?: string;
  serverVersion?: string;
}

export function credentialPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[T3_CREDENTIAL_ENV];
  if (override && override.length > 0) return expandHome(override);
  return join(homedir(), T3_CREDENTIAL_DIR, T3_CREDENTIAL_BASENAME);
}

export function t3BaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[T3_BASE_URL_ENV];
  return override && override.length > 0 ? override.replace(/\/+$/, "") : T3_DEFAULT_BASE_URL;
}

/** `~` expansion, local so this module pulls in no ssh/net surface. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function readCredential(env: NodeJS.ProcessEnv = process.env): T3Credential | null {
  const path = credentialPath(env);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let parsed: T3Credential;
  try {
    parsed = JSON.parse(raw) as T3Credential;
  } catch {
    throw new T3Error(
      "credential_rejected",
      `credential file ${path} is not valid JSON`,
      "run `ob t3 login` to re-mint it",
    );
  }
  if (!parsed || typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) {
    throw new T3Error(
      "credential_rejected",
      `credential file ${path} is malformed (no accessToken)`,
      "run `ob t3 login` to re-mint it",
    );
  }
  return parsed;
}

/**
 * Write the credential outside the repo, mode 600, parent dir 700. Returns the
 * path so callers can name it (doctor does). Never called with a token in a log.
 */
export function writeCredential(credential: T3Credential, env: NodeJS.ProcessEnv = process.env): string {
  const path = credentialPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

// ---------------------------------------------------------------------------
// JWT payload — the credential is a bearer with a decodable claim
// ---------------------------------------------------------------------------

/** base64url decode (no padding required). Pure. */
export function base64UrlDecode(input: string): Buffer {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

export function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface T3TokenClaims {
  kind?: string;
  sid?: string;
  sub?: string;
  scopes?: string[];
  method?: string;
  rtc?: string;
  iat?: number;
  exp?: number;
}

/**
 * Decode a bearer's claims. Local only — the server is the authority; this is
 * what lets `doctor` say "expired" BEFORE a launch fails.
 */
export function decodeTokenClaims(token: string): T3TokenClaims {
  const parts = token.split(".");
  if (parts.length < 2) throw new T3Error("credential_rejected", "credential is not a JWT-shaped bearer");
  try {
    return JSON.parse(base64UrlDecode(parts[0]!).toString("utf8")) as T3TokenClaims;
  } catch {
    throw new T3Error("credential_rejected", "credential claims are not decodable JSON");
  }
}

export interface CredentialStatus {
  present: boolean;
  path: string;
  /** ISO expiry, from the claim when readable. */
  expiresAt: string | null;
  expired: boolean;
  msRemaining: number | null;
  scopes: string[];
  access: string | null;
  sid: string | null;
}

/** Local status. `expired` is the claim's verdict; the server re-checks on every call. */
export function credentialStatus(
  credential: T3Credential | null,
  nowMs: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): CredentialStatus {
  const path = credentialPath(env);
  if (!credential) {
    return { present: false, path, expiresAt: null, expired: false, msRemaining: null, scopes: [], access: null, sid: null };
  }
  let claims: T3TokenClaims;
  try {
    claims = decodeTokenClaims(credential.accessToken);
  } catch {
    return { present: true, path, expiresAt: credential.expiresAt, expired: true, msRemaining: null, scopes: credential.scopes, access: credential.access, sid: null };
  }
  const expMs = typeof claims.exp === "number" ? claims.exp : Date.parse(credential.expiresAt);
  const msRemaining = Number.isFinite(expMs) ? expMs - nowMs : null;
  return {
    present: true,
    path,
    expiresAt: Number.isFinite(expMs) ? new Date(expMs).toISOString() : null,
    expired: msRemaining !== null && msRemaining <= 0,
    msRemaining,
    scopes: claims.scopes ?? credential.scopes,
    access: claims.rtc ?? credential.access,
    sid: claims.sid ?? null,
  };
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface T3TransportDeps {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Runs `t3 auth pairing create`; injected so tests never shell out. */
  createPairingCode?: (ttl: string, env: NodeJS.ProcessEnv) => string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

async function readBody(res: Response): Promise<unknown> {
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (type.includes("text/event-stream")) {
    // MCP may answer over SSE; take the last `data:` frame that parses.
    const frames = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter((l) => l.length > 0);
    for (const frame of frames.reverse()) {
      try {
        return JSON.parse(frame);
      } catch {
        continue;
      }
    }
    return text;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// mintCredential — the OAuth + pairing-code flow, from a script
// ---------------------------------------------------------------------------

export interface MintOptions {
  baseUrl?: string;
  /** Access level to approve; defaults to `full-access`. */
  access?: string;
  /** TTL for the one-time pairing code. */
  pairingTtl?: string;
  clientName?: string;
  env?: NodeJS.ProcessEnv;
  deps?: T3TransportDeps;
  /** Receive each step's line for a transcript. */
  onStep?: (line: string) => void;
}

function defaultCreatePairingCode(ttl: string, env: NodeJS.ProcessEnv): string {
  const bin = env[T3_BIN_ENV] ?? "t3";
  const result = spawnSync(bin, ["auth", "pairing", "create", "--ttl", ttl, "--json"], {
    encoding: "utf8",
    env: env as Record<string, string>,
  });
  if (result.error) {
    throw new T3Error(
      "credential_missing",
      `could not run \`${bin} auth pairing create\`: ${result.error.message}`,
      `install the T3 CLI or set ${T3_BIN_ENV}`,
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim().split("\n").pop() ?? "unknown error";
    throw new T3Error("unreachable", `\`${bin} auth pairing create\` failed: ${detail}`, "is the T3 server running?");
  }
  let parsed: { credential?: string };
  try {
    parsed = JSON.parse(result.stdout) as { credential?: string };
  } catch {
    throw new T3Error("protocol", `\`${bin} auth pairing create\` did not return JSON`);
  }
  if (!parsed.credential) {
    throw new T3Error("protocol", "pairing response carried no credential");
  }
  return parsed.credential;
}

/**
 * Mint a fresh MCP credential and (unless `write` is false — the probe uses
 * that) persist it. This is also the RENEWAL path: there is no refresh grant,
 * so renewing is simply running this again.
 */
export async function mintCredential(
  opts: MintOptions & { write?: boolean } = {},
): Promise<{ credential: T3Credential; path: string | null; steps: string[] }> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.deps?.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = opts.deps?.now ?? (() => Date.now());
  const createPairing = opts.deps?.createPairingCode ?? defaultCreatePairingCode;
  const baseUrl = (opts.baseUrl ?? t3BaseUrl(env)).replace(/\/+$/, "");
  const access = opts.access ?? T3_ACCESS;
  const steps: string[] = [];
  const step = (line: string) => {
    steps.push(line);
    opts.onStep?.(line);
  };

  // 1. Dynamic client registration (RFC 7591). The client id is stateless and signed.
  const redirectUri = "http://127.0.0.1:9/callback";
  const regRes = await fetchImpl(`${baseUrl}/oauth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: opts.clientName ?? "ob" }),
  });
  const reg = (await readBody(regRes)) as { client_id?: string; error_description?: string };
  if (!regRes.ok || !reg.client_id) {
    throw new T3Error(
      "protocol",
      `MCP client registration failed (${regRes.status}): ${reg.error_description ?? "no client_id"}`,
      "is this a T3 server? check T3_BASE_URL",
    );
  }
  step(`registration: client registered at ${baseUrl} (${opts.clientName ?? "ob"})`);

  // 2. PKCE.
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = base64UrlEncode(createHash("sha256").update(codeVerifier).digest());

  const authorization = {
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: base64UrlEncode(randomBytes(8)),
    resource: `${baseUrl}/mcp`,
  };

  // 3. Ask for the approval details (no browser session here → no csrfToken).
  const approvalRes = await fetchImpl(`${baseUrl}/oauth/mcp/approval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(authorization),
  });
  const approval = (await readBody(approvalRes)) as { message?: string };
  if (!approvalRes.ok) {
    throw new T3Error("protocol", `MCP approval request rejected: ${approval.message ?? approvalRes.status}`, "check the requested access/scopes");
  }
  step(`consent: ${baseUrl} offered an approval page (no browser needed)`);

  // 4. Approve with a one-time pairing code minted by the T3 CLI.
  const pairingCode = createPairing(opts.pairingTtl ?? T3_PAIRING_TTL, env);
  step(`consent: approved with a one-time pairing code (access=${access})`);

  const decisionRes = await fetchImpl(`${baseUrl}/oauth/mcp/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authorization, decision: { _tag: "pairing-code", access, code: pairingCode } }),
  });
  const decision = (await readBody(decisionRes)) as { redirectTo?: string; message?: string };
  if (!decisionRes.ok || !decision.redirectTo) {
    throw new T3Error(
      "refused",
      `MCP consent was refused: ${decision.message ?? decisionRes.status}`,
      "mint a pairing code with the standard scopes (run without --scope), or approve `read-only`",
    );
  }
  const code = new URL(decision.redirectTo).searchParams.get("code");
  if (!code) throw new T3Error("protocol", "consent redirect carried no authorization code");
  step("consent: authorization code issued");

  // 5. Exchange the code (PKCE verifier proves we are the same client).
  const tokenRes = await fetchImpl(`${baseUrl}/oauth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: reg.client_id,
      code_verifier: codeVerifier,
      resource: `${baseUrl}/mcp`,
    }).toString(),
  });
  const token = (await readBody(tokenRes)) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    scope?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !token.access_token) {
    throw new T3Error(
      "refused",
      `MCP token exchange failed: ${token.error_description ?? tokenRes.status}`,
      "authorization codes are one-use and short-lived; re-run to try again",
    );
  }

  const claims = decodeTokenClaims(token.access_token);
  const expiresMs = typeof claims.exp === "number" ? claims.exp : now() + (token.expires_in ?? 0) * 1000;
  const issuedMs = typeof claims.iat === "number" ? claims.iat : now();
  const credential: T3Credential = {
    version: 1,
    baseUrl,
    accessToken: token.access_token,
    tokenType: token.token_type ?? "Bearer",
    access: claims.rtc ?? access,
    scopes: claims.scopes ?? (token.scope ? token.scope.split(" ") : []),
    issuedAt: new Date(issuedMs).toISOString(),
    expiresAt: new Date(expiresMs).toISOString(),
    clientId: reg.client_id,
  };
  step(`token: minted (${credential.scopes.join(" ")}) expiring ${credential.expiresAt}`);

  const path = opts.write === false ? null : writeCredential(credential, env);
  if (path) step(`stored: ${path} (mode 600, outside the repo)`);
  return { credential, path, steps };
}

// ---------------------------------------------------------------------------
// T3Client — the tool surface
// ---------------------------------------------------------------------------

export interface T3ClientDeps extends T3TransportDeps {
  baseUrl?: string;
  credential?: T3Credential | null;
  timeoutMs?: number;
}

export interface McpToolError {
  _tag?: string;
  code?: string;
  message?: string;
}

export interface T3Environment {
  environmentId: string;
  label: string;
  serverVersion: string;
  platform: { os: string; arch: string; machine: string };
}

/**
 * A project's git identity, as T3 resolves it from the checkout (`repositoryIdentity` on
 * `t3_project_list`). Present only when the workspace root really is a repository T3 recognises.
 */
export interface T3RepositoryIdentity {
  canonicalKey: string;
  displayName?: string;
  provider?: string;
  owner?: string;
  name?: string;
  webUrl?: string;
  rootPath?: string;
  locator?: { source: string; remoteName?: string; remoteUrl?: string };
}

/** One project script (`t3_project_list`'s `scripts`), read for its count only. */
export interface T3ProjectScript {
  name?: string;
  command?: string;
}

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  repositoryIdentity?: T3RepositoryIdentity | null;
  defaultModelSelection?: { instanceId: string; model: string } | null;
  /** The project's own scripts (`t3_project_list`); ob reports how many, never what they run. */
  scripts?: T3ProjectScript[] | null;
  deletedAt?: string | null;
}

/** One option a model lists (OB-1815): Claude models carry `effort`, OpenCode models `variant`. */
export interface T3ModelOption {
  id: string;
  values: string[];
  default?: string;
}

export interface T3ProviderModel {
  id: string;
  label?: string;
  /** What the model lets a launch set (OB-1815). Absent on a model that lists none. */
  options?: T3ModelOption[];
}

export interface T3ProviderInstance {
  providerInstanceId: string;
  displayName: string;
  driverKind?: string;
  models: T3ProviderModel[];
  constraints?: string[];
}

export interface T3Capabilities {
  runtimeMode: string;
  providers: T3ProviderInstance[];
}

export interface T3ThreadRun {
  runId: string;
  status: string;
  requestedAt?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface T3Thread {
  threadId: string;
  projectId: string;
  title: string;
  status: string;
  worktreePath: string | null;
  branch: string | null;
  settled: boolean;
  archived: boolean;
  model: string;
  providerInstanceId: string;
  activeRunId: string | null;
  latestRunId: string | null;
  /** How many questions/approvals the thread is waiting on the human for (0 = nothing pending). */
  pendingRequestCount?: number;
  /** How many timeline items the thread holds: the page a recent-items read starts from (OB-1710). */
  itemCount?: number;
  /** The thread that spawned this one, and how — `subagent` for a delegated child (1124's tree). */
  parentThreadId?: string | null;
  relationshipToParent?: string | null;
  snoozed?: boolean;
  snoozedUntil?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/** One row of `t3_thread_list`: the summary, without the run detail `t3_thread_read` returns. */
export interface T3ThreadSummary {
  threadId: string;
  projectId?: string;
  title: string;
  status: string;
  latestRunId: string | null;
  providerInstanceId: string;
  model: string;
  settled: boolean;
  parentThreadId: string | null;
  /** `subagent` on a delegated child; null on a thread a human or ob launched. */
  relationshipToParent?: string | null;
  snoozed?: boolean;
  snoozedUntil?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface T3ThreadListResult {
  projectId: string;
  threads: T3ThreadSummary[];
  nextCursor: number | null;
  /** How many threads the project holds in total (a truncated page is reported, never silently cut). */
  total?: number;
}

export interface T3ThreadRead {
  thread: T3Thread;
  recentRuns: T3ThreadRun[];
  items: Array<{
    position: number;
    type: string;
    status: string;
    title?: string | null;
    text?: string | null;
    /** Who wrote the item: `user` for a human, `agent` for a provider or an MCP caller (OB-1710). */
    createdBy?: string | null;
    /** Where it came from: `web`/`mobile` for a human, `mcp` for a tool call, `provider` for a model. */
    creationSource?: string | null;
    updatedAt?: string;
  }>;
  nextPosition: number;
  hasMore: boolean;
}

export interface T3LaunchResult {
  threadId: string;
  projectId: string;
  modelSelection: { instanceId: string; model: string };
  runId: string | null;
  status: string | null;
}

export interface T3LaunchInput {
  projectId?: string;
  scratch?: boolean;
  title: string;
  message?: string;
  modelSelection: { instanceId: string; model: string; options?: unknown };
  runtimeMode?: string;
  interactionMode?: string;
  workspaceStrategy?: { type: "root" } | { type: "existing_worktree"; worktreePath: string; branch?: string };
  /**
   * The retry key ob sends with every launch so a retry is the SAME durable work rather than a second
   * thread (wayfinder 1120). It is derived from the spinoff row id and never changes for that row.
   *
   * Measured on the pinned build (0.1.0): `t3_thread_launch`'s schema does NOT declare this property and
   * its own description says "Each call creates a new launch with no retry key" — so ob does not RELY on
   * it. It is sent anyway (the tool declares `additionalProperties: true`, so it is accepted) because it
   * is the correct key the day T3 honours one, and the durable guard today is adoption of the thread
   * already bound to the row's worktree.
   */
  clientRequestId?: string;
  /**
   * Attachments the brief carries, as PENDING UPLOADS: the tool's own description says "Attachments
   * must be pending uploads" and the schema caps the array at 8 items (image ≤ 10 MB, file ≤ 50 MB).
   * Measured end to end on 0.1.0 by wayfinder 1103: `t3_attachment_prepare_upload` returns
   * `{attachmentId, relativeUrl}`, the bytes are POSTed to `relativeUrl` (HTTP 204), and the launch's
   * run then sees the image. Sending one is a two-step call, not a file path.
   */
  attachments?: T3LaunchAttachment[];
}

export interface T3LaunchAttachment {
  type: "image" | "file";
  /** The `attachmentId` from `t3_attachment_prepare_upload` (spelled `pending-…`). */
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * A message into an existing thread (`t3_thread_send`). ob uses exactly one shape: `mode: "queue"`, so a
 * note never interrupts a turn in flight, and a `clientRequestId` — which this tool DOES declare, so a
 * retry after a lost response is the same durable message rather than a second one.
 */
export interface T3SendInput {
  threadId: string;
  message: string;
  mode?: T3SendMode;
  clientRequestId?: string;
}

/**
 * One message T3 is HOLDING for a thread — queued, not yet delivered (a `t3_queue` `action: "list"` row, 1205).
 *
 * Only the two fields ob acts on are typed: the id it withdraws by, and the text it matches a note
 * against. `truncated` is carried because a long message is the one case where matching the text could be
 * wrong — ob's notes are far below the cap, and a caller that cannot see the whole text must not pretend
 * it matched it.
 */
export interface T3QueuedMessage {
  queuedRunId: string;
  text: string;
  truncated: boolean;
}

/**
 * How many held messages ob reads in one `t3_queue` (`action: list`) page, and the most pages it will walk (1205).
 *
 * An architect thread's queue is a handful (it drains at the end of every turn) so one page is normally the
 * whole answer. The bound exists so a thread that is mid-turn AND still being fed can never spin this in a
 * loop. Note that walking more than one page is NOT a complete read: the tool documents its results as a
 * LIVE OFFSET PAGE, so an item removed between two reads shifts the offsets and can be stepped over while
 * the cursor still runs out. See `T3QueueRead`.
 */
const QUEUE_PAGE_LIMIT = 50;
const QUEUE_PAGE_MAX = 4;

/**
 * A read of the messages a thread is HOLDING, and whether it saw ALL of them (1205).
 *
 * `complete: false` is what stops a bounded scan from reading as evidence of absence: the caller must not
 * turn "no note in what I read" into "nothing is held", because the remedy is to look again, not to
 * conclude. Nothing in ob may treat an incomplete read as a clean queue.
 *
 * Completeness has a narrow meaning, and it is the honest one: the WHOLE queue came back in ONE live page.
 * A second page is read only to withdraw what it can see; because offsets are recomputed against a queue
 * that other turns are draining, two pages are not proof of coverage even when the cursor runs out.
 */
export interface T3QueueRead {
  items: T3QueuedMessage[];
  complete: boolean;
}

/** A timeline position past any thread's end: a read from here returns the thread header and no items (OB-2192). */
export const PAST_THE_END = 1_000_000_000;

export class T3Client {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  readonly credential: T3Credential | null;
  private sessionId: string | null = null;
  private serverVersion: string | null = null;

  constructor(deps: T3ClientDeps = {}) {
    this.env = deps.env ?? process.env;
    this.baseUrl = (deps.baseUrl ?? t3BaseUrl(this.env)).replace(/\/+$/, "");
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // An explicit `credential: null` means "no credential" (the reachability probe); omitting the
    // key means "read the stored one".
    this.credential = deps.credential !== undefined ? deps.credential : readCredential(this.env);
  }

  /** Build a client from the stored credential, refusing loudly when it is missing or stale. */
  static async connected(deps: T3ClientDeps = {}): Promise<T3Client> {
    const env = deps.env ?? process.env;
    const credential = deps.credential !== undefined ? deps.credential : readCredential(env);
    if (!credential) {
      throw new T3Error(
        "credential_missing",
        `no T3 MCP credential at ${credentialPath(env)}`,
        "run `ob t3 login` to mint one",
      );
    }
    const status = credentialStatus(credential, Date.now(), env);
    if (status.expired) {
      throw new T3Error(
        "credential_expired",
        `T3 MCP credential expired ${status.expiresAt ?? "?"}`,
        "run `ob t3 login` to renew it (T3 advertises no refresh grant)",
      );
    }
    const client = new T3Client({ ...deps, credential });
    await client.initialize();
    return client;
  }

  get base(): string {
    return this.baseUrl;
  }

  get version(): string | null {
    return this.serverVersion;
  }

  /**
   * One HTTP request under the client's limit. OS-203: our own abort is a `timeout` naming what was asked
   * (`label`: the tool, else the path) and how long it waited; only a request that never connected is
   * `unreachable`. A slow T3 under load answered nothing yet, which is not the same as T3 being down.
   */
  private async request(path: string, init: RequestInit = {}, label: string = path): Promise<Response> {
    const controller = new AbortController();
    const started = Date.now();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw t3Timeout(label, Date.now() - started, this.timeoutMs);
      throw new T3Error(
        "unreachable",
        `T3 server not reachable at ${this.baseUrl}: ${(err as Error).message}`,
        "is T3 running? `t3 serve`, or set T3_BASE_URL",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reachability probe that does NOT need a credential. */
  async reachable(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.request("/.well-known/oauth-protected-resource", { method: "GET" });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      const body = (await readBody(res)) as { resource_name?: string };
      return { ok: true, detail: body.resource_name ?? "T3 Code" };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  /** MCP handshake: capture the session id and the server version. */
  async initialize(): Promise<{ serverVersion: string; sessionId: string | null }> {
    const res = await this.request("/mcp", {
      method: "POST",
      headers: this.mcpHeaders(false),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "ob", version: "1" },
        },
      }),
    });
    if (res.status === 401) {
      throw new T3Error(
        "credential_rejected",
        "T3 rejected the MCP credential (401 invalid_mcp_credential)",
        "run `ob t3 login` to re-mint it",
      );
    }
    if (!res.ok) {
      throw new T3Error("protocol", `MCP initialize failed with HTTP ${res.status}`);
    }
    this.sessionId = res.headers.get("mcp-session-id");
    const body = (await readBody(res)) as { result?: { serverInfo?: { version?: string } }; error?: { message?: string } };
    if (body.error) throw new T3Error("protocol", `MCP initialize error: ${body.error.message ?? "unknown"}`);
    this.serverVersion = body.result?.serverInfo?.version ?? null;
    // The initialized notification closes the handshake; best-effort.
    await this.request("/mcp", {
      method: "POST",
      headers: this.mcpHeaders(true),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).catch(() => undefined);
    return { serverVersion: this.serverVersion ?? "unknown", sessionId: this.sessionId };
  }

  private mcpHeaders(withSession: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const token = this.credential?.accessToken;
    if (token) headers.authorization = `${this.credential?.tokenType ?? "Bearer"} ${token}`;
    if (withSession && this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  /**
   * Call one MCP tool. Every failure path throws a `T3Error` that carries the
   * upstream reason — the seam never returns a silent no-op.
   */
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.sessionId === null) await this.initialize();
    const res = await this.request("/mcp", {
      method: "POST",
      headers: this.mcpHeaders(true),
      body: JSON.stringify({ jsonrpc: "2.0", id: 2 + Math.floor(Math.random() * 1000), method: "tools/call", params: { name, arguments: args } }),
    }, name);
    if (res.status === 401) {
      throw new T3Error(
        "credential_rejected",
        `T3 rejected the MCP credential for '${name}' (401 invalid_mcp_credential)`,
        "run `ob t3 login` to re-mint it",
      );
    }
    const body = (await readBody(res)) as {
      result?: { structuredContent?: unknown; isError?: boolean; content?: Array<{ type: string; text?: string }> };
      error?: { code?: number; message?: string };
    };
    if (body.error) {
      throw new T3Error("protocol", `${name}: ${body.error.message ?? "JSON-RPC error"}`, "check the tool name/arguments");
    }
    if (!body.result) throw new T3Error("protocol", `${name}: empty MCP result (HTTP ${res.status})`);
    if (body.result.isError) {
      // T3 puts `{_tag, code, message}` in the text content. Surface it verbatim.
      const text = body.result.content?.map((c) => c.text ?? "").join("") ?? "";
      let parsed: McpToolError = {};
      try {
        parsed = JSON.parse(text) as McpToolError;
      } catch {
        parsed = { message: text };
      }
      throw new T3Error("refused", `${name}: ${parsed.message ?? text ?? "tool reported an error"}`, remedyForToolError(parsed.code), parsed.code);
    }
    return (body.result.structuredContent ?? parseTextContent(body.result.content)) as T;
  }

  async tools(): Promise<Array<{ name: string; description?: string }>> {
    if (this.sessionId === null) await this.initialize();
    const res = await this.request("/mcp", {
      method: "POST",
      headers: this.mcpHeaders(true),
      body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
    });
    const body = (await readBody(res)) as { result?: { tools?: Array<{ name: string; description?: string }> }; error?: { message?: string } };
    if (body.error) throw new T3Error("protocol", `tools/list: ${body.error.message ?? "error"}`);
    return body.result?.tools ?? [];
  }

  // ── read surface ─────────────────────────────────────────────────────────

  environment(): Promise<T3Environment> {
    return this.callTool<T3Environment>("t3_environment_read");
  }

  async projects(): Promise<T3Project[]> {
    const out = await this.callTool<{ projects: T3Project[] }>("t3_project_list");
    return out.projects ?? [];
  }

  /**
   * `search` (OB-1815) asks T3 for models its short default list omits (`omittedModels`): absent, the short
   * list; given, the matches too. A model name is the usual search.
   */
  capabilities(search?: string): Promise<T3Capabilities> {
    return this.callTool<T3Capabilities>("orchestrator_capabilities", search === undefined ? undefined : { search });
  }

  // ── write surface — the four the map names ────────────────────────────────

  launch(input: T3LaunchInput): Promise<T3LaunchResult> {
    return this.callTool<T3LaunchResult>("t3_thread_launch", {
      ...input,
      runtimeMode: input.runtimeMode ?? "full-access",
    });
  }

  read(threadId: string, opts: { limit?: number; view?: "messages" | "activity"; runLimit?: number; afterPosition?: number } = {}): Promise<T3ThreadRead> {
    return this.callTool<T3ThreadRead>("t3_thread_read", { threadId, ...opts });
  }

  /**
   * The thread header only (OB-2192): a read from past the end, so T3 pages no items. A read from the first
   * item times out under load on an architect thread of thousands of items; this one answers in well under a second.
   */
  async readHeader(threadId: string): Promise<T3Thread> {
    return (await this.read(threadId, { afterPosition: PAST_THE_END, limit: 1, runLimit: 5 })).thread;
  }

  /**
   * List a project's threads (newest first). `titleContains` is T3's own filter — ob uses it to narrow
   * the adoption scan to the threads it titled for one ticket, then confirms identity by the thread's
   * `worktreePath` (an id), never by the title text.
   *
   * `includeSubagents` is T3's own switch for the delegated children a parent spawned: `false` (the read
   * surface's default) lists only the threads a human or ob launched, which are the ones ob stamps rows
   * on. Omitted, T3 includes them.
   */
  list(opts: {
    projectId?: string;
    titleContains?: string;
    settled?: boolean;
    statuses?: string[];
    includeSubagents?: boolean;
    limit?: number;
    cursor?: number;
  } = {}): Promise<T3ThreadListResult> {
    return this.callTool<T3ThreadListResult>("t3_thread_list", { ...opts });
  }

  /** `view: "activity"` is how a provider failure surfaces (`type: "error"` items). */
  activity(threadId: string): Promise<T3ThreadRead> {
    return this.read(threadId, { view: "activity", limit: 50 });
  }

  update(threadId: string, action: "rename" | "regenerate_title", title?: string): Promise<unknown> {
    return this.callTool("t3_thread_update", { threadId, action, ...(title === undefined ? {} : { title }) });
  }

  rename(threadId: string, title: string): Promise<unknown> {
    return this.update(threadId, "rename", title);
  }

  organize(threadId: string, action: "pin" | "unpin" | "snooze" | "unsnooze" | "settle" | "unsettle" | "archive" | "unarchive" | "mark_unread"): Promise<unknown> {
    return this.callTool("t3_thread_organize", { threadId, action });
  }

  settle(threadId: string): Promise<unknown> {
    return this.organize(threadId, "settle");
  }

  /**
   * Deliver a message into a thread (1133). The one write ob makes into a thread it did not open a run
   * on: the readying note into the architect, and the land reply into the builder.
   */
  send(input: T3SendInput): Promise<unknown> {
    return this.callTool("t3_thread_send", { ...input });
  }

  /**
   * The messages a thread is HOLDING — queued, not yet delivered (1205). This is what T3 delivers when the
   * thread's live turn ends, which is why ob can look at it at all: the readying note it withdraws below is
   * in here from the moment `send` returns until the architect's turn ends.
   *
   * AN ABSENT CURSOR IS `undefined`, NEVER `null` (1264). T3's schema is `cursor?: number`, so `null` is not
   * "no cursor" to it — it is an invalid argument, and the call is refused before a page is read. ob treats
   * null as "absent" everywhere, which is exactly the habit that turned into a live rejection: the first
   * page went out as `cursor: null` and `ob close` could never withdraw a held readying note at all.
   */
  async queue(threadId: string): Promise<T3QueueRead> {
    const out: T3QueuedMessage[] = [];
    let cursor: number | null = null;
    let complete = false;
    for (let page = 0; page < QUEUE_PAGE_MAX; page++) {
      const res: { items?: T3QueuedMessage[]; nextCursor?: number | null } = await this.callTool("t3_queue", {
        action: "list",
        threadId,
        limit: QUEUE_PAGE_LIMIT,
        // Omitted on the first page: `undefined` drops the key at the boundary, `null` would be refused.
        cursor: cursor ?? undefined,
      });
      out.push(...(res.items ?? []));
      cursor = res.nextCursor ?? null;
      if (cursor === null) {
        // COMPLETE only when the whole thing came back in ONE page. The tool hands back a live OFFSET page,
        // so a removal between two reads shifts every later offset: a second page can step over an item and
        // still end with a null cursor. Pages beyond the first are read to withdraw what they can see and
        // are never claimed as coverage.
        complete = page === 0;
        break;
      }
    }
    return { items: out, complete };
  }

  /**
   * Withdraw one held message before T3 delivers it (`t3_queue` with `action: "cancel"`, 1205). T3's own queue
   * command, so the message is gone from the thread's history as well as from its queue — exactly what a
   * readying note for a ticket that has just landed should be. (T3 merged the old `t3_queue_list`,
   * `t3_queue_read` and `t3_queue_cancel` into the one `t3_queue` tool, selected by `action`; OB-1793.)
   */
  queueCancel(threadId: string, queuedRunId: string): Promise<unknown> {
    return this.callTool("t3_queue", { action: "cancel", threadId, queuedRunId });
  }

  wait(threadId: string, timeoutMs?: number): Promise<{ runId: string | null; status: string; timedOut: boolean }> {
    return this.callTool("t3_thread_wait", { threadId, timeoutMs });
  }

  interrupt(threadId: string): Promise<unknown> {
    return this.callTool("t3_thread_interrupt", { threadId });
  }
}

// ---------------------------------------------------------------------------
// turnAutoSettleOff: the one orchestration command MCP does not expose (OB-1845)
// ---------------------------------------------------------------------------

/** What ob asks `t3 auth session issue` for: the two scopes this needs, and only long enough to use them. */
const T3_SESSION_SCOPES = ["orchestration:read", "orchestration:operate"];
const T3_SESSION_TTL = "5m";
const T3_ORCHESTRATION_PROTOCOL = "2";

/** The part of a WebSocket the dispatch uses, so a test never opens one. */
export interface T3CommandSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface T3OrchestrationDeps {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Runs `t3 auth session issue`; injected so tests never shell out. */
  issueSessionBearer?: (env: NodeJS.ProcessEnv) => string;
  openSocket?: (url: string) => T3CommandSocket;
}

function defaultIssueSessionBearer(env: NodeJS.ProcessEnv): string {
  const bin = env[T3_BIN_ENV] ?? "t3";
  const scopes = T3_SESSION_SCOPES.flatMap((scope) => ["--scope", scope]);
  const result = spawnSync(bin, ["auth", "session", "issue", ...scopes, "--ttl", T3_SESSION_TTL, "--label", "ob-auto-settle", "--token-only"], {
    encoding: "utf8",
    timeout: DEFAULT_TIMEOUT_MS,
    env: env as Record<string, string>,
  });
  if (result.error) {
    throw new T3Error("credential_missing", `could not run \`${bin} auth session issue\`: ${result.error.message}`, `install the T3 CLI or set ${T3_BIN_ENV}`);
  }
  // stderr only: stdout is the bearer.
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim().split("\n").pop() || "unknown error";
    throw new T3Error("credential_rejected", `\`${bin} auth session issue\` failed: ${detail}`);
  }
  const bearer = result.stdout.trim();
  if (bearer.length === 0) throw new T3Error("protocol", `\`${bin} auth session issue\` printed no bearer`);
  return bearer;
}

/** `autoSettleDisabledAt` off T3's bounded thread read. MCP's `t3_thread_read` does not carry the field. */
async function readAutoSettleDisabledAt(
  threadId: string,
  ctx: { baseUrl: string; fetchImpl: FetchLike; headers: Record<string, string>; timeoutMs: number },
): Promise<string | null> {
  const res = await orchestrationHttp(`${ctx.baseUrl}/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`, { headers: ctx.headers }, ctx);
  const body = (await readBody(res)) as { reason?: string; projection?: { thread?: { autoSettleDisabledAt?: string | null } } };
  if (!res.ok) throw new T3Error("refused", `T3 refused the read of thread ${threadId} (HTTP ${res.status}): ${body.reason ?? "no reason given"}`);
  if (!body.projection?.thread) throw new T3Error("protocol", `T3's read of thread ${threadId} carried no thread`);
  return body.projection.thread.autoSettleDisabledAt ?? null;
}

async function orchestrationHttp(url: string, init: RequestInit, ctx: { fetchImpl: FetchLike; timeoutMs: number }): Promise<Response> {
  const signal = AbortSignal.timeout(ctx.timeoutMs);
  const started = Date.now();
  try {
    return await ctx.fetchImpl(url, { ...init, signal });
  } catch (err) {
    if (signal.aborted) throw t3Timeout(new URL(url).pathname, Date.now() - started, ctx.timeoutMs);
    throw new T3Error("unreachable", `T3 server not reachable: ${(err as Error).message}`, "is T3 running? `t3 serve`, or set T3_BASE_URL");
  }
}

/**
 * Send one command over the socket and wait for its Exit. Effect RPC's JSON framing, read from T3's
 * bundle and proven live on 0.1.7. A failure never quotes the socket's URL, which holds the ticket.
 */
function dispatchOverSocket(socket: T3CommandSocket, command: Record<string, unknown>, timeoutMs: number): Promise<void> {
  const requestId = "1";
  return new Promise<void>((resolve, reject) => {
    const finish = (error: T3Error | null) => {
      clearTimeout(timer);
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      socket.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(t3Timeout(String(command.type ?? "the command"), timeoutMs, timeoutMs)), timeoutMs);
    socket.onopen = () => socket.send(JSON.stringify({ _tag: "Request", id: requestId, tag: "orchestration.dispatchCommand", payload: command, headers: [] }));
    socket.onerror = () => finish(new T3Error("unreachable", "the WebSocket to T3 failed"));
    socket.onclose = () => finish(new T3Error("protocol", "T3 closed the WebSocket before answering the command"));
    socket.onmessage = (event) => {
      let frame: { _tag?: string; requestId?: string; exit?: { _tag?: string; cause?: Array<{ error?: { message?: string }; defect?: unknown }> } };
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame._tag !== "Exit" || frame.requestId !== requestId) return;
      if (frame.exit?._tag === "Success") return finish(null);
      const cause = frame.exit?.cause?.[0];
      finish(new T3Error("refused", `T3 refused the command: ${cause?.error?.message ?? JSON.stringify(cause?.defect ?? frame.exit)}`));
    };
  });
}

/**
 * Turn auto-settle off for one thread and read it back: `autoSettleDisabledAt` is what this returns, never
 * an assumption. A thread that already has it off sends no command, so a re-run changes nothing.
 *
 * The bearer lives in this call's memory only and is not revoked: its short TTL is the only cleanup. Writing to T3's database or settings is not a fallback.
 */
export async function turnAutoSettleOff(threadId: string, deps: T3OrchestrationDeps = {}): Promise<string> {
  const env = deps.env ?? process.env;
  const baseUrl = (deps.baseUrl ?? t3BaseUrl(env)).replace(/\/+$/, "");
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const bearer = (deps.issueSessionBearer ?? defaultIssueSessionBearer)(env);
  const headers = { authorization: `Bearer ${bearer}`, "x-t3-orchestration-protocol": T3_ORCHESTRATION_PROTOCOL };
  const http = { baseUrl, fetchImpl, headers, timeoutMs };

  const already = await readAutoSettleDisabledAt(threadId, http);
  if (already) return already;

  const ticketRes = await orchestrationHttp(`${baseUrl}/api/auth/websocket-ticket/rpc`, { method: "POST", headers }, http);
  const ticketBody = (await readBody(ticketRes)) as { ticket?: string; reason?: string };
  if (!ticketRes.ok || !ticketBody.ticket) {
    throw new T3Error("credential_rejected", `T3 refused a WebSocket ticket (HTTP ${ticketRes.status}): ${ticketBody.reason ?? "no ticket returned"}`);
  }

  const socketUrl = `${baseUrl.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticketBody.ticket)}&orchestrationProtocol=${T3_ORCHESTRATION_PROTOCOL}`;
  const open = deps.openSocket ?? ((url) => new WebSocket(url) as unknown as T3CommandSocket);
  let socket: T3CommandSocket;
  try {
    socket = open(socketUrl);
  } catch {
    // Not the runtime's message: it can quote the URL, and the URL holds the ticket.
    throw new T3Error("unreachable", "could not open the WebSocket to T3");
  }
  await dispatchOverSocket(socket, { type: "thread.auto-settle.set", commandId: randomUUID(), threadId, enabled: false }, timeoutMs);

  const readBack = await readAutoSettleDisabledAt(threadId, http);
  if (!readBack) throw new T3Error("protocol", `T3 accepted the command, but its read of thread ${threadId} still shows auto-settle on`);
  return readBack;
}

function parseTextContent(content?: Array<{ type: string; text?: string }>): unknown {
  const text = content?.map((c) => c.text ?? "").join("") ?? "";
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The one-line remedy attached to a refused tool call. */
export function remedyForToolError(code?: string): string {
  switch (code) {
    case "thread_not_found":
      return "the thread was deleted or the id is stale; re-read the tree";
    case "invalid_request":
      return "check the arguments the tool documented";
    case "orchestration_error":
      return "T3 could not run the command; read the thread for the run's error item";
    case "unavailable":
      return "T3 is up but the service refused; retry, then check `ob t3 doctor`";
    default:
      return "see the upstream message; `ob t3 doctor` checks the transport";
  }
}

/** Derive the release channel from a version string: `-preview.` / `-nightly.` / else release. */
export function channelForVersion(version: string): string {
  if (version.includes("-preview")) return "preview";
  if (version.includes("-nightly")) return "nightly";
  return "release";
}

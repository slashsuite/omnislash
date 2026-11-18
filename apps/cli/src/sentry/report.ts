// Error reporting to Sentry for the two OmniSlash daemons on the API host (ob 1657): omnislash-web (serve.ts, which
// also hosts /api/ob/*) and the WhatsApp bridge supervisor (`ob whatsapp bridge run`). Errors only: no
// tracing, no profiling, no logs, no breadcrumbs. The timer jobs (sync, backups, alerts) never call this;
// their failure path is the job-failed alerting.
//
// The gate is the DSN. It lives in the ob secret store (never in the repo, never in a unit file), one per
// Sentry project. No DSN, or a secret store that cannot be read, means `@sentry/bun` is never even loaded:
// nothing initialised, nothing sent, and the daemon starts exactly as it did before. Reporting is a bonus
// and must never be the reason a daemon does not start.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultMasterKey, getSecret, hasSecret } from "../secrets.ts";
import type { Store } from "../db/store.ts";
import { scrubEvent } from "./scrub.ts";

export type SentryDaemon = "web" | "bridge";

/** Per daemon: the Sentry project it reports to and the ob secret holding that project's DSN. */
export const SENTRY_DAEMONS: Record<SentryDaemon, { project: string; secret: string }> = {
  web: { project: "omnislash-web", secret: "omnislash-web-sentry-dsn" },
  bridge: { project: "omnislash-whatsapp-bridge", secret: "omnislash-whatsapp-bridge-sentry-dsn" },
};

/** The env var a unit sets to say where this daemon runs (`live`, `dev`). Unset reads as `dev`. */
const SENTRY_ENVIRONMENT_ENV = "OMNISLASH_SENTRY_ENVIRONMENT";
/** Pins the release when set; otherwise it is the git sha of the checkout the process started from. */
const SENTRY_RELEASE_ENV = "SENTRY_RELEASE";

type SentryConfig = { dsn: string; release: string; environment: string };

/** The reporting config, or null when there is no DSN: the one gate for the whole feature. */
function sentryConfigOf(input: {
  dsn: string | null | undefined;
  release: string | null | undefined;
  environment: string | null | undefined;
}): SentryConfig | null {
  const dsn = input.dsn?.trim();
  if (!dsn) return null;
  return {
    dsn,
    release: input.release?.trim() || "unknown",
    environment: input.environment?.trim() || "dev",
  };
}

/** The sha of the checkout this process runs from: what ob-deploy.sh put on disk before the unit started. */
function checkoutSha(cwd: string = fileURLToPath(new URL("../../../..", import.meta.url))): string | null {
  try {
    const out = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 5000 });
    const sha = out.status === 0 ? out.stdout.trim() : "";
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** The slice of `@sentry/bun` this module uses, so a test can stand in for the SDK. */
export interface SentrySdk {
  init(options: Record<string, unknown>): unknown;
  captureException(error: unknown, hint?: { tags?: Record<string, string> }): unknown;
  flush(timeoutMs?: number): Promise<boolean>;
}

export type StartSentryDeps = {
  /** Read the DSN secret; null when it is not there. Defaults to the ob secret store. */
  readDsn?: () => Promise<string | null>;
  env?: Record<string, string | undefined>;
  sha?: () => string | null;
  /** Loads the SDK. Only called once a DSN exists. */
  loadSdk?: () => Promise<SentrySdk>;
};

/** What `startSentry` reports back when reporting is on: never the DSN. */
export type SentryStarted = { project: string; release: string; environment: string };

let active: SentrySdk | null = null;

/** The DSN for a daemon from the ob secret store, or null on any failure (a missing key is not fatal). */
async function readDsnFromStore(openStore: () => Promise<Store>, daemon: SentryDaemon): Promise<string | null> {
  try {
    const store = await openStore();
    const name = SENTRY_DAEMONS[daemon].secret;
    if (!(await hasSecret(store, name))) return null;
    return await getSecret(store, name, defaultMasterKey().get());
  } catch {
    return null;
  }
}

/** The options the SDK is initialised with. */
function sentryOptions(config: SentryConfig): Record<string, unknown> {
  return {
    dsn: config.dsn,
    release: config.release,
    environment: config.environment,
    // Off at the SDK, as well as scrubbed after it: no user, cookies, headers, bodies or query strings.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
    },
    sendDefaultPii: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    beforeSend: scrubEvent,
  };
}

/**
 * Initialise Sentry for `daemon`, when its DSN secret exists. Returns what it reports as, or null when reporting is off. Never throws:
 * a daemon that cannot report still has to serve. Call once, before the daemon starts listening.
 */
export async function startSentry(
  daemon: SentryDaemon,
  openStore: () => Promise<Store>,
  deps: StartSentryDeps = {},
): Promise<SentryStarted | null> {
  try {
    const env = deps.env ?? process.env;
    const dsn = await (deps.readDsn ?? (() => readDsnFromStore(openStore, daemon)))();
    const config = sentryConfigOf({
      dsn,
      release: env[SENTRY_RELEASE_ENV] || (deps.sha ?? checkoutSha)(),
      environment: env[SENTRY_ENVIRONMENT_ENV],
    });
    if (!config) return null;
    const sdk = await (deps.loadSdk ?? (() => import("@sentry/bun") as unknown as Promise<SentrySdk>))();
    sdk.init(sentryOptions(config));
    active = sdk;
    return { project: SENTRY_DAEMONS[daemon].project, release: config.release, environment: config.environment };
  } catch {
    active = null;
    return null;
  }
}

/** Report an error a handler caught. A no-op when reporting is off, and never throws. */
export function reportError(error: unknown, tags: Record<string, string> = {}): void {
  try {
    active?.captureException(error, { tags });
  } catch {
    // Dropped on purpose: a failed report must not turn into a failed request.
  }
}

/** Wait (bounded) for queued events to leave, for a process about to exit. A no-op when reporting is off. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  try {
    await active?.flush(timeoutMs);
  } catch {
    // Same: the exit this precedes matters more than the report.
  }
}

/** Test seam: forget the active SDK. */
export function resetSentryForTest(): void {
  active = null;
}

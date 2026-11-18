import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "../ctx.ts";
import { AppError } from "../errors.ts";
import { print } from "../output.ts";
import { startRealtimeServer, REALTIME_PORT } from "../realtime.ts";
import { WEB_PORT, displayHost, isLoopbackBind, webBindFor, webServeEnv } from "../web-bind.ts";
import { loadWebTls, realtimeUrlFor, tlsPathsFor, webTlsEnv, webUrl } from "../web-tls.ts";
import { summarizeCert, type CertSummary } from "./cert.ts";

// ob web (084) — serve the read-only dashboard (web/) as a foreground, long-running process so the
// launchd `web` job (KeepAlive, RunAtLoad) supervises it: starts at login, relaunches on crash.
// Serves the PRODUCTION build (#11): build-on-start (`bun run build`) → self-host the built output
// with a thin Bun entry (`serve.ts`) that serves dist/client statics then delegates to the SSR
// handler. Build cadence is build-on-start — dist/ is gitignored, so there's never a stale prebuilt
// artifact to drift; each launchd (re)launch rebuilds from source (~a few hundred ms) and always
// matches the code on disk. Port 5050.
// Also hosts the realtime WS sidecar in-process (083) on REALTIME_PORT — it has bun:sqlite + src/.
// Both listeners take the SAME bind address (192): the page and its socket are one deployment, and the
// browser derives the socket host from the page's own origin, so a LAN-served page would otherwise dial
// a sidecar that is not listening there. Loopback by default; see web-bind.ts.
// Both listeners also take the SAME TLS material (220), for the same reason: the page's scheme decides
// the socket's scheme, so https + ws is a page that loads and never updates. TLS is opt-in: not
// configured is plain HTTP, configured is TLS or a refusal to start (1383); see web-tls.ts.
//
// OB-1933: `ob web` warns when the served certificate has fewer than 7 days left, and exits with the
// serve child's code so systemd sees a crashed dashboard as a failure rather than a clean exit.
//
// OB-2160: `ob web --prebuilt` serves the dist already on disk and never builds. The server's unit runs it,
// because building on start put the 6 to 8 s vite build inside every deploy's restart, and the API refused
// connections for all of it. The server's deploy script builds BEFORE it restarts instead. A
// missing dist is a refusal to start, never a quiet build. Plain `ob web` (a laptop, a dev run) still builds.

/** The child-process shape cmdWeb needs from Bun.spawn. */
interface WebChild {
  exited: Promise<number>;
  kill(): void;
}

export interface WebDeps {
  spawn?: (cmd: string[], opts: { cwd: string; env?: Record<string, string | undefined>; stdout: "inherit"; stderr: "inherit" }) => WebChild;
  startRealtime?: (opts: Parameters<typeof startRealtimeServer>[0]) => { stop(): void };
  now?: Date;
  /** The directory holding the apps (`apps/`). Defaults to the apps beside this checkout. `--app <name>` resolves inside it. */
  appsDir?: string;
  /** The dashboard app directory. Defaults to apps/<--app> (apps/dashboard when no --app is given). */
  webDir?: string;
  /** Register (on) and remove (off) a signal handler. Defaults to process.on/process.off. */
  onSignal?: { on(sig: "SIGTERM" | "SIGINT", fn: () => void): void; off(sig: "SIGTERM" | "SIGINT", fn: () => void): void };
}

/** Days below which `ob web` warns at start. Exactly this many does not warn. */
const CERT_WARN_DAYS = 7;

/** The start-up warning for the served certificate, or null when it is not near expiry. */
function certExpiryWarning(certPath: string, summary: CertSummary): string | null {
  if (summary.expired) return `WARNING: TLS certificate ${certPath} EXPIRED on ${summary.notAfter}; run ob cert renew`;
  if (summary.daysLeft < CERT_WARN_DAYS) {
    return `WARNING: TLS certificate ${certPath} expires in ${summary.daysLeft} day(s) (${summary.notAfter}); run ob cert renew`;
  }
  return null;
}

/** The port `--port` names, or WEB_PORT when it is absent. A non-integer or out-of-range value is a refusal. */
export function webPortFor(raw: string | undefined): number {
  if (raw === undefined) return WEB_PORT;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || n < 1 || n > 65535) {
    throw new AppError(`ob web --port: "${raw}" is not a port (1 to 65535)`);
  }
  return n;
}

/** An app name is one directory under apps/: lowercase letters, digits and hyphens, so no path can escape it. */
const APP_NAME = /^[a-z0-9][a-z0-9-]*$/;

export async function cmdWeb(ctx: Ctx, deps: WebDeps = {}): Promise<void> {
  const spawn = deps.spawn ?? ((cmd, opts) => Bun.spawn(cmd, opts));
  const startRealtime = deps.startRealtime ?? startRealtimeServer;
  const signals = deps.onSignal ?? {
    on: (sig, fn) => process.on(sig, fn),
    off: (sig, fn) => process.off(sig, fn),
  };
  const appsDir = deps.appsDir ?? fileURLToPath(new URL("../../../", import.meta.url));
  // OB-2199 step 1: `--app <name>` serves apps/<name> (the default is the dashboard). A name that is not a
  // directory under apps/ is refused by name, before anything is built or bound.
  const appFlag = ctx.flags.app;
  const app = typeof appFlag === "string" ? appFlag : "dashboard";
  if (typeof appFlag === "string" && !APP_NAME.test(appFlag)) {
    throw new AppError(`ob web --app: "${appFlag}" is not an app name (one directory under apps/, lowercase letters, digits and hyphens)`);
  }
  const webDir = deps.webDir ?? join(appsDir, app);
  if (typeof appFlag === "string" && !existsSync(webDir)) {
    throw new AppError(`ob web --app: no app named "${appFlag}" (no directory ${webDir})`);
  }
  if (typeof appFlag === "string" && !existsSync(join(webDir, "serve.ts"))) {
    throw new AppError(`ob web --app: "${appFlag}" is not a served app (no serve.ts in ${webDir})`);
  }
  const port = webPortFor(typeof ctx.flags.port === "string" ? ctx.flags.port : undefined);
  const sidecar = ctx.flags["no-sidecar-port"] !== true;
  // The standalone sidecar holds REALTIME_PORT, so a serve child on that same port could only fail after it started.
  if (sidecar && port === REALTIME_PORT) {
    throw new AppError(`ob web --port ${port}: that is the realtime sidecar's port; pass --no-sidecar-port or another --port`);
  }
  const prebuilt = ctx.flags.prebuilt === true;
  // serve.ts imports dist/server/server.js and serves dist/client: both halves must be there.
  if (prebuilt) {
    const missing = [join(webDir, "dist", "server", "server.js"), join(webDir, "dist", "client")].filter((p) => !existsSync(p));
    if (missing.length > 0) {
      throw new AppError(
        `ob web --prebuilt: no built ${app} at ${join(webDir, "dist")} (missing ${missing.join(", ")}); ` +
          `build it first (bunx moon run ${app}:build) or run plain 'ob web${appFlag === undefined ? "" : ` --app ${app}`}', which builds`,
      );
    }
  }
  const bind = await webBindFor(ctx.store, ctx.flags.bind);
  const host = displayHost(bind);
  // Only `served`: never the installed pair (tls_domain is shared, so every laptop would need a cert).
  const { served } = await tlsPathsFor(ctx.store, {
    certFlag: ctx.flags["tls-cert"],
    keyFlag: ctx.flags["tls-key"],
  });
  // Throws before either listener exists when TLS is configured but cannot be served (1383).
  const tls = loadWebTls(served);
  // An unparseable certificate cannot be served anyway, so summarizeCert's AppError stops the start here.
  const expiryWarning = tls ? certExpiryWarning(tls.certPath, summarizeCert(tls.cert, deps.now ?? new Date())) : null;
  const secure = tls !== null;
  // OB-2199 step 1: `--no-sidecar-port` opens no standalone :5051 listener. The app's own serve.ts mounts
  // its sidecar on its own origin, so the standalone one is only for the default dashboard.
  const rt = sidecar ? startRealtime({ hostname: bind, store: ctx.store, tls }) : null;
  if (rt) print(`realtime: ${realtimeUrlFor(secure, host, REALTIME_PORT)} (pushes on DB change)`);
  if (!isLoopbackBind(bind)) {
    print(
      rt
        ? `bind ${bind}: the ${app} and its sidecar are reachable from any machine that can route here`
        : `bind ${bind}: the ${app} is reachable from any machine that can route here`,
    );
  }
  if (tls) print(`TLS: ${tls.certPath} (key ${tls.keyPath})`);
  // An expired certificate is still served, with the warning: refusing would take the dashboard down for
  // a certificate the daily renew timer is about to replace.
  if (expiryWarning) print(expiryWarning);
  if (prebuilt) {
    print(`serving the prebuilt ${app} in ${join(webDir, "dist")} (no build)`);
  } else {
    print(`building OmniSlash ${app}: ${webDir}`);
    const build = spawn(["bun", "run", "build"], { cwd: webDir, stdout: "inherit", stderr: "inherit" });
    const buildCode = await build.exited;
    if (buildCode !== 0) {
      rt?.stop();
      throw new Error(`${app} build failed (exit ${buildCode}): not serving stale/missing output`);
    }
  }
  print(`serving OmniSlash ${app} (built) → ${webUrl(secure, host, port)}`);
  const proc = spawn(["bun", "run", "serve"], {
    cwd: webDir,
    // The child is handed the PATHS, never the key bytes: it runs as the same user and reads the same
    // files. It is handed them only when this process loaded the material, so serve.ts never has to
    // decide anything about TLS on its own.
    env: { ...process.env, ...webServeEnv(bind, port), ...webTlsEnv(tls) },
    stdout: "inherit",
    stderr: "inherit",
  });
  // forward launchd's stop signal so both the child server and the WS sidecar exit cleanly. `stopping`
  // tells a requested stop (exit 0) from a crash (the child's own code).
  let stopping = false;
  const stop = () => {
    stopping = true;
    rt?.stop();
    proc.kill();
  };
  signals.on("SIGTERM", stop);
  signals.on("SIGINT", stop);
  try {
    const code = await proc.exited;
    if (code !== 0 && !stopping) {
      print(`dashboard server exited ${code}`);
      ctx.exit = code;
    }
  } finally {
    signals.off("SIGTERM", stop);
    signals.off("SIGINT", stop);
    rt?.stop();
  }
}

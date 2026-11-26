import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "../ctx.ts";
import { AppError } from "../errors.ts";
import { print } from "../output.ts";
import { WEB_PORT, displayHost, isLoopbackBind, webBindFor, webServeEnv } from "../web-bind.ts";
import { loadWebTls, tlsPathsFor, webTlsEnv, webUrl } from "../web-tls.ts";
import { summarizeCert, type CertSummary } from "./cert.ts";

// ob web (084) serves the OB dashboard (apps/ob-dashboard) as a foreground, long-running process, so a
// supervisor (the daemon's `web` job, a systemd unit) starts it and relaunches it on a crash. OS-214: bare
// `ob web` serves ob-dashboard; `--app <name>` serves another app under apps/ that has a serve.ts.
//
// It serves the PRODUCTION build (#11): `bun run build` in the app, then the app's `bun run serve`
// (serve.ts), which serves dist/client statics and hands the rest to the SSR handler. dist/ is gitignored,
// so building on start can never serve a stale artifact. Port 5050 unless `--port` says otherwise.
//
// The realtime socket is the app's own: ob-dashboard's serve.ts mounts it on its own origin, so ob web opens
// no second listener (OS-214 retired the standalone :5051 sidecar the personal dashboard dialled). The serve
// child gets the bind address (192, loopback by default, see web-bind.ts) and the TLS paths (220): TLS is
// opt-in, and configured is TLS or a refusal to start (1383), see web-tls.ts.
//
// OB-1933: `ob web` warns when the served certificate has fewer than 7 days left, and exits with the
// serve child's code so systemd sees a crashed dashboard as a failure rather than a clean exit.
//
// OB-2160: `ob web --prebuilt` serves the dist already on disk and never builds, so a deploy builds BEFORE
// it restarts and the restart is down only for the process start. A missing dist is a refusal to start,
// never a quiet build. Plain `ob web` (a laptop, a dev run) still builds.

/** The child-process shape cmdWeb needs from Bun.spawn. */
interface WebChild {
  exited: Promise<number>;
  kill(): void;
}

export interface WebDeps {
  spawn?: (cmd: string[], opts: { cwd: string; env?: Record<string, string | undefined>; stdout: "inherit"; stderr: "inherit" }) => WebChild;
  now?: Date;
  /** The directory holding the apps (`apps/`). Defaults to the apps beside this checkout. `--app <name>` resolves inside it. */
  appsDir?: string;
  /** The served app's directory. Defaults to apps/<--app> (apps/ob-dashboard when no --app is given). */
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

/** The app bare `ob web` serves (OS-214). */
const DEFAULT_WEB_APP = "ob-dashboard";

/** An app name is one directory under apps/: lowercase letters, digits and hyphens, so no path can escape it. */
const APP_NAME = /^[a-z0-9][a-z0-9-]*$/;

export async function cmdWeb(ctx: Ctx, deps: WebDeps = {}): Promise<void> {
  const spawn = deps.spawn ?? ((cmd, opts) => Bun.spawn(cmd, opts));
  const signals = deps.onSignal ?? {
    on: (sig, fn) => process.on(sig, fn),
    off: (sig, fn) => process.off(sig, fn),
  };
  const appsDir = deps.appsDir ?? fileURLToPath(new URL("../../../", import.meta.url));
  // OB-2199 step 1: `--app <name>` serves apps/<name> (the default is ob-dashboard, OS-214). A name that is not a
  // directory under apps/ is refused by name, before anything is built or bound.
  const appFlag = ctx.flags.app;
  const app = typeof appFlag === "string" ? appFlag : DEFAULT_WEB_APP;
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
  if (!isLoopbackBind(bind)) print(`bind ${bind}: the ${app} is reachable from any machine that can route here`);
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
  // forward the supervisor's stop signal so the child server exits cleanly. `stopping`
  // tells a requested stop (exit 0) from a crash (the child's own code).
  let stopping = false;
  const stop = () => {
    stopping = true;
    proc.kill();
  };
  signals.on("SIGTERM", stop);
  signals.on("SIGINT", stop);
  try {
    const code = await proc.exited;
    if (code !== 0 && !stopping) {
      print(`${app} server exited ${code}`);
      ctx.exit = code;
    }
  } finally {
    signals.off("SIGTERM", stop);
    signals.off("SIGINT", stop);
  }
}

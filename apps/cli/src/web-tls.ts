import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "./errors.ts";
import { settingFor } from "./settings.ts";
import type { Store } from "./db/store.ts";

// ob 220: TLS for `ob web`, on the LAN.
//
// WHY AT ALL: the dashboard is served from the always-on server's LAN address over plain HTTP (192),
// so anything typed into a page crosses the house network in cleartext. ob 219 wants a page you can
// paste a token into, and a pasted token is exactly the thing that must not travel that way.
//
// WHAT THIS MODULE IS: the resolution and the loading, kept away from both listeners so the same
// answer serves the dashboard (:5050) and the realtime sidecar (:5051). It reads files and it decides;
// it never issues, renews or writes anything (`ob cert` does that).
//
// TWO OUTCOMES, and never a third (ob 1383, the owner's call: a configured TLS install never serves
// cleartext):
//   - NOT CONFIGURED -> plain HTTP, no warning, no error. This is a laptop, and the absence of a
//                       certificate is not a fault. Nothing about a loopback install changes.
//   - CONFIGURED     -> TLS, or a hard error that stops `ob web`. A certificate or key that is ABSENT
//                       (not issued yet) is refused exactly like one that is UNUSABLE (empty, not PEM,
//                       a directory, a key a stranger can read). There used to be a third state,
//                       "configured but absent = plain HTTP with a warning", and it is gone on purpose:
//                       a warning on stderr is read by nobody, the downgrade lands on the one page that
//                       takes a credential, and on 2026-10-19 it was also the state that crashed the
//                       dashboard (the warning left the env set and serve.ts read a missing file).
//                       Configuring TLS is the decision; issuing the certificate (`ob cert renew`)
//                       comes BEFORE configuring it, not after.

export const WEB_TLS_CERT_ENV = "OMNISLASH_WEB_TLS_CERT";
export const WEB_TLS_KEY_ENV = "OMNISLASH_WEB_TLS_KEY";

export interface WebTlsPaths {
  /** The full chain (leaf + intermediates), PEM. Public material. */
  certPath: string;
  /** The private key, PEM. Secret material, mode 0600. */
  keyPath: string;
}

export interface WebTlsMaterial extends WebTlsPaths {
  cert: string;
  key: string;
}

export interface WebTlsSources {
  certFlag?: string | null;
  keyFlag?: string | null;
  certEnv?: string | null;
  keyEnv?: string | null;
  certConfigured?: string | null;
  keyConfigured?: string | null;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

/** Which source supplied the served pair (OB-1933): the flag, the env pair, or the config rows. */
export type WebTlsSource = "flag" | "env" | "config";

/**
 * `--tls-cert`/`--tls-key` > the env pair > the `web_tls_cert`/`web_tls_key` config rows > nothing,
 * plus the source that won (the certificate's half decides it; the key's half is resolved the same way).
 *
 * The two halves are resolved as ONE decision rather than independently: a certificate with no key (or
 * the reverse) cannot serve anything, and silently ignoring the half that was set would turn a typo
 * into plain HTTP on a page that was meant to be encrypted. So half a pair is a usage error.
 */
function resolveWebTlsSource(
  sources: WebTlsSources = {},
): { paths: WebTlsPaths; source: WebTlsSource } | null {
  const certFlag = clean(sources.certFlag);
  const certEnv = clean(sources.certEnv);
  const certPath = certFlag ?? certEnv ?? clean(sources.certConfigured);
  const keyPath = clean(sources.keyFlag) ?? clean(sources.keyEnv) ?? clean(sources.keyConfigured);
  if (certPath === null && keyPath === null) return null;
  if (certPath === null || keyPath === null) {
    throw new AppError(
      `TLS is half configured: ${certPath === null ? "a key" : "a certificate"} was given with no ${certPath === null ? "certificate" : "key"}. ` +
        `Set both (--tls-cert/--tls-key, ${WEB_TLS_CERT_ENV}/${WEB_TLS_KEY_ENV}, or the web_tls_cert/web_tls_key config rows) or neither`,
    );
  }
  const source: WebTlsSource = certFlag !== null ? "flag" : certEnv !== null ? "env" : "config";
  return { paths: { certPath, keyPath }, source };
}

/** The served pair alone; see resolveWebTlsSource. */
export function resolveWebTlsPaths(sources: WebTlsSources = {}): WebTlsPaths | null {
  return resolveWebTlsSource(sources)?.paths ?? null;
}

/** Where `ob cert renew` INSTALLS the issued material. Stable paths, so the units and the config rows
 *  never carry a domain name. (Moved here from commands/cert.ts by OB-1933; re-exported there.) */
export function installedCertPaths(dir: string): WebTlsPaths {
  return { certPath: join(dir, "fullchain.pem"), keyPath: join(dir, "privkey.pem") };
}

/** The `tls_dir` default: an empty row means this directory, for every caller (OB-1933). */
export const DEFAULT_TLS_DIR = "/etc/omnislash/tls";

export interface TlsPaths {
  /** What `ob web` serves on this machine: flag > env > config rows, or null (plain HTTP). */
  served: WebTlsPaths | null;
  servedSource: WebTlsSource | null;
  /** Where `ob cert renew` installs, when `tls_domain` is set; null otherwise. */
  installed: WebTlsPaths | null;
}

/**
 * The ONE place the TLS paths are computed (OB-1933). `ob web`, `ob cert status`, `ob cert renew` and
 * the backup's key exclusion all ask here, so `cert status` can no longer report a file nobody serves.
 *
 * `served` and `installed` are kept apart on purpose. `ob web` serves ONLY `served` and never falls back
 * to `installed`: `tls_domain` lives in the SHARED config, so every laptop sees it, and a fallback would
 * make every laptop's dashboard demand a certificate it does not have.
 */
export async function tlsPathsFor(
  store: Store,
  flags: { certFlag?: string | null; keyFlag?: string | null } = {},
  env: Record<string, string | undefined> = process.env,
): Promise<TlsPaths> {
  const resolved = resolveWebTlsSource({
    certFlag: flags.certFlag,
    keyFlag: flags.keyFlag,
    certEnv: env[WEB_TLS_CERT_ENV] ?? null,
    keyEnv: env[WEB_TLS_KEY_ENV] ?? null,
    certConfigured: await settingFor(store, "web_tls_cert"),
    keyConfigured: await settingFor(store, "web_tls_key"),
  });
  return {
    served: resolved?.paths ?? null,
    servedSource: resolved?.source ?? null,
    installed: await installedTlsPathsFor(store),
  };
}

/** The installed half alone. Needs no flag or env, so it never throws on a half-configured pair. */
export async function installedTlsPathsFor(store: Store): Promise<WebTlsPaths | null> {
  if ((await settingFor(store, "tls_domain")).trim() === "") return null;
  return installedCertPaths((await settingFor(store, "tls_dir")).trim() || DEFAULT_TLS_DIR);
}

/** The effective TLS paths for a live invocation: the flags, the env pair, then the config rows. */
export async function webTlsPathsFor(
  store: Store,
  flags: { certFlag?: string | null; keyFlag?: string | null } = {},
  env: Record<string, string | undefined> = process.env,
): Promise<WebTlsPaths | null> {
  return (await tlsPathsFor(store, flags, env)).served;
}

/** The problem with a private key's mode, or null. Group or other bits are the problem (ob 182). */
export function keyModeProblem(path: string): string | null {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) === 0) return null;
  return (
    `the TLS private key ${path} has mode 0${mode.toString(8)}, which is readable beyond its owner. ` +
    `Fix it with: chmod 600 ${path}`
  );
}

/** True when the key is the certificate's own private key. Throws when either does not parse. */
export function pairMatches(certPem: string, keyPem: string): boolean {
  return new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem));
}

/** True when the file is there AND is a regular file. A directory at the path is NOT "absent". */
function presentAsFile(path: string): { present: boolean; regular: boolean } {
  try {
    return { present: true, regular: statSync(path).isFile() };
  } catch {
    return { present: false, regular: false };
  }
}

function readOrThrow(path: string, what: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new AppError(`cannot read the TLS ${what} at ${path}: ${(err as Error).message}`);
  }
  if (text.trim() === "") throw new AppError(`the TLS ${what} at ${path} is empty`);
  if (!text.includes("-----BEGIN")) {
    throw new AppError(`the TLS ${what} at ${path} is not PEM (no -----BEGIN block)`);
  }
  return text;
}

/**
 * Load the material named by `paths`: null when TLS is not configured, the material when it is, and an
 * AppError for every configured path that cannot be served. See the module header for why there is no
 * fallback to plain HTTP.
 *
 * The key's permissions are checked the way ob 182 checks the master key's: group or other bits on a
 * private key mean anyone with an account on the box can impersonate the dashboard, and a mode nobody
 * looks at is a mode that stays wrong.
 */
export function loadWebTls(paths: WebTlsPaths | null): WebTlsMaterial | null {
  if (!paths) return null;
  const cert = presentAsFile(paths.certPath);
  const key = presentAsFile(paths.keyPath);
  if (!cert.present || !key.present) {
    const missing = [!cert.present ? paths.certPath : null, !key.present ? paths.keyPath : null].filter(Boolean);
    throw new AppError(
      `TLS is configured but ${missing.join(" and ")} ${missing.length > 1 ? "do" : "does"} not exist, ` +
        `so \`ob web\` will not start: a configured TLS install never serves plain HTTP. ` +
        `Issue the certificate with \`ob cert renew\` and check it with \`ob cert status\``,
    );
  }
  if (!cert.regular) throw new AppError(`the TLS certificate path ${paths.certPath} is not a regular file`);
  if (!key.regular) throw new AppError(`the TLS key path ${paths.keyPath} is not a regular file`);
  const modeProblem = keyModeProblem(paths.keyPath);
  if (modeProblem) throw new AppError(modeProblem);
  const certPem = readOrThrow(paths.certPath, "certificate");
  const keyPem = readOrThrow(paths.keyPath, "private key");
  // OB-1933: a key that is not the certificate's own cannot complete a handshake, so serving it fails
  // silently in every browser. `ob cert renew` installs the key first and the cert last; a crash between
  // the two renames leaves exactly this state, and refusing here names the fix.
  let matches: boolean;
  try {
    matches = pairMatches(certPem, keyPem);
  } catch (err) {
    throw new AppError(
      `the TLS certificate ${paths.certPath} or key ${paths.keyPath} does not parse (${(err as Error).message}). ` +
        `Reissue the pair with \`ob cert renew\``,
    );
  }
  if (!matches) {
    throw new AppError(
      `the TLS key ${paths.keyPath} does not belong to the certificate ${paths.certPath}, so no browser could ` +
        `complete a handshake. Reinstall the pair with \`ob cert renew\``,
    );
  }
  return { ...paths, cert: certPem, key: keyPem };
}

/** `https` exactly when a listener has material to serve it with. */
export function webScheme(tls: boolean): "http" | "https" {
  return tls ? "https" : "http";
}

/** The URL to print for a listener, so the scheme in the message is the scheme on the wire. */
export function webUrl(tls: boolean, host: string, port: number): string {
  return `${webScheme(tls)}://${host}:${port}`;
}

/** The socket URL to print, matched to the page's scheme the way the browser derives it (realtimeUrl.ts). */
export function realtimeUrlFor(tls: boolean, host: string, port: number): string {
  return `${tls ? "wss" : "ws"}://${host}:${port}`;
}

/** The env the dashboard's own Bun server (apps/dashboard/serve.ts) reads for its TLS material. */
export function webTlsEnv(paths: WebTlsPaths | null): Record<string, string> {
  return paths ? { [WEB_TLS_CERT_ENV]: paths.certPath, [WEB_TLS_KEY_ENV]: paths.keyPath } : {};
}

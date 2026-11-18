import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { sqliteStoreFor } from "../db/store.ts";
import { print } from "../output.ts";
import { defaultMasterKey, getSecret } from "../secrets.ts";
import { settingFor, settingNumFor } from "../settings.ts";
import {
  DEFAULT_TLS_DIR,
  installedCertPaths,
  installedTlsPathsFor,
  keyModeProblem,
  pairMatches,
  tlsPathsFor,
  type WebTlsPaths,
} from "../web-tls.ts";

// OB-1933: the installed paths are computed in web-tls.ts with every other TLS path; re-exported here
// so existing imports keep working.
export { installedCertPaths };

// -----------------------------------------------------------------------------
// `ob cert` (220): the LAN certificate the dashboard serves.
//
// WHY LET'S ENCRYPT AND NOT A SELF-SIGNED CERTIFICATE, since a self-signed one needs no ACME client, no
// DNS provider and no renewal at all: because the page this exists for is the tokens page (219), and a
// self-signed certificate teaches "click through the warning" on the one page that holds every
// credential. That habit is worth less than the encryption is worth. A phone is the other half of it:
// the dashboard is opened from a phone, and installing a private CA on iOS is a profile, a Settings
// dive and a trust toggle per device, redone whenever the CA is rotated.
//
// WHY DNS-01, since the box is not reachable from the internet: because DNS-01 is the challenge that
// does not need it. HTTP-01 and TLS-ALPN-01 both require Let's Encrypt to CONNECT INWARDS to port 80 or
// 443, which would mean opening the house to the internet to secure a service that never leaves it, and
// ob 184's tunnel deliberately carries ssh for three named targets and nothing else. DNS-01 proves the
// name by writing a TXT record through the Cloudflare API, outbound only, and the credential for it
// (`cloudflare-api-token`) is already in the encrypted store for the domain the house already runs.
//
// WHY AN EXTERNAL ACME CLIENT AND NOT ACME IN THIS CODEBASE: an ACME implementation is JWS signing,
// nonce handling, order polling, retry and account-key custody, all of it security-critical and all of
// it a solved problem. lego is one Go binary, packaged in Debian, driven entirely by argv and two
// environment variables. The seam is `lego_bin`, so a newer upstream binary can be dropped in without a
// code change.
//
// WHAT NEVER HAPPENS HERE: no DNS record is created by ob (lego writes and deletes the _acme-challenge
// TXT itself), no A record is published (the name resolves through Pi-hole Local DNS, LAN only), and
// the private key never leaves the box, never enters the database and never enters the backup artifact.
// -----------------------------------------------------------------------------

/** Where lego keeps its own account key + issued material. Its layout, not ours; we copy out of it. */
export function legoPaths(dir: string, domain: string): { accountDir: string; certPath: string; keyPath: string } {
  const accountDir = join(dir, "lego");
  return {
    accountDir,
    certPath: join(accountDir, "certificates", `${domain}.crt`),
    keyPath: join(accountDir, "certificates", `${domain}.key`),
  };
}

export interface LegoOptions {
  domain: string;
  email: string;
  /** lego's own storage root (--path). */
  accountDir: string;
  /** Renew when fewer than this many days remain. Ignored by the first issuance. */
  renewDays: number;
  /** true once lego already holds material for this domain: `renew` rather than `run`. */
  haveCert: boolean;
  /** Force a renewal even when the certificate is not near expiry. */
  force?: boolean;
  /** Use Let's Encrypt's staging CA: untrusted material, real rate limits avoided. For rehearsals. */
  staging?: boolean;
}

const STAGING_CA = "https://acme-staging-v02.api.letsencrypt.org/directory";
/** Wider than any certificate's lifetime, so `--force` always falls inside lego's renewal window. */
const FORCE_RENEW_DAYS = 3650;

/**
 * The lego invocation, as data. Pure, so the flags that matter (the challenge type, the CA, the renewal
 * window) are asserted in a test rather than discovered at 03:40 on the box.
 *
 * `--dns cloudflare` reads CF_DNS_API_TOKEN from the environment; the token is never an argument, so it
 * never appears in `ps` or in a journal line.
 */
export function legoArgs(opts: LegoOptions): string[] {
  const args = ["--accept-tos", "--email", opts.email, "--domains", opts.domain, "--dns", "cloudflare", "--path", opts.accountDir];
  if (opts.staging) args.push("--server", STAGING_CA);
  if (opts.haveCert) {
    // lego renews when FEWER than `--days` remain, so --force is expressed as a window wider than any
    // certificate's lifetime rather than as a separate flag. One documented behaviour instead of two,
    // and it cannot be a flag this version of lego does not have.
    args.push("renew", "--days", String(opts.force ? FORCE_RENEW_DAYS : opts.renewDays));
    // The timer fires daily and most days there is nothing to do; without this every box on the
    // internet running the same client would hit the CA in the same minute.
    args.push("--no-random-sleep");
  } else {
    args.push("run");
  }
  return args;
}

export interface CertSummary {
  subject: string;
  sans: string[];
  issuer: string;
  notBefore: string;
  notAfter: string;
  daysLeft: number;
  expired: boolean;
}

/** Read a PEM chain's leaf. Pure (takes the text), so the expiry arithmetic is testable with a
 *  throwaway certificate and never needs a real one. */
export function summarizeCert(pem: string, now: Date = new Date()): CertSummary {
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(pem);
  } catch (err) {
    throw new AppError(`could not parse the certificate: ${(err as Error).message}`);
  }
  const notAfter = new Date(x509.validTo);
  const daysLeft = Math.floor((notAfter.getTime() - now.getTime()) / 86_400_000);
  return {
    subject: x509.subject.replace(/\n/g, ", "),
    sans: (x509.subjectAltName ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^DNS:/, ""))
      .filter((s) => s.length > 0),
    issuer: x509.issuer.split("\n").find((l) => l.startsWith("O=")) ?? x509.issuer.replace(/\n/g, ", "),
    notBefore: new Date(x509.validFrom).toISOString(),
    notAfter: notAfter.toISOString(),
    daysLeft,
    expired: notAfter.getTime() <= now.getTime(),
  };
}

interface CertConfig {
  domain: string;
  email: string;
  dir: string;
  renewDays: number;
  legoBin: string;
}

/** The five config rows, through the store (1615): under Postgres `ctx.db` is the stand-in handle, and
 *  reading the rows off it is what made `ob cert` refuse on the API host after the cutover. */
async function certConfig(ctx: Ctx): Promise<CertConfig | null> {
  const store = ctx.store ?? ctx.db;
  const domain = (await settingFor(store, "tls_domain")).trim();
  if (domain === "") return null;
  return {
    domain,
    email: (await settingFor(store, "tls_email")).trim(),
    dir: (await settingFor(store, "tls_dir")).trim() || DEFAULT_TLS_DIR,
    renewDays: await settingNumFor(store, "tls_renew_days"),
    legoBin: (await settingFor(store, "lego_bin")).trim() || "lego",
  };
}

/**
 * Write `contents` at `path` with `mode`, through a temp file in the same directory, and say whether
 * the bytes changed. Same-directory so the rename is atomic: a reader (the running dashboard, or the
 * .path unit watching for a change) never sees a half-written key.
 */
export function installMaterial(path: string, contents: string, mode: number): boolean {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  if (existing === contents) return false;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  return true;
}

/**
 * Install a cert/key pair as two regular files at their stable paths (OB-1933). Not a symlink swap of a
 * directory: omnislash-cert-reload.path watches PathChanged on fullchain.pem, and a swapped directory never
 * fires it.
 *
 * KEY FIRST, CERT LAST. The cert's rename is the event that restarts the dashboard, so it must be the
 * final write. Accepted window: a crash between the two renames leaves the new key beside the old cert.
 * If the dashboard restarts before the next renew, `ob web` refuses the mismatched pair (loadWebTls)
 * until `ob cert renew` runs; installMaterial rewrites any file whose bytes differ from lego's copy, so
 * that next run repairs it. Refusing is the honest outcome: a mismatched pair cannot complete a TLS
 * handshake anyway, and the refusal names the fix where serving would fail silently in every browser.
 */
export function installPair(
  paths: WebTlsPaths,
  certPem: string,
  keyPem: string,
  install: typeof installMaterial = installMaterial,
): { keyChanged: boolean; certChanged: boolean } {
  const keyChanged = install(paths.keyPath, keyPem, 0o600);
  const certChanged = install(paths.certPath, certPem, 0o644);
  return { keyChanged, certChanged };
}

/** The Cloudflare API token for the DNS-01 challenge: the environment first (a wrapper may have set
 *  it), then the encrypted store. Read into a variable, handed to the child, never printed. */
async function cloudflareToken(ctx: Ctx): Promise<string> {
  const fromEnv = (process.env.CF_DNS_API_TOKEN ?? "").trim();
  if (fromEnv !== "") return fromEnv;
  const value = (
    (await getSecret(ctx.store ?? sqliteStoreFor(ctx.db), "cloudflare-api-token", defaultMasterKey().get())) ?? ""
  ).trim();
  if (value === "") {
    throw new AppError(
      "no `cloudflare-api-token` in the secret store, so the DNS-01 challenge cannot write its TXT record. " +
        "Store it with `ob secret set cloudflare-api-token` (it needs Zone:DNS:Edit and Zone:Zone:Read on the zone)",
    );
  }
  return value;
}

export interface CertStatusReport {
  /** Every reason the pair cannot be served healthily, one line each. Empty = healthy. */
  problems: string[];
  summary: CertSummary | null;
  /** The key's permission bits, or null when the key is absent. */
  keyMode: number | null;
  /** Whether the key is the certificate's own, or null when it could not be checked. */
  pairMatches: boolean | null;
}

/**
 * What `ob cert status` knows about one pair, as data (OB-1933). Pure apart from reading the two files,
 * and it never throws: a broken install is exactly what status exists to report. Shares its low-level
 * checks with loadWebTls (keyModeProblem, pairMatches) so the two cannot disagree about a pair.
 */
export function certStatusReport(paths: WebTlsPaths, now: Date = new Date()): CertStatusReport {
  const problems: string[] = [];
  const read = (path: string): string | null => {
    try {
      return statSync(path).isFile() ? readFileSync(path, "utf8") : null;
    } catch {
      return null;
    }
  };
  const certPem = read(paths.certPath);
  const keyPem = read(paths.keyPath);
  let summary: CertSummary | null = null;
  if (certPem === null) {
    problems.push(`certificate missing: ${paths.certPath} (issue it with \`ob cert renew\`)`);
  } else {
    try {
      summary = summarizeCert(certPem, now);
      if (summary.expired) problems.push(`certificate EXPIRED on ${summary.notAfter}: every browser will refuse it`);
    } catch (err) {
      problems.push(`certificate does not parse: ${(err as Error).message}`);
    }
  }
  let keyMode: number | null = null;
  if (keyPem === null) {
    problems.push(`key missing: ${paths.keyPath}`);
  } else {
    keyMode = statSync(paths.keyPath).mode & 0o777;
    const modeProblem = keyModeProblem(paths.keyPath);
    if (modeProblem) problems.push(modeProblem);
  }
  let matches: boolean | null = null;
  if (summary !== null && keyPem !== null) {
    try {
      matches = pairMatches(certPem!, keyPem);
    } catch (err) {
      problems.push(`key does not parse: ${(err as Error).message}`);
    }
    if (matches === false) {
      problems.push(`key ${paths.keyPath} does not belong to certificate ${paths.certPath} (reinstall with \`ob cert renew\`)`);
    }
  }
  return { problems, summary, keyMode, pairMatches: matches };
}

const samePaths = (a: WebTlsPaths, b: WebTlsPaths): boolean => a.certPath === b.certPath && a.keyPath === b.keyPath;

async function certStatus(ctx: Ctx, now: Date = new Date()): Promise<void> {
  const store = ctx.store ?? ctx.db;
  const { served, servedSource, installed } = await tlsPathsFor(store, {
    certFlag: ctx.flags["tls-cert"],
    keyFlag: ctx.flags["tls-key"],
  });
  const paths = served ?? installed;
  if (!paths) {
    if (ctx.mode === "json") {
      print(JSON.stringify({ configured: false, paths_agree: true, ok: true, problems: [] }, null, 2));
      return;
    }
    print("TLS is not configured on this machine (no `tls_domain` and no served pair), so `ob web` serves plain HTTP.");
    return;
  }
  const domain = (await settingFor(store, "tls_domain")).trim() || null;
  const renewDays = await settingNumFor(store, "tls_renew_days");
  const source = served ? servedSource! : "tls_dir (not served by ob web on this machine)";
  const report = certStatusReport(paths, now);
  const pathsAgree = served === null || installed === null || samePaths(served, installed);
  const problems = [...report.problems];
  if (!pathsAgree) {
    problems.push(
      `ob web serves ${served!.certPath} but ob cert renew installs ${installed!.certPath}: renewals never reach the dashboard`,
    );
  }
  const ok = problems.length === 0;
  if (!ok) ctx.exit = 1;
  if (ctx.mode === "json") {
    print(
      JSON.stringify(
        {
          configured: true,
          domain,
          source,
          certPath: paths.certPath,
          keyPath: paths.keyPath,
          issued: report.summary !== null,
          keyMode: report.keyMode?.toString(8) ?? null,
          pairMatches: report.pairMatches,
          renewDays,
          ...(report.summary ?? {}),
          paths_agree: pathsAgree,
          ok,
          problems,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (domain) print(`domain:   ${domain}`);
  print(`source:   ${source}`);
  if (report.summary) {
    const s = report.summary;
    print(`subject:  ${s.subject}`);
    print(`names:    ${s.sans.join(", ") || "(none)"}`);
    print(`issuer:   ${s.issuer}`);
    print(`expires:  ${s.notAfter} (${s.daysLeft} day(s) left, renews at ${renewDays})`);
  }
  print(`cert:     ${paths.certPath}`);
  print(`key:      ${paths.keyPath}${report.keyMode === null ? " (MISSING)" : ` (mode 0${report.keyMode.toString(8)})`}`);
  if (!pathsAgree) print(`installed: ${installed!.certPath} (key ${installed!.keyPath})`);
  for (const p of problems) print(`PROBLEM: ${p}`);
  if (ok) print("ok");
}

async function certRenew(ctx: Ctx): Promise<void> {
  const cfg = await certConfig(ctx);
  if (!cfg) {
    // The renewal is a DECLARED job (218), so it runs wherever the fleet runs, including a laptop that
    // has no certificate and wants none. On such a machine there is nothing to renew and that is not a
    // failure: exiting non-zero here would raise a JOB FAILING alert every day for a working laptop.
    print("TLS is not configured on this machine (no `tls_domain`); nothing to renew.");
    return;
  }
  if (cfg.email === "") {
    throw new AppError(
      "no `tls_email` configured, and Let's Encrypt requires an account contact. Set it with `ob config set tls_email <you@example.com>`",
    );
  }
  const lego = legoPaths(cfg.dir, cfg.domain);
  mkdirSync(lego.accountDir, { recursive: true, mode: 0o700 });
  const args = legoArgs({
    domain: cfg.domain,
    email: cfg.email,
    accountDir: lego.accountDir,
    renewDays: cfg.renewDays,
    haveCert: existsSync(lego.certPath),
    force: ctx.flags.force,
    staging: ctx.flags.staging,
  });
  print(`${cfg.legoBin} ${args.join(" ")}`);
  const cfToken = await cloudflareToken(ctx);
  const proc = Bun.spawnSync({
    cmd: [cfg.legoBin, ...args],
    // The token exists in this child's environment and nowhere else: not in a file, not in a unit, not
    // in an argument and so not in `ps`, and nothing here echoes it. The tradeoff, stated the way ob 186
    // stated it for the GitHub token: while lego runs, root and the `ob` user can read it out of
    // /proc/<pid>/environ. That is the exposure any credential a process actually uses has.
    env: { ...process.env, CF_DNS_API_TOKEN: cfToken },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    throw new AppError(
      `${cfg.legoBin} exited ${proc.exitCode} (see its output above). The certificate on disk is unchanged`,
    );
  }
  if (!existsSync(lego.certPath) || !existsSync(lego.keyPath)) {
    throw new AppError(
      `${cfg.legoBin} reported success but left no material at ${lego.certPath}. Nothing was installed`,
    );
  }
  // The resolver's installed pair (OB-1933): the same answer `ob cert status` and the backup use.
  const installed = (await installedTlsPathsFor(ctx.store ?? ctx.db)) ?? installedCertPaths(cfg.dir);
  const { keyChanged, certChanged } = installPair(installed, readFileSync(lego.certPath, "utf8"), readFileSync(lego.keyPath, "utf8"));
  const changed = certChanged || keyChanged;
  if (ctx.mode === "json") {
    print(JSON.stringify({ domain: cfg.domain, changed, ...installed }, null, 2));
    return;
  }
  print(
    changed
      ? `installed a new certificate for ${cfg.domain} → ${installed.certPath} (the dashboard picks it up on restart)`
      : `${cfg.domain} is not due for renewal; the installed certificate is unchanged`,
  );
}

/** `ob cert status | renew`. */
export async function cmdCert(ctx: Ctx, deps: { now?: Date } = {}): Promise<void> {
  const sub = ctx.args[0] ?? "status";
  if (sub === "status") return await certStatus(ctx, deps.now);
  if (sub === "renew") return await certRenew(ctx);
  throw new UsageError(`unknown cert subcommand '${sub}' (status|renew)`);
}

import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";
import {
  WEB_TLS_CERT_ENV,
  WEB_TLS_KEY_ENV,
  loadWebTls,
  realtimeUrlFor,
  resolveWebTlsPaths,
  webScheme,
  webTlsEnv,
  webTlsPathsFor,
  webUrl,
  installedCertPaths,
} from "../../../apps/cli/src/web-tls.ts";
import { installMaterial, legoArgs, legoPaths, summarizeCert } from "../../../apps/cli/src/commands/cert.ts";

// -----------------------------------------------------------------------------
// TLS for the dashboard (220).
//
// Everything here is assertable WITHOUT issuing a certificate: no ACME, no Cloudflare, no DNS, no
// network of any kind. The one place real TLS material is needed (parsing an expiry) generates a
// throwaway self-signed certificate into a temp directory with `openssl` and deletes it in afterEach,
// and skips itself rather than failing where openssl is absent.
// -----------------------------------------------------------------------------

const dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ob-web-tls-"));
  dirs.push(d);
  return d;
}

/** A cert/key PAIR of the right SHAPE (PEM headers, 0600 key). Not valid material, and never needs to
 *  be: everything in the resolution layer is about paths, presence and permissions. */
function pemPair(dir: string, keyMode = 0o600): { certPath: string; keyPath: string } {
  const certPath = join(dir, "fullchain.pem");
  const keyPath = join(dir, "privkey.pem");
  writeFileSync(certPath, "-----BEGIN CERTIFICATE-----\nnot-a-real-certificate\n-----END CERTIFICATE-----\n");
  writeFileSync(keyPath, "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n");
  chmodSync(keyPath, keyMode);
  return { certPath, keyPath };
}

// OB-1933: loadWebTls now checks the key belongs to the cert, so a test that expects it to SUCCEED needs
// a real pair. Generated with openssl; those tests skip where openssl is absent.
const haveOpenssl = Bun.spawnSync({ cmd: ["which", "openssl"], stdout: "pipe", stderr: "pipe" }).exitCode === 0;

function realPair(dir: string, keyMode = 0o600): { certPath: string; keyPath: string } {
  const certPath = join(dir, "fullchain.pem");
  const keyPath = join(dir, "privkey.pem");
  const gen = Bun.spawnSync({
    cmd: ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "30", "-subj", "/CN=ob.example.invalid"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (gen.exitCode !== 0) throw new Error("openssl failed");
  chmodSync(keyPath, keyMode);
  return { certPath, keyPath };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("no certificate is not an error, the laptop path", () => {
  test("nothing configured anywhere resolves to null and loads to plain HTTP", () => {
    expect(resolveWebTlsPaths()).toBeNull();
    expect(resolveWebTlsPaths({ certEnv: "", keyEnv: "   ", certConfigured: "", keyConfigured: "" })).toBeNull();
    expect(loadWebTls(null)).toBeNull();
  });

  test("a fresh database has no TLS rows, so `ob web` is unchanged by this ticket", async () => {
    const db = freshDb();
    await expect(webTlsPathsFor(sqliteStoreFor(db), {}, {})).resolves.toBeNull();
    expect((await webTlsPathsFor(sqliteStoreFor(db), {}, {}))).toBeNull();
    expect(loadWebTls(await webTlsPathsFor(sqliteStoreFor(db), {}, {}))).toBeNull();
    expect(webUrl(false, "127.0.0.1", 5050)).toBe("http://127.0.0.1:5050");
  });

  test("the child server is handed no TLS env at all when there is no material", () => {
    expect(webTlsEnv(null)).toEqual({});
  });
});

describe("configured but not issued, a refusal and never a fall back to plain HTTP (1383)", () => {
  test("an absent certificate refuses to start, naming the path and the fix", () => {
    const dir = tmpDir();
    const paths = { certPath: join(dir, "fullchain.pem"), keyPath: join(dir, "privkey.pem") };
    expect(() => loadWebTls(paths)).toThrow(AppError);
    expect(() => loadWebTls(paths)).toThrow(paths.certPath);
    expect(() => loadWebTls(paths)).toThrow(/ob cert renew/);
    expect(() => loadWebTls(paths)).toThrow(/ob cert status/);
    expect(() => loadWebTls(paths)).toThrow(/never serves plain HTTP/);
  });

  test("the refusal names both halves when both are missing, and only the missing one otherwise", () => {
    const dir = tmpDir();
    const { keyPath } = pemPair(dir);
    const absentCert = join(dir, "nope.pem");
    const msg = (paths: { certPath: string; keyPath: string }): string => {
      try {
        loadWebTls(paths);
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error("expected loadWebTls to refuse");
    };
    const one = msg({ certPath: absentCert, keyPath });
    expect(one).toContain(absentCert);
    expect(one).not.toContain(keyPath);
    const both = msg({ certPath: absentCert, keyPath: join(dir, "gone.pem") });
    expect(both).toContain(" and ");
  });

  test("an absent cert configured by ENV or by config row refuses the same way as by flag", async () => {
    const dir = tmpDir();
    const certPath = join(dir, "fullchain.pem");
    const keyPath = join(dir, "privkey.pem");
    const fromEnv = await webTlsPathsFor(sqliteStoreFor(freshDb()), {}, { [WEB_TLS_CERT_ENV]: certPath, [WEB_TLS_KEY_ENV]: keyPath });
    expect(() => loadWebTls(fromEnv)).toThrow(/does not exist|do not exist/);
    const db = freshDb();
    await setConfig(db, "web_tls_cert", certPath);
    await setConfig(db, "web_tls_key", keyPath);
    const fromRow = await webTlsPathsFor(sqliteStoreFor(db), {}, {});
    expect(() => loadWebTls(fromRow)).toThrow(/does not exist|do not exist/);
  });
});

describe("configured and unusable, a broken deployment is never a quiet downgrade", () => {
  test("an empty file, a non-PEM file and a directory are all errors, not HTTP", () => {
    const dir = tmpDir();
    const { certPath, keyPath } = pemPair(dir);

    writeFileSync(certPath, "");
    expect(() => loadWebTls({ certPath, keyPath })).toThrow(/is empty/);

    writeFileSync(certPath, "just some text\n");
    expect(() => loadWebTls({ certPath, keyPath })).toThrow(/is not PEM/);

    const dirAsCert = join(dir, "a-directory.pem");
    mkdirSync(dirAsCert);
    expect(() => loadWebTls({ certPath: dirAsCert, keyPath })).toThrow(/not a regular file/);
  });

  test("a private key readable beyond its owner is refused, with the chmod that fixes it", () => {
    const dir = tmpDir();
    const { certPath, keyPath } = haveOpenssl ? realPair(dir, 0o644) : pemPair(dir, 0o644);
    expect(() => loadWebTls({ certPath, keyPath })).toThrow(/mode 0644/);
    expect(() => loadWebTls({ certPath, keyPath })).toThrow(new RegExp(`chmod 600 ${keyPath}`));
    chmodSync(keyPath, 0o600);
    // Accepting it needs a real pair (OB-1933 checks the key belongs to the cert).
    if (haveOpenssl) expect(loadWebTls({ certPath, keyPath })).not.toBeNull();
  });

  test("half a pair is a usage error rather than a silent fall back to cleartext", () => {
    expect(() => resolveWebTlsPaths({ certConfigured: "/etc/omnislash/tls/fullchain.pem" })).toThrow(
      /half configured/,
    );
    expect(() => resolveWebTlsPaths({ keyEnv: "/etc/omnislash/tls/privkey.pem" })).toThrow(/half configured/);
  });

  test("no error ever echoes the key material", () => {
    const dir = tmpDir();
    const keyPath = join(dir, "privkey.pem");
    const secret = "SUPER-SECRET-KEY-BYTES";
    writeFileSync(keyPath, `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----\n`);
    chmodSync(keyPath, 0o644);
    const { certPath } = pemPair(dir);
    const message = (() => {
      try {
        loadWebTls({ certPath, keyPath });
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(message).not.toContain(secret);
  });
});

describe("precedence: the flag, then the env pair, then the config rows", () => {
  test("--tls-cert/--tls-key win over both, and the env pair wins over the rows", async () => {
    const db = freshDb();
    await setConfig(db, "web_tls_cert", "/rows/fullchain.pem");
    await setConfig(db, "web_tls_key", "/rows/privkey.pem");
    expect((await webTlsPathsFor(sqliteStoreFor(db), {}, {}))).toEqual({
      certPath: "/rows/fullchain.pem",
      keyPath: "/rows/privkey.pem",
    });
    const env = { [WEB_TLS_CERT_ENV]: "/env/fullchain.pem", [WEB_TLS_KEY_ENV]: "/env/privkey.pem" };
    expect((await webTlsPathsFor(sqliteStoreFor(db), {}, env))).toEqual({ certPath: "/env/fullchain.pem", keyPath: "/env/privkey.pem" });
    expect((await webTlsPathsFor(sqliteStoreFor(db), { certFlag: "/f/c.pem", keyFlag: "/f/k.pem" }, env))).toEqual({
      certPath: "/f/c.pem",
      keyPath: "/f/k.pem",
    });
  });

  test("a blank env value never beats a configured row", async () => {
    const db = freshDb();
    await setConfig(db, "web_tls_cert", "/rows/fullchain.pem");
    await setConfig(db, "web_tls_key", "/rows/privkey.pem");
    expect((await webTlsPathsFor(sqliteStoreFor(db), {}, { [WEB_TLS_CERT_ENV]: "  ", [WEB_TLS_KEY_ENV]: "" }))).toEqual({
      certPath: "/rows/fullchain.pem",
      keyPath: "/rows/privkey.pem",
    });
  });
});

describe("one scheme across both listeners", () => {
  // The page derives its socket URL from its own origin (apps/dashboard/src/lib/realtimeUrl.ts), so a
  // dashboard on https that dials a sidecar still on ws is a page that loads and never live-updates.
  test("http pairs with ws and https pairs with wss", () => {
    expect(webScheme(false)).toBe("http");
    expect(webScheme(true)).toBe("https");
    expect(webUrl(true, "example.test", 5050)).toBe("https://example.test:5050");
    expect(realtimeUrlFor(true, "example.test", 5051)).toBe("wss://example.test:5051");
    expect(realtimeUrlFor(false, "127.0.0.1", 5051)).toBe("ws://127.0.0.1:5051");
  });

  test("both listeners are given the SAME paths, or neither is", () => {
    const dir = tmpDir();
    const paths = pemPair(dir);
    expect(webTlsEnv(paths)).toEqual({
      [WEB_TLS_CERT_ENV]: paths.certPath,
      [WEB_TLS_KEY_ENV]: paths.keyPath,
    });
  });
});

describe("`ob cert`: the lego invocation, as data", () => {
  const base = {
    domain: "example.test",
    email: "alex@example.com",
    accountDir: "/etc/omnislash/tls/lego",
    renewDays: 30,
  };

  test("the challenge is DNS-01 through Cloudflare, so nothing inbound is ever needed", () => {
    const args = legoArgs({ ...base, haveCert: false });
    expect(args).toContain("--dns");
    expect(args[args.indexOf("--dns") + 1]).toBe("cloudflare");
    // No HTTP-01 and no TLS-ALPN-01: both would require Let's Encrypt to connect INWARDS to this house.
    expect(args).not.toContain("--http");
    expect(args).not.toContain("--tls");
    // The token is never an argument, so it is never in `ps` or a journal line.
    expect(args.join(" ")).not.toMatch(/CF_|token/i);
  });

  test("the first run issues; afterwards it renews inside the configured window", () => {
    expect(legoArgs({ ...base, haveCert: false })).toContain("run");
    const renew = legoArgs({ ...base, haveCert: true });
    expect(renew).toContain("renew");
    expect(renew).not.toContain("run");
    expect(renew[renew.indexOf("--days") + 1]).toBe("30");
    expect(renew).toContain("--no-random-sleep");
    // --force is a WIDER WINDOW, not a separate flag: lego renews when fewer than --days remain, so
    // one documented behaviour covers it and there is no flag a given lego version might not have.
    const forced = legoArgs({ ...base, haveCert: true, force: true });
    expect(Number(forced[forced.indexOf("--days") + 1])).toBeGreaterThan(90);
    expect(forced).not.toContain("--force");
  });

  test("--staging swaps the CA, so a rehearsal cannot burn a rate limit", () => {
    const args = legoArgs({ ...base, haveCert: false, staging: true });
    expect(args[args.indexOf("--server") + 1]).toContain("acme-staging-v02");
    expect(legoArgs({ ...base, haveCert: false })).not.toContain("--server");
  });

  test("the installed paths carry no domain name, so units and config rows never move", () => {
    expect(installedCertPaths("/etc/omnislash/tls")).toEqual({
      certPath: "/etc/omnislash/tls/fullchain.pem",
      keyPath: "/etc/omnislash/tls/privkey.pem",
    });
    const lego = legoPaths("/etc/omnislash/tls", base.domain);
    expect(lego.accountDir).toBe("/etc/omnislash/tls/lego");
    expect(lego.certPath).toBe(`/etc/omnislash/tls/lego/certificates/${base.domain}.crt`);
  });
});

describe("`ob cert`: installing material", () => {
  test("the key lands 0600, the chain 0644, and an unchanged renewal changes nothing", () => {
    const dir = tmpDir();
    const { certPath, keyPath } = installedCertPaths(dir);
    // Key first, cert last (OB-1933).
    expect(installMaterial(keyPath, "key k1\n", 0o600)).toBe(true);
    expect(installMaterial(certPath, "-----BEGIN CERTIFICATE-----\nc1\n", 0o644)).toBe(true);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(certPath).mode & 0o777).toBe(0o644);
    // Same bytes = no write, which is what keeps the .path unit from restarting the dashboard daily.
    expect(installMaterial(keyPath, "key k1\n", 0o600)).toBe(false);
    expect(installMaterial(keyPath, "key k2\n", 0o600)).toBe(true);
    // And a real pair it writes is exactly what `ob web` will accept (needs openssl, OB-1933).
    if (!haveOpenssl) return;
    const src = realPair(mkdtempSync(join(dir, "src-")));
    const keyPem = readFileSync(src.keyPath, "utf8");
    installMaterial(keyPath, keyPem, 0o600);
    installMaterial(certPath, readFileSync(src.certPath, "utf8"), 0o644);
    expect(loadWebTls({ certPath, keyPath })?.key).toBe(keyPem);
  });
});

// A REAL certificate, generated here and deleted here: the only way to prove the expiry arithmetic
// without either issuing one from a CA or checking one into the repo. Skipped where openssl is absent
// rather than failing, because this is the one test with an external dependency.
const openssl = Bun.spawnSync({ cmd: ["which", "openssl"], stdout: "pipe", stderr: "pipe" }).exitCode === 0;

describe.skipIf(!openssl)("`ob cert status`: reading a real certificate", () => {
  test("subject, names and days-left come off the leaf", () => {
    const dir = tmpDir();
    const certPath = join(dir, "throwaway.crt");
    const keyPath = join(dir, "throwaway.key");
    const gen = Bun.spawnSync({
      cmd: [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", keyPath, "-out", certPath, "-days", "90",
        "-subj", "/CN=ob.example.invalid",
        "-addext", "subjectAltName=DNS:ob.example.invalid",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(gen.exitCode).toBe(0);
    const summary = summarizeCert(readFileSync(certPath, "utf8"));
    expect(summary.subject).toContain("ob.example.invalid");
    expect(summary.sans).toContain("ob.example.invalid");
    expect(summary.expired).toBe(false);
    expect(summary.daysLeft).toBeGreaterThan(85);
    expect(summary.daysLeft).toBeLessThanOrEqual(90);
    // The renewal window this ticket ships: 30 days, so a 90-day certificate is not yet due.
    expect(summary.daysLeft).toBeGreaterThan(30);
    // Replayed a year on, the same bytes read as expired rather than as "fine".
    const later = summarizeCert(readFileSync(certPath, "utf8"), new Date(Date.now() + 365 * 86_400_000));
    expect(later.expired).toBe(true);
    expect(later.daysLeft).toBeLessThan(0);
  });

  test("a file that is not a certificate is a clear error, not a crash", () => {
    expect(() => summarizeCert("-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n")).toThrow(
      /could not parse the certificate/,
    );
  });
});

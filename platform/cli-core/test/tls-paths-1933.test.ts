import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import type { Ctx } from "../../../apps/cli/src/ctx.ts";
import {
  WEB_TLS_CERT_ENV,
  WEB_TLS_KEY_ENV,
  installedCertPaths,
  loadWebTls,
  tlsPathsFor,
  webTlsPathsFor,
} from "../../../apps/cli/src/web-tls.ts";
import { certStatusReport, cmdCert, installMaterial, installPair } from "../../../apps/cli/src/commands/cert.ts";
import { backupTlsKeyPaths } from "../../../apps/cli/src/commands/db.ts";
import { cmdWeb, type WebDeps } from "../../../apps/cli/src/commands/web.ts";

// -----------------------------------------------------------------------------
// OB-1933: one TLS path resolver, `ob cert status` that fails on a broken pair, the `ob web` expiry
// warning and child exit code, and the key-first pair install. No network, no lego, no port bound:
// real throwaway pairs come from openssl in a temp dir (skipped where openssl is absent), and `ob web`
// runs against a fake spawn and a fake realtime server.
// -----------------------------------------------------------------------------

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ob-tls-1933-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const openssl = Bun.spawnSync({ cmd: ["which", "openssl"], stdout: "pipe", stderr: "pipe" }).exitCode === 0;
const DAY = 86_400_000;

/** A real self-signed pair valid for `days`, at fullchain.pem/privkey.pem in `dir`. */
function realPair(dir: string, days: number): { certPath: string; keyPath: string } {
  const { certPath, keyPath } = installedCertPaths(dir);
  const gen = Bun.spawnSync({
    cmd: ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", String(days), "-subj", "/CN=ob.example.invalid"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (gen.exitCode !== 0) throw new Error(`openssl failed: ${gen.stderr.toString()}`);
  chmodSync(keyPath, 0o600);
  return { certPath, keyPath };
}

/** A second key that belongs to no certificate here. */
function strayKey(dir: string): string {
  const path = join(dir, "stray.pem");
  const gen = Bun.spawnSync({ cmd: ["openssl", "genpkey", "-algorithm", "RSA", "-out", path], stdout: "pipe", stderr: "pipe" });
  if (gen.exitCode !== 0) throw new Error("openssl genpkey failed");
  return readFileSync(path, "utf8");
}

function ctxFor(db = freshDb(), mode: "text" | "json" = "text", args: string[] = []): Ctx {
  return { db, store: sqliteStoreFor(db), dbPath: ":memory:", mode, flags: {}, args } as unknown as Ctx;
}

async function capture(fn: () => Promise<void>): Promise<string> {
  let out = "";
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return out;
}

describe("item 1: one resolver", () => {
  test("served follows flag > env > config, and names the source that won", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    expect(await tlsPathsFor(store, {}, {})).toEqual({ served: null, servedSource: null, installed: null });
    await setConfig(db, "web_tls_cert", "/rows/c.pem");
    await setConfig(db, "web_tls_key", "/rows/k.pem");
    expect(await tlsPathsFor(store, {}, {})).toMatchObject({ served: { certPath: "/rows/c.pem" }, servedSource: "config" });
    const env = { [WEB_TLS_CERT_ENV]: "/env/c.pem", [WEB_TLS_KEY_ENV]: "/env/k.pem" };
    expect(await tlsPathsFor(store, {}, env)).toMatchObject({ served: { certPath: "/env/c.pem" }, servedSource: "env" });
    expect(await tlsPathsFor(store, { certFlag: "/f/c.pem", keyFlag: "/f/k.pem" }, env)).toMatchObject({
      served: { certPath: "/f/c.pem", keyPath: "/f/k.pem" },
      servedSource: "flag",
    });
    // webTlsPathsFor stays the served answer.
    expect(await webTlsPathsFor(store, {}, env)).toEqual({ certPath: "/env/c.pem", keyPath: "/env/k.pem" });
  });

  test("installed is the tls_dir pair only when tls_domain is set, with an empty tls_dir meaning the default", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    await setConfig(db, "tls_dir", "/somewhere");
    expect((await tlsPathsFor(store, {}, {})).installed).toBeNull();
    await setConfig(db, "tls_domain", "ob.example.invalid");
    expect((await tlsPathsFor(store, {}, {})).installed).toEqual(installedCertPaths("/somewhere"));
    await setConfig(db, "tls_dir", "");
    const r = await tlsPathsFor(store, {}, {});
    expect(r.installed).toEqual({ certPath: "/etc/omnislash/tls/fullchain.pem", keyPath: "/etc/omnislash/tls/privkey.pem" });
    // A laptop sees tls_domain too, but serves nothing: installed never becomes served.
    expect(r.served).toBeNull();
  });

  test("the backup excludes both keys by path, and survives a half-configured served pair", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    await setConfig(db, "tls_domain", "ob.example.invalid");
    await setConfig(db, "web_tls_cert", "/rows/c.pem");
    await setConfig(db, "web_tls_key", "/rows/k.pem");
    expect(await backupTlsKeyPaths(store)).toEqual(["/rows/k.pem", "/etc/omnislash/tls/privkey.pem"]);
    // Half a served pair: the backup does not fail, and still excludes the key half that was set.
    await setConfig(db, "web_tls_cert", "");
    expect(await backupTlsKeyPaths(store)).toEqual(["/rows/k.pem", "/etc/omnislash/tls/privkey.pem"]);
  });
});

describe("item 2: `ob cert status` exits 1 on every broken pair", () => {
  const now = new Date();

  test.skipIf(!openssl)("certStatusReport: a healthy pair matches, and an unparseable cert is a problem, not a throw", () => {
    const healthy = realPair(tmpDir(), 30);
    expect(certStatusReport(healthy, now)).toMatchObject({ problems: [], pairMatches: true });
    writeFileSync(healthy.certPath, "-----BEGIN CERTIFICATE-----\nnope\n-----END CERTIFICATE-----\n");
    expect(certStatusReport(healthy, now).problems.join()).toMatch(/certificate does not parse/);
  });

  async function statusExit(setup: (db: ReturnType<typeof freshDb>, dir: string) => Promise<void>, nowAt = now) {
    const db = freshDb();
    const dir = tmpDir();
    await setup(db, dir);
    const ctx = ctxFor(db, "json", ["status"]);
    const out = await capture(() => cmdCert(ctx, { now: nowAt }));
    return { exit: ctx.exit ?? 0, json: JSON.parse(out) };
  }

  const installedAt = async (db: ReturnType<typeof freshDb>, dir: string) => {
    await setConfig(db, "tls_domain", "ob.example.invalid");
    await setConfig(db, "tls_dir", dir);
  };

  test.skipIf(!openssl)("healthy is exit 0 with ok and paths_agree in JSON", async () => {
    const r = await statusExit(async (db, dir) => {
      await installedAt(db, dir);
      realPair(dir, 30);
    });
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ ok: true, paths_agree: true, problems: [], source: "tls_dir (not served by ob web on this machine)" });
    expect(r.json.daysLeft).toBeGreaterThan(25);
  });

  test("not configured is exit 0", async () => {
    const r = await statusExit(async () => {});
    expect(r.exit).toBe(0);
    expect(r.json).toMatchObject({ configured: false, ok: true });
  });

  test("missing cert", async () => {
    const r = await statusExit(installedAt);
    expect(r.exit).toBe(1);
    expect(r.json.problems.join()).toMatch(/certificate missing/);
  });

  test.skipIf(!openssl)("missing key", async () => {
    const r = await statusExit(async (db, dir) => {
      await installedAt(db, dir);
      rmSync(realPair(dir, 30).keyPath);
    });
    expect(r.exit).toBe(1);
    expect(r.json.problems.join()).toMatch(/key missing/);
  });

  test.skipIf(!openssl)("expired", async () => {
    const r = await statusExit(async (db, dir) => {
      await installedAt(db, dir);
      realPair(dir, 1);
    }, new Date(now.getTime() + 7 * DAY));
    expect(r.exit).toBe(1);
    expect(r.json.expired).toBe(true);
  });

  test.skipIf(!openssl)("bad key mode", async () => {
    const r = await statusExit(async (db, dir) => {
      await installedAt(db, dir);
      chmodSync(realPair(dir, 30).keyPath, 0o640);
    });
    expect(r.exit).toBe(1);
    expect(r.json.problems.join()).toMatch(/mode 0640/);
  });

  test.skipIf(!openssl)("mismatched pair", async () => {
    const r = await statusExit(async (db, dir) => {
      await installedAt(db, dir);
      writeFileSync(realPair(dir, 30).keyPath, strayKey(tmpDir()), { mode: 0o600 });
    });
    expect(r.exit).toBe(1);
    expect(r.json.pairMatches).toBe(false);
  });

  test.skipIf(!openssl)("served and installed disagree: the served pair is checked and the disagreement fails it", async () => {
    const r = await statusExit(async (db, dir) => {
      await installedAt(db, dir);
      realPair(dir, 30);
      const other = realPair(tmpDir(), 30);
      await setConfig(db, "web_tls_cert", other.certPath);
      await setConfig(db, "web_tls_key", other.keyPath);
    });
    expect(r.exit).toBe(1);
    expect(r.json).toMatchObject({ paths_agree: false, ok: false, source: "config" });
    expect(r.json.problems.join()).toMatch(/renewals never reach the dashboard/);
  });

  test("text mode still prints each problem on its own line with exit 1", async () => {
    const db = freshDb();
    const dir = tmpDir();
    await installedAt(db, dir);
    const ctx = ctxFor(db, "text", ["status"]);
    const out = await capture(() => cmdCert(ctx));
    expect(ctx.exit).toBe(1);
    expect(out).toMatch(/^PROBLEM: certificate missing/m);
  });
});

describe.skipIf(!openssl)("item 4: crash-safe pair install", () => {
  test("installPair writes the key first and the cert last", () => {
    const src = realPair(tmpDir(), 30);
    const dest = installedCertPaths(tmpDir());
    const order: string[] = [];
    const spy: typeof installMaterial = (path, contents, mode) => {
      order.push(path);
      return installMaterial(path, contents, mode);
    };
    installPair(dest, readFileSync(src.certPath, "utf8"), readFileSync(src.keyPath, "utf8"), spy);
    expect(order).toEqual([dest.keyPath, dest.certPath]);
    expect(statSync(dest.certPath).mtimeMs).toBeGreaterThanOrEqual(statSync(dest.keyPath).mtimeMs);
    expect(loadWebTls(dest)).not.toBeNull();
  });

  test("a split pair (new key, old cert) is refused by loadWebTls and repaired by the next installMaterial pass", () => {
    const oldPair = realPair(tmpDir(), 30);
    const fresh = realPair(tmpDir(), 30);
    const dest = installedCertPaths(tmpDir());
    installPair(dest, readFileSync(oldPair.certPath, "utf8"), readFileSync(oldPair.keyPath, "utf8"));
    // The crash: the key rename landed, the cert rename did not.
    installMaterial(dest.keyPath, readFileSync(fresh.keyPath, "utf8"), 0o600);
    expect(() => loadWebTls(dest)).toThrow(/does not belong to the certificate/);
    expect(() => loadWebTls(dest)).toThrow(/ob cert renew/);
    // The next renew run: the key is unchanged, the cert differs and is rewritten.
    expect(installPair(dest, readFileSync(fresh.certPath, "utf8"), readFileSync(fresh.keyPath, "utf8"))).toEqual({
      keyChanged: false,
      certChanged: true,
    });
    expect(loadWebTls(dest)).not.toBeNull();
  });
});

describe("items 3 and 5: `ob web` warns on a near-expiry cert and exits with the child's code", () => {
  function fakeDeps(serveCode: number, opts: { now?: Date; stopFirst?: boolean } = {}) {
    const handlers = new Map<string, () => void>();
    let resolveServe!: (n: number) => void;
    const serveExited = new Promise<number>((r) => (resolveServe = r));
    const calls: string[][] = [];
    const deps: WebDeps = {
      now: opts.now,
      spawn: (cmd) => {
        calls.push(cmd);
        if (cmd.join(" ") === "bun run build") return { exited: Promise.resolve(0), kill() {} };
        // The serve child: either it crashes on its own, or a forwarded stop kills it.
        if (opts.stopFirst) {
          queueMicrotask(() => handlers.get("SIGTERM")?.());
        } else {
          queueMicrotask(() => resolveServe(serveCode));
        }
        return {
          exited: serveExited,
          kill() {
            resolveServe(serveCode);
          },
        };
      },
      startRealtime: () => ({ stop() {} }),
      onSignal: {
        on: (sig, fn) => void handlers.set(sig, fn),
        off: (sig, fn) => {
          if (handlers.get(sig) === fn) handlers.delete(sig);
        },
      },
    };
    return { deps, handlers, calls };
  }

  test("a crashed child (exit 3) is ctx.exit 3, and the handlers are removed", async () => {
    const ctx = ctxFor();
    const { deps, handlers, calls } = fakeDeps(3);
    const out = await capture(() => cmdWeb(ctx, deps));
    expect(ctx.exit).toBe(3);
    expect(out).toContain("dashboard server exited 3");
    expect(calls).toEqual([["bun", "run", "build"], ["bun", "run", "serve"]]);
    expect(handlers.size).toBe(0);
  });

  test("a forwarded stop is exit 0 even though the killed child exits non-zero", async () => {
    const ctx = ctxFor();
    const { deps, handlers } = fakeDeps(143, { stopFirst: true });
    const out = await capture(() => cmdWeb(ctx, deps));
    expect(ctx.exit ?? 0).toBe(0);
    expect(out).not.toContain("dashboard server exited");
    expect(handlers.size).toBe(0);
  });

  test.skipIf(!openssl)("3 days left warns after the TLS line; 30 days does not; expired warns and still serves", async () => {
    const pair = realPair(tmpDir(), 30);
    const env = { [WEB_TLS_CERT_ENV]: pair.certPath, [WEB_TLS_KEY_ENV]: pair.keyPath };
    const run = async (now: Date) => {
      const ctx = ctxFor();
      ctx.flags["tls-cert"] = env[WEB_TLS_CERT_ENV];
      ctx.flags["tls-key"] = env[WEB_TLS_KEY_ENV];
      return { ctx, out: await capture(() => cmdWeb(ctx, fakeDeps(0, { now }).deps)) };
    };
    const soon = await run(new Date(Date.now() + 27 * DAY - 3_600_000));
    expect(soon.out).toMatch(/TLS: .*\nWARNING: TLS certificate .* expires in 3 day\(s\) .*; run ob cert renew/);
    expect((await run(new Date())).out).not.toContain("WARNING");
    const expired = await run(new Date(Date.now() + 40 * DAY));
    expect(expired.out).toMatch(/WARNING: TLS certificate .* EXPIRED on .*; run ob cert renew/);
    expect(expired.out).toContain("serving OmniSlash dashboard");
    expect(expired.ctx.exit ?? 0).toBe(0);
  });
});

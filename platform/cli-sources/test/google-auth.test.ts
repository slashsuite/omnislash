import { describe, expect, test } from "bun:test";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, statSync } from "node:fs";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { googleTokenFromFile, mergeGoogleToken, readGoogleToken, type GoogleToken } from "../src/google.ts";
import { getSecret, inMemoryMasterKey, setSecret } from "../../../apps/cli/src/secrets.ts";
import { AppError, UsageError } from "../../../apps/cli/src/errors.ts";
import type { Ctx } from "../../../apps/cli/src/ctx.ts";
import type { Flags } from "../../../apps/cli/src/ctx.ts";
import {
  DEFAULT_SCOPES,
  buildAuthUrl,
  expandScope,
  resolveScopes,
  resolveClientCreds,
  requireClientCredsFromFlags,
  parseClientSecretJson,
  clientCredsFromStoredGoogleJson,
  tokenResponseToGoogleToken,
  writeGoogleTokenFile,
  runGoogleAuth,
  callbackFromUrl,
  type Loopback,
  type TokenExchangeResponse,
} from "../src/commands/google.ts";

function tmpPath(): string {
  return join(tmpdir(), `ob-gauth-${randomUUID()}.json`);
}

function mkCtx(flags: Partial<Flags>): Ctx {
  const db = freshDb();
  return { db, store: sqliteStoreFor(db), dbPath: ":memory:", mode: "human", flags: flags as Flags, args: [] };
}

const CLIENT_SECRET_JSON = JSON.stringify({
  installed: {
    client_id: "cid.apps.googleusercontent.com",
    client_secret: "topsecret-xyz",
    redirect_uris: ["http://localhost"],
  },
});

describe("ob google auth — URL construction (129)", () => {
  test("auth URL: endpoint, offline, consent, loopback redirect, default scopes", () => {
    const url = buildAuthUrl({
      clientId: "cid",
      redirectUri: "http://127.0.0.1:54321",
      scopes: DEFAULT_SCOPES,
      state: "st",
    });
    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    const p = new URL(url).searchParams;
    expect(p.get("client_id")).toBe("cid");
    expect(p.get("redirect_uri")).toBe("http://127.0.0.1:54321");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("state")).toBe("st");
    expect(p.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar",
    );
  });

  test("expandScope: short names → full URL, full URLs pass through", () => {
    expect(expandScope("gmail.modify")).toBe("https://www.googleapis.com/auth/gmail.modify");
    expect(expandScope("https://www.googleapis.com/auth/drive")).toBe(
      "https://www.googleapis.com/auth/drive",
    );
  });

  test("resolveScopes: --scopes gmail.send expands + merges with defaults (deduped)", () => {
    const scopes = resolveScopes("gmail.send");
    expect(scopes).toEqual([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    expect(resolveScopes(undefined)).toEqual(DEFAULT_SCOPES);
    expect(resolveScopes("gmail.modify")).toEqual(DEFAULT_SCOPES);
  });

  test("callbackFromUrl parses code/error/state from the loopback request URL", () => {
    expect(callbackFromUrl("http://127.0.0.1:5000/?code=abc&state=st")).toEqual({
      code: "abc",
      error: undefined,
      state: "st",
    });
    expect(callbackFromUrl("http://127.0.0.1:5000/?error=access_denied")).toEqual({
      code: undefined,
      error: "access_denied",
      state: undefined,
    });
  });
});

describe("ob google auth — client creds resolution (129)", () => {
  test("--client parses installed.client_id/client_secret from client_secret.json", () => {
    const p = tmpPath();
    writeFileSync(p, CLIENT_SECRET_JSON);
    const ctx = mkCtx({ client: p });
    const creds = resolveClientCreds(ctx);
    expect(creds.clientId).toBe("cid.apps.googleusercontent.com");
    expect(creds.clientSecret).toBe("topsecret-xyz");
    ctx.db.close();
    rmSync(p, { force: true });
  });

  test("--client-id / --client-secret flags", () => {
    const ctx = mkCtx({ "client-id": "flag-id", "client-secret": "flag-secret" });
    const creds = resolveClientCreds(ctx);
    expect(creds).toEqual({ clientId: "flag-id", clientSecret: "flag-secret" });
    ctx.db.close();
  });

  test("only one of --client-id/--client-secret → UsageError", () => {
    const ctx = mkCtx({ "client-id": "flag-id" });
    expect(() => resolveClientCreds(ctx)).toThrow(UsageError);
    ctx.db.close();
  });

  test("google_oauth_client_path setting is used when no flags given", async () => {
    const p = tmpPath();
    writeFileSync(p, CLIENT_SECRET_JSON);
    const ctx = mkCtx({});
    await setConfig(ctx.db, "google_oauth_client_path", p);
    const creds = resolveClientCreds(ctx);
    expect(creds.clientId).toBe("cid.apps.googleusercontent.com");
    ctx.db.close();
    rmSync(p, { force: true });
  });

  test("no creds anywhere → clean UsageError", () => {
    const ctx = mkCtx({});
    expect(() => resolveClientCreds(ctx)).toThrow(/no OAuth client credentials/);
    ctx.db.close();
  });

  test("flags-only resolver names --client / --client-id / --client-secret, not the config key", () => {
    expect(() => requireClientCredsFromFlags({})).toThrow(/--client <client_secret.json>/);
    expect(() => requireClientCredsFromFlags({})).toThrow(/--client-id\/--client-secret/);
    try {
      requireClientCredsFromFlags({});
    } catch (e) {
      expect((e as Error).message).not.toContain("google_oauth_client_path");
    }
  });

  test("parseClientSecretJson rejects malformed / incomplete files", () => {
    expect(() => parseClientSecretJson("not json")).toThrow(AppError);
    expect(() => parseClientSecretJson(JSON.stringify({ installed: { client_id: "x" } }))).toThrow(
      /missing installed.client_id/,
    );
  });

  test("stored google JSON yields client_id/client_secret even when the refresh is dead (424)", () => {
    expect(
      clientCredsFromStoredGoogleJson(
        JSON.stringify({
          access_token: "dead",
          refresh_token: "dead-refresh",
          expiry: "2020-01-01T00:00:00.000Z",
          client_id: "stored-id",
          client_secret: "stored-secret",
        }),
      ),
    ).toEqual({ clientId: "stored-id", clientSecret: "stored-secret" });
    expect(clientCredsFromStoredGoogleJson("")).toBeNull();
    expect(clientCredsFromStoredGoogleJson("{}")).toBeNull();
    expect(clientCredsFromStoredGoogleJson("not json")).toBeNull();
    expect(clientCredsFromStoredGoogleJson(JSON.stringify({ client_id: "x" }))).toBeNull();
  });
});

describe("ob google auth — token mapping + file write (129)", () => {
  const fixture: TokenExchangeResponse = {
    access_token: "ya29.fixture-access",
    refresh_token: "1//fixture-refresh",
    expires_in: 3600,
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    token_type: "Bearer",
  };

  test("response → GoogleToken with ISO expiry computed from expires_in", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const token = tokenResponseToGoogleToken(fixture, { clientId: "cid", clientSecret: "sec" }, now);
    expect(token.access_token).toBe("ya29.fixture-access");
    expect(token.refresh_token).toBe("1//fixture-refresh");
    expect(token.expiry).toBe(new Date(now + 3600 * 1000).toISOString());
    expect(token.client_id).toBe("cid");
    expect(token.client_secret).toBe("sec");
  });

  test("expires_in defaults to 3600 when absent", () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    const token = tokenResponseToGoogleToken({ access_token: "a" }, { clientId: "c", clientSecret: "s" }, now);
    expect(token.expiry).toBe(new Date(now + 3600 * 1000).toISOString());
  });

  test("write to a TEMP path is chmod 600 and round-trips through readGoogleToken", () => {
    const p = tmpPath();
    const token = tokenResponseToGoogleToken(fixture, { clientId: "cid", clientSecret: "sec" });
    const abs = writeGoogleTokenFile(p, token);
    expect(abs).toBe(p);
    // mode 600
    expect(statSync(p).mode & 0o777).toBe(0o600);
    // the JSON is exactly what the connectors accept
    const read = readGoogleToken(p);
    expect(read.access_token).toBe("ya29.fixture-access");
    expect(read.refresh_token).toBe("1//fixture-refresh");
    expect(read.client_id).toBe("cid");
    expect(read.client_secret).toBe("sec");
    expect(read.expiry).toBe(token.expiry);
    rmSync(p, { force: true });
  });
});

describe("ob google auth — full loopback flow with injected seams (no network)", () => {
  const SECRET = "flow-client-secret-DO-NOT-LOG";
  const fixture: TokenExchangeResponse = {
    access_token: "flow-access-token-DO-NOT-LOG",
    refresh_token: "flow-refresh-token-DO-NOT-LOG",
    expires_in: 1800,
  };

  test("drives loopback callback, exchanges via injected fake, stores token; never logs secrets", async () => {
    const ctx = mkCtx({ "client-id": "flow-id", "client-secret": SECRET, scopes: "gmail.modify" });
    const key = inMemoryMasterKey(); // in-memory master key — NO real Keychain

    // capture everything printed to stdout
    const origLog = console.log;
    let logged = "";
    console.log = (...a: unknown[]) => {
      logged += a.join(" ") + "\n";
    };

    let exchangeParams: { code: string; redirectUri: string; clientId: string; clientSecret: string } | null = null;
    let openedUrl = "";
    let closed = false;

    try {
      const res = await runGoogleAuth(ctx, {
        masterKey: key,
        // fake exchanger: asserts wiring, returns the fixture — NEVER hits Google
        exchange: async (p) => {
          exchangeParams = p;
          return fixture;
        },
        // fake browser: capture the auth URL (its state is echoed back by the fake loopback)
        openUrl: (url) => {
          openedUrl = url;
        },
        // fake loopback: no socket — returns the code and echoes the state from the opened URL
        startLoopback: (): Loopback => ({
          redirectUri: "http://127.0.0.1:65000",
          waitForCode: async () => ({
            code: "auth-code-123",
            state: new URL(openedUrl).searchParams.get("state") ?? undefined,
          }),
          close: () => {
            closed = true;
          },
        }),
      });

      expect(closed).toBe(true);
      expect(new URL(openedUrl).searchParams.get("access_type")).toBe("offline");

      expect(res.scopes).toContain("https://www.googleapis.com/auth/gmail.modify");
      expect(exchangeParams!.code).toBe("auth-code-123");
      expect(exchangeParams!.clientId).toBe("flow-id");
      expect(exchangeParams!.redirectUri.startsWith("http://127.0.0.1:")).toBe(true);

      // token landed in the encrypted store (secret `google`), decryptable + round-trips
      const raw = await getSecret(ctx.store ?? sqliteStoreFor(ctx.db), "google", key.get());
      expect(raw).not.toBeNull();
      const stored = JSON.parse(raw!) as { access_token: string; refresh_token?: string };
      expect(stored.access_token).toBe("flow-access-token-DO-NOT-LOG");
      expect(stored.refresh_token).toBe("flow-refresh-token-DO-NOT-LOG");
    } finally {
      console.log = origLog;
      ctx.db.close();
    }

    // never-logs: secrets and tokens must not appear in printed output
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain("flow-access-token-DO-NOT-LOG");
    expect(logged).not.toContain("flow-refresh-token-DO-NOT-LOG");
    // it prints the consent URL (safe: client_id is not a secret) as a fallback
    expect(logged).toContain("https://accounts.google.com/o/oauth2/v2/auth");
  });
});

describe("ob google — CLI wiring (129)", () => {
  test("`ob google auth` with no creds exits 2 (UsageError) and does not touch the network", async () => {
    const r = await runCli(freshDbPath(), ["google", "auth"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("no OAuth client credentials");
  });

  test("`ob google <unknown>` is a clean UsageError", async () => {
    const r = await runCli(freshDbPath(), ["google", "bogus"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown google subcommand");
  });

  // 1305: the hosted half's receiver is on the API host, so without an API client there is nothing to
  // print a URL for. It refuses and names the desktop flow rather than pretending.
  test("`ob google auth-url` without an API refuses and points at the loopback flow", async () => {
    const r = await runCli(freshDbPath(), ["google", "auth-url"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("needs the API");
    expect(r.err).toContain("ob google auth");
    expect(r.err).not.toContain("unknown google subcommand");
  });

  test("`ob --help` lists the google auth command", async () => {
    const r = await runCli(freshDbPath(), ["--help"]);
    expect(r.out).toContain("google auth");
  });

  test("`ob --help` lists google auth-url (1305)", async () => {
    const r = await runCli(freshDbPath(), ["--help"]);
    expect(r.out).toContain("google auth-url");
    expect(r.out).toContain("HOSTED");
  });
});

describe("mergeGoogleToken (OB-1916)", () => {
  const prev: GoogleToken = { access_token: "a0", refresh_token: "R", client_id: "cid", client_secret: "s" };

  test("keeps the stored refresh token when the new token has none", () => {
    const next: GoogleToken = { access_token: "a1", client_id: "cid", client_secret: "s" };
    expect(mergeGoogleToken(prev, next)).toEqual({ ...next, refresh_token: "R" });
  });

  test("takes the new refresh token when the response carries one", () => {
    const next: GoogleToken = { access_token: "a1", refresh_token: "R2", client_id: "cid" };
    expect(mergeGoogleToken(prev, next)).toBe(next);
  });

  test("passes next through when there is no previous token", () => {
    const next: GoogleToken = { access_token: "a1", client_id: "cid" };
    expect(mergeGoogleToken(null, next)).toBe(next);
  });

  test("a different client_id never inherits the old refresh token", () => {
    const next: GoogleToken = { access_token: "a1", client_id: "other" };
    expect(mergeGoogleToken(prev, next)).toBe(next);
    expect(mergeGoogleToken(prev, next).refresh_token).toBeUndefined();
  });
  test("a refused (marked) previous token never hands its refresh token on, and the result carries no marker (OB-1950)", () => {
    const marked: GoogleToken = { ...prev, refresh_invalid_at: "2026-11-01T00:00:00Z" };
    const next: GoogleToken = { access_token: "a1", client_id: "cid", client_secret: "s" };
    const merged = mergeGoogleToken(marked, next);
    expect(merged.refresh_token).toBeUndefined();
    expect(merged.refresh_invalid_at).toBeUndefined();
    const markedNext = mergeGoogleToken(prev, { ...next, refresh_token: "R2", refresh_invalid_at: "2026-11-01T00:00:00Z" });
    expect(markedNext.refresh_invalid_at).toBeUndefined();
    expect(markedNext.refresh_token).toBe("R2");
  });
});

describe("ob google auth — local write merges over the stored token (OB-1916)", () => {
  test("a response with no refresh token keeps the stored one and saves the new access token", async () => {
    const ctx = mkCtx({ "client-id": "flow-id", "client-secret": "sec" });
    const key = inMemoryMasterKey();
    const store = ctx.store ?? sqliteStoreFor(ctx.db);
    await setSecret(
      store,
      "google",
      JSON.stringify({ access_token: "old-at", refresh_token: "stored-R", client_id: "flow-id", client_secret: "sec" }),
      key.get(),
    );
    const origLog = console.log;
    console.log = () => {};
    let openedUrl = "";
    try {
      await runGoogleAuth(ctx, {
        masterKey: key,
        exchange: async () => ({ access_token: "new-at", expires_in: 1800 }),
        openUrl: (url) => {
          openedUrl = url;
        },
        startLoopback: (): Loopback => ({
          redirectUri: "http://127.0.0.1:65000",
          waitForCode: async () => ({ code: "c", state: new URL(openedUrl).searchParams.get("state") ?? undefined }),
          close: () => {},
        }),
      });
      const stored = JSON.parse((await getSecret(store, "google", key.get()))!) as GoogleToken;
      expect(stored.access_token).toBe("new-at");
      expect(stored.refresh_token).toBe("stored-R");
    } finally {
      console.log = origLog;
      ctx.db.close();
    }
  });
});

describe("legacy token file write failure (OB-1916)", () => {
  test("a failed persist warns with the path and does not throw", () => {
    const dir = process.env.TMPDIR ?? tmpdir();
    const path = join(dir, `ob-gtok-${randomUUID()}.json`);
    writeFileSync(path, JSON.stringify({ access_token: "file-at-DO-NOT-LOG", refresh_token: "file-rt-DO-NOT-LOG" }));
    const origWrite = process.stderr.write.bind(process.stderr);
    let err = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      err += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      const resolved = googleTokenFromFile(path);
      expect(resolved.token.access_token).toBe("file-at-DO-NOT-LOG");
      rmSync(path);
      mkdirSync(path); // the write now fails with EISDIR, even as root
      err = "";
      expect(() => resolved.persist({ access_token: "new-at-DO-NOT-LOG", refresh_token: "new-rt-DO-NOT-LOG" })).not.toThrow();
      expect(err).toContain("could not save the refreshed token");
      expect(err).toContain(path);
      expect(err).not.toContain("DO-NOT-LOG");
    } finally {
      process.stderr.write = origWrite;
      rmSync(path, { recursive: true, force: true });
    }
  });
});

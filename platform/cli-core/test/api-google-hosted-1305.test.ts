// ob 1305 -- the HOSTED Google OAuth half: a browser-reachable authorize + callback on the API host, so a
// phone can finish a re-auth that the loopback flow cannot.
//
// The two browser routes are the API's ONLY unauthenticated ones, so the assertions here are mostly
// NEGATIVE: the state is the whole guard, the code must never appear in a response or an error, and a
// state that is absent, unknown, replayed or expired must fail CLOSED with a name. The token is persisted
// through the SAME secret path the loopback flow uses -- there is no second store to assert against.
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { getSecret, inMemoryMasterKey, setSecret } from "../../../apps/cli/src/secrets.ts";
import { OB_API_PREFIX, OB_API_ROUTES } from "../../../apps/cli/src/api/contract.ts";
import { HELP } from "../../../apps/cli/src/cli.ts";
import {
  STATE_TTL_MS,
  createGoogleStateStore,
  stateRefusalSentence,
  type GoogleStateStore,
} from "../../cli-sources/src/google-hosted.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenExchangeResponse } from "../../cli-sources/src/commands/google.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";

const TOKEN = "a-test-bearer-token-that-is-long-enough";
const ORIGIN = "http://api-host.local";
const CLIENT_SECRET = "hosted-client-secret-DO-NOT-LOG";
const ACCESS = "hosted-access-token-DO-NOT-LOG";
const REFRESH = "hosted-refresh-token-DO-NOT-LOG";
const CODE = "hosted-auth-code-DO-NOT-LOG";
const KEY = inMemoryMasterKey();

function googleCredsJson(): string {
  return JSON.stringify({
    access_token: "dead-access",
    refresh_token: "dead-refresh",
    expiry: "2020-01-01T00:00:00.000Z",
    client_id: "stored-id.apps.googleusercontent.com",
    client_secret: CLIENT_SECRET,
  });
}

interface Ctx {
  store: Store;
  calls: { code: string; redirectUri: string; clientId: string }[];
  call(
    path: string,
    opts?: { method?: string; token?: string | null; headers?: Record<string, string> },
  ): Promise<{ status: number; text: string; headers: Headers; json: any }>;
  authStart(headers?: Record<string, string>): Promise<string>;
}

async function withApi(
  fn: (ctx: Ctx) => Promise<void>,
  opts: { exchange?: (p: any) => Promise<TokenExchangeResponse>; now?: () => number; states?: GoogleStateStore } = {},
): Promise<void> {
  const db = freshDb();
  const store = sqliteStoreFor(db);
  await setSecret(store, "google", googleCredsJson(), KEY.get());
  const calls: Ctx["calls"] = [];
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    secrets: { masterKey: KEY },
    googleHosted: {
      // OB-1935: an in-memory store, so no test reads or locks the live ~/.omnislash state file.
      states: opts.states ?? createGoogleStateStore(STATE_TTL_MS),
      exchange: async (p) => {
        calls.push({ code: p.code, redirectUri: p.redirectUri, clientId: p.clientId });
        if (opts.exchange) return await opts.exchange(p);
        return { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 };
      },
      ...(opts.now ? { now: opts.now } : {}),
    },
  });

  const call: Ctx["call"] = async (path, o = {}) => {
    const headers: Record<string, string> = { ...o.headers };
    const token = o.token === undefined ? TOKEN : o.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const res = await api(new Request(`${ORIGIN}${OB_API_PREFIX}${path}`, { method: o.method ?? "GET", headers }));
    const text = await res.text();
    return { status: res.status, text, headers: res.headers, json: text ? safeJson(text) : null };
  };

  /** The mint is BEARER-authenticated (`auth-url`); the browser route only resumes what it minted. */
  const authStart = async (headers: Record<string, string> = {}): Promise<string> => {
    const res = await call("/google/auth-url", { method: "POST", headers });
    expect(res.status).toBe(200);
    return new URL(res.json.url).searchParams.get("state")!;
  };

  try {
    await fn({ store, calls, call, authStart });
  } finally {
    db.close();
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

describe("hosted Google auth -- mint + GET /google/auth (1305)", () => {
  test("the mint answers with Google's consent URL: offline + consent, default scopes, a fresh state", async () => {
    await withApi(async ({ call }) => {
      const res = await call("/google/auth-url", { method: "POST" });
      expect(res.status).toBe(200);
      const url = new URL(res.json.url);
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      const p = url.searchParams;
      expect(p.get("client_id")).toBe("stored-id.apps.googleusercontent.com");
      expect(p.get("response_type")).toBe("code");
      expect(p.get("access_type")).toBe("offline");
      // Without prompt=consent Google will not re-issue a refresh token, which is the entire point.
      expect(p.get("prompt")).toBe("consent");
      expect(p.get("redirect_uri")).toBe(`${ORIGIN}${OB_API_PREFIX}/google/callback`);
      expect(p.get("scope")).toBe(
        "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar",
      );
      expect(p.get("state")!.length).toBeGreaterThanOrEqual(32);
      // The client secret must never leave the server.
      expect(res.text).not.toContain(CLIENT_SECRET);
    });
  });

  test("GET /google/auth (no bearer) resumes a minted state: 302 to Google with THAT state", async () => {
    await withApi(async ({ call, authStart }) => {
      const state = await authStart();
      const res = await call(`/google/auth?state=${state}`, { token: null });
      expect(res.status).toBe(302);
      const p = new URL(res.headers.get("location")!).searchParams;
      expect(p.get("state")).toBe(state);
      expect(p.get("redirect_uri")).toBe(`${ORIGIN}${OB_API_PREFIX}/google/callback`);
      expect(p.get("prompt")).toBe("consent");
      expect(p.get("access_type")).toBe("offline");
      // Nothing was burned by the redirect: the callback can still complete.
      const done = await call(`/google/callback?state=${state}&code=${CODE}`, { token: null });
      expect(done.status).toBe(200);
    });
  });

  test("an unauthenticated caller CANNOT mint: GET /google/auth without a state refuses by name", async () => {
    await withApi(async ({ calls, call }) => {
      const res = await call("/google/auth", { token: null });
      expect(res.status).toBe(400);
      expect(res.text).toContain("no state on the callback");
      // No state was minted, so no callback can be completed and no credential can be replaced.
      expect(calls).toEqual([]);
      const unknown = await call(`/google/auth?state=${randomUUID()}`, { token: null });
      expect(unknown.status).toBe(400);
      expect(unknown.text).toContain("was not minted by this server");
    });
  });

  test("each mint is a NEW state (no reuse), and X-Forwarded-Proto makes the callback https", async () => {
    await withApi(async ({ call }) => {
      const a = await call("/google/auth-url", { method: "POST" });
      const b = await call("/google/auth-url", { method: "POST" });
      const sa = new URL(a.json.url).searchParams.get("state");
      const sb = new URL(b.json.url).searchParams.get("state");
      expect(sa).not.toBe(sb);

      const proxied = await call("/google/auth-url", {
        method: "POST",
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "ob-api.example.test" },
      });
      const p = new URL(proxied.json.url).searchParams;
      expect(p.get("redirect_uri")).toBe("https://ob-api.example.test/api/ob/google/callback");
    });
  });

  test("a mint with no stored google creds refuses by name (no half-built URL)", async () => {
    await withApi(async ({ store, call }) => {
      await setSecret(store, "google", "", KEY.get());
      const res = await call("/google/auth-url", { method: "POST" });
      expect(res.status).toBe(400);
      expect(res.json.error.message).toContain("no OAuth client credentials");
      expect(res.text).not.toContain(CLIENT_SECRET);
    });
  });

  test("a mint the state store cannot lock answers 503 busy with the sentence, not a stack (OB-1935)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob1935-"));
    try {
      const states = createGoogleStateStore(STATE_TTL_MS, join(dir, "state.json"), { flock: () => -1, waitMs: 0 });
      await withApi(
        async ({ call }) => {
          const res = await call("/google/auth-url", { method: "POST" });
          expect(res.status).toBe(503);
          expect(res.json.error).toEqual({ code: "busy", message: stateRefusalSentence("busy") });
        },
        { states },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("hosted Google auth -- GET /google/callback (1305)", () => {
  test("converts the code, stores secret google, and says a refresh token was issued", async () => {
    await withApi(async ({ store, calls, call, authStart }) => {
      const state = await authStart();
      const res = await call(`/google/callback?state=${state}&code=${CODE}`, { token: null });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.text).toContain("done — you can close this");
      expect(res.text).toContain("Refresh token issued");
      expect(res.text).not.toContain(CODE);
      expect(res.text).not.toContain(state);
      expect(res.text).not.toContain(ACCESS);
      expect(res.text).not.toContain(REFRESH);
      expect(res.text).not.toContain(CLIENT_SECRET);

      // The exchange used the SAME redirect_uri the state was minted for.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.code).toBe(CODE);
      expect(calls[0]!.redirectUri).toBe(`${ORIGIN}${OB_API_PREFIX}/google/callback`);

      // Persisted through the existing secret path -- no second store, no file.
      const stored = JSON.parse((await getSecret(store, "google", KEY.get()))!) as {
        access_token: string;
        refresh_token?: string;
        client_id: string;
      };
      expect(stored.access_token).toBe(ACCESS);
      expect(stored.refresh_token).toBe(REFRESH);
      expect(stored.client_id).toBe("stored-id.apps.googleusercontent.com");
    });
  });

  test("no refresh token → the page says so plainly (it does not claim success)", async () => {
    await withApi(
      async ({ call, authStart }) => {
        const state = await authStart();
        const res = await call(`/google/callback?state=${state}&code=${CODE}`, { token: null });
        expect(res.status).toBe(200);
        expect(res.text).toContain("done — you can close this");
        expect(res.text).toContain("No refresh token was issued");
      },
      { exchange: async () => ({ access_token: ACCESS, expires_in: 3600 }) },
    );
  });

  test("no refresh token from Google keeps the stored one and saves the new access token (OB-1916)", async () => {
    await withApi(
      async ({ store, call, authStart }) => {
        const state = await authStart();
        const res = await call(`/google/callback?state=${state}&code=${CODE}`, { token: null });
        expect(res.text).toContain("No refresh token was issued");
        const stored = JSON.parse((await getSecret(store, "google", KEY.get()))!) as {
          access_token: string;
          refresh_token?: string;
        };
        expect(stored.access_token).toBe(ACCESS);
        expect(stored.refresh_token).toBe("dead-refresh");
      },
      { exchange: async () => ({ access_token: ACCESS, expires_in: 3600 }) },
    );
  });

  test("a stored value with client creds but no refresh token saves the new token with none (OB-1916)", async () => {
    await withApi(
      async ({ store, call, authStart }) => {
        await setSecret(
          store,
          "google",
          JSON.stringify({ access_token: "dead-access", client_id: "stored-id.apps.googleusercontent.com", client_secret: CLIENT_SECRET }),
          KEY.get(),
        );
        const state = await authStart();
        await call(`/google/callback?state=${state}&code=${CODE}`, { token: null });
        const stored = JSON.parse((await getSecret(store, "google", KEY.get()))!) as {
          access_token: string;
          refresh_token?: string;
        };
        expect(stored.access_token).toBe(ACCESS);
        expect(stored.refresh_token).toBeUndefined();
      },
      { exchange: async () => ({ access_token: ACCESS, expires_in: 3600 }) },
    );
  });

  test("an ABSENT state is refused by name, and the exchange is never called", async () => {
    await withApi(async ({ calls, call }) => {
      const res = await call(`/google/callback?code=${CODE}`, { token: null });
      expect(res.status).toBe(400);
      expect(res.text).toContain("no state on the callback");
      expect(calls).toEqual([]);
      expect(res.text).not.toContain(CODE);
    });
  });

  test("a REPLAYED state is refused by name and the code is never exchanged twice", async () => {
    await withApi(async ({ calls, call, authStart }) => {
      const state = await authStart();
      const first = await call(`/google/callback?state=${state}&code=${CODE}`, { token: null });
      expect(first.status).toBe(200);
      const replay = await call(`/google/callback?state=${state}&code=${CODE}`, { token: null });
      expect(replay.status).toBe(400);
      expect(replay.text).toContain("already used");
      expect(replay.text).toContain("replay");
      expect(calls).toHaveLength(1);
      expect(replay.text).not.toContain(CODE);
    });
  });

  test("an UNKNOWN state is refused by name", async () => {
    await withApi(async ({ calls, call }) => {
      const res = await call(`/google/callback?state=${randomUUID()}&code=${CODE}`, { token: null });
      expect(res.status).toBe(400);
      expect(res.text).toContain("was not minted by this server");
      expect(calls).toEqual([]);
    });
  });

  test("an EXPIRED state is refused by name", async () => {
    let now = 1_000_000;
    await withApi(
      async ({ calls, call, authStart }) => {
        const state = await authStart();
        now += STATE_TTL_MS + 1;
        const res = await call(`/google/callback?state=${state}&code=${CODE}`, { token: null });
        expect(res.status).toBe(400);
        expect(res.text).toContain("state expired");
        expect(calls).toEqual([]);
        // …and it stays refused AS EXPIRED (OB-1935): time only moves forward, so a retry cannot revive it.
        const retry = await call(`/google/callback?state=${state}&code=${CODE}`, { token: null });
        expect(retry.status).toBe(400);
        expect(retry.text).toContain("state expired");
        expect(calls).toEqual([]);
      },
      { now: () => now },
    );
  });

  test("a state with no code is refused by name, and Google's error is surfaced without the code", async () => {
    await withApi(async ({ calls, call, authStart }) => {
      const noCode = await authStart();
      const missing = await call(`/google/callback?state=${noCode}`, { token: null });
      expect(missing.status).toBe(400);
      expect(missing.text).toContain("no authorization code");

      const denied = await authStart();
      const err = await call(`/google/callback?state=${denied}&error=access_denied`, { token: null });
      expect(err.status).toBe(400);
      expect(err.text).toContain("access_denied");
      expect(calls).toEqual([]);
    });
  });

  test("an exchange failure is reported generically -- the code never reaches the page", async () => {
    await withApi(
      async ({ call, authStart }) => {
        const state = await authStart();
        const res = await call(`/google/callback?state=${state}&code=${CODE}`, { token: null });
        expect(res.status).toBe(400);
        expect(res.text).toContain("the code exchange with Google failed");
        expect(res.text).not.toContain(CODE);
      },
      {
        exchange: async () => {
          throw new Error(`upstream said no (code=${CODE})`);
        },
      },
    );
  });
});

describe("hosted Google auth -- auth gating + railed-off surface (1305)", () => {
  test("the two browser routes are the ONLY paths that skip the bearer token", async () => {
    await withApi(async ({ call, authStart }) => {
      // /google/auth and /google/callback: no bearer required. The auth route answers a minted state with
      // a redirect, and the callback burns it (asserted above). Everything else authenticates first.
      expect((await call("/google/auth", { token: null })).status).toBe(400); // no state: refused, not minted
      const state = await authStart();
      expect((await call(`/google/auth?state=${state}`, { token: null })).status).toBe(302);
      expect((await call("/google/callback?state=nope", { token: null })).status).toBe(400);
      // Everything else still authenticates first, including near-misses and the authenticated mint.
      for (const p of ["/google/auth-url", "/google/authorize", "/google/callback/extra", "/google/auth?x=1"]) {
        expect((await call(p, { token: null, method: "POST" })).status).toBe(401);
      }
      expect((await call("/google/auth-url", { token: null, method: "POST" })).status).toBe(401);
      expect((await call(`/google/auth?state=${state}`, { token: null, method: "POST" })).status).toBe(401);
      // The authenticated mint works with the bearer.
      const mint = await call("/google/auth-url", { method: "POST" });
      expect(mint.status).toBe(200);
      const consent = new URL(mint.json.url);
      expect(consent.searchParams.get("redirect_uri")).toBe(`${ORIGIN}${OB_API_PREFIX}/google/callback`);
      expect(consent.searchParams.get("prompt")).toBe("consent");
      expect(consent.searchParams.get("state")).toBeTruthy();
    });
  });

  test("the redirect_uri is pinned by config when set (the registered public one)", async () => {
    await withApi(async ({ store, call, authStart }) => {
      await setConfig(store, "google_oauth_redirect_uri", "https://ob-api.example.test/api/ob/google/callback");
      const mint = await call("/google/auth-url", { method: "POST" });
      expect(new URL(mint.json.url).searchParams.get("redirect_uri")).toBe(
        "https://ob-api.example.test/api/ob/google/callback",
      );
      const state = await authStart();
      const resumed = await call(`/google/auth?state=${state}`, { token: null });
      const p = new URL(resumed.headers.get("location")!).searchParams;
      expect(p.get("redirect_uri")).toBe("https://ob-api.example.test/api/ob/google/callback");
    });
  });

  test("a bad method or trailing path on the browser routes is not silently served", async () => {
    await withApi(async ({ call }) => {
      expect((await call("/google/callback", { token: null, method: "POST" })).status).toBe(401);
      expect((await call("/google/auth/extra", { token: null })).status).toBe(401);
      // With a valid token those are honest 404s that list what IS served.
      const unknown = await call("/google/callback", { method: "POST" });
      expect(unknown.status).toBe(404);
      expect(unknown.json.error.served.join("\n")).toContain("GET /api/ob/google/callback");
    });
  });
});

describe("hosted Google auth -- CLI + docs (1305)", () => {
  test("`ob google auth-url` prints the server's URL and opens no local database", async () => {
    const calls: ApiRequest[] = [];
    const transport: ApiTransport = async (req) => {
      calls.push(req);
      return {
        status: 200,
        body: JSON.stringify({
          url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&state=st&prompt=consent",
        }),
      };
    };
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, ["google", "auth-url"], {
      api: { base: "https://ob-api.example.test", token: TOKEN, transport },
    });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&state=st&prompt=consent",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://ob-api.example.test/api/ob/google/auth-url");
    // No local DB, and the token never appears in the output.
    expect(existsSync(dbPath)).toBe(false);
    expect(r.out).not.toContain(TOKEN);
    expect(r.err).not.toContain(TOKEN);
  });

  test("the local (no API) path refuses auth-url and points at the desktop flow", async () => {
    const r = await runCli(freshDbPath(), ["google", "auth-url"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("needs the API");
    expect(r.err).toContain("ob google auth");
  });

  test("docs: HELP and the route list carry the hosted half", () => {
    expect(HELP).toContain("google auth-url");
    expect(HELP).toContain("HOSTED");
    const routes = OB_API_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(routes).toContain("GET /google/auth");
    expect(routes).toContain("GET /google/callback");
    expect(routes).toContain("POST /google/auth-url");
  });
});

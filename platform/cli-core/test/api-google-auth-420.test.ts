// ob 420 -- `ob google auth` on an API client RUNS the loopback and persists via the secret API.
//
// 415 classified it routed-so-the-handler-can-refuse. Wrong half. Loopback needs a browser here;
// the token `gmail sync` uses lives on the API host. Persist is POST /secrets (`secret set google`).
// No google HTTP endpoint. No local DB. No `~/.google_token`. No live Google.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { unroutedRefusal } from "../../../apps/cli/src/api/routing.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { HELP } from "../../../apps/cli/src/cli.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import type { Loopback, TokenExchangeResponse } from "../../cli-sources/src/commands/google.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";
const SECRET = "flow-client-secret-DO-NOT-LOG";
const ACCESS = "flow-access-token-DO-NOT-LOG";
const REFRESH = "flow-refresh-token-DO-NOT-LOG";

const fixture: TokenExchangeResponse = {
  access_token: ACCESS,
  refresh_token: REFRESH,
  expires_in: 1800,
};

interface Stub {
  transport: ApiTransport;
  calls: ApiRequest[];
}

function stub(answers: Record<string, unknown>): Stub {
  const calls: ApiRequest[] = [];
  const transport: ApiTransport = async (req) => {
    calls.push(req);
    const path = req.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]!;
    const key = `${req.method} ${path}`;
    if (!(key in answers)) {
      return {
        status: 404,
        body: JSON.stringify({ error: { code: "unknown_endpoint", message: `no stub for ${key}` } }),
      };
    }
    return { status: 200, body: JSON.stringify(answers[key]) };
  };
  return { transport, calls };
}

function api(s: Stub) {
  return { api: { base: BASE, token: TOKEN, transport: s.transport } };
}

function seams() {
  let openedUrl = "";
  return {
    opened: () => openedUrl,
    googleAuth: {
      exchange: async () => fixture,
      openUrl: (url: string) => {
        openedUrl = url;
      },
      startLoopback: (): Loopback => ({
        redirectUri: "http://127.0.0.1:65000",
        waitForCode: async () => ({
          code: "auth-code-123",
          state: new URL(openedUrl).searchParams.get("state") ?? undefined,
        }),
        close: () => {},
      }),
    },
  };
}

describe("docs (420)", () => {
  test("HELP says google auth RUNS on an API client, not unset-OMNISLASH_API", () => {
    expect(HELP).toContain("google auth");
    expect(HELP).toContain("SPLIT (420)");
    expect(HELP).toContain("RUNS on THIS machine");
    expect(HELP).not.toContain("'google auth' refuses BY NAME");
    expect(HELP).not.toMatch(/google auth[\s\S]{0,200}unset OMNISLASH_API/);
  });
});

describe("`ob google auth` on an API client (420)", () => {
  test("missing creds is a usage error naming the flags; not unroutedRefusal; not the 415 unset-API string", async () => {
    const s = stub({});
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, ["google", "auth"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("no OAuth client credentials");
    expect(r.err).toContain("--client");
    expect(r.err).toContain("--client-id");
    expect(r.err).toContain("--client-secret");
    expect(r.err).toContain("store secret google with client_id/client_secret from a prior auth");
    expect(r.err).not.toContain("google_oauth_client_path");
    expect(r.err).not.toContain("unset OMNISLASH_API");
    expect(r.err).not.toContain("run it on the API host");
    expect(r.err).not.toContain(unroutedRefusal("google", BASE));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.method).toBe("POST");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/secrets/read`);
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ name: "google" });
    expect(existsSync(dbPath)).toBe(false);
  });

  test("unknown sub is a usage error and does not call the API", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["google", "frobnicate"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown google subcommand 'frobnicate'");
    expect(r.err).not.toContain("unset OMNISLASH_API");
    expect(r.err).not.toContain(unroutedRefusal("google", BASE));
    expect(s.calls).toEqual([]);
  });

  test("bare `ob google` is a usage error (auth is the only sub), not a 415 refusal", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["google"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown google subcommand");
    expect(r.err).not.toContain("unset OMNISLASH_API");
    expect(r.err).not.toContain("run it on the API host");
    expect(s.calls).toEqual([]);
  });

  test("auth runs the loopback seams, persists via POST /secrets, opens no sqlite, does not print the token", async () => {
    const s = stub({
      "POST /secrets": { name: "google", set: true, updated_at: "2026-08-24T00:00:00.000Z" },
    });
    const dbPath = freshDbPath();
    const { googleAuth, opened } = seams();
    const r = await runCli(
      dbPath,
      ["google", "auth", "--client-id", "flow-id", "--client-secret", SECRET, "--scopes", "gmail.send"],
      { ...api(s), googleAuth },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("stored Google token as secret `google`");
    expect(r.out).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(r.out).toContain("https://www.googleapis.com/auth/gmail.modify");
    expect(r.out).toContain("https://www.googleapis.com/auth/calendar");
    expect(r.out).not.toContain(SECRET);
    expect(r.out).not.toContain(ACCESS);
    expect(r.out).not.toContain(REFRESH);
    expect(r.err).not.toContain(ACCESS);
    expect(r.err).not.toContain("unset OMNISLASH_API");
    expect(r.err).not.toContain(unroutedRefusal("google", BASE));

    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.method).toBe("POST");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/secrets`);
    const body = JSON.parse(s.calls[0]!.body!) as { name: string; value: string };
    expect(body.name).toBe("google");
    const stored = JSON.parse(body.value) as { access_token: string; refresh_token?: string };
    expect(stored.access_token).toBe(ACCESS);
    expect(stored.refresh_token).toBe(REFRESH);
    expect(s.calls[0]!.url).not.toContain(ACCESS);
    expect(s.calls[0]!.url).not.toContain("google");

    expect(existsSync(dbPath)).toBe(false);
    expect(new URL(opened()).searchParams.get("access_type")).toBe("offline");
    expect(new URL(opened()).searchParams.get("redirect_uri")).toBe("http://127.0.0.1:65000");
  });
});

describe("`ob google auth` stored client creds (424)", () => {
  const STORED_SECRET = "stored-client-secret-DO-NOT-LOG";
  const DEAD_ACCESS = "dead-access-token-DO-NOT-LOG";
  const DEAD_REFRESH = "dead-refresh-token-DO-NOT-LOG";

  function storedGoogle(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      access_token: DEAD_ACCESS,
      refresh_token: DEAD_REFRESH,
      expiry: "2020-01-01T00:00:00.000Z",
      client_id: "stored-id.apps.googleusercontent.com",
      client_secret: STORED_SECRET,
      ...over,
    });
  }

  test("no --client, transport returns google JSON with client fields → loopback runs (seams)", async () => {
    const s = stub({
      "POST /secrets/read": { name: "google", value: storedGoogle() },
      "POST /secrets": { name: "google", set: true, updated_at: "2026-08-24T00:00:00.000Z" },
    });
    const dbPath = freshDbPath();
    const { googleAuth, opened } = seams();
    const r = await runCli(dbPath, ["google", "auth"], { ...api(s), googleAuth });
    expect(r.code).toBe(0);
    expect(r.out).toContain("stored Google token as secret `google`");
    expect(r.out).not.toContain(STORED_SECRET);
    expect(r.out).not.toContain(DEAD_ACCESS);
    expect(r.out).not.toContain(DEAD_REFRESH);
    expect(r.out).not.toContain(ACCESS);
    expect(r.out).not.toContain(REFRESH);
    expect(r.err).not.toContain(STORED_SECRET);
    expect(r.err).not.toContain(unroutedRefusal("google", BASE));

    expect(s.calls).toHaveLength(2);
    expect(s.calls[0]!.method).toBe("POST");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/secrets/read`);
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ name: "google" });
    expect(s.calls[0]!.url).not.toContain("google");
    expect(s.calls[1]!.method).toBe("POST");
    expect(s.calls[1]!.url).toBe(`${BASE}${OB_API_PREFIX}/secrets`);
    const body = JSON.parse(s.calls[1]!.body!) as { name: string; value: string };
    expect(body.name).toBe("google");
    const stored = JSON.parse(body.value) as {
      access_token: string;
      client_id: string;
      client_secret: string;
    };
    expect(stored.access_token).toBe(ACCESS);
    expect(stored.client_id).toBe("stored-id.apps.googleusercontent.com");
    expect(stored.client_secret).toBe(STORED_SECRET);

    expect(existsSync(dbPath)).toBe(false);
    expect(new URL(opened()).searchParams.get("client_id")).toBe("stored-id.apps.googleusercontent.com");
    expect(new URL(opened()).searchParams.get("access_type")).toBe("offline");
  });

  test("missing google secret → usage error, no unrouted refusal", async () => {
    const s = stub({});
    const { googleAuth } = seams();
    const r = await runCli(freshDbPath(), ["google", "auth"], { ...api(s), googleAuth });
    expect(r.code).toBe(2);
    expect(r.err).toContain("no OAuth client credentials");
    expect(r.err).toContain("--client");
    expect(r.err).toContain("store secret google with client_id/client_secret from a prior auth");
    expect(r.err).not.toContain(unroutedRefusal("google", BASE));
    expect(r.err).not.toContain("google_oauth_client_path");
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/secrets/read`);
  });

  test("empty google secret → usage error, no unrouted refusal, no persist", async () => {
    const s = stub({ "POST /secrets/read": { name: "google", value: "" } });
    const { googleAuth } = seams();
    const r = await runCli(freshDbPath(), ["google", "auth"], { ...api(s), googleAuth });
    expect(r.code).toBe(2);
    expect(r.err).toContain("no OAuth client credentials");
    expect(r.err).toContain("store secret google with client_id/client_secret from a prior auth");
    expect(r.err).not.toContain(unroutedRefusal("google", BASE));
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/secrets/read`);
  });

  test("google JSON without client fields → usage error, no persist", async () => {
    const s = stub({
      "POST /secrets/read": {
        name: "google",
        value: storedGoogle({ client_id: "", client_secret: "" }),
      },
    });
    const r = await runCli(freshDbPath(), ["google", "auth"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("no OAuth client credentials");
    expect(r.err).not.toContain(unroutedRefusal("google", BASE));
    expect(s.calls).toHaveLength(1);
  });
});

describe("`ob google auth` on an API client keeps the stored refresh token (OB-1916)", () => {
  const STORED = JSON.stringify({
    access_token: "old-access-DO-NOT-LOG",
    refresh_token: "stored-R-DO-NOT-LOG",
    client_id: "stored-id.apps.googleusercontent.com",
    client_secret: "stored-secret-DO-NOT-LOG",
  });

  function noRefreshSeams() {
    const s = seams();
    return { ...s, googleAuth: { ...s.googleAuth, exchange: async () => ({ access_token: ACCESS, expires_in: 1800 }) } };
  }

  test("a stored token with R and an exchange with none: the POSTed body carries R", async () => {
    const s = stub({
      "POST /secrets/read": { name: "google", value: STORED },
      "POST /secrets": { name: "google", set: true, updated_at: "2026-11-11T00:00:00.000Z" },
    });
    const { googleAuth } = noRefreshSeams();
    const r = await runCli(freshDbPath(), ["google", "auth"], { ...api(s), googleAuth });
    expect(r.code).toBe(0);
    expect(s.calls).toHaveLength(2);
    const body = JSON.parse(s.calls[1]!.body!) as { value: string };
    const stored = JSON.parse(body.value) as { access_token: string; refresh_token?: string };
    expect(stored.access_token).toBe(ACCESS);
    expect(stored.refresh_token).toBe("stored-R-DO-NOT-LOG");
    expect(r.out).not.toContain("stored-R-DO-NOT-LOG");
  });

  test("with --client flags no stored value is read and the POSTed token is the exchange's", async () => {
    const s = stub({ "POST /secrets": { name: "google", set: true, updated_at: "2026-11-11T00:00:00.000Z" } });
    const { googleAuth } = noRefreshSeams();
    const r = await runCli(freshDbPath(), ["google", "auth", "--client-id", "flow-id", "--client-secret", SECRET], {
      ...api(s),
      googleAuth,
    });
    expect(r.code).toBe(0);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/secrets`);
    const stored = JSON.parse((JSON.parse(s.calls[0]!.body!) as { value: string }).value) as {
      access_token: string;
      refresh_token?: string;
    };
    expect(stored.access_token).toBe(ACCESS);
    expect(stored.refresh_token).toBeUndefined();
  });
});

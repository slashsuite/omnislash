import { describe, expect, test } from "bun:test";
import { AppError } from "../../../apps/cli/src/errors.ts";
import {
  GOOGLE_HTTP_TIMEOUT_MS,
  GoogleHttpError,
  HttpGoogleClient,
  SyncTokenExpiredError,
  isExpiredGmailHistory,
  isGoneGoogleMessage,
  type GoogleFetch,
  type GoogleToken,
} from "../src/google.ts";

const LIVE: GoogleToken = { access_token: "at", expiry: "2999-01-01T00:00:00Z" };
const EXPIRED: GoogleToken = {
  access_token: "old",
  refresh_token: "rt",
  client_id: "cid",
  client_secret: "sec",
  expiry: "2000-01-01T00:00:00Z",
};

function abortErr(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

/** Resolves only when the caller aborts — the hang that used to hold gmail-sync for days. */
const hangingFetch: GoogleFetch = (_input, init) => {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(abortErr());
      return;
    }
    signal.addEventListener("abort", () => reject(abortErr()), { once: true });
  });
};

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("isGoneGoogleMessage (177)", () => {
  test("404 and 403 are gone; 401/429 and a plain AppError are not", () => {
    expect(isGoneGoogleMessage(new GoogleHttpError(404, "https://example/m"))).toBe(true);
    expect(isGoneGoogleMessage(new GoogleHttpError(403, "https://example/m"))).toBe(true);
    expect(isGoneGoogleMessage(new GoogleHttpError(401, "https://example/m"))).toBe(false);
    expect(isGoneGoogleMessage(new GoogleHttpError(429, "https://example/m"))).toBe(false);
    expect(isGoneGoogleMessage(new AppError("Google API request failed (404) for https://example/m"))).toBe(false);
    expect(isGoneGoogleMessage(new TypeError("fetch failed"))).toBe(false);
    expect(isGoneGoogleMessage(null)).toBe(false);
  });
});

describe("isExpiredGmailHistory (751)", () => {
  test("404 on /history is expired; message 404 and other statuses are not", () => {
    expect(
      isExpiredGmailHistory(
        new GoogleHttpError(404, "https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=1"),
      ),
    ).toBe(true);
    expect(
      isExpiredGmailHistory(new GoogleHttpError(404, "https://gmail.googleapis.com/gmail/v1/users/me/history")),
    ).toBe(true);
    expect(
      isExpiredGmailHistory(
        new GoogleHttpError(404, "https://gmail.googleapis.com/gmail/v1/users/me/messages/gone?format=full"),
      ),
    ).toBe(false);
    expect(
      isExpiredGmailHistory(
        new GoogleHttpError(403, "https://gmail.googleapis.com/gmail/v1/users/me/history?startHistoryId=1"),
      ),
    ).toBe(false);
    expect(isExpiredGmailHistory(new GoogleHttpError(401, "https://example/history"))).toBe(false);
    expect(isExpiredGmailHistory(new AppError("Google API request failed (404) for https://example/history"))).toBe(
      false,
    );
    expect(isExpiredGmailHistory(null)).toBe(false);
  });
});

describe("HttpGoogleClient HTTP (177)", () => {
  test("default timeout is 30s", () => {
    expect(GOOGLE_HTTP_TIMEOUT_MS).toBe(30_000);
  });

  test("404/403 on GET throw GoogleHttpError with the stable message shape", async () => {
    const c = new HttpGoogleClient(LIVE, undefined, {
      fetch: async () => jsonResponse(404, { error: "notFound" }),
    });
    try {
      await c.gmailGetMessage("gone");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(GoogleHttpError);
      expect(err).toBeInstanceOf(AppError);
      const e = err as GoogleHttpError;
      expect(e.status).toBe(404);
      expect(e.message).toMatch(/^Google API request failed \(404\) for /);
      expect(e.message).toContain("messages/gone");
      expect(isGoneGoogleMessage(err)).toBe(true);
    }

    const c403 = new HttpGoogleClient(LIVE, undefined, { fetch: async () => jsonResponse(403) });
    await expect(c403.gmailGetMessage("x")).rejects.toMatchObject({ status: 403 });
  });

  test("401 and 429 throw GoogleHttpError but are not gone", async () => {
    for (const status of [401, 429]) {
      const c = new HttpGoogleClient(LIVE, undefined, { fetch: async () => jsonResponse(status) });
      try {
        await c.gmailGetMessage("x");
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(GoogleHttpError);
        expect((err as GoogleHttpError).status).toBe(status);
        expect(isGoneGoogleMessage(err)).toBe(false);
      }
    }
  });

  test("410 throws SyncTokenExpiredError (calendar stale syncToken)", async () => {
    const c = new HttpGoogleClient(LIVE, undefined, { fetch: async () => jsonResponse(410) });
    await expect(c.calendarListEvents({ calendarId: "primary" })).rejects.toBeInstanceOf(SyncTokenExpiredError);
  });

  test("200 returns the JSON body", async () => {
    const c = new HttpGoogleClient(LIVE, undefined, {
      fetch: async () => jsonResponse(200, { id: "m1", threadId: "t1" }),
    });
    expect(await c.gmailGetMessage("m1")).toEqual({ id: "m1", threadId: "t1" });
  });

  test("a hanging GET times out instead of holding the process", async () => {
    const c = new HttpGoogleClient(LIVE, undefined, { fetch: hangingFetch, timeoutMs: 20 });
    const start = Date.now();
    await expect(c.gmailGetMessage("x")).rejects.toThrow(/timed out after 20ms/);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test("a hanging token refresh times out with a refresh-specific message", async () => {
    const c = new HttpGoogleClient(EXPIRED, undefined, { fetch: hangingFetch, timeoutMs: 20 });
    await expect(c.gmailGetMessage("x")).rejects.toThrow(/token refresh timed out after 20ms/);
  });
});

// --- OB-1916: missing expiry, 401 refresh-and-retry, single flight, rotation -----------------------------

const TOKEN_URI = "https://oauth2.googleapis.com/token";
type Call = { url: string; method: string; auth: string | null; body: string | null };

/** A fake fetch that records every call and answers the token POST and the API calls from scripted queues. */
function scripted(opts: { token?: Response[]; api?: Response[] }) {
  const calls: Call[] = [];
  const tokenQ = [...(opts.token ?? [])];
  const apiQ = [...(opts.api ?? [])];
  const fetchImpl: GoogleFetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined || init?.body === null ? null : String(init.body);
    calls.push({ url, method: init?.method ?? "GET", auth: headers.get("authorization"), body });
    const q = url === TOKEN_URI ? tokenQ : apiQ;
    const next = q.shift();
    if (!next) throw new Error(`unexpected call to ${url}`);
    return next;
  };
  return {
    calls,
    fetchImpl,
    tokenPosts: () => calls.filter((c) => c.url === TOKEN_URI).length,
    apiCalls: () => calls.filter((c) => c.url !== TOKEN_URI),
  };
}

const REFRESHABLE: GoogleToken = {
  access_token: "old",
  refresh_token: "rt",
  client_id: "cid",
  client_secret: "sec",
  expiry: "2999-01-01T00:00:00Z",
};

describe("HttpGoogleClient token handling (OB-1916)", () => {
  test("a token with no expiry refreshes before the first call, and only once", async () => {
    const { expiry: _e, ...noExpiry } = REFRESHABLE;
    const f = scripted({
      token: [jsonResponse(200, { access_token: "fresh", expires_in: 3600 })],
      api: [jsonResponse(200, { id: "a" }), jsonResponse(200, { id: "b" })],
    });
    const c = new HttpGoogleClient(noExpiry, undefined, { fetch: f.fetchImpl });
    await c.gmailGetMessage("a");
    expect(f.calls[0].url).toBe(TOKEN_URI);
    expect(f.calls[1].auth).toBe("Bearer fresh");
    await c.gmailGetMessage("b");
    expect(f.tokenPosts()).toBe(1);
  });

  test("a token with no expiry whose refresh is rejected still uses its access token, and does not retry the refresh", async () => {
    const { expiry: _e, ...noExpiry } = REFRESHABLE;
    const f = scripted({
      token: [jsonResponse(400, { error: "invalid_grant" })],
      api: [jsonResponse(200, { id: "a" }), jsonResponse(200, { id: "b" })],
    });
    const c = new HttpGoogleClient(noExpiry, undefined, { fetch: f.fetchImpl });
    expect(await c.gmailGetMessage("a")).toEqual({ id: "a" });
    expect(f.apiCalls()[0].auth).toBe("Bearer old");
    await c.gmailGetMessage("b");
    expect(f.tokenPosts()).toBe(1);
  });

  test("concurrent calls on a token with no expiry whose refresh is rejected all fall back to the access token", async () => {
    const { expiry: _e, ...noExpiry } = REFRESHABLE;
    let tokenPosts = 0;
    const fetchImpl: GoogleFetch = async (input) => {
      if (String(input) === TOKEN_URI) {
        tokenPosts++;
        await Promise.resolve();
        return jsonResponse(400);
      }
      return jsonResponse(200, { id: "ok" });
    };
    const c = new HttpGoogleClient(noExpiry, undefined, { fetch: fetchImpl });
    expect(await Promise.all([c.gmailGetMessage("a"), c.gmailGetMessage("b")])).toEqual([{ id: "ok" }, { id: "ok" }]);
    expect(tokenPosts).toBe(1);
  });

  test("a token with no expiry whose refreshed token fails to save still throws", async () => {
    const { expiry: _e, ...noExpiry } = REFRESHABLE;
    const f = scripted({ token: [jsonResponse(200, { access_token: "fresh", expires_in: 3600 })], api: [] });
    const c = new HttpGoogleClient(
      noExpiry,
      () => {
        throw new Error("store write failed");
      },
      { fetch: f.fetchImpl },
    );
    await expect(c.gmailGetMessage("a")).rejects.toThrow("store write failed");
  });

  test("401 then 200: one refresh, one retry, success", async () => {
    const f = scripted({
      token: [jsonResponse(200, { access_token: "fresh", expires_in: 3600 })],
      api: [jsonResponse(401), jsonResponse(200, { id: "m" })],
    });
    const c = new HttpGoogleClient(REFRESHABLE, undefined, { fetch: f.fetchImpl });
    expect(await c.gmailGetMessage("m")).toEqual({ id: "m" });
    expect(f.tokenPosts()).toBe(1);
    expect(f.apiCalls().map((x) => x.auth)).toEqual(["Bearer old", "Bearer fresh"]);
  });

  test("401 twice: one refresh, one retry, then GoogleHttpError 401 (no loop)", async () => {
    const f = scripted({
      token: [jsonResponse(200, { access_token: "fresh", expires_in: 3600 })],
      api: [jsonResponse(401), jsonResponse(401)],
    });
    const c = new HttpGoogleClient(REFRESHABLE, undefined, { fetch: f.fetchImpl });
    await expect(c.gmailGetMessage("m")).rejects.toMatchObject({ status: 401 });
    expect(f.tokenPosts()).toBe(1);
    expect(f.apiCalls()).toHaveLength(2);
  });

  test("a rejected refresh after a 401 throws the refresh error with no retry", async () => {
    const f = scripted({ token: [jsonResponse(400)], api: [jsonResponse(401)] });
    const c = new HttpGoogleClient(REFRESHABLE, undefined, { fetch: f.fetchImpl });
    await expect(c.gmailGetMessage("m")).rejects.toThrow("Google token refresh failed (400)");
    expect(f.apiCalls()).toHaveLength(1);
  });

  test("single flight: two concurrent 401s make exactly one token POST", async () => {
    const calls: Call[] = [];
    let release!: () => void;
    const bothInFlight = new Promise<void>((r) => (release = r));
    let pendingApi = 0;
    const fetchImpl: GoogleFetch = async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization");
      calls.push({ url, method: init?.method ?? "GET", auth, body: null });
      if (url === TOKEN_URI) return jsonResponse(200, { access_token: "fresh", expires_in: 3600 });
      if (auth === "Bearer old") {
        pendingApi++;
        if (pendingApi === 2) release();
        await bothInFlight;
        return jsonResponse(401);
      }
      return jsonResponse(200, { id: "ok" });
    };
    const c = new HttpGoogleClient(REFRESHABLE, undefined, { fetch: fetchImpl });
    const results = await Promise.all([c.gmailGetMessage("a"), c.gmailGetMessage("b")]);
    expect(results).toEqual([{ id: "ok" }, { id: "ok" }]);
    expect(calls.filter((x) => x.url === TOKEN_URI)).toHaveLength(1);
    expect(calls.filter((x) => x.url !== TOKEN_URI && x.auth === "Bearer fresh")).toHaveLength(2);
  });

  test("a 401 on a POST via send retries the same body once", async () => {
    const f = scripted({
      token: [jsonResponse(200, { access_token: "fresh", expires_in: 3600 })],
      api: [jsonResponse(401), jsonResponse(200, { id: "d1" })],
    });
    const c = new HttpGoogleClient(REFRESHABLE, undefined, { fetch: f.fetchImpl });
    expect(await c.gmailCreateDraft({ raw: "UkFX" })).toEqual({ id: "d1" });
    const posts = f.apiCalls();
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.method)).toEqual(["POST", "POST"]);
    expect(posts[1].body).toBe(posts[0].body);
    expect(posts[1].auth).toBe("Bearer fresh");
  });

  test("rotation: a refresh carrying a new refresh token persists the new one; one without keeps the old", async () => {
    for (const [resp, want] of [
      [{ access_token: "fresh", expires_in: 3600, refresh_token: "rt-new" }, "rt-new"],
      [{ access_token: "fresh", expires_in: 3600 }, "rt"],
    ] as const) {
      const persisted: GoogleToken[] = [];
      const f = scripted({ token: [jsonResponse(200, resp)], api: [jsonResponse(200, { id: "m" })] });
      const c = new HttpGoogleClient(EXPIRED, (t) => void persisted.push(t), { fetch: f.fetchImpl });
      await c.gmailGetMessage("m");
      expect(persisted).toHaveLength(1);
      expect(persisted[0].refresh_token).toBe(want);
      expect(persisted[0].access_token).toBe("fresh");
    }
  });
});

describe("HttpGoogleClient invalid_grant (OB-1950)", () => {
  const SECRETS = ["old", "rt", "sec"];
  const noToken = (msg: string) => SECRETS.every((v) => !msg.split(/\W+/).includes(v));

  function spies() {
    const persisted: GoogleToken[] = [];
    let marks = 0;
    return {
      persisted,
      marks: () => marks,
      persist: (t: GoogleToken) => void persisted.push(t),
      onInvalidGrant: () => void marks++,
    };
  }

  test("an expired token refused with invalid_grant: hook once, marker persisted, AppError naming `ob google auth`", async () => {
    const s = spies();
    const f = scripted({ token: [jsonResponse(400, { error: "invalid_grant" })], api: [] });
    const c = new HttpGoogleClient(EXPIRED, s.persist, { fetch: f.fetchImpl, onInvalidGrant: s.onInvalidGrant });
    const err = await c.gmailGetMessage("m").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    const msg = (err as AppError).message;
    expect(msg).toContain("invalid_grant");
    expect(msg).toContain("ob google auth");
    expect(noToken(msg)).toBe(true);
    expect(s.marks()).toBe(1);
    expect(s.persisted).toHaveLength(1);
    expect(s.persisted[0].refresh_invalid_at).toBeString();
    expect(s.persisted[0].refresh_token).toBe("rt");
    expect(f.apiCalls()).toHaveLength(0);
  });

  test("a throwing hook and a throwing persist each still lead to the same AppError", async () => {
    for (const which of ["hook", "persist"] as const) {
      let persistCalls = 0;
      let hookCalls = 0;
      const f = scripted({ token: [jsonResponse(400, { error: "invalid_grant" })], api: [] });
      const c = new HttpGoogleClient(
        EXPIRED,
        () => {
          persistCalls++;
          if (which === "persist") throw new Error("store write failed");
        },
        {
          fetch: f.fetchImpl,
          onInvalidGrant: () => {
            hookCalls++;
            if (which === "hook") throw new Error("recorder failed");
          },
        },
      );
      await expect(c.gmailGetMessage("m")).rejects.toThrow("ob google auth");
      expect(hookCalls).toBe(1);
      expect(persistCalls).toBe(1);
    }
  });

  test("a 400 with another error or a non-JSON body is a plain refresh failure and calls neither", async () => {
    for (const resp of [
      jsonResponse(400, { error: "invalid_request" }),
      new Response("<html>nope</html>", { status: 400 }),
    ]) {
      const s = spies();
      const f = scripted({ token: [resp], api: [] });
      const c = new HttpGoogleClient(EXPIRED, s.persist, { fetch: f.fetchImpl, onInvalidGrant: s.onInvalidGrant });
      await expect(c.gmailGetMessage("m")).rejects.toThrow("Google token refresh failed (400)");
      expect(s.marks()).toBe(0);
      expect(s.persisted).toHaveLength(0);
    }
  });

  test("a token with no expiry refused with invalid_grant is marked and still sends its access token", async () => {
    const { expiry: _e, ...noExpiry } = REFRESHABLE;
    const s = spies();
    const f = scripted({ token: [jsonResponse(400, { error: "invalid_grant" })], api: [jsonResponse(200, { id: "a" })] });
    const c = new HttpGoogleClient(noExpiry, s.persist, { fetch: f.fetchImpl, onInvalidGrant: s.onInvalidGrant });
    expect(await c.gmailGetMessage("a")).toEqual({ id: "a" });
    expect(s.marks()).toBe(1);
    expect(s.persisted).toHaveLength(1);
    expect(s.persisted[0].refresh_invalid_at).toBeString();
    expect(f.apiCalls()[0].auth).toBe("Bearer old");
  });

  test("a marked token with an expired access token: no token POST, hook called, AppError", async () => {
    const s = spies();
    const f = scripted({ token: [], api: [] });
    const marked = { ...EXPIRED, refresh_invalid_at: "2026-11-01T00:00:00Z" };
    const c = new HttpGoogleClient(marked, s.persist, { fetch: f.fetchImpl, onInvalidGrant: s.onInvalidGrant });
    await expect(c.gmailGetMessage("m")).rejects.toThrow("ob google auth");
    expect(f.tokenPosts()).toBe(0);
    expect(f.calls).toHaveLength(0);
    expect(s.marks()).toBe(1);
  });

  test("a marked token with an unexpired access token sends it", async () => {
    const s = spies();
    const f = scripted({ token: [], api: [jsonResponse(200, { id: "m" })] });
    const marked = { ...REFRESHABLE, refresh_invalid_at: "2026-11-01T00:00:00Z" };
    const c = new HttpGoogleClient(marked, s.persist, { fetch: f.fetchImpl, onInvalidGrant: s.onInvalidGrant });
    expect(await c.gmailGetMessage("m")).toEqual({ id: "m" });
    expect(f.apiCalls()[0].auth).toBe("Bearer old");
    expect(s.marks()).toBe(0);
  });

  test("a marked token answered 401: no token POST, AppError", async () => {
    const s = spies();
    const f = scripted({ token: [], api: [jsonResponse(401)] });
    const marked = { ...REFRESHABLE, refresh_invalid_at: "2026-11-01T00:00:00Z" };
    const c = new HttpGoogleClient(marked, s.persist, { fetch: f.fetchImpl, onInvalidGrant: s.onInvalidGrant });
    await expect(c.gmailGetMessage("m")).rejects.toThrow("ob google auth");
    expect(f.tokenPosts()).toBe(0);
    expect(f.apiCalls()).toHaveLength(1);
    expect(s.marks()).toBe(1);
  });
});

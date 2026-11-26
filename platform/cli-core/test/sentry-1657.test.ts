import { describe, expect, test } from "bun:test";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import {
  flushSentry,
  reportError,
  resetSentryForTest,
  startSentry,
  type SentrySdk,
} from "../../../apps/cli/src/sentry/report.ts";
import { scrubEvent } from "../../../apps/cli/src/sentry/scrub.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";

const store = (async () => ({}) as Store) as () => Promise<Store>;

function fakeSdk() {
  const calls = { init: [] as Record<string, unknown>[], captured: [] as unknown[], flushed: 0 };
  const sdk: SentrySdk = {
    init: (o) => void calls.init.push(o),
    captureException: (e, hint) => void calls.captured.push([e, hint]),
    flush: async () => {
      calls.flushed++;
      return true;
    },
  };
  return { sdk, calls };
}

describe("ob 1657: Sentry is off without a DSN", () => {
  test("no DSN secret: the SDK is never loaded, nothing is initialised or sent", async () => {
    resetSentryForTest();
    let loaded = 0;
    const started = await startSentry("web", store, {
      readDsn: async () => null,
      env: {},
      sha: () => "abc1234",
      loadSdk: async () => {
        loaded++;
        return fakeSdk().sdk;
      },
    });
    expect(started).toBeNull();
    expect(loaded).toBe(0);
    reportError(new Error("boom"));
    await flushSentry();
  });

  test("a blank DSN counts as none", async () => {
    resetSentryForTest();
    const { sdk, calls } = fakeSdk();
    expect(await startSentry("bridge", store, { readDsn: async () => "  ", env: {}, loadSdk: async () => sdk })).toBeNull();
    expect(calls.init).toEqual([]);
  });

  test("a secret store that cannot be read leaves reporting off instead of throwing", async () => {
    resetSentryForTest();
    const failing = (async () => {
      throw new Error("database down");
    }) as () => Promise<Store>;
    expect(await startSentry("web", failing, { env: {} })).toBeNull();
  });

  test("an SDK that fails to load leaves reporting off instead of throwing", async () => {
    resetSentryForTest();
    const started = await startSentry("web", store, {
      readDsn: async () => "https://k@o1.ingest.us.sentry.io/1",
      env: {},
      loadSdk: async () => {
        throw new Error("cannot find module");
      },
    });
    expect(started).toBeNull();
  });
});

describe("ob 1657: Sentry on", () => {
  test("initialises once with release, environment, no tracing and no breadcrumbs", async () => {
    resetSentryForTest();
    const { sdk, calls } = fakeSdk();
    const started = await startSentry("web", store, {
      readDsn: async () => "https://k@o1.ingest.us.sentry.io/1",
      env: { OMNISLASH_SENTRY_ENVIRONMENT: "live" },
      sha: () => "68125b6b0123",
      loadSdk: async () => sdk,
    });
    expect(started).toEqual({ project: "omnislash-web", release: "68125b6b0123", environment: "live" });
    expect(calls.init).toHaveLength(1);
    const o = calls.init[0]!;
    expect(o.dsn).toBe("https://k@o1.ingest.us.sentry.io/1");
    expect(o.release).toBe("68125b6b0123");
    expect(o.environment).toBe("live");
    expect(o.tracesSampleRate).toBe(0);
    expect(o.maxBreadcrumbs).toBe(0);
    expect(o.sendDefaultPii).toBe(false);
    expect(o.beforeSend).toBe(scrubEvent);
    // The returned value names the project, never the DSN.
    expect(JSON.stringify(started)).not.toContain("ingest");
    reportError(new Error("boom"), { daemon: "x" });
    expect(calls.captured).toHaveLength(1);
    await flushSentry();
    expect(calls.flushed).toBe(1);
    resetSentryForTest();
  });

  test("the bridge reports to its own project; SENTRY_RELEASE pins the release; unset environment reads as dev", async () => {
    resetSentryForTest();
    const { sdk } = fakeSdk();
    const started = await startSentry("bridge", store, {
      readDsn: async () => "https://k@o1.ingest.us.sentry.io/2",
      env: { SENTRY_RELEASE: "pinned" },
      sha: () => "ignored",
      loadSdk: async () => sdk,
    });
    expect(started).toEqual({ project: "omnislash-whatsapp-bridge", release: "pinned", environment: "dev" });
    resetSentryForTest();
  });

  test("a checkout with no readable sha reports as release unknown", async () => {
    resetSentryForTest();
    const { sdk, calls } = fakeSdk();
    await startSentry("web", store, { readDsn: async () => "https://k@o1.ingest.us.sentry.io/1", env: {}, sha: () => null, loadSdk: async () => sdk });
    expect(calls.init[0]!.release).toBe("unknown");
    resetSentryForTest();
  });
});

describe("ob 1657: the ob API catch-all reports what it turns into a 500", () => {
  const TOKEN = "a-test-bearer-token-that-is-long-enough";
  const call = async (thunk: () => Promise<Store>) => {
    resetSentryForTest();
    const { sdk, calls } = fakeSdk();
    await startSentry("web", store, { readDsn: async () => "https://k@o1.ingest.us.sentry.io/1", env: {}, sha: () => "abc1234", loadSdk: async () => sdk });
    const api = createObApi({ store: thunk, token: () => ({ token: TOKEN, path: "/nowhere", reason: null, message: null }) });
    const res = await api(new Request(`http://api-host.local${OB_API_PREFIX}/next`, { headers: { authorization: `Bearer ${TOKEN}` } }));
    resetSentryForTest();
    return { res, calls };
  };

  test("an unexpected error is a 500 and one Sentry event", async () => {
    const { res, calls } = await call(async () => {
      throw new Error("db exploded");
    });
    expect(res.status).toBe(500);
    expect(calls.captured).toHaveLength(1);
    expect(String((calls.captured[0] as unknown[])[0])).toContain("db exploded");
  });

  test("a store stall (504 timeout) is reported too", async () => {
    resetSentryForTest();
    const { sdk, calls } = fakeSdk();
    await startSentry("web", store, { readDsn: async () => "https://k@o1.ingest.us.sentry.io/1", env: {}, loadSdk: async () => sdk });
    const api = createObApi({ store: () => new Promise<Store>(() => {}), requestTimeoutMs: 20, token: () => ({ token: TOKEN, path: "/nowhere", reason: null, message: null }) });
    const res = await api(new Request(`http://api-host.local${OB_API_PREFIX}/next`, { headers: { authorization: `Bearer ${TOKEN}` } }));
    expect(res.status).toBe(504);
    expect(calls.captured).toHaveLength(1);
    resetSentryForTest();
  });

  test("a refused request (bad token) is not reported", async () => {
    resetSentryForTest();
    const { sdk, calls } = fakeSdk();
    await startSentry("web", store, { readDsn: async () => "https://k@o1.ingest.us.sentry.io/1", env: {}, loadSdk: async () => sdk });
    const api = createObApi({ store, token: () => ({ token: TOKEN, path: "/nowhere", reason: null, message: null }) });
    const res = await api(new Request(`http://api-host.local${OB_API_PREFIX}/next`, { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
    expect(calls.captured).toEqual([]);
    resetSentryForTest();
  });
});

describe("ob 1657: scrub", () => {
  test("cookies, Authorization and Access headers, bodies and query strings never leave", () => {
    const event = scrubEvent<Record<string, unknown>>({
      request: {
        url: "https://acme.example/api/ob/items?token=abc123&sig=zzz",
        method: "POST",
        headers: {
          Cookie: "session=s3cr3t",
          Authorization: "Bearer topsecret",
          "Cf-Access-Jwt-Assertion": "eyJhbGciOi.jwt.value",
          "CF-Access-Client-Secret": "shh",
          "User-Agent": "curl/8",
        },
        cookies: { session: "s3cr3t" },
        data: '{"body":"hello"}',
        query_string: "token=abc123",
      },
      user: { ip_address: "1.2.3.4" },
      breadcrumbs: [{ message: "x" }],
      extra: { note: "y" },
    });
    const text = JSON.stringify(event);
    for (const secret of ["s3cr3t", "topsecret", "jwt.value", "shh", "abc123", "zzz", "hello", "1.2.3.4"]) {
      expect(text).not.toContain(secret);
    }
    expect(event.request).toEqual({
      url: "https://acme.example/api/ob/items",
      method: "POST",
      headers: { "User-Agent": "curl/8" },
    });
    expect("user" in event).toBe(false);
    expect("breadcrumbs" in event).toBe(false);
    expect("extra" in event).toBe(false);
  });

  test("WhatsApp message content, phone numbers and JIDs never leave", () => {
    const event = scrubEvent({
      message: "send to +27 00 000 0012 failed",
      exception: {
        values: [
          {
            type: "Error",
            value: "no chat for 27000000012@s.whatsapp.net or 27000000012:12@s.whatsapp.net, call 0000000012",
            stacktrace: { frames: [{ filename: "bridge.ts", lineno: 12 }] },
          },
        ],
      },
      contexts: { whatsapp: { body: "hi mom", sender: "27000000012", phone: "0000000012", text: "secret chat" } },
      tags: { daemon: "whatsapp-bridge" },
    });
    const text = JSON.stringify(event);
    for (const leaked of ["27000000012", "0000000012", "00 000 0012", "hi mom", "secret chat", "s.whatsapp.net"]) {
      expect(text).not.toContain(leaked);
    }
    // What is useful survives.
    expect(text).toContain("bridge.ts");
    expect(text).toContain("whatsapp-bridge");
    expect(text).toContain("no chat for");
  });

  test("the release sha and environment pass through untouched, even when the sha is all digits", () => {
    const event = scrubEvent({ release: "123456789012", environment: "live", event_id: "1234567890123456", message: "m" });
    expect(event.release).toBe("123456789012");
    expect(event.environment).toBe("live");
    expect(event.event_id).toBe("1234567890123456");
  });

  test("tokens and a DSN pasted into an error message are redacted", () => {
    const event = scrubEvent({ message: "fetch failed Bearer abc.def and https://abc123def@o99.ingest.us.sentry.io/12 ghp_abcdefghij" });
    expect(JSON.stringify(event)).not.toMatch(/abc\.def|abc123def|ghp_abcdefghij/);
  });
});

// The committed-DSN scan reads every file in the repo, so it is a CI step, not a test here: inside this
// file's 5 s per-test budget it timed out whenever git's object store was cold and the disk busy (OB-2177,
// OB-2220). Its logic is tested on a fixture repo in ops/ci/no-sentry-dsn.test.ts; this keeps CI running it.
describe("ob 1657: no DSN in git", () => {
});

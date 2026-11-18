import { describe, expect, test } from "bun:test";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { lastCredentialCheck, runCredentialCheck } from "../../../apps/cli/src/credentials.ts";
import { inMemoryMasterKey, setSecret } from "../../../apps/cli/src/secrets.ts";

// ob 1656. The opencode keys pay for the skeptical-review legs and jev, and an expired key or an empty
// plan failed them silently (1618). Both checks are exercised through the `http` seam only: no live
// network, no real key. Go reports usage windows; Zen has no balance endpoint, so its check proves the key.

const KEY = inMemoryMasterKey();
const GO_KEY = "oc_go_THIS_MUST_NEVER_BE_RENDERED_1656_0123456789";
const ZEN_KEY = "oc_zen_THIS_MUST_NEVER_BE_RENDERED_1656_9876543210";

async function seeded(secrets: Record<string, string>) {
  const store = sqliteStoreFor(freshDb());
  for (const [name, value] of Object.entries(secrets)) await setSecret(store, name, value, KEY.get());
  return store;
}

function fakeHttp(status: number, body: unknown, seen: Request[] = []) {
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(String(input), init));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { http, seen };
}

const usage = (rolling: number, weekly: number, monthly: number, status = "ok") => ({
  usage: {
    rolling: { status, percent: rolling, resetsAt: "2026-10-27T12:29:06.000Z" },
    weekly: { status, percent: weekly, resetsAt: "2026-11-02T00:00:00.000Z" },
    monthly: { status, percent: monthly, resetsAt: "2026-11-20T12:04:18.000Z" },
  },
});

describe("opencode-go: key plus the usage windows (ob 1656)", () => {
  test("a healthy plan is ok, reports the windows, and makes one authenticated GET to /usage", async () => {
    const store = await seeded({ "opencode-go": GO_KEY });
    const { http, seen } = fakeHttp(200, usage(81, 40, 50));
    const row = await runCredentialCheck(store, "opencode-go", { http, masterKey: KEY });
    expect(row.ok).toBe(true);
    expect(row.detail).toContain("rolling 81% used");
    expect(row.detail).toContain("monthly 50% used");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${GO_KEY}`);
  });

  test("a heavy rolling window alone is normal use, not a failure", async () => {
    const store = await seeded({ "opencode-go": GO_KEY });
    const { http } = fakeHttp(200, usage(99, 10, 10));
    expect((await runCredentialCheck(store, "opencode-go", { http, masterKey: KEY })).ok).toBe(true);
  });

  test("weekly or monthly at 90% or more is a WARNING 'running low' that stays ok and says when it resets", async () => {
    const store = await seeded({ "opencode-go": GO_KEY });
    const { http } = fakeHttp(200, usage(81, 86, 93));
    const row = await runCredentialCheck(store, "opencode-go", { http, masterKey: KEY });
    expect(row.ok).toBe(true);
    expect(row.detail?.startsWith("WARNING: ")).toBe(true);
    expect(row.detail).toContain("running low");
    expect(row.detail).toContain("monthly resets 2026-11-20");
    expect(row.detail).not.toContain("weekly resets");
  });

  test("weekly at 97% (OB-1843) warns with the reset time and stays ok", async () => {
    const store = await seeded({ "opencode-go": GO_KEY });
    const { http } = fakeHttp(200, usage(10, 97, 40));
    const row = await runCredentialCheck(store, "opencode-go", { http, masterKey: KEY });
    expect(row.ok).toBe(true);
    expect(row.detail?.startsWith("WARNING: ")).toBe(true);
    expect(row.detail).toContain("weekly resets");
  });

  test("a plan at 100% on a window still fails even though it is also high", async () => {
    const store = await seeded({ "opencode-go": GO_KEY });
    const { http } = fakeHttp(200, usage(10, 100, 40));
    const row = await runCredentialCheck(store, "opencode-go", { http, masterKey: KEY });
    expect(row.ok).toBe(false);
  });

  test("a window whose status is not ok means the plan is used up", async () => {
    const store = await seeded({ "opencode-go": GO_KEY });
    const { http } = fakeHttp(200, usage(100, 60, 60, "exhausted"));
    const row = await runCredentialCheck(store, "opencode-go", { http, masterKey: KEY });
    expect(row.ok).toBe(false);
    expect(row.detail).toContain("used up");
  });

  test("an expired key fails with OpenCode's own reason and never carries the key", async () => {
    const store = await seeded({ "opencode-go": GO_KEY });
    const { http } = fakeHttp(401, { error: { code: "api_key_expired", message: `key ${GO_KEY} has expired` } });
    const row = await runCredentialCheck(store, "opencode-go", { http, masterKey: KEY });
    expect(row.ok).toBe(false);
    expect(row.detail).toBe("OpenCode Go answered HTTP 401 (api_key_expired)");
    expect(JSON.stringify(await lastCredentialCheck(store, "opencode-go"))).not.toContain(GO_KEY);
  });

  test("a 200 that lacks a window, or its percent, fails closed rather than passing blind", async () => {
    const store = await seeded({ "opencode-go": GO_KEY });
    for (const body of [{ somethingElse: true }, { usage: { rolling: { status: "ok", percent: 5 } } }, { usage: { ...usage(1, 1, 1).usage, monthly: { status: "ok" } } }]) {
      const { http } = fakeHttp(200, body);
      expect((await runCredentialCheck(store, "opencode-go", { http, masterKey: KEY })).ok).toBe(false);
    }
  });
});

describe("opencode-zen: the key only, and it says so (ob 1656)", () => {
  test("a good key is ok, lists models once with a GET, and states that the balance is not checked", async () => {
    const store = await seeded({ "opencode-zen": ZEN_KEY });
    const { http, seen } = fakeHttp(200, { object: "list", data: [] });
    const row = await runCredentialCheck(store, "opencode-zen", { http, masterKey: KEY });
    expect(row.ok).toBe(true);
    expect(row.detail).toContain("no balance endpoint");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe("https://opencode.ai/zen/v1/models");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${ZEN_KEY}`);
  });
});

// ob 1756: `ob cloudflare zones | dns list|add|rm`. A fake fetch stands in for Cloudflare: no live network.
import { describe, expect, test } from "bun:test";
import { qualify, runCloudflare, type CloudflareDeps } from "../../../apps/cli/src/cloudflare.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryMasterKey, setSecret } from "../../../apps/cli/src/secrets.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { openDb } from "../../../apps/cli/src/db.ts";

const TOKEN = "cf-token-must-never-print";
const ZONE_ID = "a".repeat(32);
const REC_A = "b".repeat(32);
const REC_B = "c".repeat(32);
const REC_C = "d".repeat(32);

const ZONES = [{ id: ZONE_ID, name: "example.com", status: "active" }];
const RECORDS = [
  { id: REC_A, type: "A", name: "www.example.com", content: "203.0.113.7", proxied: true, ttl: 1 },
  { id: REC_B, type: "TXT", name: "dup.example.com", content: "one", proxied: false, ttl: 300 },
  { id: REC_C, type: "TXT", name: "dup.example.com", content: "two", proxied: false, ttl: 300 },
];

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

function fakeCloudflare() {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ method, url, auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.replace("https://api.cloudflare.com/client/v4", "").split("?")[0]!;
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], result, result_info: { page: 1, total_pages: 1 } }), { status: 200 });
    if (method === "GET" && path === "/zones") return ok(ZONES);
    if (method === "GET" && path === `/zones/${ZONE_ID}/dns_records`) return ok(RECORDS);
    if (method === "POST" && path === `/zones/${ZONE_ID}/dns_records`) return ok({ id: "e".repeat(32), ...JSON.parse(String(init!.body)) });
    if (method === "DELETE" && path.startsWith(`/zones/${ZONE_ID}/dns_records/`)) return ok({ id: path.split("/").pop() });
    return new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: "no route" }], result: null }), { status: 404 });
  };
  return { calls, fetch: impl as unknown as typeof fetch, writes: () => calls.filter((c) => c.method !== "GET") };
}

function deps(f: ReturnType<typeof fakeCloudflare>, secrets: Record<string, string> = { "cloudflare-api-token": TOKEN }): CloudflareDeps {
  return { fetch: f.fetch, secret: async (n) => secrets[n] ?? null };
}

async function capture(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  let out = "";
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

const run = (f: ReturnType<typeof fakeCloudflare>, args: string[], flags: Record<string, unknown> = {}) =>
  capture(() => runCloudflare(args, flags, "human", deps(f)));

describe("reads", () => {
  test("zones prints name, id, status, with the bearer token", async () => {
    const f = fakeCloudflare();
    const out = await run(f, ["zones"]);
    expect(out).toContain(`example.com\t${ZONE_ID}\tactive`);
    expect(f.calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(out).not.toContain(TOKEN);
  });

  test("account id, when stored, narrows zones", async () => {
    const f = fakeCloudflare();
    await capture(() => runCloudflare(["zones"], {}, "human", deps(f, { "cloudflare-api-token": TOKEN, "cloudflare-account-id": "acct1" })));
    expect(f.calls[0]!.url).toContain("account.id=acct1");
  });

  test("dns list takes a zone name or id and prints one line per record", async () => {
    const f = fakeCloudflare();
    const out = await run(f, ["dns", "list", "EXAMPLE.com"]);
    expect(out).toContain(`${REC_A}\tA\twww.example.com\t203.0.113.7\tproxied\tauto`);
    expect(out).toContain(`${REC_B}\tTXT\tdup.example.com\tone\tdns-only\t300`);
    expect(await run(f, ["dns", "list", ZONE_ID])).toContain("www.example.com");
    expect(f.writes()).toEqual([]);
  });

  test("an unknown zone is a usage error naming the known ones", async () => {
    await expect(run(fakeCloudflare(), ["dns", "list", "nope.org"])).rejects.toThrow(/known: example\.com/);
  });

  test("a missing token is named, and nothing is fetched", async () => {
    const f = fakeCloudflare();
    await expect(capture(() => runCloudflare(["zones"], {}, "human", deps(f, {})))).rejects.toThrow(/cloudflare-api-token/);
    expect(f.calls).toEqual([]);
  });

  test("an API failure surfaces Cloudflare's error code and message, not the token", async () => {
    const bad: CloudflareDeps = {
      fetch: (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 9109, message: "Invalid access token" }] }), { status: 403 })) as unknown as typeof fetch,
      secret: async (n) => (n === "cloudflare-api-token" ? TOKEN : null),
    };
    const e = await runCloudflare(["zones"], {}, "human", bad).then(() => null, (x: Error) => x);
    expect(e!.message).toContain("403");
    expect(e!.message).toContain("9109: Invalid access token");
    expect(e!.message).not.toContain(TOKEN);
  });
});

describe("dns add", () => {
  test("without --yes it is a dry run: prints the change, sends no write", async () => {
    const f = fakeCloudflare();
    const out = await run(f, ["dns", "add", "example.com", "a", "api", "198.51.100.4"]);
    expect(out).toContain("dry run: would add A api.example.com -> 198.51.100.4 (proxied: no, ttl: auto)");
    expect(out).toContain("nothing sent");
    expect(f.writes()).toEqual([]);
  });

  test("with --yes it POSTs the exact body that was printed", async () => {
    const f = fakeCloudflare();
    const out = await run(f, ["dns", "add", "example.com", "A", "@", "198.51.100.4", ], { yes: true, proxied: true });
    expect(out).toContain("added A example.com -> 198.51.100.4 (proxied: yes, ttl: auto)");
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0]!.body).toEqual({ type: "A", name: "example.com", content: "198.51.100.4", ttl: 1, proxied: true });
    expect(f.writes()[0]!.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("--ttl is passed through for an unproxied record", async () => {
    const f = fakeCloudflare();
    await run(f, ["dns", "add", "example.com", "TXT", "_v", "hello", ], { yes: true, ttl: "300" });
    expect(f.writes()[0]!.body).toEqual({ type: "TXT", name: "_v.example.com", content: "hello", ttl: 300, proxied: false });
  });

  test("refuses what Cloudflare would reject or this command cannot express, before any write", async () => {
    const f = fakeCloudflare();
    await expect(run(f, ["dns", "add", "example.com", "MX", "m", "mail"], { yes: true })).rejects.toThrow(/not supported/);
    await expect(run(f, ["dns", "add", "example.com", "TXT", "t", "x"], { yes: true, proxied: true })).rejects.toThrow(/--proxied only/);
    await expect(run(f, ["dns", "add", "example.com", "A", "t", "1.2.3.4"], { yes: true, proxied: true, ttl: "300" })).rejects.toThrow(/proxied/);
    await expect(run(f, ["dns", "add", "example.com", "A", "t", "1.2.3.4"], { yes: true, ttl: "5" })).rejects.toThrow(/--ttl/);
    await expect(run(f, ["dns", "add", "example.com", "A"], { yes: true })).rejects.toThrow(/usage/);
    expect(f.writes()).toEqual([]);
  });

  test("--json reports whether anything was sent", async () => {
    const f = fakeCloudflare();
    const out = await capture(() => runCloudflare(["dns", "add", "example.com", "A", "j", "1.2.3.4"], {}, "json", deps(f)));
    expect(JSON.parse(out)).toMatchObject({ action: "add", zone: "example.com", sent: false });
  });
});

describe("dns rm", () => {
  test("by name, without --yes: shows the record, deletes nothing", async () => {
    const f = fakeCloudflare();
    const out = await run(f, ["dns", "rm", "example.com", "www"]);
    expect(out).toContain(`dry run: would remove A www.example.com -> 203.0.113.7`);
    expect(out).toContain(REC_A);
    expect(f.writes()).toEqual([]);
  });

  test("by id with --yes issues one DELETE for that record", async () => {
    const f = fakeCloudflare();
    const out = await run(f, ["dns", "rm", "example.com", REC_A], { yes: true });
    expect(out).toContain("removed A www.example.com");
    expect(f.writes()).toHaveLength(1);
    expect(f.writes()[0]!.method).toBe("DELETE");
    expect(f.writes()[0]!.url).toContain(`/dns_records/${REC_A}`);
  });

  test("an ambiguous name is refused with the ids, even with --yes", async () => {
    const f = fakeCloudflare();
    await expect(run(f, ["dns", "rm", "example.com", "dup"], { yes: true })).rejects.toThrow(new RegExp(`${REC_B}[\\s\\S]*${REC_C}`));
    expect(f.writes()).toEqual([]);
  });

  test("a name that matches nothing is an error", async () => {
    await expect(run(fakeCloudflare(), ["dns", "rm", "example.com", "ghost"], { yes: true })).rejects.toThrow(/no record 'ghost'/);
  });
});

test("qualify: relative, apex and fully qualified names", () => {
  expect(qualify("WWW", "example.com")).toBe("www.example.com");
  expect(qualify("@", "example.com")).toBe("example.com");
  expect(qualify("a.example.com", "example.com")).toBe("a.example.com");
  expect(qualify("www.example.com.", "example.com")).toBe("www.example.com");
  expect(qualify("notexample.com", "example.com")).toBe("notexample.com.example.com");
});

describe("through the CLI (API client, stubbed transport + fetch)", () => {
  const BASE = "https://ob.example.test";
  const readCalls: string[] = [];
  const transport: ApiTransport = async (req) => {
    const path = req.url.slice((BASE + OB_API_PREFIX).length);
    readCalls.push(`${req.method} ${path} ${req.body ?? ""}`);
    const name = JSON.parse(req.body ?? "{}").name;
    if (path === "/secrets/read" && name === "cloudflare-api-token") return { status: 200, body: JSON.stringify({ value: TOKEN }) };
    return { status: 404, body: JSON.stringify({ error: { code: "not_found", message: "no secret" } }) };
  };

  test("zones: token over /secrets/read, Cloudflare called with it, the missing account id tolerated", async () => {
    const f = fakeCloudflare();
    const r = await runCli(freshDbPath(), ["cloudflare", "zones"], { api: { base: BASE, token: "t", transport }, cloudflareFetch: f.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toContain("example.com");
    expect(f.calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  test("dns add is a dry run by default (exit 0, no write) and sends with --yes", async () => {
    const f = fakeCloudflare();
    const deps = { api: { base: BASE, token: "t", transport }, cloudflareFetch: f.fetch };
    const dry = await runCli(freshDbPath(), ["cloudflare", "dns", "add", "example.com", "A", "x", "1.2.3.4"], deps);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("nothing sent");
    expect(f.writes()).toEqual([]);
    const live = await runCli(freshDbPath(), ["cloudflare", "dns", "add", "example.com", "A", "x", "1.2.3.4", "--yes"], deps);
    expect(live.code).toBe(0);
    expect(f.writes()).toHaveLength(1);
    expect(live.out + live.err).not.toContain(TOKEN);
  });

  test("a usage error exits 2", async () => {
    const f = fakeCloudflare();
    const r = await runCli(freshDbPath(), ["cloudflare", "bogus"], { api: { base: BASE, token: "t", transport }, cloudflareFetch: f.fetch });
    expect(r.code).toBe(2);
  });
});

// --- ob 1643: `cloudflare tunnels` -----------------------------------------------------------------
// The versions live on GET /accounts/<acct>/cfd_tunnel/<id>/connections (result[].version and
// result[].conns[].client_version); the list's own `conns` is deliberately returned EMPTY by the fake,
// so a regression that reads it sees no version at all.

const ACCT = "acct-1643";

interface FakeTunnel {
  id: string;
  name: string;
  status?: string;
  /** One entry per cloudflared client: its host version and its edge connections' client_version. */
  clients: Array<{ version: string; conns?: string[] }>;
}

function fakeTunnels(tunnels: FakeTunnel[], opts: { failConnections?: string; failList?: boolean } = {}) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, auth: new Headers(init?.headers).get("authorization"), body: undefined });
    const path = url.replace("https://api.cloudflare.com/client/v4", "").split("?")[0]!;
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], result, result_info: { page: 1, total_pages: 1 } }), { status: 200 });
    if (path === `/accounts/${ACCT}/cfd_tunnel`) {
      if (opts.failList) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }), { status: 403 });
      return ok(tunnels.map((t) => ({ id: t.id, name: t.name, status: t.status ?? "healthy", conns: [] })));
    }
    const m = path.match(new RegExp(`^/accounts/${ACCT}/cfd_tunnel/([^/]+)/connections$`));
    if (m) {
      if (opts.failConnections === m[1]) return new Response(JSON.stringify({ success: false, errors: [{ code: 1000, message: "upstream" }], result: null }), { status: 502 });
      const t = tunnels.find((x) => x.id === m[1])!;
      return ok(t.clients.map((c) => ({ id: "c", version: c.version, conns: (c.conns ?? [c.version]).map((v) => ({ client_version: v })) })));
    }
    return new Response(JSON.stringify({ success: false, errors: [{ code: 7003, message: "no route" }], result: null }), { status: 404 });
  };
  return { calls, fetch: impl as unknown as typeof fetch };
}

const tdeps = (f: { fetch: typeof fetch }, secrets: Record<string, string> = { "cloudflare-api-token": TOKEN, "cloudflare-account-id": ACCT }): CloudflareDeps => ({
  fetch: f.fetch,
  secret: async (n) => secrets[n] ?? null,
});

const tunnelsOut = (f: { fetch: typeof fetch }, flags: Record<string, unknown> = {}, mode: "human" | "json" = "human") =>
  capture(() => runCloudflare(["tunnels"], flags, mode, tdeps(f)));

// The live fleet on 2026-10-26: ob-api one patch ahead of two tunnels that are FINE.
const LIVE: FakeTunnel[] = [
  { id: "t1", name: "ob-api", clients: [{ version: "2026.10.4" }] },
  { id: "t2", name: "homeassistant", clients: [{ version: "2026.10.3" }] },
  { id: "t3", name: "advisor-quotes-demo", clients: [{ version: "2026.10.3" }] },
];

describe("tunnels (1643)", () => {
  test("a fleet within a release-month of its newest is clean: name, status, count, versions, no STALE", async () => {
    const f = fakeTunnels(LIVE);
    const out = await tunnelsOut(f);
    expect(out).toContain("ob-api\thealthy\t1 connector\t2026.10.4");
    expect(out).toContain("homeassistant\thealthy\t1 connector\t2026.10.3");
    expect(out).not.toContain("STALE");
    expect(out).not.toContain("fix:");
    expect(out).not.toContain(TOKEN);
    expect(f.calls[0]!.url).toContain(`/accounts/${ACCT}/cfd_tunnel?is_deleted=false`);
    expect(f.calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
  });

  test("one stale tunnel: the whole fleet prints, that tunnel is marked with its per-host fix, and it throws", async () => {
    const f = fakeTunnels([...LIVE, { id: "t4", name: "ob-api-old", clients: [{ version: "2026.8.2" }] }]);
    let out = "";
    let err: unknown;
    try {
      out = await capture(() => runCloudflare(["tunnels"], {}, "human", tdeps(f)).catch((e) => { err = e; }) as Promise<void>);
    } catch (e) {
      err = e;
    }
    expect(out).toContain("ob-api-old\thealthy\t1 connector\t2026.8.2\tSTALE");
    expect(out).toContain("ob-api\thealthy"); // fresh ones still listed
    expect(out).toContain("fix: upgrade that host's cloudflared");
    expect(String(err)).toContain("ob-api-old at 2026.8.2");
    expect(String(err)).not.toContain("homeassistant at");
  });

  test("the real hosts get their real fix: API host .deb via pct exec dpkg, HA via ha apps update", async () => {
    const f = fakeTunnels([
      { id: "t1", name: "ob-api", clients: [{ version: "2026.8.2" }] },
      { id: "t2", name: "homeassistant", clients: [{ version: "2026.10.3" }, { version: "2026.9.0" }] },
    ]);
    const err = await runCloudflare(["tunnels"], {}, "human", tdeps(f)).then(() => "", (e: Error) => e.message);
    expect(err).toContain("pct exec <ctid> -- dpkg -i");
    expect(err).toContain("ha apps update 9074a9fa_cloudflared");
  });

  test("--floor catches a same-month connector below an advisory's exact cutoff", async () => {
    const f = fakeTunnels(LIVE);
    const err = await runCloudflare(["tunnels"], { floor: "2026.10.4" }, "human", tdeps(f)).then(() => "", (e: Error) => e.message);
    expect(err).toContain("homeassistant at 2026.10.3");
    expect(err).toContain("below the --floor 2026.10.4");
    expect(err).not.toContain("ob-api at");
  });

  test("a malformed --floor is a usage error before anything is fetched", async () => {
    const f = fakeTunnels(LIVE);
    await expect(runCloudflare(["tunnels"], { floor: "latest" }, "human", tdeps(f))).rejects.toThrow("--floor must be a cloudflared version");
    expect(f.calls).toHaveLength(0);
  });

  test("an edge connection older than its host's version still counts (client_version is read too)", async () => {
    const f = fakeTunnels([
      { id: "t1", name: "ob-api", clients: [{ version: "2026.10.4" }] },
      { id: "t2", name: "homeassistant", clients: [{ version: "2026.10.4", conns: ["2026.10.4", "2026.7.1"] }] },
    ]);
    const err = await runCloudflare(["tunnels"], {}, "human", tdeps(f)).then(() => "", (e: Error) => e.message);
    expect(err).toContain("homeassistant at 2026.7.1, 2026.10.4");
  });

  test("an empty fleet is clean: prints (no tunnels), no stale", async () => {
    const f = fakeTunnels([]);
    expect(await tunnelsOut(f)).toContain("(no tunnels)");
  });

  test("a tunnel with no connectors prints '-' and 0 connectors, and is not stale", async () => {
    const f = fakeTunnels([{ id: "t1", name: "ob-api", status: "inactive", clients: [] }, ...LIVE.slice(1)]);
    const out = await tunnelsOut(f);
    expect(out).toContain("ob-api\tinactive\t0 connectors\t-");
    expect(out).not.toContain("STALE");
  });

  test("--json is the rows, stale flag and hint included", async () => {
    const f = fakeTunnels([...LIVE, { id: "t4", name: "ob-api-old", clients: [{ version: "2026.8.2" }] }]);
    const out = await capture(() => runCloudflare(["tunnels"], {}, "json", tdeps(f)).catch(() => {}) as Promise<void>);
    const rows = JSON.parse(out) as Array<{ name: string; stale: boolean; versions: string[]; hint: string | null }>;
    expect(rows.find((r) => r.name === "ob-api-old")).toMatchObject({ stale: true, versions: ["2026.8.2"] });
    expect(rows.find((r) => r.name === "ob-api")).toMatchObject({ stale: false, hint: null });
  });

  test("a failed list is a cloudflare error, never a stale verdict", async () => {
    const f = fakeTunnels(LIVE, { failList: true });
    const err = await runCloudflare(["tunnels"], {}, "human", tdeps(f)).then(() => "", (e: Error) => e.message);
    expect(err).toContain("403");
    expect(err).toContain("Authentication error");
    expect(err).not.toContain("stale");
    expect(err).not.toContain(TOKEN);
  });

  test("a failed connections read is a cloudflare error naming the endpoint, not a stale verdict, and nothing prints", async () => {
    const f = fakeTunnels(LIVE, { failConnections: "t2" });
    let out = "";
    const err = await (async () => {
      try {
        out = await capture(() => runCloudflare(["tunnels"], {}, "human", tdeps(f)));
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).toContain("cloudflare: GET");
    expect(err).toContain("/connections -> 502");
    expect(err).not.toContain("stale");
    expect(out).not.toContain("STALE");
  });

  test("without the account id there is nothing to read, and it says which secret", async () => {
    const f = fakeTunnels(LIVE);
    await expect(runCloudflare(["tunnels"], {}, "human", tdeps(f, { "cloudflare-api-token": TOKEN }))).rejects.toThrow("cloudflare-account-id");
    expect(f.calls).toEqual([]);
  });
});

describe("tunnels through the CLI as a recorded job (1643 + 218)", () => {
  function localSeam() {
    const dir = mkdtempSync(join(tmpdir(), "ob-1643-"));
    const keyFile = join(dir, "master.key");
    writeFileSync(keyFile, inMemoryMasterKey().get().toString("base64"), { mode: 0o600 });
    return { dbPath: freshDbPath(), keyFile };
  }

  async function seed(dbPath: string): Promise<void> {
    const db = openDb(dbPath);
    const store = sqliteStoreFor(db);
    await setSecret(store, "cloudflare-api-token", TOKEN, inMemoryMasterKey().get());
    await setSecret(store, "cloudflare-account-id", ACCT, inMemoryMasterKey().get());
    db.close();
  }

  async function withKey<T>(keyFile: string, fn: () => Promise<T>): Promise<T> {
    const prev = process.env.OMNISLASH_MASTER_KEY_FILE;
    process.env.OMNISLASH_MASTER_KEY_FILE = keyFile;
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env.OMNISLASH_MASTER_KEY_FILE;
      else process.env.OMNISLASH_MASTER_KEY_FILE = prev;
    }
  }

  const jobRow = async (dbPath: string) => {
    const listed = await runCli(dbPath, ["jobs", "--json"]);
    return (JSON.parse(listed.out) as Array<{ job: string; consecutive_failures: number; last_success_at: string | null; last_error: string | null }>).find((r) => r.job === "tunnel-check")!;
  };

  test("a clean fleet exits 0 and `ob jobs` shows tunnel-check with a last success", async () => {
    const { dbPath, keyFile } = localSeam();
    await seed(dbPath);
    const f = fakeTunnels(LIVE);
    const r = await withKey(keyFile, () => runCli(dbPath, ["cloudflare", "tunnels"], { cloudflareFetch: f.fetch }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("ob-api\thealthy\t1 connector\t2026.10.4");
    expect(r.out + r.err).not.toContain(TOKEN);
    const row = await jobRow(dbPath);
    expect(row.last_success_at).not.toBeNull();
    expect(row.consecutive_failures).toBe(0);
  });

  test("a stale fleet exits 1 and the job's last_error names the tunnel, the version and the fix", async () => {
    const { dbPath, keyFile } = localSeam();
    await seed(dbPath);
    const f = fakeTunnels([{ id: "t1", name: "ob-api", clients: [{ version: "2026.8.2" }] }, LIVE[1]!]);
    const r = await withKey(keyFile, () => runCli(dbPath, ["cloudflare", "tunnels"], { cloudflareFetch: f.fetch }));
    expect(r.code).toBe(1);
    expect(r.out).toContain("STALE");
    const row = await jobRow(dbPath);
    expect(row.consecutive_failures).toBe(1);
    expect(row.last_error).toContain("ob-api at 2026.8.2");
    expect(row.last_error).toContain("pct exec <ctid> -- dpkg -i");
  });

  test("a failed read exits 1 as a cloudflare error: the recorded error says the read failed, not that anything is stale", async () => {
    const { dbPath, keyFile } = localSeam();
    await seed(dbPath);
    const f = fakeTunnels(LIVE, { failList: true });
    const r = await withKey(keyFile, () => runCli(dbPath, ["cloudflare", "tunnels"], { cloudflareFetch: f.fetch }));
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("STALE");
    const row = await jobRow(dbPath);
    expect(row.last_error).toContain("cloudflare: GET");
    expect(row.last_error).not.toContain("stale");
  });

  test("a hand-run with --floor is a question about an advisory, not the job: exits 1, records nothing", async () => {
    const { dbPath, keyFile } = localSeam();
    await seed(dbPath);
    const f = fakeTunnels(LIVE);
    const r = await withKey(keyFile, () => runCli(dbPath, ["cloudflare", "tunnels", "--floor", "2026.10.9"], { cloudflareFetch: f.fetch }));
    expect(r.code).toBe(1);
    const row = await jobRow(dbPath);
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_error).toBeNull();
  });
});

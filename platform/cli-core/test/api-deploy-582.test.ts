// ob 582 — `ob deploy` over the API: one row per deploy target, written by ob-deploy.sh (on the server)
// and the 581 web-dev push (from this machine), read by `deploy status` from anywhere.
//
// CLIENT half: stubbed transport, no network, no token file, no database (api-client-353's seam).
// SERVER half: real Postgres via the 325 harness, exercising the endpoint against the pg schema.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderCommandHelp } from "../../../apps/cli/src/cli.ts";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import { API_ROUTED_COMMANDS, LOCAL_ONLY_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";
const README = cliDocs();

const ROW_LIVE = {
  target: "live",
  host: "api-host",
  unit: "omnislash-web.service",
  sha: "320207e9a1b2c3d4e5f60718293a4b5c6d7e8f901",
  at: "2026-09-03T12:00:00.000Z",
  result: "ok",
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

function api(s: Stub, extra: { deploySsh?: (argv: readonly string[]) => { code: number } } = {}) {
  return { api: { base: BASE, token: TOKEN, transport: s.transport }, ...extra };
}

describe("routing (582)", () => {
  test("deploy is ROUTED, has a client handler, and is not local-only", () => {
    expect(API_ROUTED_COMMANDS.has("deploy")).toBe(true);
    expect(LOCAL_ONLY_COMMANDS.has("deploy")).toBe(false);
    expect(typeof API_HANDLERS.deploy).toBe("function");
  });

  test("HELP and README document deploy status|record|run", () => {
    const help = renderCommandHelp("deploy");
    expect(help).toContain("deploy status");
    expect(help).toContain("deploy record");
    expect(help).toContain("deploy run");
    expect(README).toContain("deploy status");
    expect(README).toContain("deploy run");
  });
});

describe("API client: deploy (582)", () => {
  test("`ob deploy status` GETs /deploys and renders the rows", async () => {
    const s = stub({ "GET /deploys": { deploys: [ROW_LIVE] } });
    const r = await runCli(freshDbPath(), ["deploy", "status"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("live");
    expect(r.out).toContain("api-host");
    expect(r.out).toContain(ROW_LIVE.sha);
    expect(s.calls.map((c) => `${c.method} ${c.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]}`)).toEqual([
      "GET /deploys",
    ]);
    expect(r.err).not.toContain("run it on the API host");
  });

  test("`ob deploy status --json` prints the rows as JSON", async () => {
    const s = stub({ "GET /deploys": { deploys: [ROW_LIVE] } });
    const r = await runCli(freshDbPath(), ["deploy", "status", "--json"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([ROW_LIVE]);
  });

  test("`ob deploy record` POSTs the row and prints the outcome", async () => {
    const s = stub({
      "POST /deploys": {
        deploy: { ...ROW_LIVE, result: "rolled-back", sha: "0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb" },
      },
    });
    const r = await runCli(
      freshDbPath(),
      ["deploy", "record", "--target", "live", "--host", "api-host", "--unit", "omnislash-web.service",
        "--sha", "0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb", "--result", "rolled-back"],
      api(s),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("recorded rolled-back for live @ 0dfd09b9");
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({
      target: "live",
      host: "api-host",
      unit: "omnislash-web.service",
      sha: "0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb",
      result: "rolled-back",
      at: undefined,
    });
    expect(r.err).not.toContain("run it on the API host");
  });

  test("`ob deploy record` with a bad --result is a usage error before the wire", async () => {
    const s = stub({});
    const r = await runCli(
      freshDbPath(),
      ["deploy", "record", "--target", "live", "--host", "api-host", "--unit", "omnislash-web.service",
        "--sha", "0dfd09b9", "--result", "maybe"],
      api(s),
    );
    expect(r.code).toBe(2);
    expect(r.err).toContain("--result must be one of ok|rolled-back|refused");
    expect(s.calls).toHaveLength(0);
  });

  test("unknown deploy subcommand refuses", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["deploy", "frobnicate"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown deploy subcommand");
    expect(r.err).toContain("status|record|run");
  });

  test("`ob deploy run --ssh` POSTs refused from last known when ssh fails", async () => {
    const s = stub({
      "GET /deploys": { deploys: [ROW_LIVE] },
      "POST /deploys": { deploy: { ...ROW_LIVE, result: "refused" } },
    });
    const r = await runCli(freshDbPath(), ["deploy", "run", "--ssh"], api(s, { deploySsh: () => ({ code: 255 }) }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("recorded refused for live");
    expect(s.calls.map((c) => `${c.method} ${c.url.slice((BASE + OB_API_PREFIX).length).split("?")[0]}`)).toEqual([
      "GET /deploys",
      "POST /deploys",
    ]);
    expect(JSON.parse(s.calls[1]!.body!)).toEqual({
      target: "live",
      host: "api-host",
      unit: "omnislash-web.service",
      sha: ROW_LIVE.sha,
      result: "refused",
    });
  });

  test("`ob deploy run --ssh` uses placeholders when ssh fails and no live row", async () => {
    const s = stub({
      "GET /deploys": { deploys: [] },
      "POST /deploys": {
        deploy: { target: "live", host: "api-host", unit: "omnislash-web.service", sha: "unknown", at: "2026-09-12T00:00:00.000Z", result: "refused" },
      },
    });
    const r = await runCli(freshDbPath(), ["deploy", "run", "--ssh"], api(s, { deploySsh: () => ({ code: 1 }) }));
    expect(r.code).toBe(1);
    expect(JSON.parse(s.calls[1]!.body!)).toEqual({
      target: "live",
      host: "api-host",
      unit: "omnislash-web.service",
      sha: "unknown",
      result: "refused",
    });
  });
});

// ── SERVER half: the real endpoints over a real (embedded) Postgres ────────────────────────────────

const TOKEN_S = "a-test-bearer-token-that-is-long-enough";

function url(path: string): string {
  return `https://ob.example.test${OB_API_PREFIX}${path}`;
}

interface ServerCtx {
  store: Store;
  call: (path: string, opts?: { method?: string; body?: unknown }) => Promise<{ status: number; body: any }>;
}

async function withApi(fn: (ctx: ServerCtx) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({
    kind: "postgres",
    connection: lease.options as unknown as Record<string, unknown>,
  });
  const api = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN_S, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const call = async (path: string, opts: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> => {
    const res = await api(
      new Request(url(path), {
        method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
        headers: {
          authorization: `Bearer ${TOKEN_S}`,
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      }),
    );
    const text = await res.text();
    return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
  };
  try {
    await fn({ store, call });
  } finally {
    await store.close();
    await lease.release();
  }
}

describe("POST/GET /deploys (582, real Postgres)", () => {
  test("record writes one row per target; status reads it back; upsert replaces; bad result is a 400", async () => {
    await withApi(async ({ call }) => {
      const created = await call("/deploys", {
        body: {
          target: "live",
          host: "api-host",
          unit: "omnislash-web.service",
          sha: ROW_LIVE.sha,
          result: "ok",
        },
      });
      expect(created.status).toBe(201);
      expect(created.body.deploy.result).toBe("ok");
      expect(created.body.deploy.sha).toBe(ROW_LIVE.sha);
      // absent `at` is stamped by the server
      expect(created.body.deploy.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      const second = await call("/deploys", {
        body: {
          target: "web-dev",
          host: "ob-host",
          unit: "omnislash-web-dev.service",
          sha: "0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb",
          result: "ok",
        },
      });
      expect(second.status).toBe(201);

      const all = await call("/deploys");
      expect(all.status).toBe(200);
      expect(all.body.deploys.map((r: { target: string }) => r.target).sort()).toEqual(["live", "web-dev"]);

      // one row per target: re-recording live replaces, does not append
      const upsert = await call("/deploys", {
        body: {
          target: "live",
          host: "api-host",
          unit: "omnislash-web.service",
          sha: "0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb",
          result: "rolled-back",
        },
      });
      expect(upsert.status).toBe(201);
      const after = await call("/deploys");
      expect(after.body.deploys).toHaveLength(2);
      const live = after.body.deploys.find((r: { target: string }) => r.target === "live");
      expect(live.result).toBe("rolled-back");
      expect(live.sha).toBe("0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb");

      // the vocabulary is closed: anything else is a 400
      const bad = await call("/deploys", {
        body: {
          target: "live",
          host: "api-host",
          unit: "omnislash-web.service",
          sha: "0dfd09b9",
          result: "maybe",
        },
      });
      expect(bad.status).toBe(400);
    });
  });
});
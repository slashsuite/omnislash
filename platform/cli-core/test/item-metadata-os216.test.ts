// OS-216: ob's item metadata is complete and honest.
// - `ob tags` lists every tag in use with its count, and `list --json` carries each item's tags.
// - A ticket that blocks a higher one ranks at that priority, down the whole chain; its stored priority stays.
// - `ob overnight decide --at` dates a decision, and `ob overnight backfill` dates the wayfinder imports by night.
//
// The local half runs on a throwaway SQLite store through `runCli`; the API half sends the CLI's own requests through
// `createObApi` on a leased local Postgres (no network, no live database) and must print the same lines.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openStore } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_ROUTES } from "../../../apps/cli/src/api/contract.ts";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import { API_ROUTED_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { renderCommandHelp, renderSubcommandHelp } from "../../../apps/cli/src/cli.ts";
import { Database } from "bun:sqlite";
import { computeRaises, dependencyRaises, type PriorityNode } from "../../../apps/cli/src/dep-priority.ts";
import { priorityRows } from "../../../apps/cli/src/items.ts";
import { parseAt } from "../../../apps/cli/src/overnight.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";
const README = cliDocs();

type Run = (args: string[]) => Promise<{ code: number; out: string; err: string }>;

function stable(s: string): string {
  return s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "<ts>");
}

const node = (id: string, priority: number | null, status = "open"): PriorityNode => ({
  id,
  ref: id.toUpperCase(),
  type: "task",
  status,
  priority,
  project_id: "p",
});

describe("computeRaises (OS-216)", () => {
  // urgent=1, high=2, medium=3, low=4, critical=6
  test("critical outranks urgent; a lower blocked item raises nothing", () => {
    const r = computeRaises([node("a", 1), node("b", 6), node("x", 2), node("y", 4)], [{ from: "a", to: "b" }, { from: "x", to: "y" }], null);
    expect(r.get("a")?.priority).toBe(6);
    expect(r.has("x")).toBe(false);
  });

  test("a closed blocked item raises nothing, and a cycle settles", () => {
    expect(computeRaises([node("a", 4), node("b", 2, "done")], [{ from: "a", to: "b" }], null).size).toBe(0);
    const r = computeRaises([node("a", 4), node("b", 3), node("c", 2)], [{ from: "a", to: "b" }, { from: "b", to: "a" }, { from: "b", to: "c" }], null);
    expect(r.get("a")?.priority).toBe(2);
    expect(r.get("b")?.priority).toBe(2);
  });
});

describe("parseAt (OS-216)", () => {
  test("a bare date is that day at midnight UTC; a date-time without a zone or a bad date is refused", () => {
    expect(parseAt("2026-11-18")).toBe("2026-11-18T00:00:00.000Z");
    expect(() => parseAt("2026-11-18T23:40:00")).toThrow(/with a zone/);
    expect(() => parseAt("2026-13-01")).toThrow();
  });
});

/** The ticket's proof as one script, run locally and over the API. */
async function script(run: Run): Promise<string[]> {
  const log: string[] = [];
  const step = async (args: string[]) => {
    const r = await run(args);
    // `show --json` has always had a different shape locally (task detail, prs, valid_next); its fields are asserted instead.
    if (args[0] === "show" && args.includes("--json")) return r;
    log.push(`${args.join(" ")} => ${r.code}\n${stable(r.out)}${stable(r.err)}`);
    return r;
  };
  const ok = async (args: string[]) => {
    const r = await step(args);
    expect(r.code, `${args.join(" ")}: ${r.err}`).toBe(0);
    return r;
  };
  await ok(["project", "add", "alpha", "--kind", "side", "--key", "AL"]);
  await ok(["project", "add", "beta", "--kind", "side", "--key", "BE"]);

  // --- tags ---
  await ok(["add", "Low ticket", "--project", "alpha", "--priority", "low", "--tag", "backend", "--tag", "rework"]); // AL-1
  await ok(["add", "High ticket", "--project", "alpha", "--priority", "high", "--tag", "backend"]); // AL-2
  await ok(["add", "Medium middle", "--project", "alpha", "--priority", "medium"]); // AL-3
  await ok(["add", "Beta thing", "--project", "beta", "--tag", "frontend", "--tag", "backend"]); // BE-1

  const tags = await ok(["tags"]);
  expect(tags.out.trim().split("\n")).toEqual(["3  backend", "1  frontend", "1  rework"]);
  expect(JSON.parse((await ok(["tags", "--project", "alpha", "--json"])).out)).toEqual([
    { tag: "backend", count: 2 },
    { tag: "rework", count: 1 },
  ]);
  expect((await ok(["tags", "-q", "--project", "beta"])).out.trim()).toBe("backend\nfrontend");
  const unknown = await step(["tags", "--project", "nope"]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("nope");

  const listed = JSON.parse((await ok(["list", "--project", "alpha", "--json"])).out) as Array<{ ref: string; tags?: string[] }>;
  expect(listed.find((i) => i.ref === "AL-1")?.tags?.sort()).toEqual(["backend", "rework"]);
  expect(listed.find((i) => i.ref === "AL-3")?.tags).toEqual([]);

  // --- dependency priority: AL-1 (low) blocks AL-3 (medium) blocks AL-2 (high) ---
  await ok(["link", "AL-1", "blocks", "AL-3"]);
  await ok(["link", "AL-3", "blocks", "AL-2"]);
  const shown = await ok(["show", "AL-1"]);
  expect(shown.out).toContain("priority:  high (raised from low: blocks AL-3)");
  const one = JSON.parse((await ok(["show", "AL-1", "--json"])).out) as { priority: string; effective_priority: string; raised_by?: string };
  expect(one.priority).toBe("low"); // stored priority unchanged
  expect(one.effective_priority).toBe("high");
  expect(one.raised_by).toBe("AL-3");
  expect((await ok(["search", "Low", "--json"])).out).toContain('"effective_priority": "high"');
  const high = JSON.parse((await ok(["list", "--project", "alpha", "--priority", "high", "--json"])).out) as Array<{ ref: string }>;
  expect(high.map((i) => i.ref).sort()).toEqual(["AL-1", "AL-2", "AL-3"]);
  const next = JSON.parse((await ok(["next", "--project", "alpha", "--json"])).out) as Array<{ ref: string; effective_priority: string }>;
  expect(next.find((i) => i.ref === "AL-1")?.effective_priority).toBe("high");

  // Closing the high ticket drops the raise down the whole chain.
  await ok(["close", "AL-2"]);
  expect((await ok(["show", "AL-1"])).out).toContain("priority:  medium (raised from low: blocks AL-3)");
  await ok(["close", "AL-3"]);
  expect((await ok(["show", "AL-1"])).out).not.toContain("raised");
  // A raise across projects (checked under a scope below): AL-1 blocks a high ticket in beta.
  await ok(["add", "Beta high", "--project", "beta", "--priority", "high"]); // BE-2
  await ok(["link", "AL-1", "blocks", "BE-2"]);
  expect((await ok(["show", "AL-1"])).out).toContain("priority:  high (raised from low: blocks BE-2)");

  // --- overnight --at and backfill ---
  await ok(["overnight", "start", "--project", "alpha", "--date", "2026-11-17"]);
  await ok(["overnight", "start", "--project", "alpha", "--date", "2026-11-18"]);
  const at = JSON.parse(
    (await ok(["overnight", "decide", "Dated", "--what", "x", "--why", "y", "--project", "alpha", "--night", "2026-11-17", "--at", "2026-11-17T23:40:00Z", "--json"])).out,
  ) as { decided_at: string };
  expect(at.decided_at).toBe("2026-11-17T23:40:00.000Z");
  const bad = await step(["overnight", "decide", "Bad", "--what", "x", "--why", "y", "--project", "alpha", "--night", "2026-11-17", "--at", "last night"]);
  expect(bad.code).toBe(2);
  await ok(["overnight", "decide", "Imported 17", "--what", "x", "--why", "imported from wayfinder/overnight-review-2026-11-17.md", "--project", "alpha", "--night", "2026-11-17"]);
  await ok(["overnight", "decide", "Imported 18", "--what", "x", "--why", "imported from wayfinder/overnight-review-2026-11-18.md", "--project", "alpha", "--night", "2026-11-18"]);
  await ok(["overnight", "decide", "Live", "--what", "x", "--why", "logged live", "--project", "alpha", "--night", "2026-11-18"]);

  const dry = await ok(["overnight", "backfill", "--dry-run"]);
  expect(dry.out).toContain("2 decisions to backfill (dry run, nothing written)");
  const wet = await ok(["overnight", "backfill", "--project", "alpha", "--json"]);
  const rows = JSON.parse(wet.out) as Array<{ night: string; to: string }>;
  expect(rows.map((r) => [r.night, r.to])).toEqual([
    ["2026-11-17", "2026-11-17T00:00:00.000Z"],
    ["2026-11-18", "2026-11-18T00:00:00.000Z"],
  ]);
  expect((await ok(["overnight", "backfill"])).out.trim()).toBe("no imported overnight decisions to backfill");
  const night = JSON.parse((await ok(["overnight", "show", "--project", "alpha", "--date", "2026-11-18", "--json"])).out) as {
    decisions: Array<{ title: string; decided_at: string }>;
  };
  expect(night.decisions.find((d) => d.title === "Imported 18")?.decided_at).toBe("2026-11-18T00:00:00.000Z");
  expect(night.decisions.find((d) => d.title === "Live")?.decided_at.startsWith("2026-11-18T00:00:00")).toBe(false);
  return log;
}

let localLog: string[] = [];

describe("OS-216, local", () => {
  test("the proof script on a throwaway SQLite store", async () => {
    const dbPath = freshDbPath();
    localLog = await script((args) => runCli(dbPath, args));
    // A caller scoped to alpha (a scoped API token) never takes a raise from, or sees the ref of, beta's BE-2.
    const db = new Database(dbPath);
    try {
      const ids = new Map((await priorityRows(db, ["1", "5"])).map((r) => [r.ref, r.project_id]));
      expect(ids.get("AL-1")).toBeTruthy();
      expect(ids.get("BE-2")).not.toBe(ids.get("AL-1"));
      expect((await dependencyRaises(db, null)).get("1")?.viaRef).toBe("BE-2");
      expect((await dependencyRaises(db, null, new Set([ids.get("AL-1")!]))).has("1")).toBe(false);
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("OS-216 over the API", () => {
  test("routed, declared, and documented", () => {
    const declared = OB_API_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(declared).toContain("GET /tags");
    expect(declared).toContain("POST /overnight/backfill");
    expect(API_ROUTED_COMMANDS.has("tags")).toBe(true);
    expect(API_HANDLERS.tags).toBeDefined();
    const help = [renderCommandHelp("tags"), renderCommandHelp("link"), renderSubcommandHelp("overnight", "decide"), renderSubcommandHelp("overnight", "backfill")].join("\n");
    for (const doc of [help, README]) {
      for (const s of ["tags", "--at", "overnight backfill", "--dry-run", "blocks"]) expect(doc).toContain(s);
    }
  });

  test("the same script through the server prints the same lines with the same exit codes", async () => {
    const lease = await leaseRealPgDb();
    const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
    const obApi = createObApi({
      store: async () => store,
      token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    });
    const transport: ApiTransport = async (req) => {
      const res = await obApi(
        new Request(req.url.replace(BASE, "http://api-host.local"), {
          method: req.method,
          headers: req.headers,
          ...(req.body === undefined ? {} : { body: req.body }),
        }),
      );
      return { status: res.status, body: await res.text() };
    };
    try {
      const apiLog = await script((args) => runCli(freshDbPath(), args, { api: { base: BASE, token: TOKEN, transport } }));
      expect(apiLog).toEqual(localLog);
    } finally {
      await store.close?.();
    }
  }, 60_000);
});

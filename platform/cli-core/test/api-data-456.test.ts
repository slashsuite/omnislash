// ob 456 — remaining DATA commands through purpose-built endpoints.
//
// CLIENT half: stubbed transport, no network, no token file, no database.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import { API_ROUTED_COMMANDS, LOCAL_ONLY_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import { OB_API_LOCAL_ONLY, OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";
const README = cliDocs();

const PORTED = [
  "person",
  "whois",
  "review-miss",
  "cursor",
  "test-user",
  "sync",
] as const;

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

describe("routing (456)", () => {
  test("every remaining DATA command is ROUTED, has a client handler, and is not local-only", () => {
    for (const cmd of PORTED) {
      expect(API_ROUTED_COMMANDS.has(cmd), cmd).toBe(true);
      expect(LOCAL_ONLY_COMMANDS.has(cmd), cmd).toBe(false);
      expect(typeof API_HANDLERS[cmd], cmd).toBe("function");
    }
  });

  test("OB_API_LOCAL_ONLY has no store-path-not-ported rows", () => {
    for (const [cmd, reason] of Object.entries(OB_API_LOCAL_ONLY)) {
      expect(reason.includes("store path not ported (337)"), cmd).toBe(false);
    }
  });
});

describe("MUST SERVE over a stub (456)", () => {
  test("`ob person` GETs /people", async () => {
    const s = stub({
      "GET /people": {
        people: [
          {
            id: 1,
            real_name: "Ada",
            role: "eng",
            github_login: "ada",
            linear_user_id: null,
            linear_name: null,
            slack_user_id: null,
            slack_handle: null,
            whatsapp_jid: null,
            email: null,
            notes: null,
            relationship: null,
            comms_style: null,
            comms_notes: null,
            id_number: null,
            created_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    const r = await runCli(freshDbPath(), ["person", "list"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Ada");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/people`);
  });

  test("`ob person add` POSTs /people", async () => {
    const s = stub({
      "POST /people": {
        person: {
          id: 2,
          real_name: "Bob",
          role: null,
          github_login: null,
          linear_user_id: null,
          linear_name: null,
          slack_user_id: null,
          slack_handle: null,
          whatsapp_jid: null,
          email: null,
          notes: null,
          relationship: null,
          comms_style: null,
          comms_notes: null,
          id_number: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const r = await runCli(freshDbPath(), ["person", "add", "Bob"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(s.calls[0]!.body!)).toMatchObject({ real_name: "Bob" });
  });

  test("`ob whois ada` GETs /whois?handle=ada", async () => {
    const s = stub({
      "GET /whois": {
        person: {
          id: 1,
          real_name: "Ada",
          role: "eng",
          github_login: "ada",
          linear_user_id: null,
          linear_name: null,
          slack_user_id: null,
          slack_handle: null,
          whatsapp_jid: null,
          email: null,
          notes: null,
          relationship: null,
          comms_style: null,
          comms_notes: null,
          id_number: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      },
    });
    const r = await runCli(freshDbPath(), ["whois", "ada"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Ada");
    expect(s.calls[0]!.url).toContain("/whois?handle=ada");
  });

  test("`ob cursor get` GETs /cursors", async () => {
    const s = stub({ "GET /cursors": { value: "abc" } });
    const r = await runCli(freshDbPath(), ["cursor", "get", "acme", "k"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("abc");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/cursors?skill=acme&key=k`);
  });

  test("`ob sync` POSTs /sync (host handler, not a client sqlite open)", async () => {
    const s = stub({
      "POST /sync": { github: { prs: 3, events: 4 } },
    });
    const r = await runCli(freshDbPath(), ["sync"], api(s));
    expect(r.code).toBe(0);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.method).toBe("POST");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/sync`);
    expect(r.out).toContain("synced");
  });

  test("`ob snapshot` is gone", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["snapshot"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown command 'snapshot'");
    expect(s.calls).toEqual([]);
  });

});

describe("docs (456)", () => {
  test("README names the new endpoints", () => {
    expect(README).toContain("/api/ob/people");
    expect(README).toContain("/api/ob/sync");
  });
});

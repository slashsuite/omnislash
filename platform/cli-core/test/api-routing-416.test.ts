// ob 416 — kill the unrouted third class. Every HANDLER is API-routed or local-only.
//
// CLIENT half: stubbed transport, no network, no token file, no database, no live Google.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDLERS, HELP } from "../../../apps/cli/src/cli.ts";
import { API_HANDLERS } from "../../../apps/cli/src/api/client-handlers.ts";
import {
  API_ROUTED_COMMANDS,
  LOCAL_ONLY_COMMANDS,
  unroutedRefusal,
} from "../../../apps/cli/src/api/routing.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";
const README = readFileSync(join(import.meta.dir, "../../../apps/cli/README.md"), "utf8");

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

describe("every HANDLER is classified (416)", () => {
  test("Object.keys(HANDLERS) is the union of API_ROUTED and LOCAL_ONLY, no overlap, no remainder", () => {
    const handlers = Object.keys(HANDLERS).sort();
    const routed = [...API_ROUTED_COMMANDS].sort();
    const local = [...LOCAL_ONLY_COMMANDS.keys()].sort();
    const both = routed.filter((c) => LOCAL_ONLY_COMMANDS.has(c));
    expect(both).toEqual([]);
    expect([...routed, ...local].sort()).toEqual(handlers);
  });

  test("API_HANDLERS keys still match API_ROUTED_COMMANDS", () => {
    expect(Object.keys(API_HANDLERS).sort()).toEqual([...API_ROUTED_COMMANDS].sort());
  });

  test("unroutedRefusal is the safety net, not a class: no HANDLER can reach it", () => {
    for (const command of Object.keys(HANDLERS)) {
      const classified = API_ROUTED_COMMANDS.has(command) || LOCAL_ONLY_COMMANDS.has(command);
      expect(classified, command).toBe(true);
      // run.ts only calls unroutedRefusal when !local && !isApiRouted.
    }
    expect(unroutedRefusal("not-a-handler", BASE)).toContain("not routed through the ob API yet");
  });
});

describe("MUST SERVE over a stub (416)", () => {
  test("`ob project` GETs /projects and renders id\\tkind\\tname", async () => {
    const s = stub({
      "GET /projects": {
        projects: [{ id: "cue", name: "Cue", kind: "side", git_remote: "git@github.com:acmecorp/app.git", created_at: "2026-01-01T00:00:00.000Z" }],
      },
    });
    const r = await runCli(freshDbPath(), ["project"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("cue\tside\tCue\tgit@github.com:acmecorp/app.git");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/projects`);
  });

  test("`ob project add` POSTs /projects", async () => {
    const s = stub({
      "POST /projects": {
        project: { id: "side", name: "Side", kind: "side", git_remote: null, created_at: "2026-01-01T00:00:00.000Z" },
      },
    });
    const r = await runCli(freshDbPath(), ["project", "add", "Side", "--kind", "side"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("side");
    expect(s.calls[0]!.method).toBe("POST");
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ name: "Side", kind: "side", remote: null });
  });

  test("`ob project edit` POSTs /projects/:name/edit and `ob project rm --force` DELETEs /projects/:name?force=true (1621)", async () => {
    const proj = { id: "side", name: "Side", kind: "side", git_remote: "u", created_at: "2026-01-01T00:00:00.000Z" };
    const s = stub({
      "POST /projects/side/edit": { project: proj },
      "DELETE /projects/side": { project: proj },
    });
    const e = await runCli(freshDbPath(), ["project", "edit", "side", "--remote", "u"], api(s));
    expect(e.code).toBe(0);
    expect(s.calls[0]!.method).toBe("POST");
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ remote: "u" });
    const r = await runCli(freshDbPath(), ["project", "rm", "side", "--force"], api(s));
    expect(r.code).toBe(0);
    expect(s.calls[1]!.method).toBe("DELETE");
    expect(s.calls[1]!.url).toBe(`${BASE}${OB_API_PREFIX}/projects/side?force=true`);
    const noFlags = await runCli(freshDbPath(), ["project", "edit", "side"], api(s));
    expect(noFlags.code).not.toBe(0);
    expect(s.calls.length).toBe(2);
  });

  test("`ob project rename` POSTs /projects/:old/rename with the new name (OB-1846)", async () => {
    const proj = { id: "newname", name: "newname", kind: "side", git_remote: null, created_at: "2026-01-01T00:00:00.000Z", key: "ON" };
    const s = stub({ "POST /projects/oldname/rename": { project: proj } });
    const r = await runCli(freshDbPath(), ["project", "rename", "oldname", "newname"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("newname");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/projects/oldname/rename`);
    expect(JSON.parse(String(s.calls[0]!.body))).toEqual({ name: "newname" });
  });

  test("`ob brief --in-flight` GETs /brief?in_flight=true", async () => {
    const s = stub({ "GET /brief": { brief: { form: "in-flight", prs: { "addressing-comments": [], "waiting-review": [], authoring: [] }, items: [] } } });
    const r = await runCli(freshDbPath(), ["brief", "--in-flight"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("In flight");
    expect(s.calls[0]!.url).toContain("/brief?in_flight=true");
  });

  test("`ob log list --json` prints the SAME array the local command prints", async () => {
    const entries = [{ ts: "2026-08-20T10:00:00.000Z", type: "kudos", text: "nice", about: null, itemId: null }];
    const s = stub({ "GET /log": { entries } });
    const r = await runCli(freshDbPath(), ["log", "list", "--json"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(entries);
  });

  test("`ob log kudos hi` POSTs /log", async () => {
    const entry = { ts: "2026-08-20T10:00:00.000Z", type: "kudos", text: "hi", about: null, itemId: null };
    const s = stub({ "POST /log": { entry } });
    const r = await runCli(freshDbPath(), ["log", "kudos", "hi"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("logged kudos: hi");
    expect(JSON.parse(s.calls[0]!.body!)).toEqual({ type: "kudos", text: "hi", about: null, item: null });
  });

  test("`ob jobs --json` prints the SAME array", async () => {
    const jobs = [{ job: "sync", state: "ok", cadence_s: 300, threshold_s: 3600, quiet_s: 10, last_attempt_at: null, last_success_at: null, last_error: null, consecutive_failures: 0, consecutive_interruptions: 0, unresolved_for_s: null }];
    const s = stub({ "GET /jobs": { jobs } });
    const r = await runCli(freshDbPath(), ["jobs", "--json"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(jobs);
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/jobs`);
  });

  test("`ob alerts --quiet` prints keys", async () => {
    const s = stub({
      "GET /alerts": { alerts: [{ key: "7:sync", rule: 7, label: "job failing", entity: "sync", message: "failing", state_hash: "x" }] },
    });
    const r = await runCli(freshDbPath(), ["alerts", "--quiet"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("7:sync");
  });

  test("`ob decision list --json` matches local", async () => {
    const decisions = [{ id: "1", status: "accepted", title: "use postgres" }];
    const s = stub({ "GET /decisions": { decisions } });
    const r = await runCli(freshDbPath(), ["decision", "list", "--json"], api(s));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(decisions);
  });

  test("`ob learning` lists over /learnings", async () => {
    const s = stub({
      "GET /learnings": { learnings: [{ id: "2", status: "open", kind: "book", progress: "mid", title: "STE-100" }] },
    });
    const r = await runCli(freshDbPath(), ["learning"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("STE-100");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/learnings`);
  });

  test("`ob roadmap` lists over /roadmaps", async () => {
    const s = stub({
      "GET /roadmaps": { roadmaps: [{ id: "3", status: "open", title: "Q3", progress: { done: 1, total: 4, fraction: 0.25 } }] },
    });
    const r = await runCli(freshDbPath(), ["roadmap"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("Q3");
    expect(r.out).toContain("(1/4)");
  });

  test("`ob standup latest` GETs /standup/latest", async () => {
    const s = stub({ "GET /standup/latest": { standup: null } });
    const r = await runCli(freshDbPath(), ["standup", "latest"], api(s));
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("no standup yet");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/standup/latest`);
  });

  test("`ob standup generate` is gone", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["standup", "generate"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown standup subcommand");
    expect(s.calls).toEqual([]);
  });

  test("`ob slack unread` GETs /slack/unread", async () => {
    const s = stub({
      "GET /slack/unread": {
        messages: [{ id: 1, ts: "1", channel: "C", channel_type: "channel", user: "U", text: "hi", thread_ts: null, permalink: null, person_id: null, created_at: "2026-01-01T00:00:00.000Z" }],
      },
    });
    const r = await runCli(freshDbPath(), ["slack", "unread"], api(s));
    expect(r.code).toBe(0);
    expect(r.out).toContain("channel\tC\tU\thi");
    expect(s.calls[0]!.url).toBe(`${BASE}${OB_API_PREFIX}/slack/unread?limit=20`);
  });

  test("`ob slack sync` stays retired and does not call the API", async () => {
    const s = stub({});
    const r = await runCli(freshDbPath(), ["slack", "sync"], api(s));
    expect(r.code).toBe(2);
    expect(r.err).toContain("retired");
    expect(s.calls).toEqual([]);
  });
});

describe("MUST LOCAL refuse by name (416)", () => {
  test("OB-1808 moved backup, db and cert off the refusal: the API host runs them", () => {
    for (const command of ["backup", "db", "cert"]) {
      expect(API_ROUTED_COMMANDS.has(command), command).toBe(true);
      expect(LOCAL_ONLY_COMMANDS.has(command), command).toBe(false);
    }
  });

  test("456 moved the remaining DATA commands off the unported refusal", async () => {
    for (const command of ["person", "cursor", "whois"]) {
      expect(API_ROUTED_COMMANDS.has(command), command).toBe(true);
      expect(LOCAL_ONLY_COMMANDS.has(command), command).toBe(false);
    }
  });

  test("web points at the API host (457)", async () => {
    for (const command of ["web"]) {
      const s = stub({});
      const r = await runCli(freshDbPath(), [command], api(s));
      expect(r.code, command).toBe(1);
      expect(r.err, command).toContain("the API host");
      expect(r.err, command).not.toContain("store path not ported");
      expect(s.calls).toEqual([]);
    }
  });
});

describe("docs (416)", () => {
  test("HELP names the 416 served half and that the third class is gone", () => {
    expect(HELP).toContain("416");
    expect(HELP).toContain("EVERY command is API-routed or local-only");
    expect(HELP).not.toContain("'ob brief' and 'ob log' are not in this change");
  });

  test("README names the new endpoints", () => {
    expect(README).toContain("/api/ob/projects");
    expect(README).toContain("/api/ob/brief");
    expect(README).toContain("/api/ob/log");
    expect(README).toContain("/api/ob/slack/unread");
  });
});

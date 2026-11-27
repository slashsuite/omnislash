import { describe, expect, test } from "bun:test";
import { HANDLERS, HELP } from "../../../apps/cli/src/cli.ts";
import { LOCAL_ONLY_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import { daemonJobs, macDaemonJobs } from "../../cli-coord/src/commands/coord.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import type { ApiRequest, ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

const README = cliDocs();
const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

const RETIRED = ["replica", "pg-export", "init"] as const;
const SERVER_ONLY = ["web"] as const;
const MAC_MUST_NOT_INSTALL = [
  "web",
  "cert-renew",
  "backup",
  "sync",
  "gmail-sync",
  "cal-sync",
  "alerts",
] as const;

function stub() {
  const calls: ApiRequest[] = [];
  const transport: ApiTransport = async (req) => {
    calls.push(req);
    return {
      status: 404,
      body: JSON.stringify({ error: { code: "unknown_endpoint", message: "no stub" } }),
    };
  };
  return { transport, calls };
}

function api(s: ReturnType<typeof stub>) {
  return { api: { base: BASE, token: TOKEN, transport: s.transport } };
}

describe("retired leftover laptop commands (457)", () => {
  test("replica, pg-export and init are gone from HANDLERS", () => {
    for (const command of RETIRED) {
      expect(HANDLERS[command], command).toBeUndefined();
      expect(LOCAL_ONLY_COMMANDS.has(command), command).toBe(false);
    }
  });

  test("those three commands are a usage error, not a handler", async () => {
    for (const command of RETIRED) {
      const r = await runCli(freshDbPath(), [command]);
      expect(r.code, command).toBe(2);
      expect(r.err, command).toContain(`unknown command '${command}'`);
    }
  });

  test("HELP and README do not document them as commands", () => {
    expect(HELP).not.toMatch(/^\s*replica\b/m);
    expect(HELP).not.toMatch(/^\s*pg-export\b/m);
    expect(HELP).not.toMatch(/^\s*init\b/m);
    expect(README).not.toMatch(/^\| `replica /m);
    expect(README).not.toMatch(/^\| `pg-export /m);
    expect(README).not.toMatch(/^\| `init` /m);
  });
});

describe("Mac daemon install holds only the client jobs since the drain retired (457, 1589, OS-67, OS-288)", () => {
  test("macDaemonJobs is role-tick and settle-sweep", () => {
    const mac = macDaemonJobs("/Users/nobody").map((j) => j.job);
    expect(mac).toEqual(["role-tick", "settle-sweep"]);
    for (const job of MAC_MUST_NOT_INSTALL) {
      expect(mac, job).not.toContain(job);
    }
  });

  test("daemonJobs still declares the server fleet (health / units)", () => {
    const declared = daemonJobs("/Users/nobody").map((j) => j.job);
    expect(declared).not.toContain("spinoff-drain");
    expect(declared).toContain("web");
    expect(declared).toContain("backup");
    expect(declared).toContain("gmail-sync");
  });

  test("`ob daemon status --json` reports the Mac list, not the old full set", async () => {
    const r = await runCli(freshDbPath(), ["daemon", "status", "--json"]);
    expect(r.code).toBe(0);
    const jobs = JSON.parse(r.out).jobs as Array<{ job: string }>;
    expect(jobs.map((j) => j.job)).toEqual(["role-tick", "settle-sweep"]);
    for (const job of MAC_MUST_NOT_INSTALL) {
      expect(jobs.find((j) => j.job === job), job).toBeUndefined();
    }
  });
});

describe("API-client refuse for server-kept commands names the host (457)", () => {
  test("web refuses loudly: run on the API host, not unported", async () => {
    for (const command of SERVER_ONLY) {
      const s = stub();
      const r = await runCli(freshDbPath(), [command], api(s));
      expect(r.code, command).toBe(1);
      expect(r.err, command).toContain(`'ob ${command}' is a LOCAL command`);
      expect(r.err, command).toContain("the API host");
      expect(r.err, command).not.toContain("store path not ported");
      expect(r.err, command).not.toContain("unported");
      expect(s.calls).toEqual([]);
    }
  });
});

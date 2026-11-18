import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import {
  formatAgentsReset,
  listAgents,
  listAllAgentIds,
  registerAgent,
  resetAgents,
  resetAgentsAndLeases,
} from "../src/agent.ts";
import { acquireLease, leaseStatus, listAllLeaseResources, releaseAllLeases } from "../src/lease.ts";
import { enqueueSpinoff, listSpinoffs } from "../src/commands/spinoff.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { HELP } from "../../../apps/cli/src/cli.ts";

const LEASES = [
  "app:widget",
  "app:widget-dev",
  "ticket:1",
  "worktree:/tmp/437-wt",
  "port:3000",
  "spinoff:9",
] as const;

async function seed(db: ReturnType<typeof freshDb>): Promise<void> {
  await registerAgent(db, { id: "ghost-a", ticket: "117", status: "working", ttlS: 900 });
  await registerAgent(db, { id: "ghost-b", ticket: "145", status: "readying", ttlS: 900 });
  await registerAgent(db, { id: "architect-acme", status: "planning", ttlS: 900 });
  for (const resource of LEASES) {
    expect((await acquireLease(db, resource, "stale-holder", 1800)).ok).toBe(true);
  }
}

describe("resetAgents / releaseAllLeases (437)", () => {
  test("dry-run lists every agent and lease and writes nothing", async () => {
    const db = freshDb();
    await seed(db);
    const preview = await resetAgentsAndLeases(db, { dryRun: true });
    expect(preview.agents).toEqual(["architect-acme", "ghost-a", "ghost-b"]);
    expect(preview.leases).toEqual([...LEASES].sort());
    expect(await listAllAgentIds(db)).toEqual(preview.agents);
    expect(await listAllLeaseResources(db)).toEqual(preview.leases);
    expect((await listAgents(db, { includeExpired: true })).map((a) => a.id).sort()).toEqual(preview.agents);
    expect((await leaseStatus(db)).filter((l) => !l.expired)).toHaveLength(LEASES.length);
  });

  test("bare reset empties agents and every lease, including app:widget and ticket:1", async () => {
    const db = freshDb();
    await seed(db);
    const gone = await resetAgentsAndLeases(db);
    expect(gone.agents).toEqual(["architect-acme", "ghost-a", "ghost-b"]);
    expect(gone.leases).toContain("app:widget");
    expect(gone.leases).toContain("ticket:1");
    expect(await listAllAgentIds(db)).toEqual([]);
    expect(await listAgents(db, { includeExpired: true })).toEqual([]);
    expect(await leaseStatus(db)).toEqual([]);
    expect((await leaseStatus(db)).filter((l) => !l.expired)).toHaveLength(0);
  });

  test("resetAgents and releaseAllLeases are independently empty-safe", async () => {
    const db = freshDb();
    expect(await resetAgents(db)).toEqual([]);
    expect(await releaseAllLeases(db)).toEqual([]);
  });

  test("does not touch spinoff rows", async () => {
    const db = freshDb();
    await seed(db);
    await enqueueSpinoff(db, {
      ticketRef: "S-keep",
      repo: "/r/x",
      branch: "s-keep",
      mode: "agent",
      brief: "stay",
    });
    await resetAgentsAndLeases(db);
    const rows = await listSpinoffs(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ticket_ref: "S-keep", status: "pending" });
  });

  test("formatAgentsReset names the wipe and the live-process rule", () => {
    const human = formatAgentsReset({ agents: ["a"], leases: ["app:widget"] }, false);
    expect(human).toContain("reset 1 agents, 1 leases");
    expect(human).toContain("agents: a");
    expect(human).toContain("leases: app:widget");
    expect(human).toContain("do not kill or relaunch");
    expect(formatAgentsReset({ agents: [], leases: [] }, true)).toBe("would reset 0 agents, 0 leases");
  });
});

describe("CLI: ob agents reset (437)", () => {
  async function seedCli(dbPath: string): Promise<void> {
    for (const id of ["architect-acme", "ghost-a", "ghost-b"]) {
      expect((await runCli(dbPath, ["agent", "register", "--id", id, "--no-lease"])).code).toBe(0);
    }
    for (const resource of LEASES) {
      const r = await runCli(dbPath, ["lease", "acquire", resource, "--holder", "stale-holder", "--ttl", "1800"]);
      expect(r.code).toBe(0);
    }
  }

  test("--dry-run prints every id and resource, changes nothing", async () => {
    const dbPath = freshDbPath();
    await seedCli(dbPath);
    const preview = await runCli(dbPath, ["agents", "reset", "--dry-run"]);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain("would reset 3 agents, 6 leases");
    expect(preview.out).toContain("ghost-a");
    expect(preview.out).toContain("app:widget");
    expect(preview.out).toContain("ticket:1");
    expect(preview.out).not.toContain("do not kill");

    const agents = JSON.parse((await runCli(dbPath, ["agents", "--all", "--json"])).out) as Array<{ id: string }>;
    expect(agents.map((a) => a.id).sort()).toEqual(["architect-acme", "ghost-a", "ghost-b"]);
    const leases = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out) as Array<{
      resource: string;
      expired: boolean;
    }>;
    expect(leases.map((l) => l.resource).sort()).toEqual([...LEASES].sort());
    expect(leases.filter((l) => !l.expired)).toHaveLength(LEASES.length);
  });

  test("bare reset mutates with no --yes: 0 agents, 0 held leases", async () => {
    const dbPath = freshDbPath();
    await seedCli(dbPath);
    const reset = await runCli(dbPath, ["agents", "reset"]);
    expect(reset.code).toBe(0);
    expect(reset.out).toContain("reset 3 agents, 6 leases");
    expect(reset.out).toContain("app:widget");
    expect(reset.out).toContain("ticket:1");
    expect(reset.out).toContain("do not kill or relaunch");

    const agents = JSON.parse((await runCli(dbPath, ["agents", "--all", "--json"])).out) as unknown[];
    expect(agents).toEqual([]);
    const humanAgents = await runCli(dbPath, ["agents", "--all"]);
    expect(humanAgents.out).toContain("no active agents");
    const leases = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out) as unknown[];
    expect(leases).toEqual([]);
    const humanLeases = await runCli(dbPath, ["lease", "status"]);
    expect(humanLeases.out).toContain("no active leases");
  });

  test("--json names dry_run plus the ids; empty wipe is ok", async () => {
    const dbPath = freshDbPath();
    const empty = JSON.parse((await runCli(dbPath, ["agents", "reset", "--json"])).out);
    expect(empty).toEqual({ dry_run: false, agents: [], leases: [] });
    await seedCli(dbPath);
    const dry = JSON.parse((await runCli(dbPath, ["agents", "reset", "--dry-run", "--json"])).out);
    expect(dry.dry_run).toBe(true);
    expect(dry.agents).toHaveLength(3);
    expect(dry.leases).toContain("app:widget");
    expect(JSON.parse((await runCli(dbPath, ["agents", "--all", "--json"])).out)).toHaveLength(3);
  });

  test("does not touch spinoff rows or items", async () => {
    const dbPath = freshDbPath();
    await seedCli(dbPath);
    expect((await runCli(dbPath, ["add", "keep this item", "--project", "proj"])).code).toBe(0);
    const db = openDb(dbPath);
    await enqueueSpinoff(db, {
      ticketRef: "S-keep",
      repo: "/r/x",
      branch: "s-keep",
      mode: "agent",
      brief: "stay",
    });
    db.close();
    expect((await runCli(dbPath, ["agents", "reset"])).code).toBe(0);
    const items = JSON.parse((await runCli(dbPath, ["list", "--json"])).out) as Array<{ title: string }>;
    expect(items.some((i) => i.title === "keep this item")).toBe(true);
    const db2 = openDb(dbPath);
    expect((await listSpinoffs(db2)).map((r) => r.ticket_ref)).toEqual(["S-keep"]);
    db2.close();
  });

  test("HELP and README warn this is a full wipe", () => {
    expect(HELP).toContain("agents reset [--dry-run]");
    expect(HELP).toContain("WIPE");
    expect(HELP).toContain("no --yes");
    expect(HELP).toContain("Live processes stay up");
    const readme = readFileSync(join(import.meta.dir, "../../../apps/cli/README.md"), "utf8");
    expect(readme).toContain("`agents reset [--dry-run]`");
    expect(readme).toContain("Full wipe of the agent registry AND every lease");
    expect(readme).toContain("/api/ob/agents/reset");
    expect(readme).toContain("Live processes stay up");
  });
});

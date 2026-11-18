import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { enqueueSpinoff, markSpinoffReady, type EnqueueInput, type SpinoffRow } from "../src/commands/spinoff.ts";
import { __setSh } from "./sh-no-pr.ts";
import { getAgent, listAgents, registerAgent } from "../src/agent.ts";
import { claimTicketLease } from "../src/agent-register.ts";
import { acquireLeases, liveHold, ticketLeaseKey, worktreeLeaseKey } from "../src/lease.ts";

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "577",
  repo: "/r/omnislash",
  branch: "577",
  mode: "interactive",
  brief: "ready must not let register re-claim",
  ...over,
});

async function seedLaunched(
  db: ReturnType<typeof freshDb>,
  ticket: string,
  branch: string,
  worktree = `/wt/${branch}`,
): Promise<SpinoffRow> {
  const { row } = await enqueueSpinoff(db, input({ ticketRef: ticket, branch, worktree }));
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, worktree = ? WHERE id = ?").run(
    branch,
    worktree,
    row.id,
  );
  await registerAgent(db, { id: branch, ticket, branch, worktree, status: "working", ttlS: 900 });
  return { ...row, status: "launched", agent_id: branch, worktree };
}

describe("claimTicketLease after ready-for-gate (577)", () => {
  test("ready → register --note does not re-claim ticket:; architect acquire succeeds", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "577", "577", "/tmp/wt-577");
    await acquireLeases(db, [ticketLeaseKey("577"), worktreeLeaseKey("/tmp/wt-577")], "577", 900);
    await markSpinoffReady(db, row);
    expect(await liveHold(db, ticketLeaseKey("577")!)).toBeNull();
    expect(await liveHold(db, worktreeLeaseKey("/tmp/wt-577")!)).toBeNull();

    expect(await claimTicketLease(db, { id: "577", ticket: "577", ttlS: 900 })).toBeNull();
    await registerAgent(db, { id: "577", note: "tool.execute.after", ttlS: 900 });

    expect(await liveHold(db, ticketLeaseKey("577")!)).toBeNull();
    expect(await liveHold(db, worktreeLeaseKey("/tmp/wt-577")!)).toBeNull();
    expect((await getAgent(db, "577"))?.note).toBe("tool.execute.after");
    expect((await listAgents(db)).map((a) => a.id)).toEqual(["577"]);

    const got = await acquireLeases(db, [ticketLeaseKey("577")], "architect-omnislash", 1800);
    expect(got.ok).toBe(true);
    expect((await liveHold(db, ticketLeaseKey("577")!))?.holder).toBe("architect-omnislash");
  });

  test("session.idle --status needs-human still does not re-claim", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "577", "577", "/tmp/wt-577");
    await acquireLeases(db, [ticketLeaseKey("577")], "577", 900);
    await markSpinoffReady(db, row);

    expect(await claimTicketLease(db, { id: "577", ticket: "577", ttlS: 900 })).toBeNull();
    await registerAgent(db, { id: "577", status: "needs-human", ttlS: 900 });

    expect(await liveHold(db, ticketLeaseKey("577")!)).toBeNull();
    expect((await getAgent(db, "577"))?.status).toBe("needs-human");
    const got = await acquireLeases(db, [ticketLeaseKey("577")], "architect-omnislash", 1800);
    expect(got.ok).toBe(true);
  });

  test("a launched (not ready) builder still claims", async () => {
    const db = freshDb();
    await seedLaunched(db, "577", "577", "/tmp/wt-577");
    expect(await claimTicketLease(db, { id: "577", ticket: "577", ttlS: 900 })).toBe("ticket:577");
    expect((await liveHold(db, ticketLeaseKey("577")!))?.holder).toBe("577");
  });

  test("does not drop an architect-* hold", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "577", "577", "/tmp/wt-577");
    await acquireLeases(db, [ticketLeaseKey("577")], "architect-omnislash", 1800);
    await markSpinoffReady(db, row);
    expect(await claimTicketLease(db, { id: "577", ticket: "577", ttlS: 900, holder: "architect-omnislash" })).toBe(
      "ticket:577",
    );
    expect(await claimTicketLease(db, { id: "577", ticket: "577", ttlS: 900 })).toBe("ticket:577");
    expect((await liveHold(db, ticketLeaseKey("577")!))?.holder).toBe("architect-omnislash");
    expect(await getAgent(db, "577")).not.toBeNull();
  });
});

describe("ob spinoff ready then agent register (577)", () => {
  test("ready → register --note → ticket: is free; architect acquire succeeds; agent row stays", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    // A REAL directory: since 1188 `spinoff ready` requires the checkout it is about to still exist.
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-577-"));
    await seedLaunched(db, "577", "577", wt);
    await acquireLeases(db, [ticketLeaseKey("577"), worktreeLeaseKey(wt)], "577", 900);
    const restore = __setSh((cmd) =>
      cmd.includes("--porcelain") ? { ok: true, err: "", out: "" } : { ok: true, err: "", out: "State: ready\n" },
    );
    try {
      expect((await runCli(dbPath, ["spinoff", "ready", "577"])).code).toBe(0);

      const reg = await runCli(dbPath, ["agent", "register", "--id", "577", "--note", "tool.execute.after"]);
      expect(reg.code).toBe(0);
      expect(reg.out).toContain("registered 577");

      expect(JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)).toEqual([]);

      const acquire = await runCli(dbPath, [
        "lease",
        "acquire",
        "ticket:577",
        "--holder",
        "architect-omnislash",
        "--ttl",
        "1800",
      ]);
      expect(acquire.code).toBe(0);

      const held = JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out);
      expect(held).toHaveLength(1);
      expect(held[0].resource).toBe("ticket:577");
      expect(held[0].holder).toBe("architect-omnislash");

      const beat = await runCli(dbPath, ["agent", "heartbeat", "577"]);
      expect(beat.code).toBe(0);
      expect(JSON.parse((await runCli(dbPath, ["lease", "status", "--json"])).out)[0].holder).toBe("architect-omnislash");

      const agents = JSON.parse((await runCli(dbPath, ["agents", "--json"])).out) as Array<{
        id: string;
        note: string | null;
      }>;
      expect(agents.map((a) => a.id)).toContain("577");
      expect(agents.find((a) => a.id === "577")?.note).toBe("tool.execute.after");
    } finally {
      restore();
      db.close();
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

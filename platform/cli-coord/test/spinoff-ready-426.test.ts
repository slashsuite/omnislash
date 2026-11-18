import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { enqueueSpinoff, listSpinoffs, markSpinoffReady, type EnqueueInput, type SpinoffRow } from "../src/commands/spinoff.ts";
import { __setSh } from "./sh-no-pr.ts";
import { getAgent, listAgents, registerAgent } from "../src/agent.ts";
import { acquireLeases, appLeaseKey, liveHold, ticketLeaseKey, worktreeLeaseKey } from "../src/lease.ts";

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "426",
  repo: "/r/omnislash",
  branch: "426",
  mode: "interactive",
  brief: "release builder leases",
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

describe("markSpinoffReady releases builder leases (426)", () => {
  test("releases ticket: and worktree: held by agent_id / branch; keeps the agent row", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "426", "426", "/tmp/wt-426");
    await acquireLeases(db, [ticketLeaseKey("426"), worktreeLeaseKey("/tmp/wt-426")], "426", 900);

    const result = await markSpinoffReady(db, row);
    expect(result.already).toBe(false);
    expect(result.leasesReleased).toBe(true);
    expect(result.row.status).toBe("ready-for-gate");
    expect((await liveHold(db, ticketLeaseKey("426")!))).toBeNull();
    expect((await liveHold(db, worktreeLeaseKey("/tmp/wt-426")!))).toBeNull();
    expect((await getAgent(db, "426"))?.status).toBe("readying");
    expect((await listAgents(db)).map((a) => a.id)).toEqual(["426"]);
    expect((await listSpinoffs(db, "ready-for-gate")).map((r) => r.ticket_ref)).toEqual(["426"]);
  });

  test("releases the worktree:omnislash.<branch> form when the builder holds it", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "426", "426", "/tmp/wt-426");
    await acquireLeases(db, [ticketLeaseKey("426"), "worktree:omnislash.426"], "426", 900);

    const result = await markSpinoffReady(db, row);
    expect(result.leasesReleased).toBe(true);
    expect((await liveHold(db, ticketLeaseKey("426")!))).toBeNull();
    expect((await liveHold(db, "worktree:omnislash.426"))).toBeNull();
  });

  test("does not release an architect-* hold on the same keys", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "426", "426", "/tmp/wt-426");
    await acquireLeases(db, [ticketLeaseKey("426"), worktreeLeaseKey("/tmp/wt-426")], "architect-omnislash", 1800);

    const result = await markSpinoffReady(db, row);
    expect(result.leasesReleased).toBe(false);
    expect((await liveHold(db, ticketLeaseKey("426")!))?.holder).toBe("architect-omnislash");
    expect((await liveHold(db, worktreeLeaseKey("/tmp/wt-426")!))?.holder).toBe("architect-omnislash");
  });

  test("does not release architect-cue / any architect-* even when the builder also holds another key", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "426", "426", "/tmp/wt-426");
    await acquireLeases(db, [ticketLeaseKey("426")], "426", 900);
    await acquireLeases(db, [worktreeLeaseKey("/tmp/wt-426")], "architect-cue", 1800);

    const result = await markSpinoffReady(db, row);
    expect(result.leasesReleased).toBe(true);
    expect((await liveHold(db, ticketLeaseKey("426")!))).toBeNull();
    expect((await liveHold(db, worktreeLeaseKey("/tmp/wt-426")!))?.holder).toBe("architect-cue");
  });

  test("does not release an app: key the builder happens to hold", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "426", "426", "/tmp/wt-426");
    await acquireLeases(db, [ticketLeaseKey("426"), appLeaseKey("widget-dev")], "426", 900);

    const result = await markSpinoffReady(db, row);
    expect(result.leasesReleased).toBe(true);
    expect((await liveHold(db, ticketLeaseKey("426")!))).toBeNull();
    expect((await liveHold(db, appLeaseKey("widget-dev")!))?.holder).toBe("426");
  });

  test("already ready-for-gate still releases leftover builder leases (418)", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "418", "418", "/tmp/wt-418");
    await markSpinoffReady(db, row);
    await acquireLeases(db, [ticketLeaseKey("418")], "418", 900);

    const again = await markSpinoffReady(db, { ...row, status: "ready-for-gate" });
    expect(again.already).toBe(true);
    expect(again.leasesReleased).toBe(true);
    expect((await liveHold(db, ticketLeaseKey("418")!))).toBeNull();
    expect((await getAgent(db, "418"))).not.toBeNull();
    expect((await listSpinoffs(db, "ready-for-gate"))).toHaveLength(1);
  });

  test("already ready-for-gate with nothing held reports leasesReleased false", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "426", "426");
    await markSpinoffReady(db, row);
    const again = await markSpinoffReady(db, { ...row, status: "ready-for-gate" });
    expect(again.already).toBe(true);
    expect(again.leasesReleased).toBe(false);
  });
});

describe("ob spinoff ready --json leases_released (426)", () => {
  test("true when the builder held ticket:/worktree:, false on a second call with nothing left", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    // A REAL directory since 1188: a readying decision now requires the checkout to still exist, so the
    // fake path this used to pass is exactly the hole the guard closes.
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-426-"));
    await seedLaunched(db, "426", "426", wt);
    await acquireLeases(db, [ticketLeaseKey("426"), worktreeLeaseKey(wt)], "426", 900);
    const restore = __setSh((cmd) =>
      cmd.includes("--porcelain") ? { ok: true, err: "", out: "" } : { ok: true, err: "", out: "State: ready\n" },
    );
    try {
      const first = await runCli(dbPath, ["spinoff", "ready", "426", "--json"]);
      expect(first.code).toBe(0);
      const body = JSON.parse(first.out);
      expect(body.already).toBe(false);
      expect(body.leases_released).toBe(true);
      expect(body.status).toBe("handed-off");

      const second = await runCli(dbPath, ["spinoff", "ready", "426", "--json"]);
      expect(second.code).toBe(0);
      expect(JSON.parse(second.out).leases_released).toBe(false);
      expect(JSON.parse(second.out).already).toBe(true);
    } finally {
      restore();
      db.close();
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

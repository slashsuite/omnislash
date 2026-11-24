import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import {
  enqueueSpinoff,
  findSpinoffForReady,
  formatReadyReport,
  listSpinoffs,
  markSpinoffReady,
  markSpinoffSentBack,
  pickSpinoffForReady,
  readCommitState,
  recentlyDoneSpinoffs,
  reconcileSpinoffs,
  watchReconcileTick,
  type EnqueueInput,
  type SpinoffRow,
} from "../src/commands/spinoff.ts";
import { __setSh } from "./sh-no-pr.ts";
import { getAgent, listAgents, registerAgent } from "../src/agent.ts";
import { acquireLeases, liveHold, ticketLeaseKey, worktreeLeaseKey } from "../src/lease.ts";

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "391",
  repo: "/r/omnislash",
  branch: "391",
  mode: "interactive",
  brief: "declare done",
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

describe("pickSpinoffForReady (391)", () => {
  const launched = (over: Partial<SpinoffRow> = {}): SpinoffRow =>
    ({
      id: 7,
      ticket_ref: "391",
      repo: "/r",
      branch: "391",
      worktree: "/wt/391",
      mode: "interactive",
      brief: "x",
      status: "launched",
      error: null,
      agent_id: "391",
      request_at: "2026-08-23T00:00:00.000Z",
      launched_at: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
      base_sha: null,
      reported_at: null,
      launcher: null,
      launch_attempts: 1,
      session_id: null,
      engine: null,
      ...over,
    }) as SpinoffRow;

  test("prefers a readyable id over a same-numbered ticket on a merged row", () => {
    const rows = [
      launched({ id: 12, ticket_ref: "other", status: "merged" }),
      launched({ id: 3, ticket_ref: "12", branch: "t-12" }),
    ];
    expect(pickSpinoffForReady(rows, { ref: "12" }).ticket_ref).toBe("12");
  });

  test("refuses a merged id by NAME rather than picking another row (1188)", () => {
    const rows = [launched({ id: 9, status: "merged" }), launched({ id: 10, ticket_ref: "other" })];
    // 1188: a landed row's refusal says it landed, not that it is "not launched" — the difference a
    // architect acting on a stale note needs. The sha comes from an injected reader (this function is pure).
    expect(() => pickSpinoffForReady(rows, { ref: "9" })).toThrow(/nothing to gate; 391 has already landed/);
    expect(() => pickSpinoffForReady(rows, { ref: "9", landedShaFor: () => "1a9ca3fc" })).toThrow(
      "nothing to gate; 391 landed as 1a9ca3fc",
    );
  });

  test("cwd worktree wins over branch when both match different rows", () => {
    const rows = [
      launched({ id: 1, ticket_ref: "A", branch: "feat", worktree: "/other" }),
      launched({ id: 2, ticket_ref: "B", branch: "other", worktree: "/here" }),
    ];
    expect(pickSpinoffForReady(rows, { cwd: "/here", branch: "feat" }).ticket_ref).toBe("B");
  });
});

describe("markSpinoffReady (391)", () => {
  test("stamps launched → ready-for-gate, bumps the agent, releases no lease", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "391", "391", "/tmp/wt-391");
    await acquireLeases(db, [ticketLeaseKey("391"), worktreeLeaseKey("/tmp/wt-391")], "architect-omnislash", 1800);

    const result = await markSpinoffReady(db, row);
    expect(result.already).toBe(false);
    expect(result.row.status).toBe("ready-for-gate");
    expect((await listSpinoffs(db, "ready-for-gate")).map((r) => r.ticket_ref)).toEqual(["391"]);
    expect((await getAgent(db, "391"))?.status).toBe("readying");
    expect((await listAgents(db)).map((a) => a.id)).toEqual(["391"]);
    expect(result.leasesReleased).toBe(false);
    expect((await liveHold(db, ticketLeaseKey("391")!))?.holder).toBe("architect-omnislash");
    expect((await liveHold(db, worktreeLeaseKey("/tmp/wt-391")!))?.holder).toBe("architect-omnislash");
  });

  test("is idempotent when already handed off", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "391", "391");
    await markSpinoffReady(db, row);
    const again = await markSpinoffReady(db, { ...row, status: "ready-for-gate" });
    expect(again.already).toBe(true);
    expect((await listSpinoffs(db, "ready-for-gate"))).toHaveLength(1);
  });

  test("refuses pending / merged / failed", async () => {
    const db = freshDb();
    const { row } = await enqueueSpinoff(db, input({ ticketRef: "P" }));
    await expect(markSpinoffReady(db, row)).rejects.toThrow(/is queued/);
  });
});

describe("watch + status + reconcile see ready-for-gate (391)", () => {
  test("watch emits ready-for-gate without the branch being on main", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "391", "391");
    await markSpinoffReady(db, row);
    const done = await watchReconcileTick(db, { reported: new Set() }, () => {}, () => false);
    expect(done).toEqual([{ id: row.id, ticket_ref: "391", branch: "391", outcome: "handed off" }]);
    expect((await listSpinoffs(db, "ready-for-gate"))[0]!.reported_at).not.toBeNull();
    expect(await watchReconcileTick(db, { reported: new Set() }, () => {}, () => false)).toEqual([]);
  });

  test("a handoff then a merge is reported twice, once each (OB-1924)", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "391", "391");
    db.query("UPDATE spinoff SET base_sha = 'base-sha' WHERE id = ?").run(row.id);
    const state = { reported: new Set<number>() };
    const restore = __setSh((cmd) =>
      cmd.includes("rev-list") && cmd.includes("--count") ? { ok: true, err: "", out: "1\n" } : { ok: true, err: "", out: "" },
    );
    try {
      await markSpinoffReady(db, row);
      expect((await watchReconcileTick(db, state, () => {}, () => false)).map((d) => d.outcome)).toEqual(["handed off"]);
      expect(await watchReconcileTick(db, state, () => {}, () => false)).toEqual([]);
      // the architect merges the PR: the branch is on main, reconcile lands the row
      expect((await watchReconcileTick(db, state, () => {}, () => true)).map((d) => d.outcome)).toEqual(["landed on main"]);
      expect(await watchReconcileTick(db, state, () => {}, () => true)).toEqual([]);
    } finally {
      restore();
    }
  });

  test("a handoff, a sendback and a second handoff reports the second (OB-1924)", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "391", "391");
    const state = { reported: new Set<number>() };
    const emitted: string[] = [];
    await markSpinoffReady(db, row);
    await watchReconcileTick(db, state, (d) => emitted.push(d.outcome), () => false);
    const handed = (await listSpinoffs(db, "ready-for-gate"))[0]!;
    expect(handed.reported_at).not.toBeNull();
    await markSpinoffSentBack(db, handed);
    // sent back: off the handed-off list, nothing new to report
    expect(await watchReconcileTick(db, state, (d) => emitted.push(d.outcome), () => false)).toEqual([]);
    await markSpinoffReady(db, (await listSpinoffs(db, "launched"))[0]!);
    const again = await watchReconcileTick(db, state, (d) => emitted.push(d.outcome), () => false);
    expect(again.map((d) => d.outcome)).toEqual(["handed off"]);
    expect(emitted).toEqual(["handed off", "handed off"]);
  });

  test("recentlyDoneSpinoffs includes ready-for-gate ahead of needing a merge", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "391", "391");
    await markSpinoffReady(db, row);
    expect((await recentlyDoneSpinoffs(db)).map((r) => r.ticket_ref)).toEqual(["391"]);
    expect((await recentlyDoneSpinoffs(db))[0]!.status).toBe("ready-for-gate");
  });

  test("reconcile still lands a ready-for-gate row once the branch merges", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "391", "391");
    await markSpinoffReady(db, row);
    const rec = await reconcileSpinoffs(db, () => true, undefined, () => 1);
    expect(rec.merged).toEqual(["391"]);
    expect((await listSpinoffs(db, "merged")).map((r) => r.ticket_ref)).toEqual(["391"]);
    expect(await listAgents(db)).toEqual([]);
  });
});

describe("readCommitState + formatReadyReport (391)", () => {
  test("takes the newest State: line from the branch range (git log is newest first)", () => {
    const restore = __setSh((cmd) => {
      if (cmd.includes("log") && cmd.some((c) => String(c).includes("main.."))) {
        return { ok: true, err: "", out: "feat: y\n\nState: ready — gated\n\nfeat: x\n\nState: partial — wip\n" };
      }
      return { ok: true, err: "", out: "" };
    });
    try {
      expect(readCommitState("/wt", "391")).toBe("State: ready — gated");
    } finally {
      restore();
    }
  });

  test("State: ready-for-gate is prose, not a verdict (OB-1924)", () => {
    const restore = __setSh((cmd) => {
      if (cmd.includes("log")) return { ok: true, err: "", out: "feat: y\n\nState: ready-for-gate\n" };
      return { ok: true, err: "", out: "" };
    });
    try {
      expect(readCommitState("/wt", "391")).toBeNull();
    } finally {
      restore();
    }
  });

  test("report names ticket, branch, worktree, State, and the architect next step", () => {
    const row = {
      ticket_ref: "391",
      branch: "391",
      worktree: "/Users/j/dev/omnislash.391",
    } as SpinoffRow;
    const text = formatReadyReport(row, "State: ready — gated", false);
    expect(text).toContain("391 handed off");
    expect(text).toContain("ticket:    391");
    expect(text).toContain("branch:    391");
    expect(text).toContain("worktree:  /Users/j/dev/omnislash.391");
    expect(text).toContain("State: ready — gated");
    expect(text).toContain("landable: yes");
    expect(text).toContain("next:      the sentinel gates and merges the PR (the handoff is the human yes)");
    expect(text).not.toContain("agent done");
  });
});

describe("ob spinoff ready CLI (391)", () => {
  test("marks by ticket and prints the architect next step", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    // A real directory: since 1188 a readying decision requires the checkout it is about to still exist.
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-391-"));
    await seedLaunched(db, "391", "391", wt);
    // `status --porcelain` answers empty (a clean checkout) — the same stub shape the 471 dirty test uses.
    const restore = __setSh((cmd) =>
      cmd.includes("--porcelain") ? { ok: true, err: "", out: "" } : { ok: true, err: "", out: "State: ready — gated\n" },
    );
    try {
      const r = await runCli(dbPath, ["spinoff", "ready", "391"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("391 handed off");
      expect(r.out).toContain("ticket:    391");
      expect(r.out).toContain("branch:    391");
      expect(r.out).toContain(`worktree:  ${wt}`);
      expect(r.out).toContain("State: ready — gated");
      expect(r.out).toContain("landable: yes");
      expect(r.out).toContain("next:      the sentinel gates and merges the PR (the handoff is the human yes)");
      const json = await runCli(dbPath, ["spinoff", "ready", "391", "--json"]);
      const body = JSON.parse(json.out);
      expect(body.already).toBe(true);
      expect(body.leases_released).toBe(false);
      expect(body.status).toBe("handed-off");
    } finally {
      restore();
      db.close();
      rmSync(wt, { recursive: true, force: true });
    }
  });
});

describe("findSpinoffForReady against a store (391)", () => {
  test("finds by ticket, by id, and refuses a pending row", async () => {
    const db = freshDb();
    const row = await seedLaunched(db, "391", "391", "/tmp/wt-391");
    expect((await findSpinoffForReady(db, { ref: "391" })).id).toBe(row.id);
    expect((await findSpinoffForReady(db, { ref: String(row.id) })).id).toBe(row.id);
    await enqueueSpinoff(db, input({ ticketRef: "pending-only", branch: "p" }));
    await expect(findSpinoffForReady(db, { ref: "pending-only" })).rejects.toThrow(/is queued/);
  });
});

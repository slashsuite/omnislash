import { describe, expect, test } from "bun:test";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { renderSubcommandHelp } from "../../../apps/cli/src/cli.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { enqueueSpinoff, refuseSubcommandRef, type EnqueueInput, type SpinoffRow, type StampInput } from "../src/commands/spinoff.ts";
import { abandonRefusal, abandonSpinoff, abandonedError, isAbandoned, renderAbandon, type AbandonDeps } from "../src/spinoff-abandon.ts";
import { buildMix, type MixSource } from "../src/spinoff-mix.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

// 1697: `ob spinoff abandon` retires a launched-but-unbuilt spinoff without `ob close` (which stamps it landed).

const row = (over: Partial<SpinoffRow> = {}): SpinoffRow =>
  ({
    id: 783,
    ticket_ref: "abandon",
    repo: "omnislash",
    branch: "abandon",
    worktree: "/wt/abandon",
    mode: "interactive",
    brief: "b",
    status: "launched",
    error: null,
    agent_id: "abandon",
    base_sha: "abc123",
    t3_thread_id: "thread-1",
    ...over,
  }) as SpinoffRow;

function deps(over: Partial<AbandonDeps> = {}): AbandonDeps & { calls: string[]; stamped: StampInput[] } {
  const calls: string[] = [];
  const stamped: StampInput[] = [];
  return {
    calls,
    stamped,
    commitsAhead: () => 0,
    stopThread: async (id) => {
      calls.push(`stop:${id}`);
      return { interrupted: true, settled: true, error: null };
    },
    stamp: async (input) => {
      calls.push("stamp");
      stamped.push(input);
      return null;
    },
    finishAgent: async (id) => {
      calls.push(`done:${id}`);
      return { done: true, released: ["ticket:abandon", "worktree:/wt/abandon"], error: null };
    },
    ...over,
  };
}

describe("abandonRefusal (1697)", () => {
  test("a landed row, an already failed row and an already abandoned row are refused", () => {
    expect(abandonRefusal(row({ status: "merged" }), 0, false)).toContain("already landed");
    expect(abandonRefusal(row({ status: "failed", error: "launch blew up" }), 0, false)).toContain("already failed");
    expect(abandonRefusal(row({ status: "failed", error: "abandoned: oops" }), 0, false)).toContain("already abandoned");
  });

  test("commits past base_sha are a land, not an abandon, until --force", () => {
    expect(abandonRefusal(row(), 2, false)).toContain("2 commit(s)");
    expect(abandonRefusal(row(), 2, true)).toBeNull();
    expect(abandonRefusal(row(), 0, false)).toBeNull();
  });

  test("unknown commits refuse a launched row but not a pending one", () => {
    expect(abandonRefusal(row(), null, false)).toContain("cannot tell");
    expect(abandonRefusal(row(), null, true)).toBeNull();
    expect(abandonRefusal(row({ status: "pending" }), null, false)).toBeNull();
  });
});

describe("abandonSpinoff (1697)", () => {
  test("stops the thread, THEN retires the row, THEN finishes the agent", async () => {
    const d = deps();
    const res = await abandonSpinoff(row(), d, { note: "started by mistake" });
    expect(d.calls).toEqual(["stop:thread-1", "stamp", "done:abandon"]);
    expect(d.stamped).toEqual([{ id: 783, outcome: "failed", error: "abandoned: started by mistake" }]);
    expect(res).toMatchObject({ id: 783, agent_done: true, released: ["ticket:abandon", "worktree:/wt/abandon"], warnings: [] });
    expect(res.thread).toMatchObject({ id: "thread-1", interrupted: true, settled: true });
  });

  test("a row with no thread skips the stop; a missing note is said", async () => {
    const d = deps();
    await abandonSpinoff(row({ t3_thread_id: null }), d);
    expect(d.calls).toEqual(["stamp", "done:abandon"]);
    expect(d.stamped[0]!.error).toBe("abandoned: no note given");
  });

  test("falls back to the branch when the row has no agent id", async () => {
    const d = deps();
    await abandonSpinoff(row({ agent_id: null, branch: "b-1" }), d);
    expect(d.calls).toContain("done:b-1");
  });

  test("a thread that will not settle changes NOTHING without --force", async () => {
    const d = deps({ stopThread: async () => ({ interrupted: false, settled: false, error: "T3 unreachable" }) });
    await expect(abandonSpinoff(row(), d, {})).rejects.toThrow(/could not be stopped.*Nothing was changed/s);
    expect(d.calls).toEqual([]);
  });

  test("--force retires the row past a stuck thread and says so", async () => {
    const d = deps({ stopThread: async () => ({ interrupted: false, settled: false, error: "T3 unreachable" }) });
    const res = await abandonSpinoff(row(), d, { force: true });
    expect(d.calls).toEqual(["stamp", "done:abandon"]);
    expect(res.warnings.join("\n")).toContain("may still be running");
  });

  test("a refused row touches nothing (no stop, no stamp)", async () => {
    const d = deps({ commitsAhead: () => 3 });
    await expect(abandonSpinoff(row(), d, {})).rejects.toThrow(/3 commit\(s\)/);
    expect(d.calls).toEqual([]);
  });

  test("a failed stamp stops before the agent is finished", async () => {
    const d = deps({ stamp: async () => "no such row" });
    await expect(abandonSpinoff(row(), d, {})).rejects.toThrow(/not retired: no such row/);
    expect(d.calls).toEqual(["stop:thread-1"]);
  });

  test("an agent step that fails is a warning, not a lost abandon", async () => {
    const d = deps({ finishAgent: async () => ({ done: false, released: [], error: "api down" }) });
    const res = await abandonSpinoff(row(), d, {});
    expect(res.warnings[0]).toContain("ob agent done abandon");
  });

  test("the report names the worktree it kept", async () => {
    const res = await abandonSpinoff(row(), deps(), { note: "x" });
    expect(renderAbandon(res, false)).toContain("worktree kept: /wt/abandon");
    expect((JSON.parse(renderAbandon(res, true)) as { status: string }).status).toBe("failed");
  });
});

describe("spinoff mix excludes abandoned rows (1697)", () => {
  const mix = (id: number, over: Partial<MixSource> = {}): MixSource => ({
    id,
    ticket_ref: `t${id}`,
    repo: "omnislash",
    status: "merged",
    error: null,
    request_at: "2026-10-10T00:00:00.000Z",
    item_id: null,
    tier: "medium",
    model: "claude-sonnet-5-5",
    ...over,
  });

  test("isAbandoned needs BOTH the failed status and the marker", () => {
    expect(isAbandoned({ status: "failed", error: abandonedError("x") })).toBe(true);
    expect(isAbandoned({ status: "failed", error: "launch failed" })).toBe(false);
    expect(isAbandoned({ status: "merged", error: abandonedError("x") })).toBe(false);
  });

  test("an abandoned row is neither a launch, a failure nor a landing", () => {
    const rows = [mix(1), mix(2, { status: "failed", error: "abandoned: oops" }), mix(3, { status: "failed", error: "real failure" })];
    const r = buildMix(rows, new Map(), null);
    expect(r.total).toBe(2);
    expect(r.abandoned).toBe(1);
    const medium = r.tiers.find((t) => t.tier === "medium")!;
    expect(medium).toMatchObject({ count: 2, landed: 1, blocked: 1 });
    expect(r.notes.join("\n")).toContain("1 abandoned dispatch(es) are excluded");
  });

  test("an abandoned dispatch is not the 'earlier' half of a re-dispatch", () => {
    const rows = [
      mix(1, { ticket_ref: "x", tier: "simple", status: "failed", error: "abandoned: wrong ticket" }),
      mix(2, { ticket_ref: "x", tier: "complex", status: "failed", error: "real failure" }),
    ];
    const r = buildMix(rows, new Map(), null);
    expect(r.tiers.find((t) => t.tier === "simple")!.count).toBe(0);
    expect(r.tiers.every((t) => t.redispatched_higher === 0)).toBe(true);
  });

  test("only abandoned rows inside --since are counted in the note", () => {
    const rows = [mix(1, { status: "failed", error: "abandoned: a", request_at: "2026-09-01T00:00:00.000Z" }), mix(2, { status: "failed", error: "abandoned: b" })];
    expect(buildMix(rows, new Map(), "2026-10-01T00:00:00.000Z").abandoned).toBe(1);
  });
});

describe("the subcommand-word guard (1697)", () => {
  test.each(["abandon", "sendback", "drain", "list", "show", "mix", "gateable", "handoff", "check"])("'%s' is refused as a ticket ref", (word) => {
    expect(() => refuseSubcommandRef(word)).toThrow(/is a spinoff subcommand, not a ticket ref/);
  });

  test("a real ticket ref passes", () => {
    expect(() => refuseSubcommandRef("1697")).not.toThrow();
    expect(() => refuseSubcommandRef("#782")).not.toThrow();
  });

  test("`ob spinoff queue <word>` queues nothing", async () => {
    const dbPath = freshDbPath();
    const r = await runCli(dbPath, ["spinoff", "queue", "abandon"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("is a spinoff subcommand");
    const db = openDb(dbPath);
    expect((db.query("SELECT count(*) AS n FROM spinoff").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe("ob spinoff abandon (CLI)", () => {
  const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
    ticketRef: "9",
    repo: "/r/omnislash",
    branch: "9",
    mode: "interactive",
    brief: "b",
    worktree: "/wt/9",
    ...over,
  });

  test("retires a queued row as failed 'abandoned:', never as landed, and mix leaves it out", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const { row: queued } = await enqueueSpinoff(db, input());
    db.close();

    const r = await runCli(dbPath, ["spinoff", "abandon", String(queued.id), "--note", "mistaken launch"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("abandoned #");
    expect(r.out).toContain("worktree kept: /wt/9");

    const after = openDb(dbPath);
    const stored = after.query("SELECT status, error FROM spinoff WHERE id = ?").get(queued.id) as { status: string; error: string };
    after.close();
    expect(stored).toEqual({ status: "failed", error: "abandoned: mistaken launch" });

    const m = JSON.parse((await runCli(dbPath, ["spinoff", "mix", "--json"])).out) as { total: number; abandoned: number };
    expect(m).toMatchObject({ total: 0, abandoned: 1 });

    const again = await runCli(dbPath, ["spinoff", "abandon", String(queued.id)]);
    expect(again.code).not.toBe(0);
    expect(again.err).toContain("already abandoned");
  });

  test("needs a row, and says 'ob spinoff abandon' is not a ticket", async () => {
    const r = await runCli(freshDbPath(), ["spinoff", "abandon"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("requires a <row-id|ticket>");
  });
});

describe("docs (1697)", () => {
  test("HELP and the README name spinoff abandon", () => {
    const README = cliDocs();
    for (const doc of [renderSubcommandHelp("spinoff", "abandon"), README]) {
      expect(doc).toContain("spinoff abandon");
      expect(doc).toContain("base_sha");
    }
  });
});

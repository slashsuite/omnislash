// OS-211: the spinoff lifecycle refuses wrong moves and allows legitimate ones. One test per (status, event)
// pair through `moveSpinoff` against the machine's edge table, then the named writers (claim, stamp, handoff,
// send-back, resume, reopen, land, the verdict record) each refusing the illegal move and making the legal one.
// A send-back, a resume and a reopen clear the recorded verdict; the send-back restore puts it back.
// No live network and no live DB: a temp sqlite database per test.
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { SPINOFF_EDGES, type SpinoffEvent, type SpinoffState } from "../../state-machine/src/spinoff.ts";
import {
  claimSpinoffRow,
  enqueueSpinoff,
  getSpinoffRow,
  landSpinoff,
  markSpinoffReady,
  markSpinoffReopened,
  markSpinoffResumed,
  markSpinoffSentBack,
  moveSpinoff,
  recordSpinoffVerdict,
  restoreSentBackRow,
  stampSpinoff,
  SpinoffTransitionRefused,
} from "../src/commands/spinoff.ts";

const STATES = Object.keys(SPINOFF_EDGES) as SpinoffState[];
const EVENTS: SpinoffEvent[] = ["claim", "stamp", "retry", "fail", "handoff", "sendback", "resume", "land", "reopen"];
const ZERO = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };

/** A fresh db with one clean-repo row of `status` (a clean repo, so `ob spinoff state` may record its verdict). */
async function seed(status: SpinoffState): Promise<{ db: Database; id: number }> {
  const db = openDb(freshDbPath(), { create: true });
  const { row } = await enqueueSpinoff(db, { ticketRef: "HC-211", repo: "/r/hackcove", branch: "hc-211", mode: "interactive", brief: "lifecycle", worktree: "/wt/does-not-exist-os211" });
  db.query("UPDATE spinoff SET status = ?, agent_id = 'hc-211' WHERE id = ?").run(status, row.id);
  return { db, id: row.id };
}

const statusOf = (db: Database, id: number): string => (db.query("SELECT status FROM spinoff WHERE id = ?").get(id) as { status: string }).status;
const verdictOf = (db: Database, id: number) =>
  db.query("SELECT verdict, verdict_reason, gate_line FROM spinoff WHERE id = ?").get(id) as { verdict: string | null; verdict_reason: string | null; gate_line: string | null };
const stored = async (db: Database, id: number) => (await getSpinoffRow(db, id))!;

/** Put a verdict on the row as `ob spinoff state` would, whatever its status, to test what a move does to it. */
function putVerdict(db: Database, id: number): void {
  db.query("UPDATE spinoff SET verdict = 'needs-human', verdict_reason = 'is the label right?', gate_line = 'green' WHERE id = ?").run(id);
}

describe("every (status, event) pair through the machine (OS-211)", () => {
  for (const from of STATES) {
    for (const event of EVENTS) {
      const to = SPINOFF_EDGES[from][event];
      test(to ? `${from} --${event}--> ${to} is allowed` : `${from} --${event}--> is refused and the row stays ${from}`, async () => {
        const { db, id } = await seed(from);
        if (to) {
          const row = await moveSpinoff(db, id, event);
          expect(row.status).toBe(to);
          expect(statusOf(db, id)).toBe(to);
        } else {
          const err = await moveSpinoff(db, id, event).catch((e) => e);
          expect(err).toBeInstanceOf(SpinoffTransitionRefused);
          expect((err as Error).message).toContain(`'${event}' is not a move from there`);
          expect(statusOf(db, id)).toBe(from);
        }
      });
    }
  }

  test("a writer's from-set narrows the machine, never widens it", async () => {
    // land is legal from building, but a writer that only lands handed-off rows refuses a building one by guard.
    const { db, id } = await seed("launched");
    const err = await moveSpinoff(db, id, "land", {}, ["ready-for-gate"]).catch((e) => e);
    expect(err).toBeInstanceOf(SpinoffTransitionRefused);
    expect((err as Error).message).toContain("does not move a row from there");
    expect(statusOf(db, id)).toBe("launched");
    // and a from-set naming a state the machine refuses from cannot make the move legal
    const { db: db2, id: id2 } = await seed("failed");
    await expect(moveSpinoff(db2, id2, "land", {}, ["failed"])).rejects.toBeInstanceOf(SpinoffTransitionRefused);
    expect(statusOf(db2, id2)).toBe("failed");
  });
});

describe("claim (OS-211)", () => {
  test("a pending row is claimed; any other row is not, and stays where it is", async () => {
    const { db, id } = await seed("pending");
    const won = await claimSpinoffRow(db, id);
    expect(won.claimed?.status).toBe("launching");
    for (const from of STATES.filter((s) => s !== "pending")) {
      const { db: d, id: i } = await seed(from);
      expect((await claimSpinoffRow(d, i)).claimed).toBeNull();
      expect(statusOf(d, i)).toBe(from);
    }
  });
});

describe("stamp (OS-211)", () => {
  test("a launching row is stamped launched; a pending, handed-off, landed or failed one is refused", async () => {
    const { db, id } = await seed("launching");
    await stampSpinoff(db, { id, outcome: "launched" });
    expect(statusOf(db, id)).toBe("launched");
    for (const from of ["pending", "ready-for-gate", "merged", "failed"] as const) {
      const { db: d, id: i } = await seed(from);
      await expect(stampSpinoff(d, { id: i, outcome: "launched" })).rejects.toBeInstanceOf(SpinoffTransitionRefused);
      expect(statusOf(d, i)).toBe(from);
    }
  });
});

describe("handoff (ready) (OS-211)", () => {
  test("a building row hands off; a queued, launching, landed or failed row is refused", async () => {
    const { db, id } = await seed("launched");
    const res = await markSpinoffReady(db, await stored(db, id));
    expect(res.row.status).toBe("ready-for-gate");
    for (const from of ["pending", "launching", "merged", "failed"] as const) {
      const { db: d, id: i } = await seed(from);
      await expect(markSpinoffReady(d, await stored(d, i))).rejects.toThrow("cannot hand off");
      expect(statusOf(d, i)).toBe(from);
    }
  });

  test("a stale copy of a building row is refused once the stored row has failed", async () => {
    const { db, id } = await seed("launched");
    const stale = await stored(db, id);
    db.query("UPDATE spinoff SET status = 'failed' WHERE id = ?").run(id);
    await expect(markSpinoffReady(db, stale)).rejects.toBeInstanceOf(SpinoffTransitionRefused);
    expect(statusOf(db, id)).toBe("failed");
  });

  test("a repeat handoff of a handed-off row is a no-op, not a second move", async () => {
    const { db, id } = await seed("ready-for-gate");
    const res = await markSpinoffReady(db, await stored(db, id));
    expect(res.already).toBe(true);
    expect(statusOf(db, id)).toBe("ready-for-gate");
  });
});

describe("send-back and its restore (OS-211)", () => {
  test("a handed-off row goes back to building with its verdict cleared", async () => {
    const { db, id } = await seed("ready-for-gate");
    putVerdict(db, id);
    const moved = await markSpinoffSentBack(db, await stored(db, id), { note: "fix the test" });
    expect(moved.status).toBe("launched");
    expect(verdictOf(db, id)).toEqual({ verdict: null, verdict_reason: null, gate_line: null });
  });

  test("a building, landed or failed row is not sent back", async () => {
    for (const from of ["launched", "merged", "failed"] as const) {
      const { db, id } = await seed(from);
      putVerdict(db, id);
      await expect(markSpinoffSentBack(db, await stored(db, id))).rejects.toThrow("cannot send back");
      expect(statusOf(db, id)).toBe(from);
      expect(verdictOf(db, id).verdict).toBe("needs-human");
    }
  });

  test("a stale handed-off copy of a row that already failed is refused and leaves its verdict", async () => {
    const { db, id } = await seed("ready-for-gate");
    putVerdict(db, id);
    const stale = await stored(db, id);
    db.query("UPDATE spinoff SET status = 'failed' WHERE id = ?").run(id);
    await expect(markSpinoffSentBack(db, stale)).rejects.toBeInstanceOf(SpinoffTransitionRefused);
    expect(statusOf(db, id)).toBe("failed");
    expect(verdictOf(db, id).verdict).toBe("needs-human");
  });

  test("the restore puts the cleared verdict back, so a needs-human row waits on the owner again", async () => {
    const { db, id } = await seed("launched");
    await recordSpinoffVerdict(db, await stored(db, id), { verdict: "needs-human", reason: "is the label right?", gate: "green" });
    await markSpinoffReady(db, await stored(db, id));
    const before = await stored(db, id);
    expect(before.phase).toBe("owner_merge_call");
    await markSpinoffSentBack(db, before, { note: "fix" });
    const res = await restoreSentBackRow(db, id, { note: "send-back undone" }, before);
    expect(res.row).toMatchObject({ status: "ready-for-gate", phase: "owner_merge_call", verdict: "needs-human", verdict_reason: "is the label right?", gate_line: "green" });
  });

  test("the restore never writes a verdict over one the builder recorded since, nor onto a row that moved on", async () => {
    const { db, id } = await seed("ready-for-gate");
    putVerdict(db, id);
    const before = await stored(db, id);
    await markSpinoffSentBack(db, before, { note: "fix" });
    db.query("UPDATE spinoff SET verdict = 'landable', verdict_reason = null, gate_line = 'green (new)' WHERE id = ?").run(id);
    await restoreSentBackRow(db, id, {}, before);
    expect(verdictOf(db, id)).toEqual({ verdict: "landable", verdict_reason: null, gate_line: "green (new)" });

    const { db: d, id: i } = await seed("ready-for-gate");
    putVerdict(d, i);
    const pre = await stored(d, i);
    await markSpinoffSentBack(d, pre, { note: "fix" });
    d.query("UPDATE spinoff SET status = 'failed' WHERE id = ?").run(i);
    await expect(restoreSentBackRow(d, i, {}, pre)).rejects.toThrow("cannot hand off");
    expect(verdictOf(d, i).verdict).toBeNull();
    expect(statusOf(d, i)).toBe("failed");
  });
});

describe("resume (OS-211)", () => {
  test("a handed-off row resumes building with its verdict cleared; any other row is refused", async () => {
    const { db, id } = await seed("ready-for-gate");
    putVerdict(db, id);
    const moved = await markSpinoffResumed(db, await stored(db, id), { note: "the rest of the ticket" });
    expect(moved.status).toBe("launched");
    expect(verdictOf(db, id).verdict).toBeNull();
    for (const from of ["launched", "merged", "failed"] as const) {
      const { db: d, id: i } = await seed(from);
      await expect(markSpinoffResumed(d, await stored(d, i), { note: "more" })).rejects.toThrow("nothing to resume");
      expect(statusOf(d, i)).toBe(from);
    }
  });
});

describe("reopen (OS-211)", () => {
  test("a landed row reopens to building with its verdict cleared", async () => {
    const { db, id } = await seed("merged");
    putVerdict(db, id);
    const moved = await markSpinoffReopened(db, await stored(db, id), { note: "nothing merged" });
    expect(moved.status).toBe("launched");
    expect(verdictOf(db, id)).toEqual({ verdict: null, verdict_reason: null, gate_line: null });
  });

  test("a row that is not landed is not reopened", async () => {
    for (const from of ["pending", "launched", "ready-for-gate", "failed"] as const) {
      const { db, id } = await seed(from);
      await expect(markSpinoffReopened(db, await stored(db, id))).rejects.toThrow("nothing to reopen");
      expect(statusOf(db, id)).toBe(from);
    }
  });
});

describe("land (OS-211)", () => {
  test("a building or handed-off row lands; a queued, launching, landed or failed row is refused", async () => {
    for (const from of ["launched", "ready-for-gate"] as const) {
      const { db, id } = await seed(from);
      await landSpinoff(db, id, ZERO);
      expect(statusOf(db, id)).toBe("merged");
    }
    for (const from of ["pending", "launching", "merged", "failed"] as const) {
      const { db, id } = await seed(from);
      await expect(landSpinoff(db, id, ZERO)).rejects.toBeInstanceOf(SpinoffTransitionRefused);
      expect(statusOf(db, id)).toBe(from);
    }
  });
});

describe("the verdict record (OS-211)", () => {
  test("a row a builder is on takes a verdict; a queued, landed or failed row is refused and unchanged", async () => {
    for (const from of ["launching", "launched", "ready-for-gate"] as const) {
      const { db, id } = await seed(from);
      const saved = await recordSpinoffVerdict(db, await stored(db, id), { verdict: "landable", gate: "green" });
      expect(saved.verdict).toBe("landable");
    }
    for (const from of ["pending", "merged", "failed"] as const) {
      const { db, id } = await seed(from);
      await expect(recordSpinoffVerdict(db, await stored(db, id), { verdict: "landable" })).rejects.toThrow();
      expect(verdictOf(db, id).verdict).toBeNull();
    }
  });

  test("a stale building copy of a row that has since failed records nothing", async () => {
    const { db, id } = await seed("launched");
    const stale = await stored(db, id);
    db.query("UPDATE spinoff SET status = 'failed' WHERE id = ?").run(id);
    await expect(recordSpinoffVerdict(db, stale, { verdict: "landable" })).rejects.toThrow("while the verdict was being recorded");
    expect(verdictOf(db, id).verdict).toBeNull();
  });
});

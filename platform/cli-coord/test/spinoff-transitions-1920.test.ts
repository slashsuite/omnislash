// OB-1920: spinoff row writers check the status they move FROM. One transition table; every writer goes
// through `moveSpinoff`, so a failed row cannot land and a landed one cannot come back.
// No live network and no live DB: a temp sqlite database, a fake git, and a temp directory as the worktree.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { spinoffReady } from "../../../apps/cli/src/api/handlers.ts";
import { ApiFault } from "../../../apps/cli/src/api/fault.ts";
import {
  __setSh,
  enqueueSpinoff,
  getSpinoffRow,
  landSpinoff,
  localSpinoffSteps,
  markSpinoffSentBack,
  restoreSentBackRow,
  SPINOFF_STATUSES,
  SPINOFF_TRANSITIONS,
  stampSpinoff,
  SpinoffTransitionRefused,
  type EnqueueInput,
} from "../src/commands/spinoff.ts";
import { abandonSpinoff, type AbandonDeps } from "../src/spinoff-abandon.ts";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

const ZERO = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: 0 };

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "1920",
  repo: "/r/acme",
  branch: "1920",
  mode: "interactive",
  brief: "transition table",
  ...over,
});

/** A fresh db with one row of `status`; returns the db and the row id. */
async function seed(status: string, worktree = "/wt/does-not-exist-1920"): Promise<{ db: Database; id: number }> {
  const db = openDb(freshDbPath(), { create: true });
  const { row } = await enqueueSpinoff(db, input({ worktree }));
  db.query("UPDATE spinoff SET status = ?, worktree = ?, agent_id = '1920' WHERE id = ?").run(status, worktree, row.id);
  return { db, id: row.id };
}

function statusOf(db: Database, id: number): string {
  return (db.query("SELECT status FROM spinoff WHERE id = ?").get(id) as { status: string }).status;
}

describe("the transition table (OB-1920)", () => {
  test("failed is terminal, merged leaves only by reopen (OB-2180), and every target is a known status", () => {
    expect(SPINOFF_TRANSITIONS.merged).toEqual(["launched"]);
    expect(SPINOFF_TRANSITIONS.failed).toEqual([]);
    for (const from of SPINOFF_STATUSES) for (const to of SPINOFF_TRANSITIONS[from]) expect(SPINOFF_STATUSES).toContain(to);
  });
});

describe("stamp checks the from-state (OB-1920)", () => {
  for (const status of ["merged", "failed"] as const) {
    for (const outcome of ["launched", "failed"] as const) {
      test(`stamp ${outcome} on a ${status} row is refused and the row is unchanged`, async () => {
        const { db, id } = await seed(status);
        const err = await stampSpinoff(db, { id, outcome, error: "x" }).catch((e) => e);
        expect(err).toBeInstanceOf(SpinoffTransitionRefused);
        const word = status === "merged" ? "landed" : "failed";
        const event = outcome === "launched" ? "stamp" : "fail";
        expect((err as Error).message).toBe(`spinoff #${id} is ${word}: '${event}' is not a move from there`);
        expect(statusOf(db, id)).toBe(status);
      });
    }
  }

  test("stamp launched on a pending row is refused: the claim always comes first", async () => {
    const { db, id } = await seed("pending");
    const err = await stampSpinoff(db, { id, outcome: "launched" }).catch((e) => e);
    expect((err as Error).message).toBe(`spinoff #${id} is queued: 'stamp' is not a move from there`);
    expect(statusOf(db, id)).toBe("pending");
  });

  test("stamp launched on a launching row still launches; the 384 session re-stamp still works", async () => {
    const { db, id } = await seed("launching");
    await stampSpinoff(db, { id, outcome: "launched" });
    expect(statusOf(db, id)).toBe("launched");
    await stampSpinoff(db, { id, outcome: "launched", session_id: "ses-1" });
    const row = await getSpinoffRow(db, id);
    // OB-1921: neither stamp counts an attempt; the claim does, and this row was seeded past it.
    expect(row).toMatchObject({ status: "launched", session_id: "ses-1", launch_attempts: 0 });
  });

  test("a refused stamp reaches the drain's step as a returned error string, not a throw", async () => {
    const { db, id } = await seed("merged");
    const err = await localSpinoffSteps(db).stamp({ id, outcome: "failed", error: "launcher blew up" });
    expect(err).toBe(`spinoff #${id} is landed: 'fail' is not a move from there`);
    expect(statusOf(db, id)).toBe("merged");
  });
});

describe("land checks the from-state (OB-1920)", () => {
  for (const [status, word] of [
    ["pending", "queued"],
    ["launching", "launching"],
    ["failed", "failed"],
  ] as const) {
    test(`land on a ${status} row is refused, naming row, status and target`, async () => {
      const { db, id } = await seed(status);
      const err = await landSpinoff(db, id, ZERO).catch((e) => e);
      expect(err).toBeInstanceOf(SpinoffTransitionRefused);
      expect((err as Error).message).toBe(`spinoff #${id} is ${word}: 'land' is not a move from there`);
      expect(statusOf(db, id)).toBe(status);
    });
  }

  test("land on a building or handed-off row still lands", async () => {
    for (const status of ["launched", "ready-for-gate"]) {
      const { db, id } = await seed(status);
      await landSpinoff(db, id, ZERO);
      expect(statusOf(db, id)).toBe("merged");
    }
  });
});

describe("send-back restore works on the stored row (OB-1920)", () => {
  test("the restore hands off what is stored after the flip, not a copy of the pre-flip row", async () => {
    const { db, id } = await seed("ready-for-gate");
    const before = (await getSpinoffRow(db, id))!;
    await markSpinoffSentBack(db, before, { note: "fix the test" });
    // Something wrote the row between the flip and the restore: the restore must carry it, not overwrite it.
    db.query("UPDATE spinoff SET model = 'opus-later' WHERE id = ?").run(id);
    const res = await restoreSentBackRow(db, id, { note: "send-back undone" });
    expect(res.row).toMatchObject({ id, status: "ready-for-gate", model: "opus-later" });
    expect(statusOf(db, id)).toBe("ready-for-gate");
  });

  test("a row that left building between the flip and the restore is not handed off again", async () => {
    const { db, id } = await seed("ready-for-gate");
    await markSpinoffSentBack(db, (await getSpinoffRow(db, id))!);
    db.query("UPDATE spinoff SET status = 'failed' WHERE id = ?").run(id);
    const err = await restoreSentBackRow(db, id).catch((e) => e);
    expect((err as Error).message).toContain(`spinoff #${id} is failed`);
    expect(statusOf(db, id)).toBe("failed");
  });
});

describe("the API handoff runs the CLI's worktree checks (OB-1920)", () => {
  function dirtyGit(): void {
    restores.push(
      __setSh((cmd) => {
        if (cmd.join(" ").includes("--porcelain")) return { ok: true, err: "", out: " M src/x.ts\n" };
        return { ok: true, err: "", out: "" };
      }),
    );
  }

  test("a dirty worktree is refused with 409 and the row stays building", async () => {
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-1920-"));
    restores.push(() => rmSync(wt, { recursive: true, force: true }));
    const { db, id } = await seed("launched", wt);
    dirtyGit();
    const err = await spinoffReady(asStore(db), { id }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiFault);
    expect((err as ApiFault).status).toBe(409);
    expect((err as Error).message).toContain("worktree is dirty");
    expect(statusOf(db, id)).toBe("launched");
  });

  test("a worktree this host does not have is not a refusal", async () => {
    const { db, id } = await seed("launched", join(tmpdir(), "ob-wt-1920-not-here"));
    dirtyGit();
    await spinoffReady(asStore(db), { id });
    expect(statusOf(db, id)).toBe("ready-for-gate");
  });
});

describe("abandon keeps every from-state it accepts (OB-1920)", () => {
  test("abandon of a pending row still succeeds through the real stamp", async () => {
    const { db, id } = await seed("pending");
    const row = (await getSpinoffRow(db, id))!;
    const deps: AbandonDeps = {
      commitsAhead: () => null,
      stopThread: async () => ({ interrupted: false, settled: true, error: null }),
      stamp: localSpinoffSteps(db).stamp,
      finishAgent: async () => ({ done: false, released: [], error: null }),
    };
    await abandonSpinoff(row, deps, { note: "queued by mistake" });
    expect(statusOf(db, id)).toBe("failed");
  });

  test("a refused abandon stamp surfaces as the abandon's refusal", async () => {
    const { db, id } = await seed("launched");
    const row = (await getSpinoffRow(db, id))!;
    db.query("UPDATE spinoff SET status = 'merged' WHERE id = ?").run(id); // landed after abandon read it
    const deps: AbandonDeps = {
      commitsAhead: () => 0,
      stopThread: async () => ({ interrupted: false, settled: true, error: null }),
      stamp: localSpinoffSteps(db).stamp,
      finishAgent: async () => ({ done: false, released: [], error: null }),
    };
    const err = await abandonSpinoff(row, deps).catch((e) => e);
    expect((err as Error).message).toContain(`the row was not retired: spinoff #${id} is landed: 'fail' is not a move from there`);
  });
});

// OS-173: `moveSpinoff` moves a row by the spinoff machine's events, through the package's `applyMove`. There is
// no table of its own left: every edge of SPINOFF_EDGES moves a row, a non-edge is refused by the machine as a
// SpinoffTransitionRefused (a TransitionRefused, 409 on the API, exit 1 on the CLI), and the handoff's trail
// entry names its event (driven through `ob spinoff handoff` in handoff-ci-2044.test.ts). Fresh SQLite file per test.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { AppError, TransitionRefused } from "../../../apps/cli/src/errors.ts";
import { SPINOFF_EDGES, type SpinoffEvent, type SpinoffState } from "../../state-machine/src/spinoff.ts";
import {
  SpinoffTransitionRefused,
  enqueueSpinoff,
  getSpinoffRow,
  moveSpinoff,
} from "../src/commands/spinoff.ts";

const paths: string[] = [];
afterEach(() => {
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});

function db(): Database {
  const p = freshDbPath();
  paths.push(p);
  return openDb(p);
}

/** A spinoff row stamped at `status`. Returns its id. */
async function rowAt(d: Database, status: SpinoffState, itemId: string | null = null): Promise<number> {
  const tag = Math.random().toString(36).slice(2, 8);
  const { row } = await enqueueSpinoff(d, {
    ticketRef: `T-${tag}`,
    repo: "/r/repo",
    branch: `b-${tag}`,
    mode: "interactive",
    brief: "x",
    launcher: "t3",
  });
  d.query("UPDATE spinoff SET status = ?, item_id = ?, agent_id = ?, worktree = ? WHERE id = ?").run(status, itemId, `b-${tag}`, `/wt/b-${tag}`, row.id);
  return row.id;
}

const statusOf = async (d: Database, id: number) => (await getSpinoffRow(d, id))?.status;

describe("OS-173 moveSpinoff moves by the machine's events", () => {
  const edges = Object.entries(SPINOFF_EDGES).flatMap(([from, byEvent]) =>
    Object.entries(byEvent).map(([event, to]) => [from as SpinoffState, event as SpinoffEvent, to as SpinoffState] as const),
  );

  for (const [from, event, to] of edges) {
    test(`${from} --${event}--> ${to}`, async () => {
      const d = db();
      const id = await rowAt(d, from);
      const row = await moveSpinoff(d, id, event);
      expect(row.status).toBe(to);
      expect(await statusOf(d, id)).toBe(to);
    });
  }

  test("a non-edge is refused by the machine, as a TransitionRefused, and the row does not move", async () => {
    const d = db();
    const id = await rowAt(d, "failed");
    const err = await moveSpinoff(d, id, "reopen").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpinoffTransitionRefused);
    expect(err).toBeInstanceOf(TransitionRefused);
    expect(err).toBeInstanceOf(AppError);
    const e = err as SpinoffTransitionRefused;
    expect(e.message).toBe(`spinoff #${id} is failed: 'reopen' is not a move from there`);
    expect({ machine: e.machine, from: e.from, event: e.event, why: e.why }).toEqual({ machine: "spinoff", from: "failed", event: "reopen", why: "machine" });
    expect(await statusOf(d, id)).toBe("failed");
  });

  test("a caller's narrower from-set refuses an edge the machine has, as a guard", async () => {
    const d = db();
    const id = await rowAt(d, "launched");
    const err = (await moveSpinoff(d, id, "stamp", {}, ["launching"]).catch((e: unknown) => e)) as SpinoffTransitionRefused;
    expect(err).toBeInstanceOf(SpinoffTransitionRefused);
    expect(err.why).toBe("guard");
    expect(err.message).toBe(`spinoff #${id} is building: this 'stamp' does not move a row from there`);
    expect(await statusOf(d, id)).toBe("launched");
  });

  test("a missing row is refused by name", async () => {
    const d = db();
    await expect(moveSpinoff(d, 999, "claim")).rejects.toThrow("no spinoff #999");
  });
});

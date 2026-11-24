// OS-169: `moveSpinoff` reads the row's stored status once and asks the spinoff machine beside today's guarded
// UPDATE, logging one `machine_would_refuse` event when the two disagree, without changing the move. Also:
// SpinoffTransitionRefused is a TransitionRefused naming the edge. Fresh SQLite file per test.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { AppError, TransitionRefused } from "../../../apps/cli/src/errors.ts";
import { eventsBetweenFor, parsePayload } from "../../../apps/cli/src/events.ts";
import { MACHINE_SHADOW_SOURCE, MACHINE_WOULD_REFUSE, machineShadowSeam } from "../../../apps/cli/src/machine-shadow.ts";
import { enqueueSpinoff, getSpinoffRow, moveSpinoff, SpinoffTransitionRefused } from "../src/commands/spinoff.ts";

const paths: string[] = [];
const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});

function db(): Database {
  const p = freshDbPath();
  paths.push(p);
  return openDb(p);
}

/** A spinoff row stamped at `status`. Returns its id. */
async function rowAt(d: Database, status: string): Promise<number> {
  const { row } = await enqueueSpinoff(d, {
    ticketRef: `T-${Math.random().toString(36).slice(2, 8)}`,
    repo: "/r/repo",
    branch: `b-${Math.random().toString(36).slice(2, 8)}`,
    mode: "interactive",
    brief: "x",
    launcher: "t3",
  });
  d.query("UPDATE spinoff SET status = ? WHERE id = ?").run(status, row.id);
  return row.id;
}

function machineSays(answer: "refuse" | "allow" | "throw"): void {
  restores.push(
    machineShadowSeam.set({
      ...machineShadowSeam.get(),
      decide: (machine, from, event) => {
        if (answer === "throw") throw new Error("decide blew up");
        return answer === "refuse"
          ? { ok: false, why: "machine", from, event, message: `stub: ${machine.id} refuses ${event}` }
          : { ok: true, to: "launched" };
      },
    }),
  );
}

async function shadowEvents(d: Database) {
  const rows = await eventsBetweenFor(d, { source: MACHINE_SHADOW_SOURCE, type: MACHINE_WOULD_REFUSE });
  return rows.map((r) => ({ itemId: r.item_id, actor: r.actor, payload: parsePayload<Record<string, unknown>>(r) }));
}

async function statusOf(d: Database, id: number): Promise<string | undefined> {
  return (await getSpinoffRow(d, id))?.status;
}

describe("OS-169 shadow check: moveSpinoff", () => {
  test("a move both sides allow writes no event", async () => {
    const d = db();
    const id = await rowAt(d, "pending");
    await moveSpinoff(d, id, "launching");
    expect(await statusOf(d, id)).toBe("launching");
    expect(await shadowEvents(d)).toEqual([]);
  });

  test("a move today allows and the machine refuses writes one event and still happens", async () => {
    const d = db();
    const id = await rowAt(d, "pending");
    machineSays("refuse");
    await moveSpinoff(d, id, "launching");
    expect(await statusOf(d, id)).toBe("launching");
    expect(await shadowEvents(d)).toEqual([
      {
        itemId: null,
        actor: null,
        payload: {
          machine: "spinoff",
          id: String(id),
          rowId: id,
          from: "pending",
          event: "claim",
          to: "launching",
          why: "machine",
          today: "allowed",
          message: "stub: spinoff refuses claim",
        },
      },
    ]);
  });

  test("a move today refuses still fails with today's error and message, and the agreeing machine logs nothing", async () => {
    const d = db();
    const id = await rowAt(d, "failed");
    const err = await moveSpinoff(d, id, "launched").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpinoffTransitionRefused);
    expect((err as Error).message).toBe(`spinoff #${id} is failed; it cannot move to building`);
    expect(await statusOf(d, id)).toBe("failed");
    expect(await shadowEvents(d)).toEqual([]);
  });

  test("a writer's narrower from-set refuses an edge the machine has: one event, today's refusal stands", async () => {
    const d = db();
    const id = await rowAt(d, "ready-for-gate");
    // ready-for-gate → launched is the send-back edge, but this writer only moves rows from launching.
    const err = await moveSpinoff(d, id, "launched", {}, ["launching"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpinoffTransitionRefused);
    expect(await statusOf(d, id)).toBe("ready-for-gate");
    const events = await shadowEvents(d);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      machine: "spinoff",
      from: "ready-for-gate",
      event: "sendback",
      to: "launched",
      why: null,
      today: "refused",
      message: (err as Error).message,
    });
  });

  test("the launched self-move is checked: it is the stamp edge", async () => {
    const d = db();
    const id = await rowAt(d, "launched");
    machineSays("refuse");
    await moveSpinoff(d, id, "launched");
    const events = await shadowEvents(d);
    expect(events.map((e) => e.payload.event)).toEqual(["stamp"]);
  });

  test("a move with no edge names `to:<to>`", async () => {
    const d = db();
    const id = await rowAt(d, "pending");
    machineSays("allow");
    await expect(moveSpinoff(d, id, "merged")).rejects.toThrow(SpinoffTransitionRefused);
    expect((await shadowEvents(d))[0]!.payload.event).toBe("to:merged");
  });

  test("a missing row is not checked and still refused by name", async () => {
    const d = db();
    machineSays("refuse");
    await expect(moveSpinoff(d, 999, "launching")).rejects.toThrow("no spinoff #999");
    expect(await shadowEvents(d)).toEqual([]);
  });

  test("a throwing decide or event write does not change the move", async () => {
    for (const broken of ["decide", "record"] as const) {
      const d = db();
      const ok = await rowAt(d, "pending");
      const no = await rowAt(d, "failed");
      if (broken === "decide") machineSays("throw");
      else
        restores.push(
          machineShadowSeam.set({
            decide: (_m, from, event) => ({ ok: false, why: "machine", from, event, message: "x" }),
            record: async () => {
              throw new Error("event table is gone");
            },
          }),
        );
      await moveSpinoff(d, ok, "launching");
      expect(await statusOf(d, ok)).toBe("launching");
      await expect(moveSpinoff(d, no, "launched")).rejects.toThrow(`spinoff #${no} is failed; it cannot move to building`);
      restores.pop()!();
      expect(await shadowEvents(d)).toEqual([]);
    }
  });
});

describe("OS-169 SpinoffTransitionRefused", () => {
  test("is a TransitionRefused and an AppError, naming the machine's edge", () => {
    const e = new SpinoffTransitionRefused(7, "ready-for-gate", "launched");
    expect(e).toBeInstanceOf(TransitionRefused);
    expect(e).toBeInstanceOf(AppError);
    expect(e.name).toBe("SpinoffTransitionRefused");
    expect({ machine: e.machine, id: e.id, from: e.from, event: e.event, why: e.why }).toEqual({
      machine: "spinoff",
      id: "7",
      from: "ready-for-gate",
      event: "sendback",
      why: "machine",
    });
  });

  test("a missing row reads from `none`, and a move with no edge `to:<to>`", () => {
    const missing = new SpinoffTransitionRefused(9, null, "launching");
    expect([missing.from, missing.event, missing.message]).toEqual(["none", "to:launching", "no spinoff #9"]);
    expect(new SpinoffTransitionRefused(9, "failed", "merged").event).toBe("to:merged");
  });
});

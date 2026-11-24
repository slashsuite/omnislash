// OS-169: every item status move asks the lifecycle machine beside today's check and logs one
// `machine_would_refuse` event when the two disagree, without changing the move. Pinned per function
// (transitionTo, reopenItem, blockItem, unblockItem, moveItem): an agreed move writes no event; a move today
// allows and the machine refuses writes one event and still happens; a move today refuses still fails with
// today's message. A throwing decide or event write changes nothing (pinned on transitionTo). Fresh SQLite file per test.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { eventsBetweenFor, parsePayload } from "../../../apps/cli/src/events.ts";
import { blockItem, moveItem, reopenItem, transitionTo, unblockItem } from "../../../apps/cli/src/workflow.ts";
import { MACHINE_SHADOW_SOURCE, MACHINE_WOULD_REFUSE, machineShadowSeam } from "../../../apps/cli/src/machine-shadow.ts";
import { decide } from "../../state-machine/src/decide.ts";
import { buildItemBrief } from "../../../apps/cli/src/commands/brief.ts";

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

type Decide = typeof decide;
/** Stub the machine's answer, keeping the real event writer. */
function machineSays(answer: "refuse" | "allow" | "throw"): void {
  const stub: Decide = (machine, from, event) => {
    if (answer === "throw") throw new Error("decide blew up");
    return answer === "refuse"
      ? { ok: false, why: "machine", from, event, message: `stub: ${machine.id} refuses ${event}` }
      : { ok: true, to: event.replace(/^to:/, "") };
  };
  restores.push(machineShadowSeam.set({ ...machineShadowSeam.get(), decide: stub }));
}

async function shadowEvents(d: Database) {
  const rows = await eventsBetweenFor(d, { source: MACHINE_SHADOW_SOURCE, type: MACHINE_WOULD_REFUSE });
  return rows.map((r) => ({ itemId: r.item_id, actor: r.actor, payload: parsePayload<Record<string, unknown>>(r) }));
}

async function itemAt(d: Database, status: string): Promise<string> {
  return createItem(d, { type: "task", title: `at ${status}`, status });
}

/**
 * Each function: a move both sides allow, a move today refuses (and the machine too), and the
 * function call itself. `blockedFrom` items are put in `blocked` through the real block first.
 */
interface Case {
  name: string;
  /** The status the item starts in for an allowed move, and the call that moves it. */
  allowed: { at: string; run: (d: Database, id: string) => Promise<unknown>; to: string };
  /** A move today refuses, with today's message. */
  refused: { at: string; run: (d: Database, id: string) => Promise<unknown>; to: string; message: (id: string) => string };
}

async function blockedItem(d: Database): Promise<string> {
  const id = await itemAt(d, "in_progress");
  await blockItem(d, id, "waiting", null);
  return id;
}

const CASES: Case[] = [
  {
    name: "transitionTo",
    allowed: { at: "open", to: "in_progress", run: (d, id) => transitionTo(d, id, "in_progress", { actor: "builder-1" }) },
    refused: {
      at: "open",
      to: "merged",
      run: (d, id) => transitionTo(d, id, "merged"),
      message: () => "cannot transition from 'open' to 'merged'",
    },
  },
  {
    name: "reopenItem",
    allowed: { at: "done", to: "open", run: (d, id) => reopenItem(d, id, { actor: "builder-1" }) },
    refused: { at: "in_progress", to: "open", run: (d, id) => reopenItem(d, id), message: (id) => `item '${id}' is not closed` },
  },
  {
    name: "blockItem",
    allowed: { at: "open", to: "blocked", run: (d, id) => blockItem(d, id, "waiting", null, { actor: "builder-1" }) },
    refused: {
      at: "done",
      to: "blocked",
      run: (d, id) => blockItem(d, id, "waiting", null),
      message: () => "cannot transition from 'done' to 'blocked'",
    },
  },
  {
    name: "unblockItem",
    allowed: { at: "blocked", to: "in_progress", run: (d, id) => unblockItem(d, id, { actor: "builder-1" }) },
    refused: {
      at: "blocked",
      to: "merged",
      run: (d, id) => unblockItem(d, id, {}, { to: "merged" }),
      message: () => "cannot transition from 'blocked' to 'merged'",
    },
  },
  {
    name: "moveItem",
    allowed: { at: "open", to: "ready", run: (d, id) => moveItem(d, id, "ready", { decision: { actor: "builder-1" } }) },
    refused: {
      at: "open",
      to: "merged",
      run: (d, id) => moveItem(d, id, "merged"),
      message: () => "cannot transition from 'open' to 'merged'",
    },
  },
];

async function seed(d: Database, at: string): Promise<string> {
  return at === "blocked" ? blockedItem(d) : itemAt(d, at);
}

for (const c of CASES) {
  describe(`OS-169 shadow check: ${c.name}`, () => {
    test("a move both sides allow writes no event", async () => {
      const d = db();
      const id = await seed(d, c.allowed.at);
      await c.allowed.run(d, id);
      expect((await getItem(d, id))?.status).toBe(c.allowed.to);
      expect(await shadowEvents(d)).toEqual([]);
    });

    test("a move today allows and the machine refuses writes one event and still happens", async () => {
      const d = db();
      const id = await seed(d, c.allowed.at);
      machineSays("refuse");
      await c.allowed.run(d, id);
      expect((await getItem(d, id))?.status).toBe(c.allowed.to);
      const events = await shadowEvents(d);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        itemId: id,
        actor: "builder-1",
        payload: {
          machine: "task",
          id,
          from: c.allowed.at,
          event: `to:${c.allowed.to}`,
          to: c.allowed.to,
          why: "machine",
          today: "allowed",
          message: `stub: task refuses to:${c.allowed.to}`,
        },
      });
    });

    test("a move today refuses still fails with today's message, and writes an event only where the real machine disagrees", async () => {
      const d = db();
      const id = await seed(d, c.refused.at);
      await expect(c.refused.run(d, id)).rejects.toThrow(c.refused.message(id));
      expect((await getItem(d, id))?.status).toBe(c.refused.at);
      // reopenItem's "not closed" is narrower than the table (in_progress → open is an edge), so the real machine disagrees.
      const expected = c.name === "reopenItem" ? 1 : 0;
      expect(await shadowEvents(d)).toHaveLength(expected);
    });

    test("a move today refuses and the machine allows writes one event and still fails the same way", async () => {
      const d = db();
      const id = await seed(d, c.refused.at);
      machineSays("allow");
      await expect(c.refused.run(d, id)).rejects.toThrow(c.refused.message(id));
      expect((await getItem(d, id))?.status).toBe(c.refused.at);
      const events = await shadowEvents(d);
      expect(events).toHaveLength(1);
      expect(events[0]!.payload).toMatchObject({
        machine: "task",
        id,
        from: c.refused.at,
        event: `to:${c.refused.to}`,
        to: c.refused.to,
        why: null,
        today: "refused",
        message: c.refused.message(id),
      });
      expect(events[0]!.actor).toBeNull();
    });

    // One function is enough to pin the never-throws contract: every door runs the same `shadowMove`.
    if (c.name === "transitionTo") test("a throwing decide or event write does not change the move", async () => {
      for (const broken of ["decide", "record"] as const) {
        const d = db();
        const ok = await seed(d, c.allowed.at);
        const no = await seed(d, c.refused.at);
        const restore =
          broken === "decide"
            ? (machineSays("throw"), restores.pop()!)
            : machineShadowSeam.set({
                decide: () => ({ ok: false, why: "machine", from: "x", event: "x", message: "x" }),
                record: async () => {
                  throw new Error("event table is gone");
                },
              });
        try {
          await c.allowed.run(d, ok);
          expect((await getItem(d, ok))?.status).toBe(c.allowed.to);
          await expect(c.refused.run(d, no)).rejects.toThrow(c.refused.message(no));
          expect((await getItem(d, no))?.status).toBe(c.refused.at);
        } finally {
          restore();
        }
        expect(await shadowEvents(d)).toEqual([]);
      }
    });
  });
}

describe("OS-169 shadow check: what is not checked", () => {
  test("a self-move is a no-op today and is not checked", async () => {
    const d = db();
    const id = await itemAt(d, "done");
    machineSays("refuse");
    await transitionTo(d, id, "done");
    expect(await shadowEvents(d)).toEqual([]);
  });

  test("the item brief leaves the shadow's events out", async () => {
    const d = db();
    const id = await itemAt(d, "open");
    machineSays("refuse");
    await transitionTo(d, id, "in_progress");
    expect(await shadowEvents(d)).toHaveLength(1);
    const brief = await buildItemBrief(d, (await getItem(d, id))!);
    expect(brief.events.filter((e) => e.source === MACHINE_SHADOW_SOURCE)).toEqual([]);
  });
});

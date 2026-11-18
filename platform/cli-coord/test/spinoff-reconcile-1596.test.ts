// 1596 — reconcile left a landed row at `handed-off`.
//
// Row 713 (hackcove, ticket 1591): the builder handed off, the architect squash-merged the branch onto main
// (so the branch is NOT an ancestor of main, and `isMerged` is false) and closed the ticket. The close ran
// before `ob close` marked its own rows landed (1589), so nothing retired the row, and `ob spinoff
// reconcile` skipped it: a handed-off row was only ever landed by the branch-merged signal, because the
// 932 rule said its tab must not close "while its agent row is live". That reason died with the handoff
// (471/1513): the handoff is the human's yes, and `ob close` IS the land decision. A done ticket therefore
// lands a handed-off row, the same way it lands a building one.
//
// Row 640 (ticket 1417, still open) is the other half: an open ticket must leave its handed-off row alone,
// and so must a commit that merely NAMES the ticket (that signal stays building-rows-only).
import { describe, expect, test } from "bun:test";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { listAgents, registerAgent } from "../src/agent.ts";
import {
  enqueueSpinoff,
  listSpinoffs,
  localSpinoffSteps,
  reconcileSpinoffs,
  READY_FOR_GATE,
} from "../src/commands/spinoff.ts";

/** A handed-off row with a live agent, as `ob spinoff handoff` leaves it. */
async function seedHandedOff(db: ReturnType<typeof freshDb>, ticket: string): Promise<number> {
  const { row } = await enqueueSpinoff(db, {
    ticketRef: ticket,
    repo: "/r/hackcove",
    branch: ticket,
    mode: "interactive",
    brief: "a theme",
  });
  db.query("UPDATE spinoff SET status = ?, agent_id = ?, base_sha = 'base0' WHERE id = ?").run(READY_FOR_GATE, ticket, row.id);
  await registerAgent(db, { id: ticket, ticket, branch: ticket, status: "readying", ttlS: 900 });
  return row.id;
}

/** Every git signal OFF: the branch was squashed, so it is not merged and has no commits main lacks. */
const reconcile = (db: ReturnType<typeof freshDb>, commits: Array<{ sha: string; subject: string; body: string }> = []) =>
  reconcileSpinoffs(db, () => false, undefined, () => 0, "", localSpinoffSteps(db), () => commits);

describe("reconcile lands a handed-off row once its ticket is done (1596)", () => {
  test("713's shape: handed-off, squash on main, ticket closed → landed, agent freed", async () => {
    const db = freshDb();
    const done = await createItem(db, { type: "task", title: "acme-shop-paper", status: "done" });
    await seedHandedOff(db, done);
    const rec = await reconcile(db);
    // The row carries the item's ref (1949): enqueue renames a numbered ticket to it.
    expect(rec.merged).toEqual(["OB-1"]);
    expect((await listSpinoffs(db, "merged")).map((r) => r.ticket_ref)).toEqual(["OB-1"]);
    expect(await listSpinoffs(db, READY_FOR_GATE)).toEqual([]);
    expect((await listAgents(db)).map((a) => a.id)).not.toContain(done);
  });

  test("640's shape: handed-off, ticket still open → left alone", async () => {
    const db = freshDb();
    const open = await createItem(db, { type: "task", title: "acme-shop", status: "open" });
    await seedHandedOff(db, open);
    const rec = await reconcile(db);
    expect(rec.merged).toEqual([]);
    expect((await listSpinoffs(db, READY_FOR_GATE)).map((r) => r.ticket_ref)).toEqual(["OB-1"]);
  });

  test("a landing commit naming an OPEN ticket still does not retire a handed-off row", async () => {
    const db = freshDb();
    const open = await createItem(db, { type: "task", title: "squashed, not closed yet", status: "open" });
    await seedHandedOff(db, open);
    const rec = await reconcile(db, [{ sha: "abc", subject: `feat(ob ${open}): the build`, body: "" }]);
    expect(rec.merged).toEqual([]);
    expect((await listSpinoffs(db, READY_FOR_GATE)).map((r) => r.ticket_ref)).toEqual(["OB-1"]);
  });
});

// OB-1695 — a drain launched a builder on a stale row (OB-1623 row 1017) whose ticket was already done and
// whose commit was already on main. A pending row for finished work is left queued, with the way out named.
import { describe, expect, test } from "bun:test";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { createItem, setStatus } from "../../../apps/cli/src/items.ts";
import type { Commit } from "../../../apps/cli/src/tracker-link.ts";
import {
  alreadyLandedReason,
  enqueueSpinoff,
  launchQueuedRow,
  localSpinoffSteps,
  type EnqueueInput,
} from "../src/commands/spinoff.ts";

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "1623",
  repo: "/r/acme",
  branch: "1623",
  mode: "interactive",
  brief: "b",
  ...over,
});

const LAND: Commit = { sha: "50b5043e", subject: "fix(ob 1623): the thing", body: "" };
const BASE: Commit = { sha: "base1623", subject: "chore: base", body: "" };

describe("a pending row for finished work does not launch (OB-1695)", () => {
  test("a done ticket: not ready, row stays pending, nothing claimed", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "t" });
    await setStatus(db, id, "open", "done");
    const { row } = await enqueueSpinoff(db, input({ ticketRef: id, branch: "x" }));
    const r = await launchQueuedRow(db, row, "", localSpinoffSteps(db), () => []);
    expect(r.kind).toBe("not-ready");
    if (r.kind === "not-ready") expect(r.reason).toContain(`ob spinoff abandon ${row.id}`);
    const after = db.query("SELECT status FROM spinoff WHERE id = ?").get(row.id) as { status: string };
    expect(after.status).toBe("pending");
  });

  test("a landing commit after the row's base: reported as landed", async () => {
    const db = freshDb();
    const { row } = await enqueueSpinoff(db, input());
    db.query("UPDATE spinoff SET base_sha = ? WHERE id = ?").run(BASE.sha, row.id);
    const withBase = { ...row, base_sha: BASE.sha };
    expect(await alreadyLandedReason(db, withBase, () => [LAND, BASE])).toContain("already landed");
  });

  test("a landing commit older than the base does not block a re-dispatch", async () => {
    const db = freshDb();
    const { row } = await enqueueSpinoff(db, input());
    expect(await alreadyLandedReason(db, { ...row, base_sha: BASE.sha }, () => [BASE, LAND])).toBeNull();
  });

  test("a never-launched row (no base_sha) is not blocked by an old landing commit", async () => {
    const db = freshDb();
    const { row } = await enqueueSpinoff(db, input());
    expect(await alreadyLandedReason(db, { ...row, base_sha: null }, () => [LAND])).toBeNull();
  });
});

// wayfinder 1949: a spinoff is named by its item's `<KEY>-<seq>` ref, however the ticket was typed.
//
// The row's ticket_ref, its default branch (and so its worktree and builder id) all follow the ref, so
// `ob spinoff 1925`, `ob spinoff ps-4` and `ob spinoff PS-4` land on ONE row named `PS-4` / branch `ps-4`.
// Rows queued before 1949 keep their bare `1925` and must still be found by either spelling.
// In-process against a fresh SQLite database: no network, no server, no T3.
import { describe, expect, test } from "bun:test";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { createItem, editItem } from "../../../apps/cli/src/items.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { enqueueSpinoff, findSpinoffForReady, listSpinoffs, pickSpinoffForShow, ticketRefIs } from "../src/commands/spinoff.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { eq } from "drizzle-orm";
import { dispatchRefFor } from "../src/spinoff-item.ts";

async function tracker() {
  const db = freshDb();
  await registerProject(db, { name: "pixelslash", kind: "side" });
  await registerProject(db, { name: "hackcove", kind: "side" });
  await registerProject(db, { name: "scratch", kind: "home" }); // no agreed key
  const ps = await createItem(db, { type: "task", title: "keyed", projectId: "pixelslash" });
  const loose = await createItem(db, { type: "task", title: "unkeyed", projectId: "scratch" });
  return { db, ps, loose };
}

describe("dispatchRefFor (1949)", () => {
  test("a bare id, a lowercase ref and a move's alias all dispatch as the item's current ref", async () => {
    const { db, ps } = await tracker();
    expect(await dispatchRefFor(db, ps)).toBe("PS-1");
    expect(await dispatchRefFor(db, "ps-1")).toBe("PS-1");
    await editItem(db, ps, { projectId: "hackcove" });
    expect(await dispatchRefFor(db, "ps-1")).toBe("HC-1");
  });

  test("an item with no ref, an unknown ref and a GitHub issue ref keep what was typed", async () => {
    const { db, loose } = await tracker();
    expect(await dispatchRefFor(db, loose)).toBe(loose);
    expect(await dispatchRefFor(db, "ZZ-9")).toBe("ZZ-9");
    expect(await dispatchRefFor(db, "#75")).toBe("#75");
  });
});

describe("ticketRefIs (1949)", () => {
  test("accepts the old bare and #-shapes and the ref case-insensitively", () => {
    expect(ticketRefIs("1925", "1925")).toBe(true);
    expect(ticketRefIs("#75", "75")).toBe(true);
    expect(ticketRefIs("PS-4", "ps-4")).toBe(true);
    expect(ticketRefIs("PS-4", "PS-04")).toBe(true);
    expect(ticketRefIs("PS-4", "4")).toBe(false);
    expect(ticketRefIs("PS-4", "HC-4")).toBe(false);
  });
});

describe("enqueueSpinoff naming (1949)", () => {
  test("a dispatch by bare id is recorded as the ref, with the default branch following it", async () => {
    const { db, ps } = await tracker();
    const first = await enqueueSpinoff(db, { ticketRef: ps, repo: "/r/pixelslash", branch: ps, mode: "interactive", brief: "x" });
    expect(first.row.ticket_ref).toBe("PS-1");
    expect(first.row.branch).toBe("ps-1");
    expect(first.row.worktree).toBe("/r/pixelslash.ps-1");
    expect(first.row.item_id).toBe(ps);
    // the same item typed as a ref dedupes onto the same row
    const again = await enqueueSpinoff(db, { ticketRef: "ps-1", repo: "/r/pixelslash", branch: "ps-1", mode: "interactive", brief: "x" });
    expect(again.deduped).toBe(true);
    expect(again.row.id).toBe(first.row.id);
  });

  test("an explicit branch is kept; an unkeyed item keeps its bare name", async () => {
    const { db, ps, loose } = await tracker();
    const named = await enqueueSpinoff(db, { ticketRef: ps, repo: "/r/p", branch: "feature/x", mode: "interactive", brief: "x" });
    expect([named.row.ticket_ref, named.row.branch]).toEqual(["PS-1", "feature/x"]);
    const bare = await enqueueSpinoff(db, { ticketRef: loose, repo: "/r/p", branch: loose, mode: "interactive", brief: "x" });
    expect([bare.row.ticket_ref, bare.row.branch]).toEqual([loose, loose]);
  });
});

describe("a row parked under its bare id (1949)", () => {
  test("the item's ref dedupes onto it, and show and handoff find it by either spelling", async () => {
    const { db, ps } = await tracker();
    const parked = await enqueueSpinoff(db, { ticketRef: ps, repo: "/r/p", branch: ps, mode: "interactive", brief: "x" });
    // what a pre-1949 row looks like: ticket_ref and branch are the bare id
    const s = asStore(db);
    await s.q.update(s.t.spinoff).set({ ticket_ref: ps, branch: ps }).where(eq(s.t.spinoff.id, parked.row.id));
    const again = await enqueueSpinoff(db, { ticketRef: "PS-1", repo: "/r/p", branch: "ps-1", mode: "interactive", brief: "x" });
    expect([again.deduped, again.row.id]).toEqual([true, parked.row.id]);
    expect(pickSpinoffForShow(await listSpinoffs(db), "PS-1", ps).id).toBe(parked.row.id);
    expect(pickSpinoffForShow(await listSpinoffs(db), ps).id).toBe(parked.row.id);
    await s.q.update(s.t.spinoff).set({ status: "launched" }).where(eq(s.t.spinoff.id, parked.row.id));
    expect((await findSpinoffForReady(db, { ref: "ps-1" })).id).toBe(parked.row.id);
  });
});

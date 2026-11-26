// OS-27: buildTimeline, the Timeline page's pure fold of a project's items and its ranged trail into tiles, the
// weekly table and a page of the feed. The e2e (e2e/timeline.spec.ts) drives the same on a seeded store.
import { describe, expect, test } from "bun:test";
import { PRIORITY_CHANGE_TYPE as RECORDED } from "../../cli/src/decisions.ts";
import { buildTimeline, placeDecisions, PRIORITY_CHANGE_TYPE, type TimelineEvent, type TimelineItem } from "../src/lib/timeline.ts";

/** The `from` of a spinoff row's first transition (U+2014). */
const NONE = String.fromCharCode(0x2014);

const item = (over: Partial<TimelineItem> & { id: string }): TimelineItem => ({
  ref: over.id.toUpperCase(),
  title: `title ${over.id}`,
  type: "task",
  status: "open",
  created_at: "2026-11-01T00:00:00.000Z",
  closed_at: null,
  block_reason: null,
  ...over,
});

let seq = 0;
const ev = (item_id: string, ts: string, payload: Record<string, unknown>, type = "transition"): TimelineEvent => ({
  id: ++seq,
  ts,
  type,
  item_id,
  actor: "human",
  payload: JSON.stringify(payload),
});

const RANGE = { from: "2026-11-16", to: "2026-11-29", builds: false };

describe("buildTimeline (OS-27)", () => {
  test("reads priority changes under the type decisions.ts records them as", () => {
    expect(PRIORITY_CHANGE_TYPE).toBe(RECORDED);
  });

  test("a close from blocked is one Closed line that carries the spell", () => {
    const items = [item({ id: "a", created_at: "2026-11-16T09:00:00.000Z", status: "done", closed_at: "2026-11-20T12:00:00.000Z" })];
    const events = [
      ev("a", "2026-11-17T12:00:00.000Z", { from: "open", to: "blocked", note: "waits on Jacobus" }),
      ev("a", "2026-11-20T12:00:00.000Z", { from: "blocked", to: "done" }),
    ];
    const v = buildTimeline(items, events, RANGE);
    expect(v.feed.map((e) => e.kind)).toEqual(["closed", "blocked", "opened"]);
    expect(v.feed[0]!.detail).toBe("done after 4.1 d · after 3.0 d blocked");
    expect(v.feed[1]!.detail).toBe("waits on Jacobus");
  });

  test("a close that was later reopened keeps its own Closed line", () => {
    const items = [item({ id: "a", status: "done", closed_at: "2026-11-20T00:00:00.000Z" })];
    const events = [
      ev("a", "2026-11-17T00:00:00.000Z", { from: "open", to: "done" }),
      ev("a", "2026-11-18T00:00:00.000Z", { from: "done", to: "open" }),
      ev("a", "2026-11-20T00:00:00.000Z", { from: "open", to: "done" }),
    ];
    const v = buildTimeline(items, events, RANGE);
    expect(v.feed.map((e) => [e.kind, e.at.slice(0, 10)])).toEqual([
      ["closed", "2026-11-20"],
      ["status", "2026-11-18"],
      ["closed", "2026-11-17"],
    ]);
    expect(v.feed[2]!.detail).toBe("open → done");
    const reopened = buildTimeline([item({ id: "a" })], events.slice(0, 2), RANGE);
    expect(reopened.feed.map((e) => e.kind)).toEqual(["status", "closed"]);
  });

  test("an unblock that is not a close stays an Unblocked line", () => {
    const items = [item({ id: "a" })];
    const events = [
      ev("a", "2026-11-17T12:00:00.000Z", { from: "open", to: "blocked" }),
      ev("a", "2026-11-17T18:00:00.000Z", { from: "blocked", to: "open" }),
    ];
    const v = buildTimeline(items, events, RANGE);
    expect(v.feed[0]).toMatchObject({ kind: "unblocked", detail: "blocked → open after 6 h blocked" });
  });

  test("a spinoff row's steps fold into one Build line, shown only with builds; a landed row with a PR gets a Merged line", () => {
    const items = [item({ id: "a" }), item({ id: "b" })];
    const events = [
      ev("a", "2026-11-18T10:00:00.000Z", { from: NONE, to: "queued", spinoff_row: 7 }),
      ev("a", "2026-11-18T10:30:00.000Z", { from: "queued", to: "building", spinoff_row: 7 }),
      ev("a", "2026-11-18T13:00:00.000Z", { from: "building", to: "handed-off", spinoff_row: 7 }),
      ev("a", "2026-11-18T14:00:00.000Z", { from: "handed-off", to: "landed", spinoff_row: 7, pr_url: "https://github.com/o/r/pull/12" }),
      ev("b", "2026-11-19T10:00:00.000Z", { from: NONE, to: "queued", spinoff_row: 8 }),
      ev("b", "2026-11-19T11:00:00.000Z", { from: "queued", to: "building", spinoff_row: 8 }),
      // A row's note, not a step: it neither ends the row's line nor shows as a status move.
      ev("b", "2026-11-19T11:30:00.000Z", { from: "usage", to: "over-usage", spinoff_row: 8 }),
    ];
    const off = buildTimeline(items, events, RANGE);
    expect(off.feed.map((e) => [e.kind, e.detail])).toEqual([["merge", "merged, PR #12"]]);
    expect(off.feed[0]!.href).toBe("https://github.com/o/r/pull/12");

    const on = buildTimeline(items, events, { ...RANGE, builds: true });
    expect(on.feed.map((e) => [e.kind, e.at, e.detail])).toEqual([
      ["build", "2026-11-19T11:00:00.000Z", "row 8, building"],
      ["build", "2026-11-18T14:00:00.000Z", "built, row 7, 4 h"],
      ["merge", "2026-11-18T14:00:00.000Z", "merged, PR #12"],
    ]);
  });

  test("a row reopened from landed is building again, with no Merged line until it lands again", () => {
    const events = [
      ev("a", "2026-11-18T10:00:00.000Z", { from: "building", to: "landed", spinoff_row: 1, pr_url: "https://github.com/o/r/pull/29" }),
      ev("a", "2026-11-18T12:00:00.000Z", { from: "landed", to: "building", spinoff_row: 1 }),
    ];
    const reopened = buildTimeline([item({ id: "a" })], events, { ...RANGE, builds: true });
    expect(reopened.feed.map((e) => e.detail)).toEqual(["row 1, building"]);
    const relanded = [...events, ev("a", "2026-11-18T15:00:00.000Z", { from: "building", to: "landed", spinoff_row: 1, pr_url: "https://github.com/o/r/pull/30" })];
    expect(buildTimeline([item({ id: "a" })], relanded, { ...RANGE, builds: true }).feed.map((e) => e.detail)).toEqual(["built, row 1, 5 h", "merged, PR #30"]);
  });

  test("a re-close of a closed item is not a second close", () => {
    const items = [item({ id: "a", status: "done", closed_at: "2026-11-17T00:00:00.000Z" })];
    const events = [ev("a", "2026-11-17T00:00:00.000Z", { from: "open", to: "done" }), ev("a", "2026-11-19T00:00:00.000Z", { from: "done", to: "done" })];
    expect(buildTimeline(items, events, RANGE).feed.map((e) => [e.kind, e.at.slice(0, 10)])).toEqual([["status", "2026-11-19"], ["closed", "2026-11-17"]]);
  });

  test("tiles: Net is opened minus closed, and Median cycle counts task items only", () => {
    const items = [
      item({ id: "t1", created_at: "2026-11-16T00:00:00.000Z", status: "done", closed_at: "2026-11-18T00:00:00.000Z" }),
      item({ id: "t2", created_at: "2026-11-16T00:00:00.000Z", status: "done", closed_at: "2026-11-20T00:00:00.000Z" }),
      item({ id: "d1", type: "decision", created_at: "2026-11-17T00:00:00.000Z", status: "accepted", closed_at: "2026-11-17T00:05:00.000Z" }),
      item({ id: "o1", created_at: "2026-11-24T00:00:00.000Z" }),
      item({ id: "o2", created_at: "2026-11-25T00:00:00.000Z" }),
    ];
    const v = buildTimeline(items, [], RANGE);
    expect(v.tiles).toEqual({ opened: 5, closed: 3, net: 2, medianCycleDays: 3 });
  });

  test("the weekly table runs Monday to Monday, newest first, counting block spells by the week they started", () => {
    const items = [
      item({ id: "a", created_at: "2026-11-16T00:00:00.000Z", status: "done", closed_at: "2026-11-24T00:00:00.000Z" }),
      item({ id: "b", created_at: "2026-11-22T23:00:00.000Z" }),
    ];
    const events = [
      ev("a", "2026-11-22T12:00:00.000Z", { from: "open", to: "blocked" }),
      ev("a", "2026-11-24T00:00:00.000Z", { from: "blocked", to: "done" }),
    ];
    const v = buildTimeline(items, events, RANGE);
    expect(v.weeks).toEqual([
      { week: "2026-11-23", opened: 0, closed: 1, net: -1, blocks: 0, medianCycleDays: 8 },
      { week: "2026-11-16", opened: 2, closed: 0, net: 2, blocks: 1, medianCycleDays: null },
    ]);
  });

  test("the feed pages newest first by (at, key), and the pages join up with nothing lost or repeated", () => {
    const items = Array.from({ length: 7 }, (_, i) => item({ id: `i${i}`, created_at: `2026-11-${17 + (i % 3)}T10:00:00.000Z` }));
    const all = buildTimeline(items, [], { ...RANGE, limit: 100 }).feed.map((e) => e.key);
    const got: string[] = [];
    let before = null;
    for (let n = 0; n < 5; n++) {
      const p = buildTimeline(items, [], { ...RANGE, limit: 3, before });
      got.push(...p.feed.map((e) => e.key));
      before = p.next;
      if (!before) break;
    }
    expect(got).toEqual(all);
    expect(got).toHaveLength(7);
    // Every page reports the whole range's tiles.
    expect(buildTimeline(items, [], { ...RANGE, limit: 3 }).tiles.opened).toBe(7);
  });

  test("events and items outside the range are left out", () => {
    const items = [item({ id: "a", created_at: "2026-10-01T00:00:00.000Z" })];
    const events = [ev("a", "2026-11-30T00:00:00.000Z", { from: "open", to: "in_progress" })];
    expect(buildTimeline(items, events, RANGE).feed).toEqual([]);
  });
});

describe("placeDecisions (OS-216)", () => {
  test("an imported overnight decision opens on its night, not the day it was imported", () => {
    const imported = { ...item({ id: "d", type: "decision", status: "accepted", created_at: "2026-11-25T10:00:00.000Z" }), decided_at: "2026-11-18T00:00:00.000Z" };
    const task = { ...item({ id: "t", created_at: "2026-11-25T10:00:00.000Z" }), decided_at: null };
    const view = buildTimeline(placeDecisions([imported, task]), [], RANGE);
    const opened = view.feed.filter((e) => e.kind === "opened").map((e) => [e.ref, e.at.slice(0, 10)]);
    expect(opened).toContainEqual(["D", "2026-11-18"]);
    expect(opened).toContainEqual(["T", "2026-11-25"]);
  });

  test("a decided_at that is not a full ISO instant leaves the decision where it was filed", () => {
    const filed = "2026-11-25T10:00:00.000Z";
    const rows = ["2026-11-20", "last week"].map((d, n) => ({ ...item({ id: `d${n}`, type: "decision", created_at: filed }), decided_at: d }));
    expect(placeDecisions(rows).map((r) => r.created_at)).toEqual([filed, filed]);
    expect("decided_at" in placeDecisions(rows)[0]!).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../../../apps/cli/src/db.ts";
import { addLink, createItem, setStatus } from "../../../apps/cli/src/items.ts";
import {
  computeProgress,
  getRoadmapMembers,
  onTrack,
} from "../../../apps/cli/src/commands/roadmap.ts";

// Open the DB directly rather than via test/helpers.ts (which imports cli.ts and
// sibling command modules still being built in parallel). This test only needs
// the schema + roadmap logic.
function freshDb() {
  return openDb(join(tmpdir(), `ob-test-${randomUUID()}.sqlite`));
}

describe("computeProgress (pure)", () => {
  test("counts done/archived/merged statuses and any closed_at", async () => {
    const p = computeProgress([
      { status: "done", closed_at: "2026-01-01T00:00:00Z" },
      { status: "archived", closed_at: null },
      { status: "merged", closed_at: null },
      { status: "in_progress", closed_at: "2026-01-01T00:00:00Z" },
      { status: "open", closed_at: null },
    ]);
    expect(p.done).toBe(4);
    expect(p.total).toBe(5);
    expect(p.fraction).toBeCloseTo(0.8);
  });

  test("empty roadmap has zero fraction (no divide-by-zero)", async () => {
    expect(computeProgress([])).toEqual({ done: 0, total: 0, fraction: 0 });
  });
});

describe("onTrack (pure)", () => {
  const created = "2026-01-01T00:00:00Z";
  const target = "2026-12-31T00:00:00Z";
  const midYear = new Date("2026-07-01T00:00:00Z"); // ~half elapsed

  test("no target date -> no_target", async () => {
    const r = onTrack(0.5, created, null, midYear);
    expect(r.verdict).toBe("no_target");
    expect(r.elapsedFraction).toBeNull();
  });

  test("progress matching elapsed -> on_track", async () => {
    const r = onTrack(0.5, created, target, midYear);
    expect(r.verdict).toBe("on_track");
    expect(r.elapsedFraction).toBeCloseTo(0.5, 1);
  });

  test("progress well beyond elapsed -> ahead", async () => {
    expect(onTrack(0.95, created, target, midYear).verdict).toBe("ahead");
  });

  test("progress well below elapsed -> behind", async () => {
    expect(onTrack(0.1, created, target, midYear).verdict).toBe("behind");
  });

  test("past target date with incomplete work -> behind", async () => {
    const afterTarget = new Date("2027-03-01T00:00:00Z");
    const r = onTrack(0.5, created, target, afterTarget);
    expect(r.verdict).toBe("behind");
    expect(r.elapsedFraction!).toBeGreaterThan(1);
  });

  test("far-future target with early progress -> ahead", async () => {
    const justAfterCreated = new Date("2026-01-02T00:00:00Z");
    expect(onTrack(0.5, created, target, justAfterCreated).verdict).toBe("ahead");
  });
});

describe("roadmap members + progress (integration)", () => {
  test("2 done of 4 members = 2/4, ahead for a future target, behind for a past one", async () => {
    const db = freshDb();
    const roadmapId = await createItem(db, {
      type: "roadmap",
      title: "Ship v3",
      roadmap: { targetDate: "2030-01-01T00:00:00Z" },
    });

    const memberIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await createItem(db, { type: "task", title: `task ${i}` });
      memberIds.push(id);
      await addLink(db, id, "roadmap_member", roadmapId);
    }
    // Close 2 of the 4.
    await setStatus(db, memberIds[0]!, "done");
    await setStatus(db, memberIds[1]!, "done");

    const members = await getRoadmapMembers(db, roadmapId);
    expect(members).toHaveLength(4);

    const progress = computeProgress(members);
    expect(progress.done).toBe(2);
    expect(progress.total).toBe(4);
    expect(progress.fraction).toBeCloseTo(0.5);

    // Roadmap was created "now"; a target in 2030 means almost no time elapsed
    // yet 50% done -> ahead.
    const future = onTrack(progress.fraction, "2026-07-16T00:00:00Z", "2030-01-01T00:00:00Z", new Date("2026-07-16T00:00:00Z"));
    expect(future.verdict).toBe("ahead");

    // A target already in the past with only 50% done -> behind.
    const past = onTrack(progress.fraction, "2025-01-01T00:00:00Z", "2025-06-01T00:00:00Z", new Date("2026-07-16T00:00:00Z"));
    expect(past.verdict).toBe("behind");
  });

  test("members are ordered by position (NULLs last) then id", async () => {
    const db = freshDb();
    const roadmapId = await createItem(db, { type: "roadmap", title: "Ordered" });
    const a = await createItem(db, { type: "task", title: "a" });
    const b = await createItem(db, { type: "task", title: "b" });
    const c = await createItem(db, { type: "task", title: "c" });
    // Link with no position for a, then positions for b and c.
    await addLink(db, a, "roadmap_member", roadmapId);
    await addLink(db, b, "roadmap_member", roadmapId);
    await addLink(db, c, "roadmap_member", roadmapId);
    db.query(
      "UPDATE item_link SET position = ? WHERE from_item = ? AND to_item = ? AND rel_type = 'roadmap_member'",
    ).run(2, b, roadmapId);
    db.query(
      "UPDATE item_link SET position = ? WHERE from_item = ? AND to_item = ? AND rel_type = 'roadmap_member'",
    ).run(1, c, roadmapId);

    const ids = (await getRoadmapMembers(db, roadmapId)).map((m) => m.id);
    // c(pos 1), b(pos 2), then a(no position, last).
    expect(ids).toEqual([c, b, a]);
  });
});

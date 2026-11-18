import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem, getItem, getLearningDetail, getLinks } from "../../../apps/cli/src/items.ts";
import {
  chainFrom,
  supersede,
  supersedeEdgesFromLinks,
  type SupersedeEdge,
} from "../../../apps/cli/src/commands/decision.ts";

// Open the DB directly rather than via test/helpers.ts (which imports cli.ts and
// its sibling command modules still being built in parallel).
function freshDb() {
  return openDb(join(tmpdir(), `ob-test-${randomUUID()}.sqlite`));
}

describe("chainFrom (pure)", () => {
  // Edges: C supersedes B, B supersedes A  =>  chain A <- B <- C
  const edges: SupersedeEdge[] = [
    { from: "C", to: "B" },
    { from: "B", to: "A" },
  ];

  test("walks what an item supersedes (downward)", async () => {
    expect(chainFrom(edges, "C").supersedes).toEqual(["B", "A"]);
    expect(chainFrom(edges, "B").supersedes).toEqual(["A"]);
    expect(chainFrom(edges, "A").supersedes).toEqual([]);
  });

  test("walks what supersedes an item (upward)", async () => {
    expect(chainFrom(edges, "A").supersededBy).toEqual(["B", "C"]);
    expect(chainFrom(edges, "B").supersededBy).toEqual(["C"]);
    expect(chainFrom(edges, "C").supersededBy).toEqual([]);
  });

  test("does not loop on a cycle", async () => {
    const cyclic: SupersedeEdge[] = [
      { from: "X", to: "Y" },
      { from: "Y", to: "X" },
    ];
    expect(chainFrom(cyclic, "X").supersedes).toEqual(["Y"]);
  });
});

describe("supersedeEdgesFromLinks (pure)", () => {
  test("normalises out/in links relative to a node, ignoring other rels", async () => {
    const edges = supersedeEdgesFromLinks(
      [
        { rel_type: "supersedes", other: "1", direction: "out" },
        { rel_type: "supersedes", other: "3", direction: "in" },
        { rel_type: "references", other: "9", direction: "out" },
      ],
      "2",
    );
    expect(edges).toEqual([
      { from: "2", to: "1" },
      { from: "3", to: "2" },
    ]);
  });
});

describe("supersede (DB effect)", () => {
  test("old -> superseded, new -> accepted, chain is walkable", async () => {
    const db = freshDb();
    const oldId = await createItem(db, {
      type: "decision",
      title: "Use REST",
      decision: { context: "early api", choice: "REST", rationale: "simple" },
    });
    const newId = await createItem(db, {
      type: "decision",
      title: "Use gRPC",
      decision: { context: "scale", choice: "gRPC", rationale: "streaming" },
    });

    expect((await getItem(db, oldId))!.status).toBe("draft");

    const r = await supersede(db, newId, oldId);
    expect(r).toEqual({
      newId,
      oldId,
      newStatus: "accepted",
      oldStatus: "superseded",
    });

    expect((await getItem(db, oldId))!.status).toBe("superseded");
    expect((await getItem(db, newId))!.status).toBe("accepted");

    // The chain is walkable in both directions from the real links.
    const newEdges = supersedeEdgesFromLinks(await getLinks(db, newId), newId);
    expect(chainFrom(newEdges, newId).supersedes).toContain(oldId);
    const oldEdges = supersedeEdgesFromLinks(await getLinks(db, oldId), oldId);
    expect(chainFrom(oldEdges, oldId).supersededBy).toContain(newId);
  });

  test("rejects non-existent or non-decision ids with UsageError", async () => {
    const db = freshDb();
    const dec = await createItem(db, { type: "decision", title: "D", decision: {} });
    const task = await createItem(db, { type: "task", title: "T" });
    await expect(supersede(db, dec, "999")).rejects.toThrow();
    await expect(supersede(db, task, dec)).rejects.toThrow();
    await expect(supersede(db, dec, dec)).rejects.toThrow();
  });
});

describe("learning detail round-trips", () => {
  test("createItem persists kind/progress/source/why", async () => {
    const db = freshDb();
    const id = await createItem(db, {
      type: "learning",
      title: "Learn query optimization",
      learning: {
        kind: "competency",
        progress: "proficient",
        source: "https://use-the-index-luke.com",
        why: "keep tripping on N+1",
      },
    });
    expect((await getItem(db, id))!.status).toBe("todo");
    const d = await getLearningDetail(db, id);
    expect(d).toMatchObject({
      item_id: id,
      kind: "competency",
      progress: "proficient",
      source: "https://use-the-index-luke.com",
      why: "keep tripping on N+1",
    });
  });
});

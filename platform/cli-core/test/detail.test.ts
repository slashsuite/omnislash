import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { describe, expect, test } from "bun:test";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { addLink, addTags, attachLinear, createItem, getItem } from "../../../apps/cli/src/items.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { recordEvent, nowIso } from "../../../apps/cli/src/events.ts";
import { itemDetail } from "../../../apps/cli/src/detail.ts";
import { blockItem, closeItem, readyItem, reopenItem, setTodayRank, startItem } from "../../../apps/cli/src/workflow.ts";

// #46 — UI F5: the item-drawer read composition + the workflow-transition cores the dashboard's
// getItem / transitionItem server fns delegate to. Seeded against a fresh temp DB — no live DB/network.

describe("itemDetail composition (the `ob show`-level drawer read)", () => {
  test("composes fields + tags + links + linear ref + events + PRs + valid_next", async () => {
    const db = freshDb();
    await registerProject(db, { name: "acme", kind: "side" });
    const id = await createItem(db, { type: "task", title: "wire the drawer", body: "the F5 lever", projectId: "acme" });
    const other = await createItem(db, { type: "task", title: "dep", projectId: "acme" });
    await addTags(db, id, ["ui", "dashboard"]);
    await addLink(db, id, "blocks", other);
    await attachLinear(db, id, "https://linear.app/cue/issue/CUE-123/x");
    recordEvent(db, { ts: nowIso(), source: "github", type: "ready_for_review", itemId: id, payload: { pr: "acmecorp/acme#7", url: "https://github.com/x/7" } });
    recordEvent(db, { ts: nowIso(), source: "github", type: "review", itemId: id, payload: { pr: "acmecorp/acme#7" } });

    const d = await itemDetail(sqliteStoreFor(db), id);
    expect(d.id).toBe(id);
    expect(d.title).toBe("wire the drawer");
    expect(d.body).toBe("the F5 lever");
    expect(d.status).toBe("open");
    expect(d.kind).toBe("side");
    expect(d.tags).toEqual(["dashboard", "ui"]);
    expect(d.links.some((l) => l.other === other && l.rel_type === "blocks")).toBe(true);
    expect(d.linear?.linear_id).toBe("CUE-123");
    expect(d.events.length).toBe(2);
    // Two github events, one PR → collapsed to a single associated PR.
    expect(d.prs.length).toBe(1);
    expect(d.prs[0]!.pr).toBe("acmecorp/acme#7");
    // A side/basic-vocab open item can move to in_progress/ready/blocked/done.
    expect(d.valid_next).toContain("in_progress");
    expect(d.valid_next).toContain("done");
    expect(d.valid_next).not.toContain("qa"); // qa is cue-only vocab
  });

  test("throws on an unknown id", async () => {
    const db = freshDb();
    await expect(itemDetail(sqliteStoreFor(db), "999")).rejects.toThrow(/no item with id/);
  });
});

describe("workflow transition cores (the drawer's state actions)", () => {
  test("start → ready → close → reopen move the status and stamp closed_at", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "t" });
    await startItem(db, id);
    expect((await getItem(db, id))!.status).toBe("in_progress");
    await readyItem(db, id);
    expect((await getItem(db, id))!.status).toBe("ready");
    await closeItem(db, id);
    expect((await getItem(db, id))!.status).toBe("done");
    expect((await getItem(db, id))!.closed_at).not.toBeNull();
    await reopenItem(db, id);
    expect((await getItem(db, id))!.status).toBe("open");
    expect((await getItem(db, id))!.closed_at).toBeNull();
  });

  test("block records reason + owner and rejects a double-block", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "t" });
    await blockItem(db, id, "waiting on api", "sam");
    const row = (await getItem(db, id))!;
    expect(row.status).toBe("blocked");
    expect(row.block_reason).toBe("waiting on api");
    expect(row.block_owner).toBe("sam");
    await expect(blockItem(db, id, "again", null)).rejects.toThrow(/already blocked/);
  });

  test("rejects an invalid transition cleanly", async () => {
    const db = freshDb();
    const id = await createItem(db, { type: "task", title: "t" }); // open
    // open → ready is fine; open cannot go straight to 'merged' skipping? merged is reachable only from ready.
    await expect(reopenItem(db, id)).rejects.toThrow(/not closed/); // open item can't be reopened
    await startItem(db, id); // in_progress
    // in_progress → done is allowed; but a status the vocab doesn't hold must throw.
    // The old assertion was `expect(() => readyItem(...)).not.toThrow()`. readyItem returns a promise
    // now, so a rejection is what has to be ruled out, and awaiting it does exactly that: the test fails
    // on a rejection and passes otherwise. `.resolves.toBeDefined()` would be wrong here, since the
    // function resolves to undefined.
    await readyItem(db, id);
  });

  test("setTodayRank assigns explicit + auto ranks", async () => {
    const db = freshDb();
    const a = await createItem(db, { type: "task", title: "a" });
    const b = await createItem(db, { type: "task", title: "b" });
    expect(await setTodayRank(db, a, 5)).toBe(5);
    expect((await getItem(db, a))!.today_rank).toBe(5);
    expect(await setTodayRank(db, b)).toBe(6); // MAX(5)+1
    expect((await getItem(db, b))!.today_rank).toBe(6);
  });
});

// wayfinder 1949: per-project ticket refs (`PS-12`), proven on SQLite.
//
// Two things here can go wrong silently, so each is asserted on data rather than on "it did not throw":
//   1. two concurrent adds take the same seq (the counter upsert must serialise them);
//   2. a move loses the old ref, so a branch or note that names it stops resolving.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem, editItem, getItem } from "../../../apps/cli/src/items.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import {
  aliasesOf,
  equivalentRefs,
  normalizeRef,
  ProjectKeyError,
  resolveItemId,
  setProjectKey,
} from "../../../apps/cli/src/refs.ts";
import { freshDbPath, spawnBudget } from "../../../apps/cli/test/helpers.ts";

describe("refs on a live tracker (1949)", () => {
  test("a move takes a ref under the new key and keeps the old one as an alias", async () => {
    const db = openDb(freshDbPath(), { create: true });
    await registerProject(db, { name: "pixelslash", kind: "side" });
    await registerProject(db, { name: "hackcove", kind: "side" });
    await registerProject(db, { name: "scratch", kind: "home" });
    const id = await createItem(db, { type: "task", title: "move me", projectId: "pixelslash" });
    expect((await getItem(db, id))?.ref).toBe("PS-1");

    await editItem(db, id, { projectId: "hackcove" });
    expect((await getItem(db, id))?.ref).toBe("HC-1");
    expect(await aliasesOf(db, id)).toEqual(["PS-1"]);
    expect(await resolveItemId(db, "ps-1")).toBe(id);
    expect((await getItem(db, "PS-1"))?.id).toBe(id);
    expect((await equivalentRefs(db, id)).sort()).toEqual([id, "HC-1", "PS-1"].sort());

    // a keyless project keeps the ref it has; moving back gives a NEW PS ref, never PS-1 again
    await editItem(db, id, { projectId: "scratch" });
    expect((await getItem(db, id))?.ref).toBe("HC-1");
    await editItem(db, id, { projectId: "pixelslash" });
    expect((await getItem(db, id))?.ref).toBe("PS-2");
    expect((await aliasesOf(db, id)).sort()).toEqual(["HC-1", "PS-1"]); // same-millisecond moves tie on created_at
    db.close();
  });

  test("setProjectKey numbers the project's items, refuses a taken or malformed key, and re-keys with aliases", async () => {
    const db = openDb(freshDbPath(), { create: true });
    await registerProject(db, { name: "web", kind: "side" });
    await registerProject(db, { name: "pixelslash", kind: "side" }); // takes the agreed PS
    const a = await createItem(db, { type: "task", title: "a", projectId: "web" });
    const b = await createItem(db, { type: "task", title: "b", projectId: "web" });
    expect((await getItem(db, a))?.ref).toBeNull();

    expect(await setProjectKey(db, "web", "we")).toBe(2);
    expect([(await getItem(db, a))?.ref, (await getItem(db, b))?.ref]).toEqual(["WE-1", "WE-2"]);
    expect(await setProjectKey(db, "web", "WE")).toBe(0); // same key: nothing to renumber

    await expect(setProjectKey(db, "web", "PS")).rejects.toBeInstanceOf(ProjectKeyError);
    await expect(setProjectKey(db, "web", "W1")).rejects.toBeInstanceOf(ProjectKeyError);
    await expect(setProjectKey(db, "web", "TOOLONG")).rejects.toBeInstanceOf(ProjectKeyError);

    expect(await setProjectKey(db, "web", "WEB")).toBe(2);
    expect((await getItem(db, a))?.ref).toBe("WEB-1");
    expect(await resolveItemId(db, "we-1")).toBe(a);
    db.close();
  });

  test("no project numbers under OB; a bare number is always the legacy id", async () => {
    const db = openDb(freshDbPath(), { create: true });
    const loose = await createItem(db, { type: "task", title: "loose" });
    await registerProject(db, { name: "omnislash", kind: "side" });
    const omni = await createItem(db, { type: "task", title: "in omnislash", projectId: "omnislash" });
    expect([(await getItem(db, loose))?.ref, (await getItem(db, omni))?.ref]).toEqual(["OB-1", "OB-2"]);
    // "2" is item 2 (the omnislash one), never "OB-2" read as a seq
    expect(await resolveItemId(db, "2")).toBe("2");
    expect(await resolveItemId(db, "nope")).toBe("nope");
    expect(normalizeRef(" haf-007 ")).toBe("HAF-7");
    expect(normalizeRef("p1-2")).toBeNull();
    db.close();
  });

  test("concurrent adds from separate processes never share a seq", async () => {
    const path = freshDbPath();
    const db = openDb(path, { create: true });
    await registerProject(db, { name: "pixelslash", kind: "side" });
    db.close();
    const items = join(import.meta.dir, "..", "..", "..", "apps", "cli", "src", "items.ts");
    const dbModule = join(import.meta.dir, "..", "..", "..", "apps", "cli", "src", "db.ts");
    const script = `
      import { openDb } from ${JSON.stringify(dbModule)};
      import { createItem } from ${JSON.stringify(items)};
      const db = openDb(${JSON.stringify(path)});
      for (let i = 0; i < 5; i++) await createItem(db, { type: "task", title: "race " + i, projectId: "pixelslash" });
      db.close();
    `;
    const runners = Array.from({ length: 4 }, () => Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, OMNISLASH_STORE: "sqlite" } }));
    const outcomes = await Promise.all(runners.map(async (p) => ({ code: await p.exited, err: await new Response(p.stderr).text() })));
    for (const o of outcomes) expect(o).toEqual({ code: 0, err: "" });

    const after = new Database(path);
    const refs = (after.query("SELECT ref FROM item WHERE project_id = 'pixelslash'").all() as Array<{ ref: string }>).map((r) => r.ref);
    expect(refs.length).toBe(20);
    expect(new Set(refs).size).toBe(20);
    expect(refs.map((r) => Number(r.split("-")[1])).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(after.query("SELECT next_seq FROM ref_counter WHERE key = 'PS'").get()).toEqual({ next_seq: 21 });
    after.close();
  }, spawnBudget(4));
});


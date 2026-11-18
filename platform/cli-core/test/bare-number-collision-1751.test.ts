// OB-1751: a bare number that is the internal id of one item AND `OB-<n>` of another is refused, naming both,
// instead of silently resolving to the internal id (`ob note 149` wrote to OB-142; `ob spinoff 1750` launched
// a builder for HC-32). In-process against a fresh SQLite database.
import { describe, expect, test } from "bun:test";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { registerProject } from "../../../apps/cli/src/project.ts";
import { bareNumberCollision } from "../../../apps/cli/src/refs.ts";
import { refuseAmbiguousDispatchRef } from "../../cli-coord/src/spinoff-item.ts";

/** id 1 = PS-1, id 2 = OB-1, id 3 = OB-2: bare `1` and `2` are each also the other's OB-n; bare `3` is clean. */
async function drifted() {
  const dbPath = freshDbPath();
  const db = openDb(dbPath);
  await registerProject(db, { name: "pixelslash", kind: "side" });
  const ps = await createItem(db, { type: "task", title: "ps one", projectId: "pixelslash" });
  const a = await createItem(db, { type: "task", title: "ob one" });
  const b = await createItem(db, { type: "task", title: "ob two" });
  return { dbPath, db, ps, a, b };
}

describe("a bare number that is also a different OB-n key (OB-1751)", () => {
  test("the collision names both items", async () => {
    const { db, ps, a } = await drifted();
    const c = await bareNumberCollision(db, "1");
    expect(c).toMatchObject({ idItem: ps, idItemRef: "PS-1", keyItem: a, keyRef: "OB-1" });
    expect(await bareNumberCollision(db, "3")).toBeNull(); // OB-3 does not exist
    expect(await bareNumberCollision(db, "OB-1")).toBeNull(); // not bare
    expect(await bareNumberCollision(db, "99")).toBeNull(); // names no item as an id
  });

  test("a number whose id item IS OB-<n> is no collision", async () => {
    const db = freshDb();
    const a = await createItem(db, { type: "task", title: "x" });
    expect(await bareNumberCollision(db, a)).toBeNull();
  });

  test("`note <bare>` is refused and writes nothing; the ref and an unambiguous number still work", async () => {
    const { dbPath, db, ps, a, b } = await drifted();
    const refused = await runCli(dbPath, ["note", "1", "hello"]);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/'1' is ambiguous.*PS-1.*OB-1/);
    expect((await getItem(db, ps))?.body ?? "").not.toContain("hello");
    expect((await getItem(db, a))?.body ?? "").not.toContain("hello");

    expect((await runCli(dbPath, ["note", "OB-1", "to the key"])).code).toBe(0);
    expect((await getItem(db, a))?.body).toContain("to the key");
    expect((await runCli(dbPath, ["note", "ps-1", "to the ps"])).code).toBe(0);
    expect((await getItem(db, ps))?.body).toContain("to the ps");
    expect((await runCli(dbPath, ["note", "3", "clean"])).code).toBe(0);
    expect((await getItem(db, b))?.body).toContain("clean");
  });

  test("the ref-resolving commands (itemArg) refuse too", async () => {
    const { dbPath, db, ps } = await drifted();
    const r = await runCli(dbPath, ["close", "1"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/ambiguous/);
    expect((await getItem(db, ps))?.status).not.toBe("done");
  });

  test("`spinoff` dispatch refuses before anything is queued", async () => {
    const { db } = await drifted();
    await expect(refuseAmbiguousDispatchRef(db, "1")).rejects.toThrow(/'1' is ambiguous.*PS-1.*OB-1/);
    await refuseAmbiguousDispatchRef(db, "OB-1");
    await refuseAmbiguousDispatchRef(db, "3");
  });
});

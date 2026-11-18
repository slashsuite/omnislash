// ob 337 pass 4 — `ob note` / `ob tag` / `ob untag` / `ob link` WRITE, through the real command path.
//
// THIS TEST EXISTS BECAUSE TYPECHECK CANNOT SEE THE BUG IT CATCHES. Pass 1 made `addTags` async and left
// `addTags(db, id, tags)` as a bare statement in the handler. That typechecks -- the expression is a
// valid statement, its value is simply discarded -- and it compiles, and it exits 0, and it writes
// NOTHING, because the process ends before the promise settles. `ob tag` was silently broken by it.
//
// So these assert the SIDE EFFECT, read back out of the database afterwards, rather than the exit code.
// A discarded promise passes an exit-code assertion every time.
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { openDb } from "../../../apps/cli/src/db.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { getItem, getLinks, getTags } from "../../../apps/cli/src/items.ts";

async function withDb<T>(body: (dbPath: string) => Promise<T>): Promise<T> {
  const dbPath = freshDbPath();
  const previousCreate = process.env.OMNISLASH_DB_CREATE;
  process.env.OMNISLASH_DB_CREATE = "1";
  try {
    openDb(dbPath, { create: true }).close();
    return await body(dbPath);
  } finally {
    if (previousCreate === undefined) delete process.env.OMNISLASH_DB_CREATE;
    else process.env.OMNISLASH_DB_CREATE = previousCreate;
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
}

describe("ob 337 pass 4: the item-adjacent writes actually reach the database", () => {
  test("ob tag writes the tags, and ob untag removes them", async () => {
    await withDb(async (dbPath) => {
      const added = await runCli(dbPath, ["add", "port the note/tag/link commands", "--project", "acme", "--kind", "side", "--json"]);
      expect(added.code).toBe(0);
      const id = (JSON.parse(added.out) as { id: string }).id;

      const tagged = await runCli(dbPath, ["tag", id, "migration", "Postgres"]);
      expect(tagged.code).toBe(0);

      // Read back through a SECOND handle: the write has to have been committed by the command, not
      // merely queued on a promise the process never waited for.
      const db = openDb(dbPath);
      try {
        expect(await getTags(db, id)).toEqual(["migration", "postgres"]);
      } finally {
        db.close();
      }

      expect((await runCli(dbPath, ["untag", id, "postgres"])).code).toBe(0);
      const after = openDb(dbPath);
      try {
        expect(await getTags(after, id)).toEqual(["migration"]);
      } finally {
        after.close();
      }
    });
  });

  test("ob note appends the stamped note to the body", async () => {
    await withDb(async (dbPath) => {
      const added = await runCli(dbPath, ["add", "gate it twice", "--project", "acme", "--kind", "side", "--json"]);
      const id = (JSON.parse(added.out) as { id: string }).id;

      expect((await runCli(dbPath, ["note", id, "the suite runs twice for anything touching the db"])).code).toBe(0);

      const db = openDb(dbPath);
      try {
        const row = await getItem(db, id);
        expect(row?.body ?? "").toContain("the suite runs twice");
        // The fts5 shadow table is maintained by hand on SQLite, so a note that did not sync it would
        // leave `ob search` unable to find the text that is demonstrably in the body.
        const hits = db.query<{ item_id: string }, []>(
          `SELECT item_id FROM item_fts WHERE item_fts MATCH 'twice'`,
        ).all();
        expect(hits.map((h) => h.item_id)).toContain(id);
      } finally {
        db.close();
      }
    });
  });

  test("ob link records the relation in both directions", async () => {
    await withDb(async (dbPath) => {
      const a = JSON.parse((await runCli(dbPath, ["add", "the guard", "--project", "acme", "--kind", "side", "--json"])).out).id as string;
      const b = JSON.parse((await runCli(dbPath, ["add", "the cutover", "--project", "acme", "--kind", "side", "--json"])).out).id as string;

      expect((await runCli(dbPath, ["link", a, "blocks", b])).code).toBe(0);

      const db = openDb(dbPath);
      try {
        expect(await getLinks(db, a)).toEqual([{ rel_type: "blocks", other: b, direction: "out" }]);
        expect(await getLinks(db, b)).toEqual([{ rel_type: "blocks", other: a, direction: "in" }]);
      } finally {
        db.close();
      }
    });
  });

  test("ob tag --repo records the project alongside the tags, in one command", async () => {
    await withDb(async (dbPath) => {
      const id = JSON.parse((await runCli(dbPath, ["add", "classify me", "--project", "acme", "--kind", "side", "--json"])).out).id as string;

      expect((await runCli(dbPath, ["tag", id, "chore", "--repo", "cue-frontend", "--kind", "side"])).code).toBe(0);

      const db = openDb(dbPath);
      try {
        const row = await getItem(db, id);
        expect(row?.project_name).toBe("cue-frontend");
        expect(await getTags(db, id)).toEqual(["chore"]);
      } finally {
        db.close();
      }
    });
  });
});

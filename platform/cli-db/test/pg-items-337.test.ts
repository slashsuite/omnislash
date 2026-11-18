// ob 337 — apps/cli's own item core, run against BOTH engines and compared.
//
// The store-guard test proves an UNPORTED command refuses. This proves the PORTED ones are right, which
// is a different and harder question: every failure mode this phase risks is silent. An aggregate that
// arrives as a string turns `+ 1` into concatenation, a NULL sorts to the opposite end, a count reads
// truthy when it should read zero. None of those throw. So "it did not throw on Postgres" proves nothing
// here, and only running the same sequence on both engines and diffing the RESULTS does.
//
// The sequence is deliberately the cutover smoke test: create items (`ob add`), list the open ones
// (`ob next`), read one back with its tags, links and detail (`ob show`), move it through the workflow
// (`ob close`), and count the triage inbox (the banner on `ob next` / `ob status`).
//
// It uses the ob 325 harness, so the Postgres side is a real local cluster over a unix socket: no
// network, no live database, nothing to configure.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import {
  addLink,
  addTags,
  appendNote,
  createItem,
  getDetail,
  getItem,
  getLinks,
  getTags,
  queryItems,
  setStatus,
  triageCount,
  triageInbox,
} from "../../../apps/cli/src/items.ts";
import { closeItem, setTodayRank, startItem } from "../../../apps/cli/src/workflow.ts";

const PG_BUDGET = spawnBudget(3);

/**
 * One realistic pass over the ported item core. Returns plain JSON-able values, so a mismatch reads as a
 * diff of ids and counts rather than of object identities.
 */
async function exercise(store: Store): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // --- `ob add` ------------------------------------------------------------------------------------
  // Sequential rather than concurrent, because nextId reads MAX(id) and the ids it hands out are the
  // thing being compared. This is also the aggregate most at risk: MAX arrives from Postgres as a
  // string, and "9" + 1 is "91".
  const first = await createItem(store, { type: "task", title: "port the cli", tags: ["migration", "cli"] });
  const second = await createItem(store, { type: "task", title: "gate it", body: "run the suite twice" });
  const third = await createItem(store, { type: "task", title: "untriaged", triage: true });
  const decision = await createItem(store, {
    type: "decision",
    title: "one store at a time",
    decision: { context: "two live stores cannot be fixed forward", choice: "guard the unported paths" },
  });
  out.ids = [first, second, third, decision];

  // Ten more, so the id sequence crosses 9 -> 10 and 99 would be next. A string-concatenating nextId
  // produces "101" here instead of 11 and the whole list diverges.
  const many: string[] = [];
  for (let i = 0; i < 10; i++) many.push(await createItem(store, { type: "task", title: `bulk ${i}` }));
  out.bulkIds = many;
  out.idTypes = [...new Set([first, second, third, ...many].map((id) => typeof id))];

  // --- `ob next` / `ob list` ----------------------------------------------------------------------
  out.openIds = (await queryItems(store, { open: true })).map((i) => i.id);
  out.byType = (await queryItems(store, { type: "decision" })).map((i) => i.title);
  out.byTag = (await queryItems(store, { tag: "migration" })).map((i) => i.id);
  out.byStatus = (await queryItems(store, { status: "open" })).length;

  // --- the triage banner --------------------------------------------------------------------------
  // count(*) is bigint on Postgres and arrives as a STRING. The banner asks `n > 0`, and "0" > 0 is
  // false while "0" is truthy, so an un-coerced count is right in one place and wrong in the next.
  out.triageCount = await triageCount(store);
  out.triageCountType = typeof (await triageCount(store));
  out.triageIds = (await triageInbox(store)).map((i) => i.id);

  // --- `ob show` ----------------------------------------------------------------------------------
  await addTags(store, second, ["gate", "migration"]);
  await addLink(store, first, "blocks", second);
  await appendNote(store, second, "the suite runs twice for anything touching the db");
  const shown = await getItem(store, second);
  out.showTitle = shown?.title;
  out.showStatus = shown?.status;
  out.showBodyHasNote = shown?.body?.includes("runs twice") ?? false;
  out.showTags = await getTags(store, second);
  out.showLinksIn = (await getLinks(store, second)).map((l) => [l.direction, l.rel_type, l.other]);
  out.showLinksOut = (await getLinks(store, first)).map((l) => [l.direction, l.rel_type, l.other]);
  // decided_at defaults to "now", so it differs between the two passes by milliseconds. The KEYS and
  // every other value are what this compares; the timestamp is asserted for shape only.
  const detail = (await getDetail(store, "decision", decision)) as Record<string, unknown>;
  out.decisionDetailKeys = Object.keys(detail).sort();
  out.decisionDetail = { ...detail, decided_at: typeof detail.decided_at };
  out.missingItem = await getItem(store, "999999");

  // --- `ob start` / `ob close`, through the validated workflow -------------------------------------
  await startItem(store, first);
  out.afterStart = (await getItem(store, first))?.status;
  await closeItem(store, first);
  const closed = await getItem(store, first);
  out.afterClose = closed?.status;
  out.closedAtSet = closed?.closed_at !== null;
  // done -> done must not move closed_at (the COALESCE in setStatus).
  await setStatus(store, first, "done");
  out.closedAtStable = (await getItem(store, first))?.closed_at === closed?.closed_at;
  out.openAfterClose = (await queryItems(store, { open: true })).map((i) => i.id);

  // --- today ranks: the other MAX aggregate, and a nullable ordered column -------------------------
  out.rankExplicit = await setTodayRank(store, second, 3);
  out.rankAuto = await setTodayRank(store, third);
  out.rankTypes = [typeof out.rankExplicit, typeof out.rankAuto];
  // today_rank is NULLABLE, so this is where a NULLS-first/NULLS-last difference between the engines
  // would show up as a different list rather than an error.
  out.rankedOrder = (await queryItems(store, { open: true }))
    .map((i) => [i.id, i.today_rank])
    .filter(([, r]) => r !== null);

  return out;
}

describe("apps/cli's item core agrees across the two engines (337)", () => {
  test(
    "the cutover smoke sequence produces identical results on Postgres and on SQLite",
    async () => {
      const lease = await leaseRealPgDb();
      const dir = mkdtempSync(join(tmpdir(), "ob337-"));
      const previousCreate = process.env.OMNISLASH_DB_CREATE;
      process.env.OMNISLASH_DB_CREATE = "1";
      let pg: Store | undefined;
      let sqlite: Store | undefined;
      try {
        pg = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        sqlite = await openStore({ kind: "sqlite", path: join(dir, "omnislash.sqlite"), create: true });

        expect(pg.kind).toBe("postgres");
        expect(pg.sqlite).toBeNull();
        expect(sqlite.kind).toBe("sqlite");

        const fromPg = await exercise(pg);
        const fromSqlite = await exercise(sqlite);

        // Key by key, so a failure names the value that moved rather than "two big objects differ".
        for (const key of Object.keys(fromSqlite)) {
          expect({ [key]: fromPg[key] }).toEqual({ [key]: fromSqlite[key] });
        }

        // Absolute anchors, so a bug that broke BOTH engines identically still fails here.
        expect(fromSqlite.ids).toEqual(["1", "2", "3", "4"]);
        // The id sequence crossing into two digits: "41" instead of 14 is the string-concatenation bug.
        expect(fromSqlite.bulkIds).toEqual(["5", "6", "7", "8", "9", "10", "11", "12", "13", "14"]);
        expect(fromSqlite.idTypes).toEqual(["string"]);
        expect(fromSqlite.triageCount).toBe(1);
        expect(fromSqlite.triageCountType).toBe("number");
        expect(fromSqlite.showTags).toEqual(["gate", "migration"]);
        expect(fromSqlite.afterStart).toBe("in_progress");
        expect(fromSqlite.afterClose).toBe("done");
        expect(fromSqlite.closedAtSet).toBe(true);
        expect(fromSqlite.closedAtStable).toBe(true);
        expect(fromSqlite.missingItem).toBeNull();
        expect(fromSqlite.rankExplicit).toBe(3);
        expect(fromSqlite.rankAuto).toBe(4);
        expect(fromSqlite.rankTypes).toEqual(["number", "number"]);
      } finally {
        await pg?.close();
        await sqlite?.close();
        await lease.release();
        rmSync(dir, { recursive: true, force: true });
        if (previousCreate === undefined) delete process.env.OMNISLASH_DB_CREATE;
        else process.env.OMNISLASH_DB_CREATE = previousCreate;
      }
    },
    PG_BUDGET,
  );
});

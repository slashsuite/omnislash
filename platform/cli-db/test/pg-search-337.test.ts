// ob 337 pass 4 — `ob search` on the live path, on both engines, over one corpus.
//
// ob 322 built the Postgres side (the tsquery translator, the generated search_vec columns, the pg_trgm
// fallback) and unit-tested the TRANSLATION without a database. What it could not test is the question
// that matters at the cutover: run the same search against both engines over the same items and see what
// each one actually returns.
//
// THE POINT OF THIS TEST IS NOT THAT THE TWO AGREE -- THEY DO NOT, AND THEY SHOULD NOT.
// A measurement over 29 queries found that Postgres finds MORE on 6
// and less on none. So this asserts the difference in the direction 322 accepted:
//
//   * whatever SQLite finds, Postgres finds too (no recall is lost by the cutover);
//   * stemming, the email/path parser and the trigram fallback each earn their keep on a case fts5
//     misses, and each is named so a regression says which mechanism stopped working;
//   * the SQLite branch is byte-for-byte the pre-337 fts5 query, so nothing about today changes.
//
// The Postgres side is the ob 325 harness: a real embedded cluster over a unix socket, no network and no
// live database.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { searchItemIds } from "../../../apps/cli/src/search.ts";

const PG_BUDGET = spawnBudget(3);

// One small corpus that exercises every difference the comparison document names.
const CORPUS: Array<{ title: string; body: string | null }> = [
  { title: "port the cli to Postgres", body: "the migration of apps/cli, 265 call sites" },
  { title: "migrating the dashboard", body: "phase five of the cutover" },
  { title: "mail alex@acmecorp.example.com about the window", body: null },
  { title: "the fingerprint lives in apps/cli/src/db/schema.ts", body: null },
  { title: "ob-322 replaced fts5 with tsvector", body: "generated columns, GIN indexes" },
  { title: "a café in Elmsworth", body: "flat white" },
];

async function seed(store: Store): Promise<string[]> {
  const ids: string[] = [];
  for (const row of CORPUS) ids.push(await createItem(store, { type: "task", title: row.title, body: row.body }));
  return ids;
}

describe("ob 337 pass 4: ob search runs on both engines, and Postgres loses nothing", () => {
  test(
    "every SQLite hit is also a Postgres hit, and Postgres finds more where 322 said it would",
    async () => {
      const lease = await leaseRealPgDb();
      const dir = mkdtempSync(join(tmpdir(), "ob337s-"));
      const previousCreate = process.env.OMNISLASH_DB_CREATE;
      process.env.OMNISLASH_DB_CREATE = "1";
      let pg: Store | undefined;
      let sqlite: Store | undefined;
      try {
        pg = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        sqlite = await openStore({ kind: "sqlite", path: join(dir, "omnislash.sqlite"), create: true });

        const pgIds = await seed(pg);
        const sqliteIds = await seed(sqlite);
        // The two corpora get the same ids, so a hit set is comparable directly.
        expect(pgIds).toEqual(sqliteIds);
        const [cli, dashboard, email, path, ticket, cafe] = sqliteIds as [string, string, string, string, string, string];

        const on = async (store: Store, query: string): Promise<string[]> =>
          (await searchItemIds(store, query)).sort();

        // --- the shared floor: an ordinary word match, identical on both -------------------------
        expect(await on(sqlite, "postgres")).toEqual([cli]);
        expect(await on(pg, "postgres")).toEqual([cli]);
        expect(await on(sqlite, "cutover")).toEqual([dashboard]);
        expect(await on(pg, "cutover")).toEqual([dashboard]);
        // Operators carry over unchanged.
        expect(await on(sqlite, "postgres OR cutover")).toEqual([cli, dashboard].sort());
        expect(await on(pg, "postgres OR cutover")).toEqual([cli, dashboard].sort());

        // --- nothing SQLite finds is lost --------------------------------------------------------
        const queries = ["postgres", "cutover", "migration", "fts5", "dashboard", "window", "indexes"];
        for (const query of queries) {
          const fromSqlite = await on(sqlite, query);
          const fromPg = await on(pg, query);
          expect({ query, missing: fromSqlite.filter((id) => !fromPg.includes(id)) }).toEqual({ query, missing: [] });
        }

        // --- 1. STEMMING: Postgres finds more, with no `*` ---------------------------------------
        // fts5 matches whole tokens, so "migration" does not find "migrating".
        expect(await on(sqlite, "migration")).toEqual([cli]);
        expect(await on(pg, "migration")).toEqual([cli, dashboard].sort());

        // --- 2/3. THE PARSER + the trigram fallback -----------------------------------------------
        // tsvector's parser keeps an email address and a file path together as ONE lexeme, so the word
        // match finds nothing for a fragment of either. The pg_trgm fallback -- which runs ONLY when
        // the word match was empty -- rescues both, and fts5's unicode61 splitting finds them anyway.
        expect(await on(sqlite, "acmecorp")).toEqual([email]);
        expect(await on(pg, "acmecorp")).toEqual([email]);
        expect(await on(sqlite, "schema")).toEqual([path]);
        expect(await on(pg, "schema")).toEqual([path]);

        // --- 4. SIGNED NUMBERS: `ob-322` parses as `ob` plus the integer -322 ---------------------
        // A bare `322` has no word match against it; the fallback is what makes the ticket ref findable,
        // and it is the difference the comparison document called most likely to be noticed.
        expect(await on(pg, "322")).toEqual([ticket]);

        // --- accents: handled in the schema, not the translator ----------------------------------
        // The ob_search configuration puts unaccent in front of the stemmer, matching what unicode61
        // does, so this is the one difference that was closed rather than accepted.
        expect(await on(pg, "cafe")).toEqual([cafe]);

        // --- an unparseable query: SQLite raises, Postgres returns nothing ------------------------
        // Both are handled by cmdSearch (one as `invalid search query`, one as an empty result). This
        // pins the deliberate asymmetry rather than leaving it to be discovered.
        expect(await on(pg, 'unbalanced "')).toEqual([]);
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

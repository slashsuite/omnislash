// ob 337 pass 4: `ob search`, on whichever engine the store is.
//
// This is the one command in the port where the two engines do NOT do the same thing, and pretending
// otherwise would be the mistake. SQLite searches an fts5 virtual table (`item_fts`) maintained by hand
// through `syncFts`; Postgres searches a `search_vec` tsvector column that ob 322 declared GENERATED
// ALWAYS ... STORED on `item` itself, so it is recomputed by the very insert or update that changed the
// text and there is nothing to sync. There is no shared query that can address both.
//
// So the SQLite branch here is the pre-337 query, character for character, and the Postgres branch is
// ob 322's translator (`db/pg/search.ts`) reached only in postgres mode.
//
// THE ENGINES FIND DIFFERENT THINGS, AND THAT IS THE ACCEPTED OUTCOME OF 322, NOT A DEFECT.
// A measurement over 29 representative queries Postgres found
// MORE on 6 and found less on none, and the pg_trgm fallback is what carries three of those six. The
// differences are structural rather than incidental -- tsvector stems (`migration` finds "migrating"
// with no `*`), its parser keeps an email address or a file path together as ONE lexeme where fts5's
// unicode61 splits them on punctuation, and it drops stopwords. The trigram clause runs ONLY when the
// word match returned nothing, which is what makes it purely additive: it can never displace or reorder
// a real word hit, and one wrong guess about term-vs-substring cannot flood a good result set.
//
// The ORDER differs too and is not worth forcing into agreement. fts5 hands back rows in item_fts rowid
// order, which is the order the shadow rows happen to have been written and moves whenever an item's
// text is edited. Postgres is ordered explicitly by the item id as a number, which is creation order and
// is at least stable. What a caller can rely on on both engines is the SET of ids, not their sequence.
import type { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { asStore, type Store } from "./db/store.ts";

/**
 * The ids of every item matching an `ob search` query.
 *
 * Throws on a query fts5 rejects (a stray operator), which is the behaviour `ob search` already had and
 * reports as `invalid search query`. The Postgres branch cannot raise that: ob 322's translator treats
 * anything it does not recognise as a term, so an unparseable query returns no rows rather than an
 * error. That is a small, deliberate improvement rather than a divergence worth undoing.
 */
export async function searchItemIds(db: Database | Store, query: string): Promise<string[]> {
  const s = asStore(db);
  if (s.kind === "sqlite") {
    // Unchanged from the pre-337 query: fts5 virtual tables cannot be modelled by the query builder, so
    // this stays raw `sql` run through Drizzle.
    const rows = s.q.all(sql`SELECT item_id FROM item_fts WHERE item_fts MATCH ${query}`) as Array<{
      item_id: string;
    }>;
    return [...new Set(rows.map((r) => r.item_id))];
  }
  // Imported lazily and only on this branch, exactly as store.ts imports the driver: a SQLite process
  // must never load pg-core, and `db/pg/search.ts` pulls in the whole Postgres schema at module scope.
  const { itemSearch, runSearch } = await import("./db/pg/search.ts");
  const { item } = await import("./db/pg/schema.ts");
  const q = s.q as unknown as {
    select: (cols: unknown) => {
      from: (t: unknown) => {
        where: (w: unknown) => { orderBy: (o: unknown) => Promise<Array<{ item_id: string }>> };
      };
    };
  };
  const rows = await runSearch(itemSearch(query), (where) =>
    q
      .select({ item_id: item.id })
      .from(item)
      // CAST, not the raw text column: ids are decimal strings, so a plain text sort puts "10" before
      // "2". This is ordering only -- the rows are the same either way.
      .where(where)
      .orderBy(sql`CAST(${item.id} AS INTEGER)`),
  );
  return [...new Set(rows.map((r) => r.item_id))];
}

import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { Database } from "bun:sqlite";
import { sql as sqlTemplate, type SQL, type SQLWrapper } from "drizzle-orm";
import * as schema from "./schema.ts";

// Re-export the drizzle query operators through this bridge so consumers that live OUTSIDE apps/cli
// (the pillar domain modules — decision #26) can build queries without taking their own drizzle-orm
// dependency: drizzle-orm is a dep of apps/cli only, and resolving it from THIS file's location works.
export { eq, ne, desc, asc, and, or, not, gt, gte, lt, lte, like, inArray, notInArray, isNull, isNotNull, sql } from "drizzle-orm";
export type { SQL } from "drizzle-orm";
// unionAll lives in the sqlite-core subpath (not the drizzle-orm root); the split-aware
// category_contributions read model (domains/personal) composes its two legs with it.
export { unionAll } from "drizzle-orm/sqlite-core";

/**
 * A LIKE that means the same thing on both engines (ob 337l).
 *
 * `LIKE` is one of the very few operators whose SEMANTICS differ between the two dialects rather than its
 * spelling: SQLite's is case-INSENSITIVE for ASCII by default, Postgres's is case-SENSITIVE. A pattern
 * written against SQLite's behaviour (a word as a person types it, matched against text that arrives in
 * another case) turns into ZERO rows on Postgres. Not an error, not a crash: a search that quietly finds
 * nothing. That is the same failure shape as the string-aggregate trap, so the pattern comparison is
 * folded to lower case on both sides rather than left to the dialect.
 *
 * `lower()` on both, rather than Postgres's `ilike`: it is one expression valid in either dialect, and it
 * reproduces SQLite's ASCII folding exactly. It gives up an index, which costs nothing on tables this size
 * and would cost nothing on a scan these queries already do.
 *
 * The ESCAPE character is left alone deliberately, and it is worth knowing it differs: Postgres treats a
 * backslash in a LIKE pattern as an escape by default, SQLite treats it as a literal unless an
 * `ESCAPE` clause says otherwise. So `\%` escaping, which never worked on SQLite, starts working on
 * Postgres. That direction is a fix rather than a regression -- an escaped `%` now matches a literal `%`
 * instead of everything -- so it is reported rather than undone.
 */
export function likeCI(column: SQLWrapper, pattern: string): SQL {
  return sqlTemplate`lower(${column}) like lower(${pattern})`;
}

// Drizzle query layer over the existing bun:sqlite handle (095). One drizzle instance per DB handle
// (memoised). The DDL/migration harness stays raw for now (proven + FTS5-aware); this replaces the
// query sites. FTS MATCH search remains raw SQL — Drizzle doesn't model fts5 virtual tables.
const cache = new WeakMap<Database, BunSQLiteDatabase<typeof schema>>();

export function orm(db: Database): BunSQLiteDatabase<typeof schema> {
  let d = cache.get(db);
  if (!d) {
    d = drizzle(db, { schema });
    cache.set(db, d);
  }
  return d;
}

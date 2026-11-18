import type { SQL } from "bun";

/**
 * THE SEAM ob 321's ported schema drops into.
 *
 * The harness never imports the schema. It asks this module for two things and nothing else:
 *
 *   `id`         a string that changes whenever the schema changes. It names the cached template
 *                database, so a stale template can never be reused across a schema edit.
 *   `apply(sql)` runs against an EMPTY database and leaves the full schema in it. Called ONCE per test
 *                process, on the template; every test database is then a copy of that.
 *
 * When 321 lands, `apply` becomes the real migration chain -- the pg equivalent of `applyMigrations` in
 * `src/db.ts`, i.e. drizzle's `migrate(drizzle(sql), { migrationsFolder })` or a replay of
 * `src/db/migrations/*.sql` -- and `id` becomes the migration journal's last tag. Nothing else in the
 * harness moves, and no test changes: `freshPgDb()` keeps the same signature.
 *
 * Until then it is the fixture below: a schema of the same SHAPE as the real one (73 tables, mixed
 * scalar/jsonb/timestamptz columns, foreign keys, indexes, a text-search column), which is what the
 * harness's cost was measured against. The shape matters because the reset cost scales with the number of
 * tables, not with the number of rows.
 */
export interface PgSchemaSource {
  id: string;
  apply(sql: SQL): Promise<void>;
}

/**
 * The stand-in schema. Sized from the real one -- `src/db/schema.ts` declares 73 tables and 22 explicit
 * indexes -- so a measurement here transfers to the ported schema instead of flattering it.
 */
function fixtureDdl(): string {
  const parts: string[] = [];
  parts.push(`CREATE TABLE item (
  id serial PRIMARY KEY,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  priority integer NOT NULL DEFAULT 0,
  project text,
  cents integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)`);
  parts.push(`CREATE INDEX item_status_idx ON item (status, created_at)`);
  parts.push(`CREATE INDEX item_search_idx ON item USING gin (to_tsvector('english', title))`);
  parts.push(`CREATE TABLE note (
  id serial PRIMARY KEY,
  item_id integer NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
)`);
  parts.push(`CREATE INDEX note_item_idx ON note (item_id)`);
  // The bulk: same shape, enough of them to reproduce the real schema's reset cost.
  for (let i = 0; i < 71; i++) {
    parts.push(`CREATE TABLE fixture_${i} (
  id serial PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  n integer NOT NULL DEFAULT 0,
  cents integer,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
)`);
    if (i < 20) parts.push(`CREATE INDEX fixture_${i}_status_idx ON fixture_${i} (status, created_at)`);
  }
  return parts.join(";\n") + ";\n";
}

export const FIXTURE_SCHEMA: PgSchemaSource = {
  id: "fixture-v1",
  async apply(sql: SQL): Promise<void> {
    await sql.unsafe(fixtureDdl());
  },
};

let current: PgSchemaSource = FIXTURE_SCHEMA;

/**
 * Point the harness at a different schema. 321/phase 4 calls this once from `test/preload.ts` with the
 * real migration chain. A test that needs a schema of its own -- the migration-machinery tests, which
 * build their database deliberately empty or deliberately wrong -- takes `freshPgDatabase({ empty: true })`
 * and applies its own DDL, rather than moving this out from under every other test.
 */
export function setPgSchema(source: PgSchemaSource): void {
  current = source;
}

export function pgSchema(): PgSchemaSource {
  return current;
}

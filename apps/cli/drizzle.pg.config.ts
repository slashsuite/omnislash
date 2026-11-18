// ob 321: the POSTGRES half of the schema, generated alongside the live SQLite one (drizzle.config.ts).
// SQLite stays authoritative until phase 6 (ob 326); this config exists so `drizzle-kit generate` can
// diff src/db/pg/schema.ts against the snapshots in src/db/pg/migrations.
//
//   bunx drizzle-kit generate --config drizzle.pg.config.ts --name <what_changed>
//
// The chain RESTARTS at 0000 as a fresh Postgres baseline: the 27 SQLite migrations are history and are
// NOT replayed. From 0000 on, the same discipline as the SQLite chain applies -- additive and
// non-destructive, one statement per `--> statement-breakpoint` chunk (ob 223), and the .sql, the
// journal entry and meta/<idx>_snapshot.json always generated TOGETHER (ob 204), never hand-written.
//
// Only `generate` is used, exactly as on the SQLite side (ob 201): migrate/push/pull/studio need a
// driver this repo does not install and would touch a real database. Nothing applies these migrations
// yet -- the runtime applier is part of the cutover work, not of this phase.
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/pg/schema.ts",
  out: "./src/db/pg/migrations",
});

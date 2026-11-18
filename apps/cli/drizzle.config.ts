// Only `drizzle-kit generate` is used here, and it needs no database driver: it diffs schema.ts
// against the snapshots in ./src/db/migrations. Migrations are APPLIED at runtime by openDb() in
// src/db.ts, which reads THIS folder in drizzle's own format (meta/_journal.json + one <tag>.sql
// each, same bookkeeping table) but does the applying itself (ob 223) so each migration lands under
// an exclusive write lock and an unrecorded-but-present migration can be repaired rather than
// bricking every later open.
//
// ob 201: the driver-backed drizzle-kit commands (migrate/push/pull/studio) therefore do NOT work
// out of the box -- they ask for better-sqlite3 or @libsql/client, and better-sqlite3 was dropped
// because it forced a C toolchain (build-essential + python3, node-gyp) onto every machine that
// installs ob for a dependency nothing imported. If you ever need one of those commands, install a
// driver for that invocation rather than putting it back in package.json.
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: { url: process.env.INTROSPECT_DB ?? "/tmp/omnislash-introspect.sqlite" },
});

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

// The 097 schema fingerprint, lifted out of `platform/cli-db/test/db-migration.e2e.test.ts` so the REPLICA skew guard
// (183) and the migration safety-net share ONE notion of "what shape is this database". A second,
// slightly different fingerprint would be worse than either: the guard's whole job is to answer
// "does the server's schema match what this client understands", and it can only answer that if the
// answer is computed the same way the golden snapshot is.

/** Domain tables only: drizzle's bookkeeping table is migration-runner state, not part of the shape. */
export function tableNames(db: Database): string[] {
  return (
    db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '__drizzle_migrations' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

export function schemaFingerprint(db: Database): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const t of tableNames(db)) {
    out[t] = (
      db.query(`PRAGMA table_info("${t}")`).all() as {
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: unknown;
      }[]
    ).map((c) => ({
      name: c.name,
      type: c.type,
      notnull: c.notnull,
      pk: c.pk,
      dflt: c.dflt_value,
    }));
  }
  return out;
}

/** A short, comparable digest of the fingerprint, for storing beside a replica and comparing on read. */
export function schemaFingerprintHash(db: Database): string {
  return createHash("sha256").update(JSON.stringify(schemaFingerprint(db))).digest("hex").slice(0, 16);
}

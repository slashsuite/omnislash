import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "../../../apps/cli/src/db/schema.ts";

// 204: `drizzle-kit generate` diffs schema.ts against the LAST snapshot in migrations/meta, not against
// the .sql files. When migrations are hand-written without regenerating a snapshot, that last snapshot
// falls behind and generate emits CREATE TABLE for tables that already exist -- a file that is
// destructive by collision if anyone applies it. Nothing at runtime notices, because migrate() reads the
// .sql files, so only a test catches this. These two assertions are the whole guard: the newest journal
// entry must have a snapshot, and that snapshot must describe today's schema.ts.

const MIGRATIONS_DIR = join(import.meta.dir, "../../../apps/cli/src/db/migrations");
const META_DIR = join(MIGRATIONS_DIR, "meta");

type JournalEntry = { idx: number; tag: string };

function journalEntries(): JournalEntry[] {
  const raw = JSON.parse(readFileSync(join(META_DIR, "_journal.json"), "utf8")) as { entries: JournalEntry[] };
  return [...raw.entries].sort((a, b) => a.idx - b.idx);
}

/** drizzle names snapshots by zero-padded journal index, not by tag. */
function snapshotPath(idx: number): string {
  return join(META_DIR, `${String(idx).padStart(4, "0")}_snapshot.json`);
}

function schemaTableNames(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (is(value, SQLiteTable)) names.push(getTableName(value));
  }
  return names.sort();
}

describe("drizzle snapshot metadata (204)", () => {
  test("the newest journal entry has a snapshot beside it", () => {
    const entries = journalEntries();
    expect(entries.length).toBeGreaterThan(0);
    const last = entries[entries.length - 1]!;
    const path = snapshotPath(last.idx);
    expect({ tag: last.tag, hasSnapshot: existsSync(path) }).toEqual({ tag: last.tag, hasSnapshot: true });
  });

  test("that snapshot describes the tables schema.ts declares today", () => {
    const entries = journalEntries();
    const last = entries[entries.length - 1]!;
    const snapshot = JSON.parse(readFileSync(snapshotPath(last.idx), "utf8")) as { tables: Record<string, unknown> };
    expect(Object.keys(snapshot.tables).sort()).toEqual(schemaTableNames());
  });

  test("no snapshot is filed ahead of the journal", () => {
    const entries = journalEntries();
    const last = entries[entries.length - 1]!;
    expect(existsSync(snapshotPath(last.idx + 1))).toBe(false);
  });
});

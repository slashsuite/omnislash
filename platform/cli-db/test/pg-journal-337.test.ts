// ob 337 pass 4 — `ob log` (the standup journal) on both engines, over the same sequence.
//
// The event store is where two of the migration's silent differences meet at once:
//
//   * the idempotency probe compared payloads with IFNULL, which is a SQLite builtin Postgres does not
//     have. On Postgres that is an error, not a wrong answer -- but the shape it guards (record the same
//     event twice, get one row) is the thing worth proving rather than the spelling;
//   * the read orders by `ts`. `ts` is NOT NULL on both engines, so a DESC ordering here cannot meet the
//     NULLS-first (Postgres) vs NULLS-last (SQLite) split. Ties CAN differ, so `id` breaks them, and
//     three entries written at the same timestamp is exactly the case that proves it.
//
// Neither of those throws when it is wrong, so the only way to see them is to run the same sequence on
// both engines and diff the results. The Postgres side is the ob 325 harness: a real embedded cluster
// over a unix socket, no network and no live database.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { listJournal, logEntry, orderJournal } from "../../../apps/cli/src/commands/log.ts";
import { eventsForItemFor, recordEventFor } from "../../../apps/cli/src/events.ts";

const PG_BUDGET = spawnBudget(3);

async function exercise(store: Store): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const id = await createItem(store, { type: "task", title: "port ob log" });

  await logEntry(store, { type: "kudos", text: "unblocked me on the cutover", about: "sam-gh", ts: "2026-08-16T09:00:00Z" });
  await logEntry(store, { type: "comment", text: "the suite is flaky under load", ts: "2026-08-16T10:00:00Z" });
  await logEntry(store, { type: "suggestion", text: "gate it twice", itemId: id, ts: "2026-08-17T09:00:00Z" });

  out.all = (await listJournal(store)).map((e) => [e.type, e.text, e.about, e.itemId]);
  out.ordered = orderJournal(await listJournal(store)).map((e) => e.type);
  out.byType = (await listJournal(store, { type: "kudos" })).map((e) => e.text);
  out.since = (await listJournal(store, { since: "2026-08-17T00:00:00Z" })).map((e) => e.text);
  out.until = (await listJournal(store, { until: "2026-08-16T23:59:59Z" })).map((e) => e.text);

  // Idempotency: the same event recorded twice is ONE row. This is the IFNULL-vs-COALESCE path.
  await recordEventFor(store, { ts: "2026-08-18T09:00:00Z", source: "journal", type: "comment", payload: { text: "twice", about: null } });
  await recordEventFor(store, { ts: "2026-08-18T09:00:00Z", source: "journal", type: "comment", payload: { text: "twice", about: null } });
  out.afterDuplicate = (await listJournal(store, { since: "2026-08-18T00:00:00Z" })).map((e) => e.text);

  // A null payload on both sides of the probe -- the other half of the COALESCE.
  await recordEventFor(store, { ts: "2026-08-18T10:00:00Z", source: "journal", type: "comment" });
  await recordEventFor(store, { ts: "2026-08-18T10:00:00Z", source: "journal", type: "comment" });
  out.afterNullPayload = (await listJournal(store, { since: "2026-08-18T09:30:00Z" })).length;

  // Three entries at the SAME timestamp: `ts` alone leaves the order to the plan, so `id` breaks it.
  for (const text of ["tie a", "tie b", "tie c"]) {
    await recordEventFor(store, { ts: "2026-08-19T09:00:00Z", source: "journal", type: "comment", itemId: id, payload: { text, about: null } });
  }
  out.ties = (await listJournal(store, { since: "2026-08-19T00:00:00Z" })).map((e) => e.text);
  // eventsForItemFor is the DESC ordering, which is where a NULLS difference would land if `ts` were
  // nullable. It is not, on either engine -- this pins the tie-break instead.
  out.itemTrail = (await eventsForItemFor(store, id)).map((r) => r.ts);

  return out;
}

describe("ob 337 pass 4: the standup journal agrees across the two engines", () => {
  test(
    "ob log capture, filtering, idempotency and tie-breaking are identical on Postgres and on SQLite",
    async () => {
      const lease = await leaseRealPgDb();
      const dir = mkdtempSync(join(tmpdir(), "ob337j-"));
      const previousCreate = process.env.OMNISLASH_DB_CREATE;
      process.env.OMNISLASH_DB_CREATE = "1";
      let pg: Store | undefined;
      let sqlite: Store | undefined;
      try {
        pg = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
        sqlite = await openStore({ kind: "sqlite", path: join(dir, "omnislash.sqlite"), create: true });

        const fromPg = await exercise(pg);
        const fromSqlite = await exercise(sqlite);
        for (const key of Object.keys(fromSqlite)) {
          expect({ [key]: fromPg[key] }).toEqual({ [key]: fromSqlite[key] });
        }

        // Absolute anchors, so a bug that broke BOTH engines identically still fails here.
        expect(fromSqlite.ordered).toEqual(["kudos", "suggestion", "comment"]);
        expect(fromSqlite.byType).toEqual(["unblocked me on the cutover"]);
        expect(fromSqlite.since).toEqual(["gate it twice"]);
        expect(fromSqlite.until).toEqual(["unblocked me on the cutover", "the suite is flaky under load"]);
        expect(fromSqlite.afterDuplicate).toEqual(["twice"]);
        expect(fromSqlite.afterNullPayload).toBe(1);
        expect(fromSqlite.ties).toEqual(["tie a", "tie b", "tie c"]);
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

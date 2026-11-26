import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { nowIso } from "./db.ts";
import { orm } from "./db/orm.ts";
import { asStore, type Store } from "./db/store.ts";
import { event } from "./db/schema.ts";

export interface EventInput {
  ts: string;
  source: string; // github | linear | skill:<name>
  type: string; // ready_for_review | review_comment | review | state_change | ticket_completed | pr_synced | reopened
  itemId?: string | null;
  actor?: string | null;
  cause?: string | null; // bug | requirements (qa_rework only)
  payload?: unknown;
}

/**
 * Append an event. Events are the append-only raw measurement store keyed by the
 * external identifier inside `payload` (payload.entity for linear, payload.pr for
 * github). `itemId` is set only when a local item mirrors the external entity.
 * Idempotent per (source, type, ts, payload.key): a matching row is not duplicated,
 * so re-syncing the same window is safe.
 */
export function recordEvent(db: Database, e: EventInput): void {
  const payload = e.payload === undefined ? null : JSON.stringify(e.payload);
  const key = eventKey(e.source, e.type, e.ts, payload);
  const existing = orm(db)
    .select({ one: sql`1` })
    .from(event)
    .where(
      and(
        eq(event.source, e.source),
        eq(event.type, e.type),
        eq(event.ts, e.ts),
        sql`IFNULL(${event.payload}, '') = IFNULL(${payload}, '')`,
      ),
    )
    .limit(1)
    .get();
  if (existing) return;
  orm(db)
    .insert(event)
    .values({
      ts: e.ts,
      source: e.source,
      type: e.type,
      item_id: e.itemId ?? null,
      actor: e.actor ?? null,
      cause: e.cause ?? null,
      payload,
    })
    .run();
  void key;
}

function eventKey(source: string, type: string, ts: string, payload: string | null): string {
  return `${source}|${type}|${ts}|${payload ?? ""}`;
}

export interface EventRow {
  id: number;
  ts: string;
  source: string | null;
  type: string | null;
  item_id: string | null;
  actor: string | null;
  cause: string | null;
  payload: string | null;
}

export function eventsBetween(
  db: Database,
  opts: { source?: string; type?: string; since?: string; until?: string },
): EventRow[] {
  const conditions = [];
  if (opts.source) conditions.push(eq(event.source, opts.source));
  if (opts.type) conditions.push(eq(event.type, opts.type));
  if (opts.since) conditions.push(gte(event.ts, opts.since));
  if (opts.until) conditions.push(lte(event.ts, opts.until));
  return orm(db)
    .select()
    .from(event)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(event.ts))
    .all() as EventRow[];
}

/** Every event mirrored against a local item, newest-first — the `ob show`-level activity trail. */
export function eventsForItem(db: Database, id: string, limit = 50): EventRow[] {
  return orm(db)
    .select()
    .from(event)
    .where(eq(event.item_id, id))
    .orderBy(desc(event.ts))
    .limit(limit)
    .all() as EventRow[];
}

// --- the store-aware forms (337) --------------------------------------------------------------------
//
// `ob log` is ported; the twenty-eight other call sites of the three functions above are not, and every
// one of them sits inside a synchronous call chain through the connectors, metrics, alerts, audit and
// `ob show`'s detail block. So the event store follows the settings.ts precedent rather than dragging
// all of them into one change: the synchronous functions above stay exactly as they are, typed
// `Database` so it is obvious at the call site that they are the old sqlite-only path, and a ported
// caller uses the `...For` forms here.
//
// Neither can answer from the wrong engine. The synchronous ones are reachable only from a raw handle,
// and in postgres mode an unported command never gets one -- db.ts's guard refuses to open the file.
//
// TWO DIALECT DIFFERENCES ARE FIXED HERE RATHER THAN CARRIED OVER:
//   * IFNULL is a SQLite builtin Postgres does not have, so the idempotency probe uses COALESCE.
//   * ordering by `ts` alone left ties to fall wherever the plan put them, which is stable-ish on
//     SQLite (rowid order) and arbitrary on Postgres. `id` breaks them. `ts` is NOT NULL on both
//     engines (see the event table in db/schema.ts and db/pg/schema.ts), so neither ordering can meet
//     the NULLS-first (Postgres) vs NULLS-last (SQLite) difference -- that was checked, not assumed.

/** The store-aware form of `recordEvent`. Same idempotency: a matching row is not duplicated. */
export async function recordEventFor(db: Database | Store, e: EventInput): Promise<void> {
  const s = asStore(db);
  const payload = e.payload === undefined ? null : JSON.stringify(e.payload);
  const existing = (await s.q
    .select({ one: sql`1` })
    .from(s.t.event)
    .where(
      and(
        eq(s.t.event.source, e.source),
        eq(s.t.event.type, e.type),
        eq(s.t.event.ts, e.ts),
        sql`COALESCE(${s.t.event.payload}, '') = COALESCE(${payload}, '')`,
      ),
    )
    .limit(1)) as Array<{ one: unknown }>;
  if (existing.length > 0) return;
  await s.q.insert(s.t.event).values({
    ts: e.ts,
    source: e.source,
    type: e.type,
    item_id: e.itemId ?? null,
    actor: e.actor ?? null,
    cause: e.cause ?? null,
    payload,
  });
}

/** The store-aware form of `eventsBetween`, oldest-first with `id` breaking ties. */
export async function eventsBetweenFor(
  db: Database | Store,
  opts: { source?: string | undefined; type?: string | undefined; since?: string | undefined; until?: string | undefined },
): Promise<EventRow[]> {
  const s = asStore(db);
  const conditions = [];
  if (opts.source) conditions.push(eq(s.t.event.source, opts.source));
  if (opts.type) conditions.push(eq(s.t.event.type, opts.type));
  if (opts.since) conditions.push(gte(s.t.event.ts, opts.since));
  if (opts.until) conditions.push(lte(s.t.event.ts, opts.until));
  return (await s.q
    .select()
    .from(s.t.event)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(s.t.event.ts), asc(s.t.event.id))) as EventRow[];
}

/**
 * The store-aware form of `eventsForItem`, newest-first with `id` breaking ties.
 *
 * `filter` narrows to one kind of event in the STORE rather than in the caller (1515: an item's
 * decisions are read back on their own, and filtering a page of the item's newest events would lose a
 * decision behind a busy item's github/linear noise). The un-filtered call is the activity block.
 */
export async function eventsForItemFor(
  db: Database | Store,
  id: string,
  limit = 50,
  filter: { source?: string; notSource?: string; type?: string; types?: string[] } = {},
): Promise<EventRow[]> {
  const s = asStore(db);
  const conditions = [eq(s.t.event.item_id, id)];
  if (filter.source) conditions.push(eq(s.t.event.source, filter.source));
  if (filter.notSource) conditions.push(ne(s.t.event.source, filter.notSource));
  if (filter.type) conditions.push(eq(s.t.event.type, filter.type));
  if (filter.types?.length) conditions.push(inArray(s.t.event.type, filter.types));
  return (await s.q
    .select()
    .from(s.t.event)
    .where(and(...conditions))
    .orderBy(desc(s.t.event.ts), desc(s.t.event.id))
    .limit(limit)) as EventRow[];
}

export function parsePayload<T = Record<string, unknown>>(row: EventRow): T {
  if (!row.payload) return {} as T;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return {} as T;
  }
}

export { nowIso };

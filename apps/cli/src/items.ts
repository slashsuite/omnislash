// ob 337: the first apps/cli module through ob 324's store seam.
//
// This is the module the cutover smoke test runs on: `ob next`, `ob show`, `ob add`, `ob close` and
// `ob status` all read and write the tracker through here.
//
// TWO CONVENTIONS RUN THROUGH THE WHOLE FILE.
//
// 1. Every function takes `Database | Store` and normalises with asStore. The signature WIDENS rather
//    than changes, so the ~100 unported callers and every existing test keep passing the raw handle they
//    already have and keep getting byte-identical sqlite behaviour, while a ported caller passes a store
//    and reaches Postgres. That is what makes this landable in pieces.
//
// 2. Every function is async and every builder is AWAITED. `.all()` / `.get()` / `.run()` are the sqlite
//    dialect's synchronous terminators and do not exist on pg-core; awaiting works on both. `.get()` has
//    no await-equivalent, so a single-row read becomes `(await ...limit(1))[0] ?? null` -- the limit(1)
//    is not decoration, it is what `.get()` did.
//
// THE THREE SILENT DIFFERENCES ob 324 PAID FOR, and where they bite in here:
//   - aggregates come back from Postgres as STRINGS (count(*), max(...)), so `a + b` silently becomes
//     string concatenation with no error. triageCount and nextId both go through readNumber.
//   - booleans are 0/1 integers. Not an issue in this file: `triage` was already an integer column
//     written as 0/1 rather than a { mode: "boolean" } one, so it needs no store.bool.
//   - json columns are text. No json column is read here.
// Plus a fourth that is specific to this file: IFNULL is SQLite-only, so nextId uses COALESCE.
import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, gte, inArray, ne, not, or, sql } from "drizzle-orm";
import { nowIso } from "./db.ts";
import { defaultStatus, NON_QUEUE_TYPES } from "./status.ts";
import { eventsForItemFor, parsePayload, recordEventFor } from "./events.ts";
import { asStore, readNumber, type Store } from "./db/store.ts";
import { assignRef, keyForProject, rerefAfterMove, resolveItemId } from "./refs.ts";
import { recordPriorityChange, type DecisionOpts } from "./decisions.ts";
import {
  decisionDetail,
  item,
  itemLink,
  itemTag,
  learningDetail,
  linearRef,
  project,
  roadmapDetail,
  tag,
  taskDetail,
} from "./db/schema.ts";

export interface ItemRow {
  id: string;
  /** The per-project ref (`PS-12`, 1949), or null for an item in a project with no key. */
  ref: string | null;
  type: string;
  title: string;
  body: string | null;
  status: string;
  project_id: string | null;
  priority: number | null;
  today_rank: number | null;
  /** OB-2083: the item's place in its project's execution queue; null = unranked. */
  queue_rank: number | null;
  block_reason: string | null;
  block_owner: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  triage: number | null;
  origin_repo: string | null;
  project_name: string | null;
  project_kind: string | null;
}

// item.* + the joined project name/kind, as a flat snake_case row (mirrors the old SELECT_ITEM view).
const ITEM_COLS = {
  id: item.id,
  ref: item.ref,
  type: item.type,
  title: item.title,
  body: item.body,
  status: item.status,
  project_id: item.project_id,
  priority: item.priority,
  today_rank: item.today_rank,
  queue_rank: item.queue_rank,
  block_reason: item.block_reason,
  block_owner: item.block_owner,
  created_at: item.created_at,
  updated_at: item.updated_at,
  closed_at: item.closed_at,
  triage: item.triage,
  origin_repo: item.origin_repo,
  project_name: project.name,
  project_kind: project.kind,
} as const;

/** The item `id` names: a legacy number, a ref (`PS-12`, any case) or an alias a move left behind. */
export async function getItem(db: Database | Store, id: string): Promise<ItemRow | null> {
  const s = asStore(db);
  id = (await resolveItemId(s, id)) ?? id;
  const rows = (await s.q
    .select(ITEM_COLS)
    .from(s.t.item)
    .leftJoin(s.t.project, eq(s.t.item.project_id, s.t.project.id))
    .where(eq(s.t.item.id, id))
    .limit(1)) as ItemRow[];
  return rows[0] ?? null;
}

async function nextId(s: Store): Promise<string> {
  // COALESCE, not IFNULL: IFNULL is a SQLite builtin that Postgres does not have, and COALESCE is
  // standard and identical on both. readNumber because MAX over an integer comes back from Postgres as
  // a STRING -- un-coerced, the `+ 1` here would make the next id after 99 be "991" rather than 100.
  const rows = (await s.q
    .select({ n: sql<number>`COALESCE(MAX(CAST(${s.t.item.id} AS INTEGER)), 0) + 1` })
    .from(s.t.item)
    .limit(1)) as Array<{ n: number }>;
  return String(readNumber(rows[0]?.n));
}

// item_fts is a plain fts5 virtual table with no DB triggers, so it's maintained by hand.
// fts5 can't be modeled by the query builder — this stays raw `sql` (run through Drizzle, not db.query).
//
// SQLITE ONLY, and that is not a gap (337). ob 322 replaced the fts5 virtual tables with a `search_vec`
// tsvector column on the table itself, declared GENERATED ALWAYS ... STORED from title/body, so Postgres
// recomputes it as part of the very insert or update that changed the text. There is nothing to sync by
// hand there, and issuing this against Postgres would be an error about a table that does not exist.
async function syncFts(s: Store, id: string, title: string, body: string | null): Promise<void> {
  if (s.kind !== "sqlite") return;
  await s.q.run(sql`DELETE FROM item_fts WHERE item_id = ${id}`);
  await s.q.run(sql`INSERT INTO item_fts(item_id, title, body) VALUES(${id}, ${title}, ${body ?? ""})`);
}

export interface RoadmapDetailInput {
  targetDate?: string | null;
  sourceRef?: string | null;
  owner?: string | null;
}

export interface DecisionDetailInput {
  context?: string | null;
  choice?: string | null;
  rationale?: string | null;
  alternatives?: string | null;
  decidedAt?: string | null;
  /** OB-2097: how sure, and how to change it. */
  doubt?: string | null;
  undo?: string | null;
}

export interface LearningDetailInput {
  kind?: string | null;
  progress?: string | null;
  source?: string | null;
  why?: string | null;
}

export interface CreateItemInput {
  type: string;
  title: string;
  body?: string | null;
  status?: string;
  projectId?: string | null;
  priority?: number | null;
  tags?: string[];
  linkUrl?: string | null;
  triage?: boolean;
  originRepo?: string | null;
  roadmap?: RoadmapDetailInput;
  decision?: DecisionDetailInput;
  learning?: LearningDetailInput;
}

export async function createItem(db: Database | Store, input: CreateItemInput): Promise<string> {
  // Store.txn rather than writeTxn (317): writeTxn is built on db.transaction(), which bun:sqlite
  // requires to have a synchronous body, and everything below awaits. The body uses `s`, the store bound
  // to the transaction, and never the outer one -- on Postgres the outer store is the connection POOL,
  // so a write issued through it would leave the transaction and neither commit nor roll back with it.
  return asStore(db).txn("create the item", async (s) => {
    const id = await nextId(s);
    const ts = nowIso();
    const status = input.status ?? defaultStatus(input.type);
    await s.q
      .insert(s.t.item)
      .values({
        id,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        status,
        project_id: input.projectId ?? null,
        priority: input.priority ?? null,
        today_rank: null,
        created_at: ts,
        updated_at: ts,
        // OB-1928: an item born done is closed now, the same stamp setStatus gives a close.
        closed_at: status === "done" ? ts : null,
        triage: input.triage ? 1 : 0,
        origin_repo: input.originRepo ?? null,
      });
    // 1949: the per-project ref, allocated in THIS transaction so concurrent adds never share a seq.
    const key = await keyForProject(s, input.projectId ?? null);
    if (key) await assignRef(s, id, key);
    if (input.type === "task") {
      await s.q.insert(s.t.taskDetail).values({ item_id: id });
    }
    if (input.type === "linear_ref") {
      await s.q.insert(s.t.linearRef).values({ item_id: id });
    }
    if (input.type === "roadmap") {
      const r = input.roadmap ?? {};
      await s.q
        .insert(s.t.roadmapDetail)
        .values({ itemId: id, targetDate: r.targetDate ?? null, sourceRef: r.sourceRef ?? null, owner: r.owner ?? null });
    }
    if (input.type === "decision") {
      const d = input.decision ?? {};
      await s.q
        .insert(s.t.decisionDetail)
        .values({
          item_id: id,
          context: d.context ?? null,
          choice: d.choice ?? null,
          rationale: d.rationale ?? null,
          alternatives: d.alternatives ?? null,
          decided_at: d.decidedAt ?? ts,
          doubt: d.doubt ?? null,
          undo: d.undo ?? null,
        });
    }
    if (input.type === "learning") {
      const l = input.learning ?? {};
      await s.q
        .insert(s.t.learningDetail)
        .values({ item_id: id, kind: l.kind ?? null, progress: l.progress ?? null, source: l.source ?? null, why: l.why ?? null });
    }
    await syncFts(s, id, input.title, input.body ?? null);
    if (input.tags) await addTags(s, id, input.tags);
    if (input.linkUrl) await attachLinear(s, id, input.linkUrl);
    return id;
  });
}

export async function getRoadmapDetail(db: Database | Store, id: string): Promise<Record<string, unknown> | null> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ item_id: s.t.roadmapDetail.itemId, target_date: s.t.roadmapDetail.targetDate, source_ref: s.t.roadmapDetail.sourceRef, owner: s.t.roadmapDetail.owner })
    .from(s.t.roadmapDetail)
    .where(eq(s.t.roadmapDetail.itemId, id))
    .limit(1)) as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

export async function getDecisionDetail(db: Database | Store, id: string): Promise<Record<string, unknown> | null> {
  const s = asStore(db);
  const rows = (await s.q
    .select()
    .from(s.t.decisionDetail)
    .where(eq(s.t.decisionDetail.item_id, id))
    .limit(1)) as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

export async function getLearningDetail(db: Database | Store, id: string): Promise<Record<string, unknown> | null> {
  const s = asStore(db);
  const rows = (await s.q
    .select()
    .from(s.t.learningDetail)
    .where(eq(s.t.learningDetail.item_id, id))
    .limit(1)) as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/** The type-specific extension-table row for any item (for generic `ob show`). */
export async function getDetail(db: Database | Store, type: string, id: string): Promise<Record<string, unknown> | null> {
  switch (type) {
    case "task":
      return getTaskDetail(db, id);
    case "roadmap":
      return getRoadmapDetail(db, id);
    case "decision":
      return getDecisionDetail(db, id);
     case "learning":
       return getLearningDetail(db, id);
     default:
       return null;
  }
}

async function touch(s: Store, id: string): Promise<void> {
  await s.q.update(s.t.item).set({ updated_at: nowIso() }).where(eq(s.t.item.id, id));
}

export async function setStatus(db: Database | Store, id: string, status: string): Promise<void> {
  const s = asStore(db);
  const now = nowIso();
  const current = (await s.q
    .select({ type: s.t.item.type })
    .from(s.t.item)
    .where(eq(s.t.item.id, id))
    .limit(1)) as Array<{ type: string }>;
  if (status === "done") {
    // COALESCE, not an overwrite: `canTransition` allows done -> done, so re-closing an already-closed item
    // used to reset `closed_at` to today. The `issue-open-but-landed` drift row (77) is precisely the
    // already-done case and its printed remedy is `ob close <id>`, so following the tool's own advice
    // silently moved the completion date that reports and the journal read back. A reopen clears the column,
    // so a genuine reopen -> close still stamps a fresh date.
    await s.q
      .update(s.t.item)
      .set({ status, closed_at: sql`COALESCE(${s.t.item.closed_at}, ${now})`, updated_at: now })
      .where(eq(s.t.item.id, id));
  } else {
    await s.q.update(s.t.item).set({ status, closed_at: null, updated_at: now }).where(eq(s.t.item.id, id));
  }
}

export async function setBlocked(
  db: Database | Store,
  id: string,
  reason: string | null,
  owner: string | null,
): Promise<void> {
  const s = asStore(db);
  await s.q
    .update(s.t.item)
    .set({ status: "blocked", block_reason: reason, block_owner: owner, updated_at: nowIso() })
    .where(eq(s.t.item.id, id));
}

/** Leave `blocked` for `status`: the status goes through `setStatus` (so closed_at follows it), then the block fields clear. */
export async function clearBlock(db: Database | Store, id: string, status: string): Promise<void> {
  const s = asStore(db);
  await setStatus(s, id, status);
  await s.q.update(s.t.item).set({ block_reason: null, block_owner: null }).where(eq(s.t.item.id, id));
}

export interface EditFields {
  title?: string;
  body?: string;
  priority?: number | null;
  projectId?: string | null;
}

/**
 * OS-26: a priority that actually changes the stored value leaves one `priority_change` event on the Decisions
 * trail, written in the same transaction as the update. `decision` says who (`--holder`, `dashboard`) and why.
 */
export async function editItem(
  db: Database | Store,
  id: string,
  fields: EditFields,
  decision: DecisionOpts = {},
): Promise<void> {
  const s = asStore(db);
  const set: Partial<typeof item.$inferInsert> = {};
  if (fields.title !== undefined) set.title = fields.title;
  if (fields.body !== undefined) set.body = fields.body;
  if (fields.priority !== undefined) {
    set.priority = fields.priority;
    // Setting a priority IS triaging the item: it clears the triage-inbox flag.
    set.triage = 0;
  }
  if (fields.projectId !== undefined) set.project_id = fields.projectId;
  if (Object.keys(set).length > 0) {
    set.updated_at = nowIso();
    await s.txn("edit the item", async (tx) => {
      let priorityFrom: number | null | undefined;
      if (fields.priority !== undefined) {
        const cur = (await tx.q
          .select({ priority: tx.t.item.priority })
          .from(tx.t.item)
          .where(eq(tx.t.item.id, id))
          .limit(1)) as Array<{ priority: number | null }>;
        if (cur.length > 0) priorityFrom = cur[0]!.priority;
      }
      await keepReferenceVersion(tx, id, set.title, set.body ?? undefined);
      await tx.q.update(tx.t.item).set(set).where(eq(tx.t.item.id, id));
      // 1949: a move to a project with another key takes a new ref; the old one stays as an alias.
      if (fields.projectId !== undefined) await rerefAfterMove(tx, id, fields.projectId);
      // The stored value, compared as stored: unset (null) and `none` (0) differ, since an unset item in the
      // focus project reads as high.
      const to = fields.priority ?? null;
      if (priorityFrom !== undefined && priorityFrom !== to) {
        await recordPriorityChange(tx, id, priorityFrom, to, decision);
      }
    });
  }
  const row = await getItem(s, id);
  if (row) await syncFts(s, id, row.title, row.body);
}

export async function appendNote(db: Database | Store, id: string, text: string): Promise<void> {
  const s = asStore(db);
  const row = await getItem(s, id);
  if (!row) return;
  const stamp = `[${nowIso()}] ${text}`;
  const body = row.body && row.body.length > 0 ? `${row.body}\n${stamp}` : stamp;
  // A reference keeps the version this note replaces, in the same transaction as the write (OB-2004), and
  // builds the new body from the row as the transaction sees it, so two notes never overwrite each other.
  // Any other type takes the one statement it always did.
  if (row.type === "reference") {
    const written = await s.txn("append the note", async (tx) => {
      const prev = (await lockReference(tx, row.id)) ?? row;
      const next = prev.body && prev.body.length > 0 ? `${prev.body}\n${stamp}` : stamp;
      await keepReferenceVersion(tx, prev.id, undefined, next);
      await tx.q.update(tx.t.item).set({ body: next, updated_at: nowIso() }).where(eq(tx.t.item.id, row.id));
      return next;
    });
    await syncFts(s, id, row.title, written);
    return;
  }
  await s.q.update(s.t.item).set({ body, updated_at: nowIso() }).where(eq(s.t.item.id, id));
  await syncFts(s, id, row.title, body);
}

// --- reference documents (OB-2004) ------------------------------------------------------------------

/** The event a reference's replaced text is kept in. */
export const REFERENCE_VERSION_SOURCE = "ob";
export const REFERENCE_VERSION_TYPE = "reference_version";

export interface ReferenceVersion {
  /** 1 is the oldest version kept. */
  n: number;
  title: string;
  body: string;
  /** When this text was replaced by the next one. */
  replaced_at: string;
}

/**
 * The reference `id` as it stands now, with its row locked until the transaction ends; null for any other
 * type. The no-op UPDATE takes the row lock on Postgres (read committed): a second writer waits here, and
 * its next SELECT then sees the first writer's committed text, so the version it keeps is the text it really
 * replaces. SQLite already serialises writers (BEGIN IMMEDIATE).
 */
async function lockReference(s: Store, id: string): Promise<ItemRow | null> {
  const first = await getItem(s, id);
  if (!first || first.type !== "reference") return null;
  await s.q.update(s.t.item).set({ updated_at: nowIso() }).where(eq(s.t.item.id, id));
  return getItem(s, id);
}

/**
 * Keep what a reference is about to lose. Called inside the write's own transaction with the PREVIOUS
 * row still in place, so a failed write keeps no version and a kept version always has its write. Does
 * nothing for any other type, and nothing when the title and body come out unchanged. The payload carries
 * the item id because `recordEventFor` dedupes on source, type, ts and payload but not `item_id`.
 */
async function keepReferenceVersion(
  s: Store,
  id: string,
  title: string | undefined,
  body: string | undefined,
): Promise<void> {
  if (title === undefined && body === undefined) return;
  const prev = await lockReference(s, id);
  if (!prev) return;
  const changed = (title !== undefined && title !== prev.title) || (body !== undefined && body !== (prev.body ?? ""));
  if (!changed) return;
  const at = nowIso();
  await recordEventFor(s, {
    ts: at,
    source: REFERENCE_VERSION_SOURCE,
    type: REFERENCE_VERSION_TYPE,
    itemId: prev.id,
    payload: { item_id: prev.id, title: prev.title, body: prev.body ?? "", replaced_at: at },
  });
}

/** A reference's earlier versions, oldest first (n = 1 is the original text). */
export async function referenceVersions(db: Database | Store, id: string): Promise<ReferenceVersion[]> {
  const s = asStore(db);
  const rows = await eventsForItemFor(s, id, 1_000_000, {
    source: REFERENCE_VERSION_SOURCE,
    type: REFERENCE_VERSION_TYPE,
  });
  return rows
    .reverse()
    .map((r, i) => {
      const p = parsePayload<{ title?: string; body?: string; replaced_at?: string }>(r);
      return { n: i + 1, title: p.title ?? "", body: p.body ?? "", replaced_at: p.replaced_at ?? r.ts };
    });
}

export async function deleteItem(db: Database | Store, id: string): Promise<void> {
  await asStore(db).txn("delete the item", async (s) => {
    // sqlite only, for syncFts's reason: on Postgres the search vector is a generated column ON item, so
    // deleting the row deletes the index entry with it and there is no second table to clean up.
    if (s.kind === "sqlite") await s.q.run(sql`DELETE FROM item_fts WHERE item_id = ${id}`);
    // A reference's kept versions go with it: they hold the whole old text and `event.item_id` would only
    // null out, leaving rows nothing can read or remove (OB-2004).
    await s.q
      .delete(s.t.event)
      .where(
        and(
          eq(s.t.event.item_id, id),
          eq(s.t.event.source, REFERENCE_VERSION_SOURCE),
          eq(s.t.event.type, REFERENCE_VERSION_TYPE),
        ),
      );
    await s.q.delete(s.t.item).where(eq(s.t.item.id, id));
  });
}

export async function addTags(db: Database | Store, id: string, tags: string[]): Promise<void> {
  const s = asStore(db);
  for (const raw of tags) {
    const name = raw.trim().toLowerCase();
    if (name.length === 0) continue;
    await s.q.insert(s.t.tag).values({ name }).onConflictDoNothing({ target: s.t.tag.name });
    const found = (await s.q
      .select({ id: s.t.tag.id })
      .from(s.t.tag)
      .where(eq(s.t.tag.name, name))
      .limit(1)) as Array<{ id: number }>;
    const t = found[0];
    if (!t) continue;
    await s.q.insert(s.t.itemTag).values({ itemId: id, tagId: t.id }).onConflictDoNothing();
  }
  await touch(s, id);
}

export async function removeTags(db: Database | Store, id: string, tags: string[]): Promise<void> {
  const s = asStore(db);
  for (const raw of tags) {
    const name = raw.trim().toLowerCase();
    const found = (await s.q
      .select({ id: s.t.tag.id })
      .from(s.t.tag)
      .where(eq(s.t.tag.name, name))
      .limit(1)) as Array<{ id: number }>;
    const t = found[0];
    if (!t) continue;
    await s.q.delete(s.t.itemTag).where(and(eq(s.t.itemTag.itemId, id), eq(s.t.itemTag.tagId, t.id)));
  }
  await touch(s, id);
}

/** OS-25: the item count and the latest `updated_at`, as `<count>@<time>`. One aggregate read: the realtime
 *  snapshot carries it so a page listing items learns that one changed (an `ob order` stamps the item it moved,
 *  an add or rm moves the count). */
export async function itemsStamp(db: Database | Store): Promise<string> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ n: sql<number | string>`count(*)`, at: sql<string | null>`max(${s.t.item.updated_at})` })
    .from(s.t.item)) as Array<{ n: number | string; at: string | null }>;
  return `${String(rows[0]?.n ?? 0)}@${rows[0]?.at ?? ""}`;
}

/** OS-25: the tags of many items in one read, each list sorted by name; an item with none is absent. */
export async function tagsForItems(db: Database | Store, ids: readonly string[]): Promise<Map<string, string[]>> {
  const s = asStore(db);
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const rows = (await s.q
    .select({ id: s.t.itemTag.itemId, name: s.t.tag.name })
    .from(s.t.itemTag)
    .innerJoin(s.t.tag, eq(s.t.itemTag.tagId, s.t.tag.id))
    .where(inArray(s.t.itemTag.itemId, [...ids]))
    .orderBy(asc(s.t.tag.name))) as Array<{ id: string; name: string }>;
  for (const r of rows) out.set(r.id, [...(out.get(r.id) ?? []), r.name]);
  return out;
}

export async function getTags(db: Database | Store, id: string): Promise<string[]> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ name: s.t.tag.name })
    .from(s.t.itemTag)
    .innerJoin(s.t.tag, eq(s.t.itemTag.tagId, s.t.tag.id))
    .where(eq(s.t.itemTag.itemId, id))
    .orderBy(asc(s.t.tag.name))) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export async function addLink(db: Database | Store, from: string, rel: string, to: string): Promise<void> {
  const s = asStore(db);
  await s.q
    .insert(s.t.itemLink)
    .values({ fromItem: from, toItem: to, relType: rel })
    .onConflictDoNothing();
}

export interface LinkRow {
  rel_type: string;
  other: string;
  direction: "out" | "in";
}

export async function getLinks(db: Database | Store, id: string): Promise<LinkRow[]> {
  const s = asStore(db);
  const out = (await s.q
    .select({ rel_type: s.t.itemLink.relType, other: s.t.itemLink.toItem })
    .from(s.t.itemLink)
    .where(eq(s.t.itemLink.fromItem, id))) as Array<{ rel_type: string; other: string }>;
  const inc = (await s.q
    .select({ rel_type: s.t.itemLink.relType, other: s.t.itemLink.fromItem })
    .from(s.t.itemLink)
    .where(eq(s.t.itemLink.toItem, id))) as Array<{ rel_type: string; other: string }>;
  return [
    ...out.map((r) => ({ ...r, direction: "out" as const })),
    ...inc.map((r) => ({ ...r, direction: "in" as const })),
  ];
}

export interface LinearRefRow {
  item_id: string;
  linear_id: string | null;
  url: string | null;
  cached_title: string | null;
  cached_state: string | null;
  cached_priority: number | null;
  last_synced_at: string | null;
}

export async function getLinearRef(db: Database | Store, id: string): Promise<LinearRefRow | null> {
  const s = asStore(db);
  const rows = (await s.q
    .select()
    .from(s.t.linearRef)
    .where(eq(s.t.linearRef.item_id, id))
    .limit(1)) as LinearRefRow[];
  return rows[0] ?? null;
}

function parseLinearId(url: string): string | null {
  const m = url.match(/([A-Z][A-Z0-9]+-\d+)/);
  return m ? m[1]! : null;
}

export async function attachLinear(db: Database | Store, id: string, url: string): Promise<void> {
  const s = asStore(db);
  const linearId = parseLinearId(url);
  await s.q
    .insert(s.t.linearRef)
    .values({ item_id: id, linear_id: linearId, url })
    .onConflictDoUpdate({
      target: s.t.linearRef.item_id,
      // `excluded.*` is the same spelling in both dialects, so this raw fragment travels unchanged.
      set: { linear_id: sql`excluded.linear_id`, url: sql`excluded.url` },
    });
  await touch(s, id);
}

export async function getTaskDetail(db: Database | Store, id: string): Promise<Record<string, unknown> | null> {
  const s = asStore(db);
  const rows = (await s.q
    .select()
    .from(s.t.taskDetail)
    .where(eq(s.t.taskDetail.item_id, id))
    .limit(1)) as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

export interface ListFilters {
  open?: boolean;
  status?: string;
  type?: string;
  projectId?: string;
  tag?: string;
  since?: string;
  updatedAfter?: string;
}

export async function queryItems(db: Database | Store, filters: ListFilters): Promise<ItemRow[]> {
  const s = asStore(db);
  const conds = [];
  if (filters.open) {
    conds.push(ne(s.t.item.status, "done"));
    conds.push(not(inArray(s.t.item.type, NON_QUEUE_TYPES)));
  }
  if (filters.status) conds.push(eq(s.t.item.status, filters.status));
  if (filters.type) conds.push(eq(s.t.item.type, filters.type));
  if (filters.projectId) conds.push(eq(s.t.item.project_id, filters.projectId));
  if (filters.since) conds.push(gte(s.t.item.created_at, filters.since));
  if (filters.updatedAfter) conds.push(gte(s.t.item.updated_at, filters.updatedAfter));
  if (filters.tag) {
    conds.push(
      inArray(
        s.t.item.id,
        s.q
          .select({ id: s.t.itemTag.itemId })
          .from(s.t.itemTag)
          .innerJoin(s.t.tag, eq(s.t.itemTag.tagId, s.t.tag.id))
          .where(eq(s.t.tag.name, filters.tag.trim().toLowerCase())),
      ),
    );
  }
  // Ordered explicitly (337). This had no ORDER BY: sqlite happened to return rows in rowid order, which
  // is insertion order, and every caller then sorted in JS with ties left to fall where they fell. An
  // unordered Postgres select gives whatever order the plan produces, so the tie-breaking would differ
  // between engines and `ob next` would list two equal-priority items in a different order on each. A
  // stable, non-null key removes the question -- and it is `id`, not `created_at`, precisely because it
  // cannot be null and so cannot meet the NULLS-first/NULLS-last difference between the two engines.
  return (await s.q
    .select(ITEM_COLS)
    .from(s.t.item)
    .leftJoin(s.t.project, eq(s.t.item.project_id, s.t.project.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(s.t.item.id))) as ItemRow[];
}

// --- triage inbox (issue #56) ---

/** Items still awaiting triage (triage flag set), newest-first. */
export async function triageInbox(db: Database | Store): Promise<ItemRow[]> {
  const s = asStore(db);
  return (await s.q
    .select(ITEM_COLS)
    .from(s.t.item)
    .leftJoin(s.t.project, eq(s.t.item.project_id, s.t.project.id))
    .where(eq(s.t.item.triage, 1))
    // created_at is NOT NULL, so the DESC ordering here cannot hit the NULLS-first (Postgres) vs
    // NULLS-last (SQLite) difference. id breaks ties so two items created in the same millisecond do
    // not swap places between engines.
    .orderBy(desc(s.t.item.created_at), asc(s.t.item.id))) as ItemRow[];
}

/** OS-178: the triage count inside a set of projects (a scoped API token's view). */
export async function triageCountIn(db: Database | Store, projectIds: ReadonlySet<string>): Promise<number> {
  if (projectIds.size === 0) return 0;
  const s = asStore(db);
  const rows = (await s.q
    .select({ n: sql<number>`count(*)` })
    .from(s.t.item)
    .where(and(eq(s.t.item.triage, 1), inArray(s.t.item.project_id, [...projectIds])))
    .limit(1)) as Array<{ n: number }>;
  return readNumber(rows[0]?.n);
}

/** How many items are awaiting triage (drives the ob next / ob status banner). */
export async function triageCount(db: Database | Store): Promise<number> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ n: sql<number>`count(*)` })
    .from(s.t.item)
    .where(eq(s.t.item.triage, 1))
    .limit(1)) as Array<{ n: number }>;
  // readNumber: count(*) is bigint on Postgres and Bun's SQL client hands bigint back as a STRING. The
  // banner reads `n > 0`, and "0" > 0 is false while "0" is truthy -- so an un-coerced count is exactly
  // the kind of value that behaves correctly in one place and wrongly in the next.
  return readNumber(rows[0]?.n);
}

// --- the pre-port synchronous bridges (337) --------------------------------------------------------
//
// SQLITE ONLY, AND TEMPORARY. Two unported callers read items from deep inside synchronous call chains:
// `assembleSuggestContext` (whatsapp, called synchronously from converse.ts and from eight test sites)
// and `spinoffTicketTags` (reached through the launch path, which returns plain values
// into synchronous code). Making either async would ripple through whatsapp and the 3000-line spinoff
// module, which is a much larger change than the one this ticket is landing and is not needed by any of
// the commands being ported.
//
// So they keep a synchronous path, and it is spelled `...Sync` and typed `Database` so that it is
// obvious at every call site that this is the OLD path and cannot reach Postgres. It is not a second
// mechanism competing with the store seam: it is the same query, and it exists to be DELETED by the
// ticket that ports whatsapp and spinoff, at which point these two functions go with it.
export function queryItemsSync(db: Database, filters: ListFilters): ItemRow[] {
  const s = asStore(db);
  const conds = [];
  if (filters.open) {
    conds.push(ne(item.status, "done"));
    conds.push(not(inArray(item.type, NON_QUEUE_TYPES)));
  }
  if (filters.status) conds.push(eq(item.status, filters.status));
  if (filters.type) conds.push(eq(item.type, filters.type));
  if (filters.projectId) conds.push(eq(item.project_id, filters.projectId));
  if (filters.since) conds.push(gte(item.created_at, filters.since));
  if (filters.updatedAfter) conds.push(gte(item.updated_at, filters.updatedAfter));
  if (filters.tag) {
    conds.push(
      inArray(
        item.id,
        s.q
          .select({ id: itemTag.itemId })
          .from(itemTag)
          .innerJoin(tag, eq(itemTag.tagId, tag.id))
          .where(eq(tag.name, filters.tag.trim().toLowerCase())),
      ),
    );
  }
  return s.q
    .select(ITEM_COLS)
    .from(item)
    .leftJoin(project, eq(item.project_id, project.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(item.id))
    .all() as ItemRow[];
}

export function getTagsSync(db: Database, id: string): string[] {
  const rows = asStore(db)
    .q.select({ name: tag.name })
    .from(itemTag)
    .innerJoin(tag, eq(itemTag.tagId, tag.id))
    .where(eq(itemTag.itemId, id))
    .orderBy(asc(tag.name))
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** Clear the triage flag on an item (it has been triaged); keeps the item otherwise unchanged. */
export async function clearTriage(db: Database | Store, id: string): Promise<void> {
  const s = asStore(db);
  await s.q.update(s.t.item).set({ triage: 0, updated_at: nowIso() }).where(eq(s.t.item.id, id));
}

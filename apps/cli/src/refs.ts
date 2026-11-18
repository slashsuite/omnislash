// wayfinder 1949: per-project ticket refs (`PS-12`).
//
// THE MODEL. item.id stays the permanent internal id and every foreign key's target; a bare number always
// means that legacy id. On top of it every item in a keyed project carries a ref, `<KEY>-<seq>`:
//   - item.ref       the CURRENT ref, denormalised so a list never joins for it;
//   - item_ref       every ref the item has EVER held (its current one plus the aliases a move left behind).
//                    Its primary key is what keeps a ref from ever naming two items;
//   - ref_counter    the next seq per KEY. Keyed by the key, not the project, because items with no
//                    project share OB with omnislash.
// A project with no key gives its items no ref: they keep showing their legacy number until
// `ob project edit <id> --key <KEY>` numbers them.
//
// Display is uppercase; input is case-insensitive. Allocation is one upsert on ref_counter inside the
// caller's transaction, so two concurrent adds (or a CLI add racing an API add) take distinct seqs: the
// row lock (Postgres) or the write lock (SQLite BEGIN IMMEDIATE) serialises them, and a rolled-back
// insert rolls its seq back with it.
import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { nowIso } from "./db.ts";
import { asStore, readNumber, type Store } from "./db/store.ts";
import { AppError } from "./errors.ts";

/** The key items with no project number under. */
export const DEFAULT_KEY = "OB";

/**
 * The agreed keys (the same map migration 0037 backfills). A project registered later under one of these
 * ids takes its key at creation, so a fresh tracker numbers OmniSlash items OB-n too.
 */
export const AGREED_KEYS: Readonly<Record<string, string>> = {
  omnislash: "OB",
  pixelslash: "PS",
  hackcove: "HC",
  "acme-shop": "TH",
  "advisor-quotes": "AQ",
  stayawake: "SA",
  "claude-skills": "CS",
  "ha-frontend": "HAF",
  "hack-cove-themes": "HCT",
};

const KEY_RE = /^[A-Z]{2,4}$/;
const REF_RE = /^([A-Za-z]{2,4})-(\d+)$/;

/** `ps-12` → `PS-12`; anything that is not ref-shaped → null. */
export function normalizeRef(input: string): string | null {
  const m = input.trim().match(REF_RE);
  if (!m) return null;
  return `${m[1]!.toUpperCase()}-${Number(m[2])}`;
}

/** The key half of a ref (`PS-12` → `PS`), or null when it is not ref-shaped. */
export function refKey(ref: string): string | null {
  const n = normalizeRef(ref);
  return n ? n.slice(0, n.indexOf("-")) : null;
}

/** Why `key` cannot be a project key, or null when it can. */
export function keyProblem(key: string): string | null {
  return KEY_RE.test(key) ? null : `project key '${key}' must be 2-4 uppercase letters (A-Z), like PS or HAF`;
}

/** What ob prints for an item: its ref, or its legacy number when it has none. */
export function displayRef(row: { id: string; ref?: string | null }): string {
  return row.ref ?? row.id;
}

/** The key an item in `projectId` numbers under: OB for no project, null for a project with no key. */
export async function keyForProject(db: Database | Store, projectId: string | null): Promise<string | null> {
  if (projectId === null) return DEFAULT_KEY;
  const s = asStore(db);
  const rows = (await s.q
    .select({ key: s.t.project.key })
    .from(s.t.project)
    .where(eq(s.t.project.id, projectId))
    .limit(1)) as Array<{ key: string | null }>;
  return rows[0]?.key ?? null;
}

/** Take the next seq for `key`. Call it inside the transaction that uses the ref. */
async function nextSeq(s: Store, key: string): Promise<number> {
  const rows = (await s.q
    .insert(s.t.refCounter)
    .values({ key, next_seq: 2 })
    .onConflictDoUpdate({ target: s.t.refCounter.key, set: { next_seq: sql`${s.t.refCounter.next_seq} + 1` } })
    .returning({ next: s.t.refCounter.next_seq })) as Array<{ next: number | string }>;
  return readNumber(rows[0]?.next) - 1;
}

/**
 * Give `itemId` a fresh ref under `key`: record it in item_ref and make it the item's current ref. The
 * ref it held before stays in item_ref, so it keeps resolving (the alias a move leaves behind).
 */
export async function assignRef(s: Store, itemId: string, key: string): Promise<string> {
  const ref = `${key}-${await nextSeq(s, key)}`;
  await s.q.insert(s.t.itemRef).values({ ref, item_id: itemId, created_at: nowIso() });
  await s.q.update(s.t.item).set({ ref }).where(eq(s.t.item.id, itemId));
  return ref;
}

/**
 * The item id `input` names, or null when it names none. A bare number is the legacy id, always. A
 * ref-shaped input is looked up among every ref ever held (case-insensitive), falling back to a literal
 * id so an old non-numeric id still resolves. Anything else is taken as a literal id.
 */
export async function resolveItemId(db: Database | Store, input: string): Promise<string | null> {
  const raw = input.trim();
  if (/^\d+$/.test(raw)) return raw;
  const ref = normalizeRef(raw);
  if (ref) {
    const s = asStore(db);
    const rows = (await s.q
      .select({ id: s.t.itemRef.item_id })
      .from(s.t.itemRef)
      .where(eq(s.t.itemRef.ref, ref))
      .limit(1)) as Array<{ id: string }>;
    if (rows[0]) return rows[0].id;
  }
  return raw;
}

/** A bare number that names one item as its internal id and a DIFFERENT item as the `OB-<n>` key (OB-1751). */
export interface BareNumberCollision {
  /** The bare number as typed. */
  input: string;
  /** The item whose internal id the number is, and how it shows (its ref, or its id when it has none). */
  idItem: string;
  idItemRef: string;
  /** The item `OB-<n>` names. */
  keyItem: string;
  keyRef: string;
}

/**
 * OB-1751: the two numbering sequences drifted, so a bare `149` is the internal id of OB-142 and ALSO the
 * number in `OB-149`, a different item. `resolveItemId` always takes the internal id, which is how
 * `ob note 149` wrote to OB-142 and `ob spinoff 1750` launched a builder for HC-32. Null when the number is
 * not bare, names no item as an id (nothing to pick between), or both readings are the same item.
 * A failed read throws: failing open here is the wrong-item write this guards against.
 */
export async function bareNumberCollision(db: Database | Store, input: string): Promise<BareNumberCollision | null> {
  const raw = input.trim();
  if (!/^\d+$/.test(raw)) return null;
  const s = asStore(db);
  const keyRef = `${DEFAULT_KEY}-${Number(raw)}`;
  const holders = (await s.q
    .select({ id: s.t.itemRef.item_id })
    .from(s.t.itemRef)
    .where(eq(s.t.itemRef.ref, keyRef))
    .limit(1)) as Array<{ id: string }>;
  const keyItem = holders[0]?.id;
  if (!keyItem || keyItem === raw) return null;
  const idRows = (await s.q
    .select({ id: s.t.item.id, ref: s.t.item.ref })
    .from(s.t.item)
    .where(eq(s.t.item.id, raw))
    .limit(1)) as Array<{ id: string; ref: string | null }>;
  if (!idRows[0]) return null;
  return { input: raw, idItem: raw, idItemRef: displayRef(idRows[0]), keyItem, keyRef };
}

/** The refusal for a `BareNumberCollision`: both readings, and the typed forms that settle it. */
export function bareNumberCollisionMessage(c: BareNumberCollision): string {
  return (
    `'${c.input}' is ambiguous: as a bare number it is the internal id of ${c.idItemRef} (item ${c.idItem}), ` +
    `but ${c.keyRef} is a different item (id ${c.keyItem}). Nothing was changed. ` +
    (c.idItemRef === c.idItem
      ? `Type ${c.keyRef} for that one (item ${c.idItem} has no ref, so a bare number cannot name it while ${c.keyRef} exists)`
      : `Type ${c.keyRef} for that one, or ${c.idItemRef} for the first`)
  );
}

/** Every ref `itemId` has held besides its current one, oldest first. */
export async function aliasesOf(db: Database | Store, itemId: string): Promise<string[]> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ ref: s.t.itemRef.ref, current: s.t.item.ref })
    .from(s.t.itemRef)
    .innerJoin(s.t.item, eq(s.t.item.id, s.t.itemRef.item_id))
    .where(eq(s.t.itemRef.item_id, itemId))
    .orderBy(asc(s.t.itemRef.created_at), asc(s.t.itemRef.ref))) as Array<{ ref: string; current: string | null }>;
  return rows.filter((r) => r.ref !== r.current).map((r) => r.ref);
}

/** Every ref an item answers to: its legacy id, its current ref and its aliases. */
export async function equivalentRefs(db: Database | Store, itemId: string): Promise<string[]> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ ref: s.t.itemRef.ref })
    .from(s.t.itemRef)
    .where(eq(s.t.itemRef.item_id, itemId))) as Array<{ ref: string }>;
  return [itemId, ...rows.map((r) => r.ref)];
}

/** The current ref of each id that has one, for display in bulk. */
export async function refsFor(db: Database | Store, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const s = asStore(db);
  const rows = (await s.q
    .select({ id: s.t.item.id, ref: s.t.item.ref })
    .from(s.t.item)
    .where(inArray(s.t.item.id, ids))) as Array<{ id: string; ref: string | null }>;
  for (const r of rows) if (r.ref) out.set(r.id, r.ref);
  return out;
}

/**
 * After an item's project changed: give it a ref under the new project's key when that key differs from
 * the one its current ref carries. A move into a project with no key keeps the ref it has.
 */
export async function rerefAfterMove(s: Store, itemId: string, projectId: string | null): Promise<string | null> {
  const key = await keyForProject(s, projectId);
  const rows = (await s.q.select({ ref: s.t.item.ref }).from(s.t.item).where(eq(s.t.item.id, itemId)).limit(1)) as Array<{
    ref: string | null;
  }>;
  const current = rows[0]?.ref ?? null;
  if (!key || (current && refKey(current) === key)) return current;
  return assignRef(s, itemId, key);
}

export class ProjectKeyError extends AppError {}

/**
 * Set `projectId`'s key, then number every item of the project that has no ref under it yet, in creation
 * order. Changing a key re-refs the project's items and keeps their old refs as aliases. Refuses a
 * malformed key and one another project already holds. Returns how many items were (re)numbered.
 */
export async function setProjectKey(db: Database | Store, projectId: string, rawKey: string): Promise<number> {
  const key = rawKey.trim().toUpperCase();
  const problem = keyProblem(key);
  if (problem) throw new ProjectKeyError(problem);
  return asStore(db).txn("set the project key", async (s) => {
    const taken = (await s.q
      .select({ id: s.t.project.id })
      .from(s.t.project)
      .where(and(eq(s.t.project.key, key), ne(s.t.project.id, projectId)))
      .limit(1)) as Array<{ id: string }>;
    if (taken[0]) throw new ProjectKeyError(`project key ${key} is already project '${taken[0].id}''s`);
    await s.q.update(s.t.project).set({ key }).where(eq(s.t.project.id, projectId));
    const items = (await s.q
      .select({ id: s.t.item.id, ref: s.t.item.ref })
      .from(s.t.item)
      .where(eq(s.t.item.project_id, projectId))
      .orderBy(asc(s.t.item.created_at), asc(sql`LENGTH(${s.t.item.id})`), asc(s.t.item.id))) as Array<{
      id: string;
      ref: string | null;
    }>;
    let numbered = 0;
    for (const it of items) {
      if (it.ref && refKey(it.ref) === key) continue;
      await assignRef(s, it.id, key);
      numbered++;
    }
    return numbered;
  });
}

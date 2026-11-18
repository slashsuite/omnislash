/**
 * The ob ITEM a spinoff row serves (wayfinder 1163) — the one identity behind every join between a
 * dispatched builder and the ticket it is building.
 *
 * ── Why this exists at all ───────────────────────────────────────────────────────────────────────────
 *
 * `spinoff.ticket_ref` is the ref the row was DISPATCHED with. That is an ob item id only when the ticket
 * was numbered by `ob add`. A ticket charted BY HAND is dispatched by its wayfinder number — that number
 * names its ticket file, its branch and its worktree — while its ob mirror carries an id of its own:
 *
 *     row 591 · ticket_ref "1124" · worktree /home/owner/dev/acme.1124 · the item is 1134
 *
 * So nothing that resolves a row's ticket through `ticket_ref` alone can be right for both. The row
 * RECORDS the item it serves, at dispatch (`spinoff.item_id`, migration 0032), and every reader resolves
 * through that: settle-on-close, the `Threads` block, `ob t3 tree`, `ob t3 open`. It is the same shape
 * 1120 used for `t3_thread_id` — a fact recorded where it is known, because it cannot be derived on the
 * other side of the boundary.
 *
 * ── The order the evidence is read in, and why (1226) ────────────────────────────────────────────────
 *
 * The two numbering sequences COLLIDE — ob ids come from `ob add`, hand-charted tickets carry wayfinder
 * numbers — and the wart is deliberate, so a resolver cannot assume a ref names one item. Measured live:
 * the strip ticket was charted as wayfinder 1121 and its mirror became item 1133, while wayfinder 1133 is
 * the readying-note ticket and its mirror is item 1135. Ref "1133" therefore names TWO items, and which
 * one it means is not a majority vote: it is decided by the evidence that is SPECIFIC to it.
 *
 *   1. the TICKET PATH — an item whose own record names `wayfinder/tickets/1133-…` is the hand-charted
 *      ticket that number names. This is a fact about that one ref, written by the charter.
 *   2. the row's RECORDED identity (`spinoff.item_id`) — what dispatch decided, kept for a row whose ref
 *      has since stopped naming a path (the record outlives the file it was taken from).
 *   3. the ref AS an item id — the `ob add` numbering, where ref and item share a name.
 *
 * The bare id is LAST on purpose: it is the coincidence of two sequences, and it is what bound row 595
 * (dispatched `ob spinoff 1133`) to item 1133 — the strip's mirror — so that closing the strip told the
 * readying-note thread it had landed and re-activated a builder that had finished ([1226]). The bare-id
 * rule is kept, because it is what binds a row dispatched by its own item id (the common case): it is
 * simply consulted only when no path names the ref.
 *
 * This module imports NOTHING that imports the spinoff command module or the t3 dispatcher: `dispatch.ts`
 * resolves rows through here, and a cycle back into `spinoff.ts` would make `T3_LAUNCHER` a
 * use-before-init at load time (measured: it does).
 */

import type { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { asStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { parseIssueRef } from "../../../apps/cli/src/github-issues.ts";
import { getItem } from "../../../apps/cli/src/items.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";
import { bareNumberCollision, bareNumberCollisionMessage, equivalentRefs } from "../../../apps/cli/src/refs.ts";
import { itemForIssue, trackerRepo } from "../../../apps/cli/src/tracker-link.ts";

/** What a row records about whose ticket it is: the ref it was dispatched with, and its item, if known. */
export interface SpinoffRowRef {
  ticket_ref: string;
  item_id?: string | null;
}

/**
 * The wayfinder refs an ob item's own record NAMES — `wayfinder/tickets/<ref>-<slug>.md`. This is the
 * SPECIFIC evidence (1226): a fact about one ref, written by the charter, as opposed to an item id that a
 * different sequence happens to share.
 *
 * The ticket-file convention is a NUMERIC ref and a slug (`1124-t3-read-surface.md`); a stem that does not
 * start with a number is taken whole, which can only fail to match — it never invents a pairing. Pure.
 */
export function itemTicketPathRefs(item: { id: string; body?: string | null }): string[] {
  const refs: string[] = [];
  for (const match of (item.body ?? "").matchAll(/wayfinder\/tickets\/([A-Za-z0-9][A-Za-z0-9._-]*)\.[A-Za-z0-9]+/g)) {
    const stem = match[1]!;
    const ref = stem.match(/^(\d+)(?:-|$)/)?.[1] ?? stem;
    if (!refs.includes(ref)) refs.push(ref);
  }
  return refs;
}

/**
 * The dispatch refs an ob item answers to: its own id, plus the wayfinder ref of every
 * `wayfinder/tickets/<ref>-<slug>.md` path its record names. A record that names its OWN id as a path
 * (`wayfinder/tickets/1133-x.md` under item 1133 — a ticket chartered as the number its mirror got) lists
 * it once. Pure.
 */
export function itemDispatchRefs(item: { id: string; body?: string | null }): string[] {
  return [item.id, ...itemTicketPathRefs(item).filter((ref) => ref !== item.id)];
}

/**
 * What asking a ref about its TICKET PATH came back with — the SPECIFIC half of the resolution (1226), and
 * the one a row's ref is asked about before its id is. Four answers, not two, because the caller must be
 * able to tell "nobody names this ref" (the one answer that licenses the bare-id fallback) from "I could
 * not settle it": an ambiguous or unreadable answer that fell through to a weaker rule would pick an item
 * on the strength of a read that said nothing.
 */
export type TicketPathClaim =
  | { kind: "item"; itemId: string }
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "unreadable" };

/**
 * The item a ref's ticket path names, or why it is not one item. The LIKE is a COARSE filter — every item
 * whose body mentions this ticket path at all — and the EXACT check in `itemTicketPathRefs` is the only
 * thing that decides a pairing. The ref is used as it was typed, so a `%` or `_` in it can only widen the
 * scan, never mis-pair an item. Lowered on BOTH sides rather than with `ilike`, because SQLite has no
 * ILIKE and a ref typed in another case must resolve the same way on either engine.
 */
export async function ticketPathClaim(db: Database | Store, ticketRef: string): Promise<TicketPathClaim> {
  try {
    const s = asStore(db);
    const ref = ticketRef.trim();
    if (ref.length === 0) return { kind: "none" };
    const pattern = `%wayfinder/tickets/${ref}-%`.toLowerCase();
    const candidates = (await s.q
      .select({ id: s.t.item.id, body: s.t.item.body })
      .from(s.t.item)
      .where(sql`lower(${s.t.item.body}) like ${pattern}`)) as Array<{ id: string; body: string | null }>;
    const named = candidates.filter((c) => itemTicketPathRefs(c).includes(ref));
    if (named.length === 1) return { kind: "item", itemId: named[0]!.id };
    return named.length === 0 ? { kind: "none" } : { kind: "ambiguous" };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * The ob item a spinoff ref serves, in the order the two namespaces actually appear:
 *
 *   1. `#<n>` — a GitHub issue on the tracker repo: the item is the one LINKED to it (`ob issue link`).
 *   2. the item whose own record names `wayfinder/tickets/<ref>-…` — a hand-charted ticket's ob mirror.
 *   3. the ref AS an ob item id — the `ob add` numbering, where the ref and the item are the same name.
 *
 * Step 3 is reached ONLY on `none` (1226): a ref two items both name, or a tracker that could not be asked,
 * answers null rather than dropping through to the coincidence — the bare id is the weaker evidence, and a
 * weaker rule must not decide what a stronger one refused to.
 *
 * Null when the ref resolves to no item. Never throws: the identity is a label recorded on a row, and a
 * tracker read that fails must not fail the enqueue that is recording it.
 */
export async function ticketItemIdFor(db: Database | Store, ticketRef: string): Promise<string | null> {
  try {
    const num = parseIssueRef(ticketRef);
    if (num !== null) {
      const linked = await itemForIssue(db, { repo: await trackerRepo(db), number: num });
      return linked?.item_id ?? null;
    }
    const claim = await ticketPathClaim(db, ticketRef);
    if (claim.kind === "item") return claim.itemId;
    if (claim.kind !== "none") return null;
    // 1949: getItem resolves a `PS-12` ref (or an alias a move left) to its item, so answer with the
    // item's id rather than echoing the ref back.
    return (await getItem(db, ticketRef.trim()))?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * OB-1751: refuse to dispatch a bare number that is the internal id of one item AND `OB-<n>` of another
 * (`ob spinoff 1750` launched a builder for HC-32, whose id it is, when OB-1750 was meant). Reached only
 * when the number would fall to the bare-id leg: a hand-charted ticket path that names it (1226) still
 * binds it, and a path two items name or a tracker that cannot be asked binds nothing, so there is no
 * silent pick to refuse. Thrown before anything is queued, so a refusal leaves no pending row.
 */
export async function refuseAmbiguousDispatchRef(db: Database | Store, ticketRef: string): Promise<void> {
  const ref = ticketRef.trim();
  if (!/^\d+$/.test(ref)) return;
  if ((await ticketPathClaim(db, ref)).kind !== "none") return;
  const collision = await bareNumberCollision(db, ref);
  if (collision) throw new AppError(bareNumberCollisionMessage(collision));
}

/**
 * The ref a NEW row is dispatched under (1949): the item's current `<KEY>-<seq>` when the ref names an
 * item that has one, else the ref as typed. So `ob spinoff 1949`, `ob spinoff ob-1700` and an alias a move
 * left behind all queue one row under one name, and that name is what the branch, worktree, builder id and
 * `ticket:` lease are derived from. A `#<n>` issue ref, a hand-charted wayfinder number with no item and an
 * item in a project with no key keep what was typed. Never throws, like the resolver it reads through.
 */
export async function dispatchRefFor(db: Database | Store, ticketRef: string): Promise<string> {
  if (parseIssueRef(ticketRef) !== null) return ticketRef;
  try {
    const id = await ticketItemIdFor(db, ticketRef);
    if (!id) return ticketRef;
    return (await getItem(db, id))?.ref ?? ticketRef;
  } catch {
    return ticketRef;
  }
}

/**
 * The one line a dispatch prints when the ref it was given is claimed by TWO items (1226): the item whose
 * ID is the ref, and the mirror whose ticket PATH names it. Null in every other case, which is almost
 * always — a plain `ob add` ref IS its item, and a hand-charted ref names no item by id.
 *
 * The binding has already gone to the path (`rowItemId` / `ticketItemIdFor`), because the path is the
 * specific evidence; this only makes the coincidence VISIBLE at the one moment a human can act on it,
 * instead of picking between two items silently. Pure: the caller reads the two ids.
 */
export function collidingRefWarning(ref: string, itemId: string | null, bareId: string | null): string | null {
  if (!itemId || !bareId || bareId === itemId) return null;
  return `spinoff: '${ref}' is both item ${bareId}'s id and the ticket path item ${itemId} names — bound to ${itemId}, the path being the specific evidence`;
}

/**
 * The ob item a spinoff ROW serves, in the same order the evidence is read in (1226): the ticket path its
 * ref names, then the identity the row recorded at dispatch, then the ref as an item id.
 *
 * The path outranks the recorded id on purpose: a row dispatched under a colliding ref RECORDED the wrong
 * item (item 1133 instead of 1135), and re-resolving it is what makes an existing mis-bound row right —
 * the record is what dispatch believed, not what the tracker says.
 *
 * The weaker legs are reached only when the stronger one came back EMPTY (1226): a path two items both
 * name, or a tracker that could not be asked, leaves the row UNRESOLVED — a record that might itself have
 * been stamped by the old bare-id rule must not decide what the path refused to, and the close's own
 * "no row serves it"/"could not be joined" lines report the case by name. The record is trusted exactly
 * where the path is confirmed absent, and the bare id only after that. Null when nothing resolves.
 */
export async function rowItemId(db: Database | Store, row: SpinoffRowRef): Promise<string | null> {
  const claim = await ticketPathClaim(db, row.ticket_ref);
  if (claim.kind === "item") return claim.itemId;
  if (claim.kind !== "none") return null;
  if (row.item_id) return row.item_id;
  // The same resolution dispatch uses, so a row's identity can never be something dispatch would not have
  // bound it to. It re-asks the path (one more LIKE on this leg only) and then the bare id.
  return ticketItemIdFor(db, row.ticket_ref);
}

/**
 * The rows that serve one ITEM, and the candidate rows whose ref could NOT be resolved (1226).
 *
 * `unresolved` is not a refusal and not a miss: it is "this row was dispatched for something that names
 * this item's ref, and the tracker will not say which" — a path two items both claim, or a read that
 * failed. Dropping those rows SILENTLY is what would let a close mistake "I could not tell" for "there is
 * nothing to tell", so they travel with the answer and the caller names them.
 */
export interface ServingRows<T> {
  rows: T[];
  unresolved: T[];
}

/**
 * The rows that serve one ITEM, resolved HERE because this is where the store is (1226).
 *
 * A row can only be about this item in three ways — it records it, it was dispatched with its id, or its
 * ref is one of the item's own ticket paths — and everything else is rejected WITHOUT a read. That pre-
 * filter is not an optimisation for its own sake: the live store holds 600-odd rows, almost all of them
 * queued before the identity column existed, and a close must not resolve them one by one.
 *
 * The decision itself is `rowItemId`, the same one dispatch records with, so a row can never join an item
 * dispatch would not have bound it to; a row that records an item its ref's ticket path contradicts is
 * RE-RESOLVED to the path — that is an existing mis-bound row corrected as it is read, which is what makes
 * the 1133/1135 collision stop telling the wrong thread it landed. The one case the resolution cannot see
 * is a row dispatched by an item id the tracker does not hold: there the ref IS the closed item's name,
 * and the row records nothing else, so it serves it.
 */
export async function spinoffRowsServingItem<T extends SpinoffRowRef>(
  db: Database | Store,
  rows: readonly T[],
  item: { id: string; body?: string | null },
): Promise<ServingRows<T>> {
  const itemId = item.id;
  const pathRefs = itemTicketPathRefs(item);
  // 1949: a row is named by the item's `<KEY>-<seq>` (or a ref a move left), not only its bare id.
  const ownRefs = new Set((await equivalentRefs(db, itemId).catch(() => [itemId])).map((r) => r.toUpperCase()));
  const isOwnRef = (ref: string): boolean => ownRefs.has(ref.trim().toUpperCase());
  const serving: T[] = [];
  const unresolved: T[] = [];
  for (const row of rows) {
    const candidate = row.item_id === itemId || isOwnRef(row.ticket_ref) || pathRefs.includes(row.ticket_ref);
    if (!candidate) continue;
    const resolved = await rowItemId(db, row);
    if (resolved === itemId) {
      serving.push(row);
      continue;
    }
    // It resolves to ANOTHER item: that item's row, not this one's — not a miss, and nothing to report.
    if (resolved !== null) continue;
    // Nothing resolved. The one case that still belongs to this item is the bare-id fallback, and it is
    // taken only on a CONFIRMED absence: a row that records nothing whose ref IS this item's id serves it
    // (the `ob add` numbering, where the ref and the item share a name). `rowItemId` answers null for a ref
    // two items name and for a read that failed as well, so the claim is re-asked here rather than read
    // off that null — and anything still standing is carried out as UNRESOLVED, to be named, not dropped.
    if (row.item_id == null && isOwnRef(row.ticket_ref)) {
      const claim = await ticketPathClaim(db, row.ticket_ref);
      if (claim.kind === "none") {
        serving.push(row);
        continue;
      }
    }
    unresolved.push(row);
  }
  return { rows: serving, unresolved };
}

/**
 * The one line a close prints for a candidate row whose ref would not resolve (1226) — a ref two items
 * both name, or a tracker that could not be read. Named rather than skipped, because the alternative is a
 * close that says nothing while a builder's thread sits there un-settled.
 */
export function unresolvedRefWarning(itemId: string, row: { id: number; ticket_ref: string }): string {
  return `t3: spinoff #${row.id} (ref '${row.ticket_ref}') names more than one item, or the tracker could not be read, so it was left unresolved — nothing for '${itemId}' was settled or replied to for that row`;
}

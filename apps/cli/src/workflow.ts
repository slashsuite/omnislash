import type { Database } from "bun:sqlite";
import { and, desc, eq, isNotNull, like, sql } from "drizzle-orm";
import { AppError, TransitionRefused } from "./errors.ts";
import { decide } from "../../../platform/state-machine/src/decide.ts";
import { itemMachineFor, moveEvent } from "../../../platform/state-machine/src/item.ts";
import { clearBlock, clearTriage, editItem, getItem, queryItems, setBlocked, setStatus } from "./items.ts";
import { getFocusProject } from "./config.ts";
import { compareWithinBand } from "./worklist.ts";
import { effectivePriority } from "./priority.ts";
import { dependencyRaises } from "./dep-priority.ts";
import { DECISION_SOURCE, DECISION_TYPE, recordDecision, type DecisionOpts } from "./decisions.ts";
import { nowIso } from "./db.ts";
import { parsePayload, type EventRow } from "./events.ts";
import { asStore, readNumber, type Store } from "./db/store.ts";
import { isClosedStatus, isValidStatus, statusVocab, type Kind } from "./status.ts";
import { defineSeam } from "./test-seams.ts";

/**
 * OS-171: fires inside each door's transaction, after the door read `from` and before the guarded write, so a
 * test can move the item in between and watch the write be refused with `StatusRaced`. A no-op for real.
 */
export const statusRaceSeam = defineSeam<(tx: Store, id: string, from: string, to: string) => Promise<void>>(
  "status-race",
  async () => {},
);

/**
 * OS-171: one status move as one transaction: the race seam, then `body`, which does the guarded write
 * (`StatusRaced` when the item is no longer `from`) and the decision row through the same handle. A throw
 * anywhere rolls back the write and the decision together. Nested in a caller's transaction it joins it
 * (SQLite) or takes a savepoint (Postgres).
 */
function moveAtomically(
  db: Database | Store,
  id: string,
  from: string,
  to: string,
  body: (tx: Store) => Promise<void>,
): Promise<void> {
  return asStore(db).txn(`move ${id} ${from} -> ${to}`, async (tx) => {
    await statusRaceSeam.get()(tx, id, from, to);
    await body(tx);
  });
}

// The single validated-transition core. The CLI workflow commands (`ob start/ready/close/reopen/block/
// today`) and the dashboard's transitionItem server fn BOTH go through here — no state logic is
// duplicated, and every path respects the per-type/kind status model (status.ts). An invalid move
// throws AppError; the caller (CLI or drawer) surfaces the message rather than silently no-op'ing.

/** The named actions the dashboard drawer + CLI expose (block carries a reason; reopen re-opens a done item). */
export type WorkflowAction = "start" | "ready" | "block" | "close" | "reopen";

async function requireItem(db: Database | Store, id: string) {
  const it = await getItem(db, id);
  if (!it) throw new AppError(`no item with id '${id}'`);
  return it;
}

/** OB-2004: a reference document is not work, so no workflow move applies to it. */
function refuseReference(it: { id: string; type: string }): void {
  if (it.type === "reference") {
    throw new AppError(`item '${it.id}' is a reference document, not a task: it has no status to move (see 'ob doc')`);
  }
}

/** True when the item's machine has a move from `from` to `to` (a self-move is one: `item.ts` declares it). */
function machineAllows(type: string, kind: string | null, from: string, to: string): boolean {
  return decide(itemMachineFor(type, kind), from, moveEvent(to)).ok;
}

/**
 * The validation half of a transition, with no write, so a `--dry-run` preview fails on exactly the
 * moves the real transition would reject instead of promising something impossible. OS-172: the edge is
 * the item's lifecycle machine (`platform/state-machine/src/item.ts`), the one definition of the item
 * lifecycle. A refusal is `TransitionRefused` (why `machine`); a stored status the machine does not know
 * is refused the same way, never thrown as a crash (`ob state <id> <to> --repair '<why>'` is the way out).
 */
export async function assertTransition(db: Database | Store, id: string, to: string): Promise<void> {
  const it = await requireItem(db, id);
  refuseReference(it);
  const kind = it.project_kind as Kind | null;
  if (!isValidStatus(to, it.type, kind)) {
    throw new AppError(`status '${to}' is not valid for this item (type=${it.type}, kind=${kind ?? "none"})`);
  }
  const machine = itemMachineFor(it.type, kind);
  const event = moveEvent(to);
  const d = decide(machine, it.status, event);
  if (d.ok) return;
  const label = it.ref ?? it.id;
  const known = Object.hasOwn(machine.states, it.status);
  const message = known
    ? `item '${label}' is ${it.status}: '${event}' is not a move from there`
    : `item '${label}' is ${it.status}, which is not a state of '${machine.id}': '${event}' is not a move from there (on a local store: ob state ${label} <status> --repair '<why>')`;
  throw new TransitionRefused(message, { machine: machine.id, id: it.id, from: it.status, event, why: d.why });
}

/** Validated status move: rejects a status the type/kind can't hold, and an edge the model forbids. */
/** OS-172: the block's guard. A block with no reason is a blocked item nobody can act on. */
function blockNeedsReason(it: { id: string; ref?: string | null; type: string; project_kind: string | null; status: string }): TransitionRefused {
  return new TransitionRefused(`item '${it.ref ?? it.id}' is ${it.status}: a block needs a reason`, {
    machine: itemMachineFor(it.type, it.project_kind).id,
    id: it.id,
    from: it.status,
    event: moveEvent("blocked"),
    why: "guard",
  });
}

export async function transitionTo(db: Database | Store, id: string, to: string, decision: DecisionOpts = {}): Promise<void> {
  const it = await requireItem(db, id);
  id = it.id;
  await assertTransition(db, it.id, to);
  const from = it.status;
  // OS-172: a block carries a reason, and transitionTo takes none, so a block goes through blockItem.
  if (to === "blocked" && from !== "blocked") throw blockNeedsReason(it);
  await moveAtomically(db, id, from, to, async (tx) => {
    await setStatus(tx, id, from, to);
    // OB-1928: any close takes the item out of the triage inbox, after the move is validated and written,
    // so a refused close leaves the flag set.
    if (to === "done") await clearTriage(tx, id);
    // 1515: a move to the status it is already in (a retried `close`) is not a decision, and recording it
    // would turn every idempotent re-run into a `done -> done` line on the trail.
    if (from !== to) await recordDecision(tx, id, from, to, decision);
  });
}

export async function startItem(db: Database | Store, id: string, decision: DecisionOpts = {}): Promise<void> {
  await transitionTo(db, id, "in_progress", decision);
}

export async function readyItem(db: Database | Store, id: string, decision: DecisionOpts = {}): Promise<void> {
  await transitionTo(db, id, "ready", decision);
}

/** OB-1928: closing a blocked item is an unblock to `done`, so the block fields do not outlive the block. */
export async function closeItem(db: Database | Store, id: string, decision: DecisionOpts = {}): Promise<void> {
  const it = await requireItem(db, id);
  if (it.status === "blocked") await unblockItem(db, it.id, decision, { to: "done" });
  else await transitionTo(db, it.id, "done", decision);
}

/** The door half of a reopen: a reopen requires the item to actually be closed. */
function refuseUnlessReopenable(it: { id: string; type: string; status: string }): void {
  refuseReference(it);
  if (it.status !== "done") throw new AppError(`item '${it.id}' is not closed`);
}

/** The validation half of a reopen. No write. */
export async function assertReopen(db: Database | Store, id: string): Promise<void> {
  const it = await requireItem(db, id);
  refuseUnlessReopenable(it);
  await assertTransition(db, it.id, "open");
}

export async function reopenItem(db: Database | Store, id: string, decision: DecisionOpts = {}): Promise<void> {
  const it = await requireItem(db, id);
  id = it.id;
  refuseUnlessReopenable(it);
  await assertTransition(db, it.id, "open");
  await moveAtomically(db, id, "done", "open", async (tx) => {
    await setStatus(tx, id, "done", "open");
    await recordDecision(tx, id, "done", "open", decision);
  });
}

/**
 * `reason` is the block's own text (kept on the item); `decision.note` is the note on the transition.
 * OB-1928: refused when the item is already blocked (no silent reason overwrite), done, or of a type/kind
 * whose vocabulary has no `blocked` (roadmap, decision, learning).
 */
export async function blockItem(
  db: Database | Store,
  id: string,
  reason: string | null,
  owner: string | null,
  decision: DecisionOpts = {},
): Promise<void> {
  const it = await requireItem(db, id);
  id = it.id;
  if (it.status === "blocked") throw new AppError(`item '${id}' is already blocked`);
  await assertTransition(db, id, "blocked");
  // OS-172: the block's guard. A block with no reason is a blocked item nobody can act on.
  if (!reason?.trim()) throw blockNeedsReason(it);
  const from = it.status;
  // OS-26: the owner rides on the transition, so who a block waited on survives the block being cleared.
  const extra = owner ? { ...decision.extra, block_owner: owner } : decision.extra;
  await moveAtomically(db, id, from, "blocked", async (tx) => {
    await setBlocked(tx, id, from, reason, owner);
    await recordDecision(tx, id, from, "blocked", { ...decision, extra, note: decision.note ?? reason });
  });
}

/**
 * The status the item was in when it was last blocked: the `from` of the newest trail decision whose `to`
 * is `blocked` (OB-1928). A direct query, not `decisionsForItem` and its 50-row window, so a long-blocked
 * busy item still finds it. Null when the trail has none.
 */
async function statusBeforeBlock(db: Database | Store, id: string): Promise<string | null> {
  const s = asStore(db);
  // The payload is JSON text on both engines; the LIKE narrows to candidate rows and the parse below is
  // the real check (a note can never match, since its quotes are escaped in the JSON).
  const rows = (await s.q
    .select()
    .from(s.t.event)
    .where(
      and(
        eq(s.t.event.item_id, id),
        eq(s.t.event.source, DECISION_SOURCE),
        eq(s.t.event.type, DECISION_TYPE),
        like(s.t.event.payload, '%"to":"blocked"%'),
      ),
    )
    .orderBy(desc(s.t.event.ts), desc(s.t.event.id))) as EventRow[];
  for (const r of rows) {
    const p = parsePayload<{ from?: unknown; to?: unknown }>(r);
    if (p.to === "blocked" && typeof p.from === "string") return p.from;
  }
  return null;
}

/**
 * The unblock half (OB-1928): refuses an item that is not blocked. With `to`, moves there (validated);
 * without it, restores the status the item was blocked from, falling back to `open` when the trail has
 * none, when the table has no edge back to it from `blocked` (`merged`, `qa` and the like), or when it
 * is `done` (restoring a legacy `done -> blocked` would skip the close's side effects). The fallback is
 * validated too, so a type with no `open` is refused rather than written outside its vocabulary. Clears the block fields, keeps closed_at in step
 * with the status, and records `blocked -> <target>`.
 */
export async function unblockItem(
  db: Database | Store,
  id: string,
  decision: DecisionOpts = {},
  opts: { to?: string } = {},
): Promise<void> {
  const it = await requireItem(db, id);
  id = it.id;
  if (it.status !== "blocked") throw new AppError(`item '${id}' is not blocked`);
  const kind = it.project_kind as Kind | null;
  const prior = opts.to === undefined ? await statusBeforeBlock(db, id) : null;
  const target =
    opts.to ??
    (prior && prior !== "done" && isValidStatus(prior, it.type, kind) && machineAllows(it.type, kind, "blocked", prior)
      ? prior
      : "open");
  // A legacy blocked row of a type with no `open` (a decision, say) is refused by name, never written open.
  await assertTransition(db, id, target);
  await moveAtomically(db, id, "blocked", target, async (tx) => {
    await clearBlock(tx, id, "blocked", target);
    if (target === "done") await clearTriage(tx, id);
    await recordDecision(tx, id, "blocked", target, decision);
  });
}

export type MoveResult = "blocked" | "unblocked" | "reopened" | "moved";

/**
 * No check of its own: every door below runs `assertTransition` (`blockItem`, `unblockItem`, `reopenItem`,
 * `transitionTo`), so each move is checked exactly once, on the door it takes.
 *
 * The one generic move (OB-1928) that `ob state <id> <to>` and the API `/state` `set` action share, so
 * neither has its own branches: a block goes through `blockItem`, any move off `blocked` through
 * `unblockItem`, `done -> open` through `reopenItem`, and the rest through `transitionTo`. Returns which
 * door it took, so the caller can run the side effect that door owes (the reopen mirror).
 */
export async function moveItem(
  db: Database | Store,
  id: string,
  to: string,
  opts: { reason?: string | null; owner?: string | null; decision?: DecisionOpts } = {},
): Promise<MoveResult> {
  const it = await requireItem(db, id);
  id = it.id;
  const decision = opts.decision ?? {};
  if (to === "blocked") {
    await blockItem(db, id, opts.reason ?? null, opts.owner ?? null, decision);
    return "blocked";
  }
  if (it.status === "blocked") {
    await unblockItem(db, id, decision, { to });
    return "unblocked";
  }
  if (it.status === "done" && to === "open") {
    await reopenItem(db, id, decision);
    return "reopened";
  }
  await transitionTo(db, id, to, decision);
  return "moved";
}

/**
 * OS-172: the named, logged way out of a status the machine has no move from (a legacy or hand-written
 * status, say). Skips the machine's edge check, but `to` must still be in the item's vocabulary, and the
 * write is the guarded one (OS-171), so a move that raced it is still refused with `StatusRaced`. The trail
 * records `repair: <why>` with `repair: true`. `done` and `blocked` are refused: a close has side effects
 * and a block needs its reason, so repair to `open` and then close or block.
 */
export async function repairItem(
  db: Database | Store,
  id: string,
  to: string,
  why: string,
  decision: DecisionOpts = {},
): Promise<void> {
  const it = await requireItem(db, id);
  id = it.id;
  refuseReference(it);
  const reason = why.trim();
  if (!reason) throw new AppError("a repair needs a reason");
  if (to === "done" || to === "blocked") throw new AppError("repair to open, then close or block");
  const kind = it.project_kind as Kind | null;
  if (!isValidStatus(to, it.type, kind)) {
    throw new AppError(`status '${to}' is not valid for this item (type=${it.type}, kind=${kind ?? "none"})`);
  }
  const from = it.status;
  if (from === to) throw new AppError(`item '${it.ref ?? id}' is already ${to}: nothing to repair`);
  await moveAtomically(db, id, from, to, async (tx) => {
    // Leaving `blocked` clears the block fields with the same guarded write an unblock uses.
    if (from === "blocked") await clearBlock(tx, id, from, to);
    else await setStatus(tx, id, from, to);
    await recordDecision(tx, id, from, to, { ...decision, note: decision.note?.trim() ? `repair: ${reason}; ${decision.note.trim()}` : `repair: ${reason}`, extra: { ...decision.extra, repair: true } });
  });
}

/** Set a today-rank: an explicit rank, or the next slot (MAX(today_rank)+1) when omitted. Returns the rank. */
export async function setTodayRank(db: Database | Store, id: string, rank?: number): Promise<number> {
  const s = asStore(db);
  id = (await requireItem(s, id)).id;
  let n: number;
  if (rank !== undefined) {
    if (!Number.isInteger(rank)) throw new AppError(`invalid rank '${rank}'`);
    n = rank;
  } else {
    // COALESCE, not IFNULL (337): IFNULL is a SQLite builtin Postgres does not have. readNumber because
    // MAX over an integer arrives from Postgres as a string, and `"3" + 1` is "31", not 4 -- which would
    // hand out a today-rank of 31 with no error anywhere.
    const rows = (await s.q
      .select({ n: sql<number>`COALESCE(MAX(${s.t.item.today_rank}), 0) + 1` })
      .from(s.t.item)
      .limit(1)) as Array<{ n: number }>;
    n = readNumber(rows[0]?.n);
  }
  await s.q.update(s.t.item).set({ today_rank: n, updated_at: nowIso() }).where(eq(s.t.item.id, id));
  return n;
}

/** Clear the today-rank on one item, or (id omitted) on every ranked item. */
export async function clearTodayRank(db: Database | Store, id?: string): Promise<void> {
  const s = asStore(db);
  if (id === undefined) {
    await s.q.update(s.t.item).set({ today_rank: null, updated_at: nowIso() }).where(isNotNull(s.t.item.today_rank));
    return;
  }
  id = (await requireItem(s, id)).id;
  await s.q.update(s.t.item).set({ today_rank: null, updated_at: nowIso() }).where(eq(s.t.item.id, id));
}

/** Where `setQueueOrder` puts an item. `top` may name the band to put it first in; `before` / `after` take it from the target. */
export type QueueMove =
  | { top: true; priority?: number | undefined }
  | { before: string }
  | { after: string };

export interface QueueOrderResult {
  id: string;
  /** The item's effective priority after the move (its band). */
  priority: number;
  /** True when the move crossed into another band and wrote the item's priority. */
  priorityChanged: boolean;
  /** The item's queue rank after the move (1 is next). */
  rank: number;
}

/**
 * OB-2083: place one open item in its project's execution queue, the one core `ob order`, `POST
 * /items/:id/order` and the board call. The queue is a set of priority bands; inside a band the order is
 * `queue_rank` ascending. A move next to an item of ANOTHER band moves the item into that band (its
 * priority is set to the target's effective priority, through `editItem` like `ob edit --priority`); a
 * move inside the band never writes the priority, so an unset item stays unset. The band is then
 * renumbered 1..n in one transaction, dense and with no gap arithmetic; other bands are untouched. Today's
 * rank is not read and never written.
 */
export async function setQueueOrder(
  db: Database | Store,
  id: string,
  move: QueueMove,
  decision: DecisionOpts = {},
): Promise<QueueOrderResult> {
  const s = asStore(db);
  const moved = await requireItem(s, id);
  id = moved.id;
  if (!moved.project_id) throw new AppError(`${moved.ref ?? id} has no project: a queue is per project (ob edit ${moved.ref ?? id} --project <slug>)`);
  const projectId = moved.project_id;
  // One transaction for the reads, the priority write and the renumber. On sqlite BEGIN IMMEDIATE already
  // serialises writers; on Postgres (READ COMMITTED) the project row lock makes two orders in one project queue
  // up instead of both numbering the band from the same stale read.
  return s.txn("order the queue", async (tx) => {
    if (tx.kind === "postgres") {
      await (tx.q as unknown as { select: (f: unknown) => { from: (t: unknown) => { where: (w: unknown) => { for: (m: string) => Promise<unknown> } } } })
        .select({ id: tx.t.project.id })
        .from(tx.t.project)
        .where(eq(tx.t.project.id, projectId))
        .for("update");
    }
    const focusProject = await getFocusProject(tx);
    // OS-216: the band is the effective priority `ob next` shows, a dependency raise included.
    const raises = await dependencyRaises(tx, focusProject);
    const effOf = (r: { id: string; priority: number | null; project_id: string | null }) =>
      effectivePriority({ priority: r.priority, projectId: r.project_id, focusProject, raised: raises.get(r.id)?.priority });
    // `open` is "not done", which still admits an archived roadmap or an accepted decision: those are closed.
    const open = (await queryItems(tx, { open: true, projectId })).filter((r) => !isClosedStatus(r.type, r.status));
    const me = open.find((r) => r.id === id);
    if (!me) throw new AppError(`${moved.ref ?? id} is not open: only an open item has a place in the queue`);

    let band = effOf(me);
    let anchor: { id: string; after: boolean } | null = null;
    let explicit = false;
    if ("top" in move) {
      if (move.priority !== undefined) {
        band = move.priority;
        explicit = true;
      }
    } else {
      const targetRef = "before" in move ? move.before : move.after;
      const target = await requireItem(tx, targetRef);
      const label = target.ref ?? target.id;
      if (target.id === id) throw new AppError(`cannot order ${label} relative to itself`);
      if (target.project_id !== projectId) {
        throw new AppError(`${label} is in project ${target.project_id ?? "-"}, not ${projectId}: a queue is per project`);
      }
      const t = open.find((r) => r.id === target.id);
      if (!t) throw new AppError(`${label} is not open: order relative to an open item`);
      band = effOf(t);
      anchor = { id: target.id, after: "after" in move };
    }

    // The priority becomes the band's, set explicitly, when the move crosses into another band, or when
    // --top --priority names a priority the item does not store yet (an unset item in the focus project already
    // sits in the high band, but --priority high asks for it to be written). A plain same-band move writes nothing.
    const priorityChanged = band !== effOf(me) || (explicit && me.priority !== band);
    if (priorityChanged) await editItem(tx, id, { priority: band }, decision);

    const rows = open.filter((r) => effOf(r) === band || r.id === id);
    rows.sort(compareWithinBand);
    const order = rows.filter((r) => r.id !== id).map((r) => r.id);
    let at = 0;
    if (anchor) {
      const i = order.indexOf(anchor.id);
      at = anchor.after ? i + 1 : i;
    }
    order.splice(at, 0, id);

    // Only queue_rank is written (and updated_at on the moved item): a neighbour that shifts down a place has
    // not been edited, so its recency (`ob list`, `ob show`) stays as it was.
    const current = new Map(rows.map((r) => [r.id, r.queue_rank]));
    for (let i = 0; i < order.length; i++) {
      const rowId = order[i]!;
      if (rowId === id) {
        await tx.q.update(tx.t.item).set({ queue_rank: i + 1, updated_at: nowIso() }).where(eq(tx.t.item.id, rowId));
      } else if (current.get(rowId) !== i + 1) {
        await tx.q.update(tx.t.item).set({ queue_rank: i + 1 }).where(eq(tx.t.item.id, rowId));
      }
    }
    return { id, priority: band, priorityChanged, rank: at + 1 };
  });
}

/** The valid next statuses for an item (excluding its current one) — drives which drawer buttons enable. */
export function validNextStatuses(type: string, kind: Kind | null, from: string): string[] {
  // statusVocab is the universe of statuses this type/kind can hold; the machine gates each edge. An unknown
  // stored status has no moves (decide refuses it), so the list is empty.
  return statusVocab(type, kind).filter((s) => s !== from && machineAllows(type, kind, from, s));
}

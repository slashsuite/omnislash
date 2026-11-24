import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { buildStatus } from "../../../cli/src/commands/status.ts";
import { itemDetail } from "../../../cli/src/detail.ts";
import { resolveItemId } from "../../../cli/src/refs.ts";
import { TRANSITIONS, type TransitionAction } from "../../../../platform/dashboard-kit/src/server/item-transition.ts";
import { queueView, type QueueView } from "../../../../platform/dashboard-kit/src/server/queue.ts";
import {
  setPriority as setPriorityWrite,
  setQueueOrder as setQueueOrderWrite,
  setTodayRank as setTodayRankWrite,
  transitionItem as transitionItemWrite,
  type WriteContext,
} from "../../../../platform/dashboard-kit/src/server/writes.ts";
import type { ItemDetail, StatusSnapshot } from "../../../../platform/dashboard-kit/src/lib/types.ts";
import { assertSameOrigin } from "../../../../platform/dashboard-kit/src/server/same-origin.ts";
import { providedStore } from "../../provided-store.ts";
import type { QueueMove, QueueOrderResult } from "../../../cli/src/workflow.ts";

// OS-24: the home page's read and the item drawer's three server functions, on providedStore. The writes go
// through the kit's guarded writes (same-origin first, then the store) and its item-transition helper, the same
// cores `ob start/ready/block/close/reopen/today` use, so the drawer behaves as it does on Today. An id may be a
// ticket ref (`OS-24`): the home's "To review" rows carry the builder's ticket ref, so each server function
// resolves it to the item id first. Nothing here sends anything outside the machine.

export type HomeData = Pick<StatusSnapshot, "needs_review" | "focus">;

/** A ref or an id, resolved to the item id (unchanged when nothing resolves, so itemDetail names it). */
async function idOf(input: string): Promise<string> {
  return (await resolveItemId(await providedStore(), input)) ?? input;
}

/** A write's context with its id resolved. The same-origin guard runs first, so a cross-site POST is refused
 *  before the ref lookup reads the store, as the kit's writes refuse before they open it. */
async function writeFor<T extends { id: string }>(data: T): Promise<{ ctx: WriteContext; data: T }> {
  const request = getRequest();
  assertSameOrigin(request);
  return { ctx: { request, store: providedStore }, data: { ...data, id: await idOf(data.id) } };
}

const needId = (d: { id?: unknown } | undefined): string => {
  if (!d || typeof d.id !== "string" || !d.id) throw new Error("id required");
  return d.id;
};

/** The two lists the home page shows, from the same buildStatus the live snapshot carries. The wayfinder
 *  frontier is not shown here, so it is never fetched for this read. Read-only. */
export const getHome = createServerFn({ method: "GET" }).handler(async (): Promise<HomeData> => {
  const s = await buildStatus(await providedStore(), async () => []);
  // The client's AgentRow: a needs_review row always has its status (that is how it got in the bucket).
  const needs_review = s.needs_review.map((a) => ({ id: a.id, ticket: a.ticket, branch: a.branch, status: a.status ?? "", run: a.run ?? null, note: a.note ?? null }));
  return { needs_review, focus: s.focus };
});

/** The drawer's `ob show`-level detail for one item. Read-only. */
export const getItem = createServerFn({ method: "GET" })
  .validator((d: { id: string }) => ({ id: needId(d) }))
  .handler(async ({ data }): Promise<ItemDetail> => await itemDetail(await providedStore(), await idOf(data.id)));

/** Move an item (start|ready|block|unblock|move|close|reopen). A bad move throws and the drawer shows it. */
export const transitionItem = createServerFn({ method: "POST" })
  .validator((d: { id: string; action: string; reason?: string; owner?: string; to?: string }) => {
    const id = needId(d);
    if (typeof d.action !== "string" || !(TRANSITIONS as readonly string[]).includes(d.action)) {
      throw new Error(`action must be one of ${TRANSITIONS.join("|")}`);
    }
    for (const k of ["reason", "owner", "to"] as const) {
      if (d[k] !== undefined && typeof d[k] !== "string") throw new Error(`${k} must be a string`);
    }
    return { id, action: d.action as TransitionAction, reason: d.reason, owner: d.owner, to: d.to };
  })
  .handler(async ({ data }): Promise<ItemDetail> => {
    const w = await writeFor(data);
    return await transitionItemWrite(w.ctx, w.data);
  });

/** Rank an item into Today: an explicit rank, or the next slot when the rank is blank. */
export const setTodayRank = createServerFn({ method: "POST" })
  .validator((d: { id: string; rank?: number | null }) => {
    const id = needId(d);
    if (d.rank != null && (typeof d.rank !== "number" || !Number.isInteger(d.rank))) throw new Error("rank must be a whole number or null");
    return { id, rank: d.rank ?? undefined };
  })
  .handler(async ({ data }): Promise<ItemDetail> => {
    const w = await writeFor(data);
    return await setTodayRankWrite(w.ctx, w.data);
  });

// OS-25: the Queue page's read and its two writes.

const isPriority = (p: unknown): p is number => typeof p === "number" && Number.isInteger(p) && p >= 0 && p <= 6;

/** A group's queue, banded by priority (`?team=`, OS-185), or one project's in it (`?project=`). Read-only. */
export const getQueue = createServerFn({ method: "GET" })
  .validator((d: { team?: string; project?: string } | undefined) => {
    for (const k of ["team", "project"] as const) {
      if (d?.[k] !== undefined && typeof d[k] !== "string") throw new Error(`${k} must be a string`);
    }
    return { team: d?.team || undefined, project: d?.project || undefined };
  })
  .handler(async ({ data }): Promise<QueueView> => await queueView(await providedStore(), data));

/** Place an item in its project's queue (`ob order`): `top` (with an optional band), `before` or `after` an item. */
export const setQueueOrder = createServerFn({ method: "POST" })
  .validator((d: { id: string; move: QueueMove }) => {
    const id = needId(d);
    const m = d.move as Record<string, unknown> | undefined;
    let move: QueueMove;
    if (m && m.top === true) {
      if (m.priority !== undefined && !isPriority(m.priority)) throw new Error("priority must be 0-6");
      move = m.priority === undefined ? { top: true } : { top: true, priority: m.priority as number };
    } else if (m && typeof m.before === "string" && m.before) move = { before: m.before };
    else if (m && typeof m.after === "string" && m.after) move = { after: m.after };
    else throw new Error("move must be {top} or {before|after: id}");
    return { id, move };
  })
  .handler(async ({ data }): Promise<QueueOrderResult> => {
    const w = await writeFor(data);
    return await setQueueOrderWrite(w.ctx, w.data);
  });

/** Set an item's priority (`ob edit --priority`), 0-6 as priority.ts numbers them. */
export const setPriority = createServerFn({ method: "POST" })
  .validator((d: { id: string; priority: number }) => {
    const id = needId(d);
    if (!isPriority(d.priority)) throw new Error("priority must be 0-6");
    return { id, priority: d.priority };
  })
  .handler(async ({ data }): Promise<ItemDetail> => {
    const w = await writeFor(data);
    return await setPriorityWrite(w.ctx, w.data);
  });

import { getFocusProject } from "./config.ts";
import { eventsForItemFor, parsePayload } from "./events.ts";
import { MACHINE_SHADOW_SOURCE } from "./machine-shadow.ts";
import { getDetail, getItem, getLinearRef, getLinks, getTags, getTaskDetail, type LinkRow } from "./items.ts";
import { decisionsForItem, type Decision } from "./decisions.ts";
import { itemView } from "./output.ts";
import { dependencyRaises } from "./dep-priority.ts";
import { type Kind } from "./status.ts";
import { validNextStatuses } from "./workflow.ts";
import { aliasesOf } from "./refs.ts";
import type { Store } from "./db/store.ts";

// The `ob show`-level composition for a single item (#46 — UI F5). This is the SAME read logic
// cmdShow (commands/query.ts) renders — item view + tags + links + linear ref + type detail — extended
// with the activity trail (events.ts) and the item's associated PRs (derived from its github events),
// plus the validated next-status set that drives which drawer action buttons enable. A plain,
// serialisable object: the dashboard's getItem server fn returns it verbatim to the client.

export interface ItemDetailEvent {
  id: number;
  ts: string;
  source: string | null;
  type: string | null;
  actor: string | null;
  cause: string | null;
}

export interface ItemDetailPr {
  pr: string;
  url: string | null;
  latest_type: string | null;
  ts: string | null;
}

export interface ItemDetailLinear {
  linear_id: string | null;
  url: string | null;
  cached_title: string | null;
  cached_state: string | null;
}

/** A type-detail extension-table cell — always a JSON-safe scalar (the columns are text/int/null). */
export type DetailValue = string | number | boolean | null;

export interface ItemDetail {
  id: string;
  /** The per-project ref (`PS-12`, 1949), null for an item in a keyless project. Absent from an older host. */
  ref?: string | null;
  /** Refs the item held before a move (1949), oldest first. Absent from an older host. */
  aliases?: string[];
  type: string;
  title: string;
  status: string;
  priority: string | null;
  effective_priority: string;
  /** OS-216: the open item this one blocks that raised its effective priority, when one did. */
  raised_by?: string;
  today_rank: number | null;
  queue_rank: number | null;
  project: string | null;
  kind: string | null;
  block_reason: string | null;
  block_owner: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  body: string | null;
  tags: string[];
  links: LinkRow[];
  linear: ItemDetailLinear | null;
  detail: Record<string, DetailValue> | null;
  events: ItemDetailEvent[];
  /** The status-change trail (ob 1515), newest first. Absent from an older host's answer. */
  decisions?: Decision[];
  prs: ItemDetailPr[];
  /** Valid next statuses per the per-type/kind state model — drives which action buttons enable. */
  valid_next: string[];
}

/** Compose the item-drawer detail. Throws when the id is unknown (surfaced by the caller).
 *
 *  Ported to the store seam (337): the dashboard's item drawer reads through the same store the CLI does,
 *  so the drawer cannot render one engine's item beside another's activity trail. `eventsForItemFor`
 *  orders by `event.ts` then `event.id`, both NOT NULL, so the DESC read cannot meet the
 *  NULLS-FIRST-on-Postgres split and two events in the same millisecond keep a stable order. */
export async function itemDetail(store: Store, id: string, opts: { allowedProjects?: ReadonlySet<string> | undefined } = {}): Promise<ItemDetail> {
  const row = await getItem(store, id);
  if (!row) throw new Error(`no item with id '${id}'`);
  id = row.id;
  const focus = await getFocusProject(store);
  const view = itemView(row, focus, await dependencyRaises(store, focus, opts.allowedProjects));
  const detail = await getDetail(store, row.type, id);
  const taskDetail = row.type === "task" ? await getTaskDetail(store, id) : null;
  const linear = await getLinearRef(store, id);
  // OS-169: the state-machine shadow's rows are telemetry, not the item's activity.
  const events = await eventsForItemFor(store, id, 50, { notSource: MACHINE_SHADOW_SOURCE });

  // Associated PRs: the github-source events carry the pr (+ url) in their payload. Collapse to the
  // distinct PRs, each keeping its most-recent event's type/ts (events already come newest-first).
  const prMap = new Map<string, ItemDetailPr>();
  for (const e of events) {
    if (e.source !== "github") continue;
    const p = parsePayload<{ pr?: string | number; url?: string }>(e);
    const pr = p.pr != null ? String(p.pr) : null;
    if (!pr) continue;
    if (!prMap.has(pr)) prMap.set(pr, { pr, url: p.url ?? null, latest_type: e.type, ts: e.ts });
  }

  return {
    id: row.id,
    ref: row.ref ?? null,
    aliases: await aliasesOf(store, id),
    type: view.type,
    title: view.title,
    status: view.status,
    priority: view.priority,
    effective_priority: view.effective_priority,
    ...(view.raised_by ? { raised_by: view.raised_by } : {}),
    today_rank: view.today_rank,
    queue_rank: view.queue_rank,
    project: view.project,
    kind: view.kind,
    block_reason: view.block_reason,
    block_owner: view.block_owner,
    created_at: view.created_at,
    updated_at: view.updated_at,
    closed_at: view.closed_at,
    body: row.body,
    tags: await getTags(store, id),
    links: await getLinks(store, id),
    linear: linear
      ? { linear_id: linear.linear_id, url: linear.url, cached_title: linear.cached_title, cached_state: linear.cached_state }
      : null,
    // The type-specific detail (roadmap/decision/learning) or the task extension row. Those tables are
    // all text/int/null columns, so the values are JSON-safe scalars.
    detail: (detail ?? taskDetail) as Record<string, DetailValue> | null,
    events: events.map((e) => ({ id: e.id, ts: e.ts, source: e.source, type: e.type, actor: e.actor, cause: e.cause })),
    decisions: await decisionsForItem(store, id),
    prs: [...prMap.values()],
    valid_next: validNextStatuses(row.type, row.project_kind as Kind | null, row.status),
  };
}

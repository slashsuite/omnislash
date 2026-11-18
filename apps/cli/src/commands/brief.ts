import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, ne, not } from "drizzle-orm";
import { NON_QUEUE_TYPES } from "../status.ts";
import type { Ctx } from "../ctx.ts";
import { UsageError, AppError } from "../errors.ts";
import { print } from "../output.ts";
import { asStore, type Store } from "../db/store.ts";
import { getItem, getLinearRef, getLinks, getTags, type ItemRow } from "../items.ts";
import { parsePayload, type EventRow } from "../events.ts";
import { inFlightPrsFor, type InFlightPr, type PrState } from "./status.ts";

// ob brief (138 Part A): assemble the WORK-STATE material for a topic so a reply to a
// "what's the status of X / where's your work on Y" question can be drafted specifically and
// accurately. It reports facts from the tracker — it never drafts prose. Consumed by the
// /ob-slack-triage skill (--json) but usable standalone (text). Two forms:
//   ob brief <id>        — a single item (local id or linear_ref) + its links/events
//   ob brief --in-flight — everything in flight: open PRs by state + open items

const PR_STATES: PrState[] = ["addressing-comments", "waiting-review", "authoring"];

/** Bucket in-flight PRs into the three states (stable key order for the JSON contract). */
function prsByState(prs: InFlightPr[]): Record<PrState, InFlightPr[]> {
  return {
    "addressing-comments": prs.filter((p) => p.state === "addressing-comments"),
    "waiting-review": prs.filter((p) => p.state === "waiting-review"),
    authoring: prs.filter((p) => p.state === "authoring"),
  };
}

export interface BriefEvent {
  ts: string;
  source: string | null;
  type: string | null;
  actor: string | null;
  summary: string;
}

/** A short human phrase for an event row (for the "recent activity" list). */
function summarizeEvent(row: EventRow): string {
  const p = parsePayload<Record<string, unknown>>(row);
  const s = (k: string) => (p[k] == null ? "" : String(p[k]));
  switch (row.type) {
    case "pr_synced":
      return `${s("pr")} synced${p.is_draft ? " (draft)" : ""}${p.title ? ` — ${s("title")}` : ""}`;
    case "ready_for_review":
      return `${s("pr")} ready for review`;
    case "review":
      return `review ${s("state")} by ${p.author ?? "?"} on ${s("pr")}`.replace(/\s+/g, " ").trim();
    case "review_comment":
      return `review comment by ${p.author ?? "?"} on ${s("pr")}`;
    case "state_change":
      return `${s("entity")}: ${p.from ?? "?"} → ${s("to")}`;
    case "reopened":
      return `${s("entity")} reopened (${p.from ?? "?"} → ${s("to")})`;
    case "ticket_completed":
      return `${s("entity")} completed`;
    case "ticket_acs":
      return `${s("entity")} ACs synced${p.state ? ` (${s("state")})` : ""}`;
    default:
      return row.type ?? "event";
  }
}

/**
 * Every event, newest first -- read ONCE per brief (337).
 *
 * The filtering happens in TypeScript (a brief keeps an event for half a dozen unrelated reasons), and it
 * used to re-read the whole table for each pass. One read per invocation matters more against a Postgres
 * connection than it did against an in-process SQLite handle.
 *
 * `event.ts` and `event.id` are both NOT NULL, so the DESC ordering cannot meet the NULLS-FIRST
 * (Postgres) vs NULLS-LAST (SQLite) split, and `id` breaks ties so two events recorded in the same
 * millisecond cannot swap places between engines.
 */
async function eventRows(db: Database | Store): Promise<EventRow[]> {
  const s = asStore(db);
  return (await s.q.select().from(s.t.event).orderBy(desc(s.t.event.ts), desc(s.t.event.id))) as EventRow[];
}

/** Most-recent events matching `keep`, newest first, capped at `limit`. Pure. */
function recentEvents(
  rows: EventRow[],
  keep: (row: EventRow, p: Record<string, unknown>) => boolean,
  limit = 10,
): BriefEvent[] {
  const out: BriefEvent[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    if (!keep(row, parsePayload<Record<string, unknown>>(row))) continue;
    out.push({ ts: row.ts, source: row.source, type: row.type, actor: row.actor, summary: summarizeEvent(row) });
  }
  return out;
}

/** Resolve a brief arg to a local item: by local id, else by a mirrored linear_ref identifier. */
export async function resolveItem(db: Database | Store, arg: string): Promise<ItemRow | null> {
  const direct = await getItem(db, arg);
  if (direct) return direct;
  const s = asStore(db);
  const rows = (await s.q
    .select({ id: s.t.linearRef.item_id })
    .from(s.t.linearRef)
    .where(eq(s.t.linearRef.linear_id, arg))
    .limit(1)) as Array<{ id: string }>;
  return rows[0] ? getItem(db, rows[0].id) : null;
}

interface LinkView {
  rel_type: string;
  direction: "out" | "in";
  id: string;
  title: string | null;
  status: string | null;
}

export interface ItemBrief {
  form: "item";
  item: {
    id: string;
    type: string;
    title: string;
    status: string;
    priority: number | null;
    project: string | null;
    tags: string[];
    body: string | null;
    created_at: string;
    updated_at: string;
    block_reason: string | null;
    block_owner: string | null;
  };
  linear: { linear_id: string | null; url: string | null; cached_state: string | null; cached_title: string | null } | null;
  ticket: string | null;
  links: LinkView[];
  events: BriefEvent[];
}

export async function buildItemBrief(db: Database | Store, row: ItemRow): Promise<ItemBrief> {
  const linear = await getLinearRef(db, row.id);
  const ticket = linear?.linear_id ?? null;
  const links: LinkView[] = await Promise.all((await getLinks(db, row.id)).map(async (l) => {
    const other = await getItem(db, l.other);
    return { rel_type: l.rel_type, direction: l.direction, id: l.other, title: other?.title ?? null, status: other?.status ?? null };
  }));
  const events = recentEvents(await eventRows(db), (row2, p) => {
    if (row2.item_id === row.id) return true;
    return !!ticket && p.entity === ticket;
  });
  return {
    form: "item",
    item: {
      id: row.id,
      type: row.type,
      title: row.title,
      status: row.status,
      priority: row.priority,
      project: row.project_id,
      tags: await getTags(db, row.id),
      body: row.body,
      created_at: row.created_at,
      updated_at: row.updated_at,
      block_reason: row.block_reason,
      block_owner: row.block_owner,
    },
    linear: linear
      ? { linear_id: linear.linear_id, url: linear.url, cached_state: linear.cached_state, cached_title: linear.cached_title }
      : null,
    ticket,
    links,
    events,
  };
}

export function renderItemBrief(b: ItemBrief): string {
  const out: string[] = [];
  const i = b.item;
  out.push(`${i.id}  ${i.title}`);
  out.push(`  type:    ${i.type}    status: ${i.status}`);
  if (i.project) out.push(`  project: ${i.project}`);
  if (b.linear) {
    const state = b.linear.cached_state ? ` [${b.linear.cached_state}]` : "";
    out.push(`  linear:  ${b.linear.linear_id ?? "?"}${state}${b.linear.url ? `  ${b.linear.url}` : ""}`);
  }
  if (i.tags.length) out.push(`  tags:    ${i.tags.join(", ")}`);
  if (i.status === "blocked") out.push(`  blocked: ${i.block_reason ?? "?"}${i.block_owner ? ` (${i.block_owner})` : ""}`);
  out.push(`  updated: ${i.updated_at}`);

  if (i.body) {
    out.push("", "Body:");
    for (const bl of i.body.split("\n")) out.push(`  ${bl}`);
  }

  if (b.links.length) {
    out.push("", "Linked items");
    for (const l of b.links) {
      const arrow = l.direction === "out" ? "->" : "<-";
      out.push(`  ${arrow} ${l.rel_type} ${l.id}${l.title ? `  ${l.title}` : ""}${l.status ? ` [${l.status}]` : ""}`);
    }
  }

  out.push("", "Recent activity");
  if (b.events.length === 0) out.push("  (none)");
  else for (const e of b.events) out.push(`  ${e.ts.slice(0, 10)}  ${e.summary}`);

  return out.join("\n");
}

function renderPrGroup(prs: Record<PrState, InFlightPr[]>, indent: string): string[] {
  const out: string[] = [];
  let any = false;
  for (const st of PR_STATES) {
    for (const p of prs[st]) {
      any = true;
      const age = p.branch_age_days != null ? `, ${p.branch_age_days}d` : "";
      out.push(`${indent}[${p.state}] ${p.pr}  ${p.title ?? ""}  (+${p.additions}/-${p.deletions}${age})`);
    }
  }
  if (!any) out.push(`${indent}(none)`);
  return out;
}

export interface InFlightBrief {
  form: "in-flight";
  prs: Record<PrState, InFlightPr[]>;
  items: Array<{ id: string; title: string; status: string }>;
}

export async function buildInFlightBrief(db: Database | Store): Promise<InFlightBrief> {
  const s = asStore(db);
  const prs = await inFlightPrsFor(db);
  // Open, non-done items, ORDERED BY `item.id`: an ORDER BY-less read is rowid order on SQLite and
  // whatever the query optimiser chooses on Postgres, and this list is rendered.
  const items = (await s.q
    .select({ id: s.t.item.id, title: s.t.item.title, status: s.t.item.status })
    .from(s.t.item)
    .where(and(ne(s.t.item.status, "done"), not(inArray(s.t.item.type, NON_QUEUE_TYPES))))
    .orderBy(asc(s.t.item.id))) as Array<{ id: string; title: string; status: string }>;
  return { form: "in-flight", prs: prsByState(prs), items };
}

export function renderInFlightBrief(b: InFlightBrief): string {
  const out: string[] = ["In flight — everything open"];
  out.push("", "PRs");
  out.push(...renderPrGroup(b.prs, "  "));
  out.push("", "Items");
  if (b.items.length === 0) out.push("  (none)");
  else for (const i of b.items) out.push(`  ${i.id}  ${i.title} [${i.status}]`);
  return out.join("\n");
}

export type AnyBrief = ItemBrief | InFlightBrief;

export function renderBrief(b: AnyBrief): string {
  return b.form === "item" ? renderItemBrief(b) : renderInFlightBrief(b);
}

export function briefQuiet(b: AnyBrief): string {
  if (b.form === "item") return b.item.id;
  return PR_STATES.flatMap((s) => b.prs[s].map((p) => p.pr)).join("\n");
}

export async function cmdBrief(ctx: Ctx): Promise<void> {
  const { flags, mode } = ctx;
  const db = ctx.store ?? ctx.db;

  if (flags["in-flight"]) {
    const b = await buildInFlightBrief(db);
    if (mode === "json") return print(JSON.stringify(b, null, 2));
    if (mode === "quiet") {
      return print(briefQuiet(b));
    }
    return print(renderInFlightBrief(b));
  }

  const arg = ctx.args[0];
  if (!arg) throw new UsageError("brief requires an <id> or --in-flight");

  const row = await resolveItem(db, arg);
  if (!row) throw new AppError(`no item or linear ref '${arg}'`);
  const b = await buildItemBrief(db, row);
  if (mode === "json") return print(JSON.stringify(b, null, 2));
  if (mode === "quiet") return print(b.item.id);
  return print(renderItemBrief(b));
}

import type { Database } from "bun:sqlite";
import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { asStore, type Store } from "../db/store.ts";
import {
  addLink,
  getDecisionDetail,
  getItem,
  getLinks,
  queryItems,
  type LinkRow,
} from "../items.ts";
import { transitionTo } from "../workflow.ts";
import { print } from "../output.ts";

/** A directed supersession edge: `from` supersedes (replaces) `to`. */
export interface SupersedeEdge {
  from: string;
  to: string;
}

export interface SupersedeChain {
  /** Decisions that `id` (transitively) supersedes, oldest last. */
  supersedes: string[];
  /** Decisions that (transitively) supersede `id`, newest last. */
  supersededBy: string[];
}

/**
 * Walk a flat list of supersede edges to produce the chain around `id` in both
 * directions. Pure: no DB access, so it is trivially testable.
 */
export function chainFrom(edges: SupersedeEdge[], id: string): SupersedeChain {
  const walk = (pick: (e: SupersedeEdge, cur: string) => string | null): string[] => {
    const out: string[] = [];
    const seen = new Set<string>([id]);
    let cur = id;
    for (;;) {
      let next: string | null = null;
      for (const e of edges) {
        const cand = pick(e, cur);
        if (cand !== null && !seen.has(cand)) {
          next = cand;
          break;
        }
      }
      if (next === null) break;
      out.push(next);
      seen.add(next);
      cur = next;
    }
    return out;
  };
  return {
    supersedes: walk((e, cur) => (e.from === cur ? e.to : null)),
    supersededBy: walk((e, cur) => (e.to === cur ? e.from : null)),
  };
}

/** Normalise a node's links into supersede edges (both directions). */
export function supersedeEdgesFromLinks(links: LinkRow[], node: string): SupersedeEdge[] {
  const edges: SupersedeEdge[] = [];
  for (const l of links) {
    if (l.rel_type !== "supersedes") continue;
    edges.push(l.direction === "out" ? { from: node, to: l.other } : { from: l.other, to: node });
  }
  return edges;
}

/** Gather every supersede edge reachable from `startId` by walking `getLinks`. */
export async function collectSupersedeEdges(db: Database | Store, startId: string): Promise<SupersedeEdge[]> {
  const edges: SupersedeEdge[] = [];
  const visited = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const e of supersedeEdgesFromLinks(await getLinks(db, cur), cur)) {
      if (!edges.some((x) => x.from === e.from && x.to === e.to)) edges.push(e);
      const other = e.from === cur ? e.to : e.from;
      if (!visited.has(other)) queue.push(other);
    }
  }
  return edges;
}

async function requireDecision(db: Database | Store, id: string, role: string) {
  const item = await getItem(db, id);
  if (!item) throw new UsageError(`${role} '${id}' does not exist`);
  if (item.type !== "decision") throw new UsageError(`${role} '${id}' is not a decision`);
  return item;
}

/** Apply a supersession in a single transaction. Returns the affected ids/statuses. */
export async function supersede(
  db: Database | Store,
  newId: string,
  oldId: string,
): Promise<{ newId: string; oldId: string; newStatus: string; oldStatus: string }> {
  newId = (await requireDecision(db, newId, "new decision")).id;
  oldId = (await requireDecision(db, oldId, "old decision")).id;
  if (newId === oldId) throw new UsageError("a decision cannot supersede itself");
  // Store.txn rather than writeTxn (337): the body awaits, and bun:sqlite's own transaction requires a
  // synchronous one. The three writes stay one atomic move, which is the point of the transaction here --
  // a link without both status changes is a chain that reads as broken.
  await asStore(db).txn("supersede the decision", async (tx) => {
    await addLink(tx, newId, "supersedes", oldId);
    // OB-1928: validated moves on the trail, so the decision vocabulary refuses (and rolls back) a
    // supersede the table forbids, e.g. a superseded decision made accepted again.
    await transitionTo(tx, oldId, "superseded");
    await transitionTo(tx, newId, "accepted");
  });
  return { newId, oldId, newStatus: "accepted", oldStatus: "superseded" };
}

async function listDecisions(ctx: Ctx): Promise<void> {
  const items = await queryItems(ctx.store ?? ctx.db, { type: "decision", status: ctx.flags.status });
  items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  if (ctx.mode === "json") {
    print(
      JSON.stringify(
        items.map((i) => ({ id: i.id, status: i.status, title: i.title })),
        null,
        2,
      ),
    );
    return;
  }
  if (ctx.mode === "quiet") {
    print(items.map((i) => i.id).join("\n"));
    return;
  }
  print(renderDecisionList(items));
}

async function showDecision(ctx: Ctx, id: string): Promise<void> {
  const store = ctx.store ?? ctx.db;
  const item = await requireDecision(store, id, "decision");
  id = item.id;
  const detail = await getDecisionDetail(store, id);
  const links = await getLinks(store, id);
  const references = links.filter((l) => l.rel_type === "references");
  const chain = chainFrom(await collectSupersedeEdges(store, id), id);

  if (ctx.mode === "json") {
    print(
      JSON.stringify(
        {
          id: item.id,
          title: item.title,
          status: item.status,
          detail,
          references: references.map((r) => ({ direction: r.direction, id: r.other })),
          supersedes: chain.supersedes,
          superseded_by: chain.supersededBy,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (ctx.mode === "quiet") {
    print(id);
    return;
  }

  const lines: string[] = [];
  lines.push(`${item.id}  ${item.title}`);
  lines.push(`  status:       ${item.status}`);
  const field = (label: string, key: string) => {
    const v = detail?.[key];
    if (v !== null && v !== undefined && v !== "") lines.push(`  ${label.padEnd(12)}${String(v)}`);
  };
  field("context:", "context");
  field("choice:", "choice");
  field("rationale:", "rationale");
  field("alternatives:", "alternatives");
  field("doubt:", "doubt");
  field("undo:", "undo");
  field("decided_at:", "decided_at");
  for (const r of references) {
    lines.push(`  references:   ${r.direction === "out" ? "->" : "<-"} ${r.other}`);
  }
  if (chain.supersedes.length > 0) {
    lines.push(`  supersedes:   ${chain.supersedes.join(" -> ")}`);
  }
  if (chain.supersededBy.length > 0) {
    lines.push(`  superseded_by:${" "}${chain.supersededBy.join(" -> ")}`);
  }
  print(lines.join("\n"));
}

export function renderDecisionList(items: Array<{ id: string; status: string; title: string }>): string {
  return items.map((i) => `${i.id}\t${i.status.padEnd(10)}\t${i.title}`).join("\n");
}

export async function cmdDecision(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];

  if (sub === undefined || sub === "list") {
    await listDecisions(ctx);
    return;
  }

  if (sub === "supersede") {
    const newId = ctx.args[1];
    const oldId = ctx.args[2];
    if (!newId || !oldId) {
      throw new UsageError("decision supersede requires <newId> <oldId>");
    }
    const r = await supersede(ctx.store ?? ctx.db, newId, oldId);
    if (ctx.mode === "json") {
      print(JSON.stringify(r, null, 2));
    } else if (ctx.mode !== "quiet") {
      print(`${r.newId} (accepted) supersedes ${r.oldId} (superseded)`);
    } else {
      print(r.newId);
    }
    return;
  }

  // Otherwise treat the positional as a decision id.
  await showDecision(ctx, sub);
}

// OS-216: effective priority follows dependencies. Jacobus, 2026-11-25: "raise effective priority automatically
// down the dependency chain; stored priority unchanged." When A blocks B (B depends on A) and B is open, A's
// effective priority is at least B's, and so on down the chain: a low ticket that blocks a high one shows high.
// Only the effective priority moves; the stored `priority` column is never written here.
import type { Database } from "bun:sqlite";
import type { Store } from "./db/store.ts";
import { blocksLinks, priorityRows } from "./items.ts";
import { effectivePriority, prioritySortRank } from "./priority.ts";
import { isClosedStatus } from "./status.ts";

export interface PriorityNode {
  id: string;
  ref: string | null;
  type: string;
  status: string;
  priority: number | null;
  project_id: string | null;
}

/** Why an item's effective priority is higher than its own: the priority, and the open dependent it came from. */
export interface Raise {
  priority: number;
  /** The item this one blocks that passed the priority down (the next link up the chain). */
  via: string;
  viaRef: string | null;
}

export type Raises = ReadonlyMap<string, Raise>;

/**
 * Pure: the raises a set of `blocks` links gives. `from` blocks `to`. A closed dependent passes nothing down, so a
 * finished ticket stops lifting what it waited on. Iterated to a fixed point, so a chain of any length is covered
 * and a cycle (A blocks B blocks A) settles instead of looping: a value only ever moves to a better rank.
 */
export function computeRaises(
  nodes: readonly PriorityNode[],
  links: ReadonlyArray<{ from: string; to: string }>,
  focusProject: string | null,
): Map<string, Raise> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const eff = new Map<string, number>();
  for (const n of nodes) eff.set(n.id, effectivePriority({ priority: n.priority, projectId: n.project_id, focusProject }));
  const raises = new Map<string, Raise>();
  const live = links.filter((l) => {
    const to = byId.get(l.to);
    return byId.has(l.from) && to !== undefined && !isClosedStatus(to.type, to.status) && l.from !== l.to;
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (const l of live) {
      const up = eff.get(l.to)!;
      if (prioritySortRank(up) < prioritySortRank(eff.get(l.from)!)) {
        eff.set(l.from, up);
        raises.set(l.from, { priority: up, via: l.to, viaRef: byId.get(l.to)!.ref });
        changed = true;
      }
    }
  }
  return raises;
}

/** No raises: for a write's echo, where nothing is ranked. */
export const NO_RAISES: Raises = new Map();

/**
 * Every raise in the store: all `blocks` links and the items on either end of them. With `allowedProjects` (a scoped
 * API token) only items in those projects take part, so a raise never comes from, or names, an item the caller
 * cannot see (OS-178's rule for links).
 */
export async function dependencyRaises(
  db: Database | Store,
  focusProject: string | null,
  allowedProjects?: ReadonlySet<string>,
): Promise<Map<string, Raise>> {
  const links = await blocksLinks(db);
  if (links.length === 0) return new Map();
  const ids = [...new Set(links.flatMap((l) => [l.from, l.to]))];
  const rows = await priorityRows(db, ids);
  const visible = allowedProjects ? rows.filter((r) => r.project_id !== null && allowedProjects.has(r.project_id)) : rows;
  return computeRaises(visible, links, focusProject);
}

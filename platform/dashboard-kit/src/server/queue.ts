// OS-25: the execution queue as the Queue page shows it (OS-185: a group's projects merged, or one project's): its open items in `ob next` order, under one
// band per priority. Read-only.
//
// The order is `ob next --project <slug>`'s with Today set aside (the architect's call 1, 2026-11-24): `ob next`
// puts a Today-ranked item first whatever its band, which would break the bands, so each band here is ordered by
// `compareWithinBand` alone, the same order `setQueueOrder` numbers from, and a Today item carries a mark in its
// place. The items come from `nextWorklist`, so the set (open, NON_QUEUE_TYPES left out) and the effective
// priority (no priority in the focus project counts as high) are ob next's own.

import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { itemsStamp, tagsForItems } from "../../../../apps/cli/src/items.ts";
import { effectivePriority, priorityName, RANK_ORDER } from "../../../../apps/cli/src/priority.ts";
import { compareWithinBand, nextWorklist } from "../../../../apps/cli/src/worklist.ts";
import { resolveScope, type GroupProject, type ProjectGroup } from "./groups.ts";

export interface QueueRow {
  id: string;
  ref: string | null;
  title: string;
  status: string;
  /** The effective priority, the band it sits in. */
  priority: number;
  tags: string[];
  /** Ranked into Today (`ob today`): `ob next` lists it first, the page marks it in its band. */
  today: boolean;
  /** OS-185: the project it is in, named on the row when the page shows a whole group. */
  project: GroupProject;
}

export interface QueueBand {
  /** The priority integer (priority.ts). */
  priority: number;
  /** Its name, also the SortableSection id. */
  name: string;
  items: QueueRow[];
}

export interface QueueView {
  /** OS-185: the group shown, every group to pick from, and the project drilled into (null: the whole group). */
  group: ProjectGroup;
  groups: ProjectGroup[];
  project: GroupProject | null;
  /** Every band, best first, an empty one included (it takes a drop). */
  bands: QueueBand[];
  /** The store's itemsStamp at this read, the baseline the page compares the live snapshot's against. */
  itemsStamp: string;
}

/**
 * A group's queue (OS-185), its projects' open items merged band by band, or one project's when `project` names
 * one. `groups.ts` resolveScope picks the group: the named team, else the focus project's, else Slash. A band's
 * order across projects is ob next's own (kind, then each project's queue rank, then recency).
 */
export async function queueView(store: Store, ask: { team?: string; project?: string } = {}): Promise<QueueView> {
  const scope = await resolveScope(store, ask);
  const projectOf = new Map(scope.group.projects.map((p) => [p.id, p]));
  const { items, focusProject } = await nextWorklist(store, scope.project ? { project: scope.project.id } : { allowedProjects: new Set(scope.projectIds) });
  const stamp = await itemsStamp(store);
  const tags = await tagsForItems(store, items.map((i) => i.id));
  const bands: QueueBand[] = RANK_ORDER.map((priority) => ({ priority, name: priorityName(priority), items: [] }));
  const byPriority = new Map(bands.map((b) => [b.priority, b]));
  for (const item of [...items].sort(compareWithinBand)) {
    const priority = effectivePriority({ priority: item.priority, projectId: item.project_id, focusProject });
    byPriority.get(priority)?.items.push({
      id: item.id,
      ref: item.ref,
      title: item.title,
      status: item.status,
      priority,
      tags: tags.get(item.id) ?? [],
      today: item.today_rank !== null,
      project: projectOf.get(item.project_id!)!,
    });
  }
  return { group: scope.group, groups: scope.groups, project: scope.project, bands, itemsStamp: stamp };
}

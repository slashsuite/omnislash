// OS-25: one project's execution queue as the Queue page shows it: its open items in `ob next` order, under one
// band per priority. Read-only.
//
// The order is `ob next --project <slug>`'s with Today set aside (the architect's call 1, 2026-11-24): `ob next`
// puts a Today-ranked item first whatever its band, which would break the bands, so each band here is ordered by
// `compareWithinBand` alone, the same order `setQueueOrder` numbers from, and a Today item carries a mark in its
// place. The items come from `nextWorklist`, so the set (open, NON_QUEUE_TYPES left out) and the effective
// priority (no priority in the focus project counts as high) are ob next's own.

import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { AppError } from "../../../../apps/cli/src/errors.ts";
import { itemsStamp, tagsForItems } from "../../../../apps/cli/src/items.ts";
import { effectivePriority, priorityName, RANK_ORDER } from "../../../../apps/cli/src/priority.ts";
import { getProject, listProjects } from "../../../../apps/cli/src/project.ts";
import { compareWithinBand, nextWorklist } from "../../../../apps/cli/src/worklist.ts";

/** The project the page opens on when the URL names none (call 4). */
export const DEFAULT_QUEUE_PROJECT = "omnislash";

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
}

export interface QueueBand {
  /** The priority integer (priority.ts). */
  priority: number;
  /** Its name, also the SortableSection id. */
  name: string;
  items: QueueRow[];
}

export interface QueueProject {
  id: string;
  label: string;
}

export interface QueueView {
  project: QueueProject;
  projects: QueueProject[];
  /** Every band, best first, an empty one included (it takes a drop). */
  bands: QueueBand[];
  /** The store's itemsStamp at this read, the baseline the page compares the live snapshot's against. */
  itemsStamp: string;
}

/** One project's queue. `project` is an id or a name; absent, the default project, else the first one. */
export async function queueView(store: Store, project?: string): Promise<QueueView> {
  const all = await listProjects(store);
  const projects = all.map((p) => ({ id: p.id, label: p.display_name ?? p.name }));
  const wanted = project ?? (all.some((p) => p.id === DEFAULT_QUEUE_PROJECT) ? DEFAULT_QUEUE_PROJECT : all[0]?.id);
  if (wanted === undefined) throw new AppError("no projects yet (ob project add)");
  const p = await getProject(store, wanted);
  if (!p) throw new AppError(`no project '${wanted}'`);

  const { items, focusProject } = await nextWorklist(store, { project: p.id });
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
    });
  }
  return { project: { id: p.id, label: p.display_name ?? p.name }, projects, bands, itemsStamp: stamp };
}

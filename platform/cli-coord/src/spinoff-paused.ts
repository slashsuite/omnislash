// OS-134: a paused or archived project's tickets are not dispatched. `ob spinoff`, `ob spinoff queue` and the API
// enqueue refuse one before the row exists, naming the status; `ob spinoff drain` (and the API's launchable read)
// leaves an already-queued row pending, reported as not ready. `--allow-paused '<why>'` overrides: the reason goes
// on the item's Decisions trail, bound to the row, and that row then launches (a drain reads the trail by row id).
// Modelled on `--no-flake-slot` (spinoff-flake.ts).

import type { Database } from "bun:sqlite";
import { AppError, UsageError } from "../../../apps/cli/src/errors.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import { getItem } from "../../../apps/cli/src/items.ts";
import { getProject } from "../../../apps/cli/src/project.ts";
import { isProjectHeld, projectStatusOf, type ProjectStatus } from "../../../apps/cli/src/project-status.ts";
import { decisionsForItem, recordDecision } from "../../../apps/cli/src/decisions.ts";
import { rowItemId, ticketItemIdFor } from "./spinoff-item.ts";

/** The trail's `to` for an `--allow-paused` override; its `from` is the project's status (`paused|archived`). */
const ALLOW_PAUSED_TO = "allow-paused";

/** The held project behind an item, or null when the item has none or its project is active. */
async function heldProjectOf(db: Database | Store, itemId: string | null): Promise<{ id: string; status: ProjectStatus } | null> {
  if (!itemId) return null;
  const item = await getItem(db, itemId);
  if (!item?.project_id) return null;
  const project = await getProject(db, item.project_id);
  if (!project || !isProjectHeld(project)) return null;
  return { id: project.id, status: projectStatusOf(project) };
}

/** The refusal, naming the project and its status. Pure. */
function pausedProjectMessage(project: { id: string; status: ProjectStatus }): string {
  return `project ${project.id} is ${project.status}`;
}

/**
 * Refuse a dispatch whose ticket is in a paused or archived project. Thrown before the row is queued, so nothing
 * is left behind. A blank `--allow-paused` is refused (the reason is the point); a non-blank one lets it through.
 * Returns the held project when the dispatch goes ahead under the override (so the caller records it), else null.
 */
export async function refusePausedProject(
  db: Database | Store,
  ticketRef: string,
  allowPaused: string | undefined | null,
): Promise<{ id: string; status: ProjectStatus } | null> {
  if (allowPaused !== undefined && allowPaused !== null && allowPaused.trim() === "") {
    throw new UsageError("--allow-paused needs a reason: --allow-paused '<why>'");
  }
  const held = await heldProjectOf(db, await ticketItemIdFor(db, ticketRef));
  if (!held) return null;
  if (allowPaused) return held;
  throw new AppError(
    `not dispatched: ${ticketRef} is in ${pausedProjectMessage(held)}. Nothing was queued. ` +
      `Resume it with 'ob project resume ${held.id}', or dispatch with --allow-paused '<why>'`,
  );
}

/** Record an `--allow-paused` override on the item's trail, bound to the row it lets launch. */
export async function recordAllowPaused(
  db: Database | Store,
  row: { id: number; ticket_ref: string; item_id?: string | null },
  held: { status: ProjectStatus },
  why: string,
  actor?: string | null,
): Promise<void> {
  const itemId = row.item_id ?? (await ticketItemIdFor(db, row.ticket_ref));
  if (!itemId) return;
  await recordDecision(db, itemId, held.status, ALLOW_PAUSED_TO, { actor, note: why, spinoffRow: row.id });
}

/**
 * Why a queued row may not launch: its project is paused or archived and no `--allow-paused` released THIS row.
 * Null when it may launch. Read by the drain and the API's launchable list.
 */
export async function pausedRowReason(
  db: Database | Store,
  row: { id: number; ticket_ref: string; item_id?: string | null },
): Promise<string | null> {
  const itemId = await rowItemId(db, row);
  const held = await heldProjectOf(db, itemId);
  if (!held) return null;
  const trail = await decisionsForItem(db, itemId!);
  if (trail.some((d) => d.to === ALLOW_PAUSED_TO && d.spinoff_row === row.id)) return null;
  return `${pausedProjectMessage(held)}; 'ob project resume ${held.id}', or re-dispatch with --allow-paused '<why>'`;
}

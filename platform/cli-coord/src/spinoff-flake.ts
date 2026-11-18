// OB-2230: one flake fix at a time on the whole machine, and its builder tests inside `flake-box`.
//
// Only one flake is fixed at a time: not one flake per planner, one flake in total.
// A ticket is a flake by its priority `flake` (OB-2060). `ob spinoff` takes the machine-wide `flake:slot` lease
// for a flake row's builder at the claim, atomically with its `ticket:` and `worktree:` leases, and the
// handoff, `ob close`, `ob spinoff abandon` and a failed launch free it. A dispatch that finds the slot held by
// another builder is refused before any row exists. `--no-flake-slot '<why>'` launches without taking it, and
// the reason goes on the Decisions trail.
//
// The slot is a DISPATCH slot, not a test lease: inside the box a builder runs its tests with no lease and no
// time cap (the OB-2229 ten minute cap is for normal `cpu:` runs only).

import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { inArray } from "drizzle-orm";
import { AppError, UsageError } from "../../../apps/cli/src/errors.ts";
import { asStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { getItem } from "../../../apps/cli/src/items.ts";
import { PRIORITY_FLAKE } from "../../../apps/cli/src/priority.ts";
import { decisionsForItem, recordDecision } from "../../../apps/cli/src/decisions.ts";
import { defineSeam } from "../../../apps/cli/src/test-seams.ts";
import { builderIdOf } from "./clean-repo.ts";
import { liveHold } from "./lease.ts";
import { rowItemId, ticketItemIdFor } from "./spinoff-item.ts";

/** The one machine-wide flake fix slot. */
export const FLAKE_SLOT_KEY = "flake:slot";

/**
 * How long the slot is held between beats: 6 hours. A builder that stops heartbeating frees it within that;
 * `ob agent heartbeat <id>` moves the expiry of every lease the builder holds, this one included.
 */
export const FLAKE_SLOT_TTL_S = 21600;

/** Where the box lives on the desktop (`/etc/systemd/system/flake.slice`, `/etc/sudoers.d/98-flake-box`). */
const FLAKE_BOX_PATH = "/usr/local/bin/flake-box";

/** A string every flake-box paragraph carries, so a message is never given a second one. */
export const FLAKE_BOX_MARKER = "Run every test and every reproduction through `flake-box <command>`";

/** The trail's `from` and `to` for a `--no-flake-slot` override. */
const FLAKE_SLOT_FROM = "flake-slot";
const NO_FLAKE_SLOT_TO = "no-flake-slot";

const flakeBoxSeam = defineSeam<() => boolean>("cli-coord/spinoff-flake.flakeBoxPresent", () => existsSync(FLAKE_BOX_PATH));

/** Is `flake-box` on this machine? A seam, so a test decides. */
export function flakeBoxPresent(): boolean {
  return flakeBoxSeam.get()();
}

/** Test seam: install a fake box check; returns the restore. */
export function __setFlakeBoxPresent(fn: () => boolean): () => void {
  return flakeBoxSeam.set(fn);
}

/** Is this item at priority `flake`? */
async function itemIsFlake(db: Database | Store, itemId: string | null | undefined): Promise<boolean> {
  // No catch: a store that cannot answer must not launch a flake row without its slot.
  return itemId ? (await getItem(db, itemId))?.priority === PRIORITY_FLAKE : false;
}

/** Is the ticket behind this ref at priority `flake`? */
export async function ticketIsFlake(db: Database | Store, ticketRef: string): Promise<boolean> {
  return itemIsFlake(db, await ticketItemIdFor(db, ticketRef));
}

/**
 * The paragraph a flake row's launch prompt carries, before the directive to run the spinoff skill. `present`
 * is whether `flake-box` is on the machine that launches the builder, null when that is not known here. Pure.
 */
export function flakeBoxParagraph(present: boolean | null): string {
  const lines = [
    "This is a flake fix, the one flake fix on this machine (ob spinoff holds `flake:slot` for you; the handoff, close or abandon frees it). " +
      FLAKE_BOX_MARKER +
      ": it runs in `flake.slice`, which has CPUs 4, 5, 10 and 11 to itself, 8 GiB and no swap, so you can loop a test without touching anyone else. " +
      "Inside the box no lease applies and there is no time cap: no `ob lease run cpu:browser`, no 10 minute limit, loop it for as long as it takes to fail. " +
      "To starve the test further, pin it to fewer of the box's CPUs with `flake-box taskset -c 4 <command>`. " +
      "Never `systemd-run --user` inside the box (that leaves it), and never start a machine-wide load generator (busy loops, `stress`). " +
      "Name the command that reproduced it in the handoff.",
  ];
  if (present === null) {
    lines.push(
      `If \`${FLAKE_BOX_PATH}\` is not on the machine you run on (\`ls ${FLAKE_BOX_PATH}\`), there is no box: run the reproduction pinned with \`taskset\` to a few CPUs, still with no machine-wide load generator, and say in the handoff that it ran without the box.`,
    );
  } else if (!present) {
    lines.push(
      `\`${FLAKE_BOX_PATH}\` is not on this machine, so there is no box here: run the reproduction pinned with \`taskset\` to a few CPUs, still with no machine-wide load generator, and say in the handoff that it ran without the box.`,
    );
  }
  return lines.join(" ");
}

/**
 * Put the flake paragraph into a launch message: just before `directive` when the message carries it (a
 * ticket-composed brief), else at the end (a caller's own `--brief`). Pure.
 */
export function withFlakeParagraph(ask: string, paragraph: string, directive: string): string {
  const at = ask.lastIndexOf(directive);
  if (at < 0) return `${ask.trimEnd()}\n\n${paragraph}`;
  return `${ask.slice(0, at)}${paragraph}\n\n${ask.slice(at)}`;
}

/** The warning a flake dispatch prints on a machine with no box. Pure. */
export function noFlakeBoxWarning(ref: string): string {
  return `  ⚠ ${ref} is a flake fix, but ${FLAKE_BOX_PATH} is not on this machine: the builder is told to run without the box`;
}

/** The refusal when another builder holds the slot. Pure. */
export function flakeSlotHeldMessage(holder: string, ref: string | null): string {
  return `${FLAKE_SLOT_KEY} held by ${holder}${ref ? ` for ${ref}` : ""}; one flake fix at a time`;
}

/** Statuses of a row whose builder may still hold the slot. */
const LIVE_ROW_STATUSES = ["launching", "launched", "ready-for-gate"];

/** The ticket a slot holder is building, read off its live spinoff row, or null when none names it. */
export async function flakeSlotRefFor(db: Database | Store, holder: string): Promise<string | null> {
  const s = asStore(db);
  const rows = (await s.q
    .select()
    .from(s.t.spinoff)
    .where(inArray(s.t.spinoff.status, LIVE_ROW_STATUSES))) as Array<Parameters<typeof builderIdOf>[0]>;
  const row = rows.find((r) => r.branch === holder || builderIdOf(r) === holder);
  return row?.ticket_ref ?? null;
}

/** A blank `--no-flake-slot` is refused: the reason is the point of the override. Pure. */
function refuseEmptyNoFlakeSlot(why: string | undefined | null): void {
  if (why !== undefined && why !== null && why.trim() === "") {
    throw new UsageError("--no-flake-slot needs a reason: --no-flake-slot '<why>'");
  }
}

/**
 * Refuse a flake dispatch while another builder holds the slot (OB-2230). Thrown before the row is queued, so
 * nothing is left behind. `self` are the holders that count as this dispatch (its builder id, its branch, the
 * `--holder` it runs under): a hold of one of those is its own, not a collision. A non-flake ticket and a
 * `--no-flake-slot` dispatch are never refused here.
 */
export async function refuseHeldFlakeSlot(
  db: Database | Store,
  ticketRef: string,
  self: string[],
  noFlakeSlot: string | undefined | null,
): Promise<boolean> {
  refuseEmptyNoFlakeSlot(noFlakeSlot);
  if (!(await ticketIsFlake(db, ticketRef))) return false;
  if (noFlakeSlot) return true;
  const hold = await liveHold(db, FLAKE_SLOT_KEY);
  if (hold && !self.filter(Boolean).includes(hold.holder)) {
    throw new AppError(
      `not dispatched: ${flakeSlotHeldMessage(hold.holder, await flakeSlotRefFor(db, hold.holder))}. Nothing was queued. ` +
        `Wait for that fix to hand off, or dispatch with --no-flake-slot '<why>'; 'ob lease release ${FLAKE_SLOT_KEY} --force' ONLY if that holder is gone`,
    );
  }
  return true;
}

/** Record a `--no-flake-slot` override on the item's trail, bound to the row it lets launch without the slot. */
export async function recordNoFlakeSlot(
  db: Database | Store,
  row: { id: number; ticket_ref: string; item_id?: string | null },
  why: string,
  actor?: string | null,
): Promise<void> {
  const itemId = row.item_id ?? (await ticketItemIdFor(db, row.ticket_ref));
  if (!itemId) return;
  await recordDecision(db, itemId, FLAKE_SLOT_FROM, NO_FLAKE_SLOT_TO, { actor, note: why, spinoffRow: row.id });
}

/** Did a `--no-flake-slot` dispatch release THIS row from the slot? Read off the trail, by row id. */
async function rowOverridesFlakeSlot(db: Database | Store, itemId: string, rowId: number): Promise<boolean> {
  const trail = await decisionsForItem(db, itemId);
  return trail.some((d) => d.from === FLAKE_SLOT_FROM && d.to === NO_FLAKE_SLOT_TO && d.spinoff_row === rowId);
}

/**
 * Does this row's launch take `flake:slot`? Yes for a row whose item is at priority `flake`, unless a
 * `--no-flake-slot` dispatch released that row. A flake ticket runs no model trial, so there is no second leg.
 */
async function rowTakesFlakeSlot(
  db: Database | Store,
  row: { id: number; ticket_ref: string; item_id?: string | null; trial_leg?: string | null },
): Promise<boolean> {
  const itemId = await rowItemId(db, row as never);
  if (!(await itemIsFlake(db, itemId))) return false;
  return !(await rowOverridesFlakeSlot(db, itemId!, row.id));
}

/** `flake:slot` when this row's launch takes it, else null: an extra key for the claim's one transaction. */
export async function flakeSlotKeyFor(
  db: Database | Store,
  row: { id: number; ticket_ref: string; item_id?: string | null; trial_leg?: string | null },
): Promise<string | null> {
  return (await rowTakesFlakeSlot(db, row)) ? FLAKE_SLOT_KEY : null;
}

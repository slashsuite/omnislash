import { existsSync } from "node:fs";
import { createServerFn } from "@tanstack/react-start";
import { inArray, or } from "../../../cli/src/db/orm.ts";
import { decisionsStamp } from "../../../cli/src/decisions.ts";
import { itemsStamp, tagsForItems } from "../../../cli/src/items.ts";
import { nextWorklist } from "../../../cli/src/worklist.ts";
import { listAgents } from "../../../../platform/cli-coord/src/agent.ts";
import { builderIdOf, legRef, rowStateText } from "../../../../platform/cli-coord/src/clean-repo.ts";
import { listSpinoffs, rowVerdictState } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { currentCheckVerdicts } from "../../../../platform/cli-coord/src/spinoff-check.ts";
import { isSpikeTagged, sectionItems } from "../../../../platform/cli-coord/src/spinoff-spike.ts";
import { providedStore } from "../../provided-store.ts";
import { inFlight, landed, machineStamp, phaseOf, placeOpen, placeRow, type MachineItem, type MachineRow, type MachineView } from "../lib/machine.ts";

// OS-165: the Machine page's one read. The in-flight spinoff rows, each placed on its role state (lib/machine.ts
// placeRow, section 7 of the role machine doc), then every open ticket with no row in flight on its planning state
// (placeOpen, OS-241) in `ob next` order, and the stamp the page compares the live snapshot against. Read-only.
// The verdict (recorded, else the branch's State: line) is read only for handed-off rows (see placeRow).

/**
 * A handed-off row's verdict: the recorded one, else the branch's State: line, read only when the row's worktree is
 * on this host. git run against an empty or missing worktree reads the server's own checkout and borrows its verdict.
 */
function verdictOf(row: Parameters<typeof rowVerdictState>[0]): string | null {
  return row.worktree && existsSync(row.worktree) ? rowVerdictState(row) : rowStateText(row);
}

async function machineView(): Promise<MachineView> {
  const store = await providedStore();
  const spinoffs = await listSpinoffs(store);
  const agents = await listAgents(store);
  const itemStamp = await itemsStamp(store);

  const ids = [...new Set(spinoffs.flatMap((s) => (s.item_id ? [s.item_id] : [])))];
  const refs = [...new Set(spinoffs.map((s) => s.ticket_ref))];
  const t = store.t;
  const items = (
    await store.q
      .select({ id: t.item.id, ref: t.item.ref, title: t.item.title, closed_at: t.item.closed_at })
      .from(t.item)
      .where(or(inArray(t.item.id, ids.length ? ids : [""]), inArray(t.item.ref, refs.length ? refs : [""])))
  ).map((i): MachineItem => ({ id: i.id, ref: i.ref ?? null, title: i.title, closed: i.closed_at !== null }));
  const tags = await tagsForItems(store, items.map((i) => i.id));

  const statusOf = new Map(agents.map((a) => [a.id, a.status ?? null]));
  const flying = inFlight(spinoffs, items);
  const rows: MachineRow[] = flying.map(({ row, item }) => ({
    id: row.id,
    itemId: item.id,
    ref: legRef(item.ref ?? row.ticket_ref, row.trial_leg),
    title: item.title,
    state: placeRow({
      status: row.status,
      phase: phaseOf(row as { phase?: unknown }),
      builderStatus: statusOf.get(builderIdOf(row)) ?? null,
      spike: isSpikeTagged(tags.get(item.id) ?? []),
      verdict: row.status === "ready-for-gate" ? verdictOf(row) : null,
    }),
  }));

  // OS-241: the open tickets no row is working, in `ob next` order (held projects left out, as `ob next` does). A
  // merged ticket not yet closed is done, not back in planning.
  const busy = new Set([...flying.map(({ item }) => item.id), ...landed(spinoffs, items)]);
  const open = (await nextWorklist(store)).items.filter((i) => !busy.has(i.id));
  const openTags = await tagsForItems(store, open.map((i) => i.id));
  const checks = await currentCheckVerdicts(store, open);
  const planning: MachineRow[] = open.map((i) => ({
    id: null,
    itemId: i.id,
    ref: i.ref ?? i.id,
    title: i.title,
    state: placeOpen({ tags: openTags.get(i.id) ?? [], check: checks.get(i.id) ?? null, drilled: sectionItems(i.body, "Drilled").length > 0 }),
  }));
  return { rows: [...rows, ...planning], stamp: machineStamp(spinoffs, agents, itemStamp, await decisionsStamp(store)) };
}

export const getMachine = createServerFn({ method: "GET" }).handler(async (): Promise<MachineView> => await machineView());

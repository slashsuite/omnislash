import { createServerFn } from "@tanstack/react-start";
import { inArray, or } from "../../../cli/src/db/orm.ts";
import { itemsStamp, tagsForItems } from "../../../cli/src/items.ts";
import { listAgents } from "../../../../platform/cli-coord/src/agent.ts";
import { builderIdOf } from "../../../../platform/cli-coord/src/clean-repo.ts";
import { listSpinoffs } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { isSpikeTagged } from "../../../../platform/cli-coord/src/spinoff-spike.ts";
import { providedStore } from "../../provided-store.ts";
import { inFlight, machineStamp, phaseOf, placeRow, type MachineItem, type MachineRow, type MachineView } from "../lib/machine.ts";

// OS-165: the Machine page's one read. The in-flight spinoff rows, each placed on its role state (lib/machine.ts
// placeRow, section 7 of the role machine doc), and the stamp the page compares the live snapshot against. Read-only.
// The verdict is not read: a sendback leaves it on the row (see placeRow).

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
  const rows: MachineRow[] = inFlight(spinoffs, items).map(({ row, item }) => ({
    id: row.id,
    ref: item?.ref ?? row.ticket_ref,
    title: item?.title ?? row.ticket_ref,
    state: placeRow({
      status: row.status,
      phase: phaseOf(row as { phase?: unknown }),
      builderStatus: statusOf.get(builderIdOf(row)) ?? null,
      spike: item ? isSpikeTagged(tags.get(item.id) ?? []) : false,
      error: row.error ?? null,
    }),
  }));
  return { rows, stamp: machineStamp(spinoffs, agents, itemStamp) };
}

export const getMachine = createServerFn({ method: "GET" }).handler(async (): Promise<MachineView> => await machineView());

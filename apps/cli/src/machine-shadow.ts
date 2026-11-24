import type { Database } from "bun:sqlite";
import { decide } from "../../../platform/state-machine/src/decide.ts";
import { nowIso } from "./db.ts";
import type { Store } from "./db/store.ts";
import { recordEventFor } from "./events.ts";
import { defineSeam } from "./test-seams.ts";

/** A lifecycle machine as `decide` takes it (named here so apps/cli needs no xstate import of its own). */
type AnyStateMachine = Parameters<typeof decide>[0];

/**
 * The shadow check (OS-169, spike OS-167 section 5 step 2): a status move asks the lifecycle machine what it
 * would decide, beside today's check, and logs one `machine_would_refuse` event when the two
 * disagree, in either direction. It never refuses and never changes the move: today's answer stands, and a
 * `decide` that throws or an event write that fails is dropped (the write failure to stderr only). It runs
 * after today's check and before the write, outside any transaction. Since OS-172 only spinoff rows are
 * shadowed: the item machine IS the item check (workflow.ts `assertTransition`). Step 6 (OS-173) does the
 * same for rows.
 */
export const MACHINE_SHADOW_SOURCE = "state-machine";
export const MACHINE_WOULD_REFUSE = "machine_would_refuse";

/** What a shadow check calls: the real `decide` and event writer, swappable by a test (OB-2150 seams). */
export const machineShadowSeam = defineSeam("machine-shadow", { decide, record: recordEventFor });

export type TodayAnswer = "allowed" | "refused";

export interface ShadowMove {
  machine: AnyStateMachine;
  /** The item id, or the spinoff row id as a string. */
  id: string;
  from: string;
  event: string;
  /** The target today's code was asked for. */
  to: string;
  today: TodayAnswer;
  /** Today's refusal message, when today refused. */
  todayMessage?: string | null;
  itemId: string | null;
  actor: string | null;
  /** Extra payload fields (`rowId` for a spinoff row). */
  extra?: Record<string, unknown>;
}

/** Ask the machine, and record the disagreement if there is one. Never throws. */
export async function shadowMove(db: Database | Store, m: ShadowMove): Promise<void> {
  const seam = machineShadowSeam.get();
  let payload: Record<string, unknown>;
  try {
    const d = seam.decide(m.machine, m.from, m.event);
    const machineAllows = d.ok;
    if (machineAllows === (m.today === "allowed")) return;
    payload = {
      machine: m.machine.id,
      id: m.id,
      ...m.extra,
      from: m.from,
      event: m.event,
      to: d.ok ? d.to : m.to,
      why: d.ok ? null : d.why,
      today: m.today,
      message: d.ok ? (m.todayMessage ?? null) : d.message,
    };
  } catch {
    return; // a decide error is dropped: the shadow must not change the move
  }
  try {
    await seam.record(db, {
      ts: nowIso(),
      source: MACHINE_SHADOW_SOURCE,
      type: MACHINE_WOULD_REFUSE,
      itemId: m.itemId,
      actor: m.actor,
      payload,
    });
  } catch (e) {
    process.stderr.write(`ob: state-machine shadow: could not record ${MACHINE_WOULD_REFUSE}: ${(e as Error)?.message ?? e}\n`);
  }
}

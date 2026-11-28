import { useRouter } from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Caption, Cluster, PageHeader, Pill, Stack } from "@slashsuite/ui-react";
import { useRealtime } from "../../../../platform/dashboard-kit/src/lib/useRealtime.ts";
import { ItemDrawer } from "../../../../platform/dashboard-kit/src/components/ItemDrawer.tsx";
import { StateTickets, stateListId } from "./StateTickets.tsx";
import { machineStamp, type MachineView } from "../lib/machine.ts";
import { roleDefinition } from "../lib/role-machine.ts";
import { getItem, setTodayRank, transitionItem } from "../server/items.ts";

// OS-165, OS-241, OS-308: the page both drawings of the role machine sit on, /machine (the StateMachine graph) and
// /overview (the persona swimlanes). Read-only. A push from the live snapshot whose rows, builders, items or decisions
// differ from the loader's read (a handoff, a sendback, a builder stamping needs-human, an `ob close`, an `ob spinoff
// check`) re-reads, so a ticket moves without a reload. Over the drawing, the in-flight and planning counts and how
// many need a person; under it, each state's list of tickets, every one opening in the item drawer.

const DEFINITION = roleDefinition();

/** The states a person must act on: the machine's human states, and the failed end. */
const NEEDS_PERSON = new Set<string>(DEFINITION.states.filter((s) => s.kind === "human" || s.kind === "failed").map((s) => s.id));

/** What the drawing may do on the page: open a state's list (and scroll to it), or open a ticket by ref. */
type MachineActions = { openState: (state: string) => void; openTicket: (ref: string) => void };

export function MachinePage({
  view,
  title,
  description,
  drawing,
}: {
  /** The loader's read (getMachine). */
  view: MachineView;
  title: string;
  description: string;
  /** The machine with the tickets on it. */
  drawing: (actions: MachineActions) => ReactNode;
}) {
  const router = useRouter();
  const { snap } = useRealtime();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);

  // Seeded from the loader, so a move between the read and the socket's first push is not taken as the baseline.
  const seen = useRef(view.stamp);
  useEffect(() => {
    seen.current = view.stamp;
  }, [view.stamp]);
  const stamp = snap ? machineStamp(snap.spinoffs, snap.agents, snap.itemsStamp ?? "", snap.decisionsStamp ?? "") : undefined;
  useEffect(() => {
    if (stamp === undefined || stamp === seen.current) return;
    seen.current = stamp;
    void router.invalidate();
  }, [stamp, router]);

  const toggle = (state: string, next: boolean) =>
    setOpen((current) => {
      const out = new Set(current);
      if (next) out.add(state);
      else out.delete(state);
      return out;
    });
  const actions: MachineActions = {
    openState: (state) => {
      if (!view.rows.some((r) => r.state === state)) return;
      toggle(state, true);
      // After the list renders open, so the scroll lands on its full height.
      requestAnimationFrame(() => document.getElementById(stateListId(state))?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
    },
    openTicket: (ref) => {
      const row = view.rows.find((r) => r.ref === ref);
      if (row) setOpenId(row.itemId);
    },
  };

  const flying = view.rows.filter((r) => r.id !== null).length;
  const planning = view.rows.length - flying;
  const waiting = view.rows.filter((r) => NEEDS_PERSON.has(r.state)).length;
  return (
    <>
      <PageHeader title={title} description={description} />
      <Stack>
        <Cluster gap="sm">
          <Caption as="span" tone="muted">
            {flying} in flight · {planning} in planning
          </Caption>
          {waiting > 0 && (
            <Pill size="sm" tone="warn">
              {waiting} need a person
            </Pill>
          )}
        </Cluster>
        {drawing(actions)}
        <StateTickets states={DEFINITION.states} tickets={view.rows} open={open} onToggle={toggle} onOpenTicket={setOpenId} />
      </Stack>
      <ItemDrawer
        itemId={openId}
        onClose={() => {
          setOpenId(null);
          void router.invalidate();
        }}
        getItem={getItem}
        transitionItem={transitionItem}
        setTodayRank={setTodayRank}
      />
    </>
  );
}

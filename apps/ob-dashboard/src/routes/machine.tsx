import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Caption, Cluster, PageHeader, Pill, Stack } from "@slashsuite/ui-react";
import { useRealtime } from "../../../../platform/dashboard-kit/src/lib/useRealtime.ts";
import { ItemDrawer } from "../../../../platform/dashboard-kit/src/components/ItemDrawer.tsx";
import { RoleMachine } from "../components/RoleMachine.tsx";
import { boxOfClick, StateTickets, stateListId } from "../components/StateTickets.tsx";
import { machineStamp } from "../lib/machine.ts";
import { roleDefinition } from "../lib/role-machine.ts";
import { getMachine } from "../server/machine.ts";
import { getItem, setTodayRank, transitionItem } from "../server/items.ts";

// OS-165: the role state machine (platform/state-machine, through roleDefinition) with every in-flight
// spinoff on its state, and (OS-241) every open ticket no row is working on its planning state. Read-only. A push
// from the live snapshot whose rows, builders, items or decisions differ from this read (a handoff, a sendback, a
// builder stamping needs-human, an `ob close`, an `ob spinoff check`) re-reads, so a ticket moves without a reload.
// Clicking a state's box opens the list of its tickets under the diagram; each one opens in the item drawer.

export const Route = createFileRoute("/machine")({
  loader: async () => await getMachine(),
  component: Machine,
});

const DEFINITION = roleDefinition();

/** The states a person must act on: the machine's human states, and the failed end. */
const NEEDS_PERSON = new Set<string>(DEFINITION.states.filter((s) => s.kind === "human" || s.kind === "failed").map((s) => s.id));

function Machine() {
  const view = Route.useLoaderData();
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
  const onDiagramClick = (e: MouseEvent<HTMLDivElement>) => {
    const state = boxOfClick(e.target);
    if (!state || !view.rows.some((r) => r.state === state)) return;
    toggle(state, true);
    // After the list renders open, so the scroll lands on its full height.
    requestAnimationFrame(() => document.getElementById(stateListId(state))?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  };

  const flying = view.rows.filter((r) => r.id !== null).length;
  const planning = view.rows.length - flying;
  const waiting = view.rows.filter((r) => NEEDS_PERSON.has(r.state)).length;
  return (
    <>
      <PageHeader
        title="Machine"
        description="Every spinoff in flight, and every open ticket still being planned, on the state of the role machine it is in. It moves as builders and the architect hand work on. Click a state to list its tickets."
      />
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
        {/* A click in a box opens its list below; the keyboard reaches the same lists there. */}
        {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div onClick={onDiagramClick} className="[&_[data-measure^='n:']]:cursor-pointer">
          <RoleMachine tickets={view.rows} />
        </div>
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

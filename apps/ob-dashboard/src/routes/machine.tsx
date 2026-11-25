import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Caption, Cluster, PageHeader, Pill, Stack } from "@slashsuite/ui-react";
import { useRealtime } from "../../../../platform/dashboard-kit/src/lib/useRealtime.ts";
import { RoleMachine } from "../components/RoleMachine.tsx";
import { machineStamp } from "../lib/machine.ts";
import { roleDefinition } from "../lib/role-machine.ts";
import { getMachine } from "../server/machine.ts";

// OS-165: the role state machine (platform/state-machine, through roleDefinition) with every in-flight
// spinoff on its state. Read-only. A push from the live snapshot whose rows, builders or items differ from this read
// (a handoff, a sendback, a builder stamping needs-human, an `ob close`) re-reads, so a row moves without a reload.

export const Route = createFileRoute("/machine")({
  loader: async () => await getMachine(),
  component: Machine,
});

/** The states a person must act on: the machine's human states, and the failed end. */
const NEEDS_PERSON = new Set<string>(roleDefinition().states.filter((s) => s.kind === "human" || s.kind === "failed").map((s) => s.id));

function Machine() {
  const view = Route.useLoaderData();
  const router = useRouter();
  const { snap } = useRealtime();

  // Seeded from the loader, so a move between the read and the socket's first push is not taken as the baseline.
  const seen = useRef(view.stamp);
  useEffect(() => {
    seen.current = view.stamp;
  }, [view.stamp]);
  const stamp = snap ? machineStamp(snap.spinoffs, snap.agents, snap.itemsStamp ?? "") : undefined;
  useEffect(() => {
    if (stamp === undefined || stamp === seen.current) return;
    seen.current = stamp;
    void router.invalidate();
  }, [stamp, router]);

  const waiting = view.rows.filter((r) => NEEDS_PERSON.has(r.state)).length;
  return (
    <>
      <PageHeader title="Machine" description="Every spinoff in flight, on the state of the role machine it is in. It moves as builders and the architect hand work on." />
      <Stack>
        <Cluster gap="sm">
          <Caption as="span" tone="muted">
            {view.rows.length} in flight
          </Caption>
          {waiting > 0 && (
            <Pill size="sm" tone="warn">
              {waiting} need a person
            </Pill>
          )}
        </Cluster>
        <RoleMachine tickets={view.rows} />
      </Stack>
    </>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { MachinePage } from "../components/MachinePage.tsx";
import { RoleSwimlanes } from "../components/RoleSwimlanes.tsx";
import { getMachine } from "../server/machine.ts";

// OS-261, OS-308: the role state machine drawn as persona swimlanes (RoleSwimlanes), the same tickets as /machine on
// the same states. Clicking a state's title opens the list of its tickets under the lanes; a ticket's ref on a card,
// or a row in that list, opens it in the item drawer.

export const Route = createFileRoute("/overview")({
  loader: async () => await getMachine(),
  component: Overview,
});

function Overview() {
  const view = Route.useLoaderData();
  return (
    <MachinePage
      view={view}
      title="Overview"
      description="Who does what, where: one lane per persona, one column per stage, from an idea to a shipped ticket. Every spinoff in flight and every open ticket still being planned sits on the state it is in, and moves as the work is handed on. Click a state to list its tickets."
      drawing={({ openState, openTicket }) => <RoleSwimlanes tickets={view.rows} onOpenState={openState} onOpenTicket={openTicket} />}
    />
  );
}

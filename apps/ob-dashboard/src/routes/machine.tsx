import { createFileRoute } from "@tanstack/react-router";
import { MachinePage } from "../components/MachinePage.tsx";
import { RoleMachine } from "../components/RoleMachine.tsx";
import { boxOfClick } from "../components/StateTickets.tsx";
import { getMachine } from "../server/machine.ts";

// OS-165: the role state machine (platform/state-machine, through roleDefinition) with every in-flight spinoff on its
// state, and (OS-241) every open ticket no row is working on its planning state. OS-308: drawn by uislash's
// StateMachine, every state a box and every move an arrow (the persona swimlanes of OS-261 are on /overview).
// Clicking a state's box opens the list of its tickets under the graph; each one opens in the item drawer.

export const Route = createFileRoute("/machine")({
  loader: async () => await getMachine(),
  component: Machine,
});

function Machine() {
  const view = Route.useLoaderData();
  return (
    <MachinePage
      view={view}
      title="Machine"
      description="Every spinoff in flight, and every open ticket still being planned, on the state of the role machine it is in. It moves as builders and the architect hand work on. Click a state to list its tickets."
      drawing={({ openState }) => (
        <>
          {/* A click in a box opens its list below; the keyboard reaches the same lists there. */}
          {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
          <div
            onClick={(e) => {
              const state = boxOfClick(e.target);
              if (state) openState(state);
            }}
            className="[&_[data-measure^='n:']]:cursor-pointer [&_div:has(>[data-measure^='l:'])]:cursor-pointer"
          >
            <RoleMachine tickets={view.rows} />
          </div>
        </>
      )}
    />
  );
}

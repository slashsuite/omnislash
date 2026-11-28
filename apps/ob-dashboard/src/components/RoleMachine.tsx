import { StateMachine } from "@slashsuite/ui-react";
import { useMemo } from "react";
import { GRAPH_TONES, type RoleTicket, roleDefinition, roleItems } from "../lib/role-machine.ts";

// OS-187, OS-308: the role state machine with the tickets in flight on it, drawn by uislash's StateMachine: every
// state a box with its persona-named label, every move an arrow in the colour of the persona that makes it, and each
// ticket a dot in its state's box. Pure: the tickets are the prop; the machine is read from platform/state-machine
// through roleDefinition. The persona swimlanes of the same machine are RoleSwimlanes, on the Overview page.

export function RoleMachine({ tickets }: { tickets: readonly RoleTicket[] }) {
  const { states, transitions } = useMemo(() => roleDefinition(), []);
  const items = useMemo(() => roleItems(tickets), [tickets]);
  return <StateMachine label="Role state machine" states={states} transitions={transitions} items={items} roleTones={GRAPH_TONES} />;
}

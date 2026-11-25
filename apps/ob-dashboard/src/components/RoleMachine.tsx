import { StateMachine } from "@slashsuite/ui-react";
import { useMemo } from "react";
import { type RoleMachineJson, type RoleTicket, roleDefinition, roleItems } from "../lib/role-machine.ts";

// OS-187: the role state machine with the tickets in flight on it, drawn by uislash's StateMachine. Pure: the
// machine JSON and the tickets are props. Wiring it to the live spinoff rows is a later ticket.

export function RoleMachine({ machine, tickets }: { machine: RoleMachineJson; tickets: readonly RoleTicket[] }) {
  const { states, transitions } = useMemo(() => roleDefinition(machine), [machine]);
  const items = useMemo(() => roleItems(tickets), [tickets]);
  return <StateMachine label="Role state machine" states={states} transitions={transitions} items={items} />;
}

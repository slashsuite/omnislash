import { StateMachine } from "@slashsuite/ui-react";
import { useMemo } from "react";
import { ROLE_TONES, type RoleTicket, roleDefinition, roleItems } from "../lib/role-machine.ts";

// OS-187: the role state machine with the tickets in flight on it, drawn by uislash's StateMachine. Pure: the
// tickets are the prop; the machine is read from platform/state-machine through roleDefinition. OS-237: each role
// has its own colour, the owner pinned to his (ROLE_TONES).

export function RoleMachine({ tickets }: { tickets: readonly RoleTicket[] }) {
  const { states, transitions } = useMemo(() => roleDefinition(), []);
  const items = useMemo(() => roleItems(tickets), [tickets]);
  return <StateMachine label="Role state machine" states={states} transitions={transitions} items={items} roleTones={ROLE_TONES} />;
}

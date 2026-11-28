import { useEffect, useState } from "react";
import type { RoleTicket } from "../lib/role-machine.ts";

// OS-308: the tickets the role machine's stories put on it, shared by the graph (RoleMachine.stories.tsx) and the
// swimlanes (RoleSwimlanes.stories.tsx), so both draw the same world.

export const busy: RoleTicket[] = [
  { ref: "OS-187", title: "RoleMachine diagram component", state: "building" },
  { ref: "OS-188", title: "Spinoff machine wiring", state: "building" },
  { ref: "OS-176", title: "Trim the agents list", state: "reviewing" },
  { ref: "OS-170", title: "Empty state on the queue", state: "owner_call" },
  { ref: "OS-174", title: "Generate the role machine JSON", state: "pr_ci" },
  { ref: "OS-179", title: "Rename the deploy step", state: "handed_off" },
  { ref: "OS-182", title: "Dark theme for the journal", state: "gating" },
  { ref: "OS-185", title: "Backfill item tags", state: "queued" },
  { ref: "OS-160", title: "Move backups to the new host", state: "failed" },
  { ref: "OS-171", title: "Can moon cache the e2e build?", state: "spike" },
  { ref: "OS-172", title: "Item machine is the item check", state: "closed" },
  { ref: "OS-165", title: "Live state machine view", state: "drilling" },
  { ref: "OS-260", title: "A Backlog state for the role machine", state: "backlog" },
  { ref: "OS-261", title: "Undrilled idea for the queue", state: "backlog" },
];

export const onePerson: RoleTicket[] = [{ ref: "OS-170", title: "Empty state on the queue", state: "owner_call" }];

/** The path OS-189, OS-191 and OS-206 each took from a builder's thread to done. */
const PATH = ["building", "reviewing", "pr_ci", "handed_off", "gating", "closed"];
const REPLAYED = [
  { ref: "OS-189", title: "ob project pause in API mode", start: 0 },
  { ref: "OS-191", title: "A pending PixelSlash review no longer blocks the handoff", start: 2 },
  { ref: "OS-206", title: "Retire DeepSeek and Luna from the review setup", start: 4 },
];

/** The tickets of REPLAYED, each moved one state along PATH every 1.6 seconds, round and round. */
export function useReplay(): RoleTicket[] {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((n) => n + 1), 1600);
    return () => clearInterval(t);
  }, []);
  return REPLAYED.map((r) => ({ ref: r.ref, title: r.title, state: PATH[(r.start + step) % PATH.length] ?? "building" }));
}

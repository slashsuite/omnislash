import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import type { RoleTicket } from "../lib/role-machine.ts";
import { RoleMachine } from "./RoleMachine.tsx";

// OS-187: the role state machine (platform/state-machine, through fromXState) with tickets on it. Each look has a light and a
// dark story, so both are one click (and one screenshot) away. Replay walks real OmniSlash tickets along the
// path a landed ticket took, so the dots move between states.

const busy: RoleTicket[] = [
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
];

const onePerson: RoleTicket[] = [{ ref: "OS-170", title: "Empty state on the queue", state: "owner_call" }];

/** The path OS-189, OS-191 and OS-206 each took from a builder's thread to done. */
const PATH = ["building", "reviewing", "pr_ci", "handed_off", "gating", "closed"];
const REPLAYED = [
  { ref: "OS-189", title: "ob project pause in API mode", start: 0 },
  { ref: "OS-191", title: "A pending PixelSlash review no longer blocks the handoff", start: 2 },
  { ref: "OS-206", title: "Retire DeepSeek and Luna from the review setup", start: 4 },
];

/** Moves each replayed ticket one state along PATH every 1.6 seconds, round and round. */
function Replay() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((n) => n + 1), 1600);
    return () => clearInterval(t);
  }, []);
  const tickets = REPLAYED.map((r) => ({ ref: r.ref, title: r.title, state: PATH[(r.start + step) % PATH.length] ?? "building" }));
  return <RoleMachine tickets={tickets} />;
}

const meta: Meta<typeof RoleMachine> = {
  title: "Machine/RoleMachine",
  component: RoleMachine,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof RoleMachine>;

const light = { globals: { theme: "light" } };
const dark = { globals: { theme: "dark" } };

export const Busy: Story = { args: { tickets: busy }, ...dark };
export const BusyLight: Story = { args: { tickets: busy }, ...light };
export const Empty: Story = { args: { tickets: [] }, ...dark };
export const EmptyLight: Story = { args: { tickets: [] }, ...light };
export const OnePersonNeeded: Story = { args: { tickets: onePerson }, ...dark };
export const OnePersonNeededLight: Story = { args: { tickets: onePerson }, ...light };
export const ReplayHandoffs: Story = { render: () => <Replay />, ...dark };
export const ReplayHandoffsLight: Story = { render: () => <Replay />, ...light };

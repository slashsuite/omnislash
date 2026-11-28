import type { Meta, StoryObj } from "@storybook/react-vite";
import { busy, onePerson, useReplay } from "./role-tickets.fixture.ts";
import { RoleMachine } from "./RoleMachine.tsx";

// OS-187, OS-308: the role state machine (platform/state-machine, through fromXState) drawn by uislash's StateMachine,
// with tickets on it. Each look has a light and a dark story, so both are one click (and one screenshot) away. Replay
// walks real OmniSlash tickets along the path a landed ticket took, so the dots move between states.

function Replay() {
  return <RoleMachine tickets={useReplay()} />;
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

import type { Meta, StoryObj } from "@storybook/react-vite";
import { busy, onePerson, useReplay } from "./role-tickets.fixture.ts";
import { RoleSwimlanes } from "./RoleSwimlanes.tsx";

// OS-261, OS-308: the role state machine drawn as persona swimlanes (the Overview page), with tickets on it. Each look
// has a light and a dark story. Replay walks real OmniSlash tickets along the path a landed ticket took, so their
// chips move between states.

function Replay() {
  return <RoleSwimlanes tickets={useReplay()} />;
}

const meta: Meta<typeof RoleSwimlanes> = {
  title: "Machine/RoleSwimlanes",
  component: RoleSwimlanes,
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj<typeof RoleSwimlanes>;

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

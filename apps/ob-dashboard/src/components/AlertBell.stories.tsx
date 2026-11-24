import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertBell } from "./AlertBell.tsx";

// OS-186: the first story in ob-dashboard, proving the Storybook setup. With no realtime push the bell
// shows its quiet state ("No alerts"), which renders the same in the light and the dark theme.

const meta: Meta<typeof AlertBell> = { title: "Components/AlertBell", component: AlertBell };
export default meta;
type Story = StoryObj<typeof AlertBell>;

export const NoAlerts: Story = {};

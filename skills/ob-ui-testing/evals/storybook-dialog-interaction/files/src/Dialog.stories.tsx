import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { Dialog } from "./Dialog";

const meta: Meta<typeof Dialog> = { title: "Overlays/Dialog", component: Dialog };
export default meta;

export const Default: StoryObj<typeof Dialog> = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (<><button type="button" onClick={() => setOpen(true)}>Open settings</button>
      <Dialog open={open} title="Settings" onClose={() => setOpen(false)}><p>Change your preferences.</p></Dialog></>);
  },
};

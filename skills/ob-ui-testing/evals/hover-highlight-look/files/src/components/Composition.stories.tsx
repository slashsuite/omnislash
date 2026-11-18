import type { Meta, StoryObj } from "@storybook/react-vite";
import { Composition } from "./Composition";

const boxes = [
  { id: "a", label: "Header", x: 10, y: 10, w: 300, h: 40 },
  { id: "b", label: "Sidebar", x: 10, y: 60, w: 80, h: 240 },
];

const meta: Meta<typeof Composition> = { component: Composition, args: { boxes } };
export default meta;
export const Default: StoryObj<typeof Composition> = {};

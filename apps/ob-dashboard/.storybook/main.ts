import type { StorybookConfig } from "@storybook/react-vite";

// OS-186: Storybook for ob-dashboard components. Stories sit next to their component. The Vite config is
// .storybook/vite.config.ts (React and Tailwind only), not the app's, which carries the TanStack Start plugins.
// Telemetry is off: Storybook would otherwise send usage events to storybook.js.org from every gate run.
const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  framework: { name: "@storybook/react-vite", options: { builder: { viteConfigPath: ".storybook/vite.config.ts" } } },
  core: { disableTelemetry: true },
};
export default config;

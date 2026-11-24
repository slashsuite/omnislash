import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// OS-186: Storybook's own Vite config. The app's vite.config.ts adds the TanStack Start plugins, which
// Storybook cannot build (a second client entry), so Storybook takes only React and Tailwind.
export default defineConfig({
  plugins: [tailwindcss(), viteReact()],
});

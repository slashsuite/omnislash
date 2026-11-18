import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The kit's component tests (happy-dom). Named *.vitest.tsx so `bun test` never matches them.
export default defineConfig({
  plugins: [viteReact()],
  test: { include: ["test/*.vitest.tsx"] },
});

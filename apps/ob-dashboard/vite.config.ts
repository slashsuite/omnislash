import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { buildCommit } from "../../platform/dashboard-kit/src/build-commit.ts";

// The same build as apps/dashboard/vite.config.ts: run under Bun (`bun --bun vite …`), with Bun's builtins
// left out of the SSR bundle so the serving Bun process resolves them natively.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  // OB-2261: every page's <meta name="build-commit"> (platform/dashboard-kit/src/lib/buildCommitMeta.ts).
  define: { __BUILD_COMMIT__: JSON.stringify(buildCommit()) },
  ssr: { external: ["bun:sqlite", "bun"] },
  build: { rolldownOptions: { external: ["bun", "bun:sqlite"] } },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
  // OB-2208: the happy-dom route tests (src/route-tests/*.vitest.tsx), as in apps/dashboard/vite.config.ts.
  // The plain *.test.ts files (bun:test) run under `bun test`, so vitest is pointed at the route tests only.
  test: {
    include: ["src/route-tests/*.vitest.tsx"],
  },
});

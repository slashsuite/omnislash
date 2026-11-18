import { defineConfig, devices } from "@playwright/test";

// Happy paths only, against a local production build.
export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env["CI"],
  reporter: "list",
  use: { baseURL: "http://localhost:4173", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run build && bunx vite preview --port 4173",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env["CI"],
    timeout: 300_000,
  },
});

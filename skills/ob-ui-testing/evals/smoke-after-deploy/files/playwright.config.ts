import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  retries: process.env.CI ? 2 : 0,
  use: { baseURL: "http://localhost:4173", trace: "on-first-retry" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: { command: "bun run build && bun run preview", url: "http://localhost:4173", reuseExistingServer: !process.env.CI },
});

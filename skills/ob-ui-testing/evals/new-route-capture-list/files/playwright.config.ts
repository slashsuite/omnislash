import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "e2e",
  retries: 0,
  forbidOnly: !!process.env.CI,
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["iPhone 15"] } },
  ],
  webServer: { command: "bun run build && bun run preview", url: "http://127.0.0.1:4173", reuseExistingServer: false },
});

import { defineConfig, devices } from "@playwright/test";
const PORT = 5173;
export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["iPhone 15"] } },
  ],
  webServer: { command: "bun run build && bun run preview", url: `http://127.0.0.1:${PORT}`, reuseExistingServer: false },
});

import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./e2e/world.ts";

// OS-146: the OB dashboard's e2e, against the BUILT app (the webServer below builds first) on a fresh temp store.
// Run it under the browser lease: `ob lease run cpu:browser -- bunx moon run ob-dashboard:e2e`.
export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: 0, // a flaky test is a bug to fix, never retried
  // One shared SQLite store behind one server: each test reseeds it, so two at once would see each other's writes.
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["iPhone 15"], browserName: "chromium" } }, // phone viewport, Chromium
  ],
  // Builds first, so a bare `bunx playwright test` never serves a stale or missing dist.
  webServer: { command: "bun run build && bun e2e/serve.ts", url: BASE_URL, reuseExistingServer: false },
});

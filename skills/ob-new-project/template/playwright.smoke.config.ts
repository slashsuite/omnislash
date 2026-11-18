import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke runs against a DEPLOYED app (SMOKE_BASE_URL), as the smoke accounts only.
 * Credentials come from the secret store via env; the smoke runner never holds live payment keys.
 */
const baseURL = process.env["SMOKE_BASE_URL"];
if (!baseURL)
  throw new Error("SMOKE_BASE_URL is required, e.g. SMOKE_BASE_URL=https://app.example.com");

export default defineConfig({
  testDir: "./smoke",
  testMatch: "**/*.smoke.ts",
  retries: 1,
  reporter: "list",
  use: { baseURL },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

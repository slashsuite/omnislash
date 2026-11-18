import { expect, test } from "@playwright/test";

test("production serves the home page", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.ok()).toBe(true);
  await expect(page.locator("h1")).toBeVisible();
});

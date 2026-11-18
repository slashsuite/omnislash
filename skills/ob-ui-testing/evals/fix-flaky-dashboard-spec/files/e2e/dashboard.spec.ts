import { test, expect } from "@playwright/test";

test.describe.serial("dashboard", () => {
  test("loads", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1100); // let react hydrate
    await expect(page.locator(".card")).toBeVisible();
  });

  test("creates", async ({ page }) => {
    await page.goto("/projects");
    await page.waitForTimeout(1100);
    await page.fill("input", "Demo");
    await page.click("button.bg-violet-600");
    await page.waitForTimeout(500);
    await expect(page.locator("ul li").last()).toHaveText("Demo");
  });

  test("cleans up", async ({ request }) => {
    await request.delete("/api/projects/Demo");
  });
});

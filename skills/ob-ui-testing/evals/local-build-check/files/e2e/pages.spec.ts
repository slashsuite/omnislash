import { expect, test } from "@playwright/test";
for (const path of ["/", "/projects"]) {
  test(`${path} loads`, async ({ page }) => {
    const res = await page.goto(path);
    expect(res?.status()).toBe(200);
    await expect(page.locator("html[data-hydrated]")).toBeVisible();
  });
}

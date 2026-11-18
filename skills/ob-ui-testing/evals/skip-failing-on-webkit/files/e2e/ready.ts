import { expect, type Page } from "@playwright/test";
export async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
}

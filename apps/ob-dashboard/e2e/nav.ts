// OS-24: the header's page nav, the way a person reaches it. On the phone project AppShell keeps the nav in its
// Menu (a <details>), so the Menu is opened first; from `md` the nav is in the header row.
import { expect, type Page, type TestInfo } from "@playwright/test";

export async function openPage(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
}

/** The "Pages" nav, with the phone Menu opened when the nav lives in it. */
export async function pagesNav(page: Page, info: TestInfo) {
  if (info.project.name === "phone") await page.getByText("Menu", { exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Pages" });
  await expect(nav).toBeVisible();
  return nav;
}

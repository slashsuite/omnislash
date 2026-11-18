import { test, expect } from "@playwright/test";
import { open } from "./ready";

test("an owner reorders projects by dragging", async ({ page }) => {
  await open(page, "/projects");
  const first = page.getByRole("listitem").filter({ hasText: "Alpha" });
  const second = page.getByRole("listitem").filter({ hasText: "Beta" });
  await first.dragTo(second);
  await expect(page.getByRole("listitem").first()).toHaveText("Beta");
});

// OS-24: the OB dashboard's home and header nav, each test from a reseeded store, against the built app
// (e2e/serve.ts). The world (e2e/world.ts): builder os-1 parked on a human for OS-1, and two items ranked into Today.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPage, pagesNav } from "./nav.ts";
import { cliEnv, FOCUS_TITLES, REVIEW_NOTE, REVIEW_REF, REVIEW_TITLE } from "./world.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));

function reseed(...args: string[]): void {
  execFileSync("bun", ["e2e/seed.ts", ...args], { cwd: APP, env: cliEnv() });
}

const card = (page: Page, title: string) => page.getByRole("article", { name: title, exact: true });
const drawer = (page: Page) => page.getByRole("dialog");

test.beforeEach(() => reseed());

// The ob-frame test checks every page's marking; this checks the nav a person sees, phone Menu included.
const PAGES = ["Home", "Queue", "Alerts", "Tokens", "Models", "Timeline", "Machine", "Overview"];

test("the header nav lists every page and marks the current one", async ({ page }, info) => {
  await openPage(page, "/alerts");
  const nav = await pagesNav(page, info);
  await expect(nav.getByRole("link")).toHaveText(PAGES);
  await expect(nav.getByRole("link", { name: "Alerts", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav.locator("[aria-current]")).toHaveCount(1);
});

test("home lists the builders waiting on you and today's ranked focus", async ({ page }) => {
  await openPage(page, "/");
  const review = card(page, "To review");
  await expect(review.getByRole("button")).toHaveCount(1);
  await expect(review.getByText(REVIEW_REF, { exact: true })).toBeVisible();
  await expect(review.getByText(REVIEW_NOTE, { exact: true })).toBeVisible();
  // Ranked: rank 1 first.
  const focus = card(page, "Focus").getByRole("button");
  await expect(focus).toHaveCount(FOCUS_TITLES.length);
  for (const [i, title] of FOCUS_TITLES.entries()) await expect(focus.nth(i)).toHaveAccessibleName(title);
});

test("home says so when nothing waits on you and nothing is ranked", async ({ page }) => {
  reseed("home", "empty");
  await openPage(page, "/");
  await expect(page.getByText("Nothing to review: no builder is waiting on you.")).toBeVisible();
  await expect(page.getByText("No ranked focus: add an item to Today from its drawer.")).toBeVisible();
});

test("a To review row opens its ticket in the drawer", async ({ page }) => {
  await openPage(page, "/");
  await card(page, "To review").getByRole("button", { name: REVIEW_NOTE, exact: true }).click();
  await expect(drawer(page).getByRole("heading", { name: REVIEW_TITLE })).toBeVisible();
  await expect(drawer(page).getByText("open", { exact: true })).toBeVisible();
});

test("a status change from the drawer saves", async ({ page }) => {
  await openPage(page, "/");
  await card(page, "Focus").getByRole("button", { name: FOCUS_TITLES[0], exact: true }).click();
  const d = drawer(page);
  await expect(d.getByRole("heading", { name: FOCUS_TITLES[0] })).toBeVisible();
  const saved = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  await d.getByRole("button", { name: "Start", exact: true }).click();
  await saved;
  await expect(d.getByText("in_progress", { exact: true })).toBeVisible();

  // Saved, not just shown: a fresh load reads it back from the store.
  await page.reload();
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await card(page, "Focus").getByRole("button", { name: FOCUS_TITLES[0], exact: true }).click();
  await expect(drawer(page).getByText("in_progress", { exact: true })).toBeVisible();
});

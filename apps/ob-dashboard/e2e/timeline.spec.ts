// OS-27: the Timeline page, from a reseeded store, against the built app (e2e/serve.ts). The world is
// e2e/world.ts TIMELINE_*: one fixed week of TIMELINE_PROJECT, opened with an explicit from and to.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPage } from "./nav.ts";
import { BUSY_MOVES, cliEnv, TIMELINE_FROM, TIMELINE_PR, TIMELINE_PROJECT, TIMELINE_TITLES, TIMELINE_TO } from "./world.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));
const PATH = `/timeline?project=${TIMELINE_PROJECT}&from=${TIMELINE_FROM}&to=${TIMELINE_TO}`;

test.beforeEach(() => {
  execFileSync("bun", ["e2e/seed.ts"], { cwd: APP, env: cliEnv() });
});

const tile = (page: Page, name: string) => page.locator(`[data-tile="${name.toLowerCase()}"]`);
const line = (page: Page, text: string | RegExp) => page.getByRole("listitem").filter({ hasText: text });
const busyLines = (page: Page) => line(page, TIMELINE_TITLES.busy);

test("the tiles count the range: Net is opened minus closed, and the median cycle is tasks only", async ({ page }) => {
  await openPage(page, PATH);
  await expect(tile(page, "Opened")).toContainText("4");
  await expect(tile(page, "Closed")).toContainText("2");
  await expect(tile(page, "Net")).toContainText("+2");
  // The decision closed an hour after it opened; counted, the median would be 1.5 d.
  await expect(tile(page, "Median cycle")).toContainText("3.0 d");
  const week = page.getByRole("table", { name: "Weekly trend" }).getByRole("row").nth(1);
  await expect(week.getByRole("cell")).toHaveText([/9 Nov 2026/, "4", "2", "+2", "1", "3.0 d"]);
});

test("a close from blocked is one Closed line carrying the spell, with no Unblocked line", async ({ page }) => {
  await openPage(page, PATH);
  const mine = line(page, TIMELINE_TITLES.closedFromBlocked);
  await expect(mine.filter({ hasText: /^Closed/ })).toContainText("done after 3.0 d · after 2.0 d blocked");
  await expect(mine.filter({ hasText: /^Blocked/ })).toContainText("waits on review");
  await expect(mine).toHaveCount(3);
  await expect(page.getByText("Unblocked", { exact: true })).toHaveCount(0);
});

test("build steps fold to one line per row behind the Builds switch; the merge line shows either way", async ({ page }) => {
  await openPage(page, PATH);
  const built = line(page, TIMELINE_TITLES.built);
  const sw = page.getByRole("switch", { name: "Builds" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(built.filter({ hasText: /^Build/ })).toHaveCount(0);
  await expect(built.getByRole("link", { name: "merged, PR #42" })).toHaveAttribute("href", TIMELINE_PR);

  await sw.click();
  await expect(page).toHaveURL(/builds=true/);
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect(built.filter({ hasText: "built, row 9001, 4 h" })).toHaveCount(1);
  await expect(built.filter({ hasText: "row 9002, building" })).toHaveCount(1);
  // Six row steps became two lines, plus the opened and merged lines.
  await expect(built).toHaveCount(4);

  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await expect(built).toHaveCount(2);
});

test("Load older pages the feed by 200 and the pages join up", async ({ page }) => {
  await openPage(page, PATH);
  // Page one: the 7 newest lines of the other tickets, then the busy ticket's newest moves to fill 200.
  await expect(page.getByRole("listitem")).toHaveCount(200);
  await expect(busyLines(page)).toHaveCount(193);
  await page.getByRole("button", { name: "Load older" }).click();
  await expect(busyLines(page)).toHaveCount(BUSY_MOVES + 1);
  await expect(busyLines(page).last()).toContainText("Opened");
  await expect(page.getByRole("button", { name: "Load older" })).toHaveCount(0);
});

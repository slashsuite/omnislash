// OS-312: the Schedules page, each test from a reseeded store, against the built app (e2e/serve.ts). The world
// (e2e/world.ts SCHEDULES): db-copy has failed its last two runs, morning-sync succeeded once. Each write is read
// back through the CLI, so it is in the store and not just on the page.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPage, pagesNav } from "./nav.ts";
import { cliEnv, SCHEDULES } from "./world.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));
const FAILING = SCHEDULES.failing.name;
const HEALTHY = SCHEDULES.healthy.name;

function reseed(...args: string[]): void {
  execFileSync("bun", ["e2e/seed.ts", ...args], { cwd: APP, env: cliEnv() });
}

/** `ob schedule list --all --json`: the store's jobs as the CLI reads them. */
function stored(): { name: string; enabled: boolean; next_run_at: string | null }[] {
  return JSON.parse(execFileSync("bun", ["../cli/src/index.ts", "schedule", "list", "--all", "--json"], { cwd: APP, env: cliEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
}
const job = (name: string) => stored().find((j) => j.name === name);

const card = (page: Page, name: string) => page.getByRole("article", { name, exact: true });

/** Click a write and wait for its server function to answer. */
async function save(page: Page, click: () => Promise<void>): Promise<void> {
  const saved = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  await click();
  await saved;
}

test.beforeEach(() => reseed());

test("the nav reaches Schedules, which says how to add a job when there is none", async ({ page }, info) => {
  reseed("schedules", "empty");
  await openPage(page, "/");
  await (await pagesNav(page, info)).getByRole("link", { name: "Schedules", exact: true }).click();
  await expect(page).toHaveURL(/\/schedules$/);
  await expect(page.getByRole("heading", { name: "No scheduled jobs" })).toBeVisible();
  await expect(page.getByText("ob schedule add", { exact: true })).toBeVisible();
});

test("each job is a card with its schedule, target, last run and failure streak", async ({ page }) => {
  await openPage(page, "/schedules");
  const failing = card(page, FAILING);
  await expect(failing.getByText("every 1h", { exact: true })).toBeVisible();
  await expect(failing.getByText(SCHEDULES.failing.command, { exact: true })).toBeVisible();
  await expect(failing.getByText("on desk", { exact: true })).toBeVisible();
  await expect(failing.getByText("runs through good night", { exact: true })).toBeVisible();
  await expect(failing.getByText("2 failures in a row", { exact: true })).toBeVisible();
  await expect(failing.getByText("exit 1: write failed: disk full", { exact: true })).toBeVisible();
  const healthy = card(page, HEALTHY);
  await expect(healthy.getByText("cron 0 9 * * 1-5", { exact: true })).toBeVisible();
  await expect(healthy.getByText("succeeded", { exact: true }).first()).toBeVisible();
  await expect(healthy.getByText(/failures in a row/)).toHaveCount(0);
});

test("a job's recent runs open with their host, exit code and output", async ({ page }) => {
  await openPage(page, "/schedules");
  const failing = card(page, FAILING);
  await failing.getByRole("button", { name: "Recent runs (2)" }).click();
  const runs = failing.getByRole("article", { name: /^Run \d+$/ });
  await expect(runs).toHaveCount(2);
  await expect(runs.first().getByText("host desk · exit 1", { exact: true })).toBeVisible();
  await expect(runs.first().getByText("Output (last lines)")).toBeVisible();
  await expect(runs.first()).toContainText("disk full");
});

test("no text on the page is under 14px, run history open", async ({ page }) => {
  await openPage(page, "/schedules");
  await card(page, FAILING).getByRole("button", { name: "Recent runs (2)" }).click();
  await expect(card(page, FAILING).getByText("Output (last lines)")).toBeVisible();
  const small = await page.locator("main").evaluate((main) => {
    const out: string[] = [];
    const walk = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const el = n.parentElement;
      if (!el || !n.textContent?.trim() || el.getClientRects().length === 0) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px < 14) out.push(`${px}px: ${n.textContent.trim().slice(0, 40)}`);
    }
    return out;
  });
  expect(small).toEqual([]);
});

test("pause and resume save to the store", async ({ page }) => {
  await openPage(page, "/schedules");
  const healthy = card(page, HEALTHY);
  await save(page, () => healthy.getByRole("button", { name: "Pause", exact: true }).click());
  await expect(healthy.getByText("paused", { exact: true })).toBeVisible();
  await expect(healthy.getByRole("button", { name: "Run now" })).toBeDisabled();
  expect(job(HEALTHY)?.enabled).toBe(false);
  await save(page, () => healthy.getByRole("button", { name: "Resume", exact: true }).click());
  await expect(healthy.getByText("enabled", { exact: true })).toBeVisible();
  expect(job(HEALTHY)?.enabled).toBe(true);
});

test("run now makes the job due and runs nothing on the page", async ({ page }) => {
  await openPage(page, "/schedules");
  const before = job(FAILING)!.next_run_at!;
  const clicked = Date.now();
  await save(page, () => card(page, FAILING).getByRole("button", { name: "Run now" }).click());
  const after = job(FAILING)!.next_run_at!;
  expect(after).not.toBe(before);
  expect(Math.abs(Date.parse(after) - clicked)).toBeLessThan(60_000);
  await expect(card(page, FAILING).getByText(`Next ${after}`, { exact: true })).toBeVisible();
  // No run was started: run history is still the seeded two.
  await expect(card(page, FAILING).getByRole("button", { name: "Recent runs (2)" })).toBeVisible();
});

test("delete asks first, and confirming removes the job from the store", async ({ page }) => {
  await openPage(page, "/schedules");
  const failing = card(page, FAILING);
  await failing.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(failing.getByText(`Delete ${FAILING} and its run history? This cannot be undone.`)).toBeVisible();
  await save(page, () => failing.getByRole("button", { name: `Delete ${FAILING}`, exact: true }).click());
  await expect(card(page, FAILING)).toHaveCount(0);
  await expect(card(page, HEALTHY)).toBeVisible();
  expect(job(FAILING)).toBeUndefined();
});

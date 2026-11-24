// OS-25: the Queue page, each test from a reseeded store, against the built app (e2e/serve.ts). The world
// (e2e/world.ts QUEUE_SEED): QUEUE_PROJECT's open items in urgent, high and medium; critical, flake, low and none
// empty. Moves are made from the keyboard on both widths (focus the row, ArrowRight to its "Reorder" grip, Enter,
// arrows, Enter), and once with a pointer drag on the desktop.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPage } from "./nav.ts";
import { cliEnv, GROUP_LABEL, GROUP_TEAM, QUEUE_PROJECT, QUEUE_SEED, SIBLING_PROJECT, SIBLING_TITLE } from "./world.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));

function reseed(...args: string[]): void {
  execFileSync("bun", ["e2e/seed.ts", ...args], { cwd: APP, env: cliEnv() });
}

function ob(...args: string[]): string {
  return execFileSync("bun", ["../cli/src/index.ts", ...args], { cwd: APP, env: cliEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** `ob next --project`'s titles, in its order (a line is ref, priority, status, title, then the project). */
function nextTitles(): string[] {
  return ob("next", "--project", QUEUE_PROJECT)
    .split("\n")
    .filter((l) => l.includes("\t"))
    .map((l) => l.split("\t")[3]!.replace(/\s+·.*$/, "").trim());
}

const BANDS = ["critical", "urgent", "flake", "high", "medium", "low", "none"];

/** The page's titles, band by band, read from each row's grip label. */
async function shown(page: Page, scope: string = QUEUE_PROJECT): Promise<Record<string, string[]>> {
  return await page.getByRole("grid", { name: `${scope} queue` }).evaluate((grid) => {
    const out: Record<string, string[]> = {};
    for (const g of grid.querySelectorAll("[role=rowgroup]")) {
      out[g.getAttribute("aria-label") ?? ""] = [...g.querySelectorAll("button[aria-label^='Reorder ']")].map((b) => b.getAttribute("aria-label")!.slice("Reorder ".length));
    }
    return out;
  });
}

const seeded = (): Record<string, string[]> =>
  Object.fromEntries(BANDS.map((b, i) => [b, QUEUE_SEED.filter((s) => s.priority === [6, 1, 5, 2, 3, 4, 0][i]).map((s) => s.title)]));

/** Wait for the order to read `want` (the write, its re-read and the redraw all land first). */
async function expectOrder(page: Page, want: Record<string, string[]>): Promise<void> {
  await expect.poll(() => shown(page)).toEqual(want);
}

/**
 * A keyboard move: pick up `title` by its grip and step the drop line `steps` places (down when positive), then
 * drop. The line starts just after the item and stops before every row, each band's end row included, so one
 * step up is a no-op (before the item itself) and two is before the item above.
 */
async function keyMove(page: Page, title: string, steps: number): Promise<void> {
  const saved = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  // A tap on the title focuses the row (the grip's own .focus() is moved back to the row by the grid).
  await page.getByRole("row", { name: title, exact: true }).getByText(title, { exact: true }).click();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("button", { name: `Reorder ${title}`, exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  // react-aria starts the drag a tick after Enter; an arrow pressed before then moves nothing.
  await expect(page.locator("[aria-live]").getByText(/Started dragging/)).toBeAttached();
  for (let i = 0; i < Math.abs(steps); i++) await page.keyboard.press(steps > 0 ? "ArrowDown" : "ArrowUp");
  await page.keyboard.press("Enter");
  await saved;
}

test.beforeEach(() => reseed());

test("the queue lists the project's open items in ob next order, banded by priority with counts", async ({ page }) => {
  await openPage(page, `/queue?project=${QUEUE_PROJECT}`);
  await expectOrder(page, seeded());
  // Parity with the CLI: the page read band after band is `ob next --project`'s order.
  expect(Object.values(await shown(page)).flat()).toEqual(nextTitles());
  // Each heading carries its count; an empty band shows a drop row.
  const grid = page.getByRole("grid", { name: `${QUEUE_PROJECT} queue` });
  await expect(grid.getByRole("rowgroup", { name: "high" }).locator("[role=row]").first()).toContainText("3");
  await expect(grid.getByRole("rowgroup", { name: "low" }).getByText("Drop here")).toBeVisible();
  await expect(grid.getByText("#auth")).toBeVisible();
});

// OS-185: the page opens on a group, its projects merged, and drills into one project from the Project select.
test("the bare /queue opens on the Slash group with its projects merged, each row naming its project", async ({ page }) => {
  await openPage(page, "/queue");
  await expect(page.getByRole("combobox", { name: "Group" })).toHaveValue(GROUP_TEAM.name);
  await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue("");
  const grid = page.getByRole("grid", { name: `${GROUP_LABEL} queue` });
  // The sibling project's item sits in high beside QUEUE_PROJECT's, after them (its queue rank is 9).
  await expect.poll(async () => (await shown(page, GROUP_LABEL)).high?.slice(0, 4)).toEqual([...seeded().high!, SIBLING_TITLE]);
  await expect(grid.getByRole("row", { name: SIBLING_TITLE, exact: true }).getByText(SIBLING_PROJECT, { exact: true })).toBeVisible();
  await expect(grid.getByRole("row", { name: "Band headings", exact: true }).getByText(QUEUE_PROJECT, { exact: true })).toBeVisible();
});

test("the Project select drills into one project of the group, and a reload keeps it", async ({ page }) => {
  await openPage(page, "/queue");
  await page.getByRole("combobox", { name: "Project" }).selectOption(QUEUE_PROJECT);
  await expect(page).toHaveURL(new RegExp(`team=${GROUP_TEAM.name}.*project=${QUEUE_PROJECT}|project=${QUEUE_PROJECT}.*team=${GROUP_TEAM.name}`));
  await expectOrder(page, seeded());
  // One project: no project chip on the rows.
  await expect(page.getByRole("grid", { name: `${QUEUE_PROJECT} queue` }).getByText(QUEUE_PROJECT, { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await expect(page.getByRole("combobox", { name: "Group" })).toHaveValue(GROUP_TEAM.name);
  await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue(QUEUE_PROJECT);
  await expectOrder(page, seeded());
  // Back to the whole group.
  await page.getByRole("combobox", { name: "Project" }).selectOption("");
  await expect(page.getByRole("grid", { name: `${GROUP_LABEL} queue` })).toBeVisible();
  await expect(page).not.toHaveURL(/project=/);
});

test("a move inside a band reorders it and keeps every priority", async ({ page }) => {
  await openPage(page, `/queue?project=${QUEUE_PROJECT}`);
  await expectOrder(page, seeded());
  // Row priority select, third in high, up before Wire the queue page.
  await keyMove(page, "Row priority select", -3);
  const want = seeded();
  want.high = ["Row priority select", "Wire the queue page", "Band headings"];
  await expectOrder(page, want);
  expect(Object.values(await shown(page)).flat()).toEqual(nextTitles());
  expect(ob("show", (await refOf("Row priority select"))!)).toMatch(/high/);
});

test("a move into another band takes that band's priority", async ({ page }) => {
  await openPage(page, `/queue?project=${QUEUE_PROJECT}`);
  await expectOrder(page, seeded());
  // Phone drag check, first in medium, two places up: the end of high.
  await keyMove(page, "Phone drag check", -2);
  const want = seeded();
  want.high = ["Wire the queue page", "Band headings", "Row priority select", "Phone drag check"];
  want.medium = ["Empty band copy"];
  await expectOrder(page, want);
  expect(Object.values(await shown(page)).flat()).toEqual(nextTitles());
  expect(ob("show", (await refOf("Phone drag check"))!)).toMatch(/high/);
});

test("a drop on an empty band puts the item first there with that priority", async ({ page }) => {
  await openPage(page, `/queue?project=${QUEUE_PROJECT}`);
  await expectOrder(page, seeded());
  // Empty band copy, last in medium: one place down is before low's Drop here row.
  await keyMove(page, "Empty band copy", 1);
  const want = seeded();
  want.medium = ["Phone drag check"];
  want.low = ["Empty band copy"];
  await expectOrder(page, want);
  expect(Object.values(await shown(page)).flat()).toEqual(nextTitles());
});

test("the row's priority select moves the item to that band", async ({ page }) => {
  await openPage(page, `/queue?project=${QUEUE_PROJECT}`);
  await expectOrder(page, seeded());
  const ref = (await refOf("Band headings"))!;
  const saved = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  const select = page.getByRole("combobox", { name: `Priority of ${ref}` });
  await expect(select).toHaveValue("2");
  // A tap reaches the select inside the draggable row.
  await select.click();
  await expect(select).toBeFocused();
  await select.selectOption({ label: "critical" });
  await saved;
  const want = seeded();
  want.critical = ["Band headings"];
  want.high = ["Wire the queue page", "Row priority select"];
  await expectOrder(page, want);
});

test("a row's ref opens the item in the drawer", async ({ page }) => {
  await openPage(page, `/queue?project=${QUEUE_PROJECT}`);
  const ref = (await refOf("Fix the login loop"))!;
  await page.getByRole("button", { name: ref, exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Fix the login loop" })).toBeVisible();
});

test("an ob order from the CLI shows up without a reload", async ({ page }) => {
  await openPage(page, `/queue?project=${QUEUE_PROJECT}`);
  await expectOrder(page, seeded());
  ob("order", (await refOf("Band headings"))!, "--top");
  const want = seeded();
  want.high = ["Band headings", "Wire the queue page", "Row priority select"];
  await expectOrder(page, want);
});

test("a pointer drag inside a band reorders it", async ({ page }, info) => {
  test.skip(info.project.name === "phone", "the phone is driven by the grip from the keyboard; a touch drag is react-aria's own long press");
  await openPage(page, `/queue?project=${QUEUE_PROJECT}`);
  await expectOrder(page, seeded());
  // react-aria drags a row with the browser's own drag and drop, which dragTo drives: drop on the top edge of
  // Wire the queue page, so the drop line is before it.
  const saved = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  await page
    .getByRole("row", { name: "Row priority select", exact: true })
    .dragTo(page.getByRole("row", { name: "Wire the queue page", exact: true }), { targetPosition: { x: 40, y: 4 } });
  await saved;
  const want = seeded();
  want.high = ["Row priority select", "Wire the queue page", "Band headings"];
  await expectOrder(page, want);
});

/** A seeded item's ref, read from the CLI. */
async function refOf(title: string): Promise<string | undefined> {
  const line = ob("next", "--project", QUEUE_PROJECT)
    .split("\n")
    .find((l) => l.split("\t")[3]?.replace(/\s+·.*$/, "").trim() === title);
  return line?.split("\t")[0];
}

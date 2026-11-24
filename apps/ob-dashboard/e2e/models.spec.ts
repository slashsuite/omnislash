// OS-146: the Models page's happy paths, each from a reseeded store, against the built app (e2e/serve.ts). The CLI
// legs run the real `ob models` on the same store, so a save here is proved to be the server value every machine
// reads, and a CLI change is proved to show here.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FIXED_ROUTES } from "../../cli/src/models-file.ts";
import { pagesNav } from "./nav.ts";
import { cliEnv, MODELS_FILE } from "./world.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));

/** Arrange through the back door: model_routes back to SEED_ROUTES. */
function reseed(): void {
  execFileSync("bun", ["e2e/seed.ts"], { cwd: APP, env: cliEnv() });
}

/** Run `ob models <args>` on the e2e store. */
function ob(...args: string[]): string {
  return execFileSync("bun", ["../cli/src/index.ts", "models", ...args], { cwd: APP, env: cliEnv(), encoding: "utf8" });
}

type ShownRoute = { route: string; chain: string[]; effort: string | null; source: string };
type ShownBand = { from: number; to: number; chain: string[]; effort: string | null; source: string };
function shown(): { active: string; routes: ShownRoute[]; builder_ranges: ShownBand[] } {
  return JSON.parse(ob("show", "--json")) as { active: string; routes: ShownRoute[]; builder_ranges: ShownBand[] };
}

/** The server's stored model_routes, as `ob config get` reads it: what a save wrote, byte for byte. */
function stored(): unknown {
  return JSON.parse(execFileSync("bun", ["../cli/src/index.ts", "config", "get", "model_routes"], { cwd: APP, env: cliEnv(), encoding: "utf8" }));
}

async function open(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
}

/** Click, and wait for the save it sends (started before the click, so a fast answer is not missed). */
async function save(page: Page, click: () => Promise<void>) {
  const answered = page.waitForResponse((r) => r.url().includes("/_serverFn/") && r.request().method() === "POST");
  await click();
  await answered;
}

const row = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

test.beforeEach(() => reseed());

test("the header's Models tab opens every route with where its model comes from", async ({ page }, info) => {
  await open(page, "/");
  await (await pagesNav(page, info)).getByRole("link", { name: "Models", exact: true }).click();
  await expect(page).toHaveURL(/\/models$/);
  await expect(page.locator("html[data-hydrated]")).toBeAttached();

  // The builder routes are the builder ranges (OS-176), not route rows.
  for (const route of [...FIXED_ROUTES.filter((r) => !r.startsWith("builder.")), "job.nightly"]) {
    await expect(row(page, route).getByRole("textbox", { name: `Models for ${route}` })).toBeVisible();
  }
  await expect(row(page, "builder.complex")).toHaveCount(0);
  await expect(row(page, "job.nightly").getByText("server", { exact: true })).toBeVisible();
  await expect(row(page, "role.architect").getByText("server (builder.complex)", { exact: true })).toBeVisible();
  await expect(row(page, "checker").getByText("default", { exact: true })).toBeVisible();

  // The host's models file overrides sweep.first: the row says so and names the file, and its editor holds the
  // server value (none here), not the file's model: the file itself is never edited from the page.
  const local = row(page, "sweep.first");
  await expect(local.getByText("local", { exact: true })).toBeVisible();
  await expect(local.getByText(`Overridden on this host by ${MODELS_FILE}`)).toBeVisible();
  await expect(local.getByRole("textbox", { name: "Models for sweep.first" })).toHaveValue("");
});

test("a chain saved on the page is the server value the CLI reads", async ({ page }) => {
  await open(page, "/models");
  const r = row(page, "job.nightly");
  await r.getByRole("textbox", { name: "Models for job.nightly" }).fill("claude-sonnet-5-5, claude-haiku-5-5");
  await save(page, () => r.getByRole("button", { name: "Save job.nightly" }).click());
  await expect(r.getByText("claude-sonnet-5-5 → claude-haiku-5-5", { exact: true })).toBeVisible();
  await expect(r.getByText("saved", { exact: true })).toBeVisible();

  expect(shown().routes.find((x) => x.route === "job.nightly")).toMatchObject({ chain: ["claude-sonnet-5-5", "claude-haiku-5-5"], source: "server" });
});

const builder = (page: Page) => row(page, "Builder ranges in claude");
const bands = () => shown().builder_ranges.map((b) => [b.from, b.to, b.chain.join(","), b.effort, b.source]);

test("the builder ranges show as rows, and moving a boundary is the server value the CLI reads", async ({ page }) => {
  await open(page, "/models");
  const b = builder(page);
  await expect(b.getByRole("textbox", { name: /^From, builder row/ })).toHaveCount(3);
  await expect(b.getByRole("textbox", { name: "From, builder row 3" })).toHaveValue("7");
  await expect(b.getByRole("textbox", { name: "Models, builder row 3" })).toHaveValue("claude-opus-5-5");
  await expect(b.getByRole("combobox", { name: "Effort, builder row 3" })).toHaveValue("high");

  await b.getByRole("textbox", { name: "To, builder row 1" }).fill("4");
  await b.getByRole("textbox", { name: "From, builder row 2" }).fill("5");
  await b.getByRole("combobox", { name: "Effort, builder row 3" }).selectOption("max");
  await save(page, () => b.getByRole("button", { name: "Save builder ranges" }).click());
  await expect(b.getByText("saved", { exact: true })).toBeVisible();

  const set = shown().builder_ranges;
  expect(set.map((x) => [x.from, x.to, x.source])).toEqual([[1, 4, "server"], [5, 6, "server"], [7, 10, "server"]]);
  expect(set[2]).toMatchObject({ chain: ["claude-opus-5-5"], effort: "max" });

  await page.reload();
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await expect(builder(page).getByRole("textbox", { name: "To, builder row 1" })).toHaveValue("4");
});

test("a gap is refused with the CLI's message and nothing is stored", async ({ page }) => {
  await open(page, "/models");
  const before = stored();
  const b = builder(page);
  await b.getByRole("textbox", { name: "To, builder row 1" }).fill("2");
  await save(page, () => b.getByRole("button", { name: "Save builder ranges" }).click());
  await expect(b.getByRole("alert")).toHaveText("Not saved: model_routes profile 'claude': builder ranges leave a gap at 3: the ranges must cover 1-10 with no gap");
  expect(stored()).toEqual(before);
});

test("a range split and merged back round-trips the stored value", async ({ page }) => {
  await open(page, "/models");
  const b = builder(page);
  await save(page, () => b.getByRole("button", { name: "Save builder ranges" }).click());
  await expect(b.getByText("saved", { exact: true })).toBeVisible();
  const whole = stored();
  const wholeBands = bands();

  await test.step("split 7-10 at 9 and give 9-10 its own model", async () => {
    await b.getByRole("textbox", { name: "Split builder row 3 at" }).fill("9");
    await b.getByRole("button", { name: "Split builder row 3" }).click();
    await expect(b.getByRole("textbox", { name: "To, builder row 3" })).toHaveValue("8");
    await expect(b.getByRole("textbox", { name: "From, builder row 4" })).toHaveValue("9");
    await b.getByRole("textbox", { name: "Models, builder row 4" }).fill("claude-sonnet-5-5");
    await save(page, () => b.getByRole("button", { name: "Save builder ranges" }).click());
    await expect(b.getByText("saved", { exact: true })).toBeVisible();
    expect(bands().slice(2)).toEqual([
      [7, 8, "claude-opus-5-5", "high", "server"],
      [9, 10, "claude-sonnet-5-5", "high", "server"],
    ]);
  });

  await test.step("merge 7-8 with 9-10: one 7-10 range on the first row's model", async () => {
    await b.getByRole("button", { name: "Merge builder row 3 with next" }).click();
    await expect(b.getByRole("textbox", { name: "To, builder row 3" })).toHaveValue("10");
    await expect(b.getByRole("textbox", { name: "From, builder row 4" })).toHaveCount(0);
    await save(page, () => b.getByRole("button", { name: "Save builder ranges" }).click());
    await expect(b.getByText("saved", { exact: true })).toBeVisible();
  });

  expect(bands()).toEqual(wholeBands);
  expect(stored()).toEqual(whole);
});

test("unsetting the builder ranges drops them back to the defaults", async ({ page }) => {
  await open(page, "/models");
  const b = builder(page);
  await save(page, () => b.getByRole("button", { name: "Unset builder ranges" }).click());
  await expect(b.getByRole("button", { name: "Unset builder ranges" })).toHaveCount(0);
  expect(shown().builder_ranges.every((x) => x.source === "default")).toBe(true);
  await expect(row(page, "role.architect").getByText("default", { exact: true })).toBeVisible();
});

test("a route set with the CLI shows on the page after a reload", async ({ page }) => {
  await open(page, "/models");
  await expect(row(page, "checker").getByText("default", { exact: true })).toBeVisible();
  ob("set", "checker", "claude-opus-5-5");
  await page.reload();
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await expect(row(page, "checker").getByText("server", { exact: true })).toBeVisible();
  await expect(row(page, "checker").getByRole("textbox", { name: "Models for checker" })).toHaveValue("claude-opus-5-5");
});

test("a reader is added", async ({ page }) => {
  await open(page, "/models");
  await page.getByRole("textbox", { name: "New reader name" }).fill("kimi");
  await page.getByRole("textbox", { name: "New reader model" }).fill("opencode-go/kimi");
  await save(page, () => page.getByRole("button", { name: "Add reader" }).click());
  await expect(row(page, "kimi").getByRole("textbox", { name: "Model for reader kimi" })).toHaveValue("opencode-go/kimi");
});

test("a reader on a range is refused removal until it is taken off its ranges", async ({ page }) => {
  await open(page, "/models");
  const neon = row(page, "neon");
  await save(page, () => neon.getByRole("button", { name: "Remove reader neon" }).click());
  await expect(neon.getByRole("alert")).toContainText("Not saved: reader 'neon' is still on range 4-6, 7-10");

  await test.step("take neon off 4-6 and 7-10", async () => {
    for (const n of [2, 3]) await page.getByRole("checkbox", { name: `neon on review row ${n}` }).uncheck();
    await save(page, () => page.getByRole("button", { name: "Save review ranges" }).click());
    await expect(page.getByRole("checkbox", { name: "neon on review row 2" })).not.toBeChecked();
  });

  await save(page, () => row(page, "neon").getByRole("button", { name: "Remove reader neon" }).click());
  await expect(row(page, "neon")).toHaveCount(0);
});

test("a review range change is saved", async ({ page }) => {
  await open(page, "/models");
  await page.getByRole("checkbox", { name: "neon on review row 1" }).check();
  await save(page, () => page.getByRole("button", { name: "Save review ranges" }).click());
  await page.reload();
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await expect(page.getByRole("checkbox", { name: "neon on review row 1" })).toBeChecked();
});

test("review ranges split at a number, and an overlap is refused with the CLI's message", async ({ page }) => {
  await open(page, "/models");
  await page.getByRole("textbox", { name: "Split review row 3 at" }).fill("9");
  await page.getByRole("button", { name: "Split review row 3" }).click();
  await page.getByRole("checkbox", { name: "neon on review row 4" }).uncheck();
  await save(page, () => page.getByRole("button", { name: "Save review ranges" }).click());
  const review = JSON.parse(ob("show", "--json")).review as { tiers: Array<{ from: number; to: number; legs: string[] }> };
  expect(review.tiers.slice(2)).toEqual([
    { from: 7, to: 8, legs: ["neon", "opus"] },
    { from: 9, to: 10, legs: ["opus"] },
  ]);

  await page.getByRole("textbox", { name: "From, review row 4" }).fill("8");
  await save(page, () => page.getByRole("button", { name: "Save review ranges" }).click());
  await expect(page.getByRole("alert")).toHaveText("Not saved: review ranges 7-8 and 8-10 overlap at 8: each score belongs to one range");
});

test("switching the active profile switches it for every machine", async ({ page }) => {
  await open(page, "/models?profile=claude");
  await page.getByRole("combobox", { name: "Profile to make active" }).selectOption("alt");
  await save(page, () => page.getByRole("button", { name: "Make active for every machine" }).click());
  await expect(page.getByText(/^Active: alt/)).toBeVisible();
  await expect(page.getByRole("region", { name: "Routes in alt" })).toBeVisible();
  expect(shown().active).toBe("alt");
  await page.reload();
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await expect(page.getByRole("region", { name: "Routes in alt" })).toBeVisible();
});

test("the OpenCode Go credit shows its status and when it was last checked", async ({ page }) => {
  await open(page, "/models");
  const credit = page.getByText(/^OpenCode Go credit:/);
  await expect(credit).toHaveText("OpenCode Go credit: ok");
  await expect(page.getByText("Last checked 2026-11-24 08:30 UTC.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "Tokens page" })).toHaveAttribute("href", "/tokens");

  execFileSync("bun", ["e2e/seed.ts", "credit", "failed"], { cwd: APP, env: cliEnv() });
  await page.reload();
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await expect(credit).toHaveText("OpenCode Go credit: failed");
  await expect(page.getByText("Last checked 2026-11-24 08:30 UTC (401 Unauthorized).", { exact: false })).toBeVisible();

  execFileSync("bun", ["e2e/seed.ts", "credit", "none"], { cwd: APP, env: cliEnv() });
  await page.reload();
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await expect(credit).toHaveText("OpenCode Go credit: not checked yet");
  await expect(page.getByText("Last checked", { exact: false })).toHaveCount(0);
});

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
function shown(): { active: string; routes: ShownRoute[] } {
  return JSON.parse(ob("show", "--json")) as { active: string; routes: ShownRoute[] };
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

  for (const route of [...FIXED_ROUTES, "job.nightly"]) {
    await expect(row(page, route).getByRole("textbox", { name: `Models for ${route}` })).toBeVisible();
  }
  await expect(row(page, "job.nightly").getByText("server", { exact: true })).toBeVisible();
  await expect(row(page, "builder.complex").getByText("server", { exact: true })).toBeVisible();
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
  const r = row(page, "builder.medium");
  await r.getByRole("textbox", { name: "Models for builder.medium" }).fill("claude-sonnet-5-5, claude-haiku-5-5");
  await save(page, () => r.getByRole("button", { name: "Save builder.medium" }).click());
  await expect(r.getByText("claude-sonnet-5-5 → claude-haiku-5-5", { exact: true })).toBeVisible();
  await expect(r.getByText("saved", { exact: true })).toBeVisible();
  await expect(r.getByText("server", { exact: true })).toBeVisible();

  expect(shown().routes.find((x) => x.route === "builder.medium")).toMatchObject({ chain: ["claude-sonnet-5-5", "claude-haiku-5-5"], source: "server" });
});

test("an effort change is saved with the route", async ({ page }) => {
  await open(page, "/models");
  const r = row(page, "builder.complex");
  await r.getByRole("combobox", { name: "Effort for builder.complex" }).selectOption("max");
  await save(page, () => r.getByRole("button", { name: "Save builder.complex" }).click());
  await expect(r.getByText("claude-opus-5-5 · max")).toBeVisible();

  await page.reload();
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await expect(row(page, "builder.complex").getByText("claude-opus-5-5 · max")).toBeVisible();
});

test("unsetting a route drops it back to the default", async ({ page }) => {
  await open(page, "/models");
  await save(page, () => row(page, "builder.complex").getByRole("button", { name: "Unset builder.complex" }).click());
  await expect(row(page, "builder.complex").getByText("default", { exact: true })).toBeVisible();
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
    for (const range of ["4-6", "7-10"]) {
      const box = page.getByRole("checkbox", { name: `neon on ${range}` });
      // A click, not uncheck(): the box is controlled, so it changes once the save answers, not on the click.
      await save(page, () => box.click());
      await expect(box).not.toBeChecked();
    }
  });

  await save(page, () => row(page, "neon").getByRole("button", { name: "Remove reader neon" }).click());
  await expect(row(page, "neon")).toHaveCount(0);
});

test("a range change is saved", async ({ page }) => {
  await open(page, "/models");
  const box = page.getByRole("checkbox", { name: "neon on 1-3" });
  await save(page, () => box.click()); // controlled: it changes when the save answers
  await expect(box).toBeChecked();
  await page.reload();
  await expect(page.locator("html[data-hydrated]")).toBeAttached();
  await expect(page.getByRole("checkbox", { name: "neon on 1-3" })).toBeChecked();
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

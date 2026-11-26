// OS-165: the Machine page, from a reseeded store, against the built app (e2e/serve.ts). The world is
// e2e/world.ts MACHINE_*: three open tickets, one queued (pending), one handed to the architect (ready-for-gate),
// one failed. Each ticket's chip on a state's card is named "<ref> <title>, in <state label>" (RoleMachine, OS-261), so
// the spec asks for a chip by its title and the state it must sit in.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPage } from "./nav.ts";
import { cliEnv, MACHINE_PLANNING, MACHINE_ROWS } from "./world.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));

test.beforeEach(() => {
  execFileSync("bun", ["e2e/seed.ts"], { cwd: APP, env: cliEnv() });
});

function ob(...args: string[]): string {
  return execFileSync("bun", ["../cli/src/index.ts", ...args], { cwd: APP, env: cliEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** The chip for a row's ticket, in the state label it must sit in. */
const dot = (page: Page, title: string, state: string): Locator => page.getByRole("button", { name: `${title}, in ${state}` });

test("each in-flight row sits in its state, and the one that waits on a person is counted", async ({ page }) => {
  await openPage(page, "/machine");
  await expect(page.getByRole("heading", { name: "Machine" })).toBeVisible();
  await expect(page.getByText(/^3 in flight · \d+ in planning$/)).toBeVisible();
  await expect(dot(page, MACHINE_ROWS.queued.title, "Waiting for a builder")).toHaveCount(1);
  await expect(dot(page, MACHINE_ROWS.handed.title, "Waiting for the sentinel")).toHaveCount(1);
  await expect(dot(page, MACHINE_ROWS.failed.title, "Abandoned")).toHaveCount(1);
  // The failed end and the owner's planning call are the states a person must act on.
  await expect(page.getByText("2 need a person", { exact: true })).toBeVisible();
});

test("a claim from the CLI moves its dot to launching without a reload", async ({ page }) => {
  await openPage(page, "/machine");
  await expect(dot(page, MACHINE_ROWS.queued.title, "Waiting for a builder")).toHaveCount(1);
  // A marker on the document: a reload would drop it.
  await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
  ob("spinoff", "claim", "--id", String(MACHINE_ROWS.queued.id), "--holder", "e2e");
  await expect(dot(page, MACHINE_ROWS.queued.title, "Starting the builder")).toHaveCount(1);
  await expect(dot(page, MACHINE_ROWS.queued.title, "Waiting for a builder")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
});

test("closing a failed row's ticket from the CLI takes its dot off without a reload", async ({ page }) => {
  await openPage(page, "/machine");
  const failed = dot(page, MACHINE_ROWS.failed.title, "Abandoned");
  await expect(failed).toHaveCount(1);
  // The dot's name starts with its ticket ref ("OS-12 <title>, in ..."), which is what `ob close` takes.
  const name = await failed.evaluate((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");
  const ref = /\bOS-\d+\b/.exec(name)?.[0];
  expect(ref, `ticket ref in "${name}"`).toBeTruthy();
  await expect(page.getByText("2 need a person", { exact: true })).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
  ob("close", ref!);
  await expect(failed).toHaveCount(0);
  await expect(page.getByText(/^2 in flight · /)).toBeVisible();
  await expect(page.getByText("1 need a person", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true);
});

test("an open ticket with no row sits on its planning state, and a click on a state's title lists its tickets", async ({ page }) => {
  await openPage(page, "/machine");
  await expect(dot(page, MACHINE_PLANNING.owner.title, "Owner answers a planning question")).toHaveCount(1);
  await expect(dot(page, MACHINE_PLANNING.drilled.title, "Architect shapes the ticket")).toHaveCount(1);
  const list = page.getByRole("button", { name: /^Owner answers a planning question \d+$/ });
  await expect(list).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "List the tickets in Owner answers a planning question", exact: true }).click();
  await expect(list).toHaveAttribute("aria-expanded", "true");
  const row = page.getByRole("button", { name: new RegExp(`${MACHINE_PLANNING.owner.title}$`) });
  await row.click();
  await expect(page.getByRole("dialog").getByText(MACHINE_PLANNING.owner.title)).toBeVisible();
});

test("an open ticket with no ## Drilled section and no check is in the backlog, and the architect's shaping state holds only drilled ones (OS-260)", async ({ page }) => {
  await openPage(page, "/machine");
  await expect(page.getByRole("button", { name: "Architect shapes the ticket 1", exact: true })).toBeVisible();
  // The backlog holds the bulk (every other open ticket of this world), so its chip may sit behind the card's "+N": its
  // list names it.
  const backlog = page.getByRole("button", { name: /^Waiting to be shaped \d+$/ });
  await backlog.click();
  await expect(backlog).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: new RegExp(`${MACHINE_PLANNING.backlog.title}$`) })).toBeVisible();
});

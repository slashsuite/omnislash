// OS-261, OS-308: the Overview page (the role machine as persona swimlanes), from a reseeded store, against the built
// app (e2e/serve.ts). The world is e2e/world.ts MACHINE_*: three open tickets, one queued (pending), one handed to the
// architect (ready-for-gate), one failed. Each ticket's chip on a state's card is named "<ref> <title>, in <state
// label>" (RoleSwimlanes), so the spec asks for a chip by its title and the state it must sit in. The live updates, the
// counts and the state lists come from the page shell both pages share (MachinePage), which machine.spec.ts drives.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openPage } from "./nav.ts";
import { cliEnv, MACHINE_PLANNING, MACHINE_ROWS } from "./world.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));

test.beforeEach(() => {
  execFileSync("bun", ["e2e/seed.ts"], { cwd: APP, env: cliEnv() });
});

/** The chip for a row's ticket, in the state label it must sit in. */
const dot = (page: Page, title: string, state: string): Locator => page.getByRole("button", { name: `${title}, in ${state}` });

test("each in-flight row sits in its state, and the one that waits on a person is counted", async ({ page }) => {
  await openPage(page, "/overview");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("figure", { name: "Persona swimlanes" })).toBeVisible();
  await expect(page.getByText(/^3 in flight · \d+ in planning$/)).toBeVisible();
  await expect(dot(page, MACHINE_ROWS.queued.title, "Waiting for a builder")).toHaveCount(1);
  await expect(dot(page, MACHINE_ROWS.handed.title, "Waiting for the sentinel")).toHaveCount(1);
  await expect(dot(page, MACHINE_ROWS.failed.title, "Architect called it off, or it failed to start")).toHaveCount(1);
  // The failed end and the owner's planning call are the states a person must act on.
  await expect(page.getByText("2 need a person", { exact: true })).toBeVisible();
});

test("an open ticket with no row sits on its planning state, and a click on a state's title lists its tickets", async ({ page }) => {
  await openPage(page, "/overview");
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

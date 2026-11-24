// OS-146: the back door. Puts the e2e store's model_routes back to SEED_ROUTES and (OS-23) its opencode-go
// credit check back to an ok one at SEED_CREDIT_AT, so each test starts from the same world. Run as a script by
// the specs' beforeEach, and called by e2e/serve.ts at start. `bun e2e/seed.ts credit <ok|failed|none>` sets
// only the credit check, so a spec can show the page each state. OS-24: it also puts the home page's world back
// (seedHome); `bun e2e/seed.ts home empty` leaves the home with nothing to review and no focus.
import { openDb } from "../../cli/src/db.ts";
import { sqliteStoreFor, type Store } from "../../cli/src/db/store.ts";
import { setConfig } from "../../cli/src/config.ts";
import { recordCredentialCheck } from "../../cli/src/credentials.ts";
import { clearCredentialCheck } from "../../cli/src/secrets.ts";
import { MODEL_ROUTES_KEY } from "../../cli/src/model-routes.ts";
import { eq } from "../../cli/src/db/orm.ts";
import { createItem } from "../../cli/src/items.ts";
import { assignRef } from "../../cli/src/refs.ts";
import { registerAgent } from "../../../platform/cli-coord/src/agent.ts";
import { DB_PATH, FOCUS_TITLES, REVIEW_NOTE, REVIEW_REF, REVIEW_TITLE, SEED_CREDIT_AT, SEED_ROUTES } from "./world.ts";

export type CreditSeed = "ok" | "failed" | "none";

export async function seedCredit(store: Store, state: CreditSeed): Promise<void> {
  await clearCredentialCheck(store, "opencode-go");
  if (state === "none") return;
  await recordCredentialCheck(store, "opencode-go", { ok: state === "ok", detail: state === "ok" ? "balance $40.00" : "401 Unauthorized" }, SEED_CREDIT_AT);
}

export type HomeSeed = "full" | "empty";

/** The item titled `title`, created on the first seed and found by its title after that. */
async function itemTitled(store: Store, title: string): Promise<string> {
  const [row] = (await store.q.select({ id: store.t.item.id }).from(store.t.item).where(eq(store.t.item.title, title)).limit(1)) as { id: string }[];
  return row?.id ?? (await createItem(store, { type: "task", title, priority: 2 }));
}

/** Back to open, unblocked and unranked: whatever a test did to the item through the drawer is undone. */
async function resetItem(store: Store, id: string, todayRank: number | null): Promise<void> {
  await store.q
    .update(store.t.item)
    .set({ status: "open", block_reason: null, block_owner: null, closed_at: null, today_rank: todayRank })
    .where(eq(store.t.item.id, id));
}

export async function seedHome(store: Store, state: HomeSeed): Promise<void> {
  const review = await itemTitled(store, REVIEW_TITLE);
  const [ref] = (await store.q.select({ ref: store.t.item.ref }).from(store.t.item).where(eq(store.t.item.id, review))) as { ref: string | null }[];
  // createItem gives it an OB ref; the builder's ticket is an OS ref, so it gets one (the first on this store).
  if (ref?.ref !== REVIEW_REF) {
    const got = await assignRef(store, review, "OS");
    if (got !== REVIEW_REF) throw new Error(`seed: the review item got ${got}, not ${REVIEW_REF}`);
  }
  await resetItem(store, review, null);
  for (const [i, title] of FOCUS_TITLES.entries()) await resetItem(store, await itemTitled(store, title), state === "full" ? i + 1 : null);
  await registerAgent(store, {
    id: "os-1",
    ticket: REVIEW_REF,
    branch: "os-1",
    status: state === "full" ? "needs-human" : "working",
    note: REVIEW_NOTE,
    ttlS: 365 * 86_400,
  });
}

export async function seed(store: Store): Promise<void> {
  await setConfig(store, MODEL_ROUTES_KEY, JSON.stringify(SEED_ROUTES));
  await seedCredit(store, "ok");
  await seedHome(store, "full");
}

if (import.meta.main) {
  const db = openDb(DB_PATH);
  const store = sqliteStoreFor(db);
  const [what, state] = process.argv.slice(2);
  if (what === "credit") {
    if (state !== "ok" && state !== "failed" && state !== "none") throw new Error(`seed credit: ok, failed or none, not ${state}`);
    await seedCredit(store, state);
  } else if (what === "home") {
    if (state !== "full" && state !== "empty") throw new Error(`seed home: full or empty, not ${state}`);
    await seedHome(store, state);
  }
  else await seed(store);
  db.close();
}

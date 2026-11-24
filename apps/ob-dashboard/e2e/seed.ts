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
import { eq, inArray } from "../../cli/src/db/orm.ts";
import { DECISION_SOURCE, DECISION_TYPE } from "../../cli/src/decisions.ts";
import { addTags, createItem } from "../../cli/src/items.ts";
import { registerProject } from "../../cli/src/project.ts";
import { assignRef } from "../../cli/src/refs.ts";
import { registerAgent } from "../../../platform/cli-coord/src/agent.ts";
import {
  BUSY_MOVES,
  DB_PATH,
  FOCUS_TITLES,
  QUEUE_PROJECT,
  QUEUE_SEED,
  REVIEW_NOTE,
  REVIEW_REF,
  REVIEW_TITLE,
  SEED_CREDIT_AT,
  SEED_ROUTES,
  TIMELINE_PR,
  TIMELINE_PROJECT,
  TIMELINE_TITLES,
} from "./world.ts";

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

/**
 * OS-25: QUEUE_PROJECT's queue back to QUEUE_SEED: each item open, unranked for Today, at its seed priority and
 * queue_rank, and touched at the same fixed time, so the order is the seed's whatever a test moved. Runs after
 * seedHome, which must have the store's first OS ref.
 */
export async function seedQueue(store: Store): Promise<void> {
  await registerProject(store, { name: QUEUE_PROJECT, kind: "side" });
  const rank = new Map<number, number>();
  for (const s of QUEUE_SEED) {
    const [row] = (await store.q.select({ id: store.t.item.id }).from(store.t.item).where(eq(store.t.item.title, s.title)).limit(1)) as { id: string }[];
    const id = row?.id ?? (await createItem(store, { type: "task", title: s.title, projectId: QUEUE_PROJECT, priority: s.priority }));
    if (!row && s.tags.length > 0) await addTags(store, id, [...s.tags]);
    const r = (rank.get(s.priority) ?? 0) + 1;
    rank.set(s.priority, r);
    await resetItem(store, id, null);
    await store.q
      .update(store.t.item)
      .set({ priority: s.priority, queue_rank: r, updated_at: "2026-01-01T00:00:00.000Z" })
      .where(eq(store.t.item.id, id));
  }
}

/** The first transition of a spinoff row has no state to come from (U+2014, as `ob spinoff` writes it). */
const NO_STATE = String.fromCharCode(0x2014);

/**
 * OS-27: TIMELINE_PROJECT's items and trail back to the world world.ts describes. The items keep their ids across
 * reseeds; their dates and status are set again, and their trail is deleted and written again at fixed times.
 */
export async function seedTimeline(store: Store): Promise<void> {
  await registerProject(store, { name: TIMELINE_PROJECT, kind: "side" });
  const t = store.t;
  const ids: Record<keyof typeof TIMELINE_TITLES, string> = { closedFromBlocked: "", built: "", decision: "", busy: "" };
  for (const [key, title] of Object.entries(TIMELINE_TITLES) as [keyof typeof TIMELINE_TITLES, string][]) {
    const [row] = (await store.q.select({ id: t.item.id }).from(t.item).where(eq(t.item.title, title)).limit(1)) as { id: string }[];
    const type = key === "decision" ? "decision" : "task";
    ids[key] = row?.id ?? (await createItem(store, { type, title, projectId: TIMELINE_PROJECT, priority: 2 }));
  }
  const items: [string, { status: string; created_at: string; closed_at: string | null }][] = [
    [ids.closedFromBlocked, { status: "done", created_at: "2026-11-09T09:00:00.000Z", closed_at: "2026-11-12T09:00:00.000Z" }],
    [ids.built, { status: "open", created_at: "2026-11-09T10:00:00.000Z", closed_at: null }],
    [ids.decision, { status: "accepted", created_at: "2026-11-10T00:00:00.000Z", closed_at: "2026-11-10T01:00:00.000Z" }],
    [ids.busy, { status: "open", created_at: "2026-11-09T00:00:00.000Z", closed_at: null }],
  ];
  for (const [id, set] of items) {
    await store.q
      .update(t.item)
      .set({ ...set, block_reason: null, block_owner: null, today_rank: null, updated_at: set.closed_at ?? set.created_at })
      .where(eq(t.item.id, id));
  }

  await store.q.delete(t.event).where(inArray(t.event.item_id, Object.values(ids)));
  const move = (item_id: string, ts: string, payload: Record<string, unknown>) => ({
    ts,
    source: DECISION_SOURCE,
    type: DECISION_TYPE,
    item_id,
    actor: "human",
    payload: JSON.stringify(payload),
  });
  const row = (n: number, steps: [string, string, string][], extra: Record<string, unknown> = {}) =>
    steps.map(([ts, from, to]) => move(ids.built, ts, { from, to, spinoff_row: n, ...(to === "landed" ? extra : {}) }));
  const busy = Array.from({ length: BUSY_MOVES }, (_, i) => {
    const ts = new Date(Date.parse("2026-11-09T00:01:00.000Z") + i * 60_000).toISOString();
    return move(ids.busy, ts, i % 2 === 0 ? { from: "open", to: "in_progress" } : { from: "in_progress", to: "open" });
  });
  await store.q.insert(t.event).values([
    ...busy,
    move(ids.closedFromBlocked, "2026-11-10T09:00:00.000Z", { from: "open", to: "blocked", note: "waits on review" }),
    move(ids.closedFromBlocked, "2026-11-12T09:00:00.000Z", { from: "blocked", to: "done" }),
    move(ids.decision, "2026-11-10T01:00:00.000Z", { from: "proposed", to: "accepted" }),
    ...row(
      9001,
      [
        ["2026-11-11T08:00:00.000Z", NO_STATE, "queued"],
        ["2026-11-11T08:30:00.000Z", "queued", "building"],
        ["2026-11-11T11:00:00.000Z", "building", "handed-off"],
        ["2026-11-11T12:00:00.000Z", "handed-off", "landed"],
      ],
      // Written by hand: `ob spinoff land` does not record a pr_url yet, so live merge lines wait on that.
      { pr_url: TIMELINE_PR },
    ),
    ...row(9002, [
      ["2026-11-13T08:00:00.000Z", NO_STATE, "queued"],
      ["2026-11-13T09:00:00.000Z", "queued", "building"],
    ]),
  ]);
}

export async function seed(store: Store): Promise<void> {
  await setConfig(store, MODEL_ROUTES_KEY, JSON.stringify(SEED_ROUTES));
  await seedCredit(store, "ok");
  await seedHome(store, "full");
  await seedQueue(store);
  await seedTimeline(store);
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

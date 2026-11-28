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
import { saveFavorites } from "../../cli/src/t3-favorites.ts";
import { configIo } from "../../../platform/dashboard-kit/src/server/config-io.ts";
import { eq, inArray } from "../../cli/src/db/orm.ts";
import { DECISION_SOURCE, DECISION_TYPE } from "../../cli/src/decisions.ts";
import { addTags, createItem, setDecidedAt } from "../../cli/src/items.ts";
import { registerProject } from "../../cli/src/project.ts";
import { addTeam } from "../../cli/src/team.ts";
import { assignRef } from "../../cli/src/refs.ts";
import { createScheduledJob } from "../../cli/src/scheduled-jobs.ts";
import { registerAgent } from "../../../platform/cli-coord/src/agent.ts";
import {
  BUSY_MOVES,
  DB_PATH,
  FOCUS_TITLES,
  MACHINE_PLANNING,
  MACHINE_PROJECT,
  MACHINE_ROWS,
  GROUP_TEAM,
  QUEUE_PROJECT,
  QUEUE_SEED,
  REVIEW_NOTE,
  REVIEW_REF,
  REVIEW_TITLE,
  SCHEDULE_AT,
  SCHEDULE_FAILED_TAIL,
  SCHEDULES,
  SEED_FAVOURITES,
  SEED_CREDIT_AT,
  SEED_ROUTES,
  SIBLING_OPENED,
  SIBLING_PROJECT,
  SIBLING_TITLE,
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
  // OS-277: the timeline places a decision at its decided_at, which createItem stamps with now; pin it to the
  // seeded filing time, as a real filing would have it, so the world holds at any hour.
  await setDecidedAt(store, ids.decision, items.find(([id]) => id === ids.decision)![1].created_at);

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
      // Written by hand here; a real land records pr_url from the branch's merged PR (OS-163).
      { pr_url: TIMELINE_PR },
    ),
    ...row(9002, [
      ["2026-11-13T08:00:00.000Z", NO_STATE, "queued"],
      ["2026-11-13T09:00:00.000Z", "queued", "building"],
    ]),
  ]);
}

/** OS-185: the Slash group over the queue's and timeline's projects, and its sibling project's one item. */
export async function seedGroup(store: Store): Promise<void> {
  await registerProject(store, { name: SIBLING_PROJECT, kind: "side" });
  await addTeam(store, { ...GROUP_TEAM, projects: [QUEUE_PROJECT, TIMELINE_PROJECT, SIBLING_PROJECT] });
  const [row] = (await store.q.select({ id: store.t.item.id }).from(store.t.item).where(eq(store.t.item.title, SIBLING_TITLE)).limit(1)) as { id: string }[];
  const id = row?.id ?? (await createItem(store, { type: "task", title: SIBLING_TITLE, projectId: SIBLING_PROJECT, priority: 2 }));
  await resetItem(store, id, null);
  // Ranked 9, so it sits after QUEUE_PROJECT's ranked high items (1 to 3) in the merged high band.
  await store.q
    .update(store.t.item)
    .set({ priority: 2, queue_rank: 9, created_at: SIBLING_OPENED, updated_at: "2025-12-31T00:00:00.000Z" })
    .where(eq(store.t.item.id, id));
}

/**
 * OS-165: MACHINE_PROJECT's tickets open and their spinoff rows back on their seed states (world.ts MACHINE_ROWS),
 * written straight to the table: a real dispatch would need a repo and a launcher.
 */
export async function seedMachine(store: Store): Promise<void> {
  await registerProject(store, { name: MACHINE_PROJECT, kind: "side" });
  const t = store.t;
  const rows = Object.values(MACHINE_ROWS);
  await store.q.delete(t.spinoff).where(inArray(t.spinoff.id, rows.map((r) => r.id)));
  for (const r of rows) {
    const [got] = (await store.q.select({ id: t.item.id, ref: t.item.ref }).from(t.item).where(eq(t.item.title, r.title)).limit(1)) as { id: string; ref: string | null }[];
    const id = got?.id ?? (await createItem(store, { type: "task", title: r.title, projectId: MACHINE_PROJECT, priority: 2 }));
    await resetItem(store, id, null);
    // createItem in a side project leaves no ref; a builder's ticket always has one, so it gets the next OS ref.
    const ref = got?.ref ?? (await assignRef(store, id, "OS"));
    await store.q.insert(t.spinoff).values({
      id: r.id,
      ticket_ref: ref,
      item_id: id,
      repo: "omnislash",
      branch: ref.toLowerCase(),
      worktree: "",
      mode: "interactive",
      brief: r.title,
      status: r.status,
      request_at: "2026-11-24T08:00:00.000Z",
    });
  }
  for (const p of Object.values(MACHINE_PLANNING)) {
    const [got] = (await store.q.select({ id: t.item.id }).from(t.item).where(eq(t.item.title, p.title)).limit(1)) as { id: string }[];
    const id = got?.id ?? (await createItem(store, { type: "task", title: p.title, projectId: MACHINE_PROJECT, priority: 2 }));
    await resetItem(store, id, null);
    // OS-260: the body decides backlog or drilling (a `## Drilled` section), so a test's note on it is undone too.
    await store.q.update(t.item).set({ body: p.body }).where(eq(t.item.id, id));
    if (!got && p.tags.length > 0) await addTags(store, id, [...p.tags]);
  }
}

export type SchedulesSeed = "full" | "empty";

/**
 * OS-312: every scheduled job deleted, then (full) world.ts SCHEDULES created again with their runs written
 * straight to the table at fixed times: a real run needs `ob role tick` on a machine.
 */
export async function seedSchedules(store: Store, state: SchedulesSeed): Promise<void> {
  const t = store.t;
  await store.q.delete(t.scheduledJobRun);
  await store.q.delete(t.scheduledJob);
  if (state === "empty") return;
  const at = new Date(SCHEDULE_AT);
  const failing = await createScheduledJob(store, { ...SCHEDULES.failing }, at);
  const healthy = await createScheduledJob(store, { ...SCHEDULES.healthy }, at);
  const run = (job_id: number, started_at: string, status: "failed" | "succeeded", exit_code: number, output_tail: string | null) => ({
    job_id,
    started_at,
    finished_at: started_at,
    status,
    host: "desk",
    exit_code,
    output_tail,
    role_message_id: null,
  });
  await store.q.insert(t.scheduledJobRun).values([
    run(failing.id, "2026-11-24T06:00:00.000Z", "failed", 1, null),
    run(failing.id, "2026-11-24T07:00:00.000Z", "failed", 1, SCHEDULE_FAILED_TAIL),
    run(healthy.id, "2026-11-24T07:30:00.000Z", "succeeded", 0, null),
  ]);
  await store.q.update(t.scheduledJob).set({ last_run_at: "2026-11-24T07:00:00.000Z", last_status: "failed", last_error: "exit 1: write failed: disk full" }).where(eq(t.scheduledJob.id, failing.id));
  await store.q.update(t.scheduledJob).set({ last_run_at: "2026-11-24T07:30:00.000Z", last_status: "succeeded" }).where(eq(t.scheduledJob.id, healthy.id));
}

export async function seed(store: Store): Promise<void> {
  await setConfig(store, MODEL_ROUTES_KEY, JSON.stringify(SEED_ROUTES));
  await saveFavorites(configIo(store), SEED_FAVOURITES, new Date(SEED_CREDIT_AT));
  await seedCredit(store, "ok");
  await seedHome(store, "full");
  await seedQueue(store);
  await seedTimeline(store);
  await seedMachine(store);
  await seedGroup(store);
  await seedSchedules(store, "full");
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
  } else if (what === "schedules") {
    if (state !== "full" && state !== "empty") throw new Error(`seed schedules: full or empty, not ${state}`);
    await seedSchedules(store, state);
  }
  else await seed(store);
  db.close();
}

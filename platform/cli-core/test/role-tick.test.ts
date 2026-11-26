// OS-67: `ob role tick` writes what needs a team's architect into its inbox (one row per finding, keyed so an unchanged
// finding writes nothing) and delivers it with `deliverToRole`. No unread rows after the writes is one line and no T3
// call. The good-night lock keeps the rows and starts and sends nothing.
//
// The CLI cases run locally against a throwaway SQLite store through `runCli`; the stale-builder case runs again over
// the API on a real Postgres store (the harness role-deliver.test.ts uses). T3 is the fake seam. The findings reader is
// also tested on its own with a fixed clock.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli, type CliResult } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3, type FakeT3Install } from "../../../apps/cli/test/fake-t3.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { __setT3Seam, storeAgentRegistry, worktreeRepoOf, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { checkoutOf } from "../../../apps/cli/src/commands/t3-team.ts";
import type { RoleMessage } from "../../../apps/cli/src/inbox.ts";
import type { RoleRun } from "../../../apps/cli/src/role-run.ts";
import { openStore, sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { PRIORITY_FLAKE } from "../../../apps/cli/src/priority.ts";
import { builderContextFindings, tickClientKey, tickFindings } from "../../../apps/cli/src/role-tick.ts";
import { Database } from "bun:sqlite";
import { nightLockedUntil } from "../../../apps/cli/src/role-deliver.ts";
import { recordSpinoffCheck } from "../../cli-coord/src/spinoff-check.ts";

/** The checkout a role run opens in: this repo, which the fake T3 lists as a project. */
const REPO = worktreeRepoOf(checkoutOf(process.cwd())) ?? checkoutOf(process.cwd());
const MIN = 60_000;

let fake: FakeT3Install | null = null;
let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  // The night lock is read from $HOME at call time: every case gets an empty home, so the desktop's own lock never leaks in.
  prevHome = process.env.HOME;
  home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ob-tick-home-"));
  process.env.HOME = home;
});

afterEach(() => {
  fake?.restore();
  fake = null;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function t3(): FakeT3Install {
  fake = installFakeT3([REPO]);
  return fake;
}

/** A seam that records every call and answers none, for the cases that must not touch T3. */
function countingSeam(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const seam = new Proxy({} as T3Seam, {
    get: (_t, prop) => async () => {
      calls.push(String(prop));
      throw new Error(`unexpected T3 call: ${String(prop)}`);
    },
  });
  return { calls, restore: __setT3Seam(seam) };
}

function lock(content: string): void {
  mkdirSync(join(home, ".cache"), { recursive: true });
  writeFileSync(join(home, ".cache", "ob-good-night"), content);
}

interface Harness {
  run(args: string[]): Promise<CliResult>;
  store: Store;
}

/** Team `t` with project `tickp`, whose checkout is this repo. */
async function setup(h: Harness): Promise<void> {
  expect((await h.run(["project", "add", "tickp", "--kind", "side"])).code).toBe(0);
  expect((await h.run(["t3", "team", "add", "t", "--projects", "tickp"])).code).toBe(0);
  await setConfig(h.store, "repo_checkouts", JSON.stringify({ tickp: REPO }));
}

async function local(): Promise<Harness> {
  const dbPath = freshDbPath();
  const db = openDb(dbPath, { create: true });
  const h: Harness = { run: (args) => runCli(dbPath, args), store: sqliteStoreFor(db) };
  await setup(h);
  return h;
}

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

async function withApi(fn: (h: Harness) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
  const obApi = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const transport: ApiTransport = async (req) => {
    const res = await obApi(
      new Request(req.url.replace(BASE, "http://api-host.local"), {
        method: req.method,
        headers: req.headers,
        ...(req.body === undefined ? {} : { body: req.body }),
      }),
    );
    return { status: res.status, body: await res.text() };
  };
  const deps = { api: { base: BASE, token: TOKEN, transport } };
  const h: Harness = { run: (args) => runCli(freshDbPath(), args, deps), store };
  try {
    await setup(h);
    await fn(h);
  } finally {
    await store.close?.();
  }
}

async function messages(store: Store): Promise<RoleMessage[]> {
  const t = store.t.roleMessage;
  return (await store.q.select().from(t).orderBy(t.id)) as RoleMessage[];
}

async function runs(store: Store): Promise<RoleRun[]> {
  const t = store.t.roleRun;
  return (await store.q.select().from(t).orderBy(t.id)) as RoleRun[];
}

/** A `building` spinoff row in `repo` whose builder last beat `heartbeatAt`. */
async function building(store: Store, ref: string, heartbeatAt: string, repo = "tickp", launcher: string | null = "t3"): Promise<void> {
  const id = ref.toLowerCase();
  await store.q.insert(store.t.agent).values({ id, ticket: ref, worktree: `/wt/${id}`, branch: id, status: "working", started_at: heartbeatAt, heartbeat_at: heartbeatAt, ttl_s: 3600 });
  await store.q.insert(store.t.spinoff).values({
    ticket_ref: ref,
    repo,
    branch: id,
    worktree: `/wt/${id}`,
    mode: "interactive",
    brief: "b",
    status: "launched",
    launcher,
    agent_id: id,
    request_at: heartbeatAt,
    launched_at: heartbeatAt,
  });
}

const ago = (mins: number, now = new Date()): string => new Date(now.getTime() - mins * MIN).toISOString();

const ALL_TWO = { problem: 2, scope: 2, done: 2, design: 2, proof: 2, unknowns: 2, size: 2 };
const SIDE = { does: "Does it.", files: ["apps/cli/src/x.ts"], questions: [], scores: ALL_TWO };
const READY_BODY = "Need.\n\n## Drilled\n- read the code\n\n## Done when\n- a test shows it";

/** An item that would dispatch today: Drilled, Done when, and a `go` check on this body. */
async function dispatchReady(store: Store, projectId: string, title: string): Promise<string> {
  const id = await createItem(store, { type: "task", title, body: READY_BODY, projectId });
  await recordSpinoffCheck(store, id, { architect: SIDE, checker: SIDE });
  return id;
}


/** OS-82: a live thread `seat-1` in the fake T3, bound as the role's seat the way `ob t3 architect --thread` binds it. */
async function bindSeat(store: Store, f: FakeT3Install, role = "architect", threadId = "seat-1"): Promise<void> {
  f.threads.push({
    threadId,
    projectId: "proj-0",
    title: `t · ${role}`,
    status: "idle",
    worktreePath: null,
    branch: null,
    settled: false,
    archived: false,
    model: "claude-opus-5-5",
    providerInstanceId: "claudeAgent",
    activeRunId: null,
    latestRunId: null,
  });
  await storeAgentRegistry(store).register({ id: `${role}-t`, worktree: REPO, status: "planning", launcher: "t3", sessionId: threadId, ttlS: 3600 });
}

const staleBuilder = async (h: Harness) => {
  const f = t3();
  const heartbeat = ago(61);
  await building(h.store, "TP-1", heartbeat);
  const first = await h.run(["role", "tick"]);
  expect(first.err).toBe("");
  expect(first.code).toBe(0);
  expect(first.out).toContain("role tick t: wrote #1 stale-builder TP-1");
  expect(first.out).toContain("role tick t architect: run 1 opened, thread t3-1, with 1 message in its start brief");
  // OS-57: the run delivery just opened is not end-checked in the same pass.
  expect(first.out).toContain("role tick t architect: kept (messages were just delivered to it)");
  const rows = await messages(h.store);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ from_actor: "tick", ref: "TP-1", client_key: `tick:t:stale-builder:TP-1:building@${heartbeat}`, read_by: "role-run-1" });
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]!.message).toContain("TP-1 is building but its builder tp-1 has given no heartbeat");

  const second = await h.run(["role", "tick"]);
  expect(second.code).toBe(0);
  // OS-57: the end pass reads the open run (no context db under this HOME) and keeps it, mid-turn.
  expect(second.out.trim().split("\n")).toEqual([
    "role tick t: nothing new",
    "role tick t architect: context unknown for t3-1",
    "role tick t architect: kept (it has a run in flight (running))",
  ]);
  expect(await messages(h.store)).toHaveLength(1);
  expect(f.launches).toHaveLength(1);
  expect(f.sends).toHaveLength(0);
  expect((await runs(h.store)).map((r) => r.id)).toEqual([1]);
};

describe("ob role tick, locally", () => {
  test("no unread rows and no findings: one line, exit 0, zero seam calls, no row", async () => {
    const h = await local();
    const seam = countingSeam();
    let res: CliResult;
    try {
      res = await h.run(["role", "tick"]);
    } finally {
      seam.restore();
    }
    expect(res.err).toBe("");
    expect(res.code).toBe(0);
    expect(res.out.trim()).toBe("role tick t: nothing new");
    expect(seam.calls).toEqual([]);
    expect(await messages(h.store)).toEqual([]);
    expect(await runs(h.store)).toEqual([]);
  });

  test("a builder with a 61 minute old heartbeat: one tick row and one run; a second tick writes and starts nothing", async () => {
    await staleBuilder(await local());
  });

  test("a flake item with no live spinoff row: one row, keyed on its updated_at", async () => {
    const h = await local();
    const f = t3();
    const id = await createItem(h.store, { type: "task", title: "a flaky test", projectId: "tickp", priority: PRIORITY_FLAKE });
    const res = await h.run(["role", "tick"]);
    expect(res.code).toBe(0);
    const rows = await messages(h.store);
    expect(rows).toHaveLength(1);
    const [item] = (await h.store.q.select().from(h.store.t.item)) as Array<{ id: string; updated_at: string }>;
    expect(rows[0]!.client_key).toBe(`tick:t:flake:${id}:${item!.updated_at}`);
    expect(rows[0]!.body).toContain("is a flake ticket in tickp");
    expect(f.launches).toHaveLength(1);
  });

  test("OS-134: a paused project's flake item writes nothing", async () => {
    const h = await local();
    await createItem(h.store, { type: "task", title: "a flaky test", projectId: "tickp", priority: PRIORITY_FLAKE });
    expect((await h.run(["project", "pause", "tickp"])).code).toBe(0);
    expect(await tickFindings(h.store, "t")).toEqual([]);
  });

  test("an idle project whose top item is dispatch-ready: one row, keyed on the item's ref and updated_at", async () => {
    const h = await local();
    t3();
    const id = await dispatchReady(h.store, "tickp", "ready work");
    const res = await h.run(["role", "tick"]);
    expect(res.code).toBe(0);
    const rows = await messages(h.store);
    expect(rows).toHaveLength(1);
    const [item] = (await h.store.q.select().from(h.store.t.item)) as Array<{ updated_at: string }>;
    expect(rows[0]!.client_key).toBe(`tick:t:idle-repo:tickp:${id}@${item!.updated_at}`);
    expect(rows[0]!.ref).toBe("tickp");
  });

  test("idle projects: a blocked top item or one with no go check gives nothing; a dispatch-ready one gives a finding", async () => {
    const h = await local();
    t3();
    for (const p of ["tickq", "tickr"]) expect((await h.run(["project", "add", p, "--kind", "side"])).code).toBe(0);
    expect((await h.run(["t3", "team", "join", "t", "tickq", "tickr"])).code).toBe(0);
    // tickp: its only item is blocked. tickq: Drilled and Done when, but no check. tickr: dispatch-ready.
    const blocked = await dispatchReady(h.store, "tickp", "blocked work");
    expect((await h.run(["block", blocked, "--reason", "waiting"])).code).toBe(0);
    await createItem(h.store, { type: "task", title: "unchecked work", body: READY_BODY, projectId: "tickq" });
    const ready = await dispatchReady(h.store, "tickr", "ready work");
    const res = await h.run(["role", "tick"]);
    expect(res.code).toBe(0);
    const rows = await messages(h.store);
    expect(rows.map((m) => m.ref)).toEqual(["tickr"]);
    expect(rows[0]!.client_key).toStartWith(`tick:t:idle-repo:tickr:${ready}@`);
  });

  test("a lock file that is empty or not a timestamp is unlocked: the tick delivers", async () => {
    for (const content of ["", "not a time\n"]) {
      const h = await local();
      const f = t3();
      lock(content);
      expect(nightLockedUntil()).toBeNull();
      await building(h.store, "TP-1", ago(61));
      const res = await h.run(["role", "tick"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("run 1 opened");
      expect(f.launches).toHaveLength(1);
      f.restore();
      fake = null;
    }
  });

  test("under a future night lock the tick writes the row but starts nothing and sends nothing", async () => {
    const h = await local();
    const until = new Date(Date.now() + 6 * 60 * MIN).toISOString();
    lock(`${until}\n`);
    await building(h.store, "TP-1", ago(61));
    const seam = countingSeam();
    let res: CliResult;
    try {
      res = await h.run(["role", "tick"]);
    } finally {
      seam.restore();
    }
    expect(res.code).toBe(0);
    expect(res.out).toContain("role tick t: wrote #1 stale-builder TP-1");
    expect(res.out).toContain(`role tick t: good night until ${until}; 1 unread kept, nothing started or sent`);
    expect(seam.calls).toEqual([]);
    expect(await messages(h.store)).toMatchObject([{ ref: "TP-1", read_at: null }]);
    expect(await runs(h.store)).toEqual([]);
  });

  test("a past night lock is unlocked", () => {
    lock(new Date(Date.now() - MIN).toISOString());
    expect(nightLockedUntil()).toBeNull();
  });

  test("a team whose checkout is not on this machine prints its skip line and the next team still runs", async () => {
    const h = await local();
    t3();
    expect((await h.run(["project", "add", "nowhere-os67", "--kind", "side"])).code).toBe(0);
    // `a` sorts before `t`, so the skipped team comes first and `t` still runs after it.
    expect((await h.run(["t3", "team", "add", "a", "--projects", "nowhere-os67"])).code).toBe(0);
    await building(h.store, "TP-1", ago(61));
    const res = await h.run(["role", "tick"]);
    expect(res.code).toBe(0);
    const lines = res.out.trim().split("\n");
    expect(lines[0]).toBe("skip a: no checkout here");
    expect(lines.slice(1).join("\n")).toContain("role tick t architect: run 1 opened");
    const named = await h.run(["role", "tick", "--team", "a"]);
    expect(named.out.trim()).toBe("skip a: no checkout here");
  });

  test("an unknown --team exits 1 naming it, and stray arguments are refused", async () => {
    const h = await local();
    const res = await h.run(["role", "tick", "--team", "nope"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("role tick nope: no team 'nope'");
    expect((await h.run(["role", "tick", "t"])).code).toBe(2);
  });
});

describe("ob role tick, OS-82", () => {
  test("a team with a live seat and one unread message: no launch, the message is queued into the seat, the seat stays, no run ends", async () => {
    const h = await local();
    const f = t3();
    await bindSeat(h.store, f);
    await building(h.store, "TP-1", ago(61));
    const res = await h.run(["role", "tick"]);
    expect(res.err).toBe("");
    expect(res.code).toBe(0);
    expect(res.out).toContain("role tick t architect: 1 message queued into seat thread seat-1");
    expect(f.launches).toHaveLength(0);
    expect(f.sends.map((s) => s.threadId)).toEqual(["seat-1"]);
    expect(f.threads.find((t) => t.threadId === "seat-1")!.settled).toBe(false);
    expect((await storeAgentRegistry(h.store).read("architect-t"))?.session_id).toBe("seat-1");
    expect(await runs(h.store)).toEqual([]);
    expect((await messages(h.store))[0]).toMatchObject({ read_by: "seat:architect-t" });
  });
});

describe("ob role tick, over the API", () => {
  test("a builder with a 61 minute old heartbeat: one tick row and one run; a second tick writes and starts nothing", () => withApi(staleBuilder), 60_000);
});

describe("tickFindings on a fixed clock", () => {
  const NOW = new Date("2026-11-19T12:00:00.000Z");

  test("stale at 61 minutes, not at 60; a building row with no agent row is stale on its launch", async () => {
    const h = await local();
    await building(h.store, "TP-1", ago(61, NOW));
    await building(h.store, "TP-2", ago(60, NOW));
    await h.store.q.insert(h.store.t.spinoff).values({
      ticket_ref: "TP-3",
      repo: "tickp",
      branch: "tp-3",
      worktree: "/wt/tp-3",
      mode: "interactive",
      brief: "b",
      status: "launched",
      launcher: "t3",
      request_at: ago(90, NOW),
      launched_at: ago(90, NOW),
    });
    const found = await tickFindings(h.store, "t", NOW);
    expect(found.map((f) => [f.kind, f.ref, f.stamp])).toEqual([
      ["stale-builder", "TP-1", `building@${ago(61, NOW)}`],
      ["stale-builder", "TP-3", `building@${ago(90, NOW)}`],
    ]);
    expect(found[1]!.body).toContain("it launched 90 minutes ago");
    expect(found[1]!.body).toContain("no builder has checked in");
    expect(tickClientKey("t", found[0]!)).toBe(`tick:t:stale-builder:TP-1:building@${ago(61, NOW)}`);
  });

  test("OS-82: only t3 rows are stale builders; omnishell rows and rows with no launcher are retired and give nothing", async () => {
    const h = await local();
    await building(h.store, "OLD-1", ago(120, NOW), "tickp", "omnishell");
    await building(h.store, "OLD-2", ago(120, NOW), "tickp", null);
    await building(h.store, "TP-9", ago(120, NOW));
    expect((await tickFindings(h.store, "t", NOW)).map((f) => [f.kind, f.ref])).toEqual([["stale-builder", "TP-9"]]);
  });

  test("a stale row in another team's repo is not this team's", async () => {
    const h = await local();
    await building(h.store, "XX-1", ago(120, NOW), "elsewhere");
    expect(await tickFindings(h.store, "t", NOW)).toEqual([]);
  });

  test("a project with a live spinoff row is not idle, and a flake with a live row is not reported", async () => {
    const h = await local();
    const flake = await createItem(h.store, { type: "task", title: "flaky", projectId: "tickp", priority: PRIORITY_FLAKE });
    await dispatchReady(h.store, "tickp", "ready");
    await h.store.q.insert(h.store.t.spinoff).values({
      ticket_ref: flake,
      item_id: flake,
      repo: "tickp",
      branch: "f",
      worktree: "/wt/f",
      mode: "interactive",
      brief: "b",
      status: "pending",
      request_at: NOW.toISOString(),
    });
    expect(await tickFindings(h.store, "t", NOW)).toEqual([]);
  });
});

// --- OS-213: a builder thread past 200k context ------------------------------------------------------------------

/** The fake usage source: T3's state db under the case's $HOME, one provider turn per thread with its context. */
function t3Usage(byThread: Record<string, number>): void {
  mkdirSync(join(home, ".t3", "userdata"), { recursive: true });
  const file = join(home, ".t3", "userdata", "statev2.sqlite");
  rmSync(file, { force: true });
  const db = new Database(file, { create: true });
  db.run("create table orchestration_v2_projection_provider_turns (thread_id text, payload_json text)");
  for (const [thread, used] of Object.entries(byThread)) {
    db.run("insert into orchestration_v2_projection_provider_turns values (?, ?)", [thread, JSON.stringify({ tokenUsage: { usedTokens: used } })]);
  }
  db.close();
}

describe("OS-213: builder context", () => {
  const row = (ref: string, thread: string | null, over: Partial<{ status: string; launcher: string | null }> = {}) => ({
    id: 1,
    ticket_ref: ref,
    status: "launched",
    branch: ref.toLowerCase(),
    worktree: `/wt/${ref.toLowerCase()}`,
    launcher: "t3",
    t3_thread_id: thread,
    ...over,
  });

  test("a building t3 thread at the cap is one finding keyed on its thread; under it, unread, handed off or not t3 gives none", () => {
    const ctx: Record<string, number | null> = { a: 200_000, b: 199_999, c: 250_000, d: null, e: 300_000 };
    const found = builderContextFindings(
      [row("TP-1", "a"), row("TP-2", "b"), row("TP-3", "c", { status: "ready-for-gate" }), row("TP-4", "d"), row("TP-5", "e", { launcher: "omnishell" }), row("TP-6", null)],
      (id) => ctx[id] ?? null,
      200_000,
    );
    expect(found.map((f) => [f.kind, f.ref, f.stamp])).toEqual([["builder-context", "TP-1", "context@a"]]);
    expect(found[0]!.body).toContain("is at 200k context, past 200k");
    expect(found[0]!.body).toContain("ob spinoff brief TP-1");
    expect(found[0]!.body).toContain("ob does not relaunch it for you, and it does not watch a thread opened by hand");
  });

  test("through `ob role tick`: a thread under 200k gets nothing; past it, the relaunch prompt once", async () => {
    const h = await local();
    t3();
    await building(h.store, "TP-1", ago(5));
    const { eq } = await import("drizzle-orm");
    await h.store.q.update(h.store.t.spinoff).set({ t3_thread_id: "builder-1" }).where(eq(h.store.t.spinoff.ticket_ref, "TP-1"));

    t3Usage({ "builder-1": 199_000 });
    const under = await h.run(["role", "tick"]);
    expect(under.code).toBe(0);
    expect(under.out).not.toContain("builder-context");
    expect(await messages(h.store)).toEqual([]);

    t3Usage({ "builder-1": 231_000 });
    const over = await h.run(["role", "tick"]);
    expect(over.code).toBe(0);
    expect(over.out).toContain("role tick t: wrote #1 builder-context TP-1");
    const again = await h.run(["role", "tick"]);
    expect(again.code).toBe(0);
    expect(again.out).not.toContain("builder-context");

    const rows = await messages(h.store);
    expect(rows.map((m) => [m.ref, m.client_key])).toEqual([["TP-1", "tick:t:builder-context:TP-1:context@builder-1"]]);
    expect(rows[0]!.body).toContain("TP-1's builder thread builder-1 is at 231k context, past 200k");
  });
});

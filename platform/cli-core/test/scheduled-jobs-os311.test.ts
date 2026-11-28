// OS-311: scheduled jobs (slice 2). Due evaluation claims each due job once (a compare-and-set on next_run_at), a role
// job's prompt lands in its team role's inbox and `ob role tick` delivers it (architect, sentinel, muse), a command job is
// claimed for its host and run by the tick on that machine, never by the API server, and its outcome is recorded with
// a bounded tail. The good-night lock skips a repeating job and holds a `once` job. Fresh SQLite files, the in-process
// API, the fake T3 seam; one case over the API on a real Postgres store.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { freshDbPath, runCli, type CliResult } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3, type FakeT3Install } from "../../../apps/cli/test/fake-t3.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore, openStore, sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { storeAgentRegistry, worktreeRepoOf } from "../../../apps/cli/src/t3/dispatch.ts";
import { checkoutOf } from "../../../apps/cli/src/commands/t3-team.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { addTeam } from "../../../apps/cli/src/team.ts";
import type { RoleMessage } from "../../../apps/cli/src/inbox.ts";
import {
  createScheduledJob,
  finishScheduledJobRun,
  getScheduledJob,
  listScheduledJobRuns,
  OUTPUT_TAIL_MAX,
  parseJobName,
  scheduleClientKey,
  ScheduledJobRunNotFoundError,
  tickScheduledJobs,
  type ScheduledJob,
  type ScheduledJobInput,
  type ScheduleTickResult,
} from "../../../apps/cli/src/scheduled-jobs.ts";
import { expandCwd, runClaimedCommand } from "../../../apps/cli/src/schedule-run.ts";
import { renderSchedules, tickSchedules, type ScheduleBackend } from "../../../apps/cli/src/commands/role-tick.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { loadScopedTokens, sha256Hex } from "../../../apps/cli/src/api/scoped-tokens.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";

const REPO = worktreeRepoOf(checkoutOf(process.cwd())) ?? checkoutOf(process.cwd());
const HOST = hostname();
const NOW = new Date("2026-11-28T10:00:00.000Z");
const MIN = 60_000;

const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ob-schedule-311-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let fake: FakeT3Install | null = null;
let home: string;
let prevHome: string | undefined;
const paths: string[] = [];

beforeEach(() => {
  // The night lock is read from $HOME: every case gets an empty home, so the desktop's own lock never leaks in.
  prevHome = process.env.HOME;
  home = mkdtempSync(join(scratch, "home-"));
  process.env.HOME = home;
});

afterEach(() => {
  fake?.restore();
  fake = null;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});

function lock(): string {
  const until = new Date(Date.now() + 6 * 60 * MIN).toISOString();
  mkdirSync(join(home, ".cache"), { recursive: true });
  writeFileSync(join(home, ".cache", "ob-good-night"), `${until}\n`);
  return until;
}

function dbPath(): string {
  const p = freshDbPath();
  paths.push(p);
  return p;
}

async function store(): Promise<Store> {
  const s = asStore(openDb(dbPath()));
  await addTeam(s, { name: "core" });
  return s;
}

/** A job made due: created on the clock before `at`, its next run set to `at` (a past time the CLI would refuse). */
async function due(s: Store, input: Partial<ScheduledJobInput> & { name: string }, at: string = new Date(NOW.getTime() - MIN).toISOString()): Promise<ScheduledJob> {
  const base: ScheduledJobInput =
    input.target_kind === "command"
      ? { name: input.name, schedule_kind: "interval", schedule_expr: "15m", target_kind: "command", command: "true" }
      : { name: input.name, schedule_kind: "interval", schedule_expr: "15m", target_kind: "role", team: "core", role: "architect", prompt: "Sweep" };
  const job = await createScheduledJob(s, { ...base, ...input }, new Date(NOW.getTime() - 60 * MIN));
  const t = s.t.scheduledJob;
  await s.q.update(t).set({ next_run_at: at }).where(eq(t.id, job.id));
  return (await getScheduledJob(s, job.name))!;
}

async function messages(s: Store): Promise<RoleMessage[]> {
  const t = s.t.roleMessage;
  return (await s.q.select().from(t).orderBy(t.id)) as RoleMessage[];
}

async function runsOf(s: Store, name: string) {
  return (await listScheduledJobRuns(s, name, 50)).runs;
}

describe("due evaluation (OS-311)", () => {
  // The race across connections (separate machines' ticks) is proven on Postgres in platform/cli-db
  // (scheduled-jobs-pg-os311.test.ts): bun:sqlite blocks the one JS thread on a second connection's lock.
  test("a due role job: one unread inbox message from schedule, keyed on job and due time, a succeeded run naming it", async () => {
    const s = await store();
    const job = await due(s, { name: "sweep", prompt: "Sweep the open items" });
    const dueAt = job.next_run_at!;
    const r = await tickScheduledJobs(s, { host: HOST, now: NOW });
    expect(r.fired).toEqual([{ job_id: job.id, name: "sweep", team: "core", role: "architect", due_at: dueAt, run_id: expect.any(Number), message_id: expect.any(Number) }]);
    const [m] = await messages(s);
    expect(m).toMatchObject({ team: "core", role: "architect", from_actor: "schedule", client_key: scheduleClientKey(job.id, dueAt), read_at: null });
    expect(m!.client_key).toBe(`schedule:${job.id}:${dueAt}`);
    expect(m!.body).toContain("Sweep the open items");
    const [run] = await runsOf(s, "sweep");
    expect(run).toMatchObject({ status: "succeeded", role_message_id: m!.id });
    expect(await getScheduledJob(s, "sweep")).toMatchObject({ last_status: "succeeded", last_run_at: NOW.toISOString(), last_error: null });
  });

  test("a once job fires and is disabled; an interval job moves to now + interval; a cron job to its next time after now", async () => {
    const s = await store();
    await due(s, { name: "one", schedule_kind: "once", schedule_expr: "2026-12-01T00:00:00.000Z" });
    // Due three hours ago: one firing, never a catch-up storm, and the next run is counted from now.
    await due(s, { name: "every", schedule_kind: "interval", schedule_expr: "15m" }, new Date(NOW.getTime() - 180 * MIN).toISOString());
    await due(s, { name: "nightly", schedule_kind: "cron", schedule_expr: "0 3 * * *" });
    const r = await tickScheduledJobs(s, { host: HOST, now: NOW });
    expect(r.fired.map((f) => f.name).sort()).toEqual(["every", "nightly", "one"]);
    expect(await getScheduledJob(s, "one")).toMatchObject({ enabled: false, next_run_at: null });
    expect((await getScheduledJob(s, "every"))!.next_run_at).toBe("2026-11-28T10:15:00.000Z");
    expect((await getScheduledJob(s, "nightly"))!.next_run_at).toBe("2026-11-29T03:00:00.000Z");
    expect(await messages(s)).toHaveLength(3);
    const again = await tickScheduledJobs(s, { host: HOST, now: new Date(NOW.getTime() + 20 * MIN) });
    expect(again.fired.map((f) => f.name)).toEqual(["every"]);
  });

  test("a job not yet due and a paused job are left alone", async () => {
    const s = await store();
    await due(s, { name: "later" }, new Date(NOW.getTime() + MIN).toISOString());
    await due(s, { name: "paused" });
    await s.q.update(s.t.scheduledJob).set({ enabled: 0 }).where(eq(s.t.scheduledJob.name, "paused"));
    expect((await tickScheduledJobs(s, { host: HOST, now: NOW })).fired).toEqual([]);
    expect(await messages(s)).toEqual([]);
  });

  test("respect_good_night under the lock: a repeating job is skipped and advanced, a once job held; ignoring it fires", async () => {
    const s = await store();
    const every = await due(s, { name: "every" });
    const once = await due(s, { name: "once", schedule_kind: "once", schedule_expr: "2026-12-01T00:00:00.000Z" });
    await due(s, { name: "cmd", target_kind: "command", command: "echo hi" });
    await due(s, { name: "loud", respect_good_night: false });
    const r = await tickScheduledJobs(s, { host: HOST, now: NOW, night_locked: true });
    expect(r.skipped.map((k) => k.name).sort()).toEqual(["cmd", "every"]);
    expect(r.skipped.find((k) => k.name === "every")).toEqual({ job_id: every.id, name: "every", due_at: every.next_run_at!, next_run_at: "2026-11-28T10:15:00.000Z" });
    expect(r.deferred).toEqual([{ job_id: once.id, name: "once", due_at: once.next_run_at! }]);
    expect(r.fired.map((f) => f.name)).toEqual(["loud"]);
    expect(r.commands).toEqual([]);
    expect(await runsOf(s, "every")).toMatchObject([{ status: "skipped", output_tail: "good night: skipped" }]);
    expect(await getScheduledJob(s, "every")).toMatchObject({ last_status: "skipped", next_run_at: "2026-11-28T10:15:00.000Z" });
    // The held once job writes nothing and is still due; it fires on the first pass after the lock.
    expect(await runsOf(s, "once")).toEqual([]);
    expect(await getScheduledJob(s, "once")).toMatchObject({ enabled: true, next_run_at: once.next_run_at });
    expect((await messages(s)).map((m) => m.body)).toEqual([expect.stringContaining("'loud'")]);
    const after = await tickScheduledJobs(s, { host: HOST, now: NOW });
    expect(after.fired.map((f) => f.name)).toEqual(["once"]);
  });

  test("a role job nobody can receive (a muse not bound) fails once per window: a failed run, the error kept, moved on", async () => {
    const s = await store();
    // Made when a muse was bound; the muse has gone since, so the message cannot be stored.
    const job = await due(s, { name: "muse-job" });
    await s.q.update(s.t.scheduledJob).set({ role: "muse" }).where(eq(s.t.scheduledJob.id, job.id));
    const r = await tickScheduledJobs(s, { host: HOST, now: NOW });
    expect(r.failed).toEqual([expect.objectContaining({ name: "muse-job", error: expect.stringContaining("has no muse bound") })]);
    expect(await messages(s)).toEqual([]);
    expect(await runsOf(s, "muse-job")).toMatchObject([{ status: "failed" }]);
    expect(await getScheduledJob(s, "muse-job")).toMatchObject({ last_status: "failed", next_run_at: "2026-11-28T10:15:00.000Z", enabled: true });
    expect((await tickScheduledJobs(s, { host: HOST, now: NOW })).failed).toEqual([]);
  });

  test("a firing that fails for another reason (a database timeout) leaves even a once job due for the next pass", async () => {
    const s = await store();
    const job = await due(s, { name: "one-shot", schedule_kind: "once", schedule_expr: "2026-12-01T00:00:00.000Z" });
    const flaky = Object.create(s) as Store;
    flaky.txn = ((name: string, fn: (tx: Store) => Promise<unknown>) =>
      name === "schedule fire" ? Promise.reject(new Error("statement timeout")) : s.txn(name, fn as never)) as Store["txn"];
    const r = await tickScheduledJobs(flaky, { host: HOST, now: NOW });
    expect(r.failed).toMatchObject([{ name: "one-shot", error: "statement timeout" }]);
    expect(await getScheduledJob(s, "one-shot")).toMatchObject({ enabled: true, next_run_at: job.next_run_at });
    expect(await runsOf(s, "one-shot")).toEqual([]);
    expect((await tickScheduledJobs(s, { host: HOST, now: NOW })).fired.map((f) => f.name)).toEqual(["one-shot"]);
  });

  test("a job whose write fails does not lose a command already claimed in the same pass", async () => {
    const s = await store();
    await due(s, { name: "aaa-cmd", target_kind: "command", command: "echo hi" }, "2026-11-28T09:00:00.000Z");
    await due(s, { name: "zzz-cmd", target_kind: "command", command: "echo there" }, "2026-11-28T09:30:00.000Z");
    let claims = 0;
    const flaky = Object.create(s) as Store;
    flaky.txn = ((name: string, fn: (tx: Store) => Promise<unknown>) =>
      name === "schedule claim" && ++claims === 2 ? Promise.reject(new Error("statement timeout")) : s.txn(name, fn as never)) as Store["txn"];
    const r = await tickScheduledJobs(flaky, { host: HOST, now: NOW });
    expect(r.commands.map((c) => c.name)).toEqual(["aaa-cmd"]);
    expect(r.failed).toMatchObject([{ name: "zzz-cmd", error: "statement timeout" }]);
    // The one whose claim failed is still due.
    expect((await tickScheduledJobs(s, { host: HOST, now: NOW })).commands.map((c) => c.name)).toEqual(["zzz-cmd"]);
  });

  test("command jobs are claimed only by their host, or by any host when none is named", async () => {
    const s = await store();
    await due(s, { name: "anywhere", target_kind: "command", command: "echo a", cwd: "~/x" });
    await due(s, { name: "desk-only", target_kind: "command", command: "echo b", host: "desk" });
    const elsewhere = await tickScheduledJobs(s, { host: "laptop", now: NOW });
    expect(elsewhere.commands).toEqual([{ run_id: expect.any(Number), job_id: expect.any(Number), name: "anywhere", command: "echo a", cwd: "~/x", due_at: expect.any(String) }]);
    expect(await runsOf(s, "anywhere")).toMatchObject([{ status: "running", host: "laptop", finished_at: null }]);
    expect(await getScheduledJob(s, "desk-only")).toMatchObject({ last_run_at: null });
    const desk = await tickScheduledJobs(s, { host: "desk", now: NOW });
    expect(desk.commands.map((c) => c.name)).toEqual(["desk-only"]);
    expect(await runsOf(s, "desk-only")).toMatchObject([{ status: "running", host: "desk" }]);
  });

  test("finish records the outcome on the run and the job, bounds the tail, and finishes a run once", async () => {
    const s = await store();
    await due(s, { name: "ok", target_kind: "command" });
    await due(s, { name: "bad", target_kind: "command" });
    const { commands } = await tickScheduledJobs(s, { host: HOST, now: NOW });
    const ok = commands.find((c) => c.name === "ok")!;
    const bad = commands.find((c) => c.name === "bad")!;
    const long = "x".repeat(OUTPUT_TAIL_MAX + 500) + "\nboom";
    const later = new Date(NOW.getTime() + MIN);
    expect(await finishScheduledJobRun(s, ok.run_id, { status: "succeeded", exit_code: 0, output_tail: "fine" }, later)).toMatchObject({ status: "succeeded", exit_code: 0, output_tail: "fine", finished_at: later.toISOString() });
    const badRun = await finishScheduledJobRun(s, bad.run_id, { status: "failed", exit_code: 3, output_tail: long }, later);
    expect(badRun.output_tail!.length).toBe(OUTPUT_TAIL_MAX);
    expect(badRun.output_tail!.endsWith("boom")).toBe(true);
    expect(await getScheduledJob(s, "ok")).toMatchObject({ last_status: "succeeded", last_error: null, last_run_at: NOW.toISOString() });
    expect(await getScheduledJob(s, "bad")).toMatchObject({ last_status: "failed", last_error: "exit 3: boom" });
    await expect(finishScheduledJobRun(s, ok.run_id, { status: "failed", exit_code: 1, output_tail: "" })).rejects.toThrow("already succeeded");
    await expect(finishScheduledJobRun(s, 9999, { status: "succeeded", exit_code: 0, output_tail: "" })).rejects.toBeInstanceOf(ScheduledJobRunNotFoundError);
    await expect(finishScheduledJobRun(s, ok.run_id, { status: "running", exit_code: 0, output_tail: "" })).rejects.toThrow("succeeded or failed");
  });

  test("tick and runs are reserved job names: they are literal segments under /schedules", () => {
    expect(() => parseJobName("tick")).toThrow();
    expect(() => parseJobName("runs")).toThrow();
    expect(parseJobName("tick-sweep")).toBe("tick-sweep");
  });
});

describe("running a claimed command on this machine (OS-311)", () => {
  test("it runs in the job's cwd, ~ read as home; a cwd that does not exist fails without throwing", async () => {
    const dir = mkdtempSync(join(scratch, "cwd-"));
    expect((await runClaimedCommand({ command: "pwd", cwd: dir })).output_tail.trim()).toBe(dir);
    expect(expandCwd("~/a", "/h")).toBe("/h/a");
    expect(expandCwd("~", "/h")).toBe("/h");
    expect(expandCwd(null, "/h")).toBeUndefined();
    const missing = await runClaimedCommand({ command: "true", cwd: join(scratch, "no-such-dir") });
    expect(missing.status).toBe("failed");
  });

  test("the output kept is its last 4000 characters", async () => {
    const r = await runClaimedCommand({ command: "head -c 12000 /dev/zero | tr '\\0' a; echo END", cwd: null });
    expect(r.status).toBe("succeeded");
    expect(r.output_tail.length).toBe(OUTPUT_TAIL_MAX);
    expect(r.output_tail.endsWith("END\n")).toBe(true);
  });

  test("a command still running at its timeout is stopped with what it started, and fails", async () => {
    const pidFile = join(scratch, `pid-${Math.random().toString(36).slice(2)}`);
    const r = await runClaimedCommand({ command: `sleep 30 & echo $! > ${pidFile}; echo started; wait`, cwd: null }, { timeoutMs: 300 });
    const child = Number(readFileSync(pidFile, "utf8").trim());
    // Killed, it is gone once reaped (a zombie still answers signal 0 for a moment).
    const alive = () => {
      try {
        process.kill(child, 0);
      } catch {
        return false;
      }
      try {
        return !readFileSync(`/proc/${child}/stat`, "utf8").split(") ")[1]?.startsWith("Z");
      } catch {
        return true; // no /proc (macOS): a live pid counts as alive until reaped
      }
    };
    for (let i = 0; i < 40 && alive(); i++) await Bun.sleep(50);
    expect(alive()).toBe(false);
    expect(r.status).toBe("failed");
    expect(r.exit_code).toBeNull();
    expect(r.output_tail).toContain("started");
    expect(r.output_tail).toContain("[stopped: still running after 0s]");
  }, 10_000);
});

describe("the tick's schedule pass (OS-311)", () => {
  const empty: ScheduleTickResult = { fired: [], commands: [], skipped: [], deferred: [], failed: [] };
  const claim = (run_id: number, name: string) => ({ run_id, job_id: run_id, name, command: "x", cwd: null, due_at: NOW.toISOString() });

  test("a failing or throwing command is recorded and the next command still runs; a finish that fails is reported", async () => {
    const finished: Array<[number, string]> = [];
    const backend: ScheduleBackend = {
      tick: async () => ({ ...empty, commands: [claim(1, "a"), claim(2, "b"), claim(3, "c")] }),
      finish: async (runId, outcome) => {
        finished.push([runId, outcome.status]);
        if (runId === 3) throw new Error("api down");
      },
    };
    const s = await tickSchedules(backend, {
      host: "desk",
      runCommand: async (job) => {
        if (job.name === "a") throw new Error("spawn exploded");
        return job.name === "b" ? { status: "failed", exit_code: 1, output_tail: "no" } : { status: "succeeded", exit_code: 0, output_tail: "ok" };
      },
    });
    expect(finished).toEqual([[1, "failed"], [2, "failed"], [3, "succeeded"]]);
    expect(s.commands.map((c) => [c.name, c.status, c.finish_error])).toEqual([["a", "failed", null], ["b", "failed", null], ["c", "succeeded", "api down"]]);
    expect(s.commands[0]!.output_tail).toBe("could not run: spawn exploded");
    expect(renderSchedules(s)).toEqual([
      "role tick schedule: ran a on desk: failed (no exit code, run 1)",
      "role tick schedule: ran b on desk: failed (exit 1, run 2)",
      "role tick schedule: ran c on desk: succeeded (exit 0, run 3)",
    ]);
  });

  test("a claim that fails is the summary's error, never a throw; nothing due prints nothing", async () => {
    const s = await tickSchedules({ tick: async () => { throw new Error("no store"); }, finish: async () => {} }, { host: "desk" });
    expect(s.error).toBe("no store");
    expect(renderSchedules(s)).toEqual([]);
    const quiet = await tickSchedules({ tick: async () => empty, finish: async () => {} }, { host: "desk" });
    expect(renderSchedules(quiet)).toEqual([]);
  });

  test("the claim is asked for this machine's host and the night lock", async () => {
    const asked: unknown[] = [];
    const backend: ScheduleBackend = { tick: async (input) => (asked.push(input), empty), finish: async () => {} };
    await tickSchedules(backend);
    lock();
    await tickSchedules(backend, { host: "desk" });
    expect(asked).toEqual([{ host: HOST, night_locked: false }, { host: "desk", night_locked: true }]);
  });
});

describe("/schedules/tick and /schedules/runs/:id/finish (OS-311)", () => {
  const ADMIN = "an-admin-bearer-token-that-is-long-enough";
  const ALICE = "alice-scoped-token-0123456789abcdef0123456789";

  function serve(s: Store) {
    const tokens = join(scratch, `tokens-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(tokens, JSON.stringify([{ user: "alice", sha256: sha256Hex(ALICE), projects: ["alpha"], families: ["items", "next", "search", "projects", "schedules"] }]));
    chmodSync(tokens, 0o600);
    return createObApi({
      store: async () => s,
      token: () => ({ token: ADMIN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
      scopedTokens: () => loadScopedTokens(tokens),
    });
  }

  const call = (api: (r: Request) => Promise<Response>, token: string, path: string, body: unknown) =>
    api(new Request(`http://api-host.local${OB_API_PREFIX}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));

  test("the server claims and fires, never runs the command; finish records it; scoped tokens get 403", async () => {
    const s = await store();
    const api = serve(s);
    const marker = join(scratch, `ran-${Math.random().toString(36).slice(2)}`);
    await due(s, { name: "touch", target_kind: "command", command: `touch ${marker}` }, new Date(Date.now() - MIN).toISOString());
    await due(s, { name: "sweep" }, new Date(Date.now() - MIN).toISOString());

    for (const [path, body] of [["/schedules/tick", { host: "desk" }], ["/schedules/runs/1/finish", { status: "succeeded", exit_code: 0, output_tail: "" }]] as const) {
      const res = await call(api, ALICE, path, body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    }
    expect(await runsOf(s, "touch")).toEqual([]);

    expect((await call(api, ADMIN, "/schedules/tick", {})).status).toBe(400);
    expect((await call(api, ADMIN, "/schedules/tick", { host: "desk", now: "not a time" })).status).toBe(400);
    const res = await call(api, ADMIN, "/schedules/tick", { host: "desk" });
    expect(res.status).toBe(200);
    const claimed = (await res.json()) as ScheduleTickResult;
    expect(claimed.fired.map((f) => f.name)).toEqual(["sweep"]);
    expect(claimed.commands).toMatchObject([{ name: "touch", command: `touch ${marker}`, cwd: null }]);
    // The server returned the command; it did not run it.
    await Bun.sleep(100);
    expect(existsSync(marker)).toBe(false);

    const runId = claimed.commands[0]!.run_id;
    expect((await call(api, ADMIN, `/schedules/runs/${runId}/finish`, { status: "failed", exit_code: 1.5, output_tail: "" })).status).toBe(400);
    const fin = await call(api, ADMIN, `/schedules/runs/${runId}/finish`, { status: "failed", exit_code: 2, output_tail: "boom" });
    expect(fin.status).toBe(200);
    const { run } = (await fin.json()) as { run: { status: string; exit_code: number; output_tail: string } };
    expect(run).toMatchObject({ status: "failed", exit_code: 2 });
    expect(await getScheduledJob(s, "touch")).toMatchObject({ last_status: "failed" });
  });
});

// --- `ob role tick` end to end ---

interface Harness {
  run(args: string[]): Promise<CliResult>;
  store: Store;
}

async function setup(h: Harness): Promise<void> {
  expect((await h.run(["project", "add", "tickp", "--kind", "side"])).code).toBe(0);
  expect((await h.run(["t3", "team", "add", "t", "--projects", "tickp"])).code).toBe(0);
  await setConfig(h.store, "repo_checkouts", JSON.stringify({ tickp: REPO }));
}

async function local(): Promise<Harness> {
  const p = dbPath();
  const db = openDb(p, { create: true });
  const h: Harness = { run: (args) => runCli(p, args), store: sqliteStoreFor(db) };
  await setup(h);
  return h;
}

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

async function withApi(fn: (h: Harness) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const s = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
  const obApi = createObApi({ store: async () => s, token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }) });
  const transport: ApiTransport = async (req) => {
    const res = await obApi(new Request(req.url.replace(BASE, "http://api-host.local"), { method: req.method, headers: req.headers, ...(req.body === undefined ? {} : { body: req.body }) }));
    return { status: res.status, body: await res.text() };
  };
  const h: Harness = { run: (args) => runCli(freshDbPath(), args, { api: { base: BASE, token: TOKEN, transport } }), store: s };
  try {
    await setup(h);
    await fn(h);
  } finally {
    await s.close?.();
    await lease.release();
  }
}

/** A role job or command job on team `t`, due a minute ago by the wall clock (`ob role tick` reads the real time). */
async function dueNow(s: Store, input: Partial<ScheduledJobInput> & { name: string }): Promise<ScheduledJob> {
  return due(s, input.target_kind === "command" ? input : { team: "t", ...input }, new Date(Date.now() - MIN).toISOString());
}

/** OS-82: a live thread in the fake T3, bound as the role's seat. */
async function bindSeat(s: Store, f: FakeT3Install, role: string, threadId: string): Promise<void> {
  f.threads.push({ threadId, projectId: "proj-0", title: `t · ${role}`, status: "idle", worktreePath: null, branch: null, settled: false, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: null });
  await storeAgentRegistry(s).register({ id: `${role}-t`, worktree: REPO, status: "planning", launcher: "t3", sessionId: threadId, ttlS: 3600 });
}

const endToEnd = async (h: Harness) => {
  const f = (fake = installFakeT3([REPO]));
  await bindSeat(h.store, f, "sentinel", "sentinel-1");
  const out = join(scratch, `out-${Math.random().toString(36).slice(2)}`);
  mkdirSync(out);
  await dueNow(h.store, { name: "arch-sweep", prompt: "Sweep the board" });
  await dueNow(h.store, { name: "sent-check", role: "sentinel", prompt: "Check the branches" });
  await dueNow(h.store, { name: "here", target_kind: "command", command: "echo ran > here.txt; echo done", cwd: out });
  await dueNow(h.store, { name: "broken", target_kind: "command", command: "echo bad; exit 4" });
  await dueNow(h.store, { name: "elsewhere", target_kind: "command", command: "touch nope.txt", cwd: out, host: "not-this-machine" });

  const res = await h.run(["role", "tick"]);
  expect(res.code).toBe(0);
  const lines = res.out.trim().split("\n");
  expect(lines.some((l) => /^role tick schedule: fired arch-sweep -> t architect \(message #\d+, run \d+\)$/.test(l))).toBe(true);
  expect(res.out).toContain("role tick schedule: fired sent-check -> t sentinel");
  expect(res.out).toContain(`role tick schedule: ran here on ${HOST}: succeeded (exit 0, run `);
  expect(res.out).toContain(`role tick schedule: ran broken on ${HOST}: failed (exit 4, run `);
  expect(res.out).not.toContain("elsewhere");
  // The same pass delivers both: the architect's run opens with the prompt, the sentinel's goes into its seat.
  expect(res.out).toContain("role tick t architect: run 1 opened");
  expect(res.out).toContain("role tick t sentinel: 1 message queued into seat thread sentinel-1");
  expect(f.launches).toHaveLength(1);
  expect(f.launches[0]!.message).toContain("Sweep the board");
  expect(f.sends.map((s) => s.threadId)).toEqual(["sentinel-1"]);
  expect(f.sends[0]!.message).toContain("Check the branches");
  expect((await messages(h.store)).map((m) => [m.role, m.from_actor, m.read_at !== null])).toEqual([["architect", "schedule", true], ["sentinel", "schedule", true]]);

  expect(readFileSync(join(out, "here.txt"), "utf8")).toBe("ran\n");
  expect(existsSync(join(out, "nope.txt"))).toBe(false);
  expect(await runsOf(h.store, "here")).toMatchObject([{ status: "succeeded", exit_code: 0, output_tail: "done\n", host: HOST }]);
  expect(await runsOf(h.store, "broken")).toMatchObject([{ status: "failed", exit_code: 4, output_tail: "bad\n" }]);
  expect(await getScheduledJob(h.store, "broken")).toMatchObject({ last_status: "failed", last_error: "exit 4: bad" });
  expect(await runsOf(h.store, "elsewhere")).toEqual([]);

  // Nothing due: the next pass prints no schedule line, and --json carries the teams and the schedule pass.
  const json = await h.run(["role", "tick", "--json"]);
  expect(json.code).toBe(0);
  const parsed = JSON.parse(json.out) as { teams: Array<{ team: string }>; schedules: { host: string; fired: unknown[]; commands: unknown[] } };
  expect(parsed.teams.map((t) => t.team)).toEqual(["t"]);
  expect(parsed.schedules).toMatchObject({ host: HOST, night_locked: false, fired: [], commands: [], error: null });
};

describe("ob role tick runs the scheduled jobs (OS-311)", () => {
  test("locally: role jobs delivered to architect and sentinel, this host's commands run, a failing one does not stop the tick", async () => {
    await endToEnd(await local());
  }, 30_000);

  test("over the API on Postgres: the server claims, this machine runs and delivers", () => withApi(endToEnd), 60_000);

  test("a muse job is delivered to the bound muse", async () => {
    const h = await local();
    const f = (fake = installFakeT3([REPO]));
    await bindSeat(h.store, f, "muse", "muse-1");
    await dueNow(h.store, { name: "muse-idea", role: "muse", prompt: "Think of one thing" });
    const res = await h.run(["role", "tick"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("role tick schedule: fired muse-idea -> t muse");
    expect(res.out).toContain("role tick t muse: 1 message queued into seat thread muse-1");
    expect(f.sends.map((s) => s.threadId)).toEqual(["muse-1"]);
    expect(f.sends[0]!.message).toContain("Think of one thing");
  });

  test("under the good-night lock a respecting job is skipped and printed; nothing is delivered", async () => {
    const h = await local();
    lock();
    await dueNow(h.store, { name: "arch-sweep" });
    const res = await h.run(["role", "tick"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("role tick schedule: skipped arch-sweep for good night; next ");
    expect(await messages(h.store)).toEqual([]);
  });

  test("with no job due the output is what it was: one line per team", async () => {
    const h = await local();
    const res = await h.run(["role", "tick"]);
    expect(res.err).toBe("");
    expect(res.out.trim()).toBe("role tick t: nothing new");
  });
});

// OS-310: scheduled job tracker (slice 1) — schedule parsing & next-run math, SQLite store + CLI,
// API client/server round-trip, and scoped-token 403 refusal. Fresh SQLite file per test, in-process API transport.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { addTeam } from "../../../apps/cli/src/team.ts";
import {
  computeNextRunAt,
  InvalidScheduleError,
  MIN_INTERVAL_MS,
  normalizeScheduleExpr,
  parseCron,
  parseInterval,
  parseOnce,
  parseScheduleKind,
} from "../../../apps/cli/src/schedule.ts";
import {
  createScheduledJob,
  deleteScheduledJob,
  getScheduledJob,
  listScheduledJobRuns,
  listScheduledJobs,
  parseJobName,
  runScheduledJobNow,
  ScheduledJobNotFoundError,
  updateScheduledJob,
  type ScheduledJob,
  type ScheduledJobRun,
} from "../../../apps/cli/src/scheduled-jobs.ts";
import { cmdSchedule, expandScheduleOnceFlag } from "../../../apps/cli/src/commands/schedule.ts";
import { FLAGS, run as runCliInProc } from "../../../apps/cli/src/cli.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import { OB_API_PREFIX } from "../../../apps/cli/src/api/contract.ts";
import { loadScopedTokens, sha256Hex } from "../../../apps/cli/src/api/scoped-tokens.ts";
import { runApi } from "../../../apps/cli/src/api/run.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { isApiRouted } from "../../../apps/cli/src/api/routing.ts";
import { POSTGRES_SERVABLE_COMMANDS } from "../../../apps/cli/src/db/servable.ts";

const paths: string[] = [];
const scratch = mkdtempSync(join(process.env.TMPDIR ?? process.cwd(), "ob-schedule-310-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
afterEach(() => {
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});

function db(): Database {
  const p = freshDbPath();
  paths.push(p);
  return openDb(p);
}

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const writeErr = process.stderr.write.bind(process.stderr);
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  process.stderr.write = ((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    out,
    err,
    restore: () => {
      console.log = log;
      process.stderr.write = writeErr;
    },
  };
}

describe("schedule parsing and computeNextRunAt (OS-310)", () => {
  test("parseInterval accepts valid durations >= 60s and refuses shorter or malformed ones", () => {
    expect(parseInterval("60s")).toBe(MIN_INTERVAL_MS);
    expect(parseInterval("90s")).toBe(90_000);
    expect(parseInterval("15m")).toBe(900_000);
    expect(parseInterval("1h")).toBe(3_600_000);
    expect(parseInterval("6h")).toBe(21_600_000);
    expect(parseInterval("1d")).toBe(86_400_000);
    expect(parseInterval("  5m ")).toBe(300_000);

    for (const bad of ["59s", "0s", "0m", "-5m", "15", "abc", "15w", "1.5h", ""]) {
      expect(() => parseInterval(bad)).toThrow(InvalidScheduleError);
    }
  });

  test("parseOnce accepts ISO timestamps as UTC (even without zone) and refuses bare or impossible dates", () => {
    expect(parseOnce("2026-12-01T09:00:00Z").toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(parseOnce("2026-12-01T11:00:00+02:00").toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(parseOnce("2026-12-01T09:30").toISOString()).toBe("2026-12-01T09:30:00.000Z");

    for (const bad of ["2026-12-01", "tomorrow", "2026-13-01T00:00:00Z", "2026-02-30T09:00:00Z", ""]) {
      expect(() => parseOnce(bad)).toThrow(InvalidScheduleError);
    }
  });

  test("parseCron and computeNextRunAt handle standard 5-field UTC cron expressions and edge cases", () => {
    const from = new Date("2026-11-28T03:00:00.000Z"); // Saturday
    // Strictly after `from`: exact match advances to next day.
    expect(computeNextRunAt("cron", "0 3 * * *", from)).toBe("2026-11-29T03:00:00.000Z");
    expect(computeNextRunAt("cron", "0 3 * * *", new Date("2026-11-28T02:59:59.999Z"))).toBe("2026-11-28T03:00:00.000Z");

    // Step and list.
    expect(computeNextRunAt("cron", "*/15 * * * *", new Date("2026-11-28T03:00:00.000Z"))).toBe("2026-11-28T03:15:00.000Z");
    expect(computeNextRunAt("cron", "5,35 4 * * *", new Date("2026-11-28T03:50:00.000Z"))).toBe("2026-11-28T04:05:00.000Z");

    // Named months and days-of-week, plus dow=7 as Sunday.
    expect(computeNextRunAt("cron", "0 9 * * mon-fri", from)).toBe("2026-11-30T09:00:00.000Z");
    expect(computeNextRunAt("cron", "0 8 * * 7", from)).toBe("2026-11-29T08:00:00.000Z");
    expect(computeNextRunAt("cron", "30 8 1 jan,jul *", from)).toBe("2027-01-01T08:30:00.000Z");

    // Standard cron OR rule when both dom and dow are restricted: matches 2026-11-29 (Sun) before 15th.
    expect(computeNextRunAt("cron", "0 0 15 * sun", from)).toBe("2026-11-29T00:00:00.000Z");

    // Leap day across years.
    expect(computeNextRunAt("cron", "0 0 29 2 *", new Date("2026-03-01T00:00:00.000Z"))).toBe("2028-02-29T00:00:00.000Z");

    // Impossible date within 5-year search horizon.
    expect(() => computeNextRunAt("cron", "0 0 30 2 *", from)).toThrow(InvalidScheduleError);

    // Invalid cron expressions.
    for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "5-2 * * * *", "foo * * * *"]) {
      expect(() => parseCron(bad)).toThrow(InvalidScheduleError);
    }
  });

  test("computeNextRunAt for once and interval, plus normalizeScheduleExpr and parseScheduleKind", () => {
    const from = new Date("2026-11-28T10:00:00.000Z");
    expect(computeNextRunAt("once", "2026-12-01T11:00:00+02:00", from)).toBe("2026-12-01T09:00:00.000Z");
    expect(computeNextRunAt("interval", "15m", from)).toBe("2026-11-28T10:15:00.000Z");
    expect(normalizeScheduleExpr("once", "2026-12-01T11:00:00+02:00")).toBe("2026-12-01T09:00:00.000Z");
    expect(normalizeScheduleExpr("cron", "  0   3  * * * ")).toBe("0 3 * * *");
    expect(normalizeScheduleExpr("interval", " 1h ")).toBe("1h");
    expect(parseScheduleKind("cron")).toBe("cron");
    expect(() => parseScheduleKind("weekly")).toThrow(InvalidScheduleError);
  });
});

describe("scheduled jobs store and CLI (OS-310)", () => {
  test("CRUD lifecycle for role and command jobs, runs listing, pause/resume, run-now, and cascade delete", async () => {
    const d = db();
    const s = asStore(d);
    await addTeam(d, { name: "core" });
    const now = new Date("2026-11-28T10:00:00.000Z");

    const roleJob = await createScheduledJob(
      d,
      {
        name: "nightly-sweep",
        schedule_kind: "cron",
        schedule_expr: "0 3 * * *",
        target_kind: "role",
        team: "core",
        role: "architect",
        prompt: "Check open PRs",
      },
      now,
    );
    expect(roleJob.enabled).toBe(true);
    expect(roleJob.respect_good_night).toBe(true);
    expect(roleJob.next_run_at).toBe("2026-11-29T03:00:00.000Z");

    const cmdJob = await createScheduledJob(
      d,
      {
        name: "health-ping",
        schedule_kind: "interval",
        schedule_expr: "15m",
        target_kind: "command",
        command: "echo ok",
        cwd: "/tmp",
        host: "desk",
        respect_good_night: false,
      },
      now,
    );
    expect(cmdJob.next_run_at).toBe("2026-11-28T10:15:00.000Z");
    expect(cmdJob.respect_good_night).toBe(false);

    // Out-of-range int4 ref returns null instead of throwing.
    expect(await getScheduledJob(d, "99999999999")).toBeNull();

    // Pause hides from default list, keeps next_run_at, and refuses `run`.
    const paused = await updateScheduledJob(d, "health-ping", { enabled: false }, now);
    expect(paused.enabled).toBe(false);
    expect(paused.next_run_at).toBe("2026-11-28T10:15:00.000Z");
    expect((await listScheduledJobs(d)).map((j) => j.name)).toEqual(["nightly-sweep"]);
    expect((await listScheduledJobs(d, { all: true })).map((j) => j.name)).toEqual(["health-ping", "nightly-sweep"]);
    await expect(runScheduledJobNow(d, "health-ping", now)).rejects.toThrow("paused");

    // Resume recomputes next_run_at from now.
    const later = new Date("2026-11-28T12:00:00.000Z");
    const resumed = await updateScheduledJob(d, String(cmdJob.id), { enabled: true }, later);
    expect(resumed.enabled).toBe(true);
    expect(resumed.next_run_at).toBe("2026-11-28T12:15:00.000Z");

    // Run sets next_run_at to now.
    const dueNow = await runScheduledJobNow(d, "health-ping", later);
    expect(dueNow.next_run_at).toBe(later.toISOString());

    // Direct run insert verifies listScheduledJobRuns and ON DELETE CASCADE.
    await s.q.insert(s.t.scheduledJobRun).values({
      job_id: cmdJob.id,
      started_at: later.toISOString(),
      finished_at: later.toISOString(),
      status: "succeeded",
      host: "desk",
      exit_code: 0,
      output_tail: "ok\n",
    });
    const shown = await listScheduledJobRuns(d, "health-ping", 5);
    expect(shown.runs).toHaveLength(1);
    expect(shown.runs[0]!.status).toBe("succeeded");

    // Delete removes job and cascades to its runs.
    await deleteScheduledJob(d, "health-ping");
    expect(await getScheduledJob(d, "health-ping")).toBeNull();
    expect(await s.q.select().from(s.t.scheduledJobRun).where(eq(s.t.scheduledJobRun.job_id, cmdJob.id))).toHaveLength(0);
    await expect(listScheduledJobRuns(d, "health-ping")).rejects.toThrow(ScheduledJobNotFoundError);
  });

  test("refuses invalid schedules, duplicate names, unknown teams/roles, and bad flags with nothing written", async () => {
    const d = db();
    await addTeam(d, { name: "core" });

    expect(() => parseJobName("123bad")).toThrow();
    expect(() => parseJobName("Bad_Name")).toThrow();

    // Invalid schedule writes nothing.
    await expect(
      createScheduledJob(d, { name: "bad-cron", schedule_kind: "cron", schedule_expr: "not a cron", target_kind: "command", command: "true" }),
    ).rejects.toThrow(InvalidScheduleError);
    await expect(
      createScheduledJob(d, { name: "short-int", schedule_kind: "interval", schedule_expr: "10s", target_kind: "command", command: "true" }),
    ).rejects.toThrow(InvalidScheduleError);

    // Unknown team and unbound muse role write nothing.
    await expect(
      createScheduledJob(d, { name: "no-team", schedule_kind: "interval", schedule_expr: "5m", target_kind: "role", team: "ghost", role: "architect", prompt: "hi" }),
    ).rejects.toThrow("ghost");
    await expect(
      createScheduledJob(d, { name: "no-muse", schedule_kind: "interval", schedule_expr: "5m", target_kind: "role", team: "core", role: "muse", prompt: "hi" }),
    ).rejects.toThrow("muse");

    expect(await listScheduledJobs(d, { all: true })).toHaveLength(0);

    // Duplicate name refused.
    await createScheduledJob(d, { name: "dup", schedule_kind: "interval", schedule_expr: "5m", target_kind: "command", command: "true" });
    await expect(
      createScheduledJob(d, { name: "dup", schedule_kind: "interval", schedule_expr: "10m", target_kind: "command", command: "true" }),
    ).rejects.toThrow("already exists");
    expect(await listScheduledJobs(d, { all: true })).toHaveLength(1);

    // CLI flag validation: mutually exclusive schedule flags & target flags.
    const s = asStore(d);
    await expect(
      cmdSchedule({ db: d, store: s, dbPath: "", mode: "human", flags: { "once-at": "2026-12-01T00:00:00Z", every: "5m", cmd: "true" }, args: ["add", "both-sched"] } as never),
    ).rejects.toThrow("pass one schedule");
    await expect(
      cmdSchedule({ db: d, store: s, dbPath: "", mode: "human", flags: { every: "5m", team: "core", role: "architect", prompt: "hi", cmd: "true" }, args: ["add", "both-target"] } as never),
    ).rejects.toThrow("not both");
    await expect(
      cmdSchedule({ db: d, store: s, dbPath: "", mode: "human", flags: { runs: "0" }, args: ["show", "dup"] } as never),
    ).rejects.toThrow("--runs");
  });

  test("expandScheduleOnceFlag rewrites --once only for ob schedule and end-to-end CLI works", async () => {
    expect(expandScheduleOnceFlag(["spinoff", "watch", "--once"], FLAGS)).toEqual(["spinoff", "watch", "--once"]);
    expect(expandScheduleOnceFlag(["--db", "/tmp/a.db", "schedule", "add", "x", "--once", "2026-12-01T00:00:00Z"], FLAGS)).toEqual([
      "--db",
      "/tmp/a.db",
      "schedule",
      "add",
      "x",
      "--once-at",
      "2026-12-01T00:00:00Z",
    ]);

    const p = freshDbPath();
    paths.push(p);
    const d = openDb(p);
    await addTeam(d, { name: "core" });
    d.close();

    const prevCreate = process.env.OMNISLASH_DB_CREATE;
    const prevStore = process.env.OMNISLASH_STORE;
    process.env.OMNISLASH_DB_CREATE = "1";
    process.env.OMNISLASH_STORE = "sqlite";
    const cap = capture();
    try {
      const codeAdd = await runCliInProc(["--db", p, "schedule", "add", "once-job", "--once", "2026-12-01T07:00:00Z", "--cmd", "echo ok", "--json"]);
      expect(codeAdd).toBe(0);
      const created = JSON.parse(cap.out.join("\n")) as ScheduledJob;
      expect(created.schedule_kind).toBe("once");
      expect(created.next_run_at).toBe("2026-12-01T07:00:00.000Z");
    } finally {
      cap.restore();
      if (prevCreate === undefined) delete process.env.OMNISLASH_DB_CREATE;
      else process.env.OMNISLASH_DB_CREATE = prevCreate;
      if (prevStore === undefined) delete process.env.OMNISLASH_STORE;
      else process.env.OMNISLASH_STORE = prevStore;
    }
  });
});

describe("/schedules API and scoped-token 403 refusal (OS-310)", () => {
  const ADMIN = "an-admin-bearer-token-that-is-long-enough";
  const ALICE = "alice-scoped-token-0123456789abcdef0123456789";

  function serve(store: Store) {
    const tokens = join(scratch, `tokens-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(tokens, JSON.stringify([{ user: "alice", sha256: sha256Hex(ALICE), projects: ["alpha"], families: ["items", "next", "search", "projects"] }]));
    chmodSync(tokens, 0o600);
    return createObApi({
      store: async () => store,
      token: () => ({ token: ADMIN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
      scopedTokens: () => loadScopedTokens(tokens),
    });
  }

  test("full ob schedule round-trip over the API and 403 for scoped tokens", async () => {
    expect(isApiRouted("schedule")).toBe(true);
    expect(POSTGRES_SERVABLE_COMMANDS.has("schedule")).toBe(true);

    const d = db();
    const s = asStore(d);
    await addTeam(s, { name: "core" });
    const api = serve(s);
    const transport: ApiTransport = async (req) => {
      const res = await api(new Request(req.url, { method: req.method, headers: req.headers, body: req.body }));
      return { status: res.status, body: await res.text() };
    };

    const callCli = async (args: string[], flags: Record<string, unknown> = {}) => {
      const cap = capture();
      try {
        const code = await runApi({
          command: "schedule",
          args,
          flags: { json: true, ...flags },
          base: "http://api-host.local",
          token: ADMIN,
          transport,
        });
        return { code, out: cap.out.join("\n"), err: cap.err.join("") };
      } finally {
        cap.restore();
      }
    };

    const added = await callCli(["add", "api-nightly"], { cron: "0 3 * * *", team: "core", role: "architect", prompt: "Sweep" });
    expect(added.code).toBe(0);
    const job = JSON.parse(added.out) as ScheduledJob;
    expect(job.name).toBe("api-nightly");
    expect(job.target_kind).toBe("role");

    const listed = await callCli(["list"]);
    expect(listed.code).toBe(0);
    expect((JSON.parse(listed.out) as ScheduledJob[]).map((j) => j.name)).toEqual(["api-nightly"]);

    const paused = await callCli(["pause", "api-nightly"]);
    expect(paused.code).toBe(0);
    expect((JSON.parse(paused.out) as ScheduledJob).enabled).toBe(false);

    const listedEnabled = await callCli(["list"]);
    expect(JSON.parse(listedEnabled.out) as ScheduledJob[]).toHaveLength(0);
    const listedAll = await callCli(["list"], { all: true });
    expect(JSON.parse(listedAll.out) as ScheduledJob[]).toHaveLength(1);

    const resumed = await callCli(["resume", "api-nightly"]);
    expect(resumed.code).toBe(0);
    expect((JSON.parse(resumed.out) as ScheduledJob).enabled).toBe(true);

    const ran = await callCli(["run", "api-nightly"]);
    expect(ran.code).toBe(0);

    const shown = await callCli(["show", "api-nightly"], { runs: "5" });
    expect(shown.code).toBe(0);
    const detail = JSON.parse(shown.out) as { job: ScheduledJob; runs: ScheduledJobRun[] };
    expect(detail.job.name).toBe("api-nightly");
    expect(detail.runs).toEqual([]);

    // Invalid schedule over API -> 400 and writes nothing.
    const badRes = await api(
      new Request(`http://api-host.local${OB_API_PREFIX}/schedules`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "bad-api", schedule_kind: "interval", schedule_expr: "5s", target_kind: "command", command: "true" }),
      }),
    );
    expect(badRes.status).toBe(400);
    expect(await getScheduledJob(s, "bad-api")).toBeNull();

    // Scoped token refused on every /schedules route with 403 forbidden.
    for (const [method, path, body] of [
      ["GET", "/schedules", undefined],
      ["POST", "/schedules", JSON.stringify({ name: "x", schedule_kind: "interval", schedule_expr: "5m", target_kind: "command", command: "true" })],
      ["GET", "/schedules/api-nightly", undefined],
      ["POST", "/schedules/api-nightly", JSON.stringify({ enabled: false })],
      ["POST", "/schedules/api-nightly/run", undefined],
      ["DELETE", "/schedules/api-nightly", undefined],
    ] as const) {
      const res = await api(
        new Request(`http://api-host.local${OB_API_PREFIX}${path}`, {
          method,
          headers: { authorization: `Bearer ${ALICE}`, ...(body ? { "content-type": "application/json" } : {}) },
          body,
        }),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    }

    const deleted = await callCli(["delete", "api-nightly"]);
    expect(deleted.code).toBe(0);
    expect(await listScheduledJobs(s, { all: true })).toHaveLength(0);
  });
});

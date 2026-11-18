import { afterEach, describe, expect, test } from "bun:test";
import { until } from "../../../apps/cli/test/helpers.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { findTaskslash, rttimeHardLimitFinite, runUnderLease, taskslashArgv, type LeaseRunIo } from "../src/lease-run.ts";

// OB-2234: a `cpu:` run goes through the TaskSlash daemon when `taskslash status --json` answers, and takes
// the lease as before when it does not. The daemon is faked by a shell script standing in for the client:
// `status` exits FAKE_TS_STATUS, `run` appends its argv to FAKE_TS_LOG (one job per line, arguments joined by
// a tab) and then runs whatever follows `--` as its child, as the real client does once the job is admitted
// (a child, not an exec: the real client is a separate process that forwards no signal).

const INDEX = join(import.meta.dir, "../../../apps/cli/src/index.ts");
const temps: string[] = [];

function temp(name: string): string {
  const p = join(tmpdir(), `ob-2234-${randomUUID()}-${name}`);
  temps.push(p);
  return p;
}

afterEach(() => {
  for (const p of temps.splice(0)) for (const s of ["", "-wal", "-shm", ".status"]) rmSync(`${p}${s}`, { force: true, recursive: true });
});

function fakeTaskslash(status: number, bin = temp("taskslash")): { bin: string; log: string } {
  const log = temp("jobs.log");
  writeFileSync(
    bin,
    `#!/bin/sh
case "$1" in
  status) echo status >> '${log}.status'; exit ${status} ;;
  run)
    shift
    line=""
    for a in "$@"; do line="$line$a	"; done
    printf '%s\\n' "$line" >> '${log}'
    while [ "$1" != "--" ]; do shift; done
    shift
    "$@"
    exit $? ;;
esac
exit 1
`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

const jobs = (log: string): string[][] =>
  existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.replace(/\t$/, "").split("\t")) : [];

/** The job script every TaskSlash job runs (OB-2234): the pid record, then timeout as the group leader. */
const JOB = taskslashArgv("t", "cpu:browser", ["x"], 1)[9]!;

function countingIo() {
  const calls = { acquires: 0, releases: 0 };
  const io: LeaseRunIo = {
    acquire: async () => (calls.acquires++, { ok: true, holder: "p" }),
    release: async () => (calls.releases++, true),
  };
  return { io, calls };
}

/** Run in-process with the TaskSlash client set to `bin` (process.env is what runUnderLease reads). */
async function inProcess(bin: string, command: string[], capS: number | null = 600) {
  const before = process.env.OB_LEASE_RUN_TASKSLASH;
  const escapeBefore = process.env.OB_LEASE_RUN_ESCAPE;
  process.env.OB_LEASE_RUN_TASKSLASH = bin;
  process.env.OB_LEASE_RUN_ESCAPE = "0";
  try {
    const { io, calls } = countingIo();
    const log: string[] = [];
    const code = await runUnderLease({ resource: "cpu:browser", holder: "p", command, io, heartbeatMs: 60_000, log: (l) => log.push(l), pollMs: 5, capS });
    return { code, calls, log };
  } finally {
    process.env.OB_LEASE_RUN_TASKSLASH = before;
    if (escapeBefore === undefined) delete process.env.OB_LEASE_RUN_ESCAPE;
    else process.env.OB_LEASE_RUN_ESCAPE = escapeBefore;
  }
}

function obEnv(db: string, bin: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    OMNISLASH_DB: db,
    OMNISLASH_API: "",
    OB_LEASE_RUN_HELD: "",
    OB_LEASE_RUN_ESCAPE: "0",
    OB_LEASE_RUN_TASKSLASH: bin,
    OMNISLASH_API_URL_FILE: join(tmpdir(), `ob-no-api-url-${randomUUID()}`),
    ...extra,
  };
}

function ob(db: string, args: string[], bin: string, extra: Record<string, string> = {}) {
  const env = obEnv(db, bin, extra);
  const r = Bun.spawnSync(["bun", "run", INDEX, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("lease run through TaskSlash (OB-2234)", () => {
  test("a daemon that answers gets the job, with the stable name and the cap inside it, and no lease is taken", async () => {
    const { bin, log } = fakeTaskslash(0);
    const r = await inProcess(bin, ["sh", "-c", "exit 3"]);
    expect(r.code).toBe(3);
    expect(r.calls).toEqual({ acquires: 0, releases: 0 });
    expect(r.log).toEqual(["lease run: through taskslash"]);
    expect(jobs(log)).toEqual([["--kind", "browser", "--name", "ob:cpu:browser:sh -c exit 3", "--", "sh", "-c", JOB, "600", "sh", "-c", "exit 3"]]);
  });

  test("a command line longer than 120 characters is cut to its first 120 in the name, never in the command", () => {
    const long = ["echo", "x".repeat(200)];
    const argv = taskslashArgv("/bin/taskslash", "cpu:browser", long, 600);
    const name = argv[argv.indexOf("--name") + 1]!;
    expect(name).toBe(`ob:cpu:browser:${long.join(" ").slice(0, 120)}`);
    expect(name.length).toBe("ob:cpu:browser:".length + 120);
    expect(argv.slice(-2)).toEqual(long);
  });

  test("a daemon that does not answer: the lease is taken and the command runs as before, with no new line", async () => {
    const { bin, log } = fakeTaskslash(1);
    const r = await inProcess(bin, ["sh", "-c", "exit 4"]);
    expect(r.code).toBe(4);
    expect(r.calls).toEqual({ acquires: 1, releases: 1 });
    expect(r.log).toEqual([]);
    expect(jobs(log)).toEqual([]);
  });

  test("no client binary: the lease is taken and the command runs as before", async () => {
    const r = await inProcess(temp("no-such-taskslash"), ["true"]);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual({ acquires: 1, releases: 1 });
    expect(r.log).toEqual([]);
  });

  test("a resource that is not cpu: never goes through TaskSlash", async () => {
    const { bin, log } = fakeTaskslash(0);
    const before = process.env.OB_LEASE_RUN_TASKSLASH;
    process.env.OB_LEASE_RUN_TASKSLASH = bin;
    try {
      const { io, calls } = countingIo();
      const code = await runUnderLease({ resource: "probe:x", holder: "p", command: ["true"], io, heartbeatMs: 60_000, log: () => {}, pollMs: 5, capS: 60 });
      expect(code).toBe(0);
      expect(calls.acquires).toBe(1);
      expect(jobs(log)).toEqual([]);
    } finally {
      process.env.OB_LEASE_RUN_TASKSLASH = before;
    }
  });

  test("ob lease run --max 2 puts timeout -k 10 2 in the job, and a job cut at the cap exits 124", () => {
    const { bin, log } = fakeTaskslash(0);
    const db = temp("db.sqlite");
    const t0 = Date.now();
    const r = ob(db, ["lease", "run", "--max", "2", "cpu:browser", "--", "sleep", "30"], bin);
    expect(r.code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(r.err).toContain("lease run: through taskslash");
    expect(jobs(log)).toEqual([["--kind", "browser", "--name", "ob:cpu:browser:sleep 30", "--", "sh", "-c", JOB, "2", "sleep", "30"]]);
  }, 60_000);

  test("a nested ob lease run cpu:browser inside an outer one submits no second job", () => {
    const { bin, log } = fakeTaskslash(0);
    const db = temp("db.sqlite");
    const r = ob(db, ["lease", "run", "cpu:browser", "--", "bun", "run", INDEX, "lease", "run", "cpu:browser", "--", "echo", "inner"], bin);
    expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: "inner\n" });
    expect(jobs(log)).toHaveLength(1);
    expect(r.err).toContain("already held by the enclosing lease run");
  }, 60_000);

  test("SIGTERM to ob stops the job's whole process group, not just the client, and ob exits 143", async () => {
    const { bin } = fakeTaskslash(0);
    const db = temp("db.sqlite");
    const ready = temp("ready");
    // A grandchild of the job, the way a browser is a grandchild of a test runner.
    const n = 7_000 + Math.floor(Math.random() * 2_000);
    const proc = Bun.spawn(["setsid", "bun", "run", INDEX, "lease", "run", "cpu:browser", "--", "sh", "-c", `sleep ${n}.5 & touch '${ready}'; wait`], {
      env: obEnv(db, bin),
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      expect(await until(() => existsSync(ready), 30_000)).toBe(true);
      const alive = () => Bun.spawnSync(["pgrep", "-xf", `sleep ${n}.5`]).exitCode === 0;
      expect(alive()).toBe(true);
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(143);
      expect(await until(() => !alive(), 5_000)).toBe(true);
    } finally {
      Bun.spawnSync(["pkill", "-xf", `sleep ${n}.5`]);
    }
  }, 60_000);

  const userManager =
    !!Bun.which("systemd-run") && Bun.spawnSync(["systemd-run", "--user", "--wait", "--quiet", "--collect", "--", "true"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  test.skipIf(!userManager)("under OB_LEASE_RUN_ESCAPE=1 the client and its job run in an ob-lease-run user service (OB-2161)", () => {
    const { bin } = fakeTaskslash(0);
    const db = temp("db.sqlite");
    const r = ob(db, ["lease", "run", "cpu:browser", "--", "cat", "/proc/self/cgroup"], bin, { OB_LEASE_RUN_ESCAPE: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("ob-lease-run-");
    if (rttimeHardLimitFinite()) expect(r.err).not.toContain("inherited RTTIME limit");
  }, 60_000);
});

// OB-2254: the PATH client is used only when it answers; a broken one (a mise shim for an inactive tool exits
// 1) falls through to ~/.cargo/bin/taskslash. PATH and HOME are fakes passed in, never the real machine's.
describe("which TaskSlash client answers (OB-2254)", () => {
  /** A fake client named `taskslash` in its own PATH dir, and one in a fake HOME's .cargo/bin. */
  function machine(pathStatus: number | null, cargoStatus: number | null) {
    const pathDir = temp("path");
    const home = temp("home");
    mkdirSync(pathDir, { recursive: true });
    mkdirSync(join(home, ".cargo", "bin"), { recursive: true });
    const onPath = pathStatus === null ? null : fakeTaskslash(pathStatus, join(pathDir, "taskslash"));
    const cargo = cargoStatus === null ? null : fakeTaskslash(cargoStatus, join(home, ".cargo", "bin", "taskslash"));
    return { env: { PATH: pathDir, HOME: home } as NodeJS.ProcessEnv, onPath, cargo };
  }
  const asked = (c: { log: string } | null) => (c && existsSync(`${c.log}.status`) ? readFileSync(`${c.log}.status`, "utf8").split("\n").filter(Boolean).length : 0);

  test("a PATH client that exits 1 and a cargo client that answers: the cargo one, naming the PATH one skipped", async () => {
    const m = machine(1, 0);
    expect(await findTaskslash(m.env)).toEqual({ bin: m.cargo!.bin, skipped: m.onPath!.bin });
  });

  test("both clients fail: none, so the lease path runs", async () => {
    const m = machine(1, 1);
    expect(await findTaskslash(m.env)).toBeNull();
    expect([asked(m.onPath), asked(m.cargo)]).toEqual([1, 1]);
  });

  test("a PATH client that answers is used, with nothing skipped, and the cargo one is never run", async () => {
    const m = machine(0, 0);
    expect(await findTaskslash(m.env)).toEqual({ bin: m.onPath!.bin, skipped: null });
    expect(asked(m.cargo)).toBe(0);
  });

  test("OB_LEASE_RUN_TASKSLASH=<path> that fails does not fall back to PATH or cargo", async () => {
    const m = machine(0, 0);
    const pinned = fakeTaskslash(1);
    expect(await findTaskslash({ ...m.env, OB_LEASE_RUN_TASKSLASH: pinned.bin })).toBeNull();
    expect([asked(m.onPath), asked(m.cargo)]).toEqual([0, 0]);
  });

  test("a broken PATH client: ob lease run warns once, then goes through the cargo client", async () => {
    const m = machine(1, 0);
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME, TS: process.env.OB_LEASE_RUN_TASKSLASH, ESC: process.env.OB_LEASE_RUN_ESCAPE };
    process.env.PATH = `${m.env.PATH}:${saved.PATH}`;
    process.env.HOME = m.env.HOME;
    delete process.env.OB_LEASE_RUN_TASKSLASH;
    process.env.OB_LEASE_RUN_ESCAPE = "0";
    try {
      const { io, calls } = countingIo();
      const log: string[] = [];
      const code = await runUnderLease({ resource: "cpu:browser", holder: "p", command: ["sh", "-c", "exit 5"], io, heartbeatMs: 60_000, log: (l) => log.push(l), pollMs: 5, capS: 600 });
      expect(code).toBe(5);
      expect(calls).toEqual({ acquires: 0, releases: 0 });
      expect(log).toEqual([`lease run: taskslash on PATH (${m.onPath!.bin}) did not answer; using ${m.cargo!.bin}`, "lease run: through taskslash"]);
      expect(jobs(m.cargo!.log)).toHaveLength(1);
      expect(jobs(m.onPath!.log)).toEqual([]);
    } finally {
      for (const [k, v] of [["PATH", saved.PATH], ["HOME", saved.HOME], ["OB_LEASE_RUN_TASKSLASH", saved.TS], ["OB_LEASE_RUN_ESCAPE", saved.ESC]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

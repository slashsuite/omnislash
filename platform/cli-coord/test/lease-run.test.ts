import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { until } from "../../../apps/cli/test/helpers.ts";
import { acquireLease, isLeaseExpired, leaseKeyClass, type LeaseRow, leaseStatus, normalizeLeaseResource, releaseLease } from "../src/lease.ts";
import { LEASE_RUN_CAP_EXIT, LEASE_RUN_CPU_CAP_S, leaseRunCap, runUnderLease, type LeaseRunIo, type LeaseRunOptions } from "../src/lease-run.ts";
import { ApiError } from "../../../apps/cli/src/api/client.ts";
import { openDb } from "../../../apps/cli/src/db.ts";

// OB-2071: `ob lease run cpu:browser -- <command>` holds one machine-wide slot for as long as a browser
// test run lasts. These tests run the real `ob` process against a temp database, because the behaviour
// that matters is process-level: waiting on a second process, forwarding a signal, releasing on the way out.

const INDEX = join(import.meta.dir, "../../../apps/cli/src/index.ts");
const temps: string[] = [];
const running: Array<ReturnType<typeof Bun.spawn>> = [];

function temp(name: string): string {
  const p = join(tmpdir(), `ob-lease-run-${randomUUID()}-${name}`);
  temps.push(p);
  return p;
}

function envFor(dbPath: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    OMNISLASH_DB: dbPath,
    OMNISLASH_API: "",
    // A suite run under `ob lease run cpu:browser -- ...` must not make every spawned run a nested one.
    OB_LEASE_RUN_HELD: "",
    // The plain-child path (OB-2161): in a T3 shell the escape would apply; lease-run-escape.test.ts covers it.
    OB_LEASE_RUN_ESCAPE: "0",
    OMNISLASH_API_URL_FILE: join(tmpdir(), `ob-no-api-url-${randomUUID()}`),
    ...extra,
  };
}

// The in-process runUnderLease tests read process.env: pin them to the plain-child path too.
let escapeBefore: string | undefined;
beforeAll(() => {
  escapeBefore = process.env.OB_LEASE_RUN_ESCAPE;
  process.env.OB_LEASE_RUN_ESCAPE = "0";
});
afterAll(() => {
  if (escapeBefore === undefined) delete process.env.OB_LEASE_RUN_ESCAPE;
  else process.env.OB_LEASE_RUN_ESCAPE = escapeBefore;
});

afterEach(() => {
  for (const p of running.splice(0)) {
    try {
      p.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const p of temps.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${p}${suffix}`, { force: true });
  }
});

function obSync(db: string, args: string[]) {
  const proc = Bun.spawnSync(["bun", "run", INDEX, ...args], { env: envFor(db), stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

/** A running `ob` whose stderr and stdout are collected as they arrive. */
function obStart(db: string, args: string[], extraEnv: Record<string, string> = {}) {
  // setsid: no controlling terminal, so a signal sent here is forwarded even when `bun test` runs in a shell.
  const proc = Bun.spawn(["setsid", "bun", "run", INDEX, ...args], { env: envFor(db, extraEnv), stdout: "pipe", stderr: "pipe" });
  running.push(proc);
  const seen = { out: "", err: "" };
  const pump = async (stream: ReadableStream<Uint8Array>, key: "out" | "err") => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) seen[key] += decoder.decode(chunk);
  };
  const pumped = Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, "out"), pump(proc.stderr as ReadableStream<Uint8Array>, "err")]);
  return {
    proc,
    seen,
    async done() {
      const code = await proc.exited;
      await pumped;
      return code;
    },
  };
}

/**
 * The leases in a test database, read in-process (OB-2165). Only the `ob lease run` under test is worth an
 * `ob` start-up: under load each one took about 10 s, and a test that also spawned `ob lease acquire` to set
 * up and `ob lease status` to look spent its 60 s on those, until bun's timeout SIGTERMed the last read's
 * child mid-start and its empty stdout surfaced as "JSON Parse error: Unexpected EOF". The read opens the
 * same file the children use (WAL), synchronously, so `until()` can poll it.
 */
function leases(dbPath: string): Array<LeaseRow & { expired: boolean }> {
  const db = openDb(dbPath);
  try {
    const now = Date.now();
    const rows = db.query("SELECT * FROM lease ORDER BY resource").all() as LeaseRow[];
    return rows.map((r) => ({ ...r, expired: isLeaseExpired(r, now) }));
  } finally {
    db.close();
  }
}

/** Set up a rival's lease in-process, for the same reason: it is the precondition, not the behaviour. */
async function acquireIn(dbPath: string, holder: string, ttlS: number): Promise<boolean> {
  const db = openDb(dbPath);
  try {
    return (await acquireLease(db, "cpu:browser", holder, ttlS)).ok;
  } finally {
    db.close();
  }
}

const held = (db: string) => leases(db).filter((l) => l.resource === "cpu:browser" && !l.expired);

/**
 * A shell command that runs until `stop` exists (OB-2164), so a run lasts as long as its test needs and not
 * a fixed time that a loaded machine's `ob` start-ups can outlast. Bounded at 60 s, the tests' own timeout:
 * a test that fails before writing `stop` SIGKILLs its `ob`, which cannot pass that on to this child.
 */
const untilStop = (stop: string) => `i=0; until [ -e '${stop}' ] || [ $i -ge 600 ]; do sleep 0.1; i=$((i+1)); done`;

describe("lease run: the argument shape", () => {
  test("cpu is a named key class and cpu:browser passes through unchanged", () => {
    expect(leaseKeyClass("cpu:browser")).toBe("cpu");
    expect(normalizeLeaseResource("cpu:browser")).toBe("cpu:browser");
  });

  test("ob lease run with no command exits 2 and takes no lease", () => {
    const db = temp("db.sqlite");
    const r = obSync(db, ["lease", "run", "cpu:browser"]);
    expect(r.code).toBe(2);
    expect(held(db)).toHaveLength(0);
    // Two `ob` start-ups, the first of them cold, as its siblings' 30 s allows for: on bun's 5 s default
    // it was killed mid-spawn under load (OB-2164).
  }, 30_000);

  test("everything after -- is the command's, including flags ob itself knows", () => {
    const db = temp("db.sqlite");
    const r = obSync(db, ["lease", "run", "cpu:browser", "--", "echo", "--on", "a", "b", "--off", "--json"]);
    expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: "--on a b --off --json\n" });
  }, 30_000);
});

describe("lease run: one browser run at a time", () => {
  test("a second run waits on the first, names its holder, and starts only after it exits", async () => {
    const db = temp("db.sqlite");
    const log = temp("order.log");
    writeFileSync(log, "");
    const stop = temp("stop-a");
    // The first run lasts until this test says stop, not a fixed time (OB-2164): under load the checks
    // and the second `ob` start-up below can take longer than any sleep, and the first would end first.
    const script = (name: string, wait: string) => `echo start-${name} >> ${log}; ${wait}; echo end-${name} >> ${log}`;
    // Default holders: two runs from one checkout must still be two holders (`<branch>:<pid>@<host>`).
    const first = obStart(db, ["lease", "run", "cpu:browser", "--", "sh", "-c", script("a", untilStop(stop))]);
    expect(await until(() => held(db).length === 1, 15_000)).toBe(true);
    const firstHolder = held(db)[0]!.holder;
    expect(firstHolder).toMatch(/^.+:\d+@.+$/);
    const second = obStart(db, ["lease", "run", "cpu:browser", "--", "sh", "-c", script("b", "sleep 1")]);
    expect(await until(() => second.seen.err.includes(`waiting for cpu:browser, held by ${firstHolder}`), 15_000)).toBe(true);
    // While the first runs, the second has not started.
    expect(readFileSync(log, "utf8")).not.toContain("start-b");

    writeFileSync(stop, "");
    expect(await first.done()).toBe(0);
    expect(await second.done()).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start-a", "end-a", "start-b", "end-b"]);
    expect(held(db)).toHaveLength(0);
  }, 60_000);
});

describe("lease run: always releases", () => {
  test("a normal exit passes the child's stdout and code through and frees the slot", () => {
    const db = temp("db.sqlite");
    const r = obSync(db, ["lease", "run", "cpu:browser", "--", "sh", "-c", "echo hello"]);
    expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: "hello\n" });
    expect(held(db)).toHaveLength(0);
  }, 30_000);

  test("a failing command passes its own exit code through and frees the slot", () => {
    const db = temp("db.sqlite");
    const r = obSync(db, ["lease", "run", "cpu:browser", "--", "sh", "-c", "exit 7"]);
    expect(r.code).toBe(7);
    expect(held(db)).toHaveLength(0);
  }, 30_000);

  test("a child killed by a signal exits 128 + that signal and frees the slot", () => {
    const db = temp("db.sqlite");
    const r = obSync(db, ["lease", "run", "cpu:browser", "--", "sh", "-c", "kill -9 $$"]);
    expect(r.code).toBe(137);
    expect(held(db)).toHaveLength(0);
  }, 30_000);

  test("a nested lease run for a resource its parent holds runs at once instead of queueing behind it", () => {
    const db = temp("db.sqlite");
    const inner = `bun run ${INDEX} lease run cpu:browser -- echo inner`;
    const r = obSync(db, ["lease", "run", "cpu:browser", "--", "sh", "-c", inner]);
    expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: "inner\n" });
    expect(r.err).toContain("already held by the enclosing lease run");
    expect(held(db)).toHaveLength(0);
  }, 60_000);

  test("a nested run still forwards SIGTERM to its command and waits for it", async () => {
    const db = temp("db.sqlite");
    const log = temp("child.log");
    writeFileSync(log, "");
    const child =
      `process.on("SIGTERM", () => { require("fs").appendFileSync(${JSON.stringify(log)}, "got-SIGTERM\\n"); process.exit(0); });` +
      `require("fs").appendFileSync(${JSON.stringify(log)}, "ready\\n"); setInterval(() => {}, 1000);`;
    const run = obStart(db, ["lease", "run", "cpu:browser", "--", "bun", "-e", child], { OB_LEASE_RUN_HELD: "cpu:browser" });
    expect(await until(() => existsSync(log) && readFileSync(log, "utf8").includes("ready"), 20_000)).toBe(true);
    run.proc.kill("SIGTERM");
    expect(await run.done()).toBe(143);
    expect(readFileSync(log, "utf8")).toContain("got-SIGTERM");
  }, 60_000);

  test("a command that cannot start exits 127 and frees the slot", () => {
    const db = temp("db.sqlite");
    const r = obSync(db, ["lease", "run", "cpu:browser", "--", "no-such-binary-ob-2071"]);
    expect(r.code).toBe(127);
    expect(held(db)).toHaveLength(0);
  }, 30_000);

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    test(`${signal} to ob reaches the child, ob exits ${code}, and the slot is freed`, async () => {
      const db = temp("db.sqlite");
      const log = temp("child.log");
      writeFileSync(log, "");
      const child =
        `process.on("${signal}", () => { require("fs").appendFileSync(${JSON.stringify(log)}, "got-${signal}\\n"); process.exit(0); });` +
        `require("fs").appendFileSync(${JSON.stringify(log)}, "ready\\n"); setInterval(() => {}, 1000);`;
      const run = obStart(db, ["lease", "run", "cpu:browser", "--", "bun", "-e", child]);
      expect(await until(() => existsSync(log) && readFileSync(log, "utf8").includes("ready"), 20_000)).toBe(true);
      expect(held(db)).toHaveLength(1);
      run.proc.kill(signal);
      expect(await run.done()).toBe(code);
      expect(readFileSync(log, "utf8")).toContain(`got-${signal}`);
      expect(held(db)).toHaveLength(0);
    }, 60_000);
  }

  test("Ctrl-C while waiting exits 130, never starts the command, and leaves the other holder's lease alone", async () => {
    const db = temp("db.sqlite");
    const marker = temp("started");
    expect(await acquireIn(db, "someone-else", 120)).toBe(true);
    const run = obStart(db, ["lease", "run", "cpu:browser", "--", "touch", marker]);
    expect(await until(() => run.seen.err.includes("held by someone-else"), 15_000)).toBe(true);
    run.proc.kill("SIGINT");
    expect(await run.done()).toBe(130);
    expect(existsSync(marker)).toBe(false);
    expect(held(db).map((l) => l.holder)).toEqual(["someone-else"]);
  }, 60_000);
});

describe("lease run: a long run keeps its lease", () => {
  test("a run longer than the TTL is not reclaimable while it is running", async () => {
    const db = temp("db.sqlite");
    const stop = temp("stop");
    // ttl 2s, heartbeat every ttl/5. The command runs until this test says stop, not for a fixed time
    // (OB-2164): every check below is an `ob` process whose start-up grows without bound under load, and
    // a `sleep 5` command once ended, and rightly released its lease, before the check after it ran.
    const run = obStart(db, ["lease", "run", "cpu:browser", "--ttl", "2", "--", "sh", "-c", untilStop(stop)]);
    expect(await until(() => held(db).length === 1, 15_000)).toBe(true);
    await Bun.sleep(3_500);
    const rows = leases(db).filter((l) => l.resource === "cpu:browser");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expired).toBe(false);
    // And a rival cannot take it meanwhile.
    expect(await acquireIn(db, "rival", 5)).toBe(false);
    writeFileSync(stop, "");
    expect(await run.done()).toBe(0);
    expect(held(db)).toHaveLength(0);
  }, 60_000);
});

// OB-2157: a deploy restart of omnislash-web refuses connections for a few seconds. A waiting or starting
// run treats that as "not yet" and never runs its command without the lease; a holder that lost its lease
// keeps going and says so once; a release that hits the outage is retried. Driven through a fake `io`.
describe("lease run: an unreachable ob API is waited out (OB-2157)", () => {
  const unreachable = () => new ApiError("could not reach the ob API at http://127.0.0.1:1: Unable to connect", 0, { unreachable: true });
  const timedOut = () => new ApiError("the ob API at http://127.0.0.1:1 did not answer POST /leases within 5ms (timed out, not unreachable)", 0);

  function runCounter() {
    const file = temp("runs.log");
    writeFileSync(file, "");
    return { command: ["sh", "-c", `echo RAN >> ${file}`], runs: () => readFileSync(file, "utf8").split("\n").filter(Boolean).length };
  }

  function fastOpts(io: LeaseRunIo, command: string[], log: string[], extra: Partial<LeaseRunOptions> = {}): LeaseRunOptions {
    return { resource: "probe:x", holder: "p", command, io, heartbeatMs: 60_000, log: (l) => log.push(l), pollMs: 5, releaseWindowMs: 50, releaseRetryMs: 5, ...extra };
  }

  test("unreachable twice, denied once, then granted: the command runs once, after the grant", async () => {
    const { command, runs } = runCounter();
    const log: string[] = [];
    const answers: Array<Error | { ok: boolean; holder: string }> = [unreachable(), unreachable(), { ok: false, holder: "other" }, { ok: true, holder: "p" }];
    let calls = 0;
    let grantedAt = -1;
    const io: LeaseRunIo = {
      acquire: async () => {
        const a = answers[Math.min(calls++, answers.length - 1)]!;
        if (a instanceof Error) throw a;
        if (a.ok && grantedAt < 0) {
          grantedAt = calls;
          expect(runs()).toBe(0);
        }
        return a;
      },
      release: async () => true,
    };
    const code = await runUnderLease(fastOpts(io, command, log));
    expect(code).toBe(0);
    expect(runs()).toBe(1);
    expect(grantedAt).toBe(4);
    expect(log.filter((l) => l === "ob API unreachable, still waiting for probe:x")).toHaveLength(1);
    expect(log.filter((l) => l === "ob API back")).toHaveLength(1);
    expect(log).toContain("waiting for probe:x, held by other");
  });

  test("a call timeout (status 0, not unreachable) also counts as not granted yet", async () => {
    const { command, runs } = runCounter();
    const log: string[] = [];
    let calls = 0;
    const io: LeaseRunIo = {
      acquire: async () => {
        if (calls++ === 0) throw timedOut();
        return { ok: true, holder: "p" };
      },
      release: async () => true,
    };
    expect(await runUnderLease(fastOpts(io, command, log))).toBe(0);
    expect(runs()).toBe(1);
    expect(log).toContain("ob API unreachable, still waiting for probe:x");
  });

  test("an HTTP 500 ends the run with exit 1 and never runs the command, as before", async () => {
    const { command, runs } = runCounter();
    const io: LeaseRunIo = {
      acquire: async () => {
        throw new ApiError("the ob API answered 500", 500);
      },
      release: async () => true,
    };
    await expect(runUnderLease(fastOpts(io, command, []))).rejects.toThrow("answered 500");
    expect(runs()).toBe(0);
  });

  test("a release unreachable until the window ends keeps the child's code and says it could not release", async () => {
    const log: string[] = [];
    let releases = 0;
    const io: LeaseRunIo = {
      acquire: async () => ({ ok: true, holder: "p" }),
      release: async () => {
        releases++;
        throw unreachable();
      },
    };
    expect(await runUnderLease(fastOpts(io, ["sh", "-c", "exit 7"], log))).toBe(7);
    expect(releases).toBeGreaterThan(1);
    expect(log).toEqual(["could not release probe:x: ob API unreachable; it frees when its TTL lapses"]);
  });

  test("a release that fails once and then succeeds prints nothing extra", async () => {
    const log: string[] = [];
    let releases = 0;
    const io: LeaseRunIo = {
      acquire: async () => ({ ok: true, holder: "p" }),
      release: async () => {
        if (releases++ === 0) throw unreachable();
        return true;
      },
    };
    expect(await runUnderLease(fastOpts(io, ["true"], log))).toBe(0);
    expect(releases).toBe(2);
    expect(log).toEqual([]);
  });

  test("a holder whose lease was taken says LOST once, runs to its end, and the release leaves the other's lease", async () => {
    // A real lease table: our row lapses during the "outage", another holder takes it, and the beats see it.
    const db = openDb(temp("db.sqlite"));
    const log: string[] = [];
    const out = temp("ran.log");
    let beats = 0;
    const io: LeaseRunIo = {
      acquire: async () => {
        if (beats++ === 1) {
          // between the grant and the first beat: our row lapsed and q took it
          db.query("UPDATE lease SET heartbeat_at = ? WHERE resource = 'probe:x'").run(new Date(Date.now() - 3_600_000).toISOString());
          expect((await acquireLease(db, "probe:x", "q", 300)).ok).toBe(true);
        }
        return acquireLease(db, "probe:x", "p", 300);
      },
      release: () => releaseLease(db, "probe:x", "p"),
    };
    const code = await runUnderLease(fastOpts(io, ["sh", "-c", `sleep 0.4; echo done > ${out}`], log, { heartbeatMs: 50 }));
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("done\n");
    expect(beats).toBeGreaterThan(2);
    expect(log.filter((l) => l.startsWith("LOST "))).toEqual(["LOST probe:x: now held by q; this run is no longer protected by the lease"]);
    const rows = await leaseStatus(db);
    expect(rows.map((r) => r.holder)).toEqual(["q"]);
  });
});

describe("lease run: a heartbeat during an outage (OB-2157)", () => {
  test("says it will retry, without the 'could not reach' text a run that never ran printed", async () => {
    const log: string[] = [];
    let calls = 0;
    const io: LeaseRunIo = {
      acquire: async () => {
        if (calls++ === 0) return { ok: true, holder: "p" };
        throw new ApiError("could not reach the ob API at http://127.0.0.1:1: refused", 0, { unreachable: true });
      },
      release: async () => true,
    };
    const code = await runUnderLease({ resource: "probe:x", holder: "p", command: ["sleep", "0.3"], io, heartbeatMs: 50, log: (l) => log.push(l), pollMs: 5 });
    expect(code).toBe(0);
    expect(log.length).toBeGreaterThan(0);
    expect(new Set(log)).toEqual(new Set(["could not refresh probe:x: ob API unreachable, will retry"]));
  });
});

describe("lease run: a signalled run does not linger on an unreachable release (OB-2157)", () => {
  test("SIGTERM with the API down tries the release once and exits 143", async () => {
    const log: string[] = [];
    let releases = 0;
    const io: LeaseRunIo = {
      acquire: async () => {
        // the grant: deliver SIGTERM to this run's handlers once the command has started
        setTimeout(() => process.emit("SIGTERM" as never), 100);
        return { ok: true, holder: "p" };
      },
      release: async () => {
        releases++;
        throw new ApiError("could not reach the ob API", 0, { unreachable: true });
      },
    };
    const started = Date.now();
    const code = await runUnderLease({ resource: "probe:x", holder: "p", command: ["sleep", "5"], io, heartbeatMs: 60_000, log: (l) => log.push(l), pollMs: 5, releaseWindowMs: 10_000, releaseRetryMs: 5 });
    expect(code).toBe(143);
    expect(releases).toBe(1);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(log).toEqual(["could not release probe:x: ob API unreachable; it frees when its TTL lapses"]);
  });
});

// OB-2229: a leased run is stopped at a cap (10 minutes on a `cpu:` key), so one long browser run cannot
// block the queue. The cap counts from the grant; a nested run starts no timer of its own.
describe("lease run: the cap (OB-2229)", () => {
  function capIo() {
    const calls = { releases: 0 };
    const io: LeaseRunIo = { acquire: async () => ({ ok: true, holder: "p" }), release: async () => (calls.releases++, true) };
    return { io, calls };
  }
  const base = (io: LeaseRunIo, command: string[], log: string[], extra: Partial<LeaseRunOptions> = {}): LeaseRunOptions => ({
    resource: "cpu:browser", holder: "p", command, io, heartbeatMs: 60_000, log: (l) => log.push(l), pollMs: 5, ...extra,
  });

  test("a cpu: key defaults to 600 s; another key has no cap unless --max sets one", () => {
    expect(LEASE_RUN_CPU_CAP_S).toBe(600);
    expect(leaseRunCap("cpu:browser", undefined)).toBe(600);
    expect(leaseRunCap("probe:x", undefined)).toBeNull();
    expect(leaseRunCap("probe:x", "3600")).toBe(3600);
    expect(leaseRunCap("cpu:browser", "60")).toBe(60);
    expect(() => leaseRunCap("probe:x", "2147484")).toThrow("--max");
    for (const bad of ["900", "0", "-5", "1.5", "ten", ""]) expect(() => leaseRunCap("cpu:browser", bad)).toThrow("--max");
  });

  test("a command still running at the cap is stopped, the lease released, and the run exits 124", async () => {
    const { io, calls } = capIo();
    const log: string[] = [];
    const t0 = Date.now();
    const code = await runUnderLease(base(io, ["sleep", "30"], log, { capS: 0.3 }));
    expect(code).toBe(LEASE_RUN_CAP_EXIT);
    expect(code).toBe(124);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(calls.releases).toBe(1);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^stopped at the 0\.3 second cap on cpu:browser \(ran [\d.]+s\); split the run into parts that each finish inside 0\.3 seconds and lease each part$/);
  });

  test("the time spent waiting for the lease does not count towards the cap", async () => {
    const log: string[] = [];
    const t0 = Date.now();
    const io: LeaseRunIo = {
      // denied for 1.5 s, longer than the 1 s cap, then granted
      acquire: async () => (Date.now() - t0 < 1_500 ? { ok: false, holder: "other" } : { ok: true, holder: "p" }),
      release: async () => true,
    };
    const code = await runUnderLease(base(io, ["sleep", "0.3"], log, { capS: 1 }));
    expect(code).toBe(0);
    expect(log.some((l) => l.startsWith("stopped at"))).toBe(false);
  });

  test("a nested run under OB_LEASE_RUN_HELD starts no cap timer of its own", async () => {
    const before = process.env.OB_LEASE_RUN_HELD;
    process.env.OB_LEASE_RUN_HELD = "cpu:browser";
    try {
      const { io } = capIo();
      const log: string[] = [];
      expect(await runUnderLease(base(io, ["sleep", "0.5"], log, { capS: 0.1 }))).toBe(0);
      expect(log.some((l) => l.startsWith("stopped at"))).toBe(false);
    } finally {
      if (before === undefined) delete process.env.OB_LEASE_RUN_HELD;
      else process.env.OB_LEASE_RUN_HELD = before;
    }
  });

  test("--max above the cap, 0 or a fraction is a usage error with nothing acquired; --max 60 is accepted", () => {
    const db = temp("db.sqlite");
    for (const max of ["900", "0", "1.5"]) {
      const r = obSync(db, ["lease", "run", "--max", max, "cpu:browser", "--", "true"]);
      expect({ max, code: r.code }).toEqual({ max, code: 2 });
      expect(r.err).toContain("--max");
      expect(leases(db)).toHaveLength(0);
    }
    const ok = obSync(db, ["lease", "run", "--max", "60", "cpu:browser", "--", "echo", "ran"]);
    expect({ code: ok.code, out: ok.out }).toEqual({ code: 0, out: "ran\n" });
    expect(held(db)).toHaveLength(0);
  }, 60_000);
});

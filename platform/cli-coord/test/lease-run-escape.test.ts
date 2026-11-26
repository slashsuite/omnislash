import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { until } from "../../../apps/cli/test/helpers.ts";
import { escapedArgv, rttimeHardLimitFinite, shouldEscape, writeEnvFile } from "../src/lease-run.ts";

// OB-2161: T3 Code runs with RLIMIT_RTTIME at 0/0 and every agent shell inherits it; at 0 the kernel
// SIGKILLs a process that arms a per-thread CPU-time timer, which browsers do, so local Playwright runs
// lost browsers. `ob lease run` starts its command as a transient user service, which the user manager
// starts with its own (unlimited) limits. These tests run the real `ob` against a temp database.

const INDEX = join(import.meta.dir, "../../../apps/cli/src/index.ts");
const TIMER = join(import.meta.dir, "fixtures/rttime-timer.py");
const temps: string[] = [];
const running: Array<ReturnType<typeof Bun.spawn>> = [];

function temp(name: string): string {
  const p = join(tmpdir(), `ob-lease-escape-${randomUUID()}-${name}`);
  temps.push(p);
  return p;
}

function envFor(dbPath: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    OMNISLASH_DB: dbPath,
    OMNISLASH_API: "",
    OB_LEASE_RUN_HELD: "",
    OMNISLASH_API_URL_FILE: join(tmpdir(), `ob-no-api-url-${randomUUID()}`),
    ...extra,
  };
}

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

const sh = (cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, signal: r.signalCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

/** A user manager this test process can start services under; without one the escape cannot happen. */
const userManager = !!Bun.which("systemd-run") && sh(["systemd-run", "--user", "--wait", "--quiet", "--collect", "--", "true"]).code === 0;
/**
 * The kernel kills the bare fixture only at a hard RLIMIT_RTTIME of 0: a non-realtime thread never accrues
 * realtime time, so a finite non-zero limit (T3 shells now set 200000 us) never fires, and an unlimited one
 * never does either. So the fixture test does not depend on the shell's limit: it lowers the hard limit to 0
 * itself with prlimit (lowering needs no privilege), for the bare run and for `ob lease run` alike (OS-208).
 */
const ZERO_RTTIME = ["prlimit", "--rttime=0:0", "--"];
const SKIP_NO_MANAGER = "no systemd user manager here (systemd-run --user failed or is missing)";

function ob(db: string, args: string[], extra: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bun", "run", INDEX, ...args], { env: envFor(db, extra), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** `OB_LEASE_RUN_ESCAPE=1`: the escape runs wherever a user manager exists, limited shell or not. */
const escaped = (db: string, command: string[], extra: Record<string, string> = {}) =>
  ob(db, ["lease", "run", "probe:escape", "--", ...command], { OB_LEASE_RUN_ESCAPE: "1", ...extra });

/** Spawned directly (no setsid wrapper), so `proc.pid` is ob's own pid, the one in its unit names. */
function obStart(db: string, args: string[], extra: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", INDEX, ...args], { env: envFor(db, extra), stdout: "pipe", stderr: "pipe", detached: true });
  running.push(proc);
  return proc;
}

function units(obPid: number): string[] {
  const r = sh(["systemctl", "--user", "list-units", `ob-lease-run-${obPid}-*`, "--all", "--plain", "--no-legend"]);
  return r.out.split("\n").map((l) => l.trim().split(/\s+/)[0]!).filter(Boolean);
}

function heldProbe(db: string): number {
  const r = ob(db, ["lease", "status", "--json"]);
  const rows = JSON.parse(r.out) as Array<{ resource: string; expired: boolean }>;
  return rows.filter((l) => l.resource === "probe:escape" && !l.expired).length;
}

describe("lease run escape: when it applies", () => {
  test("reads the hard RLIMIT_RTTIME from /proc/self/limits", () => {
    const row = (soft: string, hard: string) => `Max realtime priority     0   0\nMax realtime timeout      ${soft}   ${hard}   us\n`;
    expect(rttimeHardLimitFinite(row("0", "0"))).toBe(true);
    expect(rttimeHardLimitFinite(row("unlimited", "200000"))).toBe(true);
    expect(rttimeHardLimitFinite(row("unlimited", "unlimited"))).toBe(false);
    expect(rttimeHardLimitFinite("Limit Soft Limit Hard Limit Units\n")).toBe(false);
  });

  test("an unlimited hard limit, or OB_LEASE_RUN_ESCAPE=0, spawns the command as a plain child", () => {
    const unlimited = "Max realtime timeout      unlimited  unlimited  us\n";
    const zero = "Max realtime timeout      0  0  us\n";
    expect(shouldEscape({}, unlimited)).toBe(false);
    expect(shouldEscape({ OB_LEASE_RUN_ESCAPE: "0" }, zero)).toBe(false);
    if (Bun.which("systemd-run")) expect(shouldEscape({}, zero)).toBe(true);
  });

  test.skipIf(!userManager)("OB_LEASE_RUN_ESCAPE=0 runs in ob's own cgroup, not an ob-lease-run unit", () => {
    const db = temp("db.sqlite");
    const off = ob(db, ["lease", "run", "probe:escape", "--", "cat", "/proc/self/cgroup"], { OB_LEASE_RUN_ESCAPE: "0" });
    expect(off.code).toBe(0);
    expect(off.out).not.toContain("ob-lease-run-");
    const on = escaped(db, ["cat", "/proc/self/cgroup"]);
    expect(on.out).toContain("ob-lease-run-");
  }, 30_000);

  test("the unit carries RuntimeMaxSec equal to the cap, and none without one (OB-2229)", () => {
    const argv = escapedArgv("ob-lease-run-1-ab", "/run/x.env.json", ["true"], 600);
    expect(argv).toContain("--property=RuntimeMaxSec=600");
    expect(argv.indexOf("--property=RuntimeMaxSec=600")).toBeLessThan(argv.indexOf("--"));
    expect(argv.slice(-2)).toEqual(["--", "true"]);
    expect(escapedArgv("ob-lease-run-1-ab", "/run/x.env.json", ["true"], null).some((a) => a.startsWith("--property=RuntimeMaxSec"))).toBe(false);
  });

  test("the env file is owner-only", () => {
    const f = writeEnvFile(`ob-lease-run-test-${randomUUID()}`, { A: "1" });
    temps.push(f);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ A: "1" });
  });
});

describe.skipIf(!userManager)("lease run escape: the command runs as a user service", () => {
  test("its hard RTTIME limit reads unlimited", () => {
    const r = escaped(temp("db.sqlite"), ["grep", "realtime timeout", "/proc/self/limits"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Max realtime timeout\s+unlimited\s+unlimited/);
  }, 30_000);

  test("under a hard RTTIME limit of 0 the timer_create fixture is SIGKILLed bare, and survives `ob lease run`", () => {
    const bare = sh([...ZERO_RTTIME, "python3", TIMER]);
    // Killed by the kernel before its first hit: exit 137 in a shell.
    expect(bare.signal).toBe("SIGKILL");
    // ob itself starts under the 0 limit, as it did in a T3 shell at 0/0, and decides to escape on its own
    // (no OB_LEASE_RUN_ESCAPE): the command it starts must not inherit the limit.
    const db = temp("db.sqlite");
    const r = Bun.spawnSync([...ZERO_RTTIME, "bun", "run", INDEX, "lease", "run", "probe:escape", "--", "python3", TIMER], {
      env: envFor(db),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ code: r.exitCode, out: r.stdout.toString() }).toMatchObject({ code: 0 });
    expect(r.stdout.toString()).toMatch(/^timer hits: [1-9]\d*\n$/);
  }, 30_000);

  test("exit code, stdout, stderr and the caller's cwd and environment pass through", () => {
    const r = escaped(temp("db.sqlite"), ["sh", "-c", 'echo "out $OB2161_PROBE $$-ok"; pwd; echo err >&2; exit 3'], { OB2161_PROBE: "carried" });
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/^out carried \d+-ok\n/);
    expect(r.out.split("\n")[1]).toBe(process.cwd());
    expect(r.err).toBe("err\n");
  }, 30_000);

  test("a command killed by SIGTERM gives 143, by SIGKILL 137", () => {
    const db = temp("db.sqlite");
    expect(escaped(db, ["sh", "-c", "kill -TERM $$"]).code).toBe(143);
    expect(escaped(db, ["sh", "-c", "kill -KILL $$"]).code).toBe(137);
  }, 30_000);

  test("the command is found on the caller's PATH, not the user manager's", () => {
    const bin = temp("bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    writeFileSync(join(bin, "ob2161-only-here"), "#!/bin/sh\necho found-on-caller-path\n", { mode: 0o755 });
    const r = escaped(temp("db.sqlite"), ["ob2161-only-here"], { PATH: `${bin}:${process.env.PATH}` });
    rmSync(bin, { recursive: true, force: true });
    expect({ code: r.code, out: r.out }).toEqual({ code: 0, out: "found-on-caller-path\n" });
  }, 30_000);

  test("a command that cannot start exits 127", () => {
    const r = escaped(temp("db.sqlite"), ["no-such-binary-ob-2161"]);
    expect(r.code).toBe(127);
    expect(r.err).toContain("cannot run 'no-such-binary-ob-2161'");
  }, 30_000);

  test("the env file is gone while the command runs, and the unit's properties never hold its values", async () => {
    const db = temp("db.sqlite");
    const ready = temp("ready");
    const secret = `ob2161-secret-${randomUUID()}`;
    const proc = obStart(db, ["lease", "run", "probe:escape", "--", "sh", "-c", `touch ${ready}; sleep 30`], { OB_LEASE_RUN_ESCAPE: "1", OB2161_SECRET: secret });
    expect(await until(() => existsSync(ready), 20_000)).toBe(true);
    const [unit] = units(proc.pid);
    expect(unit).toBeDefined();
    const runtime = process.env.XDG_RUNTIME_DIR || tmpdir();
    expect(existsSync(join(runtime, `${unit}.env.json`))).toBe(false);
    const shown = sh(["systemctl", "--user", "show", unit!]);
    expect(shown.code).toBe(0);
    expect(shown.out).not.toContain(secret);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
  }, 60_000);

  for (const [signal, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const) {
    test(`${signal} to ob reaches the command, leaves no unit behind and frees the lease`, async () => {
      const db = temp("db.sqlite");
      const log = temp("child.log");
      writeFileSync(log, "");
      const child =
        `process.on("${signal}", () => { require("fs").appendFileSync(${JSON.stringify(log)}, "got-${signal}\\n"); process.exit(0); });` +
        `require("fs").appendFileSync(${JSON.stringify(log)}, "ready\\n"); setInterval(() => {}, 1000);`;
      const proc = obStart(db, ["lease", "run", "probe:escape", "--", "bun", "-e", child], { OB_LEASE_RUN_ESCAPE: "1" });
      expect(await until(() => readFileSync(log, "utf8").includes("ready"), 20_000)).toBe(true);
      expect(units(proc.pid)).toHaveLength(1);
      expect(heldProbe(db)).toBe(1);
      proc.kill(signal);
      expect(await proc.exited).toBe(code);
      expect(readFileSync(log, "utf8")).toContain(`got-${signal}`);
      expect(await until(() => units(proc.pid).length === 0, 10_000)).toBe(true);
      expect(heldProbe(db)).toBe(0);
    }, 60_000);
  }

  test("a command that ignores SIGTERM is stopped on a second signal", async () => {
    const db = temp("db.sqlite");
    const ready = temp("ready");
    const proc = obStart(db, ["lease", "run", "probe:escape", "--", "sh", "-c", `trap '' TERM; touch ${ready}; while :; do sleep 0.2; done`], { OB_LEASE_RUN_ESCAPE: "1" });
    expect(await until(() => existsSync(ready), 20_000)).toBe(true);
    proc.kill("SIGTERM");
    await Bun.sleep(500);
    expect(units(proc.pid)).toHaveLength(1);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(143);
    expect(await until(() => units(proc.pid).length === 0, 15_000)).toBe(true);
    expect(heldProbe(db)).toBe(0);
  }, 60_000);

  test("a command still running at the cap is stopped, leaves no unit, frees the lease and exits 124 (OB-2229)", async () => {
    const db = temp("db.sqlite");
    const ready = temp("ready");
    const proc = obStart(db, ["lease", "run", "--max", "8", "probe:escape", "--", "sh", "-c", `touch ${ready}; sleep 60`], { OB_LEASE_RUN_ESCAPE: "1" });
    expect(await until(() => existsSync(ready), 20_000)).toBe(true);
    expect(units(proc.pid)).toHaveLength(1);
    expect(await proc.exited).toBe(124);
    const err = await new Response(proc.stderr as ReadableStream).text();
    expect(err).toContain("stopped at the 8 second cap on probe:escape");
    expect(await until(() => units(proc.pid).length === 0, 15_000)).toBe(true);
    expect(heldProbe(db)).toBe(0);
  }, 60_000);
});

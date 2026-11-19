import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cmdDaemon,
  macDaemonJobs,
  RETIRED_CLIENT_JOBS,
  renderSystemdUserService,
  renderSystemdUserTimer,
  systemdUserDir,
  systemdUserUnit,
  type DaemonJob,
  type DaemonSpawn,
} from "../src/commands/coord.ts";

const homes: string[] = [];

function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ob-daemon-home-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function recordingSpawn(ok = true): { calls: string[][]; spawn: DaemonSpawn } {
  const calls: string[][] = [];
  return {
    calls,
    spawn: (cmd) => {
      calls.push([...cmd]);
      return { ok, stdout: ok ? "enabled" : "", stderr: ok ? "" : "failed" };
    },
  };
}

function captureJson(fn: () => void): { action: string; jobs: Array<Record<string, unknown>> } {
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => {
    chunks.push(String(m ?? ""));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return JSON.parse(chunks.join("\n")) as { action: string; jobs: Array<Record<string, unknown>> };
}

/** A synthetic client job: the renderers stay generic, whatever the real client jobs are. */
function probeJob(home: string): DaemonJob {
  return {
    job: "probe",
    label: "com.omnislash.probe",
    args: [join(home, ".local", "bin", "ob"), "probe", "run"],
    opts: { logPath: join(home, "probe.log"), interval: 45, envHome: home, envPath: "/usr/bin" },
  };
}

describe("render systemd --user units (664)", () => {
  test("service is oneshot with HOME+PATH", () => {
    const unit = renderSystemdUserService(probeJob("/home/u"));
    expect(unit).toContain("[Service]");
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("ExecStart=/home/u/.local/bin/ob probe run");
    expect(unit).toContain('Environment="HOME=/home/u"');
    expect(unit).toContain("SyslogIdentifier=omnislash-probe");
    expect(unit).not.toContain("LaunchAgents");
  });

  test("timer is every interval with AccuracySec under the 1min default", () => {
    const timer = renderSystemdUserTimer(probeJob("/home/u"));
    expect(systemdUserUnit("probe")).toBe("omnislash-probe");
    expect(timer).toContain("OnUnitActiveSec=45s");
    expect(timer).toContain("AccuracySec=5s");
    expect(timer).toContain("Unit=omnislash-probe.service");
  });
});

/** A spinoff-drain unit left by a pre-1589 `ob daemon install`. */
function seedRetiredLinux(home: string): { service: string; timer: string } {
  const dir = systemdUserDir(home);
  mkdirSync(dir, { recursive: true });
  const service = join(dir, "omnislash-spinoff-drain.service");
  const timer = join(dir, "omnislash-spinoff-drain.timer");
  writeFileSync(service, "[Service]\n");
  writeFileSync(timer, "[Timer]\n");
  return { service, timer };
}

function seedRetiredMac(home: string): string {
  const dir = join(home, "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const plist = join(dir, "com.omnislash.spinoff-drain.plist");
  writeFileSync(plist, "<plist/>");
  return plist;
}

function captureText(fn: () => void): string {
  const chunks: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => {
    chunks.push(String(m ?? ""));
  };
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return chunks.join("\n");
}

const TICK_TIMER = "omnislash-role-tick.timer";

describe("ob daemon on Linux (664, 1589; OS-67: role-tick is the client job)", () => {
  test("the only client job is role-tick: every 900 s, its rendered timer and service run `ob role tick`", () => {
    const jobs = macDaemonJobs("/home/u");
    expect(jobs.map((j) => j.job)).toEqual(["role-tick"]);
    const [tick] = jobs;
    expect(tick!.opts.interval).toBe(900);
    expect(tick!.args).toEqual(["/home/u/.local/bin/ob", "role", "tick"]);
    const service = renderSystemdUserService(tick!);
    expect(service).toContain("Type=oneshot");
    expect(service).toContain("ExecStart=/home/u/.local/bin/ob role tick");
    expect(service).toContain('Environment="HOME=/home/u"');
    const timer = renderSystemdUserTimer(tick!);
    expect(timer).toContain("Unit=omnislash-role-tick.service");
    expect(timer).toContain("OnUnitActiveSec=900s");
    expect(RETIRED_CLIENT_JOBS).toContain("spinoff-drain");
  });

  test("install on a clean HOME writes the role-tick units and enables its timer", () => {
    const home = fakeHome();
    const { calls, spawn } = recordingSpawn();
    const out = captureJson(() =>
      cmdDaemon({ args: ["install"], mode: "json" }, { home, platform: "linux", spawn }),
    );
    const dir = systemdUserDir(home);
    expect(existsSync(join(dir, "omnislash-role-tick.service"))).toBe(true);
    expect(existsSync(join(dir, TICK_TIMER))).toBe(true);
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", TICK_TIMER],
    ]);
    expect(out.jobs.map((j) => j.unit)).toEqual([TICK_TIMER]);
    expect((out as unknown as { retired_removed: string[] }).retired_removed).toEqual([]);
  });

  test("install names the role-tick timer and its command", () => {
    const home = fakeHome();
    const text = captureText(() =>
      cmdDaemon({ args: ["install"], mode: "human" }, { home, platform: "linux", spawn: recordingSpawn().spawn }),
    );
    expect(text).toContain("installed 1 systemd --user units:");
    expect(text).toContain(`${TICK_TIMER} → role tick`);
  });

  test("install removes a leftover spinoff-drain unit", () => {
    const home = fakeHome();
    const { service, timer } = seedRetiredLinux(home);
    const { calls, spawn } = recordingSpawn();
    const out = captureJson(() =>
      cmdDaemon({ args: ["install"], mode: "json" }, { home, platform: "linux", spawn }),
    );
    expect(existsSync(service)).toBe(false);
    expect(existsSync(timer)).toBe(false);
    expect(calls.slice(0, 2)).toEqual([
      ["systemctl", "--user", "disable", "--now", "omnislash-spinoff-drain.timer"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect((out as unknown as { retired_removed: string[] }).retired_removed).toEqual([
      "omnislash-spinoff-drain.timer",
    ]);
  });

  test("uninstall removes a leftover spinoff-drain unit too", () => {
    const home = fakeHome();
    const { service, timer } = seedRetiredLinux(home);
    const { calls, spawn } = recordingSpawn();
    const text = captureText(() =>
      cmdDaemon({ args: ["uninstall"], mode: "human" }, { home, platform: "linux", spawn }),
    );
    expect(existsSync(service)).toBe(false);
    expect(existsSync(timer)).toBe(false);
    expect(text).toContain("removed retired unit omnislash-spinoff-drain.timer");
    expect(calls).toContainEqual(["systemctl", "--user", "disable", "--now", TICK_TIMER]);
    expect(calls.flat().join(" ")).not.toContain("launchctl");
  });

  test("status reports the role-tick timer and names a leftover", () => {
    const home = fakeHome();
    seedRetiredLinux(home);
    const { calls, spawn } = recordingSpawn();
    const text = captureText(() =>
      cmdDaemon({ args: ["status"], mode: "human" }, { home, platform: "linux", spawn }),
    );
    expect(text).toContain(`${TICK_TIMER}\tabsent\tloaded\tevery 900s\trole tick`);
    expect(text).toContain("retired unit still installed: omnislash-spinoff-drain.timer");
    expect(calls).toEqual([["systemctl", "--user", "is-enabled", TICK_TIMER]]);
  });
});

describe("ob daemon on Mac stays launchd (664, 1589; OS-67: role-tick)", () => {
  test("install on a clean HOME writes the role-tick LaunchAgent and loads it", () => {
    const home = fakeHome();
    const { calls, spawn } = recordingSpawn();
    const out = captureJson(() =>
      cmdDaemon({ args: ["install"], mode: "json" }, { home, platform: "darwin", spawn }),
    );
    const plist = join(home, "Library", "LaunchAgents", "com.omnislash.role-tick.plist");
    expect(existsSync(plist)).toBe(true);
    expect(existsSync(systemdUserDir(home))).toBe(false);
    expect(calls).toEqual([
      ["launchctl", "unload", plist],
      ["launchctl", "load", "-w", plist],
    ]);
    expect(out.jobs.map((j) => j.job)).toEqual(["role-tick"]);
  });

  test("install and uninstall remove a leftover com.omnislash.spinoff-drain", () => {
    for (const sub of ["install", "uninstall"]) {
      const home = fakeHome();
      const plist = seedRetiredMac(home);
      const { calls, spawn } = recordingSpawn();
      const out = captureJson(() =>
        cmdDaemon({ args: [sub], mode: "json" }, { home, platform: "darwin", spawn }),
      );
      expect(existsSync(plist), sub).toBe(false);
      expect(calls[0], sub).toEqual(["launchctl", "unload", "-w", plist]);
      expect(calls.flat().join(" "), sub).not.toContain("systemctl");
      expect((out as unknown as { retired_removed: string[] }).retired_removed, sub).toEqual([plist]);
    }
  });

  test("status lists role-tick and names a leftover plist", () => {
    const home = fakeHome();
    const plist = seedRetiredMac(home);
    const out = captureJson(() =>
      cmdDaemon({ args: ["status"], mode: "json" }, { home, platform: "darwin", spawn: recordingSpawn().spawn }),
    );
    expect(out.jobs.map((j) => j.job)).toEqual(["role-tick"]);
    expect((out as unknown as { retired_leftover: string[] }).retired_leftover).toEqual([plist]);
  });
});

describe("ob daemon unknown platform", () => {
  test("refuses rather than writing either host", () => {
    const home = fakeHome();
    expect(() =>
      cmdDaemon(
        { args: ["install"], mode: "json" },
        { home, platform: "win32", spawn: () => ({ ok: true, stdout: "", stderr: "" }) },
      ),
    ).toThrow(/launchd on macOS or systemd --user on Linux/);
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(existsSync(systemdUserDir(home))).toBe(false);
  });
});

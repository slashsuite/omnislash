import { describe, expect, test } from "bun:test";
import { cmdDaemon, daemonJobs, macDaemonJobs, renderPlist } from "../src/commands/coord.ts";

describe("renderPlist", () => {
  test("bakes PATH into EnvironmentVariables so launchd finds bun + shelled-out tools", () => {
    const p = renderPlist("com.omnislash.spinoff-drain", ["/u/.local/bin/ob", "spinoff", "drain"], {
      logPath: "/u/log.log",
      interval: 45,
      envPath: "/mise/bun/bin:/usr/bin:/bin",
    });
    expect(p).toContain("<key>EnvironmentVariables</key>");
    expect(p).toContain("<key>PATH</key>");
    expect(p).toContain("<string>/mise/bun/bin:/usr/bin:/bin</string>");
    expect(p).toContain("<string>/u/.local/bin/ob</string>");
    expect(p).toContain("<integer>45</integer>");
  });

  test("bakes HOME into EnvironmentVariables so the ob wrapper finds ~/.cloudflare_warp_ca.pem (601)", () => {
    const p = renderPlist("com.omnislash.spinoff-drain", ["/u/.local/bin/ob", "spinoff", "drain"], {
      logPath: "/u/log.log",
      interval: 45,
      envPath: "/mise/bun/bin:/usr/bin:/bin",
      envHome: "/Users/nobody",
    });
    expect(p).toContain("<key>HOME</key>");
    expect(p).toContain("<string>/Users/nobody</string>");
    expect(p).toContain("<key>PATH</key>");
    expect(p).toContain("<string>/mise/bun/bin:/usr/bin:/bin</string>");
  });

  test("omits EnvironmentVariables when no envPath is given", () => {
    const p = renderPlist("com.omnislash.sync", ["/u/.local/bin/ob", "sync"], {
      logPath: "/u/log.log",
      interval: 3600,
    });
    expect(p).not.toContain("EnvironmentVariables");
  });

  test("xml-escapes special chars in args and env", () => {
    const p = renderPlist("com.omnislash.x", ["/u/ob", "a&b"], { logPath: "/l", envPath: "/p<>&" });
    expect(p).toContain("a&amp;b");
    expect(p).toContain("/p&lt;&gt;&amp;");
  });

  test("KeepAlive renders for a persistent job (no schedule); omitted otherwise", () => {
    // the web dashboard: RunAtLoad + KeepAlive, no interval/calendar → launchd keeps it alive
    const web = renderPlist("com.omnislash.web", ["/u/.local/bin/ob", "web"], {
      logPath: "/u/web.log",
      runAtLoad: true,
      keepAlive: true,
    });
    expect(web).toContain("<key>KeepAlive</key>");
    expect(web).toContain("<key>RunAtLoad</key>\n    <true/>");
    expect(web).not.toContain("StartInterval");
    expect(web).not.toContain("StartCalendarInterval");
    // periodic jobs must NOT get KeepAlive
    const sync = renderPlist("com.omnislash.sync", ["/u/ob", "sync"], { logPath: "/l", interval: 3600 });
    expect(sync).not.toContain("KeepAlive");
  });

  test("weekday renders a weekly StartCalendarInterval (Sun 03:00)", () => {
    const p = renderPlist("com.omnislash.weekly", ["/u/.local/bin/ob", "sync"], {
      logPath: "/u/weekly.log",
      calendar: { hour: 3, minute: 0 },
      weekday: 0,
    });
    expect(p).toContain("<key>StartCalendarInterval</key>");
    expect(p).toContain("<key>Weekday</key>\n      <integer>0</integer>");
    expect(p).toContain("<key>Hour</key>\n      <integer>3</integer>");
    expect(p).not.toContain("StartInterval");
    expect(p).not.toContain("<key>Day</key>"); // weekly, not monthly day-of-month
  });
});

describe("daemonJobs registry (via `ob daemon status`)", () => {
  test("declares the backup job → `ob backup` (server fleet)", () => {
    expect(daemonJobs("/Users/nobody").find((j) => j.job === "backup")!.args.slice(1)).toEqual(["backup"]);
  });

  test("Mac install list is empty since the drain retired (457, 1589)", () => {
    expect(macDaemonJobs("/Users/nobody")).toEqual([]);
    const chunks: string[] = [];
    const orig = console.log;
    console.log = (m?: unknown) => {
      chunks.push(String(m ?? ""));
    };
    try {
      cmdDaemon(
        { args: ["status"], mode: "json" },
        {
          home: "/Users/nobody",
          platform: "darwin",
          spawn: () => ({ ok: true, stdout: "", stderr: "" }),
          existsSync: () => false,
        },
      );
    } finally {
      console.log = orig;
    }
    const jobs = JSON.parse(chunks.join("\n")).jobs as Array<{ job: string }>;
    expect(jobs).toEqual([]);
  });
});

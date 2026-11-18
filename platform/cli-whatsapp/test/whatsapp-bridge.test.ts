import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import {
  bridgeConfig,
  parseBridgePort,
  bridgeSpawnEnv,
  startBridge,
  runBridge,
  stopBridge,
  bridgeStatus,
  bridgeStatusHeadline,
  classifyPortOccupant,
  classifyBridgeLog,
  logIsStale,
  logShowsReconnectLoop,
  readHealthBody,
  samePath,
  realExecPathOf,
  ensureLoopbackNoProxy,
  type BridgeConfig,
  type BridgeDeps,
  type RunHandle,
  type RunOutcome,
} from "../src/whatsapp/bridge.ts";
import { daemonJobs } from "../../../platform/cli-coord/src/commands/coord.ts";
import { computeAlerts } from "../../../apps/cli/src/commands/alerts.ts";
import { jobForInvocation, jobHealth, recordJobAttempt, recordJobResult } from "../../../apps/cli/src/jobs.ts";
import { nowIso } from "../../../apps/cli/src/db.ts";
import { zeroResultNote } from "../src/commands/whatsapp.ts";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { freshPgStore } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";

const PG_BUDGET = spawnBudget(2);

// NO real bridge / binary / network / filesystem: every process + fetch + fs touch is an injected seam.

const CFG: BridgeConfig = {
  bin: "/opt/wa/whatsapp-bridge/whatsapp-bridge",
  cwd: "/opt/wa/whatsapp-bridge",
  port: 8099,
  url: "http://127.0.0.1:8099",
  logPath: "/data/acme/logs/whatsapp-bridge-8099.log",
  pidPath: "/data/acme/whatsapp-bridge-8099.pid",
  legacyLogPath: "/data/acme/logs/whatsapp-bridge.log",
  legacyPidPath: "/data/acme/whatsapp-bridge.pid",
  messagesDbPath: "/opt/wa/whatsapp-bridge/store/messages.db",
  pairingDbPath: "/opt/wa/whatsapp-bridge/store/whatsapp.db",
};

/** Deps where nothing is running and the binary exists — the happy path for start. */
function idleDeps(over: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    binExists: () => true,
    listenerPid: () => null,
    readPidfile: () => null,
    isAlive: () => false,
    execPathOf: () => null,
    realpath: (p) => p,
    readLogTail: () => null,
    // Recency is UNKNOWN unless a test says otherwise: no `stat`, no `ps`, and - the point - never a
    // manufactured "stale" that would silently change a verdict the test did not ask about.
    logMtime: () => null,
    processStartedAt: () => null,
    lastMessageAt: () => null,
    pairedDeviceCount: () => null,
    ...over,
  };
}

describe("parseBridgePort", () => {
  test("reads the explicit port from the bridge url", async () => {
    expect(parseBridgePort("http://127.0.0.1:8099")).toBe(8099);
    expect(parseBridgePort("http://127.0.0.1:8080")).toBe(8080);
  });
  test("falls back to the protocol default when no port is present", async () => {
    expect(parseBridgePort("http://127.0.0.1")).toBe(80);
    expect(parseBridgePort("https://localhost")).toBe(443);
  });
});

describe("bridgeSpawnEnv (180: strip the loopback sandbox proxy so the bridge dials WhatsApp directly)", () => {
  test("drops every proxy var (upper/lower/any *_PROXY) but keeps the rest", async () => {
    const env = bridgeSpawnEnv({
      HTTP_PROXY: "a",
      HTTPS_PROXY: "x",
      ALL_PROXY: "b",
      NO_PROXY: "c",
      http_proxy: "d",
      https_proxy: "y",
      all_proxy: "e",
      no_proxy: "f",
      FOO_PROXY: "z",
      WHATSAPP_BRIDGE_PORT: "8099",
      PATH: "/x",
    });
    expect(Object.keys(env).some((k) => /_PROXY$/i.test(k))).toBe(false);
    expect(env).toEqual({ WHATSAPP_BRIDGE_PORT: "8099", PATH: "/x" });
  });

  test("skips undefined values (process.env holes)", async () => {
    expect(bridgeSpawnEnv({ PATH: "/x", MISSING: undefined })).toEqual({ PATH: "/x" });
  });
});

describe("startBridge", () => {
  test("spawns detached with cwd = the bin dir + env WHATSAPP_BRIDGE_PORT from the url, and writes the pidfile", async () => {
    const spawns: Array<{ cmd: string[]; opts: Record<string, unknown> }> = [];
    const pids: Array<{ path: string; pid: number }> = [];
    const res = startBridge(
      CFG,
      idleDeps({
        spawn: (cmd, opts) => {
          spawns.push({ cmd, opts });
          return 4242;
        },
        writePidfile: (path, pid) => pids.push({ path, pid }),
      }),
    );

    expect(spawns).toHaveLength(1);
    const s = spawns[0]!;
    expect(s.cmd).toEqual([CFG.bin]);
    expect(s.opts.cwd).toBe(CFG.cwd); // cwd = the binary's own dir (needs store/ beside it)
    expect(s.opts.detached).toBe(true);
    const env = s.opts.env as Record<string, string>;
    expect(env.WHATSAPP_BRIDGE_PORT).toBe("8099"); // parsed from whatsapp_bridge_url
    expect(s.opts.logPath).toBe(CFG.logPath);

    expect(pids).toEqual([{ path: CFG.pidPath, pid: 4242 }]);
    expect(res).toMatchObject({ started: true, alreadyRunning: false, pid: 4242, port: 8099 });
  });

  test("strips inherited proxy env from the spawn while keeping WHATSAPP_BRIDGE_PORT (180)", async () => {
    const prev = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "127.0.0.1:58044";
    try {
      let env: Record<string, string> = {};
      startBridge(
        CFG,
        idleDeps({
          spawn: (_cmd, opts) => ((env = opts.env), 4242),
          writePidfile: () => {},
        }),
      );
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(Object.keys(env).some((k) => /_PROXY$/i.test(k))).toBe(false);
      expect(env.WHATSAPP_BRIDGE_PORT).toBe("8099");
    } finally {
      if (prev === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = prev;
    }
  });

  test("missing binary → clean error, never spawns", async () => {
    const spawns: unknown[] = [];
    expect(() =>
      startBridge(CFG, idleDeps({ binExists: () => false, spawn: () => (spawns.push(1), 1) })),
    ).toThrow(/binary not found/);
    expect(spawns).toHaveLength(0);
  });

  test("port held by a foreign process → clean error naming the port, never spawns", async () => {
    const spawns: unknown[] = [];
    expect(() =>
      startBridge(
        CFG,
        idleDeps({ listenerPid: () => 9999, spawn: () => (spawns.push(1), 1) }),
      ),
    ).toThrow(/port 8099 is already in use/);
    expect(spawns).toHaveLength(0);
  });

  test("BUG: our own bridge on the port (stale pidfile, verified by exec path) → alreadyRunning, pidfile adopted, no 'foreign' error", async () => {
    const spawns: unknown[] = [];
    const pids: Array<{ path: string; pid: number }> = [];
    const res = startBridge(
      CFG,
      idleDeps({
        listenerPid: () => 60233,
        readPidfile: () => null,
        execPathOf: () => CFG.bin,
        spawn: () => (spawns.push(1), 1),
        writePidfile: (path, pid) => pids.push({ path, pid }),
      }),
    );
    expect(res).toMatchObject({ alreadyRunning: true, started: false, pid: 60233 });
    expect(pids).toEqual([{ path: CFG.pidPath, pid: 60233 }]);
    expect(spawns).toHaveLength(0);
  });

  test("idempotent: a live pidfile process → alreadyRunning, never spawns", async () => {
    const spawns: unknown[] = [];
    const res = startBridge(
      CFG,
      idleDeps({
        readPidfile: () => 777,
        isAlive: (pid) => pid === 777,
        spawn: () => (spawns.push(1), 1),
      }),
    );
    expect(res).toMatchObject({ alreadyRunning: true, started: false, pid: 777 });
    expect(spawns).toHaveLength(0);
  });
});

describe("classifyPortOccupant (#119 fault A: a pid match is not a foreign pid)", () => {
  test("BUG: our OWN pid from the pidfile must never be classified foreign", async () => {
    const occupant = classifyPortOccupant(
      CFG,
      idleDeps({ listenerPid: () => 60233, readPidfile: () => 60233, isAlive: () => false }),
    );
    expect(occupant.kind).toBe("ours");
    expect(occupant.kind).not.toBe("foreign");
    expect(occupant).toMatchObject({ pid: 60233, evidence: "pidfile" });
  });

  test("a stale/missing pidfile still resolves as ours via the listener's executable path", async () => {
    const occupant = classifyPortOccupant(
      CFG,
      idleDeps({ listenerPid: () => 60233, readPidfile: () => null, execPathOf: () => CFG.bin }),
    );
    expect(occupant).toMatchObject({ kind: "ours", pid: 60233, evidence: "exec-path" });
  });

  test("the /var vs /private/var physical-path trap: the same binary must not read as two", async () => {
    const cfg: BridgeConfig = { ...CFG, bin: "/var/wa/whatsapp-bridge" };
    const occupant = classifyPortOccupant(
      cfg,
      idleDeps({
        listenerPid: () => 4242,
        readPidfile: () => null,
        // a RUNNING process reports its physical path
        execPathOf: () => "/private/var/wa/whatsapp-bridge",
        realpath: (p) => (p === "/var/wa/whatsapp-bridge" ? "/private/var/wa/whatsapp-bridge" : p),
      }),
    );
    expect(occupant).toMatchObject({ kind: "ours", pid: 4242, evidence: "exec-path" });
  });

  test("a genuinely different process IS foreign, and its executable is named", async () => {
    const occupant = classifyPortOccupant(
      CFG,
      idleDeps({
        listenerPid: () => 777,
        readPidfile: () => 60233,
        execPathOf: () => "/Users/x/cue/voice-server",
      }),
    );
    expect(occupant).toMatchObject({
      kind: "foreign",
      pid: 777,
      execPath: "/Users/x/cue/voice-server",
    });
  });

  test("nothing listening → none", async () => {
    expect(classifyPortOccupant(CFG, idleDeps())).toMatchObject({ kind: "none", pid: null });
  });
});

describe("samePath", () => {
  test("matches raw, canonicalised and /private-stripped forms; rejects a different file", async () => {
    const id = (p: string) => p;
    expect(samePath("/a/b", "/a/b", id)).toBe(true);
    expect(samePath("/private/var/x", "/var/x", id)).toBe(true);
    expect(samePath("/a/b", "/a/c", id)).toBe(false);
    expect(samePath("", "/a/b", id)).toBe(false);
  });

  test("a listener's executable resolves to an ABSOLUTE path, so exec-path evidence can match cfg.bin (1936)", async () => {
    // `ps -o comm=` on Linux prints only the basename, which never equals a full cfg.bin: exec-path
    // evidence would never fire there, and a wrongly-DOWN bridge was the consequence once a foreign
    // occupant stopped counting as running.
    const path = realExecPathOf(process.pid);
    expect(path).toBeTruthy();
    expect(path!.startsWith("/")).toBe(true);
  });
});

describe("runBridge (foreground / daemon-supervised)", () => {
  test("spawns the binary with cwd = the bin dir + env WHATSAPP_BRIDGE_PORT, writes the pidfile, and BLOCKS on the child", async () => {
    const spawns: Array<{ cmd: string[]; opts: Record<string, unknown> }> = [];
    const pids: Array<{ path: string; pid: number }> = [];
    const removed: string[] = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((r) => (resolveExit = r));

    const outcome = runBridge(
      CFG,
      idleDeps({
        runSpawn: (cmd, opts) => {
          spawns.push({ cmd, opts });
          return { pid: 3131, exited, kill: () => {} } as RunHandle;
        },
        writePidfile: (path, pid) => pids.push({ path, pid }),
        removePidfile: (p) => removed.push(p),
      }),
    );

    expect(outcome.alreadyRunning).toBe(false);
    const handle = outcome as Extract<RunOutcome, { alreadyRunning: false }>;
    expect(spawns).toHaveLength(1);
    const s = spawns[0]!;
    expect(s.cmd).toEqual([CFG.bin]);
    expect(s.opts.cwd).toBe(CFG.cwd);
    expect((s.opts.env as Record<string, string>).WHATSAPP_BRIDGE_PORT).toBe("8099");
    expect(s.opts.logPath).toBe(CFG.logPath);
    expect(pids).toEqual([{ path: CFG.pidPath, pid: 3131 }]);

    // it BLOCKS: the returned exited promise is still pending until the child exits...
    let done = false;
    void handle.exited.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    expect(removed).toHaveLength(0);

    // ...and the pidfile is cleaned up once the child exits.
    resolveExit(0);
    await handle.exited;
    // Only its OWN pidfile: runBridge wrote just that one, and removing the legacy file here would
    // delete a record belonging to a different bridge (310).
    expect(removed).toEqual([CFG.pidPath]);
  });

  test("strips inherited proxy env from the spawn while keeping WHATSAPP_BRIDGE_PORT (180)", async () => {
    const prev = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "127.0.0.1:58044";
    try {
      let env: Record<string, string> = {};
      runBridge(
        CFG,
        idleDeps({
          runSpawn: (_cmd, opts) => (
            (env = opts.env), { pid: 3131, exited: Promise.resolve(0), kill: () => {} }
          ),
          writePidfile: () => {},
          removePidfile: () => {},
        }),
      );
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(Object.keys(env).some((k) => /_PROXY$/i.test(k))).toBe(false);
      expect(env.WHATSAPP_BRIDGE_PORT).toBe("8099");
    } finally {
      if (prev === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = prev;
    }
  });

  test("missing binary → clean error, never spawns", async () => {
    const spawns: unknown[] = [];
    expect(() =>
      runBridge(
        CFG,
        idleDeps({
          binExists: () => false,
          runSpawn: () => (spawns.push(1), { pid: 1, exited: Promise.resolve(0), kill: () => {} }),
        }),
      ),
    ).toThrow(/binary not found/);
    expect(spawns).toHaveLength(0);
  });

  test("foreign port-in-use → clean error naming the port, never spawns", async () => {
    const spawns: unknown[] = [];
    expect(() =>
      runBridge(
        CFG,
        idleDeps({
          listenerPid: () => 9999,
          runSpawn: () => (spawns.push(1), { pid: 1, exited: Promise.resolve(0), kill: () => {} }),
        }),
      ),
    ).toThrow(/port 8099 is already in use/);
    expect(spawns).toHaveLength(0);
  });

  test("the KeepAlive retry path must not call our own pid foreign - it says our bridge is already up", async () => {
    const spawns: unknown[] = [];
    const deps = idleDeps({
      listenerPid: () => 60233,
      readPidfile: () => 60233,
      isAlive: () => false, // the pidfile pid is what lsof reports; liveness is irrelevant here
      writePidfile: () => {},
      runSpawn: () => (spawns.push(1), { pid: 1, exited: Promise.resolve(0), kill: () => {} }),
    });
    const outcome = runBridge(CFG, deps);
    expect(outcome.alreadyRunning).toBe(true);
    const noop = outcome as Extract<RunOutcome, { alreadyRunning: true }>;
    expect(noop.pid).toBe(60233);
    // 221: it is a no-op, NOT an error - but the human still gets the whole explanation.
    expect(noop.note).toMatch(/our WhatsApp bridge is already up on port 8099 \(pid 60233/);
    expect(noop.note).toMatch(/nothing to do/);
    expect(noop.note).not.toMatch(/foreign/);
    expect(spawns).toHaveLength(0);
  });

  test("221: a relaunch onto our own live bridge is a no-op that writes nothing and spawns nothing", async () => {
    const writes: unknown[] = [];
    const outcome = runBridge(
      CFG,
      idleDeps({
        listenerPid: () => 60233,
        readPidfile: () => null, // no pidfile: the occupant is ours by its executable path
        execPathOf: () => CFG.bin,
        writePidfile: (path, pid) => writes.push({ path, pid }),
        removePidfile: (p) => writes.push(p),
        runSpawn: () => {
          throw new Error("must not spawn a second bridge");
        },
      }),
    );
    expect(outcome.alreadyRunning).toBe(true);
    expect((outcome as Extract<RunOutcome, { alreadyRunning: true }>).pid).toBe(60233);
    expect(writes).toEqual([]);
  });

  test("221: the KeepAlive relaunch that ran 82 times records a SUCCESS, not an 83rd failure", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    const now = nowIso();
    const job = jobForInvocation("whatsapp", ["bridge", "run"], {});
    expect(job).toBe("whatsapp-bridge"); // it IS the declared KeepAlive job, so the seam records it
    const upDeps = idleDeps({
      listenerPid: () => 60233,
      readPidfile: () => 60233,
      writePidfile: () => {},
      runSpawn: () => {
        throw new Error("must not spawn a second bridge");
      },
    });

    // ten relaunches onto a healthy bridge, recorded exactly as the seam in run() records them: the
    // handler returns without setting an exit code, which is `ok`.
    for (let i = 10; i >= 1; i--) {
      const at = new Date(Date.parse(now) - i * 10_000).toISOString();
      await recordJobAttempt(store, job!, at);
      const outcome = runBridge(CFG, upDeps);
      expect(outcome.alreadyRunning).toBe(true);
      await recordJobResult(store, job!, { ok: true }, at);
    }

    const health = (await jobHealth(store, { now })).find((h) => h.job === "whatsapp-bridge")!;
    expect(health.consecutive_failures).toBe(0);
    expect(health.last_error).toBeNull();
    expect(health.state).toBe("unscheduled"); // a KeepAlive process, never "failing"
    expect((await computeAlerts(sqliteStoreFor(db), { focusProject: null, now })).filter((a) => a.rule >= 7)).toEqual([]);
  });
});

describe("stopBridge", () => {
  test("kills the live pidfile process and removes the pidfile", async () => {
    const kills: Array<{ pid: number; signal: string }> = [];
    const removed: string[] = [];
    const res = stopBridge(CFG, {
      readPidfile: () => 555,
      isAlive: (pid) => pid === 555,
      kill: (pid, signal) => kills.push({ pid, signal }),
      removePidfile: (p) => removed.push(p),
    });
    expect(kills).toEqual([{ pid: 555, signal: "SIGTERM" }]);
    // BOTH pidfiles (310): recordedPid falls back to the legacy one, so leaving it behind would let the
    // next status read resurrect the pid this stop just killed.
    expect(removed).toEqual([CFG.pidPath, CFG.legacyPidPath]);
    expect(res).toEqual({ stopped: true, pid: 555 });
  });

  test("falls back to the port's listener when no live pidfile AND that listener is verifiably ours", async () => {
    const kills: number[] = [];
    const res = stopBridge(
      CFG,
      idleDeps({
        readPidfile: () => null,
        isAlive: () => false,
        listenerPid: () => 606,
        execPathOf: () => CFG.bin,
        kill: (pid) => kills.push(pid),
        removePidfile: () => {},
      }),
    );
    expect(kills).toEqual([606]);
    expect(res).toEqual({ stopped: true, pid: 606 });
  });

  test("never kills a FOREIGN process holding the port", async () => {
    const kills: number[] = [];
    const res = stopBridge(
      CFG,
      idleDeps({
        readPidfile: () => null,
        isAlive: () => false,
        listenerPid: () => 606,
        execPathOf: () => "/Users/x/cue/voice-server",
        kill: (pid) => kills.push(pid),
        removePidfile: () => {},
      }),
    );
    expect(kills).toHaveLength(0);
    expect(res).toEqual({ stopped: false, pid: null });
  });

  test("nothing running → stopped:false, no kill", async () => {
    const kills: number[] = [];
    const res = stopBridge(
      CFG,
      idleDeps({
        readPidfile: () => null,
        isAlive: () => false,
        listenerPid: () => null,
        kill: (pid) => kills.push(pid),
        removePidfile: () => {},
      }),
    );
    expect(kills).toHaveLength(0);
    expect(res).toEqual({ stopped: false, pid: null });
  });
});

/** A mock transport (typeof fetch) returning a canned health Response. */
function mockHealth(response: { status?: number; body?: unknown }): typeof fetch {
  return (async () => {
    const status = response.status ?? 200;
    const body = JSON.stringify(response.body ?? {});
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

/** The reconnect loop a re-registered (phone-switched) account produces - the #119 fault-B log. */
const DELETED_DEVICE_LOG = [
  "[Client INFO]  Connected to WhatsApp",
  "[Client ERROR] Reconnection failed: invalid use of deleted device",
  "[Client INFO]  Attempting to reconnect...",
].join("\n");

/**
 * The refusal that took the bridge out for 13 days (1347), quoted from the log of a bridge built against
 * whatsmeow `v0.0.0-20260604205742` (June). The `✓ Connected to WhatsApp!` line is the trap: it is the
 * newest SUCCESS line, so a classifier that does not know the failure signature reports it as the current
 * state of the session while WhatsApp is refusing the client outright.
 */
const CLIENT_OUTDATED_LOG = [
  "22:19:17.835 [Client INFO] Successfully authenticated",
  "✓ Connected to WhatsApp!",
  '<failure location="lla" reason="405"/>',
  "[Client ERROR] Client outdated (405) connect failure (client version: 2.3000.1040847988)",
  "[Client ERROR] ❌ Client outdated - please update whatsmeow library",
].join("\n");

describe("bridgeStatus health states (#119 fault B: port-open is not logged-in)", () => {
  test("NOT RUNNING: nothing alive and nothing listening → down, no health probe", async () => {
    let probed = false;
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        fetch: (() => ((probed = true), Promise.resolve(new Response()))) as unknown as typeof fetch,
      }),
    );
    expect(res).toMatchObject({ running: false, pid: null, source: null, health: "down" });
    expect(probed).toBe(false);
    expect(res.remedy).toMatch(/bridge start/);
  });

  test("HEALTHY: alive pid + connected:true + a log with no auth failure", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 111,
        isAlive: (p) => p === 111,
        readToken: () => "tok",
        readLogTail: () => "[Client INFO] Successfully logged in as 27...",
        pairedDeviceCount: () => 1,
        lastMessageAt: () => new Date(Date.now() - 60_000).toISOString(),
        fetch: mockHealth({ status: 200, body: { connected: true, status: "ok", timestamp: 1 } }),
      }),
    );
    expect(res).toMatchObject({
      running: true,
      pid: 111,
      source: "pidfile",
      health: "healthy",
      probe: "connected",
      log: "logged-in",
    });
    expect(res.remedy).toBeNull();
    // even "healthy" states plainly that connected:true is transport, not login state
    expect(res.signals.join("\n")).toMatch(/does NOT prove the WhatsApp session is authenticated/);
  });

  test("BUG: a LISTENING but logged-out bridge must NOT read as healthy - connected:true + deleted-device log → unauthenticated + the re-pair remedy", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 60233,
        isAlive: (p) => p === 60233,
        readToken: () => "tok",
        // the websocket reconnects, so /api/health says connected:true while login is rejected
        fetch: mockHealth({ status: 200, body: { connected: true, status: "ok", timestamp: 1 } }),
        readLogTail: () => DELETED_DEVICE_LOG,
        pairedDeviceCount: () => 1, // the deleted device LEAVES its pairing row behind
      }),
    );
    expect(res.health).toBe("unauthenticated");
    expect(res.health).not.toBe("healthy");
    expect(res.log).toBe("deleted-device");
    expect(res.probe).toBe("connected"); // the proxy signal is still reported, just not believed
    expect(res.remedy).toContain(CFG.pairingDbPath);
    expect(res.remedy).toMatch(/scan the QR/);
    // the pairing row must never be presented as proof the pairing works
    expect(res.signals.join("\n")).toMatch(/cannot prove the pairing still works/);
  });

  test("UNAUTHENTICATED: a bridge waiting on a QR scan (never linked)", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 111,
        isAlive: (p) => p === 111,
        readLogTail: () => "Scan this QR code with your phone:\n[QR]",
        pairedDeviceCount: () => 0,
        fetch: mockHealth({ status: 503, body: { connected: false, status: "disconnected" } }),
      }),
    );
    expect(res).toMatchObject({ health: "unauthenticated", log: "awaiting-qr", probe: "disconnected" });
    expect(res.signals.join("\n")).toMatch(/never linked/);
  });

  test("UNKNOWN is its own answer: the probe gives no usable answer over a silent log - not healthy, not down", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 111,
        isAlive: (p) => p === 111,
        readLogTail: () => null, // log unreadable / rotated
        fetch: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
      }),
    );
    expect(res).toMatchObject({ running: true, health: "unknown", probe: "unreachable", log: "silent" });
    expect(res.health).not.toBe("healthy");
    expect(res.health).not.toBe("down");
    expect(res.signals.join("\n")).toMatch(/absence of the error is not evidence/);
  });

  test("UNKNOWN: the sandbox proxy's non-JSON non-2xx (183) is unreachable, never a 'disconnected' claim", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 111,
        isAlive: (p) => p === 111,
        readLogTail: () => "",
        fetch: (() =>
          Promise.resolve(
            new Response("<html>connection required</html>", { status: 405 }),
          )) as unknown as typeof fetch,
      }),
    );
    expect(res).toMatchObject({ health: "unknown", probe: "unreachable" });
  });

  test("UNKNOWN: a disconnected transport with no auth evidence is not a claim in either direction", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 111,
        isAlive: (p) => p === 111,
        readLogTail: () => "[Client INFO] Attempting to reconnect...",
        fetch: mockHealth({ status: 503, body: { connected: false, status: "disconnected" } }),
      }),
    );
    expect(res).toMatchObject({ health: "unknown", probe: "disconnected", log: "silent" });
  });

  test("BUG: an unverified port listener is NOT a running bridge, and its connected answer earns nothing (1936)", async () => {
    let probed = false;
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        listenerPid: () => 222,
        execPathOf: () => "/usr/local/bin/some-other-server",
        // even a LOGGED-IN line in our own (old) log must not dress a stranger's port up as healthy
        readLogTail: () => "[Client INFO] Successfully logged in as 27...",
        fetch: (() => {
          probed = true;
          return Promise.resolve(new Response(JSON.stringify({ connected: true })));
        }) as unknown as typeof fetch,
      }),
    );
    expect(res).toMatchObject({ running: false, pid: 222, source: "port", health: "unknown" });
    // A stranger is never handed our bridge bearer, and its answer would not be about our session.
    expect(probed).toBe(false);
    expect(res.remedy).toMatch(/port 8099 is already in use by pid 222/);
    expect(res.remedy).toMatch(/not our bridge/);
    expect(res.signals.join("\n")).toMatch(/it may not be our bridge at all/);
    expect(bridgeStatusHeadline(res)).toMatch(/holds the port but is not our bridge/);
  });

  test("a bridge found by exec path that answers connected is still healthy (only a stranger is demoted)", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => null,
        isAlive: () => false,
        listenerPid: () => 60233,
        execPathOf: () => CFG.bin,
        readToken: () => "tok",
        readLogTail: () => "",
        fetch: mockHealth({ status: 200, body: { connected: true, status: "ok", timestamp: 1 } }),
      }),
    );
    expect(res).toMatchObject({ running: true, pid: 60233, source: "exec-path", health: "healthy" });
  });

  test("ingestion freshness is reported but never downgrades the verdict (a quiet chat looks like silence)", async () => {
    const stale = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 111,
        isAlive: (p) => p === 111,
        readLogTail: () => "[Client INFO] Successfully logged in",
        lastMessageAt: () => stale,
        fetch: mockHealth({ status: 200, body: { connected: true, status: "ok" } }),
      }),
    );
    expect(res.health).toBe("healthy");
    expect(res.lastMessageAt).toBe(stale);
    expect(res.signals.join("\n")).toMatch(/does not prove logged-out/);
  });
});

// 1347. Two failures, one verdict: the check spent 13 days saying UNKNOWN while the log named the cause
// on its newest lines, and it quoted a 13-day-old login line as "whatsmeow's own direct report of the
// session state". Both are pinned here - no ssh, no live bridge, no real log.
describe("a refused client and a stale log (1347)", () => {
  const DAY = 24 * 3600_000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  test("405: the cause is named, the session is called FINE, and the remedy is the rebuild", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 783255,
        isAlive: (p) => p === 783255,
        readLogTail: () => CLIENT_OUTDATED_LOG,
        // The measured shape: the process has been up since before the log's last write, and nothing has
        // been written to it for 13 days. A REFUSAL survives that - it is a fact about the code we are
        // running, not a claim about the present - which is why this verdict is not "unknown".
        logMtime: () => ago(13 * DAY),
        processStartedAt: () => ago(14 * DAY),
        fetch: mockHealth({ status: 503, body: { connected: false, status: "disconnected" } }),
      }),
    );
    expect(res.log).toBe("client-outdated");
    expect(res.health).toBe("unauthenticated");
    expect(res.probe).toBe("disconnected");
    expect(res.remedy).toMatch(/go\.mau\.fi\/whatsmeow@latest/);
    expect(res.remedy).toMatch(/bridge build script/);
    // The remedy the old code would have given here - move the store aside and scan a QR - would throw
    // away a working pairing and fix nothing, so it must not appear.
    expect(res.remedy).not.toMatch(/scan (the|a) QR/);
    expect(res.remedy).not.toMatch(/move .* aside/);
    expect(res.signals.join("\n")).toMatch(/please update whatsmeow library/);
    // The machine-only doctor pushes `signals.slice(0, 3)` as its alert body, and this outage trips the
    // same `probe != connected` trigger as a dead session - so the CAUSE has to be inside those three,
    // or every 405 alert says "session not connected" and somebody re-pairs a working bridge.
    expect(res.signals.slice(0, 3).join("\n")).toMatch(/CAUSE is the bridge's whatsmeow version/);
    const headline = bridgeStatusHeadline(res);
    expect(headline).toMatch(/Client outdated/);
    expect(headline).not.toMatch(/UNKNOWN/);
  });

  test("a stale logged-in line is not a report of the current session, and never outvotes connected:false", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 111,
        isAlive: (p) => p === 111,
        readLogTail: () => "[Client INFO] Successfully logged in as 27...",
        logMtime: () => ago(13 * DAY),
        processStartedAt: () => ago(DAY),
        fetch: mockHealth({ status: 503, body: { connected: false, status: "disconnected" } }),
      }),
    );
    expect(res.log).toBe("logged-in"); // what the classifier read
    expect(res.logStale).toBe(true); // and the qualifier the verdict now carries
    expect(res.health).toBe("unknown");
    expect(res.signals.join("\n")).toMatch(/PREDATES the running bridge/);
    expect(res.signals.join("\n")).not.toMatch(/direct\s+report of the session state/);
    // The remedy must not send anybody to re-pair a bridge that has simply stopped talking.
    expect(res.remedy).toMatch(/has not been written to since/);
    expect(res.remedy).not.toMatch(/scan the QR/);
  });

  test("the SAME fresh logged-in line, on a log the running process is still writing, DOES earn 'authenticated'", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 111,
        isAlive: (p) => p === 111,
        readLogTail: () => "[Client INFO] Successfully logged in as 27...",
        logMtime: () => ago(2_000),
        processStartedAt: () => ago(60 * 60_000),
        fetch: mockHealth({ status: 200, body: { connected: true, status: "ok" } }),
      }),
    );
    expect({ health: res.health, logStale: res.logStale }).toEqual({ health: "healthy", logStale: false });
    expect(bridgeStatusHeadline(res)).toMatch(/whatsmeow reports logged in/);
    expect(res.remedy).toBeNull();
  });

  test("unknown recency is not stale: an unreadable mtime leaves the verdict exactly as it was", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 111,
        isAlive: (p) => p === 111,
        readLogTail: () => "[Client INFO] Successfully logged in as 27...",
        logMtime: () => null,
        fetch: mockHealth({ status: 200, body: { connected: true, status: "ok" } }),
      }),
    );
    expect({ log: res.log, logStale: res.logStale, health: res.health }).toEqual({
      log: "logged-in",
      logStale: false,
      health: "healthy",
    });
  });

  test("503 with a FRESH reconnect loop is transient: retry, do not re-pair", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 111,
        isAlive: (p) => p === 111,
        readLogTail: () => "[Client INFO] Connection attempt 1/3...\n[Client INFO] Attempting to reconnect...",
        logMtime: () => ago(5_000),
        processStartedAt: () => ago(60 * 60_000),
        fetch: mockHealth({ status: 503, body: { connected: false, status: "disconnected" } }),
      }),
    );
    expect(res.health).toBe("unknown");
    expect(res.remedy).toMatch(/transient/);
    expect(res.remedy).not.toMatch(/scan the QR/);
  });

  test("no verdict at all keeps the honest cannot-ask answer, unchanged", async () => {
    const res = await bridgeStatus(
      CFG,
      idleDeps({
        readPidfile: () => 111,
        isAlive: (p) => p === 111,
        readLogTail: () => "[Client INFO] Starting WhatsApp client...",
        fetch: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
      }),
    );
    expect({ health: res.health, probe: res.probe, log: res.log }).toEqual({
      health: "unknown",
      probe: "unreachable",
      log: "silent",
    });
    expect(res.remedy).toMatch(/cannot confirm the session/);
  });

  test("logIsStale: an old write, or one that predates the process - and nothing else", () => {
    const now = Date.parse("2026-10-18T12:00:00.000Z");
    const at = (iso: string) => iso;
    // Nothing written for over an hour: whatever is in there is history.
    expect(logIsStale(at("2026-10-18T10:00:00.000Z"), null, now)).toBe(true);
    // Written after the process started, within the hour: current.
    expect(logIsStale(at("2026-10-18T11:30:00.000Z"), at("2026-10-18T11:00:00.000Z"), now)).toBe(false);
    // Recent by the clock, but the write PREDATES this run - so no line in it is from this run.
    expect(logIsStale(at("2026-10-18T11:59:59.000Z"), at("2026-10-18T12:00:00.000Z"), now)).toBe(true);
    // Unknown recency is never stale.
    expect(logIsStale(null, at("2026-10-18T11:00:00.000Z"), now)).toBe(false);
    expect(logIsStale("not a date", null, now)).toBe(false);
  });
});

describe("bridgeStatusHeadline (an inference is never dressed up as a reading)", () => {
  const base = {
    running: true,
    pid: 111,
    port: 8099,
    source: "pidfile" as const,
    probe: "connected" as const,
    pairedDevices: 1,
    lastMessageAt: null,
    logStale: false,
    signals: [],
    remedy: null,
  };

  test("only whatsmeow's own logged-in line earns the word 'authenticated'", async () => {
    expect(bridgeStatusHeadline({ ...base, health: "healthy", log: "logged-in" })).toMatch(
      /healthy on :8099 \(pid 111\) - whatsmeow reports logged in/,
    );
    const silent = bridgeStatusHeadline({ ...base, health: "healthy", log: "silent" });
    expect(silent).toMatch(/no auth error in the log/);
    expect(silent).not.toMatch(/reports logged in/);
  });

  test("the three other states read as themselves", async () => {
    expect(bridgeStatusHeadline({ ...base, running: false, pid: null, health: "down", log: "silent" })).toMatch(
      /DOWN on :8099/,
    );
    expect(
      bridgeStatusHeadline({ ...base, health: "unauthenticated", log: "deleted-device" }),
    ).toMatch(/NOT AUTHENTICATED on :8099 \(pid 111\) - running, but nothing can be ingested/);
    expect(bridgeStatusHeadline({ ...base, health: "unknown", log: "silent" })).toMatch(
      /UNKNOWN on :8099 \(pid 111\) - a process is up; its session state could not be read/,
    );
  });
});

describe("classifyBridgeLog", () => {
  test("the most recent decisive line wins - a re-pair after a dead session reads logged-in", async () => {
    expect(classifyBridgeLog(`${DELETED_DEVICE_LOG}\n[Client INFO] Successfully logged in as 27…`)).toBe(
      "logged-in",
    );
    expect(classifyBridgeLog(`[Client INFO] Successfully logged in\n${DELETED_DEVICE_LOG}`)).toBe(
      "deleted-device",
    );
  });

  test("no log / no auth-relevant line → silent (absence is not evidence)", async () => {
    expect(classifyBridgeLog(null)).toBe("silent");
    expect(classifyBridgeLog("")).toBe("silent");
    expect(classifyBridgeLog("[Client INFO] Attempting to reconnect...")).toBe("silent");
  });

  test("reads a logged-out line and a QR prompt", async () => {
    expect(classifyBridgeLog("[Client ERROR] stream error: 401 logged out")).toBe("logged-out");
    expect(classifyBridgeLog("Scan this QR code with your phone")).toBe("awaiting-qr");
  });

  test("405 'Client outdated' names the CAUSE, and outranks the login line above it (1347)", async () => {
    expect(classifyBridgeLog(CLIENT_OUTDATED_LOG)).toBe("client-outdated");
    // Each of the three ways WhatsApp says it, on its own - the log is not quoted consistently.
    expect(classifyBridgeLog('<failure location="lla" reason="405"/>')).toBe("client-outdated");
    expect(classifyBridgeLog("[Client ERROR] ❌ Client outdated - please update whatsmeow library")).toBe(
      "client-outdated",
    );
    // ...and a login AFTER the refusal is a fresh verdict, so the newest decisive line still wins.
    expect(classifyBridgeLog(`${CLIENT_OUTDATED_LOG}\n[Client INFO] Successfully logged in as 27…`)).toBe(
      "logged-in",
    );
  });

  test("a reconnect loop is not an auth verdict, so it cannot mask the dead-session line (#119)", async () => {
    expect(logShowsReconnectLoop(DELETED_DEVICE_LOG)).toBe(true);
    expect(logShowsReconnectLoop(null)).toBe(false);
    expect(logShowsReconnectLoop("[Client INFO] Starting WhatsApp client...")).toBe(false);
    // The 405 log ends with a refusal and no reconnect chatter.
    expect(logShowsReconnectLoop(CLIENT_OUTDATED_LOG)).toBe(false);
  });
});

describe("readHealthBody (the probe reads TRANSPORT only)", () => {
  test("the real payloads", async () => {
    expect(readHealthBody({ connected: true, status: "ok", timestamp: 1 })).toBe("connected");
    expect(readHealthBody({ connected: false, status: "disconnected" })).toBe("disconnected");
  });

  test("the explicit boolean outranks status - {connected:false,status:'ok'} is never connected", async () => {
    expect(readHealthBody({ connected: false, status: "ok" })).toBe("disconnected");
  });

  test("an unreadable shape is unreachable (unknown), never a claim", async () => {
    expect(readHealthBody(null)).toBe("unreachable");
    expect(readHealthBody({ timestamp: 1 })).toBe("unreachable");
  });
});

describe("zeroResultNote (a zero from a logged-out bridge is not a quiet zero)", () => {
  test("each kind of zero is named, and the unauthenticated one carries the remedy", async () => {
    expect(zeroResultNote({ health: "healthy", remedy: null })).toMatch(/nothing new to read/);
    const dead = zeroResultNote({ health: "unauthenticated", remedy: "move whatsapp.db aside" });
    expect(dead).toMatch(/NOT AUTHENTICATED/);
    expect(dead).toContain("move whatsapp.db aside");
    // A refused client is not a pairing problem, so the zero does not say "re-linked" (1347).
    const refused = zeroResultNote({
      health: "unauthenticated",
      log: "client-outdated",
      remedy: "rebuild the bridge",
    });
    expect(refused).toMatch(/CLIENT IS OUTDATED/);
    expect(refused).toContain("rebuild the bridge");
    expect(refused).not.toMatch(/re-linked/);
    expect(zeroResultNote({ health: "down", remedy: null })).toMatch(/DOWN/);
    expect(zeroResultNote({ health: "unknown", remedy: null })).toMatch(/proves nothing either way/);
  });
});

describe("ensureLoopbackNoProxy (183 — probe must bypass the sandbox proxy)", () => {
  test("adds the loopback hosts to NO_PROXY / no_proxy when absent", async () => {
    const env: Record<string, string | undefined> = {};
    ensureLoopbackNoProxy(env);
    for (const key of ["NO_PROXY", "no_proxy"]) {
      const hosts = (env[key] ?? "").split(",");
      expect(hosts).toEqual(expect.arrayContaining(["127.0.0.1", "localhost", "::1"]));
    }
  });

  test("is additive + idempotent — preserves existing exemptions, no duplicates", async () => {
    const env: Record<string, string | undefined> = { NO_PROXY: "example.com,127.0.0.1" };
    ensureLoopbackNoProxy(env);
    ensureLoopbackNoProxy(env); // second call must not duplicate
    const hosts = (env.NO_PROXY ?? "").split(",");
    expect(hosts).toContain("example.com");
    expect(hosts.filter((h) => h === "127.0.0.1")).toHaveLength(1);
    expect(hosts).toEqual(expect.arrayContaining(["127.0.0.1", "localhost", "::1"]));
  });
});

describe("whatsapp-bridge daemon slot", () => {
  test("registered KeepAlive + RunAtLoad running the blocking `whatsapp bridge run`", async () => {
    const job = daemonJobs("/home/u").find((j) => j.job === "whatsapp-bridge");
    expect(job).toBeDefined();
    expect(job!.args.slice(1)).toEqual(["whatsapp", "bridge", "run"]); // the foreground mode, not start
    expect(job!.opts.keepAlive).toBe(true);
    expect(job!.opts.runAtLoad).toBe(true);
  });

  test("ob 401: `bridge run` closes the Postgres store after spawn so the supervisor holds no slots", async () => {
    const src = readFileSync(new URL("../src/commands/whatsapp.ts", import.meta.url), "utf8");
    const run = src.slice(src.indexOf('if (action === "run")'), src.indexOf('if (action === "stop")'));
    expect(run).toContain("await resetStore()");
    expect(run.indexOf("await resetStore()")).toBeLessThan(run.indexOf("handle.exited"));
  });

  test("is not on the Mac install list (457: leave installed if already there, do not add back)", async () => {
    const r = await runCli(freshDbPath(), ["daemon", "status", "--json"]);
    expect(r.code).toBe(0);
    const jobs = JSON.parse(r.out).jobs as Array<{ job: string; command: string }>;
    expect(jobs.find((j) => j.job === "whatsapp-bridge")).toBeUndefined();
  });
});

// ── one bridge, one log, one pidfile (310) ────────────────────────────────────────────────────────
// A throwaway bridge on ANOTHER port, with its own store, wrote into the shared log and overwrote the
// shared pidfile — and because classifyBridgeLog takes the newest decisive line, the LIVE healthy bridge
// then reported NOT AUTHENTICATED. A false green is bad; a false red on a working session sends nobody to
// look and would have raised a rule-11 alert against a bridge that was ingesting fine.

describe("per-port runtime paths (310)", () => {
  test("two bridges on different ports share NO log and NO pidfile", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const a = await bridgeConfig(db, "/home/ob");
      await setConfig(db, "whatsapp_bridge_url", "http://127.0.0.1:8188");
      const b = await bridgeConfig(db, "/home/ob");
      expect(a.port).not.toBe(b.port);
      expect(a.logPath).not.toBe(b.logPath);
      expect(a.pidPath).not.toBe(b.pidPath);
      // Both carry the port, so which file belongs to which bridge is readable off the name.
      expect(a.pidPath).toContain(String(a.port));
      expect(b.logPath).toContain(String(b.port));
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("the legacy shared paths are still named, so a pre-310 bridge is not orphaned", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    try {
      const cfg = await bridgeConfig(db, "/home/ob");
      expect(cfg.legacyPidPath).toBe("/home/ob/.local/share/omnislash/whatsapp-bridge.pid");
      expect(cfg.legacyLogPath).toBe("/home/ob/.local/share/omnislash/logs/whatsapp-bridge.log");
      // And they are NOT the paths a new bridge writes.
      expect(cfg.pidPath).not.toBe(cfg.legacyPidPath);
    } finally {
      await lease.release();
    }
  }, PG_BUDGET);

  test("status finds a bridge whose pid is only in the LEGACY pidfile", async () => {
    // The upgrade case: systemd already had a bridge running, its pid recorded under the old name.
    const res = await bridgeStatus(CFG, {
      readPidfile: (p) => (p === CFG.legacyPidPath ? 4242 : null),
      isAlive: () => true,
      listenerPid: () => null,
      readLogTail: () => null,
      lastMessageAt: () => null,
      pairedDeviceCount: () => 1,
      fetch: (async () => new Response(JSON.stringify({ connected: true }))) as unknown as typeof fetch,
    });
    expect(res.running).toBe(true);
    expect(res.pid).toBe(4242);
    // And it says WHICH file that pid came from. Naming the per-port path while the value came from the
    // legacy one sends the reader to `cat` an empty file — the small lie these provenance lines exist to
    // avoid, and one this fix shipped with for a moment before the live server showed it.
    expect(res.signals.some((sig) => sig.includes(CFG.legacyPidPath))).toBe(true);
    expect(res.signals.some((sig) => sig.includes(`from ${CFG.pidPath}`))).toBe(false);
  });

  test("the log verdict falls back to the legacy log, and names the file it actually read", async () => {
    const res = await bridgeStatus(CFG, {
      readPidfile: (p) => (p === CFG.pidPath ? 4242 : null),
      isAlive: () => true,
      // The per-port log does not exist yet; the running bridge's fd is on the legacy one.
      readLogTail: (p) => (p === CFG.legacyLogPath ? "Successfully logged in\n" : null),
      lastMessageAt: () => null,
      pairedDeviceCount: () => 1,
      fetch: (async () => new Response(JSON.stringify({ connected: true }))) as unknown as typeof fetch,
    });
    expect(res.log).toBe("logged-in");
    // Provenance must point at the file that was read, or the reader goes and tails an empty one.
    expect(res.signals.some((sig) => sig.includes(CFG.legacyLogPath))).toBe(true);
  });

  test("the per-port log WINS when it exists: a legacy file is not evidence about this bridge", async () => {
    const res = await bridgeStatus(CFG, {
      readPidfile: (p) => (p === CFG.pidPath ? 4242 : null),
      isAlive: () => true,
      readLogTail: (p) =>
        p === CFG.logPath ? "Successfully logged in\n" : "Scan this QR code with your WhatsApp app\n",
      lastMessageAt: () => null,
      pairedDeviceCount: () => 1,
      fetch: (async () => new Response(JSON.stringify({ connected: true }))) as unknown as typeof fetch,
    });
    // This is the 274 regression in miniature: another bridge's QR prompt must NOT downgrade this one.
    expect(res.log).toBe("logged-in");
    expect(res.health).toBe("healthy");
  });
});

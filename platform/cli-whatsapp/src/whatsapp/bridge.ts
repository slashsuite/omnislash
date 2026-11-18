import { Database } from "bun:sqlite";
import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { settingFor } from "../../../../apps/cli/src/settings.ts";
import type { Store } from "../../../../apps/cli/src/db/store.ts";
import { expandHome } from "../../../../apps/cli/src/net.ts";
import { AppError } from "../../../../apps/cli/src/errors.ts";

// ── ob owns the WhatsApp Go bridge's lifecycle (161) ──────────────────────────────────────────────
// The bridge is a manual terminal process today — when it's down, `whatsapp send` 404s and ingest
// stops. This module lets `ob whatsapp bridge start|stop|status` manage it the way `ob web` manages the
// dashboard: spawn it detached on the port `whatsapp send` already agrees on, keep a pidfile so we can
// find/stop it, and (via the `whatsapp-bridge` daemon slot, KeepAlive + RunAtLoad) keep it up across
// reboots + crashes. `start` is idempotent (a live bridge → no-op) so the KeepAlive relaunch is a cheap
// "ensure running" poll rather than a double-spawn.
//
// RE-AUTH IS HITL: on first link and the ~20-day whatsmeow session drop the bridge prints a QR to its
// LOG — a daemon can't scan it. `status` flags "up but not linked" so the human tails the log + scans.
//
// ob never talks to WhatsApp here; it only spawns the local binary + probes localhost `/api/health`.

/** Resolved paths + port for the managed bridge, derived from config. */
export interface BridgeConfig {
  /** Absolute path to the Go bridge binary (`whatsapp_bridge_bin`, ~ expanded). */
  bin: string;
  /** Working dir for the spawn = the binary's directory (it needs `store/` beside it). */
  cwd: string;
  /** Port parsed from `whatsapp_bridge_url` — passed to the child as `WHATSAPP_BRIDGE_PORT`. */
  port: number;
  /** Loopback REST base (`whatsapp_bridge_url`) used for the health probe. */
  url: string;
  /** stdout+stderr log, keyed by port (`~/.local/share/omnislash/logs/whatsapp-bridge-<port>.log`, 310). */
  logPath: string;
  /** Pidfile, keyed by port (`~/.local/share/omnislash/whatsapp-bridge-<port>.pid`, 310). */
  pidPath: string;
  /** The pre-310 shared log path. Read only when `logPath` does not exist yet (see the block above). */
  legacyLogPath: string;
  /** The pre-310 shared pidfile. Read only when `pidPath` holds nothing (see the block above). */
  legacyPidPath: string;
  /** The bridge's `store/messages.db` (`whatsapp_db_path`) - read-only ingestion evidence. */
  messagesDbPath: string;
  /** The bridge's `store/whatsapp.db` (sibling of messages.db) - the whatsmeow pairing store. */
  pairingDbPath: string;
}

/** Parse the TCP port from a bridge URL (falls back to the protocol default, then a `:NNNN` scan). */
export function parseBridgePort(url: string): number {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : 80;
  } catch {
    const m = url.match(/:(\d+)/);
    if (m) return Number(m[1]);
    throw new AppError(`cannot parse a port from whatsapp_bridge_url '${url}'`);
  }
}

// ── one bridge, one log, one pidfile (310) ────────────────────────────────────────────────────────
// These two paths used to be FIXED per machine, and that made the health verdict readable by any other
// bridge process on the box. Proven the hard way while building 274: a throwaway bridge started on a
// different port, with its own store, wrote 30 "Scan this QR code" lines into the shared log and
// overwrote the shared pidfile with its own pid. `classifyBridgeLog` takes the newest decisive line, so
// the LIVE, ingesting, healthy bridge reported NOT AUTHENTICATED — the exact false red #119 exists to
// prevent — and `ob creds check whatsapp` would have raised a rule-11 alert against a working session.
//
// The port is the key, because only one process can hold one. Two bridges therefore cannot share a log or
// a pidfile, and neither can be read as evidence about the other.
//
// The LEGACY paths are still read when the per-port ones are absent, and that is not politeness: on the
// machine this shipped to, a bridge was already running under systemd having written the legacy pidfile
// and holding an open fd on the legacy log. Without the fallback, the upgrade would have orphaned that
// process from `stop`/`status` and thrown away the logged-in evidence its verdict rests on.

/** The fixed data dir every OmniSlash runtime file lives under. */
function omnislashDataDir(home: string): string {
  return join(home, ".local", "share", "omnislash");
}

/** Per-port runtime paths, plus the pre-310 fixed ones so a bridge started before this still resolves. */
function bridgeRuntimePaths(home: string, port: number): {
  logPath: string;
  pidPath: string;
  legacyLogPath: string;
  legacyPidPath: string;
} {
  const dataDir = omnislashDataDir(home);
  return {
    logPath: join(dataDir, "logs", `whatsapp-bridge-${port}.log`),
    pidPath: join(dataDir, `whatsapp-bridge-${port}.pid`),
    legacyLogPath: join(dataDir, "logs", "whatsapp-bridge.log"),
    legacyPidPath: join(dataDir, "whatsapp-bridge.pid"),
  };
}

/** Build the runtime config for the managed bridge from settings (+ the fixed OmniSlash data dir). */
export async function bridgeConfig(store: Store, home: string = homedir()): Promise<BridgeConfig> {
  const bin = expandHome(await settingFor(store, "whatsapp_bridge_bin"));
  const url = await settingFor(store, "whatsapp_bridge_url");
  const messagesDbPath = expandHome(await settingFor(store, "whatsapp_db_path"));
  const port = parseBridgePort(url);
  return {
    bin,
    cwd: dirname(bin),
    port,
    url,
    ...bridgeRuntimePaths(home, port),
    messagesDbPath,
    pairingDbPath: join(dirname(messagesDbPath), "whatsapp.db"),
  };
}

// ── proxy-free spawn env (180) ────────────────────────────────────────────────────────────────────
// The `ob`/daemon process runs behind a loopback sandbox proxy (`HTTPS_PROXY=127.0.0.1:NNNNN`). Go's
// net/http honours `*_PROXY`, so a bridge spawned with `env: process.env` tries to dial
// `web.whatsapp.com` THROUGH that loopback proxy → "proxyconnect … connection refused" → the bridge
// gives up and dies. The bridge must reach WhatsApp DIRECTLY (a manual clean-env run connects fine), so
// we strip every proxy var before spawning it and keep everything else (incl. WHATSAPP_BRIDGE_PORT).

/**
 * A copy of `env` with all proxy configuration removed — the child (Go bridge) then connects directly
 * instead of via the loopback sandbox proxy that `ob` runs behind. Drops the well-known proxy keys in
 * both cases plus, defensively, anything matching `*_PROXY` (e.g. a stray `FOO_PROXY`).
 */
export function bridgeSpawnEnv(env: Record<string, string | undefined>): Record<string, string> {
  const KNOWN_PROXY_KEYS = new Set([
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (KNOWN_PROXY_KEYS.has(key) || /_PROXY$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

// ── injectable seams (tests never touch the real process/network/filesystem) ──────────────────────

/** Spawn the detached child; returns its pid. Real impl detaches + redirects stdio to the log file. */
export type SpawnFn = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string>; logPath: string; detached: boolean },
) => number;

/** A handle on a FOREGROUND child (for `run`): its pid, a promise of its exit code, and a killer. */
export interface RunHandle {
  pid: number;
  exited: Promise<number>;
  kill: (signal?: NodeJS.Signals) => void;
}

/** Spawn the child in the foreground (stdio → the log file); the caller awaits `exited`. */
export type ForegroundSpawnFn = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string>; logPath: string },
) => RunHandle;

export interface BridgeDeps {
  spawn?: SpawnFn;
  runSpawn?: ForegroundSpawnFn;
  /** pid of whatever is LISTENing on the port, else null (real impl shells `lsof`). */
  listenerPid?: (port: number) => number | null;
  /** is a pid alive? (real impl: `process.kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean;
  /** send a signal to a pid (real impl: `process.kill`). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** read the pid out of the pidfile, else null. */
  readPidfile?: (path: string) => number | null;
  /** write the pidfile. */
  writePidfile?: (path: string, pid: number) => void;
  /** remove the pidfile (best-effort). */
  removePidfile?: (path: string) => void;
  /** does the binary exist? */
  binExists?: (path: string) => boolean;
  /** transport for the `/api/health` probe. */
  fetch?: typeof fetch;
  /** bridge bearer token (defaults to reading `whatsapp_bridge_token_path`). */
  readToken?: () => string | Promise<string>;
  /** the executable a pid is running, else null (real impl shells `ps -p <pid> -o comm=`). */
  execPathOf?: (pid: number) => string | null;
  /** canonicalise a path (real impl `realpathSync`, falling back to the input) - see `samePath`. */
  realpath?: (path: string) => string;
  /** the tail of the bridge log (last ~64 KiB), else null when unreadable. */
  readLogTail?: (path: string) => string | null;
  /** ISO mtime of the bridge log - its newest write. Recency evidence for the log verdict (1347). */
  logMtime?: (path: string) => string | null;
  /** ISO start time of a running pid, else null. A log older than this cannot describe this run (1347). */
  processStartedAt?: (pid: number) => string | null;
  /** ISO timestamp of the newest row in the bridge's messages.db, else null. */
  lastMessageAt?: (dbPath: string) => string | null;
  /** rows in the pairing store's `whatsmeow_device`, else null when unreadable. */
  pairedDeviceCount?: (dbPath: string) => number | null;
}

function realSpawn(
  cmd: string[],
  opts: { cwd: string; env: Record<string, string>; logPath: string; detached: boolean },
): number {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const fd = openSync(opts.logPath, "a");
  const child = nodeSpawn(cmd[0]!, cmd.slice(1), {
    cwd: opts.cwd,
    env: opts.env,
    detached: opts.detached,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  return child.pid ?? -1;
}

function realRunSpawn(
  cmd: string[],
  opts: { cwd: string; env: Record<string, string>; logPath: string },
): RunHandle {
  mkdirSync(dirname(opts.logPath), { recursive: true });
  const fd = openSync(opts.logPath, "a");
  // NOT detached: the child is tied to this `ob ... run` process so launchd supervises the real bridge —
  // we await proc.exited (blocks, like cmdWeb) and forward the stop signal, so crash → run exits → relaunch.
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
  });
  return { pid: proc.pid, exited: proc.exited, kill: (signal) => proc.kill(signal) };
}

function realListenerPid(port: number): number | null {
  try {
    const p = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (p.exitCode !== 0) return null;
    const out = new TextDecoder().decode(p.stdout).trim();
    if (!out) return null;
    const pid = Number(out.split(/\s+/)[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function realIsAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = the process exists but isn't ours; still "alive".
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function realReadPidfile(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function realExecPathOf(pid: number): string | null {
  if (!pid || pid <= 0) return null;
  // Linux first: `/proc/<pid>/exe` is the REAL absolute path, while `ps -o comm=` there prints only the
  // executable's basename (15 characters at most), which can never equal a full `cfg.bin` - so exec-path
  // evidence would silently never match on the box the bridge runs on, and every listener the pidfile did
  // not name would read as foreign (1936).
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    // not Linux, or not ours to read: fall back to ps (macOS prints the full path there)
  }
  try {
    const p = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (p.exitCode !== 0) return null;
    const out = new TextDecoder().decode(p.stdout).trim();
    return out || null;
  } catch {
    return null;
  }
}

function realRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** When the log was last written, or null - the file's mtime. Unknown is never treated as stale. */
function realLogMtime(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * When a pid started, or null. `ps -o etimes=` (elapsed SECONDS) rather than `lstart`: a number needs no
 * locale or timezone parsing, and `lstart`'s "Sat Oct 18 12:19:17 2026" is a shape nobody wants to parse.
 */
function realProcessStartedAt(pid: number): string | null {
  if (!pid || pid <= 0) return null;
  try {
    const p = Bun.spawnSync(["ps", "-p", String(pid), "-o", "etimes="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (p.exitCode !== 0) return null;
    const secs = Number(new TextDecoder().decode(p.stdout).trim());
    if (!Number.isFinite(secs) || secs < 0) return null;
    return new Date(Date.now() - secs * 1000).toISOString();
  } catch {
    return null;
  }
}

/** Read the last `bytes` of a file (default 64 KiB) - null when it cannot be read. */
function realReadLogTail(path: string, bytes = 64 * 1024): string | null {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    const length = Math.min(size, bytes);
    if (length === 0) return "";
    fd = openSync(path, "r");
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return buf.toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // the tail is best-effort evidence; a failed close must not fail the status read
      }
    }
  }
}

/** Open one of the bridge's own SQLite stores READ-ONLY and hand it to `read`; null on any failure. */
function withBridgeStore<T>(dbPath: string, read: (db: Database) => T): T | null {
  if (!dbPath || !existsSync(dbPath)) return null;
  let handle: Database | null = null;
  try {
    handle = new Database(dbPath, { readonly: true });
    return read(handle);
  } catch {
    return null;
  } finally {
    handle?.close();
  }
}

function realLastMessageAt(dbPath: string): string | null {
  const raw = withBridgeStore(dbPath, (h) => {
    const row = h.query(`SELECT MAX(timestamp) AS ts FROM messages`).get() as {
      ts: string | number | null;
    } | null;
    return row?.ts ?? null;
  });
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" || /^\d+$/.test(String(raw)) ? Number(raw) : NaN;
  const d = Number.isFinite(n) && n > 0 ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function realPairedDeviceCount(dbPath: string): number | null {
  return withBridgeStore(dbPath, (h) => {
    const row = h.query(`SELECT COUNT(*) AS n FROM whatsmeow_device`).get() as { n: number } | null;
    return row ? Number(row.n) : null;
  });
}

// ── loopback probe must bypass the sandbox proxy (183, sibling of 180) ─────────────────────────────
// `ob`/the daemon run behind a loopback sandbox proxy (`HTTPS_PROXY=127.0.0.1:NNNNN`, decision #180).
// Bun's `fetch` (and even node:http) honour `*_PROXY`, so the `/api/health` probe to our OWN bridge on
// 127.0.0.1 gets routed through that firewall instead of hitting the bridge — the firewall answers 405
// + an HTML "connection required" page, so `probeHealth`'s `!res.ok` counted a LIVE, connected bridge as
// "not linked". Loopback must never be proxied, so we make sure the loopback hosts are in `NO_PROXY`
// (Bun reads it per-request, so setting it at runtime works) before the real probe fetch. Additive +
// idempotent: we only ADD loopback hosts, never touch/remove existing exemptions, and external fetches
// (Google/Slack connectors) still go through the proxy untouched.

/** Ensure the loopback hosts are proxy-exempt in `NO_PROXY`/`no_proxy` (idempotent, additive). */
export function ensureLoopbackNoProxy(env: Record<string, string | undefined> = process.env): void {
  const LOOPBACK = ["127.0.0.1", "localhost", "::1"];
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const have = new Set(
      (env[key] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    let changed = false;
    for (const host of LOOPBACK) {
      if (!have.has(host)) {
        have.add(host);
        changed = true;
      }
    }
    if (changed) env[key] = [...have].join(",");
  }
}

/** The real transport for the loopback health probe: bypass the sandbox proxy, then plain `fetch`. */
function loopbackFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  ensureLoopbackNoProxy();
  return fetch(input, init);
}

function resolve(deps: BridgeDeps) {
  return {
    spawn: deps.spawn ?? realSpawn,
    runSpawn: deps.runSpawn ?? realRunSpawn,
    listenerPid: deps.listenerPid ?? realListenerPid,
    isAlive: deps.isAlive ?? realIsAlive,
    kill: deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal)),
    readPidfile: deps.readPidfile ?? realReadPidfile,
    writePidfile:
      deps.writePidfile ?? ((path: string, pid: number) => writeFileSync(path, `${pid}\n`, "utf8")),
    removePidfile: deps.removePidfile ?? ((path: string) => rmSync(path, { force: true })),
    binExists: deps.binExists ?? existsSync,
    fetch: deps.fetch ?? (loopbackFetch as typeof fetch),
    execPathOf: deps.execPathOf ?? realExecPathOf,
    realpath: deps.realpath ?? realRealpath,
    readLogTail: deps.readLogTail ?? ((path: string) => realReadLogTail(path)),
    logMtime: deps.logMtime ?? realLogMtime,
    processStartedAt: deps.processStartedAt ?? realProcessStartedAt,
    lastMessageAt: deps.lastMessageAt ?? realLastMessageAt,
    pairedDeviceCount: deps.pairedDeviceCount ?? realPairedDeviceCount,
  };
}

/**
 * The pid recorded for this bridge: the per-port pidfile, else the pre-310 shared one (310). Reading the
 * legacy file is what keeps a bridge that was STARTED before this change findable by `stop` and `status`
 * instead of being orphaned by its own upgrade.
 */
function recordedPid(cfg: BridgeConfig, d: ReturnType<typeof resolve>): number | null {
  return recordedPidFrom(cfg, d).pid;
}

/**
 * The recorded pid AND the file it came from. The path is not decoration: every signal in this module says
 * what was actually read, and reporting the per-port file while the value came from the legacy one sends
 * the reader to `cat` an empty path — the same class of small lie the provenance lines exist to avoid.
 */
function recordedPidFrom(
  cfg: BridgeConfig,
  d: ReturnType<typeof resolve>,
): { pid: number | null; path: string } {
  const own = d.readPidfile(cfg.pidPath);
  if (own) return { pid: own, path: cfg.pidPath };
  const legacy = d.readPidfile(cfg.legacyPidPath);
  if (legacy) return { pid: legacy, path: cfg.legacyPidPath };
  return { pid: null, path: cfg.pidPath };
}

/** The pid of our running bridge — from the pidfile if that process is alive, else null. */
function ourRunningPid(cfg: BridgeConfig, d: ReturnType<typeof resolve>): number | null {
  const pid = recordedPid(cfg, d);
  return pid && d.isAlive(pid) ? pid : null;
}

/**
 * The bridge's log tail: the per-port log, else the pre-310 shared one (310). A bridge started before this
 * change holds an open fd on the legacy file, so its own logged-in line lives there — and that line is the
 * only DIRECT reading of the session anyone has.
 */
function bridgeLogTail(
  cfg: BridgeConfig,
  d: ReturnType<typeof resolve>,
): { tail: string | null; path: string; mtime: string | null } {
  // The mtime travels WITH the path it belongs to, for the same reason the path travels at all: reporting
  // the per-port file's age beside a legacy file's line would be a small lie of exactly the kind the
  // provenance lines exist to avoid (1347).
  const own = d.readLogTail(cfg.logPath);
  if (own !== null) return { tail: own, path: cfg.logPath, mtime: d.logMtime(cfg.logPath) };
  const legacy = d.readLogTail(cfg.legacyLogPath);
  if (legacy !== null) return { tail: legacy, path: cfg.legacyLogPath, mtime: d.logMtime(cfg.legacyLogPath) };
  return { tail: null, path: cfg.logPath, mtime: d.logMtime(cfg.logPath) };
}

// ── a pid match is not a foreign pid (#119, fault A) ──────────────────────────────────────────────
// The port guard used to call ANY listener on the port "a foreign process", so our OWN bridge - the very
// process the caller wanted running, pid recorded in our pidfile - was reported as a conflict to go and
// kill. Two identities have to be checked before that word is used: the pid we recorded at start, and
// the executable the listener is actually running. Only when NEITHER matches is it foreign.
//
// The exec-path comparison carries the same trap the process probe in `spinoff.ts` hit: a
// RUNNING process reports its PHYSICAL path, so a bridge under `/var/...` reports `/private/var/...` on
// macOS. Both sides go through realpath (and, as a last resort, a `/private` prefix strip) before they
// are compared, or an identical binary reads as two different ones.

/** Do two paths denote the same file? Compared raw, canonicalised, and `/private`-normalised. */
export function samePath(a: string, b: string, realpath: (p: string) => string): boolean {
  if (!a || !b) return false;
  const strip = (p: string) => (p.startsWith("/private/") ? p.slice("/private".length) : p);
  const forms = (p: string) => {
    const real = realpath(p);
    return new Set([p, real, strip(p), strip(real)]);
  };
  const left = forms(a);
  for (const form of forms(b)) if (left.has(form)) return true;
  return false;
}

/** Who holds the bridge port: nobody, our own bridge (with the evidence), or a genuinely foreign process. */
export type PortOccupant =
  | { kind: "none"; pid: null }
  | { kind: "ours"; pid: number; evidence: "pidfile" | "exec-path" }
  | { kind: "foreign"; pid: number; execPath: string | null };

/**
 * Classify whatever is LISTENing on the bridge port against our own identity - the pid in our pidfile
 * first, then the listener's executable vs `cfg.bin` (canonicalised, see `samePath`). "foreign" is only
 * returned when neither identity matches, so our own pid can never be reported as a foreign one (#119).
 */
export function classifyPortOccupant(cfg: BridgeConfig, deps: BridgeDeps = {}): PortOccupant {
  const d = resolve(deps);
  const occupant = d.listenerPid(cfg.port);
  if (!occupant) return { kind: "none", pid: null };
  const recorded = recordedPid(cfg, d);
  if (recorded && recorded === occupant) return { kind: "ours", pid: occupant, evidence: "pidfile" };
  const execPath = d.execPathOf(occupant);
  if (execPath && samePath(execPath, cfg.bin, d.realpath)) {
    return { kind: "ours", pid: occupant, evidence: "exec-path" };
  }
  return { kind: "foreign", pid: occupant, execPath };
}

export interface StartResult {
  started: boolean;
  alreadyRunning: boolean;
  pid: number;
  port: number;
  logPath: string;
}

/** The refusal message for a port held by a process that is provably not ours. */
function foreignPortError(cfg: BridgeConfig, occupant: { pid: number; execPath: string | null }) {
  const what = occupant.execPath ? ` running ${occupant.execPath}` : "";
  return new AppError(
    `port ${cfg.port} is already in use by pid ${occupant.pid}${what}, which is not our bridge ` +
      `(neither our pidfile nor ${cfg.bin}) - free it or point whatsapp_bridge_url at another port`,
  );
}

/**
 * Start the bridge (idempotent). If our pidfile points at a live process → no-op. Otherwise: refuse if
 * the binary is missing or the port is held by a process that is provably NOT ours (the 8080
 * collision), then spawn it detached with cwd = the binary's dir and a proxy-stripped env (see
 * `bridgeSpawnEnv`) carrying `WHATSAPP_BRIDGE_PORT` = the parsed port, and write the pidfile. Throws a
 * clean AppError on the two refusal cases.
 *
 * A port held by OUR OWN bridge (pidfile pid, or a listener running `cfg.bin`) is `alreadyRunning`, never
 * a conflict (#119) - a stale/missing pidfile is adopted by rewriting it to the verified pid so the next
 * `stop`/`status` finds it.
 */
export function startBridge(cfg: BridgeConfig, deps: BridgeDeps = {}): StartResult {
  const d = resolve(deps);

  const mine = ourRunningPid(cfg, d);
  if (mine) {
    return { started: false, alreadyRunning: true, pid: mine, port: cfg.port, logPath: cfg.logPath };
  }

  if (!d.binExists(cfg.bin)) {
    throw new AppError(
      `WhatsApp bridge binary not found at ${cfg.bin} — build it (whatsapp-mcp) or set config whatsapp_bridge_bin`,
    );
  }

  const occupant = classifyPortOccupant(cfg, deps);
  if (occupant.kind === "ours") {
    d.writePidfile(cfg.pidPath, occupant.pid);
    return {
      started: false,
      alreadyRunning: true,
      pid: occupant.pid,
      port: cfg.port,
      logPath: cfg.logPath,
    };
  }
  if (occupant.kind === "foreign") throw foreignPortError(cfg, occupant);

  const env = { ...bridgeSpawnEnv(process.env), WHATSAPP_BRIDGE_PORT: String(cfg.port) };
  const pid = d.spawn([cfg.bin], { cwd: cfg.cwd, env, logPath: cfg.logPath, detached: true });
  d.writePidfile(cfg.pidPath, pid);
  return { started: true, alreadyRunning: false, pid, port: cfg.port, logPath: cfg.logPath };
}

/**
 * Run the bridge in the FOREGROUND (the daemon-supervised mode, `whatsapp bridge run`) — the `ob web`
 * model. Same guards as `start` (missing binary / foreign port-in-use), same cwd + proxy-stripped env
 * with `WHATSAPP_BRIDGE_PORT` (see `bridgeSpawnEnv`) + log, but spawns the child tied to THIS process
 * and returns a handle whose `exited` the caller awaits,
 * so `ob` stays alive exactly as long as the bridge does. NOT idempotent (blocking is the whole point) —
 * launchd's KeepAlive supervises the real process, so a crash restarts it immediately with no polling.
 * The pidfile is written (so `stop`/`status` still work) and removed when the child exits.
 *
 * This is the path that used to shout "a foreign process holds it" at our own pid on every KeepAlive
 * retry (#119): it has no idempotent early-out (blocking is the point), so the occupant check is the only
 * thing standing between the caller and a wrong answer. It now names the occupant truthfully.
 *
 * Finding our OWN bridge already up is a NO-OP, not an error (221). It used to throw, so every KeepAlive
 * relaunch onto a healthy bridge exited non-zero and the job-health table read 82 consecutive failures
 * whose message was "nothing to do": the first alert the tracker ever raised was noise about a bridge
 * that was working. The caller still gets told what was found; only the exit code changed.
 */
export function runBridge(cfg: BridgeConfig, deps: BridgeDeps = {}): RunOutcome {
  const d = resolve(deps);

  if (!d.binExists(cfg.bin)) {
    throw new AppError(
      `WhatsApp bridge binary not found at ${cfg.bin} — build it (whatsapp-mcp) or set config whatsapp_bridge_bin`,
    );
  }
  const occupant = classifyPortOccupant(cfg, deps);
  if (occupant.kind === "ours") {
    // Nothing is written: a no-op relaunch leaves the running bridge's own state exactly as it found it,
    // and `start` is still the path that adopts a verified pid into a stale pidfile.
    return {
      alreadyRunning: true,
      pid: occupant.pid,
      note:
        `our WhatsApp bridge is already up on port ${cfg.port} (pid ${occupant.pid}, matched by ` +
        `${occupant.evidence === "pidfile" ? "our pidfile" : "its executable path"}) - nothing to do; ` +
        `\`ob whatsapp bridge status\` reports whether it is authenticated, \`stop\` frees the port`,
    };
  }
  if (occupant.kind === "foreign") throw foreignPortError(cfg, occupant);

  const env = { ...bridgeSpawnEnv(process.env), WHATSAPP_BRIDGE_PORT: String(cfg.port) };
  const handle = d.runSpawn([cfg.bin], { cwd: cfg.cwd, env, logPath: cfg.logPath });
  d.writePidfile(cfg.pidPath, handle.pid);
  const exited = handle.exited.finally(() => d.removePidfile(cfg.pidPath));
  return { ...handle, exited, alreadyRunning: false };
}

/**
 * What `run` did: either it owns a live child to block on, or our bridge was already up and there is
 * nothing to block on. `alreadyRunning` is the discriminant so a caller cannot await an `exited` that
 * does not exist.
 */
export type RunOutcome =
  | ({ alreadyRunning: false } & RunHandle)
  | { alreadyRunning: true; pid: number; note: string };

export interface StopResult {
  stopped: boolean;
  pid: number | null;
}

/**
 * Stop the bridge: kill the pidfile process if alive, else the port's listener - but only when that
 * listener is verifiably OURS (#119). A foreign process holding the port is left alone; `stop` used to
 * kill whoever answered on it.
 */
export function stopBridge(cfg: BridgeConfig, deps: BridgeDeps = {}): StopResult {
  const d = resolve(deps);
  const occupant = classifyPortOccupant(cfg, deps);
  const pid = ourRunningPid(cfg, d) ?? (occupant.kind === "ours" ? occupant.pid : null);
  // BOTH pidfiles are cleared (310): leaving the legacy one behind would keep naming a process that is
  // gone, and `recordedPid` falls back to it — so the next status read would resurrect a dead pid.
  const forget = () => {
    d.removePidfile(cfg.pidPath);
    d.removePidfile(cfg.legacyPidPath);
  };
  if (!pid) {
    forget();
    return { stopped: false, pid: null };
  }
  d.kill(pid, "SIGTERM");
  forget();
  return { stopped: true, pid };
}

// ── port-open is not logged-in (#119, fault B) ────────────────────────────────────────────────────
// A listening socket used to be reported as a healthy bridge. whatsmeow happily listens while its saved
// session is REJECTED ("invalid use of deleted device" after the account is re-registered on a new
// phone), so ob said "up", the sync job said "0 new" every minute, and nothing had been ingested for
// hours. A false healthy is worse than a false red: it sends nobody to look.
//
// The bridge exposes NO auth-state endpoint. `/api/health` returns
// `{"status":"ok"|"disconnected","connected":client.IsConnected(),"timestamp":N}` (whatsapp-bridge
// main.go) - and `IsConnected()` is the whatsmeow WEBSOCKET TRANSPORT, not `IsLoggedIn()`. So
// `connected:true` is itself a proxy signal and cannot, on its own, mean authenticated.
//
// So the verdict is assembled from the honest signals that exist locally, each recorded in
// `BridgeStatus.signals` with what it does and does NOT prove:
//   1. pidfile / port listener       → the process exists. Proves nothing about the session.
//   2. GET /api/health `connected`   → transport connectivity at probe time. Not login state.
//   3. the bridge's own log tail     → the DIRECT reading: whatsmeow prints "invalid use of deleted
//                                      device" / "logged out" / the QR prompt itself. Decisive when
//                                      present, absent when the log rotated.
//   4. store/whatsapp.db devices     → a pairing row EXISTS. The deleted-device case keeps that row, so
//                                      it can never prove the pairing is still valid.
//   5. store/messages.db newest row  → ingestion WAS live at that timestamp. Silence does not prove
//                                      logged-out (a quiet night looks identical), so staleness is
//                                      reported, never used to downgrade the verdict.
// Everything unresolved lands in "unknown", which is its own answer: never folded into healthy, never
// into down. Re-pairing is HITL - ob only ever prints the instructions.

/** The four distinct answers. "unknown" is a real answer, not a synonym for either healthy or down. */
export type BridgeHealth = "down" | "unauthenticated" | "healthy" | "unknown";

/** What `/api/health` said: transport up, transport down, or no usable answer at all. */
export type HealthProbe = "connected" | "disconnected" | "unreachable";

/** What the bridge's own log last said about the session - the only direct auth reading available. */
export type LogVerdict =
  | "client-outdated"
  | "deleted-device"
  | "logged-out"
  | "awaiting-qr"
  | "logged-in"
  | "silent";

export interface BridgeStatus {
  running: boolean;
  pid: number | null;
  port: number;
  /**
   * how we found the process: our pidfile, a listener verified to be running `cfg.bin`, an unverified
   * port listener, or nothing. "port" is explicitly NOT a claim that the listener is our bridge.
   */
  source: "pidfile" | "exec-path" | "port" | null;
  /** the verdict - the only field that should drive a red/green readout. */
  health: BridgeHealth;
  /** raw `/api/health` reading (transport only); "unreachable" when down or unanswered. */
  probe: HealthProbe;
  /** the newest auth-relevant line in the bridge log, or "silent" when there is none. */
  log: LogVerdict;
  /**
   * Whether that line is older than this run (the log's newest write predates the process, or nothing has
   * been written for an hour). A stale line is not a report of the current session (1347).
   */
  logStale: boolean;
  /** rows in the pairing store, else null - presence never proves the pairing still works. */
  pairedDevices: number | null;
  /** ISO timestamp of the newest ingested message, else null - evidence of ingestion, not of health. */
  lastMessageAt: string | null;
  /** plain-language provenance: what was read, and what it does not prove. */
  signals: string[];
  /** human instructions when action is needed (never performed by ob). */
  remedy: string | null;
}

// ── a REFUSED client is a cause, not silence (1347) ───────────────────────────────────────────────
// For 13 days `ob creds check whatsapp` answered UNKNOWN while the log's newest lines named the cause
// outright: `<failure location="lla" reason="405"/>`, `[Client ERROR] Client outdated (405) connect
// failure (client version: 2.3000.1040847988)` and `[Client ERROR] please update whatsmeow library`.
// The classifier knew only the SESSION verdicts, so it read straight past all three and stopped on an
// OLDER `✓ Connected to WhatsApp!` - a success line, reported as the CURRENT state of a bridge WhatsApp
// was refusing to accept. WhatsApp had bumped the client version it will accept, our whatsmeow pin had
// gone stale, and the check's own remedy ("re-link it - stop the bridge, move the store aside, start it,
// scan the QR") would have thrown away a pairing that was perfectly FINE.
//
// Cause and cure are one thing here, and it was MEASURED on 2026-10-18: pin `v0.0.0-20260604205742`
// (a June build, go.mod line 8) produced exactly that 405 block; `go get go.mau.fi/whatsmeow@latest`
// (→ v0.0.0-20261017175727) plus a re-run of the bridge build script, the new binary
// moved over the old one, took /api/health from `connected:false` to `connected:true` and the ingest
// cursor from 2026-10-05 to 2026-10-17 inside 90 seconds. So this class RECURS whenever WhatsApp bumps
// the requirement, the remedy is a REBUILD, and re-pairing is the wrong cure.
const CLIENT_OUTDATED = /\bclient outdated\b|please update whatsmeow|reason="405"/i;

/**
 * Classify the newest auth-relevant line in the bridge's log tail. Scanned in REVERSE so the most recent
 * decisive line wins - a successful login after a QR prompt or a dead-session loop supersedes it, and a
 * 405 refusal printed by the current process supersedes the login line that preceded it.
 */
export function classifyBridgeLog(tail: string | null): LogVerdict {
  if (!tail) return "silent";
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (CLIENT_OUTDATED.test(line)) return "client-outdated";
    if (/invalid use of deleted device/i.test(line)) return "deleted-device";
    if (/logged out|401.*logged.?out|device[_ ]removed/i.test(line)) return "logged-out";
    if (/scan (this|the) qr|qr code/i.test(line)) return "awaiting-qr";
    if (/successfully (logged in|paired|connected)|logged in as|connected to whatsapp/i.test(line)) {
      return "logged-in";
    }
  }
  return "silent";
}

// ── recency is evidence (1347) ─────────────────────────────────────────────────────────────────────
// The log has no dates on its auth lines (`22:19:17.097 [Client INFO] ...`), and it is APPENDED across
// restarts, so a line in it can be older than the process reading it. Two proofs are available without
// inventing a timestamp, and either one is enough:
//
//   1. the log file's own mtime PREDATES the running process - nothing in it was written by this run
//      (a bridge that starts at all logs within the second; the file is opened in append mode, which
//      does not touch mtime, so a fresh mtime really does mean a line was written);
//   2. nothing has been written to it for a whole hour - a live bridge writes socket traffic every ~20s.
//
// The distinction that matters: a *success* line ("logged-in") is a claim about NOW and decays, so a
// stale one is not a report of the current session and must never outvote a disconnected probe. A
// *refusal* line (405, deleted device) is a property of the code and the stored device, and it stands
// until something changes them - which is why the 405 diagnosis survives a stale log. That asymmetry is
// the measured case: the refused bridge's log had not been touched in 13 days.
//
// Unknown recency is NOT stale: an unreadable mtime or an unreadable process start must leave the
// verdict exactly as it was, never manufacture a downgrade.

/** How long a log may go unwritten before its lines stop describing the present. */
export const LOG_STALE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Is the log's newest write old enough that no line in it can be a report of the current session?
 * `mtime` is the log file's mtime and `processStart` the running bridge's start, both ISO or null.
 */
export function logIsStale(
  mtime: string | null,
  processStart: string | null,
  now: number = Date.now(),
): boolean {
  if (!mtime) return false;
  const written = Date.parse(mtime);
  if (!Number.isFinite(written)) return false;
  if (now - written > LOG_STALE_WINDOW_MS) return true;
  if (processStart) {
    const started = Date.parse(processStart);
    if (Number.isFinite(started) && written < started) return true;
  }
  return false;
}

/**
 * Is the bridge actively trying to (re)connect? Not an auth verdict - a liveness hint, used to tell a
 * transient reconnect loop from a session that has stopped being spoken about at all. Read separately
 * from `classifyBridgeLog` on purpose: the #119 fixture is a reconnect loop whose DECISIVE line is the
 * deleted-device error, so a reconnect class inside the verdict would mask a dead session.
 */
const RECONNECT_LOOP = /attempting to reconnect|reconnect(ion)? (failed|attempt)|connection attempt \d+\/\d+/i;

export function logShowsReconnectLoop(tail: string | null): boolean {
  if (!tail) return false;
  return tail.split(/\r?\n/).some((line) => RECONNECT_LOOP.test(line));
}

/** The remedy text for a dead pairing - instructions for a human; ob never re-pairs anything itself. */
function relinkRemedy(cfg: BridgeConfig, verdict: LogVerdict): string {
  if (verdict === "deleted-device") {
    return (
      `the saved session points at a device WhatsApp has deleted, so retrying cannot work - stop the ` +
      `bridge, move ${cfg.pairingDbPath} aside, start it, then tail ${cfg.logPath} and scan the QR`
    );
  }
  return `tail ${cfg.logPath} and scan the QR to re-link`;
}

/**
 * The remedy for a bridge WhatsApp refuses to ACCEPT (405 "Client outdated"). Deliberately not
 * `relinkRemedy`: the session is fine, so moving the store aside and scanning a new QR would throw away
 * a working pairing and fix nothing. The fix is the one that was measured - bump the whatsmeow pin and
 * rebuild - and it names the binary so a reader with more than one bridge knows which one is refused.
 */
function clientOutdatedRemedy(cfg: BridgeConfig): string {
  return (
    `WhatsApp answered "Client outdated (405)", so the whatsmeow library this bridge (${cfg.bin}) was` +
    ` built against is older than the client version WhatsApp now accepts. Bump the pin` +
    ` (go get go.mau.fi/whatsmeow@latest), rebuild with the bridge build script, and` +
    ` restart the bridge. The session is FINE - the pairing is not the problem, and a new pairing cannot` +
    ` fix a refused client`
  );
}

/**
 * Report status. Running? (our pidfile → a listener verified by exec path), on which port, and then the
 * verdict assembled from every local signal available - see the block comment above. A listener we cannot
 * identify is not our bridge and is answered separately (1936). Read-only: one loopback probe of our own
 * bridge plus local file reads, never a call to WhatsApp.
 */
export async function bridgeStatus(cfg: BridgeConfig, deps: BridgeDeps = {}): Promise<BridgeStatus> {
  const d = resolve(deps);
  const { path: pidRead } = recordedPidFrom(cfg, d);
  const minePid = ourRunningPid(cfg, d);
  const occupant = minePid ? null : classifyPortOccupant(cfg, deps);
  const pid = minePid ?? occupant?.pid ?? null;
  // No "port" arm here: a foreign occupant returns below and its source is set there (1936).
  const source: BridgeStatus["source"] = minePid
    ? "pidfile"
    : occupant?.kind === "ours"
      ? "exec-path"
      : null;
  // A FOREIGN LISTENER IS NOT OUR BRIDGE (1936); it is answered below, before anything is probed.
  const foreign = occupant?.kind === "foreign" ? occupant : null;

  const lastMessageAt = d.lastMessageAt(cfg.messagesDbPath);
  const pairedDevices = d.pairedDeviceCount(cfg.pairingDbPath);

  // A FOREIGN LISTENER IS NOT OUR BRIDGE (1936), so it gets its own answer, decided before anything is
  // probed: nothing of ours is running, and no answer that process gives is evidence about our WhatsApp
  // session - so we do not even ask it, since a `GET /api/health` would carry OUR bridge bearer to a
  // stranger. The pid is reported because it is what holds the port. Before this, any program on the port
  // was `running: true`, and a `connected:true` answer from it made the whole status `healthy`.
  if (foreign) {
    return {
      running: false,
      pid: foreign.pid,
      port: cfg.port,
      source: "port",
      health: "unknown",
      probe: "unreachable",
      log: "silent",
      logStale: false,
      pairedDevices,
      lastMessageAt,
      signals: [
        `pid ${foreign.pid} holds :${cfg.port}${foreign.execPath ? ` (running ${foreign.execPath})` : ""}` +
          ` but it is neither our pidfile's process nor ${cfg.bin} - it may not be our bridge at all`,
        `nothing of ours is running, and whatever holds the port was not asked about the session: an answer` +
          ` from a process we cannot identify would not be about our bridge`,
        ...pairingSignal(cfg, pairedDevices),
        ...ingestSignal(lastMessageAt),
      ],
      remedy: foreignPortError(cfg, foreign).message,
    };
  }

  if (!pid) {
    return {
      running: false,
      pid: null,
      port: cfg.port,
      source: null,
      health: "down",
      probe: "unreachable",
      log: "silent",
      logStale: false,
      pairedDevices,
      lastMessageAt,
      signals: [
        `no live pid in ${cfg.pidPath} (nor the pre-310 ${cfg.legacyPidPath}) and nothing LISTENing on` +
          ` :${cfg.port} - the bridge is not running` +
          ` (this does not prove the binary is missing, only that no process is up)`,
        ...pairingSignal(cfg, pairedDevices),
        ...ingestSignal(lastMessageAt),
      ],
      remedy: "run `ob whatsapp bridge start`",
    };
  }

  let probe: HealthProbe;
  try {
    const token = deps.readToken ? await deps.readToken() : null;
    probe = await probeHealth(cfg, d.fetch, token);
  } catch {
    probe = "unreachable";
  }
  const { tail, path: logRead, mtime: logWrittenAt } = bridgeLogTail(cfg, d);
  const log = classifyBridgeLog(tail);
  const logStale = logIsStale(logWrittenAt, d.processStartedAt(pid));

  const signals: string[] = [
    source === "pidfile"
      ? `pid ${pid} from ${pidRead} is alive - the process exists; that alone proves nothing about` +
        ` the WhatsApp session`
      : `pid ${pid} holds :${cfg.port} and is running ${cfg.bin} - verifiably our bridge, but a running` +
        ` process still proves nothing about the WhatsApp session`,
    probe === "connected"
      ? `GET /api/health answered connected:true - the bridge's whatsmeow WEBSOCKET is up. The bridge` +
        ` exposes no login state, so this does NOT prove the WhatsApp session is authenticated`
      : probe === "disconnected"
        ? `GET /api/health answered connected:false - the whatsmeow websocket is down. That could be a` +
          ` transient reconnect or a dead session; the endpoint cannot tell us which`
        : `GET /api/health gave no usable answer (unreachable, non-2xx without JSON, or an unknown` +
          ` payload) - nothing about the session can be read from it`,
    ...logSignal(logRead, log, logStale, logWrittenAt),
    ...pairingSignal(cfg, pairedDevices),
    ...ingestSignal(lastMessageAt),
  ];

  // The log is the only DIRECT reading of the session, so it outranks the transport probe in both
  // directions: a dead pairing is unauthenticated even while the socket reconnects (exactly the #119
  // case), and an unanswered probe over a healthy log is still only "unknown".
  //
  // A 405 is the third direction (1347): the client is refused, so the session cannot be reached at all
  // and nothing can be ingested - and because a refusal is a fact about the code rather than a claim
  // about the present, it keeps its verdict even from a log nobody has written to in days (`logIsStale`).
  if (log === "client-outdated" || log === "deleted-device" || log === "logged-out" || log === "awaiting-qr") {
    return {
      running: true,
      pid,
      port: cfg.port,
      source,
      health: "unauthenticated",
      probe,
      log,
      logStale,
      pairedDevices,
      lastMessageAt,
      signals,
      remedy: log === "client-outdated" ? clientOutdatedRemedy(cfg) : relinkRemedy(cfg, log),
    };
  }

  const health: BridgeHealth = probe === "connected" ? "healthy" : "unknown";
  return {
    running: true,
    pid,
    port: cfg.port,
    source,
    health,
    probe,
    log,
    logStale,
    pairedDevices,
    lastMessageAt,
    signals,
    remedy:
      health === "healthy"
        ? null
        : cannotAskRemedy(cfg, {
            stale: logStale,
            writtenAt: logWrittenAt,
            reconnectLoop: logShowsReconnectLoop(tail),
          }),
  };
}

/** The log signal: what the newest auth line says, and whether it is a statement about NOW (1347). */
function logSignal(
  path: string,
  verdict: LogVerdict,
  stale: boolean,
  writtenAt: string | null,
): string[] {
  if (verdict === "silent") {
    return [
      `no auth-relevant line in the tail of ${path} - absence of the error is not evidence the` +
        ` session is good (the log may have rotated past it)`,
    ];
  }
  if (verdict === "client-outdated") {
    // The cause is named in THIS line rather than one of its own, because the machine-only doctor
    // (`ops/hermes/scripts/whatsapp-bridge.sh`) pushes the first three signals as the body of its alert
    // and every WhatsApp outage trips the same `probe != connected` trigger: what separates this one is
    // that the pairing is fine and the CLIENT is too old, so that has to be inside the first three.
    const age = stale
      ? ` (that line was written ${writtenAt}, before this run - it is not a report of the current` +
        ` session, but a refused client does not recover by itself)`
      : "";
    return [
      `the newest auth-relevant line in ${path} reads "client-outdated": WhatsApp refuses this bridge's` +
        ` CLIENT version (405; its own error line says "please update whatsmeow library"), so the CAUSE` +
        ` is the bridge's whatsmeow version, NOT the session. Fix: bump go.mau.fi/whatsmeow and rebuild` +
        ` with the bridge build script - re-pairing cannot help${age}`,
    ];
  }
  if (stale) {
    return [
      `the newest auth-relevant line in ${path} reads "${verdict}", but nothing has been written to that` +
        ` log since ${writtenAt} - it PREDATES the running bridge, so it is not a report of the current` +
        ` session and does not outvote the probe`,
    ];
  }
  return [
    `the newest auth-relevant line in ${path} reads "${verdict}" - this is whatsmeow's own direct` +
      ` report of the session state`,
  ];
}

/**
 * The remedy when there is no verdict at all, in three distinct situations - because "I cannot tell"
 * has three very different actions behind it, and the old text pointed at the wrong one for two of them:
 *
 *  - a log nobody has written to recently means the bridge has stopped talking about itself. Watch it;
 *    the last line in the file is history, and acting on it is the 1347 mistake.
 *  - a FRESH reconnect loop while the transport is down is transient (WhatsApp answers 503 while it
 *    retries), so the action is to retry, not to throw the pairing away.
 *  - everything else keeps the honest cannot-ask answer, unchanged.
 */
function cannotAskRemedy(
  cfg: BridgeConfig,
  state: { stale: boolean; writtenAt: string | null; reconnectLoop: boolean },
): string {
  if (state.stale) {
    return (
      `cannot confirm the session - and ${cfg.logPath} has not been written to since ${state.writtenAt},` +
      ` so nothing in it describes the running bridge. Watch /api/health and tail the log for a FRESH` +
      ` line before acting; its last auth line is history`
    );
  }
  if (state.reconnectLoop) {
    return (
      `the bridge is up, its log is still being written and its session is not connected: that is the` +
      ` shape of a transient reconnect (WhatsApp answers 503 while a client retries) - retry in a` +
      ` minute, and only re-pair if it stays disconnected`
    );
  }
  return (
    `cannot confirm the session - tail ${cfg.logPath}; if it is looping on a reconnect error, re-link it` +
    ` (${relinkRemedy(cfg, "deleted-device")})`
  );
}

/**
 * One-line readout of a status. "healthy" is qualified by the evidence that carried it: only whatsmeow's
 * own logged-in line earns the word "authenticated" - with a silent log the headline says what was
 * actually read (a connected socket, no auth error) rather than dressing the inference up as a reading.
 */
export function bridgeStatusHeadline(s: BridgeStatus): string {
  const at = `:${s.port} (pid ${s.pid})`;
  // A listener we could not identify is not our bridge (1936), so the honest headline is that ours is
  // down and something else is holding the port - never "UNKNOWN, a process is up", which read as ours.
  if (s.health === "unknown" && s.source === "port") {
    return `whatsapp bridge DOWN on :${s.port} - pid ${s.pid} holds the port but is not our bridge`;
  }
  switch (s.health) {
    case "down":
      return `whatsapp bridge DOWN on :${s.port}`;
    case "unauthenticated":
      // The cause, named, whenever the log names one - an "outdated client" is not the re-pairing story.
      return s.log === "client-outdated"
        ? `whatsapp bridge NOT AUTHENTICATED on ${at} - WhatsApp refused this bridge's CLIENT as outdated` +
            ` (405 Client outdated); the session itself is fine`
        : `whatsapp bridge NOT AUTHENTICATED on ${at} - running, but nothing can be ingested`;
    case "healthy":
      // A stale logged-in line cannot earn the word "authenticated": it is not a report of this run.
      if (s.log === "logged-in" && !s.logStale) {
        return `whatsapp bridge healthy on ${at} - whatsmeow reports logged in`;
      }
      if (s.logStale) {
        return `whatsapp bridge healthy on ${at} - connected, and the only auth line in the log predates the running bridge, so the login was not read`;
      }
      return `whatsapp bridge healthy on ${at} - connected, no auth error in the log (the login itself was not directly read)`;
    case "unknown":
      return `whatsapp bridge UNKNOWN on ${at} - a process is up; its session state could not be read`;
  }
}

/** Provenance line for the pairing store - it can only ever prove a session row EXISTS. */
function pairingSignal(cfg: BridgeConfig, count: number | null): string[] {
  if (count === null) {
    return [
      `could not read the pairing store ${cfg.pairingDbPath} - whether a session was ever stored is` +
        ` unknown`,
    ];
  }
  if (count === 0) return [`the pairing store ${cfg.pairingDbPath} holds no device - never linked`];
  return [
    `the pairing store ${cfg.pairingDbPath} holds ${count} device row(s) - a session was stored once.` +
      ` A deleted-device rejection LEAVES that row, so this cannot prove the pairing still works`,
  ];
}

/** Provenance line for ingestion freshness - evidence of past ingest, never a verdict on health. */
function ingestSignal(lastMessageAt: string | null): string[] {
  if (!lastMessageAt) {
    return [
      `no rows in the bridge's messages.db - nothing has ever been ingested (or the store is unreadable)`,
    ];
  }
  const ageMin = Math.round((Date.now() - Date.parse(lastMessageAt)) / 60000);
  return [
    `the newest message in the bridge's messages.db is ${lastMessageAt} (${ageMin}m ago) - ingestion was` +
      ` live at that moment. Silence since then does not prove logged-out; a quiet chat looks the same`,
  ];
}

/**
 * GET /api/health with the bearer → the transport reading. The body is parsed even on a non-2xx, because
 * the bridge answers its own "disconnected" payload with a 503; a non-2xx WITHOUT a parseable payload
 * (e.g. the sandbox proxy's HTML 405, 183) is "unreachable", not "disconnected" - we did not reach the
 * bridge, so we learned nothing.
 */
async function probeHealth(
  cfg: BridgeConfig,
  doFetch: typeof fetch,
  token: string | null,
): Promise<HealthProbe> {
  const url = `${cfg.url.replace(/\/$/, "")}/api/health`;
  const res = await doFetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return readHealthBody(body);
}

/**
 * Tolerant read of the health body → the TRANSPORT reading only. The bridge's real payload is
 * `{"connected":<bool>,"status":"ok"|"disconnected","timestamp":N}` (main.go `/api/health`), so
 * `connected` is authoritative for connectivity - `status` is "ok" when up, never "connected". Other
 * truthy keys stay as tolerant fallbacks in case the bridge shape ever changes; a shape we cannot read at
 * all is "unreachable" (unknown), never a claim in either direction.
 */
export function readHealthBody(b: Record<string, unknown> | null): HealthProbe {
  if (!b || typeof b !== "object") return "unreachable";
  const truthy = (v: unknown) => v === true || v === "true";
  const falsy = (v: unknown) => v === false || v === "false";
  const s = typeof b.status === "string" ? b.status.toLowerCase() : "";
  // The explicit boolean outranks `status`: a `{connected:false,status:"ok"}` must never read connected.
  const flags = [b.connected, b.loggedIn, b.logged_in, b.linked];
  if (flags.some(truthy)) return "connected";
  if (flags.some(falsy)) return "disconnected";
  if (s === "connected" || s === "linked" || s === "ok") return "connected";
  if (s === "disconnected" || s === "unlinked") return "disconnected";
  return "unreachable";
}

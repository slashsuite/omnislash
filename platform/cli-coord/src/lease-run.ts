// `ob lease run <resource> -- <command...>` (OB-2071): hold one lease for as long as a command runs.
//
// The browser test runs (Storybook, Playwright) are the heaviest jobs on the desktop, and several of
// them at once overwhelm the CPU, so each takes the machine-wide `cpu:browser` slot first and waits for
// it. Doing that with `lease acquire --wait` and `lease release` by hand leaks the lease whenever the run
// is killed, so this wrapper acquires, keeps the lease alive while the child runs, and ALWAYS releases:
// normal exit, a failing command, Ctrl-C, SIGTERM. A run killed without a signal (a crash, kill -9)
// frees the slot when its TTL lapses.
//
// The lease calls arrive as a small interface so the same loop serves the local database (`cmdLease`)
// and the API client (`apiLease`).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { constants, homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import { isApiTransient } from "../../../apps/cli/src/api/client.ts";
import { apiOutageReporter, leaseHolderId, normalizeLeaseResource, tryAttempt } from "./lease.ts";
import { leaseWaitTitle, type LeaseWaitTitle } from "./lease-wait-title.ts";

/** A browser run is minutes long, so a crashed one should free the slot within five minutes. */
const LEASE_RUN_TTL_S = 300;
/**
 * The longest a `cpu:` run may hold its slot, counted from the grant (OB-2229): one long browser run held
 * `cpu:browser` while four others queued behind it. Longer work is split into several leased runs. Other
 * key classes have no cap unless `--max` sets one.
 */
export const LEASE_RUN_CPU_CAP_S = 600;
/** The largest `--max` a timer can hold (2^31-1 ms). */
const LEASE_RUN_MAX_CAP_S = 2_147_483;
/** The exit code of a run stopped at its cap, as `timeout` uses. */
export const LEASE_RUN_CAP_EXIT = 124;
/** Heartbeat well inside the TTL: five missed beats before the lease lapses. */
const LEASE_RUN_HEARTBEAT_MS = 60_000;
/** Poll the slot every 2 s while someone else holds it. */
const LEASE_RUN_POLL_MS = 2_000;
/**
 * A release that gets no answer from the ob API is retried this long, every LEASE_RUN_RELEASE_RETRY_MS
 * (OB-2157): a deploy restart refuses connections for a few seconds, and giving up at once leaves the slot
 * held, with nobody running, until its TTL lapses.
 */
const LEASE_RUN_RELEASE_WINDOW_MS = 60_000;
const LEASE_RUN_RELEASE_RETRY_MS = 2_000;
/**
 * Comma-separated resources the running `ob lease run` chain already holds. The child inherits it, so a
 * nested `ob lease run cpu:browser` (a script that wraps its own browser step, run under a wrapped
 * parent) runs its command straight away instead of queueing behind its own parent forever.
 */
const LEASE_RUN_HELD_ENV = "OB_LEASE_RUN_HELD";
const CAUGHT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
/** `0` never escapes T3's RLIMIT_RTTIME; `1` always does (tests); unset decides from the limit (OB-2161). */
const LEASE_RUN_ESCAPE_ENV = "OB_LEASE_RUN_ESCAPE";
/** A signalled escaped command gets this long to end before its unit is stopped outright. */
const ESCAPE_STOP_AFTER_MS = 10_000;
const SHIM = fileURLToPath(new URL("./lease-run-shim.ts", import.meta.url));

export interface LeaseRunIo {
  /** Acquire the lease, or refresh it when the caller already holds it (the same call is the heartbeat). */
  acquire(): Promise<{ ok: boolean; holder: string }>;
  /** Drop the lease; true when a row was released. */
  release(): Promise<boolean>;
}

export interface LeaseRunOptions {
  resource: string;
  holder: string;
  command: string[];
  io: LeaseRunIo;
  heartbeatMs: number;
  /** One line to stderr; the child's stdout stays clean. */
  log: (line: string) => void;
  /** How often to poll while someone else holds the lease (default 2 s); tests pass a small value. */
  pollMs?: number;
  /** How long to retry a release the ob API did not answer (default 60 s), and how often (default 2 s). */
  releaseWindowMs?: number;
  releaseRetryMs?: number;
  /** The thread-title marker for the wait (OB-2153); defaults to the T3 thread in `T3CODE_THREAD_ID`, if any. */
  title?: LeaseWaitTitle;
  /** Stop the command this many seconds after the grant and exit 124 (OB-2229); null or unset is no cap. */
  capS?: number | null;
}

const signalNumber = (sig: string | number | null | undefined): number | undefined =>
  typeof sig === "number" ? sig : sig ? (constants.signals as Record<string, number>)[sig] : undefined;

/**
 * Whether the terminal itself already delivers a Ctrl-C or hangup to the child: `ob` is in the terminal's
 * foreground process group, and the child inherited that group. Forwarding as well would signal the child
 * twice, and a second SIGINT makes many test runners skip their teardown, leaving browsers running after the
 * slot is released. Off a terminal, or outside its foreground group, the signal is forwarded.
 *
 * The one case this gets wrong: a `kill -INT <ob pid>` from elsewhere while `ob` is in a terminal's
 * foreground. The command is then not interrupted and `ob` holds the slot until it ends, which never lets two
 * runs overlap; forwarding always would make every Ctrl-C a double one, which can. SIGTERM, the signal a
 * supervisor or `timeout` sends to a pid, is always forwarded.
 */
function terminalSignalsChild(): boolean {
  try {
    const r = Bun.spawnSync(["ps", "-o", "pgid=,tpgid=", "-p", String(process.pid)], { stdout: "pipe", stderr: "ignore" });
    const [pgid, tpgid] = r.stdout.toString().trim().split(/\s+/).map(Number);
    return r.exitCode === 0 && (tpgid ?? -1) > 0 && pgid === tpgid;
  } catch {
    return false;
  }
}

/**
 * Whether this process's RLIMIT_RTTIME hard limit is finite (OB-2161). T3 Code runs with it at 0/0 and
 * every agent shell inherits it; at 0 the kernel SIGKILLs any process that arms a per-thread CPU-time
 * timer, which browsers do for their hang watchdogs. A child cannot raise a hard limit. Unreadable (no
 * /proc, not Linux) counts as unlimited.
 */
export function rttimeHardLimitFinite(limits?: string): boolean {
  let text = limits;
  if (text === undefined) {
    try {
      text = readFileSync("/proc/self/limits", "utf8");
    } catch {
      return false;
    }
  }
  const line = text.split("\n").find((l) => l.startsWith("Max realtime timeout"));
  const hard = line?.slice("Max realtime timeout".length).trim().split(/\s+/)[1];
  return hard !== undefined && hard !== "unlimited";
}

/**
 * Whether to start the command as a transient user service instead of a child (OB-2161): only a process
 * the user manager starts escapes T3's limit (a `--scope` unit stays a child of ob and keeps it). Only when
 * the limit is finite, `systemd-run` is on PATH and the shim is on disk, so macOS, CI, a shell outside T3
 * and a `lease run` nested inside an escaped one (which reads unlimited) all spawn exactly as before.
 */
export function shouldEscape(env: NodeJS.ProcessEnv = process.env, limits?: string): boolean {
  const setting = env[LEASE_RUN_ESCAPE_ENV];
  if (setting === "0") return false;
  if (!Bun.which("systemd-run") || !existsSync(SHIM)) return false;
  return setting === "1" || rttimeHardLimitFinite(limits);
}

/** The started command: a plain child, or `systemd-run` waiting on the unit that runs it. */
interface Started {
  child: ReturnType<typeof Bun.spawn>;
  unit?: string;
  envFile?: string;
}

/** The caller's environment for the shim: per-user tmpfs, owner-only, never an existing file. */
export function writeEnvFile(unit: string, env: Record<string, string | undefined>): string {
  const envFile = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `${unit}.env.json`);
  writeFileSync(envFile, JSON.stringify(env), { mode: 0o600, flag: "wx" });
  return envFile;
}

/**
 * Start the command as the unit `ob-lease-run-<pid>-<random>` through the shim (lease-run-shim.ts). The
 * service starts in the manager's environment, so the caller's goes in a 0600 file under
 * $XDG_RUNTIME_DIR that the shim deletes on start (`--setenv` would put tokens in `systemctl show`).
 * `systemd-run` gets its own session (`detached`): a terminal's Ctrl-C reaching it would stop the unit and
 * SIGTERM everything in it, so ob sends every signal itself (`signalUnit`). Its exit code is the shim's,
 * which is the command's. `--expand-environment=no`: systemd would otherwise rewrite `$$` and `${X}` in the argv.
 */
export function escapedArgv(unit: string, envFile: string, command: string[], capS: number | null = null): string[] {
  return [
    "systemd-run", "--user", "--wait", "--pipe", "--quiet", "--collect", "--same-dir", "--expand-environment=no",
    `--unit=${unit}`, "--property=TimeoutStopSec=10",
    // The cap's backstop (OB-2229): systemd stops the unit at the cap even if ob itself has died.
    ...(capS ? [`--property=RuntimeMaxSec=${capS}`] : []),
    "--", process.execPath, SHIM, envFile, String(process.pid), "--", ...command,
  ];
}

function startEscaped(command: string[], env: Record<string, string | undefined>, capS: number | null): Started {
  const unit = `ob-lease-run-${process.pid}-${randomBytes(4).toString("hex")}`;
  const envFile = writeEnvFile(unit, env);
  const argv = escapedArgv(unit, envFile, command, capS);
  try {
    const child = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: true });
    return { child, unit, envFile };
  } catch (err) {
    rmSync(envFile, { force: true });
    throw err;
  }
}

/** Fire-and-forget `systemctl --user`: a unit that already ended makes it fail, which is fine. */
function systemctl(args: string[]): void {
  try {
    Bun.spawn(["systemctl", "--user", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    // no systemctl: the shim's own watch on ob ends the command
  }
}

/**
 * `0` never goes through TaskSlash; a path uses that binary only; unset asks the `taskslash` on PATH, then
 * ~/.cargo/bin/taskslash, where TK-11 installs it (OB-2234, OB-2254).
 */
const LEASE_RUN_TASKSLASH_ENV = "OB_LEASE_RUN_TASKSLASH";
/** How long `taskslash status --json` gets to answer before the daemon counts as absent. */
const TASKSLASH_STATUS_TIMEOUT_MS = 2_000;
/** The longest command line kept in a TaskSlash job name. */
const TASKSLASH_NAME_COMMAND_CHARS = 120;

/** A TaskSlash client whose daemon answered, and the PATH client passed over on the way, if any. */
export interface TaskslashClient {
  bin: string;
  /** The `taskslash` on PATH that did not answer before `bin` did (a stale mise shim, OB-2254). */
  skipped: string | null;
}

/**
 * The TaskSlash client to use, or null when none answers or it is switched off (OB-2254). `0` is never; a
 * path is that client only, with no fallback; unset asks the `taskslash` on PATH, then ~/.cargo/bin/taskslash
 * (where TK-11 installs it), and the first whose `status --json` exits 0 wins. A PATH hit is not trusted for
 * being first: a mise shim for an inactive tool exits 1 there while the cargo client answers. Reads only `env`.
 */
export async function findTaskslash(env: NodeJS.ProcessEnv = process.env, timeoutMs = TASKSLASH_STATUS_TIMEOUT_MS): Promise<TaskslashClient | null> {
  const setting = env[LEASE_RUN_TASKSLASH_ENV];
  if (setting === "0") return null;
  if (setting) return existsSync(setting) && (await taskslashAnswers(setting, timeoutMs)) ? { bin: setting, skipped: null } : null;
  const onPath = Bun.which("taskslash", { PATH: env.PATH ?? "" });
  const cargo = join(env.HOME || homedir(), ".cargo", "bin", "taskslash");
  let skipped: string | null = null;
  if (onPath) {
    if (await taskslashAnswers(onPath, timeoutMs)) return { bin: onPath, skipped: null };
    skipped = onPath;
  }
  if (!existsSync(cargo) || (onPath && realPath(onPath) === realPath(cargo))) return null;
  return (await taskslashAnswers(cargo, timeoutMs)) ? { bin: cargo, skipped } : null;
}

function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Whether the TaskSlash daemon answers: `taskslash status --json` exits 0 within 2 s. */
export async function taskslashAnswers(bin: string, timeoutMs = TASKSLASH_STATUS_TIMEOUT_MS): Promise<boolean> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([bin, "status", "--json"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const code = await Promise.race([proc.exited, timedOut]);
  if (timer) clearTimeout(timer);
  if (code === null) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already gone
    }
    return false;
  }
  return code === 0;
}

/** Where the job writes its pid for ob to signal (OB-2234); the job's `sh` reads it from the environment. */
const LEASE_RUN_JOB_PID_ENV = "OB_LEASE_RUN_JOB_PIDFILE";
/**
 * The job: record its pid, then become `timeout` (the same pid), which leads a new process group. The record
 * is best-effort: a run whose pid cannot be written still runs, and ob then signals the client instead.
 */
const JOB_SCRIPT = `echo $$ > "$${LEASE_RUN_JOB_PID_ENV}"; exec timeout -k 10 "$0" "$@"`;

/**
 * The job a `cpu:` run becomes when the daemon answers (OB-2234): TaskSlash admits it against the machine
 * instead of the one-slot lease. The name is stable per command line, so a repeated run learns one cost
 * history. The cap goes inside the job as `timeout`, so it counts from admission, not the wait, a run cut at
 * the cap still exits 124, and the cap stops the command's whole process group (its browsers too). The job
 * first writes its pid (which becomes timeout's, and the group's) to $OB_LEASE_RUN_JOB_PIDFILE: the
 * `taskslash run` client forwards no signal and the daemon stops nothing when its client dies, so ob signals
 * that group itself.
 */
export function taskslashArgv(bin: string, resource: string, command: string[], capS: number): string[] {
  const name = `ob:${resource}:${command.join(" ").slice(0, TASKSLASH_NAME_COMMAND_CHARS)}`;
  return [bin, "run", "--kind", "browser", "--name", name, "--", "sh", "-c", JOB_SCRIPT, String(capS), ...command];
}

/**
 * Run a `cpu:` command as a TaskSlash job (OB-2234). No lease and no timer of ob's: the daemon's admission
 * replaces the slot count and `timeout` in the job is the cap. Under a finite RTTIME limit (a T3 shell) the
 * client itself runs in the OB-2161 escape unit, because the client's `systemd-run --scope` keeps its
 * caller's limits and the kernel would SIGKILL the browsers. ob always forwards a signal (the client and the
 * job are outside the terminal's process group): to the job's group once it has started, else to the client,
 * which then leaves the queue. A second signal, or 10 s after a SIGTERM without an exit, SIGKILLs the group.
 * If the daemon went away after the check, `taskslash run` exits 1 without running the command, and that 1
 * is passed through. The thread title gets no lease marker: there is no lease, and `taskslash run` prints its
 * own `taskslash: waiting` lines while the daemon holds the job.
 */
async function runThroughTaskslash(opts: LeaseRunOptions, bin: string, heldHere: string[]): Promise<number> {
  const { log } = opts;
  log("lease run: through taskslash");
  const pidFile = join(process.env.XDG_RUNTIME_DIR || tmpdir(), `ob-lease-run-job-${process.pid}-${randomBytes(4).toString("hex")}.pid`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    [LEASE_RUN_HELD_ENV]: [...new Set([...heldHere, opts.resource])].join(","),
    [LEASE_RUN_JOB_PID_ENV]: pidFile,
  };
  const argv = taskslashArgv(bin, opts.resource, opts.command, opts.capS!);

  let started: Started | null = null;
  let signalled: NodeJS.Signals | null = null;
  let hardStop: ReturnType<typeof setTimeout> | null = null;
  const jobPid = (): number | null => {
    try {
      const n = Number(readFileSync(pidFile, "utf8").trim());
      return Number.isSafeInteger(n) && n > 1 ? n : null;
    } catch {
      return null;
    }
  };
  const kill = (target: number, sig: NodeJS.Signals): boolean => {
    try {
      process.kill(target, sig);
      return true;
    } catch {
      return false;
    }
  };
  const signalClient = (sig: NodeJS.Signals) => {
    if (started?.unit) systemctl(["kill", "--kill-whom=main", `--signal=${sig}`, started.unit]);
    else {
      try {
        started?.child.kill(sig);
      } catch {
        // already gone
      }
    }
  };
  /**
   * The group (timeout leads it). While the job runs, the pid alone covers the moment before timeout makes its
   * group; once the client has exited the job has too, and that pid may already belong to someone else.
   */
  const signalJob = (sig: NodeJS.Signals, pidFallback = true): boolean => {
    const pid = jobPid();
    if (pid === null) return false;
    if (!kill(-pid, sig) && pidFallback) kill(pid, sig);
    return true;
  };
  const killAll = () => {
    signalJob("SIGKILL");
    if (started?.unit) systemctl(["stop", "--no-block", started.unit]);
    else signalClient("SIGKILL");
  };
  const onSignal = (sig: NodeJS.Signals) => {
    const first = signalled === null;
    signalled = signalled ?? sig;
    if (!first) return killAll();
    if (!signalJob(sig)) signalClient(sig);
    if (sig === "SIGTERM") hardStop = setTimeout(killAll, ESCAPE_STOP_AFTER_MS);
  };
  const handlers = CAUGHT_SIGNALS.map((sig) => {
    const h = () => onSignal(sig);
    process.on(sig, h);
    return [sig, h] as const;
  });
  try {
    let code: number | null = null;
    if (shouldEscape()) {
      try {
        started = startEscaped(argv, env, null);
      } catch (err) {
        log(`could not start a user service (${(err as Error).message}); running taskslash directly`);
      }
      if (started) {
        code = await started.child.exited;
        // The shim deletes the env file on start: one still there means the unit never ran the client.
        if (started.envFile && existsSync(started.envFile) && !signalled) {
          log("could not start taskslash as a user service; running it directly, under the inherited RTTIME limit");
          rmSync(started.envFile, { force: true });
          started = null;
        }
      }
    }
    if (!started && !signalled) {
      try {
        // Its own session: a terminal's Ctrl-C must not kill the client (it would leave the job running); ob
        // passes every signal on itself, above.
        started = { child: Bun.spawn(argv, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: true }) };
      } catch (err) {
        log(`cannot run '${bin}': ${(err as Error).message}`);
        return 127;
      }
      code = await started.child.exited;
    }
    // A job that started in the moment the client was being signalled is not left behind.
    if (signalled) {
      signalJob("SIGTERM", false);
      return 128 + (signalNumber(signalled) ?? 0);
    }
    return code ?? 128 + (signalNumber(started?.child.signalCode) ?? 1);
  } finally {
    if (hardStop) clearTimeout(hardStop);
    if (started?.envFile) rmSync(started.envFile, { force: true });
    rmSync(pidFile, { force: true });
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}

/** Everything `lease run` needs, resolved once for both the local-database and the API handler. */
export interface LeaseRunPlan {
  resource: string;
  command: string[];
  holder: string;
  ttlS: number;
  heartbeatMs: number;
  /** Seconds from the grant to the stop (OB-2229); null is no cap. */
  capS: number | null;
}

/**
 * The cap for a run (OB-2229): a `cpu:` key defaults to LEASE_RUN_CPU_CAP_S and `--max` may lower it, never
 * raise it; any other key has no cap unless `--max` sets one, with no upper limit. `--max` is a whole number
 * of seconds, 1 or more; anything else is a usage error, raised before any lease is taken.
 */
export function leaseRunCap(resource: string, max: unknown): number | null {
  const cpu = resource.startsWith("cpu:");
  if (max === undefined || max === null || max === false) return cpu ? LEASE_RUN_CPU_CAP_S : null;
  const text = String(max).trim();
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  // setTimeout fires at once past 2^31-1 ms, so a larger cap would stop the run at its start.
  if (!Number.isSafeInteger(n) || n < 1 || n > LEASE_RUN_MAX_CAP_S) throw new UsageError(`lease run --max must be a whole number of seconds, 1 to ${LEASE_RUN_MAX_CAP_S} (got '${text}')`);
  if (cpu && n > LEASE_RUN_CPU_CAP_S) {
    throw new UsageError(
      `lease run --max ${n} is above the ${capWords(LEASE_RUN_CPU_CAP_S)} cap on ${resource}; split the run into parts that each finish inside it and lease each part`,
    );
  }
  return n;
}

/** `600` reads "10 minutes", `90` reads "90 seconds". */
function capWords(s: number, singular = false): string {
  const [n, unit] = s % 60 === 0 ? [s / 60, "minute"] : [s, "second"];
  return `${n} ${unit}${singular || n === 1 ? "" : "s"}`;
}

/** An elapsed time as `10m 0s` or `0.4s`. */
function elapsedWords(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s * 10) / 10}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** The one line a capped run prints: the resource, the elapsed time, and what to do instead. */
function capLine(resource: string, capS: number, elapsedMs: number): string {
  return (
    `stopped at the ${capWords(capS, true)} cap on ${resource} (ran ${elapsedWords(elapsedMs)}); ` +
    `split the run into parts that each finish inside ${capWords(capS)} and lease each part`
  );
}

export function planLeaseRun(args: string[], flags: { ttl?: unknown; holder?: unknown; max?: unknown }): LeaseRunPlan {
  // args[0] is "run": the router has split `lease run <resource> -- <command...>` into positionals.
  const resource = args[1];
  const command = args.slice(2);
  if (!resource) throw new UsageError("lease run requires a <resource> and a command: ob lease run cpu:browser -- <command...>");
  if (command.length === 0) {
    throw new UsageError("lease run requires a command after the resource: ob lease run cpu:browser -- <command...>");
  }
  const ttlS = flags.ttl ? Number(flags.ttl) : LEASE_RUN_TTL_S;
  if (!Number.isFinite(ttlS) || ttlS <= 0) throw new UsageError("lease run --ttl must be a positive number of seconds");
  const holder = typeof flags.holder === "string" && flags.holder.trim() ? flags.holder.trim() : defaultHolder();
  const normalized = normalizeLeaseResource(resource);
  return {
    resource: normalized,
    capS: leaseRunCap(normalized, flags.max),
    command,
    holder,
    ttlS,
    heartbeatMs: Math.min(LEASE_RUN_HEARTBEAT_MS, (ttlS * 1000) / 5),
  };
}

/** The default holder: unique per `ob lease run` process, readable in `ob lease status`. */
function defaultHolder(cwd: string = process.cwd()): string {
  let where = basename(cwd);
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const branch = r.exitCode === 0 ? r.stdout.toString().trim() : "";
    if (branch && branch !== "HEAD") where = branch;
  } catch {
    // no git: the directory name stands
  }
  return `${where}:${leaseHolderId()}`;
}

/**
 * Wait for the lease, run the command with its stdio passed through, release the lease, and return the
 * exit code `ob` should use: the child's own code, or 128 + the signal when `ob` itself was signalled.
 * Under an enclosing `lease run` for the same resource there is nothing to wait for or release: the
 * command just runs, with the same signal handling.
 */
export async function runUnderLease(opts: LeaseRunOptions): Promise<number> {
  const { log, heartbeatMs } = opts;
  const heldHere = (process.env[LEASE_RUN_HELD_ENV] ?? "").split(",").filter(Boolean);
  const nested = heldHere.includes(opts.resource);

  // A `cpu:` run goes through the TaskSlash daemon when it answers (OB-2234). A nested run keeps the nested
  // path below: its parent is already a job. No daemon: the lease, exactly as before, with nothing printed.
  if (!nested && opts.resource.startsWith("cpu:") && opts.capS) {
    const client = await findTaskslash();
    if (client) {
      if (client.skipped) log(`lease run: taskslash on PATH (${client.skipped}) did not answer; using ${client.bin}`);
      return runThroughTaskslash(opts, client.bin, heldHere);
    }
  }

  let child: ReturnType<typeof Bun.spawn> | null = null;
  let started: Started | null = null;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let capped = false;
  let signalled: NodeJS.Signals | null = null;
  let wake: (() => void) | null = null;
  const onSignal = (sig: NodeJS.Signals) => {
    const first = signalled === null;
    signalled = signalled ?? sig;
    if (started?.unit) {
      // The command is not ob's child and not in the terminal's process group, so ob always passes the
      // signal on, to the shim only (it forwards to the command). A second signal, or 10 s after a SIGTERM
      // without an exit, stops the unit outright: SIGTERM to everything in it, then SIGKILL. A Ctrl-C gets
      // no deadline: a test runner's teardown takes as long as it takes, as it did before the escape.
      const unit = started.unit;
      if (!first) {
        systemctl(["stop", "--no-block", unit]);
      } else {
        systemctl(["kill", "--kill-whom=main", `--signal=${sig}`, unit]);
        if (sig === "SIGTERM") stopTimer = setTimeout(() => systemctl(["stop", "--no-block", unit]), ESCAPE_STOP_AFTER_MS);
      }
    } else if (sig === "SIGTERM" || !terminalSignalsChild()) {
      try {
        child?.kill(sig);
      } catch {
        // the child already exited
      }
    }
    wake?.();
  };
  const handlers = CAUGHT_SIGNALS.map((sig) => {
    const h = () => onSignal(sig);
    process.on(sig, h);
    return [sig, h] as const;
  });
  const signalCode = () => 128 + (signalNumber(signalled) ?? 0);

  // Marks the thread title `⏳` once a wait really starts (OB-2153) and `🔒` once the lease is held (OB-2169), and
  // restores it however the run ends.
  // Each resource has its own marker, so a run nested in another for a DIFFERENT resource marks its own beside the
  // outer one; one for the SAME resource takes the nested path below and marks nothing (OB-2169).
  const title = opts.title ?? leaseWaitTitle(opts.resource, log);
  let held = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let beating: Promise<void> | null = null;
  try {
    if (nested) {
      log(`${opts.resource} is already held by the enclosing lease run; running the command under it`);
    } else {
      // Wait. The sleep is async and woken by a signal, so Ctrl-C while queued exits without ever holding.
      // An attempt the ob API did not answer is "not yet", never a reason to run without the lease or to
      // give up (OB-2157): a deploy restart refuses connections for a few seconds.
      let told: string | null = null;
      const outage = apiOutageReporter(opts.resource, log);
      for (;;) {
        if (signalled) return signalCode();
        const r = await tryAttempt(() => opts.io.acquire(), outage);
        if (r?.ok) {
          held = true;
          break;
        }
        if (r && told !== r.holder) {
          told = r.holder;
          log(`waiting for ${opts.resource}, held by ${r.holder}`);
        }
        if (r) await title.waiting();
        // A signal during the mark found no sleep to wake; do not start one.
        if (signalled) return signalCode();
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, opts.pollMs ?? LEASE_RUN_POLL_MS);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = null;
      }
      if (signalled) return signalCode();
      if (told) log(`acquired ${opts.resource}`);
      // `🔒` from the grant to the release (OB-2169). Not awaited: the command starts at once, and the finally
      // below waits for the restore, which chains after this mark, before exit.
      void title.holding();

      // A beat that finds another holder means our row lapsed during an outage longer than the TTL and
      // someone took it. The run keeps going (stopping a browser run halfway wastes it, and an overlap costs
      // CPU, not data), says so once, and the release at the end cannot remove the other holder's lease.
      let lost = false;
      heartbeat = setInterval(() => {
        if (beating) return;
        beating = opts.io.acquire().then(
          (r) => {
            if (!r.ok && !lost) {
              lost = true;
              log(`LOST ${opts.resource}: now held by ${r.holder}; this run is no longer protected by the lease`);
            }
          },
          // An outage gets one short line: the client's full "could not reach" text is what a run that never
          // ran used to print (OB-2157), and this run is still going.
          (err: unknown) =>
            log(
              isApiTransient(err)
                ? `could not refresh ${opts.resource}: ob API unreachable, will retry`
                : `could not refresh ${opts.resource}: ${(err as Error).message}`,
            ),
        ).finally(() => {
          beating = null;
        });
      }, heartbeatMs);
    }

    const env = { ...process.env, [LEASE_RUN_HELD_ENV]: [...new Set([...heldHere, opts.resource])].join(",") };
    // The cap counts from the grant, never the wait (OB-2229). A nested run is covered by its parent's cap.
    const capS = nested ? null : (opts.capS ?? null);
    const grantedAt = Date.now();
    const overCap = () => capS !== null && Date.now() - grantedAt >= capS * 1000;
    if (capS !== null) {
      // Fires even after a signal: a teardown that hangs past the cap must not keep the slot (the exit code
      // is still 128 + that signal, which is checked first).
      capTimer = setTimeout(() => {
        capped = true;
        log(capLine(opts.resource, capS, Date.now() - grantedAt));
        if (started?.unit) {
          // SIGTERM to everything in the unit, SIGKILL after its TimeoutStopSec (10 s).
          systemctl(["stop", "--no-block", started.unit]);
        } else {
          try {
            child?.kill("SIGTERM");
          } catch {
            // already gone
          }
          killTimer = setTimeout(() => {
            try {
              child?.kill("SIGKILL");
            } catch {
              // already gone
            }
          }, ESCAPE_STOP_AFTER_MS);
        }
      }, capS * 1000);
    }
    let code: number | null = null;
    let escaped = false;
    if (shouldEscape()) {
      try {
        started = startEscaped(opts.command, env, capS);
        child = started.child;
        escaped = true;
      } catch (err) {
        log(`could not start a user service (${(err as Error).message}); running the command directly`);
      }
    }
    if (escaped) {
      code = await child!.exited;
      if (signalled) return signalCode();
      // systemd's RuntimeMaxSec may stop the unit a moment before ob's own timer fires: still the cap.
      if (capped || overCap()) {
        if (!capped) log(capLine(opts.resource, capS!, Date.now() - grantedAt));
        return LEASE_RUN_CAP_EXIT;
      }
      // The shim deletes the env file first thing, so a file still there means the unit never ran the
      // command (no user manager, no D-Bus): run it the old way rather than fail a run that never started.
      if (started?.envFile && existsSync(started.envFile)) {
        log("could not start the command as a user service; running it directly, under the inherited RTTIME limit");
        rmSync(started.envFile, { force: true });
        started = null;
        escaped = false;
      }
    }
    if (!escaped) {
      try {
        child = Bun.spawn(opts.command, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      } catch (err) {
        log(`cannot run '${opts.command[0]}': ${(err as Error).message}`);
        return 127;
      }
      code = await child.exited;
      if (signalled) return signalCode();
      if (capped) return LEASE_RUN_CAP_EXIT;
    }
    // A child killed by a signal reports exitCode null; pass it on as the shell does.
    return code ?? 128 + (signalNumber(child!.signalCode) ?? 1);
  } finally {
    if (stopTimer) clearTimeout(stopTimer);
    if (capTimer) clearTimeout(capTimer);
    if (killTimer) clearTimeout(killTimer);
    if (started?.envFile) rmSync(started.envFile, { force: true });
    if (heartbeat) clearInterval(heartbeat);
    // A refresh still in flight would re-create the row after the release below.
    if (beating) await beating;
    // A signalled run tries once and leaves the rest to the TTL: Ctrl-C and SIGTERM exit as promptly as
    // before OB-2157 (a supervisor's SIGKILL follows its SIGTERM soon after).
    if (held) await releaseWithRetry(signalled ? { ...opts, releaseWindowMs: 0 } : opts);
    // Restored before ob exits, on every path out of a wait or a hold: the command's end, a signal, or an error.
    await title.done();
    // Only now: a second Ctrl-C during a slow release (over the API) must not kill ob mid-release.
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}

/**
 * Release, retrying while the ob API gives no answer (OB-2157), up to the window. Never throws: the exit
 * code stays the child's whatever happens here.
 */
async function releaseWithRetry(opts: LeaseRunOptions): Promise<void> {
  const windowMs = opts.releaseWindowMs ?? LEASE_RUN_RELEASE_WINDOW_MS;
  const retryMs = opts.releaseRetryMs ?? LEASE_RUN_RELEASE_RETRY_MS;
  const deadline = Date.now() + windowMs;
  for (;;) {
    try {
      await opts.io.release();
      return;
    } catch (err) {
      if (!isApiTransient(err)) {
        opts.log(`could not release ${opts.resource}: ${(err as Error).message}`);
        return;
      }
      if (Date.now() + retryMs > deadline) {
        opts.log(`could not release ${opts.resource}: ob API unreachable; it frees when its TTL lapses`);
        return;
      }
      await Bun.sleep(retryMs);
    }
  }
}

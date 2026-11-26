import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { type FsInfo, MIN_SHM_FREE_BYTES, SHM_DIR, TMPFS_MAGIC, shmInfo } from "../scratch-root.ts";

/**
 * A throwaway Postgres cluster for the test suite (325).
 *
 * SQLite gave every test a fresh database by naming a file nobody else knew about. Postgres has no
 * in-memory mode and no per-file database, so the equivalent has to be built: a real postmaster, started
 * by the test process, on a unix socket in a directory of its own, holding databases nothing outside this
 * process can name.
 *
 * Three properties this file exists to guarantee, each of which was measured rather than assumed (see the
 * harness header for the numbers):
 *
 *   HERMETIC. The binaries come from a versioned npm package (`@embedded-postgres/<platform>`), not from
 *   the machine, so there is nothing to install and nothing to fetch at test time. `initdb` builds the
 *   cluster locally; no image is pulled and no server is contacted.
 *
 *   NEVER THE LIVE DATABASE. There is no TCP listener at all -- `-h ""` disables it -- so the cluster is
 *   reachable only through a unix socket in a directory this process just created. A test cannot reach the
 *   Mac's Postgres or the server's by accident, because it has no host to reach either of them on.
 *
 *   NO LEAKS. The postmaster is stopped and its tree removed in `afterAll`. A test process that is KILLED
 *   runs neither -- measured: `kill -9` on a `bun test` leaves the postmaster running and reparented to
 *   launchd -- so the sweep below is the backstop, and the owner file is what lets it tell a leak from a
 *   concurrent builder's live run without waiting anything out.
 */

/** Where a cluster's socket, data dir and pid file live: one directory per run under a shared parent. */
const CLUSTER_DIR_PREFIX = "ob-pg-";

/**
 * A unix socket's path cannot exceed 103 bytes, and macOS's `$TMPDIR` alone spends about half of that
 * (`/var/folders/y4/_z77x5tx2qnddk89qs7nkf9c0000gn/T/`). Measured: the first working version of this file
 * produced a 117-byte socket path and the postmaster refused to start with
 * `Unix-domain socket path ... is too long (maximum 103 bytes)`.
 *
 * So the fallback is `/tmp` (`pgDefaultParent`), which is short and exists on both platforms this has to work on. That
 * is not a loosening of the repo's `$TMPDIR` isolation (152): a cluster has to sit outside the per-run
 * scratch anyway, or the scratch's `rmSync` deletes an orphaned postmaster's data directory and strands the
 * postmaster itself.
 */
const DEFAULT_ROOT = "/tmp";

/**
 * Where this process's clusters go when `OMNISLASH_TEST_PG_ROOT` is not set: `/dev/shm` when it is a tmpfs
 * with room, else `/tmp`. Unlike the run scratch (`scratchParent`), a `noexec` tmpfs qualifies: Postgres
 * executes nothing from its data directory.
 *
 * OB-2029: not a disk filesystem by default. Every `CREATE DATABASE .. STRATEGY file_copy` the harness runs
 * forces a checkpoint, and with `fsync=off` that checkpoint is still a burst of writes into the page cache.
 * On btrfs a write to a page under writeback waits for it (the OB-2024 stall). With the cluster on btrfs
 * under a loaded gate, the first lease measured 3.3s to 10.8s (one checkpoint alone took 6.7s) and the
 * calendar suite's first test ran out its 15s budget; on `/dev/shm`, same load, the worst was 0.9s.
 */
export function pgDefaultParent(shm: FsInfo | null): string {
  return shm && shm.type === TMPFS_MAGIC && shm.freeBytes >= MIN_SHM_FREE_BYTES ? SHM_DIR : DEFAULT_ROOT;
}

/** Chosen once per process, so free space shrinking mid-run cannot move the root under a running cluster. */
let defaultParent: string | undefined;

/** The shared parent a new cluster goes under. */
export function pgClusterRoot(): string {
  const parent = process.env.OMNISLASH_TEST_PG_ROOT ?? (defaultParent ??= pgDefaultParent(shmInfo()));
  return join(parent, "ob-cli-pg");
}

/**
 * Creates the root and checks this process can write in it. A `/dev/shm` it cannot use (read-only, or an
 * `ob-cli-pg` another user made) moves the default to `/tmp` for the rest of the process; an explicit
 * `OMNISLASH_TEST_PG_ROOT` is never second-guessed.
 */
function makeClusterRoot(): string {
  const root = pgClusterRoot();
  try {
    mkdirSync(root, { recursive: true });
    accessSync(root, constants.W_OK);
    return root;
  } catch (e) {
    if (process.env.OMNISLASH_TEST_PG_ROOT !== undefined || defaultParent === DEFAULT_ROOT) throw e;
    defaultParent = DEFAULT_ROOT;
    const fallback = pgClusterRoot();
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

/**
 * The parents the sweep walks: both defaults when the variable is unset, since a killed run may have chosen
 * the other one (it had more `/dev/shm` free, or less).
 */
function pgClusterRoots(): string[] {
  if (process.env.OMNISLASH_TEST_PG_ROOT !== undefined) return [pgClusterRoot()];
  return [...new Set([SHM_DIR, DEFAULT_ROOT].map((p) => join(p, "ob-cli-pg")))];
}

/** The kernel's limit on `sockaddr_un.sun_path`, which is what the postmaster is refused by. */
const MAX_SOCKET_PATH = 103;

/** Escape hatch for a machine that would rather use its own Postgres: a directory holding initdb+postgres. */
const BIN_ENV = "OMNISLASH_TEST_PG_BIN";

export interface Cluster {
  /** The unix socket DIRECTORY. Bun's SQL client takes it as `path`. */
  socketDir: string;
  /** The cluster's own tree; removing it removes everything the cluster owns. */
  dir: string;
  binDir: string;
  /** Whatever the postmaster has said on stderr, so a failure to connect can name its real reason. */
  log(): string;
  stop(): Promise<void>;
}

/**
 * Recreate the shared-library symlinks the binary package ships as a manifest rather than as files.
 *
 * npm cannot carry symlinks in a tarball, so `@embedded-postgres/*` lists them in `native/pg-symlinks.json`
 * and rebuilds them in a `postinstall`. Bun does not run a postinstall unless the package is named in the
 * root `trustedDependencies`, and without the symlinks the binaries do not load at all
 * (`Library not loaded: @loader_path/../lib/libzstd.1.dylib`).
 *
 * Doing it here instead of adding `trustedDependencies` is deliberate: adding that key to the root
 * `package.json` makes bun rewrite the whole lockfile (measured: 68 insertions and 198 deletions across
 * the unrelated web-app dependency tree), which is not a diff a test harness should be carrying. It is also
 * the more robust place -- it holds however the package was installed, including with postinstalls off.
 */
function hydrateSymlinks(packageRoot: string): void {
  const manifest = join(packageRoot, "native", "pg-symlinks.json");
  if (!existsSync(manifest)) return;
  let links: { source: string; target: string }[];
  try {
    links = JSON.parse(readFileSync(manifest, "utf8"));
  } catch {
    return;
  }
  for (const { source, target } of links) {
    const targetPath = join(packageRoot, target);
    if (existsSync(targetPath)) continue;
    try {
      // Relative, so the tree survives being moved.
      symlinkSync(relative(dirname(join(packageRoot, source)), join(packageRoot, source)), targetPath);
    } catch {
      // raced with another test process doing the same thing, or already there as a broken link
    }
  }
}

function platformPackage(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `@embedded-postgres/${os}-${arch}`;
}

/**
 * Where `initdb` and `postgres` are. The npm package first, because that is the one whose version is
 * pinned in `package.json` and therefore the one the suite is proven against; an explicit
 * `OMNISLASH_TEST_PG_BIN` overrides it; a machine Postgres on PATH is the last resort so a platform without
 * a published binary package is not simply dead.
 *
 * The failure message names all three, because "postgres not found" is a genuinely confusing thing to meet
 * in a test run that has never needed Postgres before.
 */
export function resolvePgBinDir(): string {
  const override = process.env[BIN_ENV];
  if (override) {
    if (!existsSync(join(override, "initdb"))) {
      throw new Error(`${BIN_ENV}=${override} has no initdb in it`);
    }
    return override;
  }
  const pkg = platformPackage();
  try {
    const entry = Bun.resolveSync(`${pkg}/package.json`, import.meta.dir);
    const root = join(entry, "..");
    const binDir = join(root, "native", "bin");
    if (existsSync(join(binDir, "initdb"))) {
      hydrateSymlinks(root);
      return binDir;
    }
  } catch {
    // not installed for this platform: fall through to the machine's own
  }
  const which = Bun.spawnSync(["/usr/bin/which", "initdb"], { stdout: "pipe", stderr: "ignore" });
  const found = which.stdout.toString().trim();
  if (found) return join(found, "..");
  throw new Error(
    `no Postgres binaries: ${pkg} is not installed (run \`bun install\`), ${BIN_ENV} is unset, and initdb is not on PATH`,
  );
}

/** The file naming the test process a cluster belongs to. Its absence is what makes a cluster an orphan. */
const OWNER_FILE = "owner";

/**
 * Whether the TEST PROCESS that started this cluster is still running.
 *
 * This is the discriminator the grace period cannot provide. A live postmaster is ambiguous on its own --
 * it is either a concurrent builder's run or the leftovers of a killed one -- and waiting out a two-hour
 * grace to tell them apart means a `kill -9` leaks a running Postgres for two hours. Its owner is not
 * ambiguous: if the bun that started it is gone, nothing will ever stop that postmaster.
 *
 * Pid reuse is handled by requiring the process to still be a `bun`. A reused pid that happens to be
 * another bun only costs a delay, because the age check still applies.
 */
function ownerAlive(dir: string): boolean | undefined {
  const file = join(dir, OWNER_FILE);
  if (!existsSync(file)) return undefined;
  let pid: number;
  try {
    pid = Number(readFileSync(file, "utf8").trim());
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  const ps = Bun.spawnSync(["/bin/ps", "-o", "comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  return ps.stdout.toString().includes("bun");
}

/**
 * Whether a cluster directory still has a LIVE postmaster, and which pid it is.
 *
 * `postmaster.pid` line 1 is the pid and line 2 the data directory. A pid on its own is not something to
 * act on -- pids are reused, and acting on one means signalling a process this run did not start -- so it
 * counts as live only when the pid file's own data directory matches and the process is currently a
 * `postgres`.
 */
function livePostmaster(dir: string): number | undefined {
  const pidFile = join(dir, "data", "postmaster.pid");
  if (!existsSync(pidFile)) return undefined;
  let pid: number;
  let dataDir: string;
  try {
    const lines = readFileSync(pidFile, "utf8").split("\n");
    pid = Number(lines[0]);
    dataDir = (lines[1] ?? "").trim();
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  if (dataDir !== join(dir, "data")) return undefined;
  const ps = Bun.spawnSync(["/bin/ps", "-o", "comm=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
  return ps.stdout.toString().trim().endsWith("postgres") ? pid : undefined;
}

/**
 * Remove the clusters of runs that could not remove their own -- the `kill -9` case, where no `afterAll`
 * fires and both the postmaster and its tree survive.
 *
 * Two cases, and the difference matters because this repo is worked with several builders at once and
 * their clusters are siblings under the same parent:
 *
 * Measured, on this machine: `kill -9` on a `bun test` holding a cluster leaves the postmaster running,
 * reparented to launchd, with its whole tree intact. Nothing else will ever clean that up.
 *
 * What a cluster is judged on, in order:
 *
 *   ITS OWNER IS ALIVE. A concurrent builder's run. Left completely alone, whatever its age.
 *
 *   ITS OWNER IS GONE. Nothing will ever stop this; it is a leak by definition. Its postmaster is
 *   signalled (SIGQUIT is Postgres's own immediate shutdown) and the tree removed, without waiting out any
 *   grace period. This is the case that matters, and the owner file is what makes it decidable.
 *
 *   NO OWNER FILE. A cluster from a build before the file existed, or one killed between `mkdir` and the
 *   first write. Falls back to age: `graceMs` if a postmaster is still live (it might be someone's), and
 *   the much shorter `orphanMs` if not. `orphanMs` is not politeness, it is the window between a sibling
 *   run creating its directory and its postmaster appearing in the process table -- measured at ~620ms
 *   (initdb 580ms plus start 42ms), so minutes of margin.
 */
export function sweepStalePgClusters(graceMs = 2 * 60 * 60 * 1000, orphanMs = 5 * 60 * 1000): string[] {
  const swept: string[] = [];
  for (const root of pgClusterRoots()) {
    if (existsSync(root)) sweepRoot(root, graceMs, orphanMs, swept);
  }
  return swept;
}

function sweepRoot(root: string, graceMs: number, orphanMs: number, swept: string[]): void {
  for (const entry of readdirSync(root)) {
    if (!entry.startsWith(CLUSTER_DIR_PREFIX)) continue;
    const dir = join(root, entry);
    try {
      const owner = ownerAlive(dir);
      if (owner === true) continue;
      const pid = livePostmaster(dir);
      if (owner === undefined) {
        const age = Date.now() - statSync(dir).mtimeMs;
        if (age <= (pid === undefined ? orphanMs : graceMs)) continue;
      }
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGQUIT");
        } catch {
          // exited between the ps and the signal
        }
        // Wait for it to actually go. A shutting-down postmaster keeps writing its data directory, and
        // removing the tree underneath it leaves files it recreates after the walk -- measured: the orphan
        // was killed but its directory survived the rm.
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          Bun.sleepSync(20);
        }
      }
      rmSync(dir, { recursive: true, force: true });
      swept.push(dir);
    } catch {
      // a sibling run removing the same entry, or one that vanished mid-sweep
    }
  }
}

/**
 * `initdb` + a running postmaster, ready to accept connections.
 *
 * The durability settings are all off. This cluster's entire lifetime is one test run and its data dir is
 * deleted afterwards, so a crash-safe write is a write spent on nothing: `fsync=off` is what makes a
 * database-per-test affordable at all.
 */
export function startCluster(): Cluster {
  const binDir = resolvePgBinDir();
  const root = makeClusterRoot();
  // Short on purpose: every byte here comes off the socket path's 103-byte budget.
  const dir = join(root, `${CLUSTER_DIR_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12)}`);
  const data = join(dir, "data");
  // The socket lives in a short sibling of the data directory rather than inside it, for the same reason.
  const socketDir = join(dir, "s");
  const sock = socketPath(socketDir);
  if (sock.length > MAX_SOCKET_PATH) {
    throw new Error(
      `the test cluster's socket path would be ${sock.length} bytes and the kernel allows ${MAX_SOCKET_PATH}: ${sock}. Point OMNISLASH_TEST_PG_ROOT at a shorter directory.`,
    );
  }
  mkdirSync(socketDir, { recursive: true });
  // Written BEFORE initdb, so a cluster killed mid-build is already identifiable as this process's.
  writeFileSync(join(dir, OWNER_FILE), `${process.pid}\n`);

  const init = Bun.spawnSync(
    [join(binDir, "initdb"), "-D", data, "-U", "ob", "-A", "trust", "--no-sync", "-E", "UTF8", "--locale=C"],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (init.exitCode !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`initdb failed: ${init.stderr.toString().trim()}`);
  }

  const proc = Bun.spawn(
    [
      join(binDir, "postgres"),
      "-D",
      data,
      "-k",
      socketDir,
      // No TCP listener at all: the only way in is the socket above.
      "-h",
      "",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
      "-c",
      "max_connections=100",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );

  // A postmaster that refuses to start says why on stderr and then exits; without this the only symptom is
  // a socket that never appears, which is how a 117-byte socket path presented itself.
  let log = "";
  void (async () => {
    try {
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        log += new TextDecoder().decode(chunk);
      }
    } catch {
      // the stream closes when the postmaster is killed
    }
  })();

  const stop = async () => {
    try {
      proc.kill("SIGQUIT");
    } catch {
      // already exited
    }
    // Wait for it. A shutting-down postmaster is still writing its data directory, so removing the tree
    // first leaves files behind that it recreates after the walk -- measured: the directory survived the
    // rm. SIGQUIT is Postgres's immediate shutdown, so this is milliseconds.
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  };

  return { socketDir, dir, binDir, log: () => log, stop };
}

/** The socket file the postmaster creates once it is accepting connections. */
export function socketPath(socketDir: string): string {
  return join(socketDir, ".s.PGSQL.5432");
}

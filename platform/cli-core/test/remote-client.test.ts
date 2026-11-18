import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { HANDLERS, run } from "../../../apps/cli/src/cli.ts";
import { openDb, openReadOnly } from "../../../apps/cli/src/db.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import {
  configuredRemoteHost,
  isReadInvocation,
  planExecution,
  READ_COMMANDS,
  remoteCommand,
  type RemoteExec,
} from "../../../apps/cli/src/remote.ts";
import {
  dumpReplica,
  dumpReplicaBytes,
  gunzip,
  markReplicaDirty,
  openReplicaForRead,
  REPLICA_REOPEN_ATTEMPTS,
  retryOnReplacement,
  readMeta,
  refreshReplica,
  replicaLockPath,
  replicaPath,
  replicaSwapGatePath,
  replicaToken,
  stalenessNotice,
} from "../../../apps/cli/src/replica.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { acquireFileLock, type FlockFn } from "../../../apps/cli/src/file-lock.ts";

// ob 183: the remote client + read replica. NOTHING here shells out to ssh or touches the network:
// every remote interaction goes through an injected RemoteExec.

/** A fake server: a real local DB that answers `replica token` / `replica dump` the way `ob` does. */
function fakeServer(serverDbPath: string): RemoteExec & { calls: string[][]; reachable: boolean } {
  // One long-lived handle: reopening the server DB per call would move its mtime and therefore its
  // change token, which is the very thing the skip-the-transfer test is measuring.
  const serverDb = openDb(serverDbPath);
  const fake = {
    calls: [] as string[][],
    reachable: true,
    stream(_host: string, argv: string[]) {
      fake.calls.push(argv);
      if (!fake.reachable) return { code: 255, connectionFailed: true };
      return { code: 0, connectionFailed: false };
    },
    capture(_host: string, argv: string[]) {
      fake.calls.push(argv);
      if (!fake.reachable) return { code: 255, connectionFailed: true, stdout: "", stderr: "" };
      if (argv[0] === "replica" && argv[1] === "token") {
        return { code: 0, connectionFailed: false, stdout: `${replicaToken(serverDbPath)}\n`, stderr: "" };
      }
      return { code: 0, connectionFailed: false, stdout: "", stderr: "" };
    },
    fetch(_host: string, argv: string[]) {
      fake.calls.push(argv);
      if (!fake.reachable) return { code: 255, connectionFailed: true, stderr: "", bytes: new Uint8Array() };
      return { code: 0, connectionFailed: false, stderr: "", bytes: dumpReplicaBytes(serverDb) };
    },
  };
  return fake;
}

function clientDir(): string {
  return mkdtempSync(join(tmpdir(), "ob-client-"));
}

describe("remote client: command classification (183)", () => {
  test("every HANDLERS command is either allowlisted as a read or classified remote", () => {
    // The point of this test: the classification cannot go stale in silence. A command added later is
    // REMOTE by default, which is the safe answer, and this pins that nothing is unclassified.
    // 189 added two more answers (`split`, `refused`) for the commands whose side effect is this machine,
    // so they are named here rather than worked around: the property being pinned is unchanged.
    const classified = new Set(["remote", "local", "nodb", "split", "refused"]);
    const unclassified = Object.keys(HANDLERS).filter((command) => {
      const read = isReadInvocation(command, [], {});
      const mode = planExecution({ command, args: [], flags: {}, host: "ob@server" }).mode;
      return !read && !classified.has(mode);
    });
    expect(unclassified).toEqual([]);
  });

  test("the allowlist only names commands that exist", () => {
    const unknown = Object.keys(READ_COMMANDS).filter((c) => !(c in HANDLERS));
    expect(unknown).toEqual([]);
  });

  test("a command absent from the allowlist goes remote", () => {
    // `daemon` used to be here; 189 moved it into the split class, since it writes launchd plists on THIS
    // machine and never touches the database at all.
    for (const command of ["add", "close", "sync", "secret", "config", "backup"]) {
      expect(planExecution({ command, args: [], flags: {}, host: "h" }).mode).toBe("remote");
    }
  });

  test("mutating SUBCOMMANDS of read-looking commands go remote", () => {
    const cases: [string, string[]][] = [
      ["config", ["set", "remote_host", "x"]],
      ["triage", ["clear", "12"]],
      ["lease", ["acquire", "ticket:1"]],
      ["agent", ["register"]],
      ["issue", ["link", "12", "#3"]],
      ["person", ["add", "Jane"]],
      ["contact", ["cadence", "jane"]],
      ["alerts", ["snooze", "k"]],
    ];
    for (const [command, args] of cases) {
      expect(planExecution({ command, args, flags: {}, host: "h" }).mode).toBe("remote");
    }
  });

  test("a mutating subcommand whose EVIDENCE is local is split, not remote (225)", () => {
    // `spinoff cleanup` writes rows (an `agent done` per branch it swept), so it is rightly out of the read
    // allowlist, but it decides what to remove from THIS machine's checkout and process table: dispatched
    // whole it would delete branches out of the server's own clone.
    expect(planExecution({ command: "spinoff", args: ["cleanup"], flags: {}, host: "h" }).mode).toBe("split");
  });

  test("the read halves of those same commands answer from the replica", () => {
    const cases: [string, string[]][] = [
      ["next", []],
      ["list", []],
      ["show", ["12"]],
      ["search", ["drizzle"]],
      ["status", []],
      ["triage", []],
      ["lease", []],
      ["lease", ["status"]],
      ["person", ["show", "jane"]],
      ["issue", ["landed", "183"]],
      ["whois", ["someone"]],
    ];
    for (const [command, args] of cases) {
      expect(planExecution({ command, args, flags: {}, host: "h" }).mode).toBe("replica");
    }
  });

  test("a mutating FLAG makes an otherwise-read command remote", () => {
    expect(planExecution({ command: "focus", args: [], flags: {}, host: "h" }).mode).toBe("replica");
    // `focus --clear` writes config: a write hiding behind a flag
    expect(planExecution({ command: "focus", args: [], flags: { clear: true }, host: "h" }).mode).toBe("remote");
    // `today` always writes, so it is not on the allowlist at all
    expect(planExecution({ command: "today", args: [], flags: {}, host: "h" }).mode).toBe("remote");
  });

  test("with no remote_host nothing is dispatched: every command runs here", () => {
    for (const command of Object.keys(HANDLERS)) {
      const mode = planExecution({ command, args: [], flags: {}, host: null }).mode;
      expect(["local", "nodb"], command).toContain(mode);
    }
  });

  test("--local forces the replica path even for a write", () => {
    expect(planExecution({ command: "add", args: ["x"], flags: { local: true }, host: "h" }).mode).toBe("replica");
  });
});

describe("remote client: the read-only replica backstop (183)", () => {
  test("a MISCLASSIFIED write raises SQLITE_READONLY instead of writing a doomed row", async () => {
    // Deliberately treat a known write as a read, which is the mistake the read-only handle exists to
    // catch: it must throw at the statement, not land in a file the next refresh overwrites.
    const dir = clientDir();
    const dbPath = join(dir, "omnislash.sqlite");
    const server = openDb(dbPath);
    writeFileSync(replicaPath(dbPath), gunzip(dumpReplicaBytes(server)));
    server.close();

    const replica = openReplicaForRead(dbPath);
    await expect(createItem(replica, { title: "should never land", type: "task" })).rejects.toThrow(/readonly/i);
    replica.close();
  });

  // 308: the refresh REPLACES the replica underneath readers. The rename is atomic for the directory
  // entry, but a reader crossing it gets SQLITE_IOERR ("disk I/O error"). With the 45s spinoff-drain
  // job loaded, `ob spinoff drain` failed 5 of 5; with it stopped, 5 of 6 succeeded -- the same binary
  // succeeding and failing on consecutive runs is what proved this a race and not a code path.
  test("a read that loses the race is retried, and the retry reaches the replacement", () => {
    let calls = 0;
    const value = retryOnReplacement(() => {
      calls++;
      if (calls < 3) {
        const err = new Error("disk I/O error") as Error & { code?: string };
        err.code = "SQLITE_IOERR";
        throw err;
      }
      return "the refreshed replica";
    });
    expect(value).toBe("the refreshed replica");
    expect(calls).toBe(3);
  });

  test("a read that keeps losing gives up rather than spinning: the failure is still reported", () => {
    let calls = 0;
    expect(() =>
      retryOnReplacement(() => {
        calls++;
        const err = new Error("disk I/O error") as Error & { code?: string };
        err.code = "SQLITE_IOERR";
        throw err;
      }),
    ).toThrow(/disk i\/o error/i);
    expect(calls).toBe(REPLICA_REOPEN_ATTEMPTS);
  });

  test("a NON-race failure is not retried at all: only the replacement class is transient", () => {
    let calls = 0;
    expect(() =>
      retryOnReplacement(() => {
        calls++;
        throw new Error("file is not a database");
      }),
    ).toThrow(/not a database/);
    expect(calls).toBe(1);
  });

  test("a replica schema mismatch is NOT retried: it is deterministic and must surface at once", () => {
    const dir = clientDir();
    const dbPath = join(dir, "omnislash.sqlite");
    const skewed = new Database(replicaPath(dbPath), { create: true });
    skewed.exec("CREATE TABLE item (id TEXT PRIMARY KEY, surprise TEXT)");
    skewed.close();
    // Counted, not timed (OB-1894: a wall-clock bound here went red on a loaded runner while the
    // behaviour was right). The refusal is the module's AppError...
    let thrown: unknown;
    try {
      openReplicaForRead(dbPath).close();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as Error).message).toMatch(/schema does not match/);
    // ...and an AppError is never retried, even one whose text reads like a lost race.
    let calls = 0;
    expect(() =>
      retryOnReplacement(() => {
        calls++;
        throw new AppError("disk I/O error while checking the replica schema");
      }),
    ).toThrow(AppError);
    expect(calls).toBe(1);
  });

  test("a replica whose schema does not match this client is refused, not read", () => {
    const dir = clientDir();
    const dbPath = join(dir, "omnislash.sqlite");
    const skewed = new Database(replicaPath(dbPath), { create: true });
    skewed.exec("CREATE TABLE item (id TEXT PRIMARY KEY, surprise TEXT)");
    skewed.close();
    expect(() => openReplicaForRead(dbPath)).toThrow(/schema does not match/);
  });
});

describe("remote client: the refresh protocol (183)", async () => {
  test("dump → verify → rename, and an unchanged token skips the transfer", async () => {
    const serverPath = freshDbPath();
    const server = openDb(serverPath);
    await createItem(server, { title: "on the server", type: "task" });
    server.close();

    const dbPath = join(clientDir(), "omnislash.sqlite");
    const exec = fakeServer(serverPath);

    const first = refreshReplica({ dbPath, host: "ob@server", exec });
    expect(first.refreshed).toBe(true);
    expect(first.error).toBeNull();
    expect(existsSync(replicaPath(dbPath))).toBe(true);

    const replica = openReplicaForRead(dbPath);
    expect((replica.query("SELECT title FROM item").all() as { title: string }[])[0]?.title).toBe("on the server");
    replica.close();

    // second refresh: same token, so no dump is fetched at all
    exec.calls.length = 0;
    const second = refreshReplica({ dbPath, host: "ob@server", exec });
    expect(second.skipped).toBe(true);
    expect(exec.calls.map((c) => c.join(" "))).toEqual(["replica token"]);

    // ... and a write on the server moves the token, so the next refresh does transfer
    const again = openDb(serverPath);
    await createItem(again, { title: "written later", type: "task" });
    again.close();
    const third = refreshReplica({ dbPath, host: "ob@server", exec });
    expect(third.refreshed).toBe(true);
  });

  test("an unreachable host leaves the previous replica in place and records the reason", () => {
    const serverPath = freshDbPath();
    openDb(serverPath).close();
    const dbPath = join(clientDir(), "omnislash.sqlite");
    const exec = fakeServer(serverPath);
    refreshReplica({ dbPath, host: "ob@server", exec });

    exec.reachable = false;
    const outcome = refreshReplica({ dbPath, host: "ob@server", exec });
    expect(outcome.refreshed).toBe(false);
    expect(outcome.reachable).toBe(false);
    expect(outcome.error).toContain("could not reach");
    expect(existsSync(replicaPath(dbPath))).toBe(true);
    expect(readMeta(dbPath).last_refresh_ok).toBe(false);
  });

  test("a dump that is not a database is refused and the replica is not replaced", () => {
    const serverPath = freshDbPath();
    openDb(serverPath).close();
    const dbPath = join(clientDir(), "omnislash.sqlite");
    const good = fakeServer(serverPath);
    refreshReplica({ dbPath, host: "ob@server", exec: good });
    const before = readFileSync(replicaPath(dbPath));

    const junk: RemoteExec = {
      ...good,
      capture: (h, a) => ({ ...good.capture(h, a), stdout: "a-different-token\n" }),
      fetch: () => ({ code: 0, connectionFailed: false, stderr: "", bytes: Bun.gzipSync(new TextEncoder().encode("not a database")) }),
    };
    const outcome = refreshReplica({ dbPath, host: "ob@server", exec: junk });
    expect(outcome.refreshed).toBe(false);
    expect(outcome.error).toBeTruthy();
    expect(readFileSync(replicaPath(dbPath))).toEqual(before);
  });

  test("replicaToken does not move the token it reports", () => {
    const path = freshDbPath();
    openDb(path).close();
    expect(replicaToken(path)).toBe(replicaToken(path));
  });

  test("the change token moves when the server's DB is written", async () => {
    const path = freshDbPath();
    const db = openDb(path);
    const before = replicaToken(path);
    await createItem(db, { title: "moves the token", type: "task" });
    db.close();
    expect(replicaToken(path)).not.toBe(before);
  });
});

// 308: the swap itself. Retrying the read cannot save a handle that has already crossed a rename --
// on macOS SQLite refuses that handle PERMANENTLY (SQLITE_IOERR_VNODE) once the path it opened no
// longer resolves to the inode it opened, and a fresh open by path succeeds immediately. So the fix is
// not to survive the swap, it is to keep the swap from landing while a reader is open.
describe("remote client: a refresh never lands under an open reader (308)", () => {
  async function seeded(): Promise<Promise<{ dbPath: string; serverPath: string; exec: ReturnType<typeof fakeServer> }>> {
    const serverPath = freshDbPath();
    const server = openDb(serverPath);
    await createItem(server, { title: "first generation", type: "task" });
    server.close();
    const dbPath = join(clientDir(), "omnislash.sqlite");
    const exec = fakeServer(serverPath);
    expect(refreshReplica({ dbPath, host: "ob@server", exec }).refreshed).toBe(true);
    return { dbPath, serverPath, exec };
  }

  test("a reader holds the replica for the LIFETIME of its handle, so the swap defers", async () => {
    const { dbPath, serverPath, exec } = await seeded();
    const before = readFileSync(replicaPath(dbPath));

    const reader = openReplicaForRead(dbPath);
    // the server moves on, so this refresh genuinely wants to replace the file
    const later = openDb(serverPath);
    await createItem(later, { title: "second generation", type: "task" });
    later.close();
    markReplicaDirty(dbPath);

    const blocked = refreshReplica({ dbPath, host: "ob@server", exec, lock: { waitMs: 200 } });
    expect(blocked.deferred).toBe(true);
    expect(blocked.refreshed).toBe(false);
    expect(blocked.error).toBeNull();
    // the file the reader has open is untouched, and the reader keeps working
    expect(readFileSync(replicaPath(dbPath))).toEqual(before);
    expect((reader.query("SELECT title FROM item").all() as { title: string }[]).length).toBe(1);
    // nothing was recorded as done: `dirty` stays set so the next command tries again
    expect(readMeta(dbPath).dirty).toBe(true);

    reader.close();
    const landed = refreshReplica({ dbPath, host: "ob@server", exec, lock: { waitMs: 2_000 } });
    expect({ refreshed: landed.refreshed, deferred: landed.deferred }).toEqual({ refreshed: true, deferred: false });
    const after = openReplicaForRead(dbPath);
    expect((after.query("SELECT title FROM item").all() as { title: string }[]).length).toBe(2);
    after.close();
  });

  test("closing the handle releases the hold: the swap is not blocked by a reader that has finished", async () => {
    const { dbPath } = await seeded();
    const lock = replicaLockPath(dbPath);

    const reader = openReplicaForRead(dbPath);
    expect(acquireFileLock(lock, "exclusive", { waitMs: 100 })).toBeNull();
    reader.close();
    const swap = acquireFileLock(lock, "exclusive", { waitMs: 100 });
    expect(swap).not.toBeNull();
    swap?.release();
  });

  test("a reader that fails to open leaks no hold: a refused replica must not block the next refresh", () => {
    const dir = clientDir();
    const dbPath = join(dir, "omnislash.sqlite");
    const skewed = new Database(replicaPath(dbPath), { create: true });
    skewed.exec("CREATE TABLE item (id TEXT PRIMARY KEY, surprise TEXT)");
    skewed.close();

    expect(() => openReplicaForRead(dbPath)).toThrow(/schema does not match/);
    const swap = acquireFileLock(replicaLockPath(dbPath), "exclusive", { waitMs: 100 });
    expect(swap).not.toBeNull();
    swap?.release();
  });

  test("a new reader queues behind a WAITING swap instead of starving it", async () => {
    // flock hands a shared hold to anyone who asks, waiting exclusive or not, so without this gate a
    // machine that reads the replica continuously never lets a refresh land. Measured on the loop that
    // reproduces the ticket: 3 swaps in 8s without the gate, 56 with it, and no reads lost either way.
    const { dbPath } = await seeded();
    const gate = acquireFileLock(replicaSwapGatePath(dbPath), "exclusive", { waitMs: 100 });
    expect(gate).not.toBeNull();

    const started = Date.now();
    const reader = openReplicaForRead(dbPath, REPLICA_REOPEN_ATTEMPTS, { waitMs: 200, pollMs: 10 });
    const waited = Date.now() - started;
    // it waited for the swap that is queued ...
    expect(waited).toBeGreaterThanOrEqual(190);
    // ... and then read anyway rather than failing a command it could answer
    expect((reader.query("SELECT title FROM item").all() as { title: string }[]).length).toBe(1);
    reader.close();
    gate?.release();
  });

  test("a swap holds the gate WHILE it waits for readers, so new readers cannot starve it", async () => {
    const { dbPath, serverPath, exec } = await seeded();
    const later = openDb(serverPath);
    await createItem(later, { title: "second generation", type: "task" });
    later.close();

    // The gate is granted, the replica itself is not: the shape of a refresh arriving while a reader
    // has the replica open. fds are the only handle a flock stub gets, so they stand in for the files.
    const seen: number[] = [];
    const ops: [number, number][] = [];
    const stub: FlockFn = (fd, op) => {
      ops.push([fd, op]);
      if (!seen.includes(fd)) seen.push(fd);
      if (op === 8) return 0;
      return fd === seen[0] ? 0 : -1;
    };
    const outcome = refreshReplica({
      dbPath,
      host: "ob@server",
      exec,
      lock: { waitMs: 20, pollMs: 5, flock: stub },
    });
    expect(outcome.deferred).toBe(true);
    // two holds were reached for -- the gate first, then the replica -- and not just the replica
    expect(seen.length).toBe(2);
    // and the gate is handed back on the way out, so a deferral does not lock this machine's readers out
    expect(ops).toContainEqual([seen[0], 8]);
  });

  test("a swap that CAN get the hold still replaces the replica: the lock is not a permanent refusal", async () => {
    const { dbPath, serverPath, exec } = await seeded();
    const later = openDb(serverPath);
    await createItem(later, { title: "second generation", type: "task" });
    later.close();
    const outcome = refreshReplica({ dbPath, host: "ob@server", exec, lock: { waitMs: 200 } });
    expect({ refreshed: outcome.refreshed, deferred: outcome.deferred }).toEqual({ refreshed: true, deferred: false });
  });
});

describe("remote client: staleness marker (183)", () => {
  test("a fresh replica says nothing; an old one and an unreachable server both say so", () => {
    const now = Date.parse("2026-08-15T12:00:00.000Z");
    const fresh = { ...readMeta("/nowhere/omnislash.sqlite"), refreshed_at: "2026-08-15T11:59:30.000Z" };
    expect(stalenessNotice({ meta: fresh, unreachable: false, now }).stale).toBe(false);

    const old = { ...fresh, refreshed_at: "2026-08-15T11:56:00.000Z" };
    expect(stalenessNotice({ meta: old, unreachable: false, now }).message).toBe("replica as of 4m ago");

    expect(stalenessNotice({ meta: fresh, unreachable: true, now }).message).toBe(
      "replica as of 30s ago (server unreachable)",
    );
  });
});

describe("remote client: dispatch through run() (183)", () => {
  async function clientWithHost(host: string): Promise<string> {
    const dbPath = join(clientDir(), "omnislash.sqlite");
    const db = openDb(dbPath);
    await setConfig(db, "remote_host", host);
    db.close();
    return dbPath;
  }

  test("configuredRemoteHost reads the LOCAL db, and OB_REMOTE=0 makes it inert", async () => {
    const dbPath = await clientWithHost("ob@10.0.0.20");
    expect(configuredRemoteHost(dbPath, {})).toBe("ob@10.0.0.20");
    expect(configuredRemoteHost(dbPath, { OB_REMOTE: "0" })).toBeNull();
    expect(configuredRemoteHost(join(dirname(dbPath), "absent.sqlite"), {})).toBeNull();
  });

  test("configuredRemoteHost reads a LIVE WAL database, which is the shape every real machine has (1135)", async () => {
    // The reader's own two opens were the bug: `file:<path>?mode=ro` throws SQLITE_CANTOPEN in bun and
    // `{ create: false }` throws "bad parameter or other API misuse", so the catch around them answered
    // "no remote_host" on every invocation and the ssh split never engaged. The whole suite missed it
    // because no fixture was opened the way the CLI opens the database, so this one is: `openDb` leaves
    // it in WAL, and the writer stays OPEN, which is what gives the file its `-wal`/`-shm` sidecars.
    const dbPath = join(clientDir(), "omnislash.sqlite");
    const writer = openDb(dbPath);
    await setConfig(writer, "remote_host", "ob@10.0.0.20");
    expect(writer.query("pragma journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect([existsSync(`${dbPath}-wal`), existsSync(`${dbPath}-shm`)]).toEqual([true, true]);

    expect(configuredRemoteHost(dbPath, {})).toBe("ob@10.0.0.20");
    writer.close();
  });

  test("a write is dispatched over the seam with the original argv, and marks the replica dirty", async () => {
    const dbPath = await clientWithHost("ob@server");
    const exec = fakeServer(freshDbPath());
    const prev = process.env.OMNISLASH_DB;
    process.env.OMNISLASH_DB = dbPath;
    try {
      // `close` is a write that is not rewritten before dispatch. `add` without --project is (243).
      const code = await run(["close", "1"], { exec });
      expect(code).toBe(0);
      expect(exec.calls[0]).toEqual(["close", "1"]);
      expect(readMeta(dbPath).dirty).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.OMNISLASH_DB;
      else process.env.OMNISLASH_DB = prev;
    }
  });

  test("an offline write REFUSES, names the host, says it was not applied, and queues nothing", async () => {
    const dbPath = await clientWithHost("ob@server");
    const exec = fakeServer(freshDbPath());
    exec.reachable = false;
    const prev = process.env.OMNISLASH_DB;
    const origErr = process.stderr.write.bind(process.stderr);
    let err = "";
    (process.stderr.write as unknown) = (chunk: string) => {
      err += chunk;
      return true;
    };
    process.env.OMNISLASH_DB = dbPath;
    try {
      const code = await run(["add", "offline", "--project", "acme"], { exec });
      expect(code).toBe(1);
      expect(err).toContain("ob@server");
      expect(err).toContain("NOT applied");
      expect(readMeta(dbPath).dirty).toBe(false);
    } finally {
      (process.stderr.write as unknown) = origErr;
      if (prev === undefined) delete process.env.OMNISLASH_DB;
      else process.env.OMNISLASH_DB = prev;
    }
  });

  test("the loop guard refuses a second hop instead of ssh-ing to itself", async () => {
    const dbPath = await clientWithHost("ob@server");
    const exec = fakeServer(freshDbPath());
    const prev = process.env.OMNISLASH_DB;
    const origErr = process.stderr.write.bind(process.stderr);
    let err = "";
    (process.stderr.write as unknown) = (chunk: string) => {
      err += chunk;
      return true;
    };
    process.env.OMNISLASH_DB = dbPath;
    process.env.OB_REMOTE_HOP = "1";
    try {
      const code = await run(["add", "looping", "--project", "acme"], { exec });
      expect(code).toBe(1);
      expect(err).toContain("remote hop");
      expect(exec.calls).toEqual([]);
    } finally {
      delete process.env.OB_REMOTE_HOP;
      (process.stderr.write as unknown) = origErr;
      if (prev === undefined) delete process.env.OMNISLASH_DB;
      else process.env.OMNISLASH_DB = prev;
    }
  });

  test("a dirty read refreshes first, so `ob add … && ob next` shows the new item", async () => {
    const serverPath = freshDbPath();
    const server = openDb(serverPath);
    await createItem(server, { title: "written on the server", type: "task" });
    server.close();

    const dbPath = await clientWithHost("ob@server");
    const exec = fakeServer(serverPath);
    markReplicaDirty(dbPath);

    const prev = process.env.OMNISLASH_DB;
    const origLog = console.log;
    let out = "";
    console.log = (...a: unknown[]) => {
      out += a.join(" ") + "\n";
    };
    process.env.OMNISLASH_DB = dbPath;
    try {
      const code = await run(["next"], { exec });
      expect(code).toBe(0);
      expect(out).toContain("written on the server");
      expect(readMeta(dbPath).dirty).toBe(false);
    } finally {
      console.log = origLog;
      if (prev === undefined) delete process.env.OMNISLASH_DB;
      else process.env.OMNISLASH_DB = prev;
    }
  });

  test("the ssh command carries the hop marker and quotes every argument", () => {
    expect(remoteCommand(["add", "it's here", "--json"])).toBe(`OB_REMOTE_HOP=1 ob 'add' 'it'\\''s here' '--json'`);
  });
});

describe("remote client: --db is local-only and never crosses the wire (213)", () => {
  async function clientWithHost(host: string): Promise<string> {
    const dbPath = join(clientDir(), "omnislash.sqlite");
    const db = openDb(dbPath);
    await setConfig(db, "remote_host", host);
    db.close();
    return dbPath;
  }

  async function runCapturingStderr(argv: string[], deps: { exec: RemoteExec }): Promise<Promise<{ code: number; err: string }>> {
    const origErr = process.stderr.write.bind(process.stderr);
    let err = "";
    (process.stderr.write as unknown) = (chunk: string) => {
      err += chunk;
      return true;
    };
    try {
      return { code: await run(argv, deps), err };
    } finally {
      (process.stderr.write as unknown) = origErr;
    }
  }

  test("a write with --db REFUSES, and nothing is dispatched", async () => {
    const dbPath = await clientWithHost("ob@server");
    const exec = fakeServer(freshDbPath());
    const { code, err } = await runCapturingStderr(["--db", dbPath, "add", "x", "--project", "acme"], { exec });
    expect(code).toBe(1);
    // the message contract: the flag, that it is local-only, the host, and every way through
    expect(err).toContain("--db");
    expect(err).toContain("LOCAL-ONLY");
    expect(err).toContain("ob@server");
    expect(err).toContain("nothing ran and nothing was written");
    expect(err).toContain("OB_REMOTE=0");
    expect(err).toContain("--local");
    // the point of the ticket: the flag provably never reached the server
    expect(exec.calls).toEqual([]);
  });

  test("the argv that IS dispatched carries no --db", async () => {
    const dbPath = await clientWithHost("ob@server");
    const exec = fakeServer(freshDbPath());
    const prev = process.env.OMNISLASH_DB;
    process.env.OMNISLASH_DB = dbPath;
    try {
      expect(await run(["close", "1"], { exec })).toBe(0);
      expect(exec.calls[0]).toEqual(["close", "1"]);
      expect(exec.calls.flat()).not.toContain("--db");
    } finally {
      if (prev === undefined) delete process.env.OMNISLASH_DB;
      else process.env.OMNISLASH_DB = prev;
    }
  });

  test("every mode that consults the server refuses --db, reads included", () => {
    const cases: [string, string[], Record<string, unknown>][] = [
      ["add", ["x"], {}], // remote
      ["next", [], {}], // an allowlisted read, served from the replica
      ["next", [], { local: true }], // ... and the same read forced local
      ["daemon", ["status"], {}], // split
      ["spinoff", ["drain"], {}], // split
    ];
    for (const [command, args, flags] of cases) {
      const plan = planExecution({ command, args, flags: { ...flags, db: "/tmp/scratch.sqlite" }, host: "h" });
      expect([command, args.join(" "), plan.mode]).toEqual([command, args.join(" "), "refused"]);
    }
  });

  test("the replica plumbing itself keeps --db: it manages the per-database replica files", () => {
    expect(planExecution({ command: "replica", args: ["refresh"], flags: { db: "/tmp/x.sqlite" }, host: "h" }).mode).toBe("local");
    expect(planExecution({ command: "replica", args: ["token"], flags: { db: "/tmp/x.sqlite" }, host: "h" }).mode).toBe("nodb");
  });

  test("the other path-shaped flags are NOT in this class and still dispatch", () => {
    // The walk (213), pinned so the next person does not redo it. These name something on this machine
    // too, but they are either a directory on whichever machine runs the command, a local input that
    // fails LOUDLY on the server, or data recorded about the client's checkout.
    const cases: [string, string[], Record<string, unknown>][] = [
      ["db", ["snapshot"], { dir: "/tmp/snaps" }],
      ["person", ["doc", "add", "jane"], { path: "/tmp/id.pdf" }],
      ["spinoff", ["queue", "213"], { repo: "/tmp/repo", worktree: "/tmp/wt", branch: "213-x" }],
      ["agent", ["register"], { worktree: "/tmp/wt", branch: "213-x" }],
    ];
    for (const [command, args, flags] of cases) {
      expect([command, planExecution({ command, args, flags, host: "h" }).mode]).toEqual([command, "remote"]);
    }
  });

  test("with no remote_host, --db behaves exactly as it always has", async () => {
    const dbPath = freshDbPath();
    openDb(dbPath).close();
    const origLog = console.log;
    console.log = () => {};
    try {
      expect(await run(["--db", dbPath, "add", "an item in the named database", "--project", "acme"])).toBe(0);
    } finally {
      console.log = origLog;
    }
    const db = openDb(dbPath);
    const titles = (db.query("SELECT title FROM item").all() as { title: string }[]).map((r) => r.title);
    db.close();
    expect(titles).toEqual(["an item in the named database"]);
  });
});

describe("remote client: nothing changes with no remote_host (183)", () => {
  test("a plain local run reads and writes the real DB exactly as before", async () => {
    const dbPath = freshDbPath();
    const added = await runCli(dbPath, ["add", "a local item", "--project", "acme", "--json"]);
    expect(added.code).toBe(0);
    const next = await runCli(dbPath, ["next"]);
    expect(next.code).toBe(0);
    expect(next.out).toContain("a local item");
    expect(next.err).toBe("");
    expect(existsSync(replicaPath(dbPath))).toBe(false);
  });

  test("`dumpReplica` produces a gzipped database that opens", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    await createItem(db, { title: "dump me", type: "task" });
    let bytes: Uint8Array = new Uint8Array();
    await dumpReplica(db, (b) => {
      bytes = new Uint8Array(b);
    });
    db.close();
    const out = join(clientDir(), "copy.sqlite");
    writeFileSync(out, gunzip(bytes));
    const copy = openReadOnly(out);
    expect((copy.query("SELECT title FROM item").all() as { title: string }[])[0]?.title).toBe("dump me");
    copy.close();
  });
});

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DatabaseBusyError, WRITE_ATTEMPTS, isBusyFailure, withBusyRetry, writeTxn } from "../../../apps/cli/src/db/busy.ts";
import { registerAgent, getAgent } from "../../cli-coord/src/agent.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { freshDbPath, spawnBudget } from "../../../apps/cli/test/helpers.ts";

// ob 317: a write that loses a race for the lock must WAIT, not die.
//
// Two writes died of contention on the live server on the same day, and both were
// `db.transaction(...)()`: a deferred BEGIN, which upgrades a read lock to a write lock and is
// refused OUTRIGHT (no busy handler, so busy_timeout never applies). Everything below is that
// failure, made into assertions.

/** A real second process that holds the write lock for `holdMs` and then commits. A second handle in
 *  THIS process would deadlock the test rather than contend: the waiter blocks the only thread, so the
 *  holder could never reach its COMMIT. */
function spawnLockHolder(path: string, holdMs: number): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  const script = `
    import { Database } from "bun:sqlite";
    const db = new Database(${JSON.stringify(path)}, { create: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("BEGIN IMMEDIATE;");
    db.query("INSERT INTO lock_probe (v) VALUES (?)").run("holder");
    console.log("HELD");
    Bun.sleepSync(${holdMs});
    db.exec("COMMIT;");
  `;
  return Bun.spawn(["bun", "-e", script], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
}

/** Block until the holder says it has the lock, so the contention the test asserts on is real. */
async function waitForHold(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  while (!seen.includes("HELD")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`lock holder exited without taking the lock: ${seen}`);
    seen += decoder.decode(value);
  }
  reader.releaseLock();
}

function busyError(): Error {
  const err = new Error("database is locked") as Error & { code: string };
  err.code = "SQLITE_BUSY";
  return err;
}

function ioError(): Error {
  const err = new Error("disk I/O error") as Error & { code: string };
  err.code = "SQLITE_IOERR";
  return err;
}

describe("withBusyRetry (317)", () => {
  test("a write that hits SQLITE_BUSY once and then succeeds is retried, not failed", () => {
    let attempts = 0;
    const result = withBusyRetry("write the row", () => {
      attempts++;
      if (attempts === 1) throw busyError();
      return "written";
    });
    expect({ attempts, result }).toEqual({ attempts: 2, result: "written" });
  });

  test("a write that stays contended past the bound gives up with a clear error, bounded", () => {
    let attempts = 0;
    let thrown: unknown;
    const startedAt = Date.now();
    try {
      withBusyRetry("register the agent", () => {
        attempts++;
        throw busyError();
      });
    } catch (err) {
      thrown = err;
    }
    expect(attempts).toBe(WRITE_ATTEMPTS); // bounded: it does not loop until it wins
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(thrown).toBeInstanceOf(DatabaseBusyError);
    const message = (thrown as Error).message;
    expect(message).toContain("could not register the agent");
    expect(message).toContain("locked by another process");
    expect(message).toContain("nothing was written"); // the retry-is-safe promise, spelled out
    expect(message).toContain("database is locked"); // the sqlite reason, not swallowed
  });

  test("a non-BUSY sqlite error is surfaced on the FIRST attempt, never retried", () => {
    let attempts = 0;
    let thrown: unknown;
    try {
      withBusyRetry("write the row", () => {
        attempts++;
        throw ioError();
      });
    } catch (err) {
      thrown = err;
    }
    // 308 is in flight over an SQLITE_IOERR replica race. Retrying it here would hide exactly that.
    expect(attempts).toBe(1);
    expect((thrown as Error & { code: string }).code).toBe("SQLITE_IOERR");
    expect(thrown).not.toBeInstanceOf(DatabaseBusyError);
  });

  test("isBusyFailure knows contention from everything else", () => {
    expect(isBusyFailure(busyError())).toBe(true);
    expect(isBusyFailure(new Error("wrapped"))).toBe(false);
    expect(isBusyFailure({ cause: busyError(), message: "outer" })).toBe(true);
    expect(isBusyFailure(ioError())).toBe(false);
    const locked = new Error("nope") as Error & { code: string };
    locked.code = "SQLITE_LOCKED";
    expect(isBusyFailure(locked)).toBe(true);
  });
});

describe("writeTxn under real contention (317)", () => {
  // THE REGRESSION. Against a deferred `db.transaction(...)()` this body fails in ~1ms with "database
  // is locked" even though busy_timeout is 5000: the read-to-write upgrade is refused without the busy
  // handler ever being called. Taking the write lock at BEGIN puts the wait back.
  test("a read-then-write transaction WAITS for the lock holder instead of dying", async () => {
    const path = freshDbPath();
    const db = new Database(path, { create: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("CREATE TABLE lock_probe (id INTEGER PRIMARY KEY, v TEXT);");

    const holder = spawnLockHolder(path, 1200);
    await waitForHold(holder);

    const startedAt = Date.now();
    const wrote = writeTxn(db, "write the probe row", () => {
      const before = db.query("SELECT count(*) AS n FROM lock_probe").get() as { n: number };
      db.query("INSERT INTO lock_probe (v) VALUES (?)").run(`after-${before.n}`);
      return before.n;
    });
    const waitedMs = Date.now() - startedAt;
    await holder.exited;

    expect(waitedMs).toBeGreaterThan(300); // it really did wait on the holder, rather than racing past
    expect(wrote).toBe(1); // and it read the holder's committed row, so it ran AFTER the commit
    const rows = db.query("SELECT v FROM lock_probe ORDER BY id").all() as { v: string }[];
    expect(rows.map((r) => r.v)).toEqual(["holder", "after-1"]);
    db.close();
  }, spawnBudget(1));

  // The same proof through a real command's write, which is one of the two that failed live.
  test("registerAgent survives a lock holder", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    db.exec("CREATE TABLE IF NOT EXISTS lock_probe (id INTEGER PRIMARY KEY, v TEXT);");

    const holder = spawnLockHolder(dbPath, 900);
    await waitForHold(holder);

    (await registerAgent(db, { id: "build-317", status: "working", ttlS: 60 }));
    await holder.exited;

    expect((await getAgent(db, "build-317"))?.status).toBe("working");
    db.close();
  }, spawnBudget(1));
});

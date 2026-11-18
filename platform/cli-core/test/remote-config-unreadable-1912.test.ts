import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppError } from "../../../apps/cli/src/errors.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import type { Ctx } from "../../../apps/cli/src/ctx.ts";
import { cmdReplica } from "../../../apps/cli/src/commands/replica.ts";
import { runCli } from "../../../apps/cli/test/helpers.ts";
import { configuredRemoteHost, RemoteConfigUnreadable } from "../../../apps/cli/src/remote.ts";

// OB-1912: configuredRemoteHost used to answer null (= "no server configured") for ANY read error, so a
// client whose config could not be read silently took the local path and wrote a sqlite the server never
// saw. Only the four honest "not configured" cases answer null now; everything else throws. No network,
// no live DB: every database here is a fixture in a fresh temp dir, and the open seam fakes the failures.

function dir(): string {
  return mkdtempSync(join(tmpdir(), "ob-1912-"));
}

/** A real DB file on disk (the function checks existsSync before it calls the seam). */
function dbFile(): string {
  const dbPath = join(dir(), "omnislash.sqlite");
  writeFileSync(dbPath, "");
  return dbPath;
}

const throwing = (message: string) => () => {
  throw new Error(message);
};

describe("configuredRemoteHost fails closed on a read error (OB-1912)", () => {
  test("an open that throws SQLITE_CANTOPEN throws RemoteConfigUnreadable naming the path and the cause", () => {
    const dbPath = dbFile();
    let thrown: unknown;
    try {
      configuredRemoteHost(dbPath, {}, throwing("SQLITE_CANTOPEN: unable to open database file"));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RemoteConfigUnreadable);
    expect(thrown).toBeInstanceOf(AppError);
    const message = (thrown as Error).message;
    expect(message).toContain("remote_host");
    expect(message).toContain(dbPath);
    expect(message).toContain("SQLITE_CANTOPEN");
    expect(message).toContain("OB_REMOTE=0");
  });

  test("a query that throws something other than a missing table also throws (SQLITE_BUSY)", () => {
    const dbPath = dbFile();
    // A real handle whose `config` table is locked away is hard to stage, so the seam returns a handle
    // whose every statement throws BUSY.
    const open = () => {
      const db = new Database(":memory:");
      db.prepare = (() => {
        throw new Error("SQLITE_BUSY: database is locked");
      }) as unknown as typeof db.prepare;
      return db;
    };
    expect(() => configuredRemoteHost(dbPath, {}, open)).toThrow(RemoteConfigUnreadable);
  });

  test("a DB with no config table answers null", () => {
    const dbPath = dbFile();
    expect(configuredRemoteHost(dbPath, {}, () => new Database(":memory:"))).toBeNull();
  });

  test("the query throwing 'no such table: config' answers null", () => {
    const dbPath = dbFile();
    const open = () => {
      const db = new Database(":memory:");
      db.prepare = (() => {
        throw new Error("no such table: config");
      }) as unknown as typeof db.prepare;
      return db;
    };
    expect(configuredRemoteHost(dbPath, {}, open)).toBeNull();
  });

  test("a readable config with no remote_host answers null; with one it answers the host", async () => {
    const dbPath = join(dir(), "omnislash.sqlite");
    const db = openDb(dbPath);
    expect(configuredRemoteHost(dbPath, {})).toBeNull();
    await setConfig(db, "remote_host", "   ");
    expect(configuredRemoteHost(dbPath, {})).toBeNull();
    await setConfig(db, "remote_host", "ob@10.0.0.20");
    expect(configuredRemoteHost(dbPath, {})).toBe("ob@10.0.0.20");
    db.close();
  });

  test("a missing DB file answers null without calling the open seam", () => {
    const open = () => {
      throw new Error("open must not be called");
    };
    expect(configuredRemoteHost(join(dir(), "absent.sqlite"), {}, open)).toBeNull();
  });

  test("OB_REMOTE=0 answers null without calling the open seam", () => {
    let calls = 0;
    const open = () => {
      calls++;
      throw new Error("open must not be called");
    };
    expect(configuredRemoteHost(dbFile(), { OB_REMOTE: "0" }, open)).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("the CLI entry fails closed on an unreadable remote_host (OB-1912)", () => {
  test("a write command against an unreadable DB exits 1 with the named error and writes nothing", async () => {
    const dbPath = join(dir(), "omnislash.sqlite");
    // Not an sqlite file: opening it succeeds lazily, reading the config fails with "not a database".
    writeFileSync(dbPath, "this is not a sqlite database, it is long enough to look like a header\n".repeat(8));
    const before = readFileSync(dbPath);

    const res = await runCli(dbPath, ["add", "should not be written"]);

    expect(res.code).toBe(1);
    expect(res.err).toMatch(/^error: .*remote_host/);
    expect(res.err).toContain(dbPath);
    expect(res.err).toContain("OB_REMOTE=0");
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
  });

  test("OB_REMOTE=0 is the escape hatch: the same unreadable path no longer trips the named error", async () => {
    const dbPath = join(dir(), "omnislash.sqlite");
    writeFileSync(dbPath, "this is not a sqlite database, it is long enough to look like a header\n".repeat(8));
    const prev = process.env.OB_REMOTE;
    process.env.OB_REMOTE = "0";
    try {
      const res = await runCli(dbPath, ["add", "x"]);
      expect(res.err).not.toContain("could not read the remote_host");
    } finally {
      if (prev === undefined) delete process.env.OB_REMOTE;
      else process.env.OB_REMOTE = prev;
    }
  });

  test("replica status (unit: the command is not routed from HANDLERS today) reports it and exits non-zero", async () => {
    const dbPath = join(dir(), "omnislash.sqlite");
    writeFileSync(dbPath, "this is not a sqlite database, it is long enough to look like a header\n".repeat(8));
    const ctx = { dbPath, args: ["status"], mode: "text", flags: {} } as unknown as Ctx;
    let out = "";
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      out += a.join(" ") + "\n";
    };
    try {
      await cmdReplica(ctx);
    } finally {
      console.log = origLog;
    }
    expect(ctx.exit).toBe(1);
    expect(out).toContain("remote_host");
    expect(out).toContain(dbPath);
  });
});

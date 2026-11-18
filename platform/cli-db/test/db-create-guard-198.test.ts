import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DB_CREATE_ENV, openDb } from "../../../apps/cli/src/db.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

// 198: on the freshly provisioned server a bare `ob status` created and migrated a database at the
// DEFAULT path, because the units' OMNISLASH_DB is not in an interactive shell's environment. It answered
// as an empty tracker and accepted writes, sitting exactly where the next variable-less command would
// find it. Two databases on the writer machine, one of them a decoy, is a data-loss shape rather than an
// inconvenience.
//
// The guard: creating a database is deliberate. The opt-in env var creates one, and every command
// either opens what is there or refuses by name. These tests assert the refusal MESSAGE, not merely
// that something threw, because the message is the whole product here: the most likely reader is
// someone who is one environment variable away from their real tracker.

const INDEX = join(import.meta.dir, "../../../apps/cli/src/index.ts");
const temps: string[] = [];

function tempDbPath(): string {
  const p = join(tmpdir(), `ob-create-guard-${randomUUID()}.sqlite`);
  temps.push(p);
  return p;
}

/** The env a real `ob` on that box has: a DB path, and no creation opt-in (the preload sets one). */
function envWithoutOptIn(dbPath: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), OMNISLASH_DB: dbPath };
  delete env[DB_CREATE_ENV];
  return env;
}

function ob(args: string[], dbPath: string) {
  const proc = Bun.spawnSync(["bun", "run", INDEX, ...args], {
    env: envWithoutOptIn(dbPath),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

/** Run `fn` with the process-wide opt-in removed, restoring whatever the preload left. */
function withoutOptIn<T>(fn: () => T): T {
  const previous = process.env[DB_CREATE_ENV];
  delete process.env[DB_CREATE_ENV];
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[DB_CREATE_ENV];
    else process.env[DB_CREATE_ENV] = previous;
  }
}

afterEach(() => {
  for (const p of temps.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${p}${suffix}`, { force: true });
  }
});

describe("creating a database is deliberate (198)", () => {
  test("a missing database is refused, and the refusal names the path, OMNISLASH_DB, --db and the create env", () => {
    const path = tempDbPath();
    const message = withoutOptIn(() => {
      let thrown: unknown;
      try {
        openDb(path);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, "openDb created a database nobody asked for").toBeInstanceOf(Error);
      return (thrown as Error).message;
    });
    expect(message).toContain(path);
    expect(message).toContain("OMNISLASH_DB");
    expect(message).toContain("--db");
    expect(message).toContain(DB_CREATE_ENV);
    // Nothing was created on the way to refusing: no decoy, not even an empty file.
    expect(existsSync(path)).toBe(false);
  });

  test("the deliberate path creates and migrates it, and reopening is silent", () => {
    const path = tempDbPath();
    withoutOptIn(() => {
      const created = openDb(path, { create: true });
      created.query("INSERT INTO config (key, value) VALUES ('probe', 'set')").run();
      created.close();
      // Existing DB: opens with no opt-in and no create flag, exactly as before the guard.
      const reopened = openDb(path);
      expect(reopened.query("SELECT value FROM config WHERE key = 'probe'").get()).toEqual({ value: "set" });
      reopened.close();
    });
  });

  test("the env opt-in is the one-command escape hatch", () => {
    const path = tempDbPath();
    const previous = process.env[DB_CREATE_ENV];
    process.env[DB_CREATE_ENV] = "1";
    try {
      const db = openDb(path);
      expect(db.query("SELECT 1 AS ok FROM item LIMIT 1").all()).toEqual([]);
      db.close();
    } finally {
      if (previous === undefined) delete process.env[DB_CREATE_ENV];
      else process.env[DB_CREATE_ENV] = previous;
    }
    expect(existsSync(path)).toBe(true);
  });
});

describe("the guard through the real CLI (198)", () => {
  test("ob next refuses, the create env creates, and the next ob next is silent", () => {
    const path = tempDbPath();

    const refused = ob(["next"], path);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain(`no database at ${path}`);
    expect(refused.err).toContain("OMNISLASH_DB");
    expect(existsSync(path)).toBe(false);

    const created = Bun.spawnSync(["bun", "run", INDEX, "next"], {
      env: { ...envWithoutOptIn(path), [DB_CREATE_ENV]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(created.exitCode).toBe(0);
    expect(existsSync(path)).toBe(true);

    const opened = ob(["next"], path);
    expect({ code: opened.code, err: opened.err }).toEqual({ code: 0, err: "" });
  }, spawnBudget(3));
});

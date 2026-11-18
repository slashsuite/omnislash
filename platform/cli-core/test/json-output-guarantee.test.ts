import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { HANDLERS } from "../../../apps/cli/src/cli.ts";
import { print } from "../../../apps/cli/src/output.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";

// 149: `ob lease status --json` was observed returning EMPTY stdout under full-suite load. The caller
// parsed it and reported a JSON parse error against itself, so the failure looked like the caller's bug.
// Two real causes, both in openDb(): `PRAGMA journal_mode = WAL` ran BEFORE `PRAGMA busy_timeout`, so a
// concurrent WAL recovery raised SQLITE_BUSY_RECOVERY with a 0ms retry budget; and two processes racing
// to apply migration 0000 to the same fresh DB left the loser throwing "table item already exists".
// openDb() was called OUTSIDE run()'s try/catch, so either escaped as an uncaught throw: exit 1, a raw
// Bun stack on stderr, nothing on stdout.
//
// These tests pin the GUARANTEE rather than the cause: a `--json` invocation either prints parseable
// JSON or exits non-zero with a reason on stderr, never both silent and successful.

const INDEX = join(import.meta.dir, "../../../apps/cli/src/index.ts");
const temps: string[] = [];

function tempDbPath(): string {
  const p = join(tmpdir(), `ob-json-guarantee-${randomUUID()}.sqlite`);
  temps.push(p);
  return p;
}

afterEach(() => {
  for (const p of temps.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${p}${suffix}`, { force: true });
  }
});

// The read commands with REAL scripted consumers: the daemon and `ob spinoff drain` both
// parse these. Every one is exercised against an EMPTY DB, because an empty result set is
// precisely where "print nothing" hides.
const CONSUMED_READS: string[][] = [
  ["lease", "status"],
  ["agents"],
  ["spinoff", "list"],
  ["focus"],
  ["next"],
  ["list"],
  ["status"],
];

describe("--json is never both silent and successful (149)", () => {
  for (const args of CONSUMED_READS) {
    test(`ob ${args.join(" ")} --json emits parseable JSON on an empty DB`, async () => {
      const r = await runCli(freshDbPath(), [...args, "--json"]);
      expect({ cmd: args.join(" "), code: r.code, err: r.err }).toEqual({
        cmd: args.join(" "),
        code: 0,
        err: "",
      });
      expect(r.out.trim().length).toBeGreaterThan(0);
      expect(() => JSON.parse(r.out) as unknown).not.toThrow();
    });
  }

  test("an empty result set is [] or {}, not nothing", async () => {
    const db = freshDbPath();
    for (const args of [["lease", "status"], ["agents"], ["spinoff", "list"], ["list"], ["next"]]) {
      const r = await runCli(db, [...args, "--json"]);
      expect(JSON.parse(r.out)).toEqual([]);
    }
    // `ob focus` with nothing set is the same shape of empty: an object with a null field, never silence.
    const focus = await runCli(db, ["focus", "--json"]);
    expect(JSON.parse(focus.out)).toEqual({ focus_project: null });
  });

  test("a handler that prints nothing in --json mode fails LOUDLY instead of exiting 0 silent", async () => {
    const silent = "json-guarantee-silent-probe";
    HANDLERS[silent] = () => {};
    try {
      const r = await runCli(freshDbPath(), [silent, "--json"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toBe("");
      expect(r.err).toContain("produced no --json output");
      expect(r.err).toContain(silent);
    } finally {
      delete HANDLERS[silent];
    }
  });

  test("the guarantee does not fire on a handler that DID print", async () => {
    const loud = "json-guarantee-loud-probe";
    HANDLERS[loud] = () => print(JSON.stringify({ ok: true }));
    try {
      const r = await runCli(freshDbPath(), [loud, "--json"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toEqual({ ok: true });
    } finally {
      delete HANDLERS[loud];
    }
  });

  test("a --json command that fails puts its reason on stderr, never leaving stdout silently empty", async () => {
    const r = await runCli(freshDbPath(), ["focus", "no-such-project", "--json"]);
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("no project 'no-such-project'");
  });
});

interface Ran {
  code: number;
  out: string;
  err: string;
}

/** A REAL `ob` subprocess: the concurrency this reproduces only exists across processes. */
async function obProcess(dbPath: string, args: string[]): Promise<Ran> {
  const p = Bun.spawn([process.execPath, "run", INDEX, ...args], {
    env: { ...process.env, OMNISLASH_DB: dbPath, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

describe("concurrent ob processes on one DB still each emit parseable JSON (149)", () => {
  // The exact shape of the original failure: many `ob` processes opening the SAME fresh DB at once, so
  // they race both the WAL switch and migration 0000. Before the fix this failed within the first batch.
  test("24 concurrent `ob lease status --json` against a fresh DB all succeed", async () => {
    const db = tempDbPath();
    const runs = await Promise.all(Array.from({ length: 24 }, () => obProcess(db, ["lease", "status", "--json"])));
    const broken = runs
      .map((r, i) => ({ i, code: r.code, bytes: r.out.length, err: r.err.trim().slice(0, 400) }))
      .filter((r) => r.code !== 0 || r.bytes === 0);
    expect(broken).toEqual([]);
    for (const r of runs) expect(JSON.parse(r.out)).toEqual([]);
  }, 60_000);

  test("a concurrent read never exits 0 with empty stdout, and any failure names itself on stderr", async () => {
    const db = tempDbPath();
    const runs = await Promise.all(Array.from({ length: 16 }, () => obProcess(db, ["agents", "--json"])));
    for (const r of runs) {
      if (r.code === 0) expect(r.out.trim().length).toBeGreaterThan(0);
      else expect(r.err.trim().length).toBeGreaterThan(0);
    }
  }, 60_000);
});

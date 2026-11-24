// ob 337: how `ob backup` and `ob db snapshot` take a copy of the Postgres database.
//
// This is the ob 326 precondition, and it is asserted here rather than by running a backup for two
// reasons: a real `ob backup` pushes to a PRIVATE GITHUB RELEASE, and a real capture would dump the live
// database on the database host. Both halves of the decision are pure functions precisely so that neither is needed
// -- the argv and the libpq environment are computed, and the spawn is injected.
//
// What is actually being defended. The failure this replaces is not a crash; it is `ob backup` continuing
// to exit 0 every month while copying a SQLite file that Postgres had replaced, and it being found at
// restore time. So the tests below are about the things a restore depends on: the format, the NAME that
// declares the format, the fact that a failed dump is loud rather than counted as a backup, and the fact
// that a dump nobody can read is treated as a failure rather than as a copy.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiCtx } from "../../../apps/cli/src/api/client-handlers.ts";
import { apiDb } from "../../../apps/cli/src/api/host-job-client.ts";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import {
  ARTIFACT_SUFFIX,
  capture,
  describeCapture,
  pgDumpArgv,
  pgDumpEnv,
  pgRestoreListArgv,
  restoreHint,
  type CaptureRun,
} from "../../../apps/cli/src/db/capture.ts";
import {
  parseSnapshotName,
  planSnapshotRotation,
  snapshotFileName,
  snapshotName,
  estimateNextSnapshotBytes,
  LEGACY_SNAPSHOT_PREFIX,
  SNAPSHOT_PREFIX,
} from "../../../apps/cli/src/commands/db.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";

const URL_WITH_PASSWORD = "postgres://ob:sekrit@10.0.0.133:5432/omnislash";

describe("the capture argv and environment (337)", () => {
  test("the dump is custom-format, compressed, and never prompts", () => {
    expect(pgDumpArgv("/tmp/x.dump")).toEqual([
      "pg_dump",
      "--format=custom",
      "--compress=9",
      "--no-password",
      "--file=/tmp/x.dump",
    ]);
  });

  test("NO connection information rides in the argv, so no password is ever visible in `ps`", () => {
    const argv = pgDumpArgv("/tmp/x.dump");
    expect(argv.join(" ")).not.toContain("sekrit");
    expect(argv.join(" ")).not.toContain("10.0.0.133");
    expect(argv.join(" ")).not.toContain("ob:");
  });

  test("the connection travels as the libpq environment instead", () => {
    expect(pgDumpEnv(URL_WITH_PASSWORD)).toEqual({
      PGDATABASE: "omnislash",
      PGHOST: "10.0.0.133",
      PGPORT: "5432",
      PGUSER: "ob",
      PGPASSWORD: "sekrit",
    });
  });

  test("a unix-socket url puts the SOCKET PATH in PGHOST, not the empty tcp host", () => {
    // libpq spells a socket connection `?host=/var/run/postgresql`, which URL parsing leaves in the
    // query string. A socket path is never a TCP host, so it wins.
    const env = pgDumpEnv("postgres:///omnislash?host=/var/run/postgresql");
    expect(env.PGHOST).toBe("/var/run/postgresql");
    expect(env.PGDATABASE).toBe("omnislash");
    // The other spelling of the same thing: the socket path percent-encoded into the host position. It
    // has to decode, or PGHOST becomes a directory name with %2F in it and the connection fails.
    expect(pgDumpEnv("postgresql://ob@%2Fvar%2Frun%2Fpostgresql/omnislash")).toMatchObject({
      PGHOST: "/var/run/postgresql",
      PGUSER: "ob",
      PGDATABASE: "omnislash",
    });
  });

  test("a password with url-unsafe characters survives the round trip", () => {
    expect(pgDumpEnv("postgres://ob:p%40ss%3Aword@host/omnislash").PGPASSWORD).toBe("p@ss:word");
  });

  test("a url naming no database is refused rather than dumping something else", () => {
    expect(() => pgDumpEnv("postgres://ob:x@host:5432/")).toThrow(AppError);
    expect(() => pgDumpEnv("not a url at all")).toThrow(AppError);
  });

  test("the dry-run description names the connection but NEVER the password", () => {
    const described = describeCapture("/tmp/x.dump", URL_WITH_PASSWORD);
    expect(described).toContain("pg_dump");
    expect(described).toContain("PGDATABASE=omnislash");
    expect(described).toContain("PGHOST=10.0.0.133");
    expect(described).not.toContain("sekrit");
  });
});

describe("capture: a failure is loud, and an unreadable dump is a failure (337)", () => {
  const ok: CaptureRun = { ok: true, stderr: "" };

  test("the happy path dumps and then VERIFIES the dump is readable by pg_restore", () => {
    const calls: string[][] = [];
    capture({
      dest: "/tmp/x.dump",
      url: URL_WITH_PASSWORD,
      spawn: (cmd) => {
        calls.push(cmd);
        return ok;
      },
    });
    // Two commands, in this order: take the copy, then read its table of contents. The second is what
    // catches a truncated or corrupt file on the night it happens rather than on the night it is needed.
    expect(calls).toEqual([pgDumpArgv("/tmp/x.dump"), pgRestoreListArgv("/tmp/x.dump")]);
  });

  test("the environment reaches the spawn, so the dump can actually authenticate", () => {
    let seen: Record<string, string> | null = null;
    capture({
      dest: "/tmp/x.dump",
      url: URL_WITH_PASSWORD,
      spawn: (_cmd, env) => {
        seen = env;
        return ok;
      },
    });
    expect(seen).toMatchObject({ PGDATABASE: "omnislash", PGUSER: "ob", PGPASSWORD: "sekrit" });
  });

  test("a failed pg_dump THROWS and says outright that there is no backup", () => {
    expect(() =>
      capture({
        dest: "/tmp/x.dump",
        url: URL_WITH_PASSWORD,
        spawn: (cmd) => (cmd[0] === "pg_dump" ? { ok: false, stderr: "could not connect to server" } : ok),
      }),
    ).toThrow(/NO backup/);
  });

  test("a dump pg_restore cannot read is NOT counted as a backup", () => {
    // The whole failure class here is a backup command that reports success having produced something
    // worthless, so an unreadable artifact has to fail exactly as loudly as a dump that never ran.
    expect(() =>
      capture({
        dest: "/tmp/x.dump",
        url: URL_WITH_PASSWORD,
        spawn: (cmd) => (cmd[0] === "pg_restore" ? { ok: false, stderr: "input file appears truncated" } : ok),
      }),
    ).toThrow(/not readable by pg_restore/);
  });

  test("the failure message does not leak the password either", () => {
    try {
      capture({
        dest: "/tmp/x.dump",
        url: URL_WITH_PASSWORD,
        spawn: () => ({ ok: false, stderr: "nope" }),
      });
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("sekrit");
      expect((err as Error).message).toContain("pg_dump");
    }
  });
});

describe("the artifacts declare their own format (337)", () => {
  test("both the monthly backup and the local snapshot are named .dump, not .sqlite", () => {
    expect(ARTIFACT_SUFFIX).toBe(".dump");
    expect(snapshotFileName(new Date(2026, 7, 18))).toBe("omnislash-2026-08-18.dump");
    expect(snapshotName(new Date(2026, 7, 18, 3, 15, 0))).toBe("omnislash-snap-20260818-031500.dump");
  });

  test("a pre-cutover .sqlite snapshot is NOT one of ours, so rotation never deletes it", () => {
    // The last SQLite copies taken before the cutover are the ones worth keeping longest. Rotation only
    // ever considers names parseSnapshotName accepts, so leaving them unparseable leaves them alone.
    expect(parseSnapshotName("omnislash-snap-20260817-030000.sqlite")).toBeNull();
    expect(parseSnapshotName("omnislash-snap-20260818-031500.dump")).not.toBeNull();
  });

  test("the restore hint names pg_restore and the single-table form", () => {
    expect(restoreHint("omnislash-2026-08-18.dump")).toContain("pg_restore");
    expect(restoreHint("omnislash-2026-08-18.dump")).toContain("--table");
  });
});

describe("legacy omnibus-snap snapshots are listed but never rotated (OS-161)", () => {
  const MB = 1024 ** 2;
  const at = (prefix: string, h: number, mb = 100) => {
    const taken = new Date(2026, 10, 24, h, 0, 0);
    return { name: snapshotName(taken).replace(SNAPSHOT_PREFIX, prefix), bytes: mb * MB, taken };
  };

  test("a mixed set, the same timestamp under both prefixes included, prunes and counts only omnislash-snap", () => {
    const legacy = [at(LEGACY_SNAPSHOT_PREFIX, 1), at(LEGACY_SNAPSHOT_PREFIX, 2), at(LEGACY_SNAPSHOT_PREFIX, 3, 5000)];
    const current = [at(SNAPSHOT_PREFIX, 2), at(SNAPSHOT_PREFIX, 3), at(SNAPSHOT_PREFIX, 4)];
    expect(legacy.every((e) => parseSnapshotName(e.name) !== null)).toBe(true);
    // hour 2 and hour 3 exist under both prefixes
    expect(legacy[1]!.taken.getTime()).toBe(current[0]!.taken.getTime());

    // Age: keep only the newest; the two older omnislash files go, no legacy one does.
    const byAge = planSnapshotRotation([...legacy, ...current], { keepHourly: 1, keepDaily: 0 });
    expect(byAge.keep.map((e) => e.name)).toEqual([current[2]!.name]);
    expect(byAge.prune.map((e) => e.name)).toEqual([current[0]!.name, current[1]!.name]);

    // Budget: 300 MB of omnislash fits under 350 MB, so the 5 GB of legacy files are not counted and
    // nothing is pruned.
    const byBudget = planSnapshotRotation([...legacy, ...current], { keepHourly: 24, keepDaily: 0, maxBytes: 350 * MB });
    expect(byBudget.prune).toEqual([]);
    expect(byBudget.keep.map((e) => e.name).sort()).toEqual(current.map((e) => e.name).sort());

    // Free space: nothing to free but legacy files, so it falls short rather than delete one.
    const byFree = planSnapshotRotation([...legacy, { ...at(SNAPSHOT_PREFIX, 5), pending: true }], {
      freeBytes: 0,
      reserveBytes: 50 * MB,
    });
    expect(byFree.prune).toEqual([]);
    expect(byFree.shortfallBytes).toBeGreaterThan(0);
  });
});

describe("ob db fetch takes a legacy omnibus-snap name to the API (OS-161)", () => {
  async function fetchName(name: string): Promise<string[]> {
    const fetched: string[] = [];
    const out = mkdtempSync(join(tmpdir(), "os161-fetch-"));
    const client = {
      dbSnapshotFetch: async (n: string) => {
        fetched.push(n);
        return 0;
      },
    } as unknown as ApiCtx["client"];
    try {
      await apiDb({ client, mode: "quiet", flags: { out }, args: ["fetch", name], cwd: out, git: () => ({}) });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    return fetched;
  }

  test("an omnibus-snap name passes the client check and is requested", async () => {
    expect(await fetchName("omnibus-snap-20261124-043035.dump")).toEqual(["omnibus-snap-20261124-043035.dump"]);
  });

  test("a name that is not a snapshot is still refused before any request", async () => {
    await expect(fetchName("omnibus-2026-11-24.dump")).rejects.toBeInstanceOf(UsageError);
  });
});

describe("estimating the next dump with no file to measure (337)", () => {
  const at = (h: number, mb: number) => ({
    name: snapshotName(new Date(2026, 7, 18, h, 0, 0)),
    bytes: mb * 1024 ** 2,
    taken: new Date(2026, 7, 18, h, 0, 0),
  });

  test("with no history at all the estimate is 0: nothing is known yet, and it says so", () => {
    expect(estimateNextSnapshotBytes([])).toBe(0);
  });

  test("the estimate is the largest of the three most recent, so it over-estimates rather than under", () => {
    // Over-estimating prunes one extra file; under-estimating fills the volume. Only one of those is
    // recoverable, so the estimate leans that way on purpose.
    expect(estimateNextSnapshotBytes([at(1, 10), at(2, 30), at(3, 20)])).toBe(30 * 1024 ** 2);
    // An ancient outlier does not drag the estimate up forever: only the recent ones are consulted.
    expect(estimateNextSnapshotBytes([at(1, 900), at(20, 10), at(21, 12), at(22, 11)])).toBe(12 * 1024 ** 2);
  });
});

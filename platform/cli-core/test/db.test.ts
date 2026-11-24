import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import {
  localDateStamp,
  monthStamp,
  snapshotFileName,
  releaseTag,
  parseBackupTag,
  prunableTags,
  createCmd,
  uploadCmd,
  deleteCmd,
  fmtCmd,
  assertNoKeyMaterialInBackup,
  snapshotName,
  parseSnapshotName,
  parseSnapshot,
  SNAPSHOT_PREFIX,
  LEGACY_SNAPSHOT_PREFIX,
  planSnapshotRotation,
  fmtBytes,
  ensureGh,
  type SnapshotEntry,
} from "../../../apps/cli/src/commands/db.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";

// Local-date helpers use getMonth/getDate, so build dates from local components.
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 12, 0, 0);

describe("date stamps", () => {
  test("localDateStamp zero-pads month and day", () => {
    expect(localDateStamp(d(2026, 3, 5))).toBe("2026-03-05");
    expect(localDateStamp(d(2026, 12, 31))).toBe("2026-12-31");
  });
  test("monthStamp is YYYY-MM", () => {
    expect(monthStamp(d(2026, 7, 18))).toBe("2026-07");
  });
  test("snapshotFileName and releaseTag", () => {
    expect(snapshotFileName(d(2026, 7, 1))).toBe("omnislash-2026-07-01.dump");
    expect(releaseTag(d(2026, 7, 1))).toBe("db-backup-2026-07");
  });
});

describe("parseBackupTag", () => {
  test("parses a valid tag", () => {
    expect(parseBackupTag("db-backup-2025-11")).toEqual({ year: 2025, month: 11 });
  });
  test("rejects non-matching or out-of-range tags", () => {
    expect(parseBackupTag("db-backup-2025-13")).toBeNull();
    expect(parseBackupTag("db-backup-2025-00")).toBeNull();
    expect(parseBackupTag("db-backup-2025-1")).toBeNull();
    expect(parseBackupTag("v1.2.3")).toBeNull();
    expect(parseBackupTag("db-backup-latest")).toBeNull();
  });
});

describe("prunableTags", () => {
  const now = d(2026, 7, 18); // month index for 2026-07

  test("keeps the most recent 12 months (current included), prunes 12+ months old", () => {
    const tags = [
      "db-backup-2026-07", // age 0 — keep
      "db-backup-2026-01", // age 6 — keep
      "db-backup-2025-08", // age 11 — keep (boundary, retained)
      "db-backup-2025-07", // age 12 — prune (boundary, dropped)
      "db-backup-2025-06", // age 13 — prune
      "db-backup-2024-01", // very old — prune
    ];
    expect(prunableTags(tags, now)).toEqual([
      "db-backup-2025-07",
      "db-backup-2025-06",
      "db-backup-2024-01",
    ]);
  });

  test("ignores tags that aren't db-backup-YYYY-MM", () => {
    expect(prunableTags(["v1.0.0", "db-backup-latest", "nightly-2020-01"], now)).toEqual([]);
  });

  test("never prunes a future-dated tag", () => {
    expect(prunableTags(["db-backup-2027-01"], now)).toEqual([]);
  });

  test("honours a custom keepMonths", () => {
    // keepMonths=3 retains ages 0-2 (2026-07/06/05); 04 (age 3) and 03 (age 4) prune.
    expect(prunableTags(["db-backup-2026-05", "db-backup-2026-04", "db-backup-2026-03"], now, 3)).toEqual([
      "db-backup-2026-04",
      "db-backup-2026-03",
    ]);
  });
});

describe("gh command builders", () => {
  test("createCmd is a prerelease with the snapshot attached", () => {
    expect(createCmd("me/acme", "db-backup-2026-07", "/tmp/s.sqlite", "t", "n")).toEqual([
      "gh", "release", "create", "db-backup-2026-07", "/tmp/s.sqlite",
      "--repo", "me/acme", "--prerelease", "--title", "t", "--notes", "n",
    ]);
  });
  test("uploadCmd clobbers the existing asset", () => {
    expect(uploadCmd("me/acme", "db-backup-2026-07", "/tmp/s.sqlite")).toEqual([
      "gh", "release", "upload", "db-backup-2026-07", "/tmp/s.sqlite", "--repo", "me/acme", "--clobber",
    ]);
  });
  test("deleteCmd removes the release and its tag", () => {
    expect(deleteCmd("me/acme", "db-backup-2025-01")).toEqual([
      "gh", "release", "delete", "db-backup-2025-01", "--repo", "me/acme", "--yes", "--cleanup-tag",
    ]);
  });
});

describe("fmtCmd", () => {
  test("leaves bare args unquoted and quotes args with spaces", () => {
    expect(fmtCmd(["gh", "release", "create", "db-backup-2026-07", "--title", "acme DB backup 2026-07"])).toBe(
      "gh release create db-backup-2026-07 --title 'acme DB backup 2026-07'",
    );
  });
  test("escapes embedded single quotes", () => {
    expect(fmtCmd(["--notes", "it's fine"])).toBe("--notes 'it'\\''s fine'");
  });
});

describe("assertNoKeyMaterialInBackup: the DB and a private key never ride together", () => {
  const snapshot = "/tmp/omnislash-backup-x/omnislash-2026-08-15.sqlite";
  const haTarball = "/tmp/omnislash-backup-x/haconfig-2026-08.tar.gz";
  const masterKey = "/etc/omnislash/master.key";
  const tlsKey = "/etc/omnislash/tls/privkey.pem";

  test("passes the normal backup payload through", () => {
    expect(() =>
      assertNoKeyMaterialInBackup([snapshot, haTarball, "/x/network/.full/AdGuardHome.yaml"], {
        masterKey,
        tlsKeys: [tlsKey],
      }),
    ).not.toThrow();
  });

  test("refuses the configured master key file, however it is spelled", () => {
    expect(() => assertNoKeyMaterialInBackup([snapshot, masterKey], { masterKey })).toThrow(/refusing to back up/);
    expect(() => assertNoKeyMaterialInBackup([snapshot, masterKey], { masterKey })).toThrow(/encryption decorative/);
    // Same file, non-canonical path, so a resolve() comparison, not a string compare.
    expect(() => assertNoKeyMaterialInBackup(["/etc/omnislash/../acme/master.key"], { masterKey })).toThrow(
      /refusing to back up/,
    );
  });

  test("refuses a master.key by name even when no key file is configured", () => {
    // The guard has to hold on the Mac too, where the key lives in the Keychain and the env var is unset.
    expect(() => assertNoKeyMaterialInBackup([snapshot, "/srv/backup-staging/master.key"], { masterKey: null })).toThrow(
      /refusing to back up/,
    );
    expect(() => assertNoKeyMaterialInBackup([snapshot, haTarball], { masterKey: null })).not.toThrow();
  });

  // 220: the dashboard's TLS private key is the second piece of key material on the box, and the one a
  // future "stage the whole of /etc/omnislash" change would sweep up by accident.
  test("refuses the configured TLS private key, however it is spelled", () => {
    expect(() => assertNoKeyMaterialInBackup([snapshot, tlsKey], { masterKey, tlsKeys: [tlsKey] })).toThrow(
      /that is a TLS private key/,
    );
    expect(() => assertNoKeyMaterialInBackup(["/etc/omnislash/tls/../tls/privkey.pem"], { masterKey, tlsKeys: [tlsKey] })).toThrow(
      /refusing to back up/,
    );
  });

  test("refuses a private key by SHAPE, with no TLS path configured at all", () => {
    // A laptop has no tls_key row, and lego's own copy of the same key is <domain>.key, not privkey.pem.
    for (const asset of ["/srv/staging/privkey.pem", "/srv/staging/example.test.key"]) {
      expect(() => assertNoKeyMaterialInBackup([snapshot, asset], { masterKey: null })).toThrow(
        /that is a TLS private key/,
      );
    }
    // The public half is not key material and must still ride along if anything ever stages it.
    expect(() =>
      assertNoKeyMaterialInBackup([snapshot, "/srv/staging/fullchain.pem"], { masterKey: null }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 200: the hourly local snapshot's rotation, as pure logic.
//
// Rotation is the half of this that can take the tracker DOWN: an unrotated snapshot directory fills
// the 8GiB data volume, which is the failure the snapshots exist to prevent. So which copies are kept
// and which are pruned is tested here as arithmetic on a list, not by writing files.
// ---------------------------------------------------------------------------

const MB = 1024 * 1024;

/** A snapshot taken `hoursAgo` before `now`, sized `mb`. */
function snap(now: Date, hoursAgo: number, mb = 60): SnapshotEntry {
  const taken = new Date(now.getTime() - hoursAgo * 3600_000);
  return { name: snapshotName(taken), bytes: mb * MB, taken };
}

function names(entries: SnapshotEntry[]): string[] {
  return entries.map((e) => e.name);
}

describe("snapshot filenames", () => {
  test("round-trip through the stamp", () => {
    const d = new Date(2026, 7, 15, 21, 30, 4);
    expect(snapshotName(d)).toBe("omnislash-snap-20260815-213004.dump");
    expect(parseSnapshotName(snapshotName(d))?.getTime()).toBe(d.getTime());
  });

  test("both the current and the legacy omnibus-snap prefix parse, to the same moment (OS-161)", () => {
    const d = new Date(2026, 10, 24, 4, 30, 35);
    expect(parseSnapshotName("omnislash-snap-20261124-043035.dump")?.getTime()).toBe(d.getTime());
    expect(parseSnapshotName("omnibus-snap-20261124-043035.dump")?.getTime()).toBe(d.getTime());
    expect(parseSnapshot("omnislash-snap-20261124-043035.dump")?.prefix).toBe(SNAPSHOT_PREFIX);
    expect(parseSnapshot("omnibus-snap-20261124-043035.dump")?.prefix).toBe(LEGACY_SNAPSHOT_PREFIX);
  });

  test("anything that is not ours parses as null, so rotation never deletes it", () => {
    // The monthly backup's own filename, a partial write, a hand-taken pre-migration copy, and the
    // database itself. Each of these sitting in the directory must be left exactly alone.
    for (const name of [
      "omnislash-2026-08-15.dump",
      ".omnislash-snap-20260815-213004.dump.partial",
      "omnislash-snap-20260815-213004.dump.bak",
      "before-the-migration.dump",
      "acme.dump",
      "omnislash-snap-20261315-213004.dump",
      "omnislash-snap-20260815-993004.dump",
      // the pre-cutover SQLite artifacts: rotation must leave every one of them alone (337)
      "omnislash-snap-20260815-213004.sqlite",
      "omnislash-2026-08-15.sqlite",
      // other prefixes stay null; the legacy omnibus-snap one is ours since OS-161
      "omni-snap-20260815-213004.dump",
      "xomnislash-snap-20260815-213004.dump",
      "omnibus-2026-08-15.dump",
    ]) {
      expect(parseSnapshotName(name), name).toBeNull();
    }
  });
});

describe("planSnapshotRotation: the age policy", () => {
  const now = new Date(2026, 7, 15, 12, 0, 0);

  test("an empty directory keeps only the snapshot about to be written", () => {
    const pending = { ...snap(now, 0), pending: true };
    const plan = planSnapshotRotation([pending], { freeBytes: 8 * 1024 ** 3 });
    expect(names(plan.keep)).toEqual([pending.name]);
    expect(plan.prune).toEqual([]);
    expect(plan.shortfallBytes).toBe(0);
  });

  test("under the hourly window nothing is pruned", () => {
    const entries = [0, 1, 2, 3].map((h) => snap(now, h));
    const plan = planSnapshotRotation(entries, { keepHourly: 24, keepDaily: 7 });
    expect(plan.keep.length).toBe(4);
    expect(plan.prune).toEqual([]);
  });

  test("beyond the hourly window one survivor per day is kept, newest first", () => {
    // 24 hourly copies plus four more spread over the two preceding days.
    const hourly = Array.from({ length: 24 }, (_, i) => snap(now, i));
    const older = [25, 30, 49, 55].map((h) => snap(now, h));
    const plan = planSnapshotRotation([...hourly, ...older], { keepHourly: 24, keepDaily: 7 });
    // the newest of each older day survives; the second copy of that day does not
    expect(names(plan.keep).slice(0, 24)).toEqual(names(hourly));
    expect(names(plan.keep).slice(24)).toEqual([older[0]!.name, older[2]!.name]);
    expect(names(plan.prune)).toEqual([older[3]!.name, older[1]!.name]);
  });

  test("only keepDaily distinct days survive beyond the window", () => {
    const entries = Array.from({ length: 30 }, (_, i) => snap(now, 24 + i * 24));
    const plan = planSnapshotRotation(entries, { keepHourly: 1, keepDaily: 3 });
    expect(plan.keep.length).toBe(4);
    expect(plan.prune.length).toBe(26);
    // pruning is ordered oldest first, which is the order to delete in
    expect(plan.prune[0]!.taken.getTime()).toBeLessThan(plan.prune.at(-1)!.taken.getTime());
  });

  test("keepHourly below 1 is clamped, so a plan always keeps something", () => {
    const entries = [0, 1, 2].map((h) => snap(now, h));
    const plan = planSnapshotRotation(entries, { keepHourly: 0, keepDaily: 0 });
    expect(plan.keep.length).toBe(1);
    expect(plan.keep[0]!.name).toBe(entries[0]!.name);
  });
});

describe("planSnapshotRotation: the byte budget", () => {
  const now = new Date(2026, 7, 15, 12, 0, 0);

  test("the oldest are dropped until the kept set fits the budget", () => {
    const entries = Array.from({ length: 10 }, (_, i) => snap(now, i, 100));
    const plan = planSnapshotRotation(entries, { keepHourly: 10, keepDaily: 0, maxBytes: 450 * MB });
    expect(plan.keep.length).toBe(4);
    expect(names(plan.keep)).toEqual(names(entries.slice(0, 4)));
    expect(plan.prune.length).toBe(6);
  });

  test("a budget smaller than one snapshot still keeps the newest", () => {
    const entries = Array.from({ length: 3 }, (_, i) => snap(now, i, 100));
    const plan = planSnapshotRotation(entries, { keepHourly: 3, keepDaily: 0, maxBytes: 1 });
    expect(names(plan.keep)).toEqual([entries[0]!.name]);
  });

  test("the pending snapshot is never the one dropped for the budget", () => {
    const pending = { ...snap(now, 0, 100), pending: true };
    const plan = planSnapshotRotation([pending, snap(now, 1, 100)], {
      keepHourly: 5,
      keepDaily: 0,
      maxBytes: 1,
    });
    expect(names(plan.keep)).toEqual([pending.name]);
    expect(plan.prune.every((e) => !e.pending)).toBe(true);
  });
});

describe("planSnapshotRotation: the free-space pass", () => {
  const now = new Date(2026, 7, 15, 12, 0, 0);

  test("pruning frees space, and what it frees counts towards the write", () => {
    // 12 copies of 100MB, 150MB free, 512MB reserve: the copies pruned by the age policy give the
    // room back, and the plan only has to keep dropping until the pending write fits.
    const pending = { ...snap(now, 0, 100), pending: true };
    const older = Array.from({ length: 12 }, (_, i) => snap(now, i + 1, 100));
    const plan = planSnapshotRotation([pending, ...older], {
      keepHourly: 24,
      keepDaily: 0,
      maxBytes: 10 * 1024 ** 3,
      freeBytes: 150 * MB,
      reserveBytes: 512 * MB,
    });
    const freedByPrune = plan.prune.reduce((sum, e) => sum + e.bytes, 0);
    expect(150 * MB + freedByPrune - 100 * MB).toBeGreaterThanOrEqual(512 * MB);
    expect(plan.shortfallBytes).toBe(0);
    expect(plan.keep[0]!.name).toBe(pending.name);
  });

  test("a volume with nothing left to reclaim reports a shortfall instead of writing", () => {
    const pending = { ...snap(now, 0, 100), pending: true };
    const plan = planSnapshotRotation([pending], {
      keepHourly: 24,
      keepDaily: 7,
      freeBytes: 10 * MB,
      reserveBytes: 512 * MB,
    });
    // Nothing to prune, so the caller must refuse: 512MB reserve + 100MB write against 10MB free.
    expect(plan.prune).toEqual([]);
    expect(plan.shortfallBytes).toBe(602 * MB);
  });

  test("no freeBytes means no free-space pass at all", () => {
    const plan = planSnapshotRotation([snap(now, 0, 100)], { keepHourly: 24 });
    expect(plan.shortfallBytes).toBe(0);
  });
});

describe("fmtBytes", () => {
  test("scales to the unit a human reads", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2 * 1024 ** 2)).toBe("2.0 MiB");
    expect(fmtBytes(2 * 1024 ** 3)).toBe("2.0 GiB");
  });
});

describe("ensureGh (550)", () => {
  const whichGh = () => "/usr/bin/gh";
  const whichNone = () => null;
  const authOk = () => ({ ok: true, code: 0, stdout: "", stderr: "" });
  const authFail = () => ({
    ok: false,
    code: 1,
    stdout: "",
    stderr: "You are not logged into any GitHub hosts. To log in, run: gh auth login",
  });

  test("GH_TOKEN counts as authenticated and does not run gh auth status", async () => {
    let ran: string[] | null = null;
    const env = await ensureGh({
      env: { GH_TOKEN: "gho_test" },
      which: whichGh,
      run: (cmd) => {
        ran = cmd;
        return authFail();
      },
    });
    expect(ran).toBeNull();
    expect(env).toBeUndefined();
  });

  test("GITHUB_TOKEN counts as authenticated and does not run gh auth status", async () => {
    let ran: string[] | null = null;
    await ensureGh({
      env: { GITHUB_TOKEN: "gho_test" },
      which: whichGh,
      run: (cmd) => {
        ran = cmd;
        return authFail();
      },
    });
    expect(ran).toBeNull();
  });

  test("whitespace-only tokens do not count", async () => {
    await expect(ensureGh({ env: { GH_TOKEN: "  " }, which: whichGh, run: authFail })).rejects.toThrow(AppError);
  });

  test("missing gh does not tell the operator to gh auth login", async () => {
    await expect(ensureGh({ env: { GH_TOKEN: "gho_test" }, which: whichNone, run: authOk })).rejects.toThrow(
      "gh CLI not found on PATH — install the GitHub CLI",
    );
  });

  test("no token falls through to gh auth status", async () => {
    expect(await ensureGh({ env: {}, which: whichGh, run: authOk })).toBeUndefined();
    await expect(ensureGh({ env: {}, which: whichGh, run: authFail })).rejects.toThrow(/gh is not authenticated/);
  });
});

describe("ensureGh falls back to the stored github token (1575)", () => {
  const whichGh = () => "/usr/bin/gh";
  const authOk = () => ({ ok: true, code: 0, stdout: "", stderr: "" });
  const authFail = () => ({ ok: false, code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." });

  test("unauthenticated gh gets the stored token as GH_TOKEN in the returned env only", async () => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    const out = await ensureGh({ env, which: whichGh, run: authFail, secret: async () => "gho_stored\n" });
    expect(out).toEqual({ PATH: "/usr/bin", GH_TOKEN: "gho_stored" });
    expect(env.GH_TOKEN).toBeUndefined();
  });

  test("a logged-in gh never reads the secret store", async () => {
    let read = false;
    const out = await ensureGh({
      env: {},
      which: whichGh,
      run: authOk,
      secret: async () => {
        read = true;
        return "gho_stored";
      },
    });
    expect(out).toBeUndefined();
    expect(read).toBe(false);
  });

  test("no stored token still fails, and points at ob secret set github", async () => {
    await expect(ensureGh({ env: {}, which: whichGh, run: authFail, secret: async () => null })).rejects.toThrow(
      /ob secret set github/,
    );
  });
});

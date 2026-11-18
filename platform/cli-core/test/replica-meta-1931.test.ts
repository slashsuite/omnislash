import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDb } from "../../../apps/cli/src/db.ts";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";
import type { RemoteExec } from "../../../apps/cli/src/remote.ts";
import type { Ctx } from "../../../apps/cli/src/ctx.ts";
import { cmdReplica } from "../../../apps/cli/src/commands/replica.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import {
  dumpReplicaBytes,
  markReplicaDirty,
  openReplicaForRead,
  readMeta,
  refreshReplica,
  replicaToken,
  SKEW_BACKOFF_MS,
  stalenessNotice,
  writeMeta,
} from "../../../apps/cli/src/replica.ts";

// OB-1931: the replica meta. No ssh, no network: every remote call goes through a fake RemoteExec backed
// by a real local DB, the same shape as remote-client.test.ts (copied, not imported from a test file).

type Fake = RemoteExec & { calls: string[][]; fetches: number; onCapture?: () => void; onFetch?: () => void };

function fakeServer(serverDbPath: string): Fake {
  const serverDb = openDb(serverDbPath);
  const fake: Fake = {
    calls: [],
    fetches: 0,
    stream(_host: string, argv: string[]) {
      fake.calls.push(argv);
      return { code: 0, connectionFailed: false };
    },
    capture(_host: string, argv: string[]) {
      fake.calls.push(argv);
      const out =
        argv[0] === "replica" && argv[1] === "token"
          ? { code: 0, connectionFailed: false, stdout: `${replicaToken(serverDbPath)}\n`, stderr: "" }
          : { code: 0, connectionFailed: false, stdout: "", stderr: "" };
      fake.onCapture?.();
      return out;
    },
    fetch(_host: string, argv: string[]) {
      fake.calls.push(argv);
      fake.fetches++;
      const out = { code: 0, connectionFailed: false, stderr: "", bytes: dumpReplicaBytes(serverDb) };
      fake.onFetch?.();
      return out;
    },
  };
  return fake;
}

function clientDir(): string {
  return mkdtempSync(join(tmpdir(), "ob-client-1931-"));
}

async function seeded() {
  const serverPath = freshDbPath();
  const server = openDb(serverPath);
  await createItem(server, { title: "on the server", type: "task" });
  server.close();
  const dbPath = join(clientDir(), "omnislash.sqlite");
  const exec = fakeServer(serverPath);
  const first = refreshReplica({ dbPath, host: "ob@server", exec });
  expect(first.refreshed).toBe(true);
  return { serverPath, dbPath, exec };
}

/** A server whose dump does not match this client's schema: an extra table moves its 097 fingerprint. */
function skewedServer() {
  const serverPath = freshDbPath();
  const server = openDb(serverPath);
  server.exec("CREATE TABLE skew_probe (id TEXT)");
  server.close();
  const dbPath = join(clientDir(), "omnislash.sqlite");
  return { dbPath, exec: fakeServer(serverPath) };
}

describe("replica meta: refreshed_at on a confirmed-unchanged token (OB-1931)", () => {
  test("a skipped refresh restarts the replica's age", async () => {
    const { dbPath, exec } = await seeded();
    const later = Date.now() + 10 * 60_000;
    // ten minutes on, the replica reads as stale ...
    expect(stalenessNotice({ meta: readMeta(dbPath), unreachable: false, now: later }).stale).toBe(true);
    const out = refreshReplica({ dbPath, host: "ob@server", exec, now: () => later });
    expect(out.skipped).toBe(true);
    const meta = readMeta(dbPath);
    expect(Math.abs(Date.parse(meta.refreshed_at!) - later)).toBeLessThan(1000);
    // ... and once the server has confirmed it current, it does not
    expect(stalenessNotice({ meta, unreachable: false, now: later }).stale).toBe(false);
  });
});

describe("replica meta: atomic write (OB-1931)", () => {
  test("writeMeta leaves only the meta file, and it parses", () => {
    const dbPath = join(clientDir(), "omnislash.sqlite");
    const meta = { ...readMeta(dbPath), token: "t", dirty: true, dirty_seq: 3 };
    writeMeta(dbPath, meta);
    writeMeta(dbPath, { ...meta, dirty_seq: 4 });
    const files = readdirSync(join(dbPath, ".."));
    expect(files).toEqual(["replica.meta.json"]);
    expect(readMeta(dbPath)).toMatchObject({ token: "t", dirty: true, dirty_seq: 4 });
  });

  test("an old meta file without the new fields reads them as their defaults", () => {
    const dbPath = join(clientDir(), "omnislash.sqlite");
    const old = { token: "t", refreshed_at: null, dirty: true, last_refresh_ok: true, last_error: null, fingerprint: null };
    writeMeta(dbPath, old as unknown as ReturnType<typeof readMeta>);
    expect(readMeta(dbPath)).toMatchObject({ dirty_seq: 0, skew_at: null, skew_expected: null, last_deferred_at: null });
  });
});

describe("replica meta: a dirty mark landing mid-refresh survives (OB-1931)", () => {
  test("skipped path: a mark during the token call stays dirty", async () => {
    const { dbPath, exec } = await seeded();
    const before = readMeta(dbPath).dirty_seq;
    exec.onCapture = () => markReplicaDirty(dbPath);
    const out = refreshReplica({ dbPath, host: "ob@server", exec });
    expect(out.skipped).toBe(true);
    const meta = readMeta(dbPath);
    expect(meta.dirty).toBe(true);
    expect(meta.dirty_seq).toBe(before + 1);
  });

  test("swap path: a mark during the fetch stays dirty", async () => {
    const { dbPath, serverPath, exec } = await seeded();
    const later = openDb(serverPath);
    await createItem(later, { title: "second", type: "task" });
    later.close();
    const before = readMeta(dbPath).dirty_seq;
    exec.onFetch = () => markReplicaDirty(dbPath);
    const out = refreshReplica({ dbPath, host: "ob@server", exec });
    expect(out.refreshed).toBe(true);
    const meta = readMeta(dbPath);
    expect(meta.dirty).toBe(true);
    expect(meta.dirty_seq).toBe(before + 1);
  });

  test("with no interleaved mark, both paths clear dirty", async () => {
    const { dbPath, serverPath, exec } = await seeded();
    markReplicaDirty(dbPath);
    expect(refreshReplica({ dbPath, host: "ob@server", exec }).skipped).toBe(true);
    expect(readMeta(dbPath).dirty).toBe(false);

    const later = openDb(serverPath);
    await createItem(later, { title: "second", type: "task" });
    later.close();
    markReplicaDirty(dbPath);
    expect(refreshReplica({ dbPath, host: "ob@server", exec }).refreshed).toBe(true);
    expect(readMeta(dbPath).dirty).toBe(false);
  });
});

describe("replica meta: schema skew backs off (OB-1931)", () => {
  test("a second refresh inside the window does not fetch; +11 minutes does", () => {
    const { dbPath, exec } = skewedServer();
    const t0 = Date.now();
    const first = refreshReplica({ dbPath, host: "ob@server", exec, now: () => t0 });
    expect(first.error).toContain("schema skew");
    expect(exec.fetches).toBe(1);
    expect(readMeta(dbPath).skew_at).not.toBeNull();

    const second = refreshReplica({ dbPath, host: "ob@server", exec, now: () => t0 + 60_000 });
    expect(exec.fetches).toBe(1);
    expect(second.error).toContain("schema skew: backing off until");
    expect(second.error).toContain("--force");
    expect(second.reachable).toBe(true);
    // the token call still ran
    expect(exec.calls.filter((c) => c[1] === "token").length).toBe(2);

    refreshReplica({ dbPath, host: "ob@server", exec, now: () => t0 + SKEW_BACKOFF_MS + 60_000 });
    expect(exec.fetches).toBe(2);
  });

  test("--force fetches at once", () => {
    const { dbPath, exec } = skewedServer();
    const t0 = Date.now();
    refreshReplica({ dbPath, host: "ob@server", exec, now: () => t0 });
    refreshReplica({ dbPath, host: "ob@server", exec, force: true, now: () => t0 + 1000 });
    expect(exec.fetches).toBe(2);
  });

  test("a changed expected fingerprint (the checkout updated) fetches at once", () => {
    const { dbPath, exec } = skewedServer();
    const t0 = Date.now();
    refreshReplica({ dbPath, host: "ob@server", exec, now: () => t0 });
    writeMeta(dbPath, { ...readMeta(dbPath), skew_expected: "an-older-checkout" });
    refreshReplica({ dbPath, host: "ob@server", exec, now: () => t0 + 1000 });
    expect(exec.fetches).toBe(2);
  });

  test("a successful swap clears the skew record", async () => {
    const { dbPath, serverPath, exec } = await seeded();
    writeMeta(dbPath, { ...readMeta(dbPath), skew_at: new Date().toISOString(), skew_expected: "x", token: null });
    const later = openDb(serverPath);
    await createItem(later, { title: "second", type: "task" });
    later.close();
    expect(refreshReplica({ dbPath, host: "ob@server", exec }).refreshed).toBe(true);
    expect(readMeta(dbPath)).toMatchObject({ skew_at: null, skew_expected: null });
  });
});

async function status(dbPath: string, mode: "json" | "text"): Promise<string> {
  const ctx = { dbPath, args: ["status"], mode, flags: {} } as unknown as Ctx;
  let printed = "";
  const origLog = console.log;
  const prev = process.env.OB_REMOTE;
  process.env.OB_REMOTE = "0";
  console.log = (...a: unknown[]) => {
    printed += a.join(" ") + "\n";
  };
  try {
    await cmdReplica(ctx);
  } finally {
    console.log = origLog;
    if (prev === undefined) delete process.env.OB_REMOTE;
    else process.env.OB_REMOTE = prev;
  }
  return printed;
}

describe("replica status: the skew backoff (OB-1931)", () => {
  test("an active backoff shows in the last refresh line and the JSON; one for an older checkout does not", async () => {
    const { dbPath, exec } = skewedServer();
    refreshReplica({ dbPath, host: "ob@server", exec });
    expect(await status(dbPath, "text")).toContain("last refresh: failed: schema skew, backing off until ");
    const json = JSON.parse(await status(dbPath, "json")) as Record<string, unknown>;
    expect(json.skew_at).not.toBeNull();
    expect(json.skew_backoff_until).not.toBeNull();
    expect(await status(dbPath, "text")).toContain("deferred:    -");

    writeMeta(dbPath, { ...readMeta(dbPath), skew_expected: "an-older-checkout" });
    expect((JSON.parse(await status(dbPath, "json")) as Record<string, unknown>).skew_backoff_until).toBeNull();
  });
});

describe("replica meta: a deferral is recorded (OB-1931)", () => {
  test("a deferred swap sets last_deferred_at, leaves dirty, and status shows it", async () => {
    const { dbPath, serverPath, exec } = await seeded();
    const reader = openReplicaForRead(dbPath);
    const later = openDb(serverPath);
    await createItem(later, { title: "second", type: "task" });
    later.close();
    expect(readMeta(dbPath).dirty).toBe(false);
    let out;
    try {
      out = refreshReplica({ dbPath, host: "ob@server", exec, lock: { waitMs: 200 } });
    } finally {
      reader.close();
    }
    expect(out.deferred).toBe(true);
    const meta = readMeta(dbPath);
    expect(meta.last_deferred_at).not.toBeNull();
    expect(meta.dirty).toBe(false);

    const shown = JSON.parse(await status(dbPath, "json")) as Record<string, unknown>;
    expect(shown.last_deferred_at).toBe(meta.last_deferred_at);
    expect(shown.skew_at).toBeNull();
    expect(shown.skew_backoff_until).toBeNull();

    // a swap that lands clears it
    expect(refreshReplica({ dbPath, host: "ob@server", exec, lock: { waitMs: 2_000 } }).refreshed).toBe(true);
    expect(readMeta(dbPath).last_deferred_at).toBeNull();
  });
});

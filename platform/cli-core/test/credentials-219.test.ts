import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { freshDb, freshDbPath, runCli, spawnBudget } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { freshPgStore } from "../../../apps/cli/test/pg/store.ts";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import {
  CREDENTIALS,
  credentialInventory,
  googleInvalidGrantRecorder,
  lastCredentialCheck,
  originFromRequest,
  recordCredentialCheck,
  redactDetail,
  runCredentialCheck,
  storeCredential,
  writeGate,
  type Probes,
} from "../../../apps/cli/src/credentials.ts";
import { computeAlerts, filterSnoozed, snoozeAlert } from "../../../apps/cli/src/commands/alerts.ts";
import { getSecret, inMemoryMasterKey, setSecret } from "../../../apps/cli/src/secrets.ts";
import type { BridgeDeps } from "../../../platform/cli-whatsapp/src/whatsapp/bridge.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";
import { gmailDraftClientFor, listGmailDrafts } from "../../../platform/cli-sources/src/gmail-draft.ts";
import type { GoogleFetch } from "../../../platform/cli-sources/src/google.ts";

// ob 219. The tokens page exists because four credentials failed silently in two days and THREE of them
// were credentials the encrypted store does not hold. So the inventory covers what ob depends on rather
// than what `ob secret list` prints, and the line these tests hold above everything else is that a VALUE
// never leaves the server: every payload assertion below is made on the SERIALIZED payload, because a
// typed field is only as safe as the object behind it.

const KEY = inMemoryMasterKey();

/** A token-shaped string that is unmistakable if it ever turns up in a payload. */
const FAKE_GITHUB = "ghp_THIS_MUST_NEVER_BE_RENDERED_0123456789";

/** Probes that answer for a machine with nothing outside the store, unless a test says otherwise. */
function probes(over: Partial<Probes> = {}): Probes {
  return {
    fileState: () => ({ exists: false, bytes: 0, mode: null }),
    keychainItem: () => false,
    onPath: () => false,
    env: () => undefined,
    ...over,
  };
}

const PG_BUDGET = spawnBudget(2);

async function seedGithub(store: Store): Promise<void> {
  await setSecret(store, "github", FAKE_GITHUB, KEY.get());
}

/** An http seam that answers every request the same way and records what it was asked. */
function fakeHttp(response: { status: number; body: unknown }, seen: Request[] = []) {
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new Request(typeof input === "string" ? input : String(input), init));
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { http, seen };
}

describe("the inventory covers what ob depends on, not what the store holds (219)", () => {
  test("every out-of-store credential that bit recently is on the list", async () => {
    const names = CREDENTIALS.map((c) => c.name);
    expect(names).toContain("master-key"); // ob 182
    expect(names).toContain("whatsapp"); // ob 274
    for (const stored of ["google", "github", "ha", "cloudflare-api-token", "cloudflare-account-id"]) {
      expect(names).toContain(stored);
    }
    // A permanently absent entry nobody should ever fill in teaches the reader to ignore this page:
    // 208 retired the Slack job; 425 dropped router-password and claude
    // (API host has no CLI; laptop login is not this inventory). 619 dropped Linear ingest.
    expect(names).not.toContain("slack");
    expect(names).not.toContain("router-password");
    expect(names).not.toContain("claude");
    expect(names).not.toContain("linear");
  }, PG_BUDGET);

  test("presence and age render from the store, and a missing one says so", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await seedGithub(db);
    const rows = await credentialInventory(db, probes());
    const github = rows.find((r) => r.name === "github")!;
    expect(github.present).toBe(true);
    expect(github.presence_detail).toBe("in the encrypted store");
    expect(typeof github.updated_at).toBe("string");
    const ha = rows.find((r) => r.name === "ha")!;
    expect({ present: ha.present, updated_at: ha.updated_at }).toEqual({ present: false, updated_at: null });
  }, PG_BUDGET);

  test("github found only in the `gh` CLI is present, and the row says it is not in the store (ob 185)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const row = (await credentialInventory(db, probes({ onPath: (c) => c === "gh" }))).find((r) => r.name === "github")!;
    expect(row.present).toBe(true);
    expect(row.updated_at).toBeNull();
    expect(row.presence_detail).toContain("not in the store");
  }, PG_BUDGET);

  test("the master key is read as a Keychain item here and as a 0600 file on the server (ob 182)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const onMac = (await credentialInventory(db, probes({ keychainItem: () => true }))).find((r) => r.name === "master-key")!;
    expect(onMac.present).toBe(true);
    expect(onMac.presence_detail).toContain("Keychain");

    const onServer = (await credentialInventory(
      db,
      probes({
        env: (n) => (n === "OMNISLASH_MASTER_KEY_FILE" ? "/srv/ob/master.key" : undefined),
        fileState: () => ({ exists: true, bytes: 44, mode: 0o600 }),
      }),
    )).find((r) => r.name === "master-key")!;
    expect(onServer.present).toBe(true);
    expect(onServer.presence_detail).toContain("/srv/ob/master.key");
  }, PG_BUDGET);

  test("a master key file anyone can read is flagged rather than waved through", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const row = (await credentialInventory(
      db,
      probes({
        env: (n) => (n === "OMNISLASH_MASTER_KEY_FILE" ? "/srv/ob/master.key" : undefined),
        fileState: () => ({ exists: true, bytes: 44, mode: 0o644 }),
      }),
    )).find((r) => r.name === "master-key")!;
    expect(row.presence_detail).toContain("chmod 600");
  }, PG_BUDGET);

  test("refresh is not one action: the page is told which kind each credential is", async () => {
    const byName = new Map(CREDENTIALS.map((c) => [c.name, c]));
    expect(byName.get("github")!.refresh).toBe("paste");
    expect(byName.get("google")!.refresh).toBe("oauth");
    expect(byName.get("whatsapp")!.refresh).toBe("qr");
    expect(byName.get("master-key")!.refresh).toBe("keychain");
    // Only a paste-refreshable store credential offers the write path.
    const lease = await freshPgStore();
    const db = lease.store;
    const rows = await credentialInventory(db, probes());
    expect(rows.filter((r) => r.writable).map((r) => r.name).sort()).toEqual([
      "cloudflare-account-id",
      "cloudflare-api-token",
      "github",
      "ha",
      "opencode-go",
      "opencode-zen",
    ]);
  });
});

describe("no credential value ever reaches a payload (219)", () => {
  test("the serialized inventory contains no stored value", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await seedGithub(db);
    const payload = JSON.stringify(await credentialInventory(db, probes()));
    expect(payload).not.toContain(FAKE_GITHUB);
    expect(payload).toContain("github");
  }, PG_BUDGET);

  test("the serialized check verdict contains no value, even when the provider echoes it back", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await seedGithub(db);
    const { http } = fakeHttp({ status: 401, body: { message: `bad token ${FAKE_GITHUB}` } });
    const row = await runCredentialCheck(db, "github", { http, masterKey: KEY, probes: probes() });
    const payload = JSON.stringify(row);
    expect(payload).not.toContain(FAKE_GITHUB);
    expect(row.ok).toBe(false);
  }, PG_BUDGET);

  test("redactDetail replaces a value wherever it appears, and leaves short strings alone", async () => {
    expect(redactDetail(`a ${FAKE_GITHUB} b ${FAKE_GITHUB}`, [FAKE_GITHUB])).toBe("a [redacted] b [redacted]");
    expect(redactDetail("HTTP 401", ["401"])).toBe("HTTP 401");
  }, PG_BUDGET);

  test("`ob creds --json` prints no value", async () => {
    const path = freshDbPath();
    openDb(path, { create: true }).close();
    const db = (await import("bun:sqlite")).Database;
    const handle = new db(path);
    await setSecret(sqliteStoreFor(handle), "github", FAKE_GITHUB, KEY.get());
    handle.close();
    const res = await runCli(path, ["creds", "--json"]);
    expect(res.code).toBe(0);
    expect(res.out).not.toContain(FAKE_GITHUB);
    expect(res.out).toContain("whatsapp");
    expect(res.out).not.toContain("router-password");
    expect(res.out).not.toContain("\"claude\"");
    expect(res.out).not.toContain("\"linear\"");
  });
});

describe("live checks are behind a seam and never run on their own (219)", () => {
  test("a passing check records ok with a reason", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await seedGithub(db);
    const seen: Request[] = [];
    const { http } = fakeHttp({ status: 200, body: { login: "alex-example" } }, seen);
    const row = await runCredentialCheck(db, "github", { http, masterKey: KEY, probes: probes() });
    expect(row.ok).toBe(true);
    expect(row.detail).toContain("alex-example");
    expect(seen).toHaveLength(1);
  }, PG_BUDGET);

  test("a stored-but-rejected credential reads as FAILED, not as missing", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await seedGithub(db);
    const { http } = fakeHttp({ status: 401, body: { message: "Bad credentials" } });
    await runCredentialCheck(db, "github", { http, masterKey: KEY, probes: probes() });
    const stored = (await lastCredentialCheck(db, "github"))!;
    expect(stored.ok).toBe(false);
    expect(stored.detail).toContain("401");
    expect(((await credentialInventory(db, probes()))).find((r) => r.name === "github")!.present).toBe(true);
  }, PG_BUDGET);

  test("never checked is distinct from checked and bad", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await seedGithub(db);
    expect(((await credentialInventory(db, probes()))).find((r) => r.name === "github")!.last_check).toBeNull();
    const { http } = fakeHttp({ status: 401, body: { message: "Bad credentials" } });
    await runCredentialCheck(db, "github", { http, masterKey: KEY, probes: probes() });
    const after = ((await credentialInventory(db, probes()))).find((r) => r.name === "github")!;
    expect(after.last_check).not.toBeNull();
    expect(after.last_check!.ok).toBe(false);
  }, PG_BUDGET);

  test("a check that throws is recorded as a failed check rather than swallowed", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await seedGithub(db);
    const http = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const row = await runCredentialCheck(db, "github", { http, masterKey: KEY, probes: probes() });
    expect(row.ok).toBe(false);
    expect(row.detail).toContain("ECONNREFUSED");
  }, PG_BUDGET);

  test("the master key check is whether it still opens the store", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await seedGithub(db);
    const good = await runCredentialCheck(db, "master-key", { masterKey: KEY, probes: probes({ keychainItem: () => true }) });
    expect(good.ok).toBe(true);
    const wrong = await runCredentialCheck(db, "master-key", {
      masterKey: inMemoryMasterKey(Buffer.alloc(32, 9)),
      probes: probes({ keychainItem: () => true }),
    });
    expect(wrong.ok).toBe(false);
    expect(wrong.detail).toContain("wrong key");
  });
});

describe("the write path (219)", () => {
  const tls = { proto: "https:", hostname: "example.test" };
  const lan = { proto: "http:", hostname: "10.0.0.220" };

  test("writeGate lets TLS and loopback through and refuses plain HTTP over the network", async () => {
    expect(writeGate(tls)).toMatchObject({ allowed: true, via: "tls" });
    expect(writeGate({ proto: "http:", hostname: "localhost" })).toMatchObject({ allowed: true, via: "loopback" });
    expect(writeGate({ proto: "http:", hostname: "127.0.0.1" })).toMatchObject({ allowed: true, via: "loopback" });
    const refused = writeGate(lan);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("in the clear");
  }, PG_BUDGET);

  test("the origin comes from the connection's own URL, not from a forwarded header", async () => {
    expect(originFromRequest({ url: "http://10.0.0.220:3000/_serverFn/setCredential" })).toEqual({
      proto: "http:",
      hostname: "10.0.0.220",
    });
    expect(originFromRequest({ url: "https://example.test/x" })).toEqual({
      proto: "https:",
      hostname: "example.test",
    });
  }, PG_BUDGET);

  test("a paste over TLS is stored, and the return payload carries no value", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const result = await storeCredential(db, "github", `  ${FAKE_GITHUB}  `, { origin: tls, masterKey: KEY });
    expect(JSON.stringify(result)).not.toContain(FAKE_GITHUB);
    expect(await getSecret(db, "github", KEY.get())).toBe(FAKE_GITHUB);
    expect(result.updated_at).toBeTruthy();
  }, PG_BUDGET);

  test("a paste over plain HTTP on the LAN is refused, and nothing is written", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await expect(storeCredential(db, "github", FAKE_GITHUB, { origin: lan, masterKey: KEY })).rejects.toThrow(/in the clear/);
    expect(await getSecret(db, "github", KEY.get())).toBeNull();
  }, PG_BUDGET);

  test("an empty value is refused rather than storing an empty secret", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await expect(storeCredential(db, "github", "   ", { origin: tls, masterKey: KEY })).rejects.toThrow(/no value/);
    expect(await getSecret(db, "github", KEY.get())).toBeNull();
  }, PG_BUDGET);

  test("a credential a paste cannot refresh is refused with the command that can", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await expect(storeCredential(db, "google", "x".repeat(40), { origin: tls, masterKey: KEY })).rejects.toThrow(/ob google auth/);
    await expect(storeCredential(db, "whatsapp", "x".repeat(40), { origin: tls, masterKey: KEY })).rejects.toThrow(/ob whatsapp bridge start/);
    await expect(storeCredential(db, "claude", "x".repeat(40), { origin: tls, masterKey: KEY })).rejects.toThrow(/unknown credential/);
    await expect(storeCredential(db, "router-password", "x".repeat(40), { origin: tls, masterKey: KEY })).rejects.toThrow(/unknown credential/);
  });
});

// 1347. `ob creds check whatsapp` is the readout the Hermes doctor keys off, and for 13 days it answered
// UNKNOWN over a log that named the cause on its newest lines. These tests are the acceptance criterion:
// a refused client reports the CAUSE and the rebuild, a dead device reports the re-link, a fresh
// connected bridge reports ok, and a stale login line is never read as current state. Hermetic: the
// bridge's files, process and socket are all the injected `bridgeDeps` seam.
describe("`creds check whatsapp` names the CAUSE, not just the silence (ob 1347)", () => {
  const DAY = 24 * 3600_000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  /** The refusal that took the bridge out for 13 days, quoted from its log. */
  const CLIENT_OUTDATED_LOG = [
    "22:19:17.835 [Client INFO] Successfully authenticated",
    "✓ Connected to WhatsApp!",
    '<failure location="lla" reason="405"/>',
    "[Client ERROR] Client outdated (405) connect failure (client version: 2.3000.1040847988)",
    "[Client ERROR] ❌ Client outdated - please update whatsmeow library",
  ].join("\n");

  const RECONNECTING_LOG = [
    "[Client INFO]  Connected to WhatsApp",
    "[Client ERROR] Reconnection failed: invalid use of deleted device",
    "[Client INFO]  Attempting to reconnect...",
  ].join("\n");

  const health = (status: number, body: unknown): typeof fetch =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

  /** Run the whatsapp check with only the seams the bridge would have touched. */
  async function checkWhatsapp(over: Partial<BridgeDeps> = {}) {
    const store = sqliteStoreFor(freshDb());
    return runCredentialCheck(store, "whatsapp", {
      masterKey: KEY,
      // The bridge runs on another host, so the pidfile/log/store are never this machine's files.
      bridgeDeps: {
        readPidfile: () => 783255,
        isAlive: (p) => p === 783255,
        readLogTail: () => "",
        logMtime: () => null,
        processStartedAt: () => null,
        lastMessageAt: () => null,
        pairedDeviceCount: () => 1,
        fetch: health(200, { connected: true, status: "ok" }),
        ...over,
      },
    });
  }

  test("a 405 in the log reports the outdated CLIENT and the rebuild - never UNKNOWN, never a re-link", async () => {
    const row = await checkWhatsapp({
      readLogTail: () => CLIENT_OUTDATED_LOG,
      logMtime: () => ago(13 * DAY),
      processStartedAt: () => ago(14 * DAY),
      fetch: health(503, { connected: false, status: "disconnected" }),
    });
    expect(row.ok).toBe(false);
    expect(row.detail).toMatch(/Client outdated/);
    expect(row.detail).toMatch(/whatsmeow/);
    expect(row.detail).toMatch(/bridge build script/);
    expect(row.detail).not.toMatch(/UNKNOWN/);
    // The re-link remedy - the one that would throw a working pairing away - must not be what is offered.
    expect(row.detail).not.toMatch(/scan the QR/);
    expect(row.detail).not.toMatch(/move .* aside/);
  });

  test("a deleted device reports the re-link, and says nothing about rebuilding", async () => {
    const row = await checkWhatsapp({
      readLogTail: () => RECONNECTING_LOG,
      logMtime: () => ago(5_000),
      processStartedAt: () => ago(60 * 60_000),
      fetch: health(503, { connected: false, status: "disconnected" }),
    });
    expect(row.ok).toBe(false);
    expect(row.detail).toMatch(/scan the QR/);
    expect(row.detail).not.toMatch(/bridge build script/);
    expect(row.detail).not.toMatch(/Client outdated/);
  });

  test("a fresh connected bridge with no auth error is ok", async () => {
    const row = await checkWhatsapp({
      readLogTail: () => "12:53:14.264 [Client/Send DEBUG] <iq id=\"23.45-31\" type=\"get\"/>",
      logMtime: () => ago(2_000),
      processStartedAt: () => ago(60 * 60_000),
    });
    expect(row.ok).toBe(true);
    expect(row.detail).toMatch(/healthy on :8080/);
    expect(row.detail).not.toMatch(/outdated/);
  });

  test("a stale logged-in line is not read as current state: the check does not call a silent bridge healthy", async () => {
    const row = await checkWhatsapp({
      readLogTail: () => "[Client INFO] Successfully logged in as 27...",
      logMtime: () => ago(13 * DAY),
      processStartedAt: () => ago(DAY),
      fetch: health(503, { connected: false, status: "disconnected" }),
    });
    expect(row.ok).toBe(false);
    expect(row.detail).not.toMatch(/reports logged in/);
    expect(row.detail).not.toMatch(/healthy/);
  });
});

describe("a failed check surfaces on the alert list (219, rule 11)", () => {
  const NOW = "2026-08-16T12:00:00.000Z";
  // computeAlerts is still a SQLite reader (commands/alerts.ts is not ported), and rule 11 is what these
  // tests are about, so they write their credential_check rows through a SQLite-backed store rather than
  // splitting the row and the read across two engines. The credentials module takes any Store.
  const credAlerts = async (db: Database) =>
    (await computeAlerts(sqliteStoreFor(db), { focusProject: null, now: NOW })).filter(
      (a) => a.rule === 11,
    );

  test("a credential that failed its last check is one alert naming the fix", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    await recordCredentialCheck(store, "github", { ok: false, detail: "GitHub answered HTTP 401" }, "2026-08-16T11:00:00.000Z");
    const alerts = await credAlerts(db);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.entity).toBe("github");
    expect(alerts[0]!.message).toContain("HTTP 401");
    expect(alerts[0]!.message).toContain("ob secret set github");
  }, PG_BUDGET);

  test("a passing check is silent, and an absent credential never alerts at all", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    await recordCredentialCheck(store, "github", { ok: true, detail: "authenticated to GitHub as alex-example" }, NOW);
    expect((await credAlerts(db))).toEqual([]);
    // ha is not stored and has never been checked: the page shows that, the alert list does not.
    expect((await credAlerts(db)).find((a) => a.entity === "ha")).toBeUndefined();
  }, PG_BUDGET);

  test("a snooze survives re-checking the same failure and returns when the failure changes", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    await recordCredentialCheck(store, "github", { ok: false, detail: "GitHub answered HTTP 401" }, "2026-08-16T11:00:00.000Z");
    await snoozeAlert(sqliteStoreFor(db), "credential_invalid:github", null);
    expect((await filterSnoozed(sqliteStoreFor(db), (await credAlerts(db))))).toEqual([]);

    await recordCredentialCheck(store, "github", { ok: false, detail: "GitHub answered HTTP 401" }, "2026-08-16T11:30:00.000Z");
    expect((await filterSnoozed(sqliteStoreFor(db), (await credAlerts(db))))).toEqual([]); // same failure, still snoozed

    await recordCredentialCheck(store, "github", { ok: false, detail: "GitHub answered HTTP 500" }, "2026-08-16T11:45:00.000Z");
    expect((await filterSnoozed(sqliteStoreFor(db), (await credAlerts(db))))).toHaveLength(1); // failing differently is worth saying
  }, PG_BUDGET);

  test("fixing the credential clears the alert", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    await recordCredentialCheck(store, "github", { ok: false, detail: "GitHub answered HTTP 401" }, "2026-08-16T11:00:00.000Z");
    expect((await credAlerts(db))).toHaveLength(1);
    await recordCredentialCheck(store, "github", { ok: true, detail: "authenticated to GitHub as alex-example" }, "2026-08-16T11:50:00.000Z");
    expect((await credAlerts(db))).toEqual([]);
  });
});

describe("a refused Google refresh token is a failing credential (OB-1950)", () => {
  const NOW = "2026-11-11T12:00:00.000Z";
  const googleAlerts = async (db: Database) =>
    (await computeAlerts(sqliteStoreFor(db), { focusProject: null, now: NOW })).filter(
      (a) => a.rule === 11 && a.entity === "google",
    );
  const EXPIRED_GOOGLE = {
    access_token: "ya29.OLD_ACCESS_NEVER_RENDERED",
    refresh_token: "1//REFRESH_NEVER_RENDERED",
    client_id: "cid",
    client_secret: "CLIENT_SECRET_NEVER_RENDERED",
    expiry: "2000-01-01T00:00:00Z",
  };

  test("the recorder writes a failing google row, and rule 11 alerts once for google", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    await googleInvalidGrantRecorder(store)();
    const row = await lastCredentialCheck(store, "google");
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain("invalid_grant");
    expect(row?.detail).toContain("ob google auth");
    expect(await googleAlerts(db)).toHaveLength(1);
  }, PG_BUDGET);

  test("the google check on a marked token fails at once and never calls Google", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    await setSecret(store, "google", JSON.stringify({ ...EXPIRED_GOOGLE, refresh_invalid_at: NOW }), KEY.get());
    const seen: Request[] = [];
    const { http } = fakeHttp({ status: 200, body: { scope: "a b" } }, seen);
    const row = await runCredentialCheck(store, "google", { http, masterKey: KEY, probes: probes() });
    expect(row.ok).toBe(false);
    expect(row.detail).toContain("invalid_grant");
    expect(seen).toHaveLength(0);
  }, PG_BUDGET);

  test("end to end: a draft listing refused with invalid_grant marks the stored token and records the failure", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    await setSecret(store, "google", JSON.stringify(EXPIRED_GOOGLE), KEY.get());
    let apiCalls = 0;
    const fetch: GoogleFetch = async (input) => {
      if (String(input).startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }
      apiCalls++;
      return new Response("{}", { status: 200 });
    };
    const client = await gmailDraftClientFor(store, { fetch, masterKey: KEY });
    const err = await listGmailDrafts(client).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).message).toContain("ob google auth");
    for (const v of [EXPIRED_GOOGLE.access_token, EXPIRED_GOOGLE.refresh_token, EXPIRED_GOOGLE.client_secret]) {
      expect((err as AppError).message).not.toContain(v);
    }
    expect(apiCalls).toBe(0);
    const stored = JSON.parse((await getSecret(store, "google", KEY.get()))!);
    expect(stored.refresh_invalid_at).toBeString();
    expect(stored.refresh_token).toBe(EXPIRED_GOOGLE.refresh_token);
    const row = await lastCredentialCheck(store, "google");
    expect(row?.ok).toBe(false);
    expect(row?.detail).toContain("invalid_grant");
  }, PG_BUDGET);
});

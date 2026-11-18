import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDLERS } from "../../../apps/cli/src/cli.ts";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import {
  lastCredentialCheck,
  recordCredentialCheck,
  storeCredential,
} from "../../../apps/cli/src/credentials.ts";
import { computeAlerts } from "../../../apps/cli/src/commands/alerts.ts";
import { getGoogleToken } from "../../cli-sources/src/google.ts";
import {
  clearCredentialCheck,
  getSecret,
  inMemoryMasterKey,
  setSecret,
} from "../../../apps/cli/src/secrets.ts";
import { removeSecretByName, setSecretValue, googleCallback } from "../../../apps/cli/src/api/handlers.ts";
import { createGoogleStateStore } from "../../cli-sources/src/google-hosted.ts";
import { runGoogleAuth, type Loopback } from "../../cli-sources/src/commands/google.ts";
import type { Ctx, Flags } from "../../../apps/cli/src/ctx.ts";
import { jobRunRows } from "../../../apps/cli/src/jobs.ts";

// OB-1934. A person who replaces or removes a credential has made the last live-check verdict stale. A
// failed `gh` or `google` verdict kept alert rule 11 firing after the fix until someone ran `ob creds
// check`, and a removed credential kept an old ok on the tokens page. Every write that is a person's act
// now drops the `credential_check` row; the google token refresh (not a person) keeps it.

const KEY = inMemoryMasterKey();
const NOW = "2026-11-12T12:00:00.000Z";
const CHECKED = "2026-11-12T11:00:00.000Z";
const tls = { proto: "https:", hostname: "example.test" };

async function rule11(store: Store) {
  return (await computeAlerts(store, { focusProject: null, now: NOW })).filter((a) => a.rule === 11);
}

async function failedCheck(store: Store, name: string): Promise<void> {
  await recordCredentialCheck(store, name, { ok: false, detail: "HTTP 401" }, CHECKED);
  expect(await lastCredentialCheck(store, name)).not.toBeNull();
}

describe("clearCredentialCheck (OB-1934)", () => {
  test("deletes only the named row, and a name with no row is a no-op", async () => {
    const store = sqliteStoreFor(freshDb());
    await recordCredentialCheck(store, "github", { ok: true, detail: "ok" }, CHECKED);
    await recordCredentialCheck(store, "ha", { ok: true, detail: "ok" }, CHECKED);
    await clearCredentialCheck(store, "nope");
    await clearCredentialCheck(store, "github");
    expect(await lastCredentialCheck(store, "github")).toBeNull();
    expect(await lastCredentialCheck(store, "ha")).not.toBeNull();
  });
});

describe("ob secret set / rm clear the check (OB-1934)", () => {
  /** `fn` with a throwaway master key file and the value on stdin, so `secret set` runs in-process. */
  async function local<T>(stdin: string | null, fn: () => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "ob-1934-"));
    const keyFile = join(dir, "master.key");
    writeFileSync(keyFile, randomBytes(32).toString("base64"));
    chmodSync(keyFile, 0o600);
    const prevKey = process.env.OMNISLASH_MASTER_KEY_FILE;
    const prevText = Bun.stdin.text;
    process.env.OMNISLASH_MASTER_KEY_FILE = keyFile;
    (Bun.stdin as unknown as { text: () => Promise<string> }).text = async () => stdin ?? "";
    try {
      return await fn();
    } finally {
      (Bun.stdin as unknown as { text: () => Promise<string> }).text = prevText;
      if (prevKey === undefined) delete process.env.OMNISLASH_MASTER_KEY_FILE;
      else process.env.OMNISLASH_MASTER_KEY_FILE = prevKey;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function withStore<T>(dbPath: string, fn: (s: Store) => Promise<T>): Promise<T> {
    const db = openDb(dbPath);
    try {
      return await fn(sqliteStoreFor(db));
    } finally {
      db.close();
    }
  }

  test("`ob secret set` after a failed check leaves no row, and rule 11 raises nothing", async () => {
    const dbPath = freshDbPath();
    await local("new-token", async () => {
      await withStore(dbPath, async (s) => {
        await failedCheck(s, "github");
        expect(await rule11(s)).toHaveLength(1);
      });
      expect((await runCli(dbPath, ["secret", "set", "github"])).code).toBe(0);
      await withStore(dbPath, async (s) => {
        expect(await lastCredentialCheck(s, "github")).toBeNull();
        expect(await rule11(s)).toEqual([]);
      });
    });
  });

  test("`ob secret rm` after an ok check leaves no row", async () => {
    const dbPath = freshDbPath();
    await local("tok", async () => {
      expect((await runCli(dbPath, ["secret", "set", "github"])).code).toBe(0);
      await withStore(dbPath, async (s) => {
        await recordCredentialCheck(s, "github", { ok: true, detail: "fine" }, CHECKED);
      });
      expect((await runCli(dbPath, ["secret", "rm", "github"])).code).toBe(0);
      await withStore(dbPath, async (s) => {
        expect(await lastCredentialCheck(s, "github")).toBeNull();
      });
    });
  });

  test("`ob secret rm` of a secret that is not stored fails and leaves the verdict alone", async () => {
    const dbPath = freshDbPath();
    await local(null, async () => {
      await withStore(dbPath, (s) => failedCheck(s, "github"));
      expect((await runCli(dbPath, ["secret", "rm", "github"])).code).toBe(1);
      await withStore(dbPath, async (s) => {
        expect(await lastCredentialCheck(s, "github")).not.toBeNull();
      });
    });
  });
});

describe("the API writes and the tokens page paste clear the check (OB-1934)", () => {
  test("setSecretValue clears the row", async () => {
    const store = sqliteStoreFor(freshDb());
    await setSecret(store, "github", "old", KEY.get());
    await failedCheck(store, "github");
    await setSecretValue(store, { name: "github", value: "new" }, { masterKey: KEY });
    expect(await lastCredentialCheck(store, "github")).toBeNull();
    expect(await rule11(store)).toEqual([]);
  });

  test("removeSecretByName clears the row", async () => {
    const store = sqliteStoreFor(freshDb());
    await setSecret(store, "github", "old", KEY.get());
    await recordCredentialCheck(store, "github", { ok: true, detail: "fine" }, CHECKED);
    await removeSecretByName(store, { name: "github" });
    expect(await lastCredentialCheck(store, "github")).toBeNull();
  });

  test("removeSecretByName on a missing secret is a 404 and keeps the row", async () => {
    const store = sqliteStoreFor(freshDb());
    await failedCheck(store, "github");
    await expect(removeSecretByName(store, { name: "github" })).rejects.toThrow(/no secret/);
    expect(await lastCredentialCheck(store, "github")).not.toBeNull();
  });

  test("storeCredential (the tokens page paste) clears the row", async () => {
    const store = sqliteStoreFor(freshDb());
    await setSecret(store, "github", "old", KEY.get());
    await failedCheck(store, "github");
    await storeCredential(store, "github", "ghp_new", { origin: tls, masterKey: KEY });
    expect(await lastCredentialCheck(store, "github")).toBeNull();
  });

  test("a refused paste leaves the verdict alone", async () => {
    const store = sqliteStoreFor(freshDb());
    await failedCheck(store, "github");
    await expect(storeCredential(store, "github", "   ", { origin: tls, masterKey: KEY })).rejects.toThrow();
    expect(await lastCredentialCheck(store, "github")).not.toBeNull();
  });
});

describe("ob google auth clears the google check; the token refresh does not (OB-1934)", () => {
  const googleToken = JSON.stringify({
    access_token: "a0",
    refresh_token: "R",
    client_id: "cid",
    client_secret: "sec",
  });

  test("the local loopback write clears the row", async () => {
    const db = freshDb();
    const store = sqliteStoreFor(db);
    await failedCheck(store, "google");
    const ctx: Ctx = {
      db,
      store,
      dbPath: ":memory:",
      mode: "human",
      flags: { "client-id": "flow-id", "client-secret": "sec" } as unknown as Flags,
      args: [],
    };
    let openedUrl = "";
    const origLog = console.log;
    console.log = () => {};
    try {
      await runGoogleAuth(ctx, {
        masterKey: KEY,
        exchange: async () => ({ access_token: "new-at", refresh_token: "new-R", expires_in: 1800 }),
        openUrl: (url) => {
          openedUrl = url;
        },
        startLoopback: (): Loopback => ({
          redirectUri: "http://127.0.0.1:65000",
          waitForCode: async () => ({ code: "c", state: new URL(openedUrl).searchParams.get("state") ?? undefined }),
          close: () => {},
        }),
      });
    } finally {
      console.log = origLog;
    }
    expect(await getSecret(store, "google", KEY.get())).toContain("new-at");
    expect(await lastCredentialCheck(store, "google")).toBeNull();
  });

  test("the hosted callback write clears the row", async () => {
    const store = sqliteStoreFor(freshDb());
    await setSecret(store, "google", googleToken, KEY.get());
    await failedCheck(store, "google");
    const states = createGoogleStateStore(60_000);
    const state = states.mint("https://ob.example/api/ob/google/callback", Date.now());
    const out = await googleCallback(
      store,
      { state, code: "c" },
      {
        states,
        secrets: { masterKey: KEY },
        exchange: async () => ({ access_token: "hosted-at", refresh_token: "hosted-R", expires_in: 1800 }),
      },
    );
    expect(out.ok).toBe(true);
    expect(await lastCredentialCheck(store, "google")).toBeNull();
  });

  test("a token refresh persisted during a sync leaves a failed google row in place", async () => {
    const store = sqliteStoreFor(freshDb());
    await setSecret(store, "google", googleToken, KEY.get());
    await failedCheck(store, "google");
    const resolved = await getGoogleToken(store, KEY);
    await resolved.persist({ ...resolved.token, access_token: "refreshed" });
    expect(await getSecret(store, "google", KEY.get())).toContain("refreshed");
    const row = await lastCredentialCheck(store, "google");
    expect(row?.ok).toBe(false);
  });
});

describe("a --json run that prints nothing is recorded as failed (OB-1934)", () => {
  test("the job row says failed with an error naming the missing output, and the exit is 1", async () => {
    // `ob creds check --all` is a declared job. Swap its handler for one that prints nothing.
    const real = HANDLERS["creds"]!;
    HANDLERS["creds"] = () => {};
    const dbPath = freshDbPath();
    try {
      const r = await runCli(dbPath, ["creds", "check", "--all", "--json"]);
      expect(r.code).toBe(1);
    } finally {
      HANDLERS["creds"] = real;
    }
    const db = openDb(dbPath);
    try {
      const row = (await jobRunRows(sqliteStoreFor(db))).find((j) => j.job === "creds-check");
      expect(row).toBeDefined();
      expect(row!.last_success_at).toBeNull();
      expect(row!.last_failure_at).not.toBeNull();
      expect(row!.consecutive_failures).toBe(1);
      expect(row!.last_error).toContain("no --json output");
    } finally {
      db.close();
    }
  });
});

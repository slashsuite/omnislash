import { describe, expect, test } from "bun:test";
import { freshPgStore } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const PG_BUDGET = spawnBudget(2);
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { openDb } from "../../../apps/cli/src/db.ts";
import {
  addTestUser,
  getTestUser,
  listTestUsers,
  defaultSecretRef,
  secretStaleness,
  recordSecretSeen,
  setTestUserSecret,
  testUserSecretPresent,
} from "../../../apps/cli/src/commands/testuser.ts";
import { getSecret, hasSecret, inMemoryMasterKey } from "../../../apps/cli/src/secrets.ts";

// Open the DB directly rather than via test/helpers.ts (which imports cli.ts and
// its sibling v3 command modules being built in parallel). This test only needs
// the test_user + secret schemas + the module's pure DB/logic helpers — the
// secret store is exercised with an in-memory master key: NO real Keychain, NO
// real tokens, NO `security` shell-out.
function freshDb() {
  return openDb(join(tmpdir(), `ob-testuser-${randomUUID()}.sqlite`));
}

const KEY = inMemoryMasterKey().get(); // fixed in-memory 32-byte key — NEVER the real Keychain

describe("test-user registry — metadata round-trip", () => {
  test("add + get + list round-trips non-secret metadata", () => {
    const db = freshDb();
    addTestUser(db, {
      label: "admin-staging",
      role: "admin",
      email: "admin@example.com",
      workspace: "acme",
      env: "staging",
      notes: "primary admin",
    });
    addTestUser(db, {
      label: "member-prod",
      role: "member",
      email: "member@example.com",
      workspace: "acme",
      env: "prod",
    });

    const admin = getTestUser(db, "admin-staging")!;
    expect(admin.role).toBe("admin");
    expect(admin.email).toBe("admin@example.com");
    expect(admin.workspace).toBe("acme");
    expect(admin.env).toBe("staging");
    expect(admin.notes).toBe("primary admin");
    expect(admin.secret_set_at).toBeNull();
    expect(admin.last_used).toBeNull();

    const all = listTestUsers(db);
    expect(all.map((r) => r.label)).toEqual(["admin-staging", "member-prod"]);
  }, PG_BUDGET);

  test("list filters by role and env", () => {
    const db = freshDb();
    addTestUser(db, { label: "a", role: "admin", env: "staging" });
    addTestUser(db, { label: "b", role: "member", env: "staging" });
    addTestUser(db, { label: "c", role: "admin", env: "prod" });

    expect(listTestUsers(db, { role: "admin" }).map((r) => r.label)).toEqual(["a", "c"]);
    expect(listTestUsers(db, { env: "staging" }).map((r) => r.label)).toEqual(["a", "b"]);
    expect(listTestUsers(db, { role: "admin", env: "prod" }).map((r) => r.label)).toEqual(["c"]);
  });
});

describe("secret_ref = store key", () => {
  test("defaultSecretRef namespaces the store key by label", () => {
    expect(defaultSecretRef("admin-staging")).toBe("test-user:admin-staging");
  }, PG_BUDGET);

  test("add without --secret-ref falls back to the default store key", () => {
    const db = freshDb();
    const row = addTestUser(db, { label: "no-ref" });
    expect(row.secret_ref).toBe("test-user:no-ref");
  }, PG_BUDGET);

  test("add with an explicit secret-ref keeps it (store-key override)", () => {
    const db = freshDb();
    const row = addTestUser(db, { label: "custom", secretRef: "test-user:custom-key" });
    expect(row.secret_ref).toBe("test-user:custom-key");
  }, PG_BUDGET);

  test("duplicate label is rejected", () => {
    const db = freshDb();
    addTestUser(db, { label: "dup" });
    expect(() => addTestUser(db, { label: "dup" })).toThrow(/already exists/);
  });
});

describe("secret stored in the encrypted store (not the Keychain)", () => {
  test("setTestUserSecret encrypts the value under test-user:<label>, retrievable via getSecret", async () => {
    const lease = await freshPgStore();
    const store = lease.store;
    const db = freshDb();
    addTestUser(db, { label: "admin-staging" });

    await setTestUserSecret(store, db, "admin-staging", "pa55word-staging-pw", KEY);

    // stored under the namespaced store key
    expect(await hasSecret(store, "test-user:admin-staging")).toBe(true);
    expect(await getSecret(store, "test-user:admin-staging", KEY)).toBe("pa55word-staging-pw");

    // ciphertext at rest is NOT the plaintext (backup-safe)
    const rawRow = (
      (await lease.sql.unsafe(
        "SELECT ciphertext FROM secret WHERE name = 'test-user:admin-staging'",
      )) as { ciphertext: string }[]
    )[0]!;
    expect(rawRow.ciphertext).not.toContain("pa55word-staging-pw");
    db.close();
    await lease.release();
  }, PG_BUDGET);

  test("setTestUserSecret honours a --secret-ref store-key override", async () => {
    const lease = await freshPgStore();
    const store = lease.store;
    const db = freshDb();
    addTestUser(db, { label: "custom", secretRef: "test-user:custom-key" });
    await setTestUserSecret(store, db, "custom", "pw", KEY);
    expect(await hasSecret(store, "test-user:custom-key")).toBe(true);
    expect(await hasSecret(store, "test-user:custom")).toBe(false);
    db.close();
    await lease.release();
  }, PG_BUDGET);

  test("setTestUserSecret stamps secret_set_at", async () => {
    const lease = await freshPgStore();
    const store = lease.store;
    const db = freshDb();
    addTestUser(db, { label: "seen" });
    expect(getTestUser(db, "seen")!.secret_set_at).toBeNull();
    await setTestUserSecret(store, db, "seen", "pw", KEY);
    expect(getTestUser(db, "seen")!.secret_set_at).not.toBeNull();
    db.close();
    await lease.release();
  }, PG_BUDGET);

  test("setTestUserSecret on an unknown label throws", async () => {
    const lease = await freshPgStore();
    const store = lease.store;
    const db = freshDb();
    await expect(setTestUserSecret(store, db, "ghost", "pw", KEY)).rejects.toThrow(/no test-user/);
    db.close();
    await lease.release();
  });
});

describe("presence check via the store (check subcommand)", () => {
  test("present after set, absent before / for an unknown label", async () => {
    const lease = await freshPgStore();
    const store = lease.store;
    const db = freshDb();
    addTestUser(db, { label: "admin-staging" });

    // before any secret is stored
    expect(await testUserSecretPresent(store, db, "admin-staging")).toBe(false);
    // unknown label
    expect(await testUserSecretPresent(store, db, "nobody")).toBe(false);

    await setTestUserSecret(store, db, "admin-staging", "pw", KEY);
    expect(await testUserSecretPresent(store, db, "admin-staging")).toBe(true);
    db.close();
    await lease.release();
  });
});

describe("staleness", () => {
  test("absent secret_set_at reports unknown age", () => {
    expect(secretStaleness(null)).toContain("unknown");
  }, PG_BUDGET);

  test("recent secret is not stale", () => {
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    expect(secretStaleness(recent)).toBeNull();
  }, PG_BUDGET);

  test("secret older than 90 days is flagged stale", () => {
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
    expect(secretStaleness(old)).toMatch(/stale/);
  });
});

describe("recordSecretSeen", () => {
  test("stamps secret_set_at only when previously null", () => {
    const db = freshDb();
    addTestUser(db, { label: "seen" });
    expect(getTestUser(db, "seen")!.secret_set_at).toBeNull();

    recordSecretSeen(db, "seen");
    const first = getTestUser(db, "seen")!.secret_set_at;
    expect(first).not.toBeNull();

    // Second call must not overwrite the recorded time.
    recordSecretSeen(db, "seen");
    expect(getTestUser(db, "seen")!.secret_set_at).toBe(first);
  });
});

describe("no Keychain / never-print-the-value invariants", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../../apps/cli/src/commands/testuser.ts", import.meta.url)),
    "utf8",
  );

  test("no `security` shell-out remains in the module", () => {
    expect(src).not.toContain("security");
    expect(src).not.toContain("find-generic-password");
    expect(src).not.toContain("Bun.spawnSync");
  }, PG_BUDGET);

  test("the module never decrypts the value for display (no getSecret)", () => {
    expect(src).not.toContain("getSecret");
  });
});

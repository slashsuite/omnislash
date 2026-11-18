import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { freshPgStore, type PgStoreLease } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const PG_BUDGET = spawnBudget(2);
import { openDb } from "../../../apps/cli/src/db.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";
import {
  MASTER_KEY_BYTES,
  decrypt,
  encrypt,
  getSecret,
  hasSecret,
  inMemoryMasterKey,
  listSecrets,
  removeSecret,
  setSecret,
} from "../../../apps/cli/src/secrets.ts";
import { readManagedSecret } from "../../../apps/cli/src/net.ts";
import { importSecrets } from "../../../apps/cli/src/commands/secret.ts";

function tmpPath(): string {
  return join(tmpdir(), `ob-secret-${randomUUID()}`);
}

const KEY = inMemoryMasterKey(); // fixed in-memory 32-byte key — NO real Keychain, NO real tokens

describe("crypto (AES-256-GCM) — 135", () => {
  test("encrypt → decrypt round-trips (incl. unicode + JSON)", async () => {
    const key = KEY.get();
    for (const plain of ["xoxb-opaque-token", '{"access_token":"a","refresh_token":"r"}', "ünïcödé 🔐"]) {
      const enc = encrypt(plain, key);
      // ciphertext is base64 and NOT the plaintext
      expect(enc.ciphertext).not.toContain(plain);
      expect(decrypt(enc, key)).toBe(plain);
    }
  }, PG_BUDGET);

  test("a fresh random IV per encryption (same plaintext → different ciphertext)", async () => {
    const key = KEY.get();
    const a = encrypt("same", key);
    const b = encrypt("same", key);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  }, PG_BUDGET);

  test("wrong key fails GCM authentication", async () => {
    const enc = encrypt("secret-value", KEY.get());
    const otherKey = randomBytes(MASTER_KEY_BYTES);
    expect(() => decrypt(enc, otherKey)).toThrow();
  }, PG_BUDGET);

  test("tampered ciphertext / auth tag is rejected", async () => {
    const key = KEY.get();
    const enc = encrypt("secret-value", key);
    // flip a byte in the ciphertext
    const bad = Buffer.from(enc.ciphertext, "base64");
    bad[0] = bad[0]! ^ 0xff;
    expect(() => decrypt({ ...enc, ciphertext: bad.toString("base64") }, key)).toThrow();
    // flip the auth tag
    const badTag = Buffer.from(enc.authTag, "base64");
    badTag[0] = badTag[0]! ^ 0xff;
    expect(() => decrypt({ ...enc, authTag: badTag.toString("base64") }, key)).toThrow();
  });
});

describe("store operations — 135", () => {
  test("set / get / list / rm; list never returns values; missing get → null", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const key = KEY.get();

    expect(await getSecret(db, "ha", key)).toBeNull(); // absent → null (clean)
    expect(await hasSecret(db, "ha")).toBe(false);

    await setSecret(db, "ha", "ha-value", key);
    await setSecret(db, "linear", "lin_value", key);
    expect(await getSecret(db, "ha", key)).toBe("ha-value");
    expect(await hasSecret(db, "ha")).toBe(true);

    // update in place
    await setSecret(db, "ha", "ha-rotated", key);
    expect(await getSecret(db, "ha", key)).toBe("ha-rotated");

    // list returns names + updated_at ONLY — never the value or ciphertext
    const rows = await listSecrets(db);
    expect(rows.map((r) => r.name).sort()).toEqual(["ha", "linear"]);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("ha-rotated");
    expect(serialized).not.toContain("lin_value");
    for (const r of rows) expect(r.updated_at).toBeTruthy();

    // rm
    expect(await removeSecret(db, "ha")).toBe(true);
    expect(await removeSecret(db, "ha")).toBe(false); // idempotent
    expect(await getSecret(db, "ha", key)).toBeNull();
    await lease.release();
  }, PG_BUDGET);

  test("ciphertext at rest is not the plaintext (backup-safe)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await setSecret(db, "linear", "lin_PLAINTEXT_TOKEN", KEY.get());
    const row = (
      (await lease.sql.unsafe(
        "SELECT ciphertext, iv, auth_tag FROM secret WHERE name = 'linear'",
      )) as { ciphertext: string; iv: string; auth_tag: string }[]
    )[0]!;
    expect(row.ciphertext).not.toContain("lin_PLAINTEXT_TOKEN");
    expect(row.iv).toBeTruthy();
    expect(row.auth_tag).toBeTruthy();
    await lease.release();
  });
});

describe("reader with file fallback — 135", () => {
  test("store hit uses the store (no file touched)", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await setConfig(db, "ha_token_path", "/nonexistent/never/read");
    await setSecret(db, "ha", "from-store", KEY.get());
    expect(await readManagedSecret(db, "ha", KEY)).toBe("from-store");
    await lease.release();
  }, PG_BUDGET);

  test("store miss + a fixture file → uses the file and warns to stderr", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const file = tmpPath();
    writeFileSync(file, "from-file\n");
    await setConfig(db, "ha_token_path", file);

    const origWrite = process.stderr.write.bind(process.stderr);
    let warned = "";
    (process.stderr.write as unknown) = (chunk: string) => {
      warned += chunk;
      return true;
    };
    try {
      expect(await readManagedSecret(db, "ha", KEY)).toBe("from-file"); // trimmed
    } finally {
      (process.stderr.write as unknown) = origWrite;
    }
    expect(warned).toContain("ob secret import");
    rmSync(file, { force: true });
    await lease.release();
  }, PG_BUDGET);

  test("neither store nor file → clean AppError", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    await setConfig(db, "ha_token_path", tmpPath()); // guaranteed absent
    let err: unknown;
    try {
      await readManagedSecret(db, "ha", KEY);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as Error).message).toContain("cannot read Home Assistant token");
    await lease.release();
  });
});

describe("ob secret import — 135", () => {
  test("imports the existing token files, is idempotent, and reports absent ones", async () => {
    const lease = await freshPgStore();
    const db = lease.store;
    const haFile = tmpPath();
    const githubFile = tmpPath();
    writeFileSync(haFile, "ha-imported\n");
    writeFileSync(githubFile, "gh_imported\n");
    await setConfig(db, "ha_token_path", haFile);
    await setConfig(db, "github_key_path", githubFile);
    // google points at a guaranteed-absent file
    await setConfig(db, "google_token_path", tmpPath());

    const first = await importSecrets(db, KEY);
    const byName = Object.fromEntries(first.map((r) => [r.name, r.action]));
    expect(byName.ha).toBe("imported");
    expect(byName.github).toBe("imported");
    expect(byName.google).toBe("absent");

    // ciphertext landed + decrypts to the file contents (trimmed)
    expect(await getSecret(db, "ha", KEY.get())).toBe("ha-imported");
    expect(await getSecret(db, "github", KEY.get())).toBe("gh_imported");

    // idempotent: a re-run skips the already-stored ones, does not change the value
    const second = await importSecrets(db, KEY);
    const byName2 = Object.fromEntries(second.map((r) => [r.name, r.action]));
    expect(byName2.ha).toBe("exists");
    expect(byName2.github).toBe("exists");
    expect(await getSecret(db, "ha", KEY.get())).toBe("ha-imported");

    rmSync(haFile, { force: true });
    rmSync(githubFile, { force: true });
    await lease.release();
  });
});

describe("the secret table in the Postgres chain — 135/337", () => {
  test("a fresh database has the secret table and it round-trips", async () => {
    const lease = await freshPgStore();
    const tables = (
      (await lease.sql.unsafe(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name='secret'",
      )) as { table_name: string }[]
    ).map((r) => r.table_name);
    expect(tables).toEqual(["secret"]);
    await setSecret(lease.store, "github", "ghp_value", KEY.get());
    expect(await getSecret(lease.store, "github", KEY.get())).toBe("ghp_value");
    await lease.release();
  }, PG_BUDGET);

  test("the secret table is empty until a value is set (no plaintext seeded)", async () => {
    const lease = await freshPgStore();
    const rows = (await lease.sql.unsafe("SELECT count(*)::int AS n FROM secret")) as { n: number }[];
    expect(rows[0]!.n).toBe(0);
    await lease.release();
  }, PG_BUDGET);
});

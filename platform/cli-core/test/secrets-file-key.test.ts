import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { freshPgStore } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const PG_BUDGET = spawnBudget(2);
import {
  MASTER_KEY_BYTES,
  MASTER_KEY_FILE_ENV,
  defaultMasterKey,
  fileMasterKey,
  getSecret,
  inMemoryMasterKey,
  masterKeyFilePath,
  setSecret,
} from "../../../apps/cli/src/secrets.ts";

// -----------------------------------------------------------------------------
// File-backed master key (182): the seam that lets `ob` run off darwin. Every key
// here is random test material written to a temp file — no real Keychain, no real
// token, and nothing that outlives the run.
// -----------------------------------------------------------------------------

const dirs: string[] = [];

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ob-master-key-"));
  dirs.push(d);
  return d;
}

/** Write a key file at 0600 and return its path. `contents` defaults to base64 of 32 random bytes. */
function keyFile(contents?: string, mode = 0o600): { path: string; key: Buffer } {
  const key = randomBytes(MASTER_KEY_BYTES);
  const path = join(tmpDir(), "master.key");
  writeFileSync(path, contents ?? `${key.toString("base64")}\n`);
  chmodSync(path, mode);
  return { path, key };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("fileMasterKey — happy path", () => {
  test("reads base64 of 32 bytes, tolerating a trailing newline", () => {
    const { path, key } = keyFile();
    expect(fileMasterKey(path).get().equals(key)).toBe(true);
  });

  test("round-trips a secret through the store", async () => {
    const lease = await freshPgStore();
    const { path } = keyFile();
    const k = fileMasterKey(path).get();
    await setSecret(lease.store, "linear", "lin_api_test-value", k);
    expect(await getSecret(lease.store, "linear", k)).toBe("lin_api_test-value");
    await lease.release();
  }, PG_BUDGET);

  test("the SAME 32 bytes via a file and in memory decrypt the same ciphertext", async () => {
    // This is the property that makes the Proxmox move re-encryption-free: carry the key,
    // not the ciphertext's provenance.
    const lease = await freshPgStore();
    const key = randomBytes(MASTER_KEY_BYTES);
    const path = join(tmpDir(), "master.key");
    writeFileSync(path, key.toString("base64"));
    chmodSync(path, 0o600);

    await setSecret(lease.store, "ha", "ha-round-trip", inMemoryMasterKey(key).get());
    expect(await getSecret(lease.store, "ha", fileMasterKey(path).get())).toBe("ha-round-trip");
    await lease.release();
  }, PG_BUDGET);
});

describe("fileMasterKey — every failure names the path and the problem", () => {
  test("missing file", () => {
    const path = join(tmpDir(), "absent.key");
    expect(() => fileMasterKey(path).get()).toThrow(new RegExp(`no master key file at ${path}`));
  });

  test("a miss does NOT mint a key — a fresh key would not decrypt the stored secrets", () => {
    const path = join(tmpDir(), "absent.key");
    expect(() => fileMasterKey(path).get()).toThrow(/Refusing to generate a new key/);
    expect(existsSync(path)).toBe(false);
  });

  test("not valid base64", () => {
    const { path } = keyFile("this is not base64!!\n");
    expect(() => fileMasterKey(path).get()).toThrow(/is not valid base64/);
  });

  test("wrong byte length", () => {
    const { path } = keyFile(`${randomBytes(16).toString("base64")}\n`);
    expect(() => fileMasterKey(path).get()).toThrow(/decodes to 16 bytes, expected 32/);
  });

  test("permissions looser than 0600 are refused, with the chmod fix", () => {
    const { path } = keyFile(undefined, 0o644);
    expect(() => fileMasterKey(path).get()).toThrow(/has mode 0644/);
    expect(() => fileMasterKey(path).get()).toThrow(new RegExp(`chmod 600 ${path}`));
  });

  test("0400 is fine — the check is on group/other bits, not on write", () => {
    const { path, key } = keyFile(undefined, 0o400);
    expect(fileMasterKey(path).get().equals(key)).toBe(true);
  });

  test("no error ever echoes the key material", () => {
    const key = randomBytes(MASTER_KEY_BYTES);
    const b64 = key.toString("base64");
    const path = join(tmpDir(), "master.key");
    writeFileSync(path, b64);
    chmodSync(path, 0o644);
    const msg = (() => {
      try {
        fileMasterKey(path).get();
        return "";
      } catch (err) {
        return (err as Error).message;
      }
    })();
    expect(msg).not.toContain(b64);
    expect(msg).not.toContain(b64.slice(0, 8));
  });
});

describe("provider selection", () => {
  test("masterKeyFilePath: unset, empty and whitespace-only all read as absent", () => {
    expect(masterKeyFilePath({})).toBeNull();
    expect(masterKeyFilePath({ [MASTER_KEY_FILE_ENV]: "" })).toBeNull();
    expect(masterKeyFilePath({ [MASTER_KEY_FILE_ENV]: "   " })).toBeNull();
    expect(masterKeyFilePath({ [MASTER_KEY_FILE_ENV]: " /etc/omnislash/master.key " })).toBe(
      "/etc/omnislash/master.key",
    );
  });

  test("the env var beats the Keychain, on darwin too", () => {
    const { path, key } = keyFile();
    const provider = defaultMasterKey({ [MASTER_KEY_FILE_ENV]: path }, "darwin");
    expect(provider.get().equals(key)).toBe(true);
  });

  test("no env var on darwin falls through to the Keychain provider (blocked under the test runner)", () => {
    expect(() => defaultMasterKey({}, "darwin").get()).toThrow(/refusing to read the real macOS Keychain/);
  });

  test("no env var off darwin is a clear error naming the env var and the export command", () => {
    const attempt = () => defaultMasterKey({}, "linux").get();
    expect(attempt).toThrow(/no master key available on linux/);
    expect(attempt).toThrow(new RegExp(MASTER_KEY_FILE_ENV));
    expect(attempt).toThrow(/security find-generic-password -s omnislash-master-key -a omnislash -w/);
  });

  test("off darwin WITH the env var works — this is what unblocks the move", () => {
    const { path, key } = keyFile();
    expect(defaultMasterKey({ [MASTER_KEY_FILE_ENV]: path }, "linux").get().equals(key)).toBe(true);
  });

  test("constructing the provider is inert — nothing is read until .get()", () => {
    expect(() => defaultMasterKey({}, "linux")).not.toThrow();
    expect(() => fileMasterKey(join(tmpDir(), "absent.key"))).not.toThrow();
  });
});

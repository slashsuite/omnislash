import { describe, expect, test } from "bun:test";
import { freshPgStore } from "../../../apps/cli/test/pg/store.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";
import {
  inMemoryMasterKey,
  keychainMasterKey,
  MASTER_KEY_BYTES,
  masterKeyForWrite,
  mintOnWrite,
  setSecret,
  type SecurityRunner,
} from "../../../apps/cli/src/secrets.ts";

// -----------------------------------------------------------------------------
// OB-1911: the Keychain provider must not mint a new master key when its item is missing.
// A fresh key would not decrypt the stored ciphertexts and would hide why, so a miss is a
// named error, and a key is minted only by a write into an empty store. Every case drives a
// FAKE `security` seam with platform "darwin"; the real binary is never reached.
// -----------------------------------------------------------------------------

const PG_BUDGET = spawnBudget(2);
const MISSING = /master key is missing from the Keychain/;

/** A fake `security`: holds at most one item and logs each call's subcommand. */
function fakeSecurity(initial?: Buffer) {
  let item = initial?.toString("base64");
  const calls: string[][] = [];
  const run: SecurityRunner = (args) => {
    calls.push(args);
    if (args[0] === "find-generic-password") {
      return item ? { exitCode: 0, stdout: `${item}\n`, stderr: "" } : { exitCode: 44, stdout: "", stderr: "not found" };
    }
    if (args[0] === "add-generic-password") {
      item = args[args.indexOf("-w") + 1];
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected" };
  };
  const adds = () => calls.filter((c) => c[0] === "add-generic-password").length;
  return { run, calls, adds };
}

describe("keychainMasterKey on a miss (OB-1911)", () => {
  test("item present: returns the key, no add call", () => {
    const key = Buffer.alloc(MASTER_KEY_BYTES, 3);
    const fake = fakeSecurity(key);
    expect(keychainMasterKey({ platform: "darwin", security: fake.run }).get().equals(key)).toBe(true);
    expect(fake.adds()).toBe(0);
  });

  test("item missing, mintIfMissing false (the default): named error saying how to restore, no add call", () => {
    const fake = fakeSecurity();
    let msg = "";
    try {
      keychainMasterKey({ platform: "darwin", security: fake.run }).get();
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toMatch(MISSING);
    expect(msg).toStartWith("the OmniSlash master key is missing from the Keychain");
    expect(msg).toContain("security add-generic-password -s omnislash-master-key -a omnislash -w <base64 key>");
    expect(msg).toContain("OMNISLASH_MASTER_KEY_FILE");
    expect(fake.adds()).toBe(0);
  });

  test("item missing, mintIfMissing true: exactly one add call, returns a 32-byte key", () => {
    const fake = fakeSecurity();
    const key = keychainMasterKey({ platform: "darwin", security: fake.run, mintIfMissing: true }).get();
    expect(key.length).toBe(MASTER_KEY_BYTES);
    expect(fake.adds()).toBe(1);
    // and it reads back the key it stored
    expect(keychainMasterKey({ platform: "darwin", security: fake.run }).get().equals(key)).toBe(true);
    expect(fake.adds()).toBe(1);
  });

  test("a failed add keeps today's error", () => {
    const run: SecurityRunner = (args) =>
      args[0] === "add-generic-password"
        ? { exitCode: 1, stdout: "", stderr: "denied" }
        : { exitCode: 44, stdout: "", stderr: "" };
    expect(() => keychainMasterKey({ platform: "darwin", security: run, mintIfMissing: true }).get()).toThrow(
      /could not create the OmniSlash master key in the Keychain: denied/,
    );
  });

  test("off darwin the platform error is unchanged whatever mintIfMissing says", () => {
    const fake = fakeSecurity();
    for (const mintIfMissing of [true, false]) {
      expect(() => keychainMasterKey({ platform: "linux", security: fake.run, mintIfMissing }).get()).toThrow(
        /unavailable on this platform/,
      );
    }
    expect(fake.calls.length).toBe(0);
  });
});

describe("mintOnWrite / masterKeyForWrite (OB-1911)", () => {
  test("mintOnWrite: false on a store holding a secret, true on an empty one", async () => {
    const lease = await freshPgStore();
    const store = lease.store;
    expect(await mintOnWrite(store)).toBe(true);
    await setSecret(store, "ha", "v", inMemoryMasterKey().get());
    expect(await mintOnWrite(store)).toBe(false);
    await lease.release();
  }, PG_BUDGET);

  test("masterKeyForWrite: a non-empty store with the item missing throws, an empty one mints once", async () => {
    const lease = await freshPgStore();
    const store = lease.store;

    const onEmpty = fakeSecurity();
    const minted = (await masterKeyForWrite(store, { env: {}, platform: "darwin", security: onEmpty.run })).get();
    expect(minted.length).toBe(MASTER_KEY_BYTES);
    expect(onEmpty.adds()).toBe(1);

    await setSecret(store, "ha", "v", inMemoryMasterKey().get());
    const onFull = fakeSecurity();
    const provider = await masterKeyForWrite(store, { env: {}, platform: "darwin", security: onFull.run });
    expect(() => provider.get()).toThrow(MISSING);
    expect(onFull.adds()).toBe(0);
    await lease.release();
  }, PG_BUDGET);
});

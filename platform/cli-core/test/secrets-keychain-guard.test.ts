import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inMemoryMasterKey,
  keychainMasterKey,
  MASTER_KEY_BYTES,
  REAL_KEYCHAIN_OPT_IN,
  realKeychainBlocked,
} from "../../../apps/cli/src/secrets.ts";

// -----------------------------------------------------------------------------
// The real macOS Keychain is off-limits to the suite (152). The master key it holds
// unlocks the store containing live tokens (`ob secret get linear`), so a test that
// read it would contend for shared credential storage and, on a first-use miss, WRITE
// to it. `keychainMasterKey().get()` therefore refuses under a test runner.
//
// Real-wiring coverage survives in ONE narrowly-scoped case below: a child process
// runs the genuine provider against a `security` STUB on its PATH, so the argv and the
// read/mint paths are asserted for real while the login keychain is never touched.
// (PATH must be set before the process starts — Bun.spawnSync resolves against the
// launch-time environment, so an in-process PATH edit would not redirect it.)
// -----------------------------------------------------------------------------

const SECRETS_MODULE = fileURLToPath(new URL("../../../apps/cli/src/secrets.ts", import.meta.url));

describe("the real Keychain is unreachable from a test run", () => {
  test("keychainMasterKey().get() refuses instead of shelling out to `security`", () => {
    expect(process.env.NODE_ENV).toBe("test"); // the condition the guard keys off
    expect(() => keychainMasterKey().get()).toThrow(/refusing to read the real macOS Keychain/);
  });

  test("the refusal names the injectable alternative, which works", () => {
    expect(() => keychainMasterKey().get()).toThrow(/inMemoryMasterKey/);
    expect(inMemoryMasterKey().get().length).toBe(MASTER_KEY_BYTES);
  });

  test("realKeychainBlocked: blocked under a test runner, allowed for the real CLI, opt-out explicit", () => {
    expect(realKeychainBlocked({ NODE_ENV: "test" })).toBe(true);
    expect(realKeychainBlocked({})).toBe(false);
    expect(realKeychainBlocked({ NODE_ENV: "production" })).toBe(false);
    expect(realKeychainBlocked({ NODE_ENV: "test", [REAL_KEYCHAIN_OPT_IN]: "1" })).toBe(false);
    // Only an exact "1" opts in — a stray truthy value must not unlock credential storage.
    expect(realKeychainBlocked({ NODE_ENV: "test", [REAL_KEYCHAIN_OPT_IN]: "true" })).toBe(true);
  });
});

describe("real wiring, against a `security` stub (never the login keychain)", () => {
  test("reads the key back when present, and mints+stores one on a miss when asked to", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-keychain-wiring-"));
    const argvLog = join(dir, "argv.log");
    const stored = join(dir, "stored-key"); // stands in for the keychain item

    // A stub `security`: `find-generic-password -w` prints the stored key (exit 1 when there is
    // none, which is what drives the provider's mint path); `add-generic-password -w` stores it.
    const stub = join(dir, "security");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        `echo "$@" >> "${argvLog}"`,
        'case "$1" in',
        `  find-generic-password) [ -f "${stored}" ] || exit 1; cat "${stored}"; exit 0 ;;`,
        `  add-generic-password) shift; while [ "$1" != "-w" ]; do shift; done; printf '%s' "$2" > "${stored}"; exit 0 ;;`,
        "esac",
        "exit 1",
      ].join("\n"),
    );
    chmodSync(stub, 0o755);

    const driver = join(dir, "driver.ts");
    writeFileSync(
      driver,
      [
        `import { keychainMasterKey } from ${JSON.stringify(SECRETS_MODULE)};`,
        // This is the macOS provider, and the seat running the suite is often Linux. That guard is
        // about which provider EXISTS, not about anything this test touches: `security` below is the
        // STUB on PATH and the real login keychain is never reached. Simulating the platform keeps the
        // provider's real argv + read/mint paths pinned on every seat instead of skipping them.
        `Object.defineProperty(process, "platform", { value: "darwin" });`,
        "const first = keychainMasterKey({ mintIfMissing: true }).get();",
        "const second = keychainMasterKey().get();",
        "console.log(JSON.stringify({ len: first.length, same: first.equals(second) }));",
      ].join("\n"),
    );

    const p = Bun.spawnSync([process.execPath, "run", driver], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        NODE_ENV: "test",
        [REAL_KEYCHAIN_OPT_IN]: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = new TextDecoder().decode(p.stdout).trim();
    const err = new TextDecoder().decode(p.stderr).trim();
    expect({ code: p.exitCode, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out)).toEqual({ len: MASTER_KEY_BYTES, same: true });

    // The provider queried, missed, minted, then read its own key back — and it addressed the
    // omnislash item, not some other keychain entry.
    const calls = readFileSync(argvLog, "utf8").trim().split("\n");
    expect(calls[0]).toContain("find-generic-password");
    expect(calls[1]).toContain("add-generic-password");
    expect(calls[2]).toContain("find-generic-password");
    for (const c of calls) expect(c).toContain("-s omnislash-master-key -a omnislash");
    // Budget states the processes this starts: one bun driver plus its three `security` stub calls.
    // Swap for the shared `spawnBudget(4)` once #155's test/helpers.ts version lands.
  }, 25_000);

  test("with the default options a miss is a named error and nothing is added (OB-1911)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-keychain-nomint-"));
    const argvLog = join(dir, "argv.log");
    // The stub never holds an item: every find misses, and an add would be logged.
    const stub = join(dir, "security");
    writeFileSync(stub, ["#!/bin/sh", `echo "$@" >> "${argvLog}"`, "exit 44"].join("\n"));
    chmodSync(stub, 0o755);

    const driver = join(dir, "driver.ts");
    writeFileSync(
      driver,
      [
        `import { keychainMasterKey } from ${JSON.stringify(SECRETS_MODULE)};`,
        `Object.defineProperty(process, "platform", { value: "darwin" });`,
        "try { keychainMasterKey().get(); console.log('no-throw'); } catch (e) { console.log((e as Error).message); }",
      ].join("\n"),
    );

    const p = Bun.spawnSync([process.execPath, "run", driver], {
      cwd: dir,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, NODE_ENV: "test", [REAL_KEYCHAIN_OPT_IN]: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(0);
    expect(new TextDecoder().decode(p.stdout)).toMatch(/master key is missing from the Keychain/);

    const calls = readFileSync(argvLog, "utf8").trim().split("\n");
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("find-generic-password");
    expect(calls.some((c) => c.includes("add-generic-password"))).toBe(false);
  }, 25_000);
});

import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnBudget } from "./helpers.ts";

// OB-1829: `ob secret get <name> | wc -c` returned 131072 bytes of a 176 KB secret, and exit 0.
// `index.ts` called `process.exit` straight after `printRaw`, whose `process.stdout.write` to a pipe is
// asynchronous in Bun, so the exit cut the write off at the pipe buffer. An in-process `run()` call cannot
// show it (there is no pipe and no exit), so this spawns the real entry point and reads its stdout the way a
// shell pipe or `$(...)` does.
//
// Why 4 MB and not the original 176 KB: at 200 KB the cut is a coin flip (a fast reader empties the pipe in
// time), at 4 MB it is cut short on nearly every run without the fix (131072 to 511616 bytes seen). The reader also waits before it
// reads, so the pipe is full when the process reaches `process.exit`.
//
// The second large-output command: there is none to cover. `printRaw` has exactly two callers, `ob secret get`
// (local, secret.ts) and the same command on the API client (client-handlers.ts apiSecret), and both go
// through this same exit. Every other command prints with `print()`, which is `console.log`, and Bun writes
// that synchronously, so a 4 MB `print()` to a pipe arrives whole even through `process.exit`
// (measured, 3 of 3 runs).

const ENTRY = join(import.meta.dir, "..", "src", "index.ts");

async function ob(env: Record<string, string>, args: string[], stdin?: string, readDelayMs = 0) {
  const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (readDelayMs > 0) await Bun.sleep(readDelayMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
  return { out: Buffer.from(out), err, code };
}

describe("ob secret get into a pipe (OB-1829)", () => {
  test("a 4 MB value arrives whole through a slow pipe reader, same hash, exit 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-1829-"));
    try {
      const keyFile = join(dir, "master.key");
      writeFileSync(keyFile, randomBytes(32).toString("base64"));
      chmodSync(keyFile, 0o600);
      const env = {
        OMNISLASH_DB: join(dir, "t.sqlite"),
        OMNISLASH_DB_CREATE: "1",
        OMNISLASH_STORE: "sqlite",
        OMNISLASH_MASTER_KEY_FILE: keyFile,
        OMNISLASH_API: "", // empty reads as unset, so a shell that exports it cannot send the 4 MB to a real API
        OMNISLASH_API_URL_FILE: join(dir, "no-api-url"),
        OMNISLASH_DISABLE_FRONTIER: "1",
      };
      // base64 text: stdin is trimmed, so the stored value is exactly this string.
      const value = randomBytes(3_000_000).toString("base64");
      expect(value.length).toBe(4_000_000);

      const set = await ob(env, ["secret", "set", "big"], value);
      expect(set.code).toBe(0);

      const got = await ob(env, ["secret", "get", "big"], undefined, 500);
      expect(got.code).toBe(0);
      expect(got.err).toBe("");
      expect(got.out.length).toBe(value.length + 1);
      const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
      expect(sha(got.out.subarray(0, value.length))).toBe(sha(value));
      expect(got.out.at(-1)).toBe(0x0a);

      // The fix must not change what the exit code says.
      const missing = await ob(env, ["secret", "get", "nope"]);
      expect(missing.code).toBe(1);
      expect(missing.out.length).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, spawnBudget(3));
});

import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creditErrorOf } from "../../../apps/cli/src/models-credit.ts";
import { DEFAULT_REVIEW_LEGS, DEFAULT_REVIEW_MODELS } from "../../../apps/cli/src/models-file.ts";
import { antigravityUsageTokens, readLegRecords } from "../../../apps/cli/src/review-legs.ts";
import { defaultReviewReaders, loadReviewReaders, type ConfigIO } from "../../../apps/cli/src/review-readers.ts";
import {
  antigravitySettings,
  DENIED_COMMANDS,
  finishAntigravityRun,
  legCommand,
  legProfiles,
  legSpawn,
  READ_COMMANDS,
  resolveLeg,
} from "../../../skills/ob-skeptical-review/review-leg.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");
const REVIEW_LEG_SCRIPT = join(REPO_ROOT, "skills/ob-skeptical-review/review-leg.ts");
const CLI_ENTRY = join(REPO_ROOT, "apps/cli/src/index.ts");

function withScratch<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ob-os130-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function writeFakeAgy(binDir: string, scriptBody: string): string {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "agy");
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${scriptBody}\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

describe("OS-130: antigravity (agy) skeptical-review leg", () => {
  test("antigravity: prefix routes to agy with stripped --model, --sandbox, json output, read-only --settings, no --mode plan or skip-permissions", () => {
    const resolved = resolveLeg("neon", { OB_MODELS_FILE: "/nonexistent/models.jsonc" });
    expect(resolved).toEqual({ kind: "antigravity", model: "gemini-4-neon" });

    const raw = resolveLeg("antigravity:gemini-4-neon-preview", { OB_MODELS_FILE: "/nonexistent/models.jsonc" });
    expect(raw).toEqual({ kind: "antigravity", model: "gemini-4-neon-preview" });

    const cmd = legCommand("neon", "/tmp/unused-oc", { OB_MODELS_FILE: "/nonexistent/models.jsonc" });
    expect(cmd.env).toEqual({});
    expect(cmd.argv[0]).toBe("agy");
    expect(cmd.argv.slice(1, 3)).toEqual(["--model", "gemini-4-neon"]);
    expect(cmd.argv).toContain("--sandbox");
    expect(cmd.argv).toContain("--output-format");
    expect(cmd.argv[cmd.argv.indexOf("--output-format") + 1]).toBe("json");
    expect(cmd.argv).not.toContain("--mode");
    expect(cmd.argv).not.toContain("plan");
    expect(cmd.argv).not.toContain("--dangerously-skip-permissions");

    const settingsIdx = cmd.argv.indexOf("--settings");
    expect(settingsIdx).toBeGreaterThan(0);
    const parsed = JSON.parse(cmd.argv[settingsIdx + 1]!) as ReturnType<typeof antigravitySettings>;
    expect(parsed.permissions.allow).toContain("read_file(*)");
    for (const c of READ_COMMANDS) {
      expect(parsed.permissions.allow).toContain(`command(${c})`);
      expect(parsed.permissions.allow).toContain(`command(${c} *)`);
    }
    expect(parsed.permissions.deny).toContain("write_file(*)");
    for (const c of DENIED_COMMANDS) {
      expect(parsed.permissions.deny).toContain(`command(${c})`);
      expect(parsed.permissions.deny).toContain(`command(${c} *)`);
    }
    expect(parsed.permissions.deny).toContain("command(git * --output*)");
  });

  test("200 KiB brief goes into a temp file under $TMPDIR with --add-dir and short -p prompt, never on argv", async () => {
    await withScratch((dir) => {
      const customTmp = join(dir, "tmp");
      const marker = "UNIQUE-200K-BRIEF-MARKER-OS130";
      const bigBrief = `${marker}\n${"x".repeat(205 * 1024)}\nEND`;
      expect(Buffer.byteLength(bigBrief)).toBeGreaterThan(200 * 1024);

      const { argv } = legCommand("neon", "/tmp/unused", { OB_MODELS_FILE: "/nonexistent/models.jsonc" });
      const spawn = legSpawn(argv, bigBrief, { TMPDIR: customTmp });
      try {
        expect(spawn.stdin).toBe("");
        expect(spawn.briefDir).toBeDefined();
        expect(spawn.briefDir!.startsWith(customTmp)).toBe(true);

        const addDirIdx = spawn.cmd.indexOf("--add-dir");
        expect(addDirIdx).toBeGreaterThan(0);
        expect(spawn.cmd[addDirIdx + 1]).toBe(spawn.briefDir!);

        const promptIdx = spawn.cmd.indexOf("-p");
        expect(promptIdx).toBeGreaterThan(0);
        const prompt = spawn.cmd[promptIdx + 1]!;
        const briefFile = join(spawn.briefDir!, "brief.md");
        expect(prompt).toContain(briefFile);
        expect(Buffer.byteLength(prompt)).toBeLessThan(1024);

        for (const arg of spawn.cmd) {
          expect(arg).not.toContain(marker);
          expect(Buffer.byteLength(arg)).toBeLessThan(4096);
        }
        expect(readFileSync(briefFile, "utf8")).toBe(bigBrief);
      } finally {
        if (spawn.briefDir) rmSync(spawn.briefDir, { recursive: true, force: true });
      }
    });
  });

  test("default review readers list neon and opus only while deepseek and luna stay runnable when named", async () => {
    expect([...DEFAULT_REVIEW_LEGS]).toEqual(["neon", "opus"]);
    expect(DEFAULT_REVIEW_MODELS.neon).toBe("antigravity:gemini-4-neon");
    expect(DEFAULT_REVIEW_MODELS.opus).toBe("claude-opus-5-5");

    const defaults = defaultReviewReaders();
    expect(Object.keys(defaults.readers)).toEqual(["neon", "opus"]);
    expect(defaults.tiers.map((r) => r.legs)).toEqual([["neon", "opus"], ["neon", "opus"], ["neon", "opus"]]);

    const emptyIO: ConfigIO = { get: async () => null, set: async () => {} };
    const loaded = await loadReviewReaders(emptyIO);
    expect(loaded.stored).toBe(false);
    expect(Object.keys(loaded.value.readers)).toEqual(["neon", "opus"]);

    // deepseek and luna remain runnable when named directly or via review_readers / models file.
    const ds = legCommand("deepseek", "/tmp/oc", { OB_MODELS_FILE: "/nonexistent/models.jsonc" });
    expect(ds.argv[0]).toBe("opencode");
    expect(ds.argv).toContain(DEFAULT_REVIEW_MODELS.deepseek);

    const lu = legCommand("luna", "/tmp/oc", { OB_MODELS_FILE: "/nonexistent/models.jsonc" });
    expect(lu.argv[0]).toBe("opencode");
    expect(lu.argv).toContain(DEFAULT_REVIEW_MODELS.luna);

    // End-to-end `ob review readers` CLI with review_readers unset.
    await withScratch((dir) => {
      const dbPath = join(dir, "ob.sqlite");
      const env = {
        ...process.env,
        OMNISLASH_STORE: "sqlite",
        OMNISLASH_DB_CREATE: "1",
        OMNISLASH_DB: dbPath,
        OB_REMOTE: "0",
      };
      const q = Bun.spawnSync(["bun", CLI_ENTRY, "review", "readers", "--tier", "medium", "-q"], { env, stdout: "pipe", stderr: "pipe" });
      expect(q.exitCode).toBe(0);
      expect(q.stdout.toString().trim().split("\n")).toEqual(["neon", "opus"]);

      const j = Bun.spawnSync(["bun", CLI_ENTRY, "review", "readers", "--json"], { env, stdout: "pipe", stderr: "pipe" });
      expect(j.exitCode).toBe(0);
      const parsed = JSON.parse(j.stdout.toString()) as { stored: boolean; readers: Record<string, { model: string }>; tiers: Array<{ from: number; to: number; legs: string[] }> };
      expect(parsed.stored).toBe(false);
      expect(Object.keys(parsed.readers)).toEqual(["neon", "opus"]);
      expect(parsed.tiers.at(-1)).toEqual({ from: 7, to: 10, legs: ["neon", "opus"] });
    });
  });

  test("legProfiles dedupes by (kind, model) so same model name on a different kind is kept", async () => {
    await withScratch((dir) => {
      const modelsPath = join(dir, "models.jsonc");
      writeFileSync(
        modelsPath,
        JSON.stringify({
          active: "p1",
          fallback: ["p2", "p3", "p4"],
          profiles: {
            p1: { review: { neon: "antigravity:shared-model" } },
            // Same kind + same model -> deduped
            p2: { review: { neon: "antigravity:shared-model" } },
            // Different kind (claude) + same bare model name -> kept
            p3: { review: { neon: "shared-model" } },
            // Different antigravity model -> kept
            p4: { review: { neon: "antigravity:other-model" } },
          },
        }),
        "utf8",
      );
      expect(legProfiles("neon", { OB_MODELS_FILE: modelsPath })).toEqual(["p1", "p3", "p4"]);
    });
  });

  test("creditErrorOf recognises agy quota, rate limit, RESOURCE_EXHAUSTED, 429 and non-SUCCESS JSON without loosening non-agy rate limit", () => {
    // Non-zero exit: stderr and stdout tail
    expect(creditErrorOf({ agy: { exitCode: 1, stderr: "Error: RESOURCE_EXHAUSTED: quota exceeded" } })).toMatchObject({ by: "code", match: "resource_exhausted" });
    expect(creditErrorOf({ agy: { exitCode: 1, stderr: "HTTP 429 Too Many Requests" } })).toMatchObject({ by: "text", match: "429" });
    expect(creditErrorOf({ agy: { exitCode: 1, stderr: "request failed: rate limit reached" } })).toMatchObject({ by: "text" });
    expect(creditErrorOf({ agy: { exitCode: 1, stderr: "", stdout: `${"a".repeat(2000)}\nQuota exhausted for model` } })).toMatchObject({ by: "text" });
    // Earlier than last 600 bytes of stdout is ignored
    expect(creditErrorOf({ agy: { exitCode: 1, stderr: "", stdout: `quota exceeded${"a".repeat(700)}` } })).toBeNull();
    // Unrelated error
    expect(creditErrorOf({ agy: { exitCode: 1, stderr: "socket hang up" } })).toBeNull();

    // Non-SUCCESS JSON (even on exit 0)
    expect(
      creditErrorOf({
        agy: {
          exitCode: 0,
          stdout: JSON.stringify({ status: "ERROR", error: "RESOURCE_EXHAUSTED: daily quota hit" }),
        },
      }),
    ).toMatchObject({ by: "code", match: "resource_exhausted" });
    expect(
      creditErrorOf({
        agy: {
          exitCode: 0,
          stdout: JSON.stringify({ status: "FAILED", error: "HTTP 429 rate limited" }),
        },
      }),
    ).toMatchObject({ by: "text" });
    // A payload with no status is a failed attempt (finishAntigravityRun fails it), so its error text is a credit error
    expect(creditErrorOf({ agy: { exitCode: 0, stdout: JSON.stringify({ error: "RESOURCE_EXHAUSTED: quota hit" }) } })).toMatchObject({
      by: "code",
      match: "resource_exhausted",
    });
    // A non-SUCCESS payload whose only quota or 429 text is its partial review (response) is not a credit error
    expect(
      creditErrorOf({
        agy: { exitCode: 0, stdout: JSON.stringify({ status: "FAILED", response: "wrong foo.ts:429, quota handling" }) },
      }),
    ).toBeNull();

    // Successful agy review quoting quota / 429 / RESOURCE_EXHAUSTED in its findings is NEVER a credit error
    expect(
      creditErrorOf({
        agy: {
          exitCode: 0,
          stdout: JSON.stringify({
            status: "SUCCESS",
            response: "wrong apps/foo.ts:10\n  handles HTTP 429 and RESOURCE_EXHAUSTED quota wrong",
          }),
        },
      }),
    ).toBeNull();

    // Non-agy rate limit stays non-credit (OB-1970 invariant)
    expect(creditErrorOf({ code: "rate_limit_error", message: "rate limit exceeded, retry in 30s" })).toBeNull();
    // RESOURCE_EXHAUSTED is an agy-only code: a Gemini 429 on any other provider is not a credit error
    expect(creditErrorOf({ code: "RESOURCE_EXHAUSTED", message: "429 Too Many Requests" })).toBeNull();
    // A non-zero agy exit whose JSON payload is a review quoting "429" or "quota" is not a credit error
    expect(
      creditErrorOf({
        agy: { exitCode: 1, stderr: "", stdout: JSON.stringify({ status: "SUCCESS", response: "wrong foo.ts:429 quota handling" }) },
      }),
    ).toBeNull();
  });

  test("antigravityUsageTokens sums input + cache_read into input and maps output and thinking", () => {
    expect(
      antigravityUsageTokens({
        input_tokens: 18462,
        output_tokens: 2330,
        thinking_tokens: 1579,
        cache_read_tokens: 27314,
        total_tokens: 20792,
      }),
    ).toEqual({ input: 45776, output: 2330, reasoning: 1579 });
    expect(antigravityUsageTokens(null)).toBeNull();
    expect(antigravityUsageTokens({})).toBeNull();
  });

  test("finishAntigravityRun rejects missing or non-SUCCESS status and writes plain response on SUCCESS", () => {
    const written: string[] = [];
    const logs: string[] = [];
    const ok = finishAntigravityRun(
      {
        code: 0,
        out: JSON.stringify({
          status: "SUCCESS",
          response: "ok",
          usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 50 },
        }),
        err: "",
        signal: null,
        timedOut: false,
      },
      { write: (s) => written.push(s) },
      (l) => logs.push(l),
    );
    expect(ok.code).toBe(0);
    expect(written).toEqual(["ok\n"]);
    expect(ok.out).toBe("ok\n");
    expect(ok.tokens).toEqual({ input: 150, output: 20, reasoning: 5 });

    const missingStatus = finishAntigravityRun(
      { code: 0, out: JSON.stringify({ error: "RESOURCE_EXHAUSTED" }), err: "", signal: null, timedOut: false },
      { write: (s) => written.push(s) },
      (l) => logs.push(l),
    );
    expect(missingStatus.code).toBe(1);
    expect(missingStatus.out).toBe("");
    expect(logs.some((l) => l.includes("RESOURCE_EXHAUSTED"))).toBe(true);
  });

  test("end-to-end: fake agy succeeds, emits plain response on stdout, records agy tokens, handles 200 KiB brief, and cleans up temp brief dir", async () => {
    await withScratch((dir) => {
      const binDir = join(dir, "bin");
      const tmpDir = join(dir, "tmp");
      const modelsPath = join(dir, "models.jsonc");
      const capturePath = join(dir, "captured.json");
      mkdirSync(tmpDir, { recursive: true });

      writeFakeAgy(
        binDir,
        `
bun -e '
  const fs = require("node:fs");
  const args = process.argv.slice(2);
  const addDir = args[args.indexOf("--add-dir") + 1];
  const briefText = fs.readFileSync(addDir + "/brief.md", "utf8");
  fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
    args,
    addDir,
    briefLen: Buffer.byteLength(briefText),
    hasMarker: briefText.includes("BIG-BRIEF-E2E-OS130"),
  }));
  process.stdout.write(JSON.stringify({
    conversation_id: "conv-1",
    status: "SUCCESS",
    response: "wrong apps/cli/src/foo.ts:12\\n  off-by-one\\n\\nscore: 5/10",
    num_turns: 2,
    usage: {
      input_tokens: 1200,
      output_tokens: 340,
      thinking_tokens: 85,
      cache_read_tokens: 800,
      total_tokens: 1540
    }
  }));
' -- "$@"
`,
      );

      const bigBrief = `BIG-BRIEF-E2E-OS130\n${"z".repeat(205 * 1024)}\n`;
      const proc = Bun.spawnSync(["bun", REVIEW_LEG_SCRIPT, "neon"], {
        cwd: REPO_ROOT,
        stdin: new Blob([bigBrief]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          TMPDIR: tmpDir,
          OB_MODELS_FILE: modelsPath,
          OB_REVIEW_READERS_SKIP: "1",
          CAPTURE_PATH: capturePath,
        },
      });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      expect(proc.stdout.toString()).toBe("wrong apps/cli/src/foo.ts:12\n  off-by-one\n\nscore: 5/10\n");

      const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
        args: string[];
        addDir: string;
        briefLen: number;
        hasMarker: boolean;
      };
      expect(captured.hasMarker).toBe(true);
      expect(captured.briefLen).toBe(Buffer.byteLength(bigBrief));
      expect(captured.addDir.startsWith(tmpDir)).toBe(true);
      expect(existsSync(captured.addDir)).toBe(false);
      for (const a of captured.args) expect(Buffer.byteLength(a)).toBeLessThan(4096);

      const records = readLegRecords({ OB_MODELS_FILE: modelsPath });
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        leg: "neon",
        kind: "antigravity",
        model: "gemini-4-neon",
        exit_code: 0,
        credit: false,
        tokens: { input: 2000, output: 340, reasoning: 85 },
      });
    });
  });

  test("end-to-end: agy quota failure (stderr non-zero AND exit-0 non-SUCCESS JSON) moves leg to next profile", async () => {
    await withScratch((dir) => {
      const binDir = join(dir, "bin");
      const tmpDir = join(dir, "tmp");
      const modelsPath = join(dir, "models.jsonc");
      const callsFile = join(dir, "calls.log");
      mkdirSync(tmpDir, { recursive: true });

      writeFileSync(
        modelsPath,
        JSON.stringify({
          active: "first",
          fallback: ["second", "third"],
          profiles: {
            first: { review: { neon: "antigravity:gemini-4-neon-a" } },
            second: { review: { neon: "antigravity:gemini-4-neon-b" } },
            third: { review: { neon: "antigravity:gemini-4-neon-c" } },
          },
        }),
        "utf8",
      );

      writeFakeAgy(
        binDir,
        `
bun -e '
  const fs = require("node:fs");
  const args = process.argv.slice(2);
  const model = args[args.indexOf("--model") + 1];
  fs.appendFileSync(process.env.CALLS_FILE, model + "\\n");
  if (model === "gemini-4-neon-a") {
    process.stderr.write("API error 429: RESOURCE_EXHAUSTED\\n");
    process.exit(1);
  }
  if (model === "gemini-4-neon-b") {
    process.stdout.write(JSON.stringify({
      status: "ERROR",
      error: "rate limit exceeded for quota group",
      usage: { input_tokens: 10, output_tokens: 0 }
    }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    status: "SUCCESS",
    response: "ok\\n\\nscore: 9/10",
    usage: { input_tokens: 500, output_tokens: 40, thinking_tokens: 12, cache_read_tokens: 100 }
  }));
' -- "$@"
`,
      );

      const proc = Bun.spawnSync(["bun", REVIEW_LEG_SCRIPT, "neon"], {
        cwd: REPO_ROOT,
        stdin: new Blob(["review this small diff"]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          TMPDIR: tmpDir,
          OB_MODELS_FILE: modelsPath,
          OB_REVIEW_READERS_SKIP: "1",
          CALLS_FILE: callsFile,
        },
      });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      expect(proc.stdout.toString()).toBe("ok\n\nscore: 9/10\n");
      expect(readFileSync(callsFile, "utf8").trim().split("\n")).toEqual([
        "gemini-4-neon-a",
        "gemini-4-neon-b",
        "gemini-4-neon-c",
      ]);

      const records = readLegRecords({ OB_MODELS_FILE: modelsPath });
      expect(records).toHaveLength(3);
      expect(records[0]).toMatchObject({ profile: "first", model: "gemini-4-neon-a", credit: true, exit_code: 1 });
      expect(records[1]).toMatchObject({ profile: "second", model: "gemini-4-neon-b", credit: true, exit_code: 1 });
      expect(records[2]).toMatchObject({
        profile: "third",
        model: "gemini-4-neon-c",
        credit: false,
        exit_code: 0,
        tokens: { input: 600, output: 40, reasoning: 12 },
      });
    });
  });
});

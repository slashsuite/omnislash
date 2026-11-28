import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creditErrorOf, recentCreditHits } from "../../../apps/cli/src/models-credit.ts";
import { antigravityUsageTokens, readLegRecords } from "../../../apps/cli/src/review-legs.ts";
import { defaultReviewReaders, loadReviewReaders, parseReviewReaders, type ConfigIO } from "../../../apps/cli/src/review-readers.ts";
import {
  agyCommandPattern,
  antigravitySettings,
  DENIED_COMMANDS,
  failedLegLine,
  finishAntigravityRun,
  legAttempts,
  legCommand,
  legSpawn,
  READ_COMMANDS,
  resolveLeg,
  runAcrossFallbacks,
  unknownLegMessage,
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

/** The readers `ob review readers --json` would print: the leg reads every model from here (OS-295). */
const READERS = parseReviewReaders(
  JSON.stringify({ readers: { neon: { model: "antigravity:gemini-4-neon" }, opus: { model: "claude-opus-5-5" } }, tiers: [{ from: 1, to: 10, legs: ["opus"] }] }),
);

/** A fake `ob` that prints `readers` for `ob review readers --json`, so a spawned leg reads them as it would live. */
function writeFakeOb(binDir: string, readers: unknown): string {
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "fake-ob");
  writeFileSync(path, `#!/usr/bin/env bash\ncat <<'EOF'\n${JSON.stringify(readers)}\nEOF\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
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
    const resolved = resolveLeg("neon", READERS);
    expect(resolved).toEqual({ kind: "antigravity", model: "gemini-4-neon" });

    const raw = resolveLeg("antigravity:gemini-4-neon-preview");
    expect(raw).toEqual({ kind: "antigravity", model: "gemini-4-neon-preview" });

    const cmd = legCommand("neon", "/tmp/unused-oc", READERS);
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
    // OS-210: Default mode, so a command no allow rule matches is denied in a headless run (Auto mode ran them).
    expect(parsed.agentMode).toBe("");
    expect(parsed.permissions.allow).toEqual(["read_file(*)", ...READ_COMMANDS.map((c) => `command(regex:${agyCommandPattern(c)})`)]);
    expect(parsed.permissions.deny).toContain("write_file(*)");
    for (const c of DENIED_COMMANDS) {
      expect(parsed.permissions.deny).toContain(`command(${c})`);
      expect(parsed.permissions.deny).toContain(`command(${c} *)`);
    }
  });

  test("the allow patterns take a read command with plain arguments and refuse metacharacters and git's --output (OS-210)", () => {
    const allowed = (s: string) => READ_COMMANDS.some((c) => new RegExp(agyCommandPattern(c)).test(s));
    for (const ok of ["ls", "git diff --stat HEAD~1", "git diff origin/main...HEAD -- apps/x.ts", "git show abc:path/x.ts", "git log -5 --format=%h", "grep -n ESCALATE apps/cli/src/review-run.ts", "cat gate.json", "ob show OS-1"]) {
      expect([ok, allowed(ok)]).toEqual([ok, true]);
    }
    for (const bad of ["ls; touch x", "echo $(touch x)", "ls $(touch x)", "cat gate.json | tee x", "ls > x", "ls `touch x`", "cat a\ntouch b",
      "git diff --output=x", "git diff --out=x", 'git diff "--output=x"', "git log --output x", "git diff && touch x", "touch x", "rm -rf x", "bash -c ls"]) {
      expect([bad, allowed(bad)]).toEqual([bad, false]);
    }
  });

  test("200 KiB brief goes into a temp file under $TMPDIR named in a short -p prompt, never on argv", async () => {
    await withScratch((dir) => {
      const customTmp = join(dir, "tmp");
      const marker = "UNIQUE-200K-BRIEF-MARKER-OS130";
      const bigBrief = `${marker}\n${"x".repeat(205 * 1024)}\nEND`;
      expect(Buffer.byteLength(bigBrief)).toBeGreaterThan(200 * 1024);

      const { argv } = legCommand("antigravity:gemini-4-neon", "/tmp/unused");
      const spawn = legSpawn(argv, bigBrief, { TMPDIR: customTmp });
      try {
        expect(spawn.stdin).toBe("");
        expect(spawn.briefDir).toBeDefined();
        expect(spawn.briefDir!.startsWith(customTmp)).toBe(true);

        // No --add-dir: with one, agy's terminal leaves the checkout (OS-210); read_file(*) reads the brief.
        expect(spawn.cmd).not.toContain("--add-dir");

        const promptIdx = spawn.cmd.indexOf("-p");
        expect(promptIdx).toBeGreaterThan(0);
        const prompt = spawn.cmd[promptIdx + 1]!;
        const briefFile = join(spawn.briefDir!, "brief.md");
        expect(prompt).toContain(briefFile);
        expect(Buffer.byteLength(prompt)).toBeLessThan(1024);
        // Neon reached for `git log --oneline` on the OS-261 brief, which the --o ban refuses (OS-286).
        expect(prompt).toContain("--pretty=oneline");
        expect(new RegExp(agyCommandPattern("git log")).test("git log -n 5 --pretty=oneline --abbrev-commit")).toBe(true);
        expect(new RegExp(agyCommandPattern("git log")).test("git log -n 5 --oneline")).toBe(false);

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

  test("default review readers run opus alone with no fallback (OS-256); deepseek and luna are refused when named (OS-206, OS-238)", async () => {
    // OS-299: the one default reader runs on the fixed DEFAULT_TIER_MODELS.complex, never a profile's builder.complex route; ob keeps no review model table.
    const defaults = defaultReviewReaders();
    expect(defaults.readers).toEqual({ opus: { model: "claude-opus-5-5" } });
    expect(defaults.tiers.map((r) => r.legs)).toEqual([["opus"], ["opus"], ["opus"]]);
    expect(defaults.readers.opus!.fallback).toBeUndefined();

    const emptyIO: ConfigIO = { get: async () => null, set: async () => {} };
    const loaded = await loadReviewReaders(emptyIO);
    expect(loaded.stored).toBe(false);
    expect(Object.keys(loaded.value.readers)).toEqual(["opus"]);

    // deepseek and luna are retired: naming either as a leg, or a model id that names one, is refused with a clear message.
    expect(() => legCommand("deepseek", "/tmp/oc")).toThrow(/retired \(OS-206\)/);
    expect(() => legCommand("luna", "/tmp/oc")).toThrow(/retired \(OS-206\)/);
    expect(() => legCommand("opencode-go/gpt-6-luna#high", "/tmp/oc")).toThrow(/retired/);
    expect(() => legCommand("opencode-go/deepseek-v4.1-flash#high", "/tmp/oc")).toThrow(/retired/);

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
      expect(q.stdout.toString().trim().split("\n")).toEqual(["opus"]);

      const j = Bun.spawnSync(["bun", CLI_ENTRY, "review", "readers", "--json"], { env, stdout: "pipe", stderr: "pipe" });
      expect(j.exitCode).toBe(0);
      const parsed = JSON.parse(j.stdout.toString()) as { stored: boolean; profile: string | null; readers: Record<string, { model: string }>; tiers: Array<{ from: number; to: number; legs: string[] }> };
      expect(parsed.stored).toBe(false);
      expect(Object.keys(parsed.readers)).toEqual(["opus"]);
      expect(parsed.profile).toBeNull();
      expect(parsed.tiers.at(-1)).toEqual({ from: 7, to: 10, legs: ["opus"] });
    });
  });

  test("OS-295: a bare id any route prints runs as its own model; a reader name runs on its route's model, else it errors naming the route", () => {
    // `ob models get job.ux-hill-climb-first` prints a bare id: it runs on claude, on that model, with no reader named.
    expect(resolveLeg("claude-opus-5-5")).toEqual({ kind: "claude", model: "claude-opus-5-5" });
    expect(legCommand("claude-opus-5-5", "/tmp/oc").argv.slice(0, 4)).toEqual(["claude", "-p", "--model", "claude-opus-5-5"]);
    expect(resolveLeg("antigravity:gemini-4-neon")).toEqual({ kind: "antigravity", model: "gemini-4-neon" });
    expect(legCommand("antigravity:gemini-4-neon", "/tmp/oc").argv.slice(0, 3)).toEqual(["agy", "--model", "gemini-4-neon"]);
    expect(resolveLeg("opencode-go/glm-5#high")).toEqual({ kind: "opencode", model: "opencode-go/glm-5#high" });
    expect(resolveLeg("claudeAgent:claude-sonnet-5-5")).toEqual({ kind: "claude", model: "claude-sonnet-5-5" });
    // The leg runs on whatever the reader's route says, not on a name it knows.
    const moved = parseReviewReaders(JSON.stringify({ readers: { opus: { model: "antigravity:gemini-5" } }, tiers: [{ from: 1, to: 10, legs: ["opus"] }] }));
    expect(resolveLeg("opus", moved)).toEqual({ kind: "antigravity", model: "gemini-5" });
    expect(resolveLeg("sonnet", moved)).toEqual({ kind: "antigravity", model: "gemini-5" });
    // No model nickname is a default: with no readers, `opus` and `neon` are unknown, and the error names the route.
    expect(resolveLeg("opus")).toBeUndefined();
    expect(() => legCommand("opus", "/tmp/oc")).toThrow(/`ob review readers` names no readers, so there is no reader 'opus'/);
    expect(() => legCommand("glm", "/tmp/oc", READERS)).toThrow(/`ob review readers` has no reader 'glm' \(its readers: neon, opus\)/);
    expect(unknownLegMessage("glm", READERS)).toContain("ob review readers set glm --model <id>");
  });

  test("OS-295: a leg moves along its route's fallback chain only, deduped by (kind, model), stopping at a loop", () => {
    // By default no reader has a fallback: opus gets one attempt and nothing stands in for it (OS-256).
    expect(legAttempts("opus", READERS)).toEqual(["opus"]);
    expect(legAttempts("claude-opus-5-5", READERS)).toEqual(["claude-opus-5-5"]);
    const chain = parseReviewReaders(
      JSON.stringify({
        readers: {
          a: { model: "antigravity:shared", fallback: "b" },
          // Same kind + same model as a: skipped
          b: { model: "antigravity:shared", fallback: "c" },
          // Same bare name on another kind: kept
          c: { model: "shared", fallback: "d" },
          // Loops back to a: the walk stops
          d: { model: "antigravity:other", fallback: "a" },
        },
        tiers: [{ from: 1, to: 10, legs: ["a"] }],
      }),
    );
    expect(legAttempts("a", chain)).toEqual(["a", "c", "d"]);
    expect(legAttempts("d", chain)).toEqual(["d", "a", "c"]);
    // `ob review run` (OB_REVIEW_NO_FALLBACK=1): one attempt, no reader stands in (OS-247).
    expect(legAttempts("a", chain, true)).toEqual(["a"]);
  });

  test("OS-295: a model id on a provider no leg runs is refused by name, never sent to claude", () => {
    expect(resolveLeg("codex:gpt-6")).toBeUndefined();
    expect(() => legCommand("codex:gpt-6", "/tmp/oc")).toThrow(/^model 'codex:gpt-6' is on provider 'codex'\. No review leg runs that provider\. /);
    const codex = parseReviewReaders(JSON.stringify({ readers: { opus: { model: "codex:gpt-6" } }, tiers: [{ from: 1, to: 10, legs: ["opus"] }] }));
    expect(() => legCommand("opus", "/tmp/oc", codex)).toThrow(/reader 'opus' in `ob review readers` has model 'codex:gpt-6'\. That model is on provider 'codex'\. No review leg runs that provider\. /);
    expect(resolveLeg("claude:claude-opus-5-5")).toEqual({ kind: "claude", model: "claude-opus-5-5" });
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

  test("a refused command (SUCCESS, empty response, denied_actions) is a failed leg that keeps its tokens (OS-210)", () => {
    const written: string[] = [];
    const logs: string[] = [];
    // The payload agy returned live when the reader tried `ls; touch x` under the read-only settings.
    const out = JSON.stringify({
      conversation_id: "303133a3",
      status: "SUCCESS",
      response: "",
      num_turns: 1,
      usage: { input_tokens: 11134, output_tokens: 813, thinking_tokens: 691, cache_read_tokens: 0 },
      denied_actions: [{ action: "command", display_name: "Bash" }],
    });
    const err = 'jetski: no output produced: a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.';
    const r = finishAntigravityRun({ code: 0, out, err, signal: null, timedOut: false }, { write: (s) => written.push(s) }, (l) => logs.push(l));
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(written).toEqual([]);
    // Every field agy gave for each denied action is on the failed line (OS-286), not just the count.
    expect(r.err.split("\n")[0]).toBe('agy refused 1 action(s) outside the read-only allow list and returned no findings (conversation 303133a3): {"action":"command","display_name":"Bash"}');
    expect(failedLegLine("neon", r.code, r.err)).toContain('{"action":"command","display_name":"Bash"}');
    expect(r.tokens).toEqual({ input: 11134, output: 813, reasoning: 691 });
    expect(logs.some((l) => l.includes("refused 1 action"))).toBe(true);
    const empty = finishAntigravityRun({ code: 0, out: JSON.stringify({ status: "SUCCESS", response: " " }), err: "", signal: null, timedOut: false }, { write: () => {} }, () => {});
    expect([empty.code, empty.err]).toEqual([1, "agy returned an empty response"]);
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
  const briefPath = args[args.indexOf("-p") + 1].match(/Read (\\S+brief\\.md)/)[1];
  const addDir = require("node:path").dirname(briefPath);
  const briefText = fs.readFileSync(briefPath, "utf8");
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

      const fakeOb = writeFakeOb(binDir, { stored: true, ...READERS });
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
          OB_REVIEW_READERS_SKIP: "",
          OB_REVIEW_OB: fakeOb,
          CAPTURE_PATH: capturePath,
        },
      });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
      expect(proc.stdout.toString()).toBe("wrong apps/cli/src/foo.ts:12\n  off-by-one\n\nscore: 5/10\n");
      expect(proc.stderr.toString()).toContain("review-leg: neon runs antigravity:gemini-4-neon (review readers)");

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

  test("end-to-end: agy quota failure (stderr non-zero AND exit-0 non-SUCCESS JSON) moves the leg to its route's fallback reader", async () => {
    await withScratch((dir) => {
      const binDir = join(dir, "bin");
      const tmpDir = join(dir, "tmp");
      const modelsPath = join(dir, "models.jsonc");
      const callsFile = join(dir, "calls.log");
      mkdirSync(tmpDir, { recursive: true });

      const fakeOb = writeFakeOb(binDir, {
        stored: true,
        profile: "work",
        readers: {
          neon: { model: "antigravity:gemini-4-neon-a", fallback: "second" },
          second: { model: "antigravity:gemini-4-neon-b", fallback: "third" },
          third: { model: "antigravity:gemini-4-neon-c" },
        },
        tiers: [{ from: 1, to: 10, legs: ["neon"] }],
      });

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
          OB_REVIEW_READERS_SKIP: "",
          OB_REVIEW_OB: fakeOb,
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
      expect(records[0]).toMatchObject({ leg: "neon", profile: null, model: "gemini-4-neon-a", credit: true, exit_code: 1 });
      expect(records[1]).toMatchObject({ leg: "neon", profile: "second", model: "gemini-4-neon-b", credit: true, exit_code: 1 });
      expect(records[2]).toMatchObject({
        leg: "neon",
        profile: "third",
        model: "gemini-4-neon-c",
        credit: false,
        exit_code: 0,
        tokens: { input: 600, output: 40, reasoning: 12 },
      });
      // OS-299: a leg run by hand records its credit hit on the readers' profile again, for `ob models list`.
      expect(Object.keys(recentCreditHits(new Date(), { OB_MODELS_FILE: modelsPath }))).toEqual(["work"]);
    });
  });

  test("OS-299: a model id that runs out of credit, or a reader with no profile, records no credit hit; a hit that cannot be written is logged", async () => {
    const credit = { code: 1, out: "", err: "Your credit balance is too low to access the API" };
    const ok = { code: 0, out: "score: 9/10", err: "" };
    const run = async (a: string) => (a === "opus" || a === "claude-sonnet-5-5" ? credit : ok);
    const at = new Date("2026-11-28T01:00:00Z");
    const go = async (attempts: string[], profile: string | null) => {
      const hits: Array<[string, string]> = [];
      const res = await runAcrossFallbacks("opus", attempts, run, () => {}, {}, {
        record: () => {},
        diff: null,
        now: () => at,
        readers: READERS,
        profile,
        creditHit: (p, when) => hits.push([p, when.toISOString()]),
      });
      return { res, hits };
    };

    // The reader's hit on its profile is proven end to end above (the quota chain); these are the cases that record none.
    // A bare model id is no reader of the profile, so its credit error is no hit on it.
    expect((await go(["claude-sonnet-5-5", "neon"], "work")).hits).toEqual([]);

    // With no profile named there is nothing to record against.
    expect((await go(["opus", "neon"], null)).hits).toEqual([]);

    // A hit that cannot be written is one stderr line; the leg goes on to its fallback.
    const lines: string[] = [];
    const res = await runAcrossFallbacks("opus", ["opus", "neon"], run, (l) => lines.push(l), {}, {
      record: () => {},
      diff: null,
      readers: READERS,
      profile: "work",
      creditHit: () => {
        throw new Error("disk full");
      },
    });
    expect(res).toEqual({ code: 0, attempt: "neon" });
    expect(lines.some((l) => l.includes("could not record the credit hit on profile work: disk full"))).toBe(true);
  });

});

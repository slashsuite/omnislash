#!/usr/bin/env bun
// Run ONE skeptical-review leg under a read-only tool profile.
//
//   bun review-leg.ts <neon|opus|<a reader from `ob review readers`>|antigravity:<model>|opencode/<model>[#variant]> < brief.md   (`sonnet` is an alias of `opus`)
//
// The brief arrives on stdin; the reader's findings go to stdout. Readers used to be read-only by
// instruction only: in one review a reader leg shell-executed `ob spinoff cleanup` through an
// unescaped backtick, and in another a reader left edits in six files. `delegate_task` cannot pick a
// tool profile (T3 runs every OpenCode child on the `build` agent with a session-wide allow in
// full-access, and gives a Claude child no tool list), so the legs launch here instead:
//   - Antigravity legs (`antigravity:<model>`, default `neon`) run `agy --sandbox --output-format json`
//     with `--settings` allowing only read-only tools/commands and denying writes, reading the brief
//     from a temp file under `$TMPDIR` via `--add-dir` + a short `-p` prompt, printing `response` as
//     plain text and recording `usage` tokens.
//   - OpenCode legs run the `ob-reviewer` agent (ob-reviewer.md beside this file): every tool denied
//     but read/grep/glob and a read-only shell allowlist, with shell metacharacters denied.
//   - The Opus leg (once `sonnet`) runs `claude -p --restricted` (no user/project settings, no MCP) in `dontAsk`
//     mode with only Read/Grep/Glob/Bash, Bash narrowed to the same allowlist.

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REVIEW_MODELS, activeProfile, canonicalLeg, reviewModelFor, loadModelsFile, retiredReviewMessage, splitTierModel, type ModelsFile } from "../../apps/cli/src/models-file.ts";
import { creditErrorOf, parseAntigravityJson, profileOrder, recordCreditHit } from "../../apps/cli/src/models-credit.ts";
import { parseReviewReaders, type ReviewReaders } from "../../apps/cli/src/review-readers.ts";
import {
  antigravityUsageTokens,
  appendLegRecord,
  claudeSessionTokens,
  diffSize,
  variantOf,
  type DiffSize,
  type LegKind,
  type LegRecord,
  type LegTokens,
} from "../../apps/cli/src/review-legs.ts";

/** The read-only shell commands a reader may run (prefixes; arguments allowed). */
export const READ_COMMANDS = [
  "git log",
  "git show",
  "git diff",
  "git status",
  "git blame",
  "git rev-parse",
  "git merge-base",
  "git ls-files",
  "cat",
  "grep",
  "ls",
  "head",
  "tail",
  "wc",
  "ob show",
  "ob status",
] as const;

/** Mutating commands named outright, on top of everything outside READ_COMMANDS being denied. */
export const DENIED_COMMANDS = [
  "ob spinoff",
  "ob close",
  "ob lease",
  "ob agent",
  "ob deploy",
  "ob secret",
  "wt",
  "git commit",
  "git checkout",
  "git reset",
  "git worktree",
  "git branch",
  "rm",
] as const;

/**
 * The turn cap on a leg: the claude leg's `--max-turns`, and the `steps:` in ob-reviewer.md's
 * frontmatter for the OpenCode legs (keep the two equal). A normal review fits well inside it;
 * a reader wandering the filesystem (101 calls on one PR) does not.
 */
export const MAX_TURNS = 40;

/** A leg's wall-clock limit per attempt, in seconds: OB_REVIEW_LEG_TIMEOUT_S overrides it. */
export const DEFAULT_LEG_TIMEOUT_S = 900;
/** How long a timed-out child gets between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 10_000;
/** The exit code of a leg that ran out of time: `timeout(1)`'s. */
export const TIMEOUT_EXIT = 124;

/** The longest timeout setTimeout can hold (2^31 - 1 ms); a larger delay would fire at once. */
const MAX_TIMEOUT_S = 2_147_483;

/**
 * The per-attempt timeout in seconds: OB_REVIEW_LEG_TIMEOUT_S when it is a positive number (capped at what a
 * timer can hold), else the default.
 */
export function legTimeoutS(env: Record<string, string | undefined> = process.env): number {
  const raw = env.OB_REVIEW_LEG_TIMEOUT_S?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_TIMEOUT_S) : DEFAULT_LEG_TIMEOUT_S;
}

export const PROFILE_PATH = join(import.meta.dir, "ob-reviewer.md");
export const AGENT = "ob-reviewer";

/**
 * The named legs. A Claude leg runs at the model's default effort: no `--effort` flag at all
 * (Opus at its default, higher only on the owner's explicit ask).
 */
type LegSpec = { kind: LegKind; model: string };

export const LEGS = {
  neon: { kind: "antigravity", model: DEFAULT_REVIEW_MODELS.neon },
  opus: { kind: "claude", model: DEFAULT_REVIEW_MODELS.opus },
} as const satisfies Record<string, LegSpec>;

export type LegCommand = { argv: string[]; env: Record<string, string> };

type ResolvedLeg = LegSpec;

/** An `antigravity:<model>` id runs through `agy` with the prefix stripped before `--model`. */
function isAntigravityModel(model: string): boolean {
  return model.startsWith("antigravity:") && model.slice("antigravity:".length).trim().length > 0;
}

/** An `opencode/` or `opencode-go/` id runs through opencode, anything else through claude. */
function isOpencodeModel(model: string): boolean {
  return model.startsWith("opencode/") || model.startsWith("opencode-go/");
}

function classifyModel(value: string): ResolvedLeg | undefined {
  if (value.startsWith("antigravity:")) {
    const model = value.slice("antigravity:".length).trim();
    return model ? { kind: "antigravity", model } : undefined;
  }
  // A `<provider>:<model>` value (the form builder tiers use) names the model after the colon here.
  const model = splitTierModel(value)?.model ?? value;
  if (!model.trim()) return undefined;
  return { kind: isOpencodeModel(model) ? "opencode" : "claude", model };
}

/** The raw model review_readers gives `leg` (or its old name), when the setting is stored and names it. */
function readerModel(readers: ReviewReaders | null, leg: string): string | undefined {
  if (!readers) return undefined;
  return readers.readers[leg]?.model ?? readers.readers[canonicalLeg(leg)]?.model;
}

/** What runs `ob review readers --json`: exit code and stdout. A seam so tests need no ob. */
export type ReadersRunner = () => { code: number; out: string };

const OB_ENTRY = join(import.meta.dir, "..", "..", "apps", "cli", "src", "index.ts");

function runObReaders(): { code: number; out: string } {
  const r = Bun.spawnSync(["bun", OB_ENTRY, "review", "readers", "--json"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  return { code: r.exitCode ?? 1, out: r.stdout.toString() };
}

/**
 * The stored review_readers setting, read once per leg run through `ob review readers --json`
 * (local store or the API, whichever this machine uses). Null when it is unset (the models file and the
 * built-in table decide, as before) and when it cannot be read: then one stderr line says so and the leg
 * falls back to the models file. OB_REVIEW_READERS_SKIP=1 skips the read (the test preload sets it).
 */
export function loadReaderSetting(
  run: ReadersRunner = runObReaders,
  log: (line: string) => void = (l) => console.error(l),
  env: Record<string, string | undefined> = process.env,
): ReviewReaders | null {
  // The test preload sets this, so a spawned leg in a test never starts an `ob` of its own.
  if (env.OB_REVIEW_READERS_SKIP === "1") return null;
  try {
    const { code, out } = run();
    if (code !== 0) throw new Error(`ob review readers exited ${code}`);
    const parsed = JSON.parse(out) as { stored?: boolean };
    if (!parsed.stored) return null;
    return parseReviewReaders(out);
  } catch (e) {
    log(`review-leg: could not read review_readers (${e instanceof Error ? e.message : String(e)}); using the models file`);
    return null;
  }
}

/**
 * The model and runner for `leg`. A named leg (`neon`, `opus`; `sonnet` is read as `opus`) takes its model from
 * the active profile's `review` map in the machine's models file (`ob models show`), else from LEGS; the kind
 * follows the value, so a profile may move a leg between providers. A raw `antigravity:<model>` or
 * `opencode/<model>` id is its own model. A models file that does not parse throws: no silent fallback to the table.
 * Undefined when `leg` is neither a known leg nor a raw provider id.
 */
export function resolveLeg(
  leg: string,
  env: Record<string, string | undefined> = process.env,
  profile?: string,
  readers: ReviewReaders | null = null,
): ResolvedLeg | undefined {
  // OS-206: a retired reader (deepseek, luna) or a model id naming one is refused, never run.
  const refused = retiredReviewMessage(leg, leg);
  if (refused) throw new Error(refused);
  // A reader the owner set in review_readers (the Reviewers page) wins over the machine's file.
  const fromSetting = readerModel(readers, leg);
  if (fromSetting !== undefined) return classifyModel(fromSetting);
  const known = (LEGS as Record<string, LegSpec>)[canonicalLeg(leg)];
  const file = loadModelsFile(env);
  const fromFile = reviewModelFor((profile !== undefined ? file?.profiles[profile] : activeProfile(file))?.review, leg);
  const value = fromFile ?? known?.model ?? (isOpencodeModel(leg) || isAntigravityModel(leg) ? leg : undefined);
  if (value === undefined) return undefined;
  return classifyModel(value);
}

/**
 * Read-only permissions passed to `agy --settings`: read files and READ_COMMANDS allowed, file writes and
 * DENIED_COMMANDS denied (no `--dangerously-skip-permissions`).
 */
export function antigravitySettings(): { permissions: { allow: string[]; deny: string[] } } {
  return {
    permissions: {
      allow: [
        "read_file(*)",
        ...READ_COMMANDS.flatMap((c) => [`command(${c})`, `command(${c} *)`]),
      ],
      deny: [
        "write_file(*)",
        ...DENIED_COMMANDS.flatMap((c) => [`command(${c})`, `command(${c} *)`]),
        "command(git * --output*)",
        // Shell metacharacters, as ob-reviewer.md denies them. Whether agy's matcher splits compound commands is
        // unverified; these entries cost nothing if it does not.
        "command(*`*)",
        "command(*$(*)",
        "command(*;*)",
        "command(*|*)",
        "command(*&*)",
        "command(*>*)",
        "command(*<*)",
      ],
    },
  };
}

/**
 * The command that runs `leg` read-only. `configDir` is the OpenCode config dir holding the
 * `ob-reviewer` agent; it travels with the launch (OPENCODE_CONFIG_DIR) so the profile applies in
 * any repo under review, not only one whose checkout carries it.
 */
export function legCommand(
  leg: string,
  configDir: string,
  env: Record<string, string | undefined> = process.env,
  profile?: string,
  readers: ReviewReaders | null = null,
): LegCommand {
  const resolved = resolveLeg(leg, env, profile, readers);
  if (resolved === undefined) {
    throw new Error(
      `unknown leg '${leg}': use a reader from \`ob review readers\`, neon, opus (or its old name sonnet), antigravity:<model> or an opencode/<model>[#variant] id`,
    );
  }
  if (resolved.kind === "antigravity") {
    return {
      argv: [
        "agy",
        "--model",
        resolved.model,
        "--sandbox",
        "--output-format",
        "json",
        "--settings",
        JSON.stringify(antigravitySettings()),
      ],
      env: {},
    };
  }
  if (resolved.kind === "claude") {
    return {
      argv: [
        "claude",
        "-p",
        "--model",
        resolved.model,
        "--restricted",
        "--strict-mcp-config",
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--max-turns",
        String(MAX_TURNS),
        "--tools",
        "Read,Grep,Glob,Bash",
        "--allowedTools",
        ...READ_COMMANDS.map((c) => `Bash(${c}:*)`),
        "--disallowedTools",
        "Edit",
        "Write",
        "NotebookEdit",
        ...DENIED_COMMANDS.map((c) => `Bash(${c}:*)`),
        // `git diff --output=<file>` writes; the OpenCode profile denies it by pattern too.
        "Bash(git * --output*)",
      ],
      env: {},
    };
  }
  return {
    // No message argument: `opencode run` reads the brief from stdin, so its size is not capped by
    // the kernel's 128 KiB limit on one argv string (E2BIG), and a brief opening with `---` is never a flag.
    argv: ["opencode", "run", "--standalone", "--agent", AGENT, "-m", resolved.model],
    env: { OPENCODE_CONFIG_DIR: configDir },
  };
}

export interface LegSpawn {
  cmd: string[];
  stdin: string;
  /** Temp dir holding `brief.md` for an antigravity leg; caller removes it after the run. */
  briefDir?: string;
}

/**
 * What to spawn for `brief`:
 * - Claude and OpenCode take the brief on stdin, leaving argv untouched.
 * - Antigravity (`agy`) does not read a prompt from stdin in print mode, so the brief is written to a temp
 *   file under `$TMPDIR` and `agy` gets `--add-dir <dir>` and a short `-p` prompt pointing at that file.
 * In every case the brief never goes in argv, where Linux caps one string at 128 KiB (E2BIG).
 */
export function legSpawn(
  argv: string[],
  brief: string,
  env: Record<string, string | undefined> = process.env,
): LegSpawn {
  if (argv[0] !== "agy") return { cmd: argv, stdin: brief };
  const baseTmp = env.TMPDIR?.trim() || tmpdir();
  mkdirSync(baseTmp, { recursive: true });
  const briefDir = mkdtempSync(join(baseTmp, "ob-review-brief-"));
  const briefPath = join(briefDir, "brief.md");
  writeFileSync(briefPath, brief, "utf8");
  const prompt = `Read ${briefPath} in full and follow every instruction in it. Return only the findings and score requested by the brief.`;
  return {
    cmd: [...argv, "--add-dir", briefDir, "-p", prompt],
    stdin: "",
    briefDir,
  };
}

/**
 * The profiles a leg tries, in order: the active one, then `fallback`, each kept only when it
 * gives the leg a (kind, model) pair not already in the list (the same model on the same provider would hit
 * the same empty balance). `[undefined]` with no models file: the one built-in model.
 */
export function legProfiles(leg: string, env: Record<string, string | undefined> = process.env, readers: ReviewReaders | null = null): Array<string | undefined> {
  // A leg whose model comes from review_readers gets one attempt; there is no other profile to try.
  if (readerModel(readers, leg) !== undefined) return [undefined];
  const file: ModelsFile | null = loadModelsFile(env);
  if (!file) return [undefined];
  const seen = new Set<string>();
  const out: Array<string | undefined> = [];
  for (const profile of profileOrder(file)) {
    const resolved = resolveLeg(leg, env, profile);
    if (resolved === undefined) continue;
    const key = `${resolved.kind}\u0000${resolved.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(profile);
  }
  return out.length > 0 ? out : [undefined];
}

export interface LegRun {
  code: number;
  /** What the run printed. It has already been passed through; these copies are only read for the error. */
  out: string;
  /** Raw stdout before JSON extraction (antigravity legs), kept so credit checks can read JSON status/errors. */
  rawOut?: string;
  err: string;
  /** The signal that ended the child, when one did. */
  signal?: string | null;
  /** Tokens, when the leg's tool left them somewhere readable without changing what it prints. */
  tokens?: LegTokens | null;
  /** The attempt ran past the wall-clock limit and was killed. */
  timedOut?: boolean;
}

/** How much of the end of stdout the turn-cap check reads: the cap's notice is in the reader's last message. */
const CAP_TAIL = 4000;

/**
 * Whether a finished attempt stopped on its turn cap. The claude leg ends `Error: Reached max turns (N)`
 * with exit 1. OpenCode (v2.3.0) at `steps` turns the tools off and tells the model, in a system message, to say
 * "maximum steps for this agent have been reached" in its final answer, then exits 0, so that sentence near the
 * end of stdout is the only mark. Best effort: a model that does not say it reads as a normal finish.
 */
export function capStopOf(kind: LegKind | null, out: string): "steps" | "max-turns" | null {
  const tail = out.slice(-CAP_TAIL);
  if (kind === "claude") return /Error: Reached max turns \(\d+\)/.test(tail) ? "max-turns" : null;
  if (kind === "opencode") return /maximum steps[^\n]{0,40}(?:been )?reached/i.test(tail) ? "steps" : null;
  return null;
}

/** How much of the end of stdout the credit check reads: the error is at the end, a quoted diff is not. */
const STDOUT_TAIL = 600;

/** What a record knows before the attempt ends. */
export type InFlightRecord = Pick<LegRecord, "leg" | "kind" | "model" | "variant" | "profile" | "cwd" | "start" | "diff" | "brief_bytes">;

/**
 * The attempt running now, so a SIGTERM or SIGINT on this script (a caller's timeout) can still write its
 * record (`onLegSignal`). Set before each attempt, cleared once its record is written.
 */
let inFlight: InFlightRecord | null = null;
/** Bytes the in-flight attempt has printed so far, so a signal record carries the partial output's size. */
const inFlightBytes = { out: 0, err: 0 };
/** Count `bytes` printed by the attempt in flight on `stream` (the tee calls it as each chunk passes). */
export function countOutput(stream: "out" | "err", bytes: number): void {
  inFlightBytes[stream] += bytes;
}
/** Test seam: the attempt in flight. */
export function inFlightRecord(): InFlightRecord | null {
  return inFlight;
}

export interface RecordOptions {
  /** Where a record goes (default: one line in review-legs.jsonl beside the models file). */
  record?: (r: LegRecord) => void;
  /** The leg's cwd (default: process.cwd()). */
  cwd?: string;
  /** The diff size (default: `git diff --shortstat origin/main...HEAD` in cwd, read once here). */
  diff?: DiffSize | null;
  /** The brief's size in bytes. */
  briefBytes?: number;
  /** The clock (tests). */
  now?: () => Date;
  /** The stored review_readers setting, so the record names the model the leg ran on. */
  readers?: ReviewReaders | null;
}

/** Write a record, never throwing: a record that cannot be written is one stderr line, the leg goes on. */
function safeRecord(record: (r: LegRecord) => void, r: LegRecord, log: (line: string) => void): void {
  try {
    record(r);
  } catch (e) {
    log(`review-leg: could not write the leg record: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function finish(
  base: InFlightRecord,
  end: Date,
  rest: Pick<LegRecord, "exit_code" | "signal" | "out_bytes" | "err_bytes" | "tokens" | "credit"> & Partial<Pick<LegRecord, "stop">>,
): LegRecord {
  return { v: 1, ...base, end: end.toISOString(), wall_s: Math.max(0, (end.getTime() - Date.parse(base.start)) / 1000), stop: null, ...rest };
}

/**
 * Run a leg on each profile in turn until one does not end on a credit or quota error. Any other
 * failure, or a success, is the result. Each credit hit is recorded. Only stderr and the tail of stdout are
 * read, so a transcript that merely quotes a credit error does not count as one. Every attempt writes one
 * leg record, a thrown spawn included. An attempt that timed out is recorded with
 * `signal: "timeout"`, says so on stderr and returns TIMEOUT_EXIT without trying another profile: the profiles
 * exist for an empty balance, and a leg that used its whole time has had its run.
 */
export async function runAcrossProfiles(
  leg: string,
  profiles: ReadonlyArray<string | undefined>,
  run: (profile: string | undefined) => Promise<LegRun>,
  log: (line: string) => void = (l) => console.error(l),
  env: Record<string, string | undefined> = process.env,
  opts: RecordOptions = {},
): Promise<{ code: number; profile: string | undefined }> {
  const record = opts.record ?? ((r: LegRecord) => appendLegRecord(r, env));
  const now = opts.now ?? (() => new Date());
  const cwd = opts.cwd ?? process.cwd();
  const diff = opts.diff !== undefined ? opts.diff : diffSize(cwd, env);
  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    let resolved: ResolvedLeg | undefined;
    try {
      resolved = resolveLeg(leg, env, profile, opts.readers ?? null);
    } catch {
      resolved = undefined;
    }
    const base: InFlightRecord = {
      leg,
      kind: resolved?.kind ?? null,
      model: resolved?.model ?? null,
      variant: variantOf(resolved?.model),
      profile: profile ?? null,
      cwd,
      start: now().toISOString(),
      diff,
      brief_bytes: opts.briefBytes ?? 0,
    };
    inFlight = base;
    inFlightBytes.out = 0;
    inFlightBytes.err = 0;
    let result: LegRun;
    try {
      result = await run(profile);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      safeRecord(record, finish(base, now(), { exit_code: null, signal: `spawn-error: ${message}`, out_bytes: 0, err_bytes: 0, tokens: null, credit: false }), log);
      inFlight = null;
      throw e;
    }
    if (result.timedOut) {
      safeRecord(
        record,
        finish(base, now(), {
          exit_code: null,
          signal: "timeout",
          out_bytes: Buffer.byteLength(result.out),
          err_bytes: Buffer.byteLength(result.err),
          tokens: result.tokens ?? null,
          credit: false,
        }),
        log,
      );
      inFlight = null;
      // agy prints its JSON only when it finishes, so a killed agy attempt has no partial text to point at.
      const partial = base.kind === "antigravity" ? "no partial output (agy prints only when it finishes)" : "partial output above";
      log(`review-leg: ${leg} timed out after ${legTimeoutS(env)}s; ${partial}`);
      return { code: TIMEOUT_EXIT, profile };
    }
    const stop = capStopOf(base.kind, `${result.err}\n${result.out}`);
    if (stop) log(`review-leg: ${leg} stopped at its turn cap (${stop === "steps" ? "steps" : "--max-turns"} ${MAX_TURNS}); its findings may be incomplete`);
    const credit =
      base.kind === "antigravity"
        ? creditErrorOf({ agy: { exitCode: result.code, stderr: result.err, stdout: result.rawOut ?? result.out } })
        : result.code !== 0
          ? creditErrorOf({ message: `${result.err}\n${result.out.slice(-STDOUT_TAIL)}` })
          : null;
    safeRecord(
      record,
      finish(base, now(), {
        exit_code: result.code,
        signal: result.signal ?? null,
        out_bytes: Buffer.byteLength(result.out),
        err_bytes: Buffer.byteLength(result.err),
        tokens: result.tokens ?? null,
        credit: credit !== null,
        stop,
      }),
      log,
    );
    inFlight = null;
    if (!credit) return { code: result.code, profile };
    if (profile !== undefined) recordCreditHit(profile, new Date(), env);
    const next = profiles[i + 1];
    if (next !== undefined) {
      log(`review-leg: ${leg}: ${profile ?? "built-in model"} out of credits (${credit.match}), retrying on ${next}`);
      continue;
    }
    log(`review-leg: ${leg}: out of credits on every profile tried (${profiles.filter((p) => p !== undefined).join(", ") || "built-in model"})`);
    return { code: result.code || 1, profile };
  }
  throw new Error(`review-leg: ${leg}: no profile to run on`);
}

const SIGNAL_NUMBERS = { SIGINT: 2, SIGTERM: 15 } as const;

/**
 * This script got `signal` (a caller's timeout): write the in-flight attempt's record with that signal and
 * return the exit code to leave with, 128 plus the signal number.
 */
export function onLegSignal(
  signal: keyof typeof SIGNAL_NUMBERS,
  record: (r: LegRecord) => void = (r) => appendLegRecord(r),
  log: (line: string) => void = (l) => console.error(l),
  now: Date = new Date(),
): number {
  const base = inFlight;
  if (base) {
    safeRecord(record, finish(base, now, { exit_code: null, signal, out_bytes: inFlightBytes.out, err_bytes: inFlightBytes.err, tokens: null, credit: false }), log);
    inFlight = null;
  }
  return 128 + SIGNAL_NUMBERS[signal];
}

/**
 * Pass a stream through to `to` as it arrives (when `to` is non-null), and return all of it. A killed leg
 * keeps its partial output. `sink.text` holds what has passed so far, so a caller that stops waiting (a
 * timed-out leg whose grandchild still holds the pipe) can still read it.
 */
async function tee(
  stream: ReadableStream<Uint8Array>,
  to: NodeJS.WriteStream | null,
  which: "out" | "err",
  sink: { text: string } = { text: "" },
): Promise<string> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    if (to) {
      to.write(chunk);
      countOutput(which, chunk.byteLength);
    }
    sink.text += decoder.decode(chunk, { stream: true });
  }
  sink.text += decoder.decode();
  return sink.text;
}

/** After a timed-out child exits, how long its streams get to drain before the leg stops waiting on them. */
const DRAIN_MS = 2_000;

/**
 * Spawn one attempt, stream its output through (unless `passThroughStdout` is false, as for `agy` JSON
 * output), and kill it once `timeoutS` has passed: SIGTERM, then SIGKILL after `graceMs` if it is still
 * alive. The output printed before the kill stays printed and is returned.
 */
export async function spawnLeg(
  cmd: string[],
  stdin: string,
  opts: {
    env?: Record<string, string | undefined>;
    timeoutS: number;
    graceMs?: number;
    onChild?: (child: { kill: (signal?: number | NodeJS.Signals) => void } | null) => void;
    passThroughStdout?: boolean;
  },
): Promise<LegRun> {
  const proc = Bun.spawn(cmd, { env: opts.env, stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  opts.onChild?.(proc);
  let timedOut = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    // A child that already exited (its output still draining) finished inside its time: not a timeout.
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    timedOut = true;
    proc.kill("SIGTERM");
    killer = setTimeout(() => proc.kill("SIGKILL"), opts.graceMs ?? KILL_GRACE_MS);
  }, opts.timeoutS * 1000);
  const out = { text: "" };
  const err = { text: "" };
  const streams = Promise.all([
    tee(proc.stdout, opts.passThroughStdout === false ? null : process.stdout, "out", out),
    tee(proc.stderr, process.stderr, "err", err),
  ]);
  try {
    const code = await proc.exited;
    // A killed child's grandchild can keep the pipe open; a timed-out leg does not wait on it past DRAIN_MS.
    if (timedOut) await Promise.race([streams, new Promise((r) => setTimeout(r, DRAIN_MS))]);
    else await streams;
    return { code, out: out.text, err: err.text, signal: proc.signalCode == null ? null : String(proc.signalCode), timedOut };
  } finally {
    clearTimeout(timer);
    clearTimeout(killer);
    opts.onChild?.(null);
  }
}

/**
 * Post-process an `agy --output-format json` attempt: parse the JSON payload, extract `usage` tokens,
 * promote a non-`SUCCESS` status to a non-zero exit so credit checks and callers see the failure, and write
 * `response` as plain text to `stdout` on success.
 */
export function finishAntigravityRun(
  run: LegRun,
  stdout: { write: (s: string) => unknown } = process.stdout,
  log: (line: string) => void = (l) => console.error(l),
): LegRun {
  if (run.timedOut) return { ...run, rawOut: run.out, tokens: null };
  const parsed = parseAntigravityJson(run.out);
  const tokens = parsed ? antigravityUsageTokens(parsed.usage) : null;
  if (!parsed) {
    if (run.code === 0) {
      log("review-leg: agy exited 0 without JSON output");
      return { ...run, code: 1, err: run.err.trim() ? run.err : "agy exited 0 without JSON output", rawOut: run.out, tokens: null };
    }
    return { ...run, rawOut: run.out, tokens: null };
  }
  const status = typeof parsed.status === "string" ? parsed.status : null;
  if (status !== "SUCCESS") {
    const code = run.code === 0 ? 1 : run.code;
    const detail = [parsed.error, parsed.message, parsed.response].find((v): v is string => typeof v === "string" && v.trim().length > 0);
    const reason = detail ? `agy status ${status ?? "missing"}: ${detail.trim()}` : `agy exited ${run.code} with status ${status ?? "missing"}`;
    if (detail) log(`review-leg: ${reason}`);
    else if (run.code === 0) log(`review-leg: ${reason}`);
    // The failed line copies the child's stderr; an agy that put its reason in the JSON gets it there (OS-182).
    return { ...run, code, err: run.err.trim() ? run.err : reason, out: "", rawOut: run.out, tokens };
  }
  const response = typeof parsed.response === "string" ? parsed.response : "";
  const text = response.length > 0 && !response.endsWith("\n") ? `${response}\n` : response;
  if (run.code === 0 && text.length > 0) {
    stdout.write(text);
    countOutput("out", Buffer.byteLength(text));
  }
  // Only a leg that exited 0 prints its text, so only then does `out` carry it (out_bytes matches what was printed).
  return { ...run, out: run.code === 0 ? text : "", rawOut: run.out, tokens };
}

/**
 * The one stderr line a failed leg ends on (OS-182), for the review line to copy:
 * `review-leg: <leg> failed: exit <n>: <first line of the child stderr>`. A child that printed nothing on
 * stderr gets `no stderr`, and a child killed for time says `timed out` whatever it printed before.
 */
export function failedLegLine(leg: string, code: number, childErr: string, timedOut = false): string {
  if (timedOut) return `review-leg: ${leg} failed: exit ${code}: timed out`;
  const first = childErr.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return `review-leg: ${leg} failed: exit ${code}: ${first ?? "no stderr"}`;
}

/** A throwaway OpenCode config dir holding only the reviewer agent. */
export function reviewerConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-reviewer-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "agents", `${AGENT}.md`), readFileSync(PROFILE_PATH, "utf8"));
  return dir;
}

if (import.meta.main) {
  const leg = process.argv[2];
  if (!leg) {
    console.error("usage: bun review-leg.ts <neon|opus|<a reader from `ob review readers`>|antigravity:<model>|opencode/<model>[#variant]> < brief.md");
    process.exit(2);
  }
  // The readers the owner chose (review_readers), read once for this leg.
  const readers = loadReaderSetting();
  const fromSetting = readerModel(readers, leg);
  if (fromSetting !== undefined) console.error(`review-leg: ${leg} runs ${fromSetting} (review_readers)`);
  const brief = await Bun.stdin.text();
  if (brief.trim() === "") {
    console.error("review-leg: empty brief on stdin");
    process.exit(2);
  }
  const configDir = reviewerConfigDir();
  // A caller's timeout still leaves a record of the attempt it cut short, and the child goes with it.
  let child: { kill: (signal?: number | NodeJS.Signals) => void } | null = null;
  let briefDir: string | null = null;
  const cleanup = () => {
    rmSync(configDir, { recursive: true, force: true });
    if (briefDir) {
      rmSync(briefDir, { recursive: true, force: true });
      briefDir = null;
    }
  };
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      const code = onLegSignal(sig);
      child?.kill(sig);
      cleanup();
      process.exit(code);
    });
  }
  // The last attempt's run, so a failed leg can name its child's first stderr line.
  let last: LegRun | null = null;
  // A leg that fails on a credit or quota error retries on the next profile's model for that leg.
  // Output streams through as it comes (or `response` is printed from `agy` JSON) and a copy is kept so the error can be read.
  let result: { code: number };
  try {
    result = await runAcrossProfiles(
      leg,
      legProfiles(leg, process.env, readers),
      async (profile) => {
        const { argv, env } = legCommand(leg, configDir, process.env, profile, readers);
        const isAgy = argv[0] === "agy";
        // A fixed session id lets the Claude leg's token use be read from its transcript afterwards,
        // without changing what it prints. Antigravity returns usage in its JSON payload; standalone
        // OpenCode leaves no usage on disk, so its tokens stay null.
        const sessionId = argv[0] === "claude" ? crypto.randomUUID() : null;
        const spawn = legSpawn(sessionId ? [...argv, "--session-id", sessionId] : argv, brief, process.env);
        briefDir = spawn.briefDir ?? null;
        try {
          // Each attempt has a wall-clock limit, so a wandering leg ends instead of running until killed.
          const run = await spawnLeg(spawn.cmd, spawn.stdin, {
            env: { ...process.env, ...env },
            timeoutS: legTimeoutS(),
            onChild: (c) => (child = c),
            passThroughStdout: !isAgy,
          });
          last = isAgy ? finishAntigravityRun(run) : { ...run, tokens: sessionId ? claudeSessionTokens(sessionId) : null };
          return last;
        } finally {
          if (spawn.briefDir) {
            rmSync(spawn.briefDir, { recursive: true, force: true });
            if (briefDir === spawn.briefDir) briefDir = null;
          }
        }
      },
      undefined,
      process.env,
      { briefBytes: Buffer.byteLength(brief), readers },
    );
  } catch (e) {
    // A spawn that threw (the tool is not installed) is a failed leg too, and says why.
    result = { code: 1 };
    last = { code: 1, out: "", err: e instanceof Error ? e.message : String(e) };
  }
  const code = result.code;
  if (code !== 0) console.error(failedLegLine(leg, code, last?.err ?? "", last?.timedOut ?? false));
  cleanup();
  process.exit(code);
}

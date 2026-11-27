#!/usr/bin/env bun
// Run ONE skeptical-review leg under a read-only tool profile.
//
//   bun review-leg.ts <a reader from `ob review readers`|a model id `ob models get` prints> < brief.md
//
// A reader name runs on the model `ob review readers --json` gives it, and on its fallback reader (the route's
// chain) after a credit or quota error. A model id (claude-*, <provider>:<model>, antigravity:<model>,
// opencode/<model>[#variant]) runs on that model, once. This script names no model of its own (OS-295).
//
// The brief arrives on stdin; the reader's findings go to stdout. Readers used to be read-only by
// instruction only: in one review a reader leg shell-executed `ob spinoff cleanup` through an
// unescaped backtick, and in another a reader left edits in six files. `delegate_task` cannot pick a
// tool profile (T3 runs every OpenCode child on the `build` agent with a session-wide allow in
// full-access, and gives a Claude child no tool list), so the legs launch here instead:
//   - Antigravity legs (`antigravity:<model>`) run `agy --sandbox --output-format json`
//     with `--settings` allowing only read-only tools/commands and denying writes, reading the brief
//     from a temp file under `$TMPDIR` via a short `-p` prompt, printing `response` as
//     plain text and recording `usage` tokens.
//   - OpenCode legs run the `ob-reviewer` agent (ob-reviewer.md beside this file): every tool denied
//     but read/grep/glob and a read-only shell allowlist, with shell metacharacters denied.
//   - Claude legs run `claude -p --restricted` (no user/project settings, no MCP) in `dontAsk`
//     mode with only Read/Grep/Glob/Bash, Bash narrowed to the same allowlist.

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalLeg, retiredReviewMessage, splitTierModel } from "../../apps/cli/src/models-file.ts";
import { creditErrorOf, parseAntigravityJson } from "../../apps/cli/src/models-credit.ts";
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

/** The runner and model a leg resolves to. A Claude leg runs at the model's default effort: no `--effort` flag at all. */
export type ResolvedLeg = { kind: LegKind; model: string };

export type LegCommand = { argv: string[]; env: Record<string, string> };

/** An `opencode/` or `opencode-go/` id runs through opencode. */
function isOpencodeModel(model: string): boolean {
  return model.startsWith("opencode/") || model.startsWith("opencode-go/");
}

/**
 * Whether `value` is a model id rather than a reader name: `antigravity:<model>`, `opencode/<model>`,
 * `opencode-go/<model>`, a bare `claude-*` id, or any `<provider>:<model>` (the form builder routes print).
 * A reader name is lowercase letters, digits and dashes, so it never holds `:` or `/`. Pure.
 */
export function isModelId(value: string): boolean {
  return value.startsWith("claude-") || value.includes(":") || isOpencodeModel(value);
}

/**
 * The runner for a model id: `antigravity:<model>` through agy (the prefix stripped), `opencode/` and
 * `opencode-go/` through opencode, anything else through claude. A `<provider>:<model>` value names the model
 * after the colon. Undefined for an id with an empty half. Pure.
 */
export function classifyModel(value: string): ResolvedLeg | undefined {
  if (value.startsWith("antigravity:")) {
    const model = value.slice("antigravity:".length).trim();
    return model ? { kind: "antigravity", model } : undefined;
  }
  const model = splitTierModel(value.trim())?.model;
  if (!model) return undefined;
  return { kind: isOpencodeModel(model) ? "opencode" : "claude", model };
}

/** The raw model the readers give `leg` (or its old name), when they name it. */
function readerModel(readers: ReviewReaders | null, leg: string): string | undefined {
  if (!readers) return undefined;
  return readers.readers[leg]?.model ?? readers.readers[canonicalLeg(leg)]?.model;
}

/** The reader `leg` falls back to on a credit or quota error (the route's fallback), when one is set. */
function readerFallback(readers: ReviewReaders | null, leg: string): string | undefined {
  if (!readers) return undefined;
  return (readers.readers[leg] ?? readers.readers[canonicalLeg(leg)])?.fallback;
}

/** What runs `ob review readers --json`: exit code and stdout. A seam so tests need no ob. */
export type ReadersRunner = () => { code: number; out: string; err?: string };


// OS-238: the `ob` on PATH, never this checkout's CLI source: run bare, the source has none of the store or API
// settings the `ob` launcher supplies, so the read failed on every run and the leg quietly used built-in models.
// OB_REVIEW_OB overrides the command (tests).
function runObReaders(env: Record<string, string | undefined> = process.env): { code: number; out: string; err: string } {
  const cmd = env.OB_REVIEW_OB ? [env.OB_REVIEW_OB] : ["ob"];
  const r = Bun.spawnSync([...cmd, "review", "readers", "--json"], { stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  return { code: r.exitCode ?? 1, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** The configured readers could not be read: the leg fails by name rather than run a model nobody configured (OS-238). */
export class ReaderSettingError extends Error {}

/**
 * The readers in force, read once per leg run through `ob review readers --json` (the store or the API, whichever
 * this machine uses), stored or ob's own defaults: whatever ob prints is what runs (OS-295). Null when the answer
 * names no readers at all. When it cannot be read it throws ReaderSettingError: the leg fails, it never guesses
 * (OS-238). OB_REVIEW_READERS_SKIP=1 skips the read (the test preload sets it), leaving only model-id legs.
 */
export function loadReaderSetting(
  env: Record<string, string | undefined> = process.env,
  run: ReadersRunner = () => runObReaders(env),
): ReviewReaders | null {
  // The test preload sets this, so a spawned leg in a test never starts an `ob` of its own.
  if (env.OB_REVIEW_READERS_SKIP === "1") return null;
  let result: { code: number; out: string; err?: string };
  try {
    result = run();
  } catch (e) {
    throw new ReaderSettingError(`could not run ob review readers: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (result.code !== 0) {
    const first = (result.err ?? "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("ob: core from"));
    throw new ReaderSettingError(`ob review readers exited ${result.code}${first ? `: ${first}` : ""}`);
  }
  try {
    const parsed = JSON.parse(result.out) as { readers?: unknown };
    if (!parsed.readers || typeof parsed.readers !== "object" || Object.keys(parsed.readers).length === 0) return null;
    return parseReviewReaders(result.out);
  } catch (e) {
    throw new ReaderSettingError(`ob review readers gave an unreadable answer: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The model and runner for `leg`. A reader name (`sonnet` is read as `opus`) runs on the model the readers give
 * it; a model id is its own model. Throws for a retired reader (OS-206). Undefined when `leg` is neither a reader
 * the readers name nor a model id, or its model is malformed: `legCommand` turns that into the error.
 */
export function resolveLeg(leg: string, readers: ReviewReaders | null = null): ResolvedLeg | undefined {
  // OS-206: a retired reader (deepseek, luna) or a model id naming one is refused, never run.
  const fromSetting = readerModel(readers, leg);
  const refused = retiredReviewMessage(leg, fromSetting ?? leg);
  if (refused) throw new Error(refused);
  if (fromSetting !== undefined) return classifyModel(fromSetting);
  return isModelId(leg) ? classifyModel(leg) : undefined;
}

/** Why `leg` resolves to nothing, naming the route it was looked up in (OS-295). Pure. */
export function unknownLegMessage(leg: string, readers: ReviewReaders | null): string {
  const model = readerModel(readers, leg);
  if (model !== undefined) return `reader '${leg}' in \`ob review readers\` has model '${model}', which names no model to run`;
  const names = readers ? Object.keys(readers.readers) : [];
  const route = names.length
    ? `\`ob review readers\` has no reader '${leg}' (its readers: ${names.join(", ")})`
    : `\`ob review readers\` names no readers, so there is no reader '${leg}'`;
  return `${route}: set one with \`ob review readers set ${leg} --model <id>\`, or pass a model id \`ob models get\` prints (claude-*, antigravity:<model>, opencode/<model>)`;
}

/**
 * The legs a run tries, in order: `leg` itself, then its fallback reader, that reader's fallback and on (the
 * route's chain, `ob review readers fallback`), each kept only when it gives a (kind, model) not already in the
 * list (the same model on the same provider would hit the same empty balance), stopping at a loop. A leg with no
 * fallback, which is every reader by default, gets one attempt: nothing stands in for it unless its route says so
 * (OS-256, OS-295). A model id gets one attempt.
 */
export function legAttempts(leg: string, readers: ReviewReaders | null = null): string[] {
  const out = [leg];
  const seen = new Set<string>();
  const first = resolveLeg(leg, readers);
  if (first) seen.add(`${first.kind}\u0000${first.model}`);
  const visited = new Set([canonicalLeg(leg)]);
  for (let next = readerFallback(readers, leg); next !== undefined && !visited.has(next); next = readerFallback(readers, next)) {
    visited.add(next);
    const resolved = resolveLeg(next, readers);
    if (resolved === undefined) continue;
    const key = `${resolved.kind}\u0000${resolved.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

// Characters no allowed argument may hold: whitespace (so no newline), the shell's control, redirect,
// substitution and escape characters, and brackets.
const AGY_NOT = "\\s;|&<>$`\\\\(){}";
// Any argument of a non-git read command (quotes allowed: with `$` and backtick refused they expand nothing).
const AGY_ARG = `[^${AGY_NOT}]+`;
// A git argument: no quotes (a quoted "--output=x" would hide the flag), and no `--o...` long flag, since git
// takes any unique prefix of `--output` (`--out=x`) and `--output` writes a file. `--oneline` goes with it.
const AGY_GIT_NOT = `${AGY_NOT}'"`;
const AGY_GIT_ARG = `(?:[^-${AGY_GIT_NOT}][^${AGY_GIT_NOT}]*|-[^-o${AGY_GIT_NOT}][^${AGY_GIT_NOT}]*|--[^o${AGY_GIT_NOT}][^${AGY_GIT_NOT}]*|--)`;

/** The anchored RE2 an allowed read command must match whole: the command, then plain arguments. */
export function agyCommandPattern(command: string): string {
  const arg = command.startsWith("git ") ? AGY_GIT_ARG : AGY_ARG;
  return `^${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: +${arg})*$`;
}

/**
 * Read-only settings passed to `agy --settings` (OS-210, proven live). Two things hold, and only these:
 * - `agentMode: ""` (Default mode). Headless `-p` runs otherwise start in Auto mode, which ran `ls; touch x`,
 *   `$(...)`, a pipe into `tee` and a `>` redirect inside `--sandbox` without asking. In Default mode a
 *   command no allow rule matches needs approval, which a headless run cannot give, so agy denies it and ends
 *   the turn with no output: the leg fails closed (exit 1, no findings) rather than writing.
 * - The allow list: `read_file(*)` and one anchored `command(regex:...)` per READ_COMMANDS entry, whose
 *   arguments hold no shell metacharacter and, for git, no `--o...` flag. A command deny rule does NOT override
 *   a matching allow rule (`git diff --output=x` ran past `command(*--output*)`), so the allow list is what
 *   keeps writes out; the deny entries below only name the mutating commands outright.
 * `write_file(*)` is denied, which agy reports to the model as a tool error.
 */
export function antigravitySettings(): { agentMode: string; permissions: { allow: string[]; deny: string[] } } {
  return {
    agentMode: "",
    permissions: {
      allow: ["read_file(*)", ...READ_COMMANDS.map((c) => `command(regex:${agyCommandPattern(c)})`)],
      deny: ["write_file(*)", ...DENIED_COMMANDS.flatMap((c) => [`command(${c})`, `command(${c} *)`])],
    },
  };
}

/**
 * The command that runs `leg` read-only. `configDir` is the OpenCode config dir holding the
 * `ob-reviewer` agent; it travels with the launch (OPENCODE_CONFIG_DIR) so the profile applies in
 * any repo under review, not only one whose checkout carries it.
 */
export function legCommand(leg: string, configDir: string, readers: ReviewReaders | null = null): LegCommand {
  const resolved = resolveLeg(leg, readers);
  if (resolved === undefined) throw new Error(unknownLegMessage(leg, readers));
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
 *   file under `$TMPDIR` and `agy` gets a short `-p` prompt pointing at that file (its `read_file(*)` allow reads it).
 * In every case the brief never goes in argv, where Linux caps one string at 128 KiB (E2BIG).
 */
export function legSpawn(
  argv: string[],
  brief: string,
  env: Record<string, string | undefined> = process.env,
): LegSpawn {
  const cwd = process.cwd();
  if (argv[0] !== "agy") return { cmd: argv, stdin: brief };
  const baseTmp = env.TMPDIR?.trim() || tmpdir();
  mkdirSync(baseTmp, { recursive: true });
  const briefDir = mkdtempSync(join(baseTmp, "ob-review-brief-"));
  const briefPath = join(briefDir, "brief.md");
  writeFileSync(briefPath, brief, "utf8");
  // No `--add-dir`: with any added dir agy's terminal leaves the checkout and relative paths miss (OS-210's
  // live run); `read_file(*)` reads the brief where it is. The prompt names the read-only commands, since any
  // other command ends the leg with no output.
  const prompt =
    `Read ${briefPath} in full and follow every instruction in it. Return only the findings and score requested by the brief. ` +
    `The checkout under review is ${cwd}; read files with your file-read tool. A shell command may only be one of ` +
    `${READ_COMMANDS.join(", ")}, one per call, with plain arguments: no ; | & > < $ \` ( ) or quotes. A git flag may not ` +
    `start with -o or --o, so write git log --pretty=oneline --abbrev-commit, never --oneline. Any other command is refused ` +
    `and ends your review with no output.`;
  return {
    cmd: [...argv, "-p", prompt],
    stdin: "",
    briefDir,
  };
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
export type InFlightRecord = Pick<LegRecord, "leg" | "kind" | "model" | "variant" | "profile" | "cwd" | "start" | "diff" | "brief_bytes" | "run" | "seat">;

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
 * Run a leg on each attempt in turn (`legAttempts`: the leg, then its route's fallback readers) until one does not
 * end on a credit or quota error. Any other failure, or a success, is the result. Only stderr and the tail of
 * stdout are read, so a transcript that merely quotes a credit error does not count as one. Every attempt writes
 * one leg record, a thrown spawn included; a stand-in attempt names its reader in the record's `profile`. An
 * attempt that timed out is recorded with `signal: "timeout"`, says so on stderr and returns TIMEOUT_EXIT without
 * trying the fallback: the fallback exists for an empty balance, and a leg that used its whole time has had its run.
 */
export async function runAcrossFallbacks(
  leg: string,
  attempts: ReadonlyArray<string>,
  run: (attempt: string) => Promise<LegRun>,
  log: (line: string) => void = (l) => console.error(l),
  env: Record<string, string | undefined> = process.env,
  opts: RecordOptions = {},
): Promise<{ code: number; attempt: string }> {
  const record = opts.record ?? ((r: LegRecord) => appendLegRecord(r, env));
  const now = opts.now ?? (() => new Date());
  const cwd = opts.cwd ?? process.cwd();
  const diff = opts.diff !== undefined ? opts.diff : diffSize(cwd, env);
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    let resolved: ResolvedLeg | undefined;
    try {
      resolved = resolveLeg(attempt, opts.readers ?? null);
    } catch {
      resolved = undefined;
    }
    const base: InFlightRecord = {
      leg,
      kind: resolved?.kind ?? null,
      model: resolved?.model ?? null,
      variant: variantOf(resolved?.model),
      profile: attempt === leg ? null : attempt,
      cwd,
      start: now().toISOString(),
      diff,
      brief_bytes: opts.briefBytes ?? 0,
      // OS-210: `ob review run` reads this leg's tokens back by its run id.
      ...(env.OB_REVIEW_RUN_ID?.trim() ? { run: env.OB_REVIEW_RUN_ID.trim() } : {}),
      // OS-247: a second seat of the same reader (`opus-2`) names itself, so its tokens are read back apart.
      ...(env.OB_REVIEW_SEAT?.trim() && env.OB_REVIEW_SEAT.trim() !== leg ? { seat: env.OB_REVIEW_SEAT.trim() } : {}),
    };
    inFlight = base;
    inFlightBytes.out = 0;
    inFlightBytes.err = 0;
    let result: LegRun;
    try {
      result = await run(attempt);
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
      return { code: TIMEOUT_EXIT, attempt };
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
    if (!credit) return { code: result.code, attempt };
    const next = attempts[i + 1];
    if (next !== undefined) {
      log(`review-leg: ${leg}: ${attempt} out of credits (${credit.match}), retrying on its fallback ${next}`);
      continue;
    }
    log(`review-leg: ${leg}: out of credits on every reader tried (${attempts.join(", ")})`);
    return { code: result.code || 1, attempt };
  }
  throw new Error(`review-leg: ${leg}: nothing to run on`);
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
  const proc = Bun.spawn(cmd, { ...(opts.env && { env: opts.env }), stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
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
  if (run.code === 0 && text.trim().length === 0) {
    // A command outside the allow list ends the headless turn: SUCCESS, an empty response and `denied_actions`
    // (OS-210's live run). That is a failed leg, never a clean one with nothing to say.
    // Name every denied action with all the fields agy gave, so the refused command can be found (OS-286).
    const deniedList: unknown[] = Array.isArray(parsed.denied_actions) ? parsed.denied_actions : [];
    const denied = deniedList.length;
    // agy's JSON names no command; the conversation id finds the refused one in agy's conversation store.
    const conv = typeof parsed.conversation_id === "string" && parsed.conversation_id.trim() ? ` (conversation ${parsed.conversation_id.trim()})` : "";
    const reason = denied > 0
      ? `agy refused ${denied} action(s) outside the read-only allow list and returned no findings${conv}: ${deniedList.map((a) => JSON.stringify(a)).join(" ")}`
      : "agy returned an empty response";
    log(`review-leg: ${reason}`);
    return { ...run, code: 1, err: run.err.trim() ? `${reason}\n${run.err}` : reason, out: "", rawOut: run.out, tokens };
  }
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
    console.error("usage: bun review-leg.ts <a reader from `ob review readers`|a model id `ob models get` prints> < brief.md");
    process.exit(2);
  }
  // The readers the owner chose (review_readers), read once for this leg.
  let readers: ReviewReaders | null;
  try {
    readers = loadReaderSetting();
  } catch (e) {
    console.error(`review-leg: ${leg} failed: exit 1: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const fromSetting = readerModel(readers, leg);
  if (fromSetting !== undefined) console.error(`review-leg: ${leg} runs ${fromSetting} (review readers)`);
  else if (!isModelId(leg)) {
    console.error(`review-leg: ${leg} failed: exit 1: ${unknownLegMessage(leg, readers)}`);
    process.exit(1);
  }
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
  // A leg that fails on a credit or quota error retries on its route's fallback reader, when one is set.
  // Output streams through as it comes (or `response` is printed from `agy` JSON) and a copy is kept so the error can be read.
  let result: { code: number };
  try {
    result = await runAcrossFallbacks(
      leg,
      legAttempts(leg, readers),
      async (attempt) => {
        const { argv, env } = legCommand(attempt, configDir, readers);
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

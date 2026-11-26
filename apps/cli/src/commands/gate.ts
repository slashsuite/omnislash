// OS-210: `ob gate run`, one gate per repo, declared in the repo's `gate.json` and cached by commit.
//
// The gate used to live in three places that drifted: ci.yml's steps, the skill text and whatever a builder
// typed. Now the repo's root `gate.json` lists the steps, `ob gate run` runs them in order, and CI's gate job
// runs the same command, so the local gate and CI cannot disagree.
//
// A run is cached under the git common dir (`ob-gate/`, shared by every worktree of the repo) by the HEAD sha
// plus the hash of gate.json: a second run at the same sha and file hash prints the stored result without
// running anything. A worktree with uncommitted or untracked changes is not the sha, so it is run and never
// cached. Red results are cached too (a red sha stays red); `--force` reruns and stores the new result.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Ctx } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { print } from "../output.ts";

export const GATE_FILE = "gate.json";

export interface GateStep {
  name: string;
  /** A shell command, run with `bash -c` from the repo root. */
  run: string;
  env?: Record<string, string>;
}

export interface GateResult {
  v: 1;
  sha: string;
  file_hash: string;
  ok: boolean;
  /** The step that failed, null on green. */
  failed: string | null;
  steps: Array<{ name: string; code: number; wall_s: number }>;
  start: string;
  end: string;
}

export interface GateOutcome {
  result: GateResult;
  cached: boolean;
  /** Why the result was not read from or written to the cache, when it was not. */
  uncached: string | null;
}

/** Parse gate.json's text: `{ "steps": [{ "name", "run", "env"? }] }`. Throws naming what is wrong. */
export function parseGateFile(text: string): GateStep[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new AppError(`${GATE_FILE} is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const steps = (raw as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps) || steps.length === 0) throw new AppError(`${GATE_FILE} needs a non-empty "steps" list`);
  const names = new Set<string>();
  return steps.map((s, i) => {
    const step = s as Partial<GateStep> | null;
    if (!step || typeof step.name !== "string" || !step.name.trim()) throw new AppError(`${GATE_FILE} step ${i + 1} needs a "name"`);
    if (typeof step.run !== "string" || !step.run.trim()) throw new AppError(`${GATE_FILE} step '${step.name}' needs a "run" command`);
    if (names.has(step.name)) throw new AppError(`${GATE_FILE} names step '${step.name}' twice`);
    names.add(step.name);
    if (step.env !== undefined && (typeof step.env !== "object" || Array.isArray(step.env) || Object.values(step.env).some((v) => typeof v !== "string"))) {
      throw new AppError(`${GATE_FILE} step '${step.name}': "env" must map names to strings`);
    }
    return { name: step.name, run: step.run, ...(step.env ? { env: step.env } : {}) };
  });
}

function git(cwd: string, args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new AppError(`git ${args.join(" ")} failed in ${cwd}: ${p.stderr.toString().trim()}`);
  return p.stdout.toString().trim();
}

/** The cache file for (sha, file hash), under the repo's git common dir. */
export function gateCachePath(root: string, sha: string, fileHash: string): string {
  const common = git(root, ["rev-parse", "--git-common-dir"]);
  const dir = isAbsolute(common) ? common : join(root, common);
  return join(dir, "ob-gate", `${sha}-${fileHash.slice(0, 16)}.json`);
}

export interface RunStep {
  (step: GateStep, root: string): Promise<number>;
}

/** Run one step with `bash -c` from the repo root, output passed through. */
const runStepLive: RunStep = async (step, root) => {
  const proc = Bun.spawn(["bash", "-c", step.run], {
    cwd: root,
    env: { ...process.env, ...step.env },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
};

/**
 * Run the gate of the repo holding `cwd`. Reads the cache unless `force`; writes it unless the worktree is
 * dirty. `log` gets the progress lines (stderr in the command).
 */
export async function runGate(
  cwd: string,
  opts: { force?: boolean; log?: (line: string) => void; runStep?: RunStep; now?: () => Date } = {},
): Promise<GateOutcome> {
  const log = opts.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const now = opts.now ?? (() => new Date());
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  const file = join(root, GATE_FILE);
  if (!existsSync(file)) throw new AppError(`no ${GATE_FILE} at ${root}: this repo declares no gate`);
  const text = readFileSync(file, "utf8");
  const steps = parseGateFile(text);
  const fileHash = createHash("sha256").update(text).digest("hex");
  const sha = git(root, ["rev-parse", "HEAD"]);
  const dirty = git(root, ["status", "--porcelain"]) !== "";
  const uncached = dirty ? "the worktree has uncommitted or untracked changes, so it is not the commit" : null;
  const cachePath = gateCachePath(root, sha, fileHash);
  if (!dirty && !opts.force && existsSync(cachePath)) {
    try {
      const result = JSON.parse(readFileSync(cachePath, "utf8")) as GateResult;
      if (result.sha === sha && result.file_hash === fileHash) return { result, cached: true, uncached: null };
    } catch {
      // a torn cache file: run the gate and overwrite it
    }
  }
  const run = opts.runStep ?? runStepLive;
  const start = now();
  const done: GateResult["steps"] = [];
  let failed: string | null = null;
  for (const step of steps) {
    log(`gate: ${step.name}: ${step.run}`);
    const t0 = now();
    const code = await run(step, root);
    done.push({ name: step.name, code, wall_s: Math.round((now().getTime() - t0.getTime()) / 100) / 10 });
    if (code !== 0) {
      failed = step.name;
      break;
    }
  }
  const result: GateResult = { v: 1, sha, file_hash: fileHash, ok: failed === null, failed, steps: done, start: start.toISOString(), end: now().toISOString() };
  if (!dirty) {
    mkdirSync(join(cachePath, ".."), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(result, null, 2) + "\n");
  }
  return { result, cached: false, uncached };
}

/** The one line a gate outcome prints: `gate green at <sha7> (cached ...)`. */
export function gateLine(o: GateOutcome): string {
  const r = o.result;
  const where = `at ${r.sha.slice(0, 7)} (${GATE_FILE} ${r.file_hash.slice(0, 7)})`;
  const verdict = r.ok ? `gate green ${where}` : `gate red ${where}: step '${r.failed}' exited ${r.steps.at(-1)?.code}`;
  const steps = r.steps.map((s) => `${s.name} ${s.wall_s}s`).join(", ");
  if (o.cached) return `${verdict}; cached from ${r.end} (--force reruns)`;
  return `${verdict}; ${steps}${o.uncached ? `; not cached: ${o.uncached}` : ""}`;
}

export async function cmdGate(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  if (sub !== "run") throw new UsageError("usage: ob gate run [--force] [--json]");
  const outcome = await runGate(process.cwd(), { force: Boolean(ctx.flags.force) });
  if (ctx.mode === "json") print(JSON.stringify({ ...outcome.result, cached: outcome.cached, uncached: outcome.uncached }, null, 2));
  else print(gateLine(outcome));
  if (!outcome.result.ok) ctx.exit = 1;
}

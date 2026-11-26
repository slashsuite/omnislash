// OB-2133: one record per skeptical-review leg attempt, and the trend read `ob models legs` prints.
//
// A leg runs `opencode run --standalone` or `claude -p` from skills/ob-skeptical-review/review-leg.ts, and
// neither tool's own store showed how long a leg took or how big the diff was. Each attempt now appends one
// JSON line to `review-legs.jsonl` beside `models-state.json` (machine-local, like the models file).
//
// Like models-file.ts and models-credit.ts it imports nothing from the rest of ob, so review-leg.ts loads it
// cheaply.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { modelsFilePath } from "./models-file.ts";

type Env = Record<string, string | undefined>;

export interface DiffSize {
  files: number;
  insertions: number;
  deletions: number;
}

export interface LegTokens {
  /** All input tokens, cache reads and writes included. */
  input: number;
  output: number;
  reasoning: number;
}

export type LegKind = "claude" | "opencode" | "antigravity";

export interface LegRecord {
  v: 1;
  leg: string;
  kind: LegKind | null;
  model: string | null;
  variant: string | null;
  profile: string | null;
  cwd: string;
  start: string;
  end: string;
  wall_s: number;
  exit_code: number | null;
  signal: string | null;
  diff: DiffSize | null;
  brief_bytes: number;
  out_bytes: number;
  err_bytes: number;
  tokens: LegTokens | null;
  /** The attempt ended on a credit or quota error, so it was retried on the next profile (or gave up). */
  credit: boolean;
  /**
   * The attempt stopped on its turn cap (OB-2140): `max-turns` for the claude leg, `steps` for an OpenCode leg
   * (best effort, read from the reader's last message). Null otherwise; absent on records written before.
   */
  stop?: "steps" | "max-turns" | null;
  /** The `ob review run` this attempt belongs to (OS-210, from OB_REVIEW_RUN_ID); absent on a hand-run leg. */
  run?: string;
  /** The `ob review run` seat (OS-247, from OB_REVIEW_SEAT) when it differs from `leg`: `opus-2` runs `opus` again. */
  seat?: string;
}

/** `review-legs.jsonl` beside the models file and `models-state.json`. */
export function reviewLegsPath(env: Env = process.env): string {
  return join(dirname(modelsFilePath(env)), "review-legs.jsonl");
}

/** Append one record as one JSON line, creating the directory. Throws on a write failure; the caller decides. */
export function appendLegRecord(record: LegRecord, env: Env = process.env): void {
  const path = reviewLegsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
}

/** Every record in the file, skipping lines that do not parse. Empty with no file. */
export function readLegRecords(env: Env = process.env): LegRecord[] {
  const path = reviewLegsPath(env);
  if (!existsSync(path)) return [];
  const out: LegRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as LegRecord;
      if (r && typeof r === "object" && typeof r.start === "string" && typeof r.wall_s === "number") out.push(r);
    } catch {
      // a torn or hand-edited line: skip it
    }
  }
  return out;
}

/** The `#<variant>` suffix of a model id, or null. */
export function variantOf(model: string | null | undefined): string | null {
  if (!model) return null;
  const i = model.lastIndexOf("#");
  return i >= 0 && i < model.length - 1 ? model.slice(i + 1) : null;
}

/** Parse `git diff --shortstat` output (` 3 files changed, 10 insertions(+), 2 deletions(-)`). Null when it is not one. */
export function parseShortstat(text: string): DiffSize | null {
  const t = text.trim();
  if (t === "") return { files: 0, insertions: 0, deletions: 0 };
  const files = /(\d+) files? changed/.exec(t);
  if (!files) return null;
  const ins = /(\d+) insertions?\(\+\)/.exec(t);
  const del = /(\d+) deletions?\(-\)/.exec(t);
  return { files: Number(files[1]), insertions: ins ? Number(ins[1]) : 0, deletions: del ? Number(del[1]) : 0 };
}

/**
 * The size of `<base>...HEAD` in `cwd` (base `origin/main`, or OB_REVIEW_DIFF_BASE). Null on any git failure:
 * a missing diff never fails a leg.
 */
export function diffSize(cwd: string, env: Env = process.env): DiffSize | null {
  const base = env.OB_REVIEW_DIFF_BASE?.trim() || "origin/main";
  try {
    const proc = Bun.spawnSync(["git", "diff", "--shortstat", `${base}...HEAD`], { cwd, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return null;
    return parseShortstat(proc.stdout.toString());
  } catch {
    return null;
  }
}

/**
 * Token totals from a Claude Code session transcript (JSONL). Each assistant message carries a `usage`; one
 * message may appear on several lines as it streams, so the last usage per message id wins. Null when no line
 * carries usage.
 */
export function claudeTranscriptTokens(text: string): LegTokens | null {
  const byId = new Map<string, Record<string, unknown>>();
  let anon = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: { message?: { id?: string; usage?: Record<string, unknown> } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = row?.message?.usage;
    if (!usage || typeof usage !== "object") continue;
    byId.set(row.message?.id ?? `anon-${anon++}`, usage);
  }
  if (byId.size === 0) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const tokens: LegTokens = { input: 0, output: 0, reasoning: 0 };
  for (const u of byId.values()) {
    tokens.input += n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
    tokens.output += n(u.output_tokens);
    const details = u.output_tokens_details as Record<string, unknown> | undefined;
    tokens.reasoning += n(details?.thinking_tokens) + n(details?.reasoning_tokens);
  }
  return tokens;
}

/**
 * Read the transcript `claude -p --session-id <id>` left under `<claude config>/projects/<cwd slug>/<id>.jsonl`.
 * The slug is looked up by file name across project dirs rather than recomputed. Null when it is not there.
 */
export function claudeSessionTokens(sessionId: string, env: Env = process.env): LegTokens | null {
  const root = join(env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".claude"), "projects");
  try {
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, `${sessionId}.jsonl`);
      if (existsSync(file)) return claudeTranscriptTokens(readFileSync(file, "utf8"));
    }
  } catch {
    // no projects dir
  }
  return null;
}

/**
 * Token totals from `agy --output-format json`'s `usage` object
 * (`{ input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens }`).
 * Null when `usage` is absent or carries no finite numeric counts.
 */
export function antigravityUsageTokens(usage: unknown): LegTokens | null {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const u = usage as Record<string, unknown>;
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!isNum(u.input_tokens) && !isNum(u.output_tokens) && !isNum(u.thinking_tokens) && !isNum(u.cache_read_tokens)) return null;
  const n = (v: unknown) => (isNum(v) ? v : 0);
  return {
    input: n(u.input_tokens) + n(u.cache_read_tokens),
    output: n(u.output_tokens),
    reasoning: n(u.thinking_tokens),
  };
}

// --- the trend ----------------------------------------------------------------

export interface LegTrendGroup {
  date: string;
  model: string;
  runs: number;
  wall_p50_s: number | null;
  wall_p90_s: number | null;
  per100_p50_s: number | null;
  failed: number;
  credit: number;
  /** Attempts the wall-clock limit ended (`signal: "timeout"`, OB-2140). */
  timeout: number;
}

/** Nearest-rank percentile of `values` (sorted here). Null when empty. */
export function nearestRank(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

/**
 * Records from the last `days` days (by start, against `now`) grouped by UTC start date and model, newest date
 * first. A credit-error attempt is counted in `credit` only: it ends early, so it is left out of the wall
 * percentiles, per100 and `failed`. A timed-out attempt (OB-2140) is counted in `timeout` only: its wall is the
 * limit, not the leg's. `failed` is a non-zero exit or a signal. Pure.
 */
export function legTrend(records: LegRecord[], opts: { days: number; now: Date }): LegTrendGroup[] {
  const since = opts.now.getTime() - opts.days * 86_400_000;
  const groups = new Map<string, { date: string; model: string; recs: LegRecord[] }>();
  for (const r of records) {
    const t = Date.parse(r.start);
    if (!Number.isFinite(t) || t < since || t > opts.now.getTime()) continue;
    const date = new Date(t).toISOString().slice(0, 10);
    const model = r.model ?? r.leg;
    const key = `${date}\u0000${model}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { date, model, recs: [] }));
    g.recs.push(r);
  }
  const out: LegTrendGroup[] = [];
  for (const g of groups.values()) {
    const isTimeout = (r: LegRecord) => r.signal === "timeout";
    const real = g.recs.filter((r) => !r.credit && !isTimeout(r));
    const walls = real.map((r) => r.wall_s);
    const per100 = real.flatMap((r) => {
      const lines = r.diff ? r.diff.insertions + r.diff.deletions : 0;
      return lines > 0 ? [(r.wall_s / lines) * 100] : [];
    });
    out.push({
      date: g.date,
      model: g.model,
      runs: g.recs.length,
      wall_p50_s: round1(nearestRank(walls, 50)),
      wall_p90_s: round1(nearestRank(walls, 90)),
      per100_p50_s: round1(nearestRank(per100, 50)),
      failed: real.filter((r) => (r.exit_code !== null && r.exit_code !== 0) || r.signal !== null).length,
      credit: g.recs.filter((r) => r.credit).length,
      timeout: g.recs.filter((r) => !r.credit && isTimeout(r)).length,
    });
  }
  return out.sort((a, b) => (a.date === b.date ? a.model.localeCompare(b.model) : b.date.localeCompare(a.date)));
}

/** One text line per group, in the `ob models legs` format. */
export function formatTrendLine(g: LegTrendGroup): string {
  const s = (v: number | null) => (v === null ? "-" : `${v}s`);
  return `${g.date} ${g.model} runs ${g.runs} wall p50 ${s(g.wall_p50_s)} p90 ${s(g.wall_p90_s)} per100 ${s(g.per100_p50_s)} failed ${g.failed} credit ${g.credit} timeout ${g.timeout}`;
}

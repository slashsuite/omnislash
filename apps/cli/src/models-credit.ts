// OB-1970: fall back to the next models profile when an account is out of credits.
//
// Two small pieces every caller shares (the spinoff launch, the run mirror's relaunch, the skeptical
// review legs and `ob models show`):
//   - `creditErrorOf`: is this failure a credit or quota exhaustion? Provider error codes first, message
//     text only as a named last resort. A rate limit, an auth failure or anything else is NOT one.
//   - the state file beside the models file (`models-state.json`): when each profile last hit a credit
//     error, and which profiles each spinoff row has already been launched on. Local, not the DB.
//
// Like models-file.ts it imports nothing from the rest of ob, so `review-leg.ts` can load it cheaply.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { modelsFilePath } from "./models-file.ts";

/** A credit hit counts as recent for this many hours (`ob models show` marks it). */
export const CREDIT_HIT_WINDOW_HOURS = 6;

/**
 * Provider error codes that mean the account has no credit or quota left. Matched against T3's own error
 * `code` and as a whole word in the message (providers put their `type`/`code` there verbatim).
 */
const CREDIT_ERROR_CODES = [
  "insufficient_quota",
  "quota_exceeded",
  "credit_balance_too_low",
  "insufficient_credits",
  "insufficient_balance",
  "out_of_credits",
  "usage_limit_exceeded",
  "usage_limit_reached",
  "billing_hard_limit_reached",
] as const;

/**
 * The last resort, used only when no code matched: message phrasings providers use for an exhausted
 * account. Deliberately narrow. "rate limit" and "overloaded" are transient and are never here.
 */
const CREDIT_ERROR_TEXT: readonly RegExp[] = [
  /credit balance (is )?too low/i,
  /out of (credits|extra usage)/i,
  /insufficient (account )?(quota|credits?|balance|funds)/i,
  /usage limit (reached|exceeded)/i,
  /exceeded your (current )?quota/i,
  /\b(quota|credits?) (exceeded|exhausted|depleted)\b/i,
  /you'?ve hit your (usage )?limit/i,
];

/** Extra provider codes and text phrasings that signal an `agy` (Antigravity) quota or rate-limit failure. */
// RESOURCE_EXHAUSTED also covers Gemini 429 rate limits, so it counts only for an agy attempt, never globally.
const AGY_ERROR_CODES = ["rate_limit_exceeded", "resource_exhausted"] as const;
const AGY_ERROR_TEXT: readonly RegExp[] = [
  /\bquota\b/i,
  /\brate[- ]?limit(?:ed|s)?\b/i,
  /\b429\b/,
];

/** How much of the end of an `agy` stdout/response string `creditErrorOf` inspects for failure text. */
const AGY_STDOUT_TAIL = 600;

export interface AntigravityJson {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  message?: string;
  num_turns?: number;
  usage?: Record<string, unknown>;
  denied_actions?: unknown[];
}

/**
 * Parse `agy --output-format json` stdout. Tries the trimmed output first, then falls back to the last
 * JSON-object line in case `agy` printed a status line ahead of the payload. Returns `null` when none parses.
 */
export function parseAntigravityJson(stdout: string): AntigravityJson | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as AntigravityJson;
  } catch {
    const lines = trimmed.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line.startsWith("{")) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as AntigravityJson;
      } catch {
        // keep scanning upwards
      }
    }
  }
  return null;
}

export interface CreditMatch {
  /** `code` when a provider code matched, `text` when only the message phrasing did (the last resort). */
  by: "code" | "text";
  /** The code or the phrase that matched. */
  match: string;
}

export interface CreditErrorInput {
  code?: string | null;
  message?: string | null;
  /**
   * An `agy` (`antigravity` leg) attempt result: matches quota, rate limit, `RESOURCE_EXHAUSTED` or `429`
   * on a non-zero exit (stderr or last 600 bytes of stdout) or on a JSON `status` other than `SUCCESS`.
   */
  agy?: {
    exitCode: number | null;
    stderr?: string | null;
    stdout?: string | null;
  } | null;
}

function matchCreditMessage(message: string, includeAgy: boolean): CreditMatch | null {
  for (const c of CREDIT_ERROR_CODES) if (new RegExp(`\\b${c}\\b`, "i").test(message)) return { by: "code", match: c };
  if (includeAgy) {
    for (const c of AGY_ERROR_CODES) if (new RegExp(`\\b${c}\\b`, "i").test(message)) return { by: "code", match: c };
  }
  for (const re of CREDIT_ERROR_TEXT) {
    const m = re.exec(message);
    if (m) return { by: "text", match: m[0] };
  }
  if (includeAgy) {
    for (const re of AGY_ERROR_TEXT) {
      const m = re.exec(message);
      if (m) return { by: "text", match: m[0] };
    }
  }
  return null;
}

/** Whether `err` is a credit or quota exhaustion, and how that was decided. `null` for anything else. Pure. */
export function creditErrorOf(err: CreditErrorInput | null | undefined): CreditMatch | null {
  if (!err) return null;
  if (err.agy) {
    const { exitCode, stderr, stdout } = err.agy;
    const rawOut = stdout ?? "";
    const parsed = parseAntigravityJson(rawOut);
    // A payload with no status is a failure too (finishAntigravityRun fails it), so its error text still counts.
    if (parsed && parsed.status !== "SUCCESS") {
      const parts = [
        stderr ?? "",
        parsed.status ?? "missing status",
        typeof parsed.error === "string" ? parsed.error : "",
        typeof parsed.message === "string" ? parsed.message : "",
      ];
      return matchCreditMessage(parts.join("\n"), true);
    }
    if (exitCode !== null && exitCode !== 0) {
      // A parsed JSON payload is the review's own text (it may quote "quota" or "429"), so only stderr counts.
      const text = parsed ? (stderr ?? "") : `${stderr ?? ""}\n${rawOut.slice(-AGY_STDOUT_TAIL)}`;
      return matchCreditMessage(text, true);
    }
    return null;
  }
  const code = err.code?.trim().toLowerCase();
  if (code && (CREDIT_ERROR_CODES as readonly string[]).includes(code)) return { by: "code", match: code };
  return matchCreditMessage(err.message ?? "", false);
}

// --- the state file ---------------------------------------------------------

export interface ModelsState {
  /** Profile name to the ISO time it last hit a credit error. */
  creditHits: Record<string, string>;
  /** Spinoff row id to the profiles it was launched on, in order. The last one is the one it runs on. */
  rows: Record<string, string[]>;
}

/** `models-state.json` beside the models file. */
export function modelsStatePath(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(modelsFilePath(env)), "models-state.json");
}

/** The state, or an empty one when there is no file or it does not parse: it is a cache, never a refusal. */
export function readModelsState(env: Record<string, string | undefined> = process.env): ModelsState {
  const path = modelsStatePath(env);
  const empty: ModelsState = { creditHits: {}, rows: {} };
  if (!existsSync(path)) return empty;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ModelsState>;
    return {
      creditHits: raw.creditHits && typeof raw.creditHits === "object" ? raw.creditHits : {},
      rows: raw.rows && typeof raw.rows === "object" ? raw.rows : {},
    };
  } catch {
    return empty;
  }
}

function writeModelsState(state: ModelsState, env: Record<string, string | undefined>): void {
  const path = modelsStatePath(env);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Record that `profile` hit a credit error at `at`. */
export function recordCreditHit(profile: string, at: Date = new Date(), env: Record<string, string | undefined> = process.env): void {
  const state = readModelsState(env);
  state.creditHits[profile] = at.toISOString();
  writeModelsState(state, env);
}

/** Record that spinoff row `rowId` is being launched on `profile`. */
export function recordRowProfile(rowId: number, profile: string, env: Record<string, string | undefined> = process.env): void {
  const state = readModelsState(env);
  const tried = state.rows[String(rowId)] ?? [];
  if (tried[tried.length - 1] !== profile) tried.push(profile);
  state.rows[String(rowId)] = tried;
  writeModelsState(state, env);
}

/** The profiles row `rowId` was launched on, in order (empty when none was recorded). */
export function rowProfiles(rowId: number, env: Record<string, string | undefined> = process.env): string[] {
  return readModelsState(env).rows[String(rowId)] ?? [];
}

/** Profiles whose last credit hit is within `hours` of `now`, with that time. */
export function recentCreditHits(
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
  hours = CREDIT_HIT_WINDOW_HOURS,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [profile, at] of Object.entries(readModelsState(env).creditHits)) {
    const t = Date.parse(at);
    if (Number.isFinite(t) && now.getTime() - t <= hours * 3_600_000 && t <= now.getTime()) out[profile] = at;
  }
  return out;
}

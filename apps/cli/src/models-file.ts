// OB-1969: the machine-level models file, `~/.config/ob/models.jsonc`.
//
// ONE file says which model runs what, grouped into profiles (one per account), and `ob models use <profile>`
// switches them all. This module is the loader every reader shares: `ob spinoff --tier`, the skeptical-review
// legs (a standalone bun script that imports this file by relative path) and `ob models` itself. It imports
// nothing from the rest of ob, so a script outside the CLI can load it cheaply.
//
// The file holds model ids and T3 provider instance ids only. No secret, no credential.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The builder tiers (1480). `dispatch.ts` re-exports these; they live here so this file needs no ob code. */
export const SPINOFF_TIERS = ["complex", "medium", "simple"] as const;
export type SpinoffTier = (typeof SPINOFF_TIERS)[number];

/**
 * A tier's model value split into its optional provider and its model (1549). `opencode:opencode-go/x`
 * names the provider instance before the FIRST colon; a bare id names none. `null` is a malformed qualified
 * value (empty provider or model). Pure.
 */
export function splitTierModel(value: string): { providerInstanceId: string | null; model: string } | null {
  const colon = value.indexOf(":");
  if (colon < 0) return { providerInstanceId: null, model: value };
  const providerInstanceId = value.slice(0, colon).trim();
  const model = value.slice(colon + 1).trim();
  if (!providerInstanceId || !model) return null;
  return { providerInstanceId, model };
}

/** The tier → model map when `spinoff_tier_models` sets nothing. Overridable per tier. */
export const DEFAULT_TIER_MODELS: Readonly<Record<SpinoffTier, string>> = {
  complex: "claude-opus-5-5",
  medium: "claude-sonnet-5-5",
  simple: "claude-haiku-5-5",
};

export function isSpinoffTier(s: string): s is SpinoffTier {
  return (SPINOFF_TIERS as readonly string[]).includes(s);
}

export function emptyHalfOf(value: string): "provider" | "model" | "provider or model" {
  if (/^\s*:/.test(value)) return "provider";
  if (/:\s*$/.test(value)) return "model";
  return "provider or model";
}

/**
 * The `spinoff_tier_models` setting, read over the defaults: a JSON object naming the model for any of the
 * tiers (`{"simple":"claude-haiku-5-5"}`); a tier it leaves out keeps its default. Malformed JSON, an
 * unknown tier or a non-string model is an ERROR, not an empty map — a typo here would otherwise send a
 * build to the default without a word. Pure.
 */
export function parseTierModels(raw: string | null | undefined): { models: Record<SpinoffTier, string>; error: string | null } {
  const models = { ...DEFAULT_TIER_MODELS };
  const text = (raw ?? "").trim();
  if (!text) return { models, error: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { models, error: `spinoff_tier_models is not JSON: ${text}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { models, error: `spinoff_tier_models must be a JSON object of tier → model, got ${text}` };
  }
  for (const [tier, model] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isSpinoffTier(tier)) return { models, error: `spinoff_tier_models names '${tier}', which is not a tier (${SPINOFF_TIERS.join("|")})` };
    if (typeof model !== "string" || !model.trim()) return { models, error: `spinoff_tier_models.${tier} must be a model id string` };
    if (!splitTierModel(model.trim())) return { models, error: `spinoff_tier_models.${tier} '${model.trim()}' has an empty ${emptyHalfOf(model.trim())} — a qualified value needs a provider AND a model around the first colon, or a bare model id` };
    models[tier] = model.trim();
  }
  return { models, error: null };
}

/** The skeptical-review legs' built-in models. `review-leg.ts` and `ob models show` both read this one table. */
export const DEFAULT_REVIEW_MODELS = {
  neon: "antigravity:gemini-4-neon",
  opus: "claude-opus-5-5",
  deepseek: "opencode-go/deepseek-v4.1-flash#high",
  luna: "opencode-go/gpt-6-luna#high",
} as const;

/** The default skeptical-review leg set when `review_readers` is unset: Neon and Opus. */
export const DEFAULT_REVIEW_LEGS = ["neon", "opus"] as const satisfies readonly (keyof typeof DEFAULT_REVIEW_MODELS)[];

/**
 * Old review-leg names still accepted (OB-2107): `sonnet` is the Claude leg, renamed `opus` when it moved to
 * Opus. A machine whose models file still says `review.sonnet` keeps that value for the `opus` leg.
 */
export const REVIEW_LEG_ALIASES: Readonly<Record<string, string>> = { sonnet: "opus" };

/** The leg an accepted name stands for: `sonnet` → `opus`, any other name as it is. Pure. */
export function canonicalLeg(leg: string): string {
  return REVIEW_LEG_ALIASES[leg] ?? leg;
}

/**
 * A profile's model for `leg`, under its own name first and then under any alias of it (OB-2107), so
 * `review.sonnet` still feeds the `opus` leg. Undefined when the profile names neither. Pure.
 */
export function reviewModelFor(review: Readonly<Record<string, string>> | undefined, leg: string): string | undefined {
  if (!review) return undefined;
  const canonical = canonicalLeg(leg);
  if (review[canonical] !== undefined) return review[canonical];
  for (const [alias, target] of Object.entries(REVIEW_LEG_ALIASES)) if (target === canonical && review[alias] !== undefined) return review[alias];
  return undefined;
}

/** The architect's checker model when no profile names one (the measure-twice step runs Haiku). */
export const DEFAULT_CHECKER = "claude-haiku-5-5";

/** The file did not parse or does not make sense. The message names the file and what is wrong. */
export class ModelsFileError extends Error {}

// --- OS-145: model routes --------------------------------------------------------------------------------
// The fixed route names, effort levels and one route's spec live here (not in model-routes.ts) because this
// file parses a local file's `routes` and must stay free of every other ob import.

/** Every route with a fixed name. `job.<name>` routes are open-ended (see `isRouteName`). */
export const FIXED_ROUTES = [
  "builder.simple",
  "builder.medium",
  "builder.complex",
  "checker",
  "role.architect",
  "role.sentinel",
  "role.muse",
  "sweep.first",
  "sweep.escalate",
  "subagent.explore",
  "subagent.fixup",
] as const;
export type FixedRoute = (typeof FIXED_ROUTES)[number];

/** A daily scheduled prompt's route: `job.` and a lowercase name. */
export const JOB_ROUTE = /^job\.[a-z0-9-]+$/;

export function isRouteName(name: string): boolean {
  return (FIXED_ROUTES as readonly string[]).includes(name) || JOB_ROUTE.test(name);
}

/** The route-name refusal, naming every fixed route and the job form. Pure. */
export function routeNameRejection(name: string): string {
  return `'${name}' is not a route (use ${FIXED_ROUTES.join(", ")} or job.<name>, a name of lowercase letters, digits and dashes)`;
}

/** The effort levels a route may name. Anything else is refused by name; omitted means the launcher's default. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type RouteEffort = (typeof EFFORT_LEVELS)[number];

export function isRouteEffort(v: string): v is RouteEffort {
  return (EFFORT_LEVELS as readonly string[]).includes(v);
}

/** One route: the models tried in order (a credit or quota error moves to the next), and an optional effort. */
export interface RouteSpec {
  chain: string[];
  effort?: RouteEffort;
}

/** A route's spec checked: a non-empty chain of model ids and a known effort. Throws `ModelsFileError` naming `where`. Pure. */
export function checkRouteSpec(where: string, v: unknown): RouteSpec {
  if (!isObject(v)) throw new ModelsFileError(`${where} must be an object with a "chain" list`);
  if (!Array.isArray(v.chain) || v.chain.length === 0) throw new ModelsFileError(`${where}.chain must be a list of at least one model id`);
  const chain = v.chain.map((m, i) => modelString(where, `chain[${i}]`, m));
  const spec: RouteSpec = { chain: [...new Set(chain)] };
  if (v.effort !== undefined) {
    if (typeof v.effort !== "string" || !isRouteEffort(v.effort)) throw new ModelsFileError(`${where}.effort '${String(v.effort)}' is not an effort level (use ${EFFORT_LEVELS.join(", ")})`);
    spec.effort = v.effort;
  }
  for (const key of Object.keys(v)) if (key !== "chain" && key !== "effort") throw new ModelsFileError(`${where} has an unknown key '${key}' (use chain, effort)`);
  return spec;
}

export interface ModelsProfile {
  builder: Partial<Record<SpinoffTier, string>>;
  checker?: string;
  /** Review leg name (`neon`, `opus`, `deepseek`, `luna`, ...; `sonnet` is read as `opus`) to model id. */
  review: Record<string, string>;
  /** OS-145: route overrides for this machine (`builder.medium`, `role.architect`, `job.<name>`, ...). */
  routes: Record<string, RouteSpec>;
}

export interface ModelsFile {
  path: string;
  /** The profile this machine runs, overriding the server's `model_routes.active` (OS-145). Null when the file names none. */
  active: string | null;
  fallback: string[];
  profiles: Record<string, ModelsProfile>;
}

/** `OB_MODELS_FILE`, else `~/.config/ob/models.jsonc` (XDG_CONFIG_HOME honoured). */
export function modelsFilePath(env: Record<string, string | undefined> = process.env): string {
  const override = env.OB_MODELS_FILE?.trim();
  if (override) return override;
  const base = env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".config");
  return join(base, "ob", "models.jsonc");
}

/**
 * Blank every `//` and `/* *\/` comment with spaces, keeping newlines and every other character where it
 * was, so offsets in the result are offsets in the original. Strings are respected: `//` inside
 * `"https://x"` is not a comment. A hand-written scanner, no dependency. Pure.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (; i < stop; i++) out += text[i] === "\n" ? "\n" : " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function modelString(path: string, where: string, v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new ModelsFileError(`${path}: ${where} must be a model id string`);
  const model = v.trim();
  if (!splitTierModel(model)) {
    throw new ModelsFileError(`${path}: ${where} '${model}' has an empty provider or model around the first colon (use '<provider>:<model>' or a bare model id)`);
  }
  return model;
}

/**
 * Parse and validate the file's text. Throws `ModelsFileError` naming `path` and the fault. Pure.
 *
 * OS-145: the file is a per-machine override of the server's `model_routes`, so `"active"`, `"fallback"` and
 * `"profiles"` are each optional, and a profile they name may be defined on the server instead of here (the
 * resolver refuses one defined nowhere). Each profile may add `"routes"`; `builder`, `checker` and `review` keep
 * working and map to builder.*, checker and the review readers.
 */
export function parseModelsFile(text: string, path: string): ModelsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (e) {
    throw new ModelsFileError(`${path} is not valid JSON with comments: ${(e as Error).message}`);
  }
  if (!isObject(raw)) throw new ModelsFileError(`${path}: the top level must be a JSON object`);
  if (raw.active !== undefined && (typeof raw.active !== "string" || !raw.active.trim())) throw new ModelsFileError(`${path}: "active" must name a profile`);
  if (raw.profiles !== undefined && !isObject(raw.profiles)) throw new ModelsFileError(`${path}: "profiles" must be an object of profile name to profile`);
  const profiles: Record<string, ModelsProfile> = {};
  for (const [name, p] of Object.entries((raw.profiles ?? {}) as Record<string, unknown>)) {
    if (!isObject(p)) throw new ModelsFileError(`${path}: profile '${name}' must be an object`);
    const profile: ModelsProfile = { builder: {}, review: {}, routes: {} };
    if (p.builder !== undefined) {
      if (!isObject(p.builder)) throw new ModelsFileError(`${path}: profile '${name}'.builder must be an object of tier to model`);
      for (const [tier, model] of Object.entries(p.builder)) {
        if (!(SPINOFF_TIERS as readonly string[]).includes(tier)) {
          throw new ModelsFileError(`${path}: profile '${name}'.builder names '${tier}', which is not a tier (${SPINOFF_TIERS.join("|")})`);
        }
        profile.builder[tier as SpinoffTier] = modelString(path, `profile '${name}'.builder.${tier}`, model);
      }
    }
    if (p.checker !== undefined) profile.checker = modelString(path, `profile '${name}'.checker`, p.checker);
    if (p.review !== undefined) {
      if (!isObject(p.review)) throw new ModelsFileError(`${path}: profile '${name}'.review must be an object of leg to model`);
      for (const [leg, model] of Object.entries(p.review)) profile.review[leg] = modelString(path, `profile '${name}'.review.${leg}`, model);
    }
    if (p.routes !== undefined) {
      if (!isObject(p.routes)) throw new ModelsFileError(`${path}: profile '${name}'.routes must be an object of route to {chain, effort}`);
      for (const [route, spec] of Object.entries(p.routes)) {
        if (!isRouteName(route)) throw new ModelsFileError(`${path}: profile '${name}'.routes: ${routeNameRejection(route)}`);
        profile.routes[route] = checkRouteSpec(`${path}: profile '${name}'.routes.${route}`, spec);
      }
    }
    profiles[name] = profile;
  }
  const active = typeof raw.active === "string" ? raw.active.trim() : null;
  let fallback: string[] = [];
  if (raw.fallback !== undefined) {
    if (!Array.isArray(raw.fallback) || raw.fallback.some((f) => typeof f !== "string" || !f.trim())) {
      throw new ModelsFileError(`${path}: "fallback" must be an array of profile names`);
    }
    fallback = (raw.fallback as string[]).map((f) => f.trim());
  }
  return { path, active, fallback, profiles };
}

/**
 * Load the machine's models file: `null` when there is none (a machine with no file behaves exactly as
 * before), a `ModelsFileError` when there is one and it is wrong. Never a silent fallback.
 */
export function loadModelsFile(env: Record<string, string | undefined> = process.env): ModelsFile | null {
  const path = modelsFilePath(env);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ModelsFileError(`${path} could not be read: ${(e as Error).message}`);
  }
  return parseModelsFile(text, path);
}

/** The active profile of a loaded file, or `null` for no file. */
export function activeProfile(file: ModelsFile | null): ModelsProfile | null {
  return file && file.active !== null && Object.hasOwn(file.profiles, file.active) ? file.profiles[file.active]! : null;
}

/**
 * The active profile's complex-tier model, split into its provider instance and model id (OS-129).
 * Returns `null` when there is no models file, it is malformed/unreadable, the active profile names
 * no `builder.complex`, or that value is a bare model id with no provider. Never throws, so pacing
 * (`ob next`, `ob usage`, `ob role brief`) and role-thread launches can fall back cleanly.
 */
export function activeComplexModel(
  env: Record<string, string | undefined> = process.env,
): { providerInstanceId: string; model: string } | null {
  let file: ModelsFile | null;
  try {
    file = loadModelsFile(env);
  } catch {
    return null;
  }
  const raw = activeProfile(file)?.builder.complex;
  if (!raw) return null;
  const split = splitTierModel(raw);
  if (!split || !split.providerInstanceId) return null;
  return { providerInstanceId: split.providerInstanceId, model: split.model };
}

/**
 * Set `"active"` by editing that one value in the raw text, so comments and layout survive. The key is
 * found in the comment-blanked copy (same offsets), so a commented-out `"active": "x"` is never the one
 * edited. Throws when the file has no `"active"` string. Pure.
 */
export function setActiveInText(text: string, profile: string, path = "models file"): string {
  const blank = stripJsonComments(text);
  // Walk the blanked copy tracking brace/bracket depth and strings, so only a TOP-LEVEL "active" key
  // (depth 1) is edited, never one nested inside a profile.
  let depth = 0;
  for (let i = 0; i < blank.length; i++) {
    const c = blank[i]!;
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === '"') {
      let j = i + 1;
      while (j < blank.length && blank[j] !== '"' && blank[j] !== "\n") j += blank[j] === "\\" ? 2 : 1;
      if (depth === 1 && blank.slice(i + 1, j) === "active") {
        const m = /^\s*:\s*"((?:[^"\\\n]|\\.)*)"/.exec(blank.slice(j + 1));
        if (m) {
          const valueStart = j + 1 + m[0].lastIndexOf('"' + m[1] + '"');
          return text.slice(0, valueStart) + JSON.stringify(profile) + text.slice(valueStart + m[1]!.length + 2);
        }
      }
      i = j;
    }
  }
  throw new ModelsFileError(`${path}: no top-level "active" value to edit`);
}

/** Write `profile` as the active one in the file at `path`. */
export function writeActive(path: string, profile: string): void {
  writeFileSync(path, setActiveInText(readFileSync(path, "utf8"), profile, path));
}

/** Copy `from` to `path`, creating the directory. The caller has already refused an existing file. */
export function initModelsFile(path: string, from: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, readFileSync(from, "utf8"), { flag: "wx" });
}

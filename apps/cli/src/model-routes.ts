// OS-145: which model runs every use, in ONE server setting, `model_routes`.
//
// A route is a named use of a model (`builder.medium`, `checker`, `role.architect`, `sweep.first`,
// `job.<name>`, ...). Each route is a fallback CHAIN of models tried in order (a credit or quota error moves to
// the next entry) and an optional effort. Routes are grouped into profiles (one per account), and the setting
// names the profile in force for everyone:
//
//   {"active": "claude", "fallback": ["antigravity"],
//    "profiles": {"claude": {"routes": {"builder.medium": {"chain": ["claude-opus-5-5"], "effort": "high"}},
//                            "review": {"readers": {...}, "tiers": {...}}}}}
//
// Each route resolves in three layers, the first that names it winning:
//   1. local:   this machine's `~/.config/ob/models.jsonc` (its `routes`, or the old `builder` / `checker` keys);
//   2. server:  the `model_routes` setting;
//   3. default: what ob ran before OS-145 (the `spinoff_tier_models` setting over the built-in tiers, Haiku for the
//               checker, the builder.complex model for role threads, Haiku/Opus for the sweep).
// The review readers resolve the same way: the profile's `review` here, else the old `review_readers` key (read,
// never written), else Neon and Opus, with the local file's `review` legs laid over the result.
//
// This module is PURE apart from the small cache below. It imports only models-file and review-readers, so the
// dashboard server and standalone scripts can load it cheaply. Reads and writes go through a `ConfigIO` the
// caller supplies (the store locally, the API client in API mode).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  DEFAULT_CHECKER,
  DEFAULT_TIER_MODELS,
  EFFORT_LEVELS,
  FIXED_ROUTES,
  ModelsFileError,
  SPINOFF_TIERS,
  canonicalLeg,
  checkRouteSpec,
  isRouteEffort,
  isRouteName,
  modelsFilePath,
  parseTierModels,
  routeNameRejection,
  splitTierModel,
  type ModelsFile,
  type RouteEffort,
  type RouteSpec,
  type SpinoffTier,
} from "./models-file.ts";
import {
  REVIEW_READERS_KEY,
  REVIEW_TIERS,
  ReviewReadersError,
  defaultReviewReaders,
  parseReviewReaders,
  validateReviewReaders,
  withReader,
  withTier,
  type ConfigIO,
  type ReviewReaders,
  type ReviewTier,
} from "./review-readers.ts";

export const MODEL_ROUTES_KEY = "model_routes";
/** The tier setting the default layer reads (`ob config set spinoff_tier_models`). */
export const TIER_MODELS_KEY = "spinoff_tier_models";
/** The profile a write names when no profile is active anywhere. */
export const DEFAULT_PROFILE = "default";

export interface RoutesProfile {
  routes: Record<string, RouteSpec>;
  /** The skeptical-review readers this profile runs; absent means the old `review_readers` key, else the defaults. */
  review?: ReviewReaders;
}

export interface ModelRoutes {
  /** The profile in force for everyone; null when none was ever chosen. A local file's `active` wins on its machine. */
  active: string | null;
  /** Profiles tried after the active one, route by route, when a whole chain is out of credit. */
  fallback: string[];
  profiles: Record<string, RoutesProfile>;
}

/** The setting is malformed, or a write would make it so. The message names what is wrong. */
export class ModelRoutesError extends Error {}

export function emptyModelRoutes(): ModelRoutes {
  return { active: null, fallback: [], profiles: {} };
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkProfileName(name: unknown, where: string): string {
  if (typeof name !== "string" || !PROFILE_NAME.test(name)) throw new ModelRoutesError(`${where} '${String(name)}' is not a profile name (letters, digits, dashes and underscores)`);
  return name;
}

/** Check a parsed value and return it normalised. Throws ModelRoutesError naming the fault. Pure. */
export function validateModelRoutes(v: unknown): ModelRoutes {
  if (!isObject(v)) throw new ModelRoutesError("model_routes must be a JSON object with active, fallback and profiles");
  for (const key of Object.keys(v)) if (!["active", "fallback", "profiles"].includes(key)) throw new ModelRoutesError(`model_routes has an unknown key '${key}' (use active, fallback, profiles)`);
  const active = v.active === undefined || v.active === null ? null : checkProfileName(v.active, "model_routes.active");
  if (v.fallback !== undefined && !Array.isArray(v.fallback)) throw new ModelRoutesError("model_routes.fallback must be a list of profile names");
  const fallback = [...new Set(((v.fallback ?? []) as unknown[]).map((f) => checkProfileName(f, "model_routes.fallback")))];
  if (v.profiles !== undefined && !isObject(v.profiles)) throw new ModelRoutesError("model_routes.profiles must be an object of profile name to {routes, review}");
  const profiles: Record<string, RoutesProfile> = {};
  for (const [name, p] of Object.entries((v.profiles ?? {}) as Record<string, unknown>)) {
    checkProfileName(name, "model_routes profile");
    if (!isObject(p)) throw new ModelRoutesError(`model_routes profile '${name}' must be an object with routes and review`);
    for (const key of Object.keys(p)) if (key !== "routes" && key !== "review") throw new ModelRoutesError(`model_routes profile '${name}' has an unknown key '${key}' (use routes, review)`);
    if (p.routes !== undefined && !isObject(p.routes)) throw new ModelRoutesError(`model_routes profile '${name}'.routes must be an object of route to {chain, effort}`);
    const routes: Record<string, RouteSpec> = {};
    for (const [route, spec] of Object.entries((p.routes ?? {}) as Record<string, unknown>)) {
      if (!isRouteName(route)) throw new ModelRoutesError(`model_routes profile '${name}': ${routeNameRejection(route)}`);
      try {
        routes[route] = checkRouteSpec(`model_routes profile '${name}'.routes.${route}`, spec);
      } catch (e) {
        if (e instanceof ModelsFileError) throw new ModelRoutesError(e.message);
        throw e;
      }
    }
    const profile: RoutesProfile = { routes };
    if (p.review !== undefined) {
      try {
        profile.review = validateReviewReaders(p.review);
      } catch (e) {
        if (e instanceof ReviewReadersError) throw new ModelRoutesError(`model_routes profile '${name}'.review: ${e.message}`);
        throw e;
      }
    }
    profiles[name] = profile;
  }
  return { active, fallback, profiles };
}

/** The stored text, parsed and checked. Empty or null is the empty setting. Throws ModelRoutesError. */
export function parseModelRoutes(raw: string | null | undefined): ModelRoutes {
  if (raw === null || raw === undefined || raw.trim() === "") return emptyModelRoutes();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ModelRoutesError("model_routes is not valid JSON");
  }
  return validateModelRoutes(parsed);
}

export function serializeModelRoutes(v: ModelRoutes): string {
  return JSON.stringify(validateModelRoutes(v));
}

// --- resolution ----------------------------------------------------------------------------------------------

/** Everything a resolution reads. Built by `loadRouteInputs`, or by a test. */
export interface RouteInputs {
  file: ModelsFile | null;
  server: ModelRoutes;
  /** The old `review_readers` key, when stored. */
  legacyReaders: ReviewReaders | null;
  /** `spinoff_tier_models` over the built-in tiers (the default layer for builder.*). */
  tierModels: Readonly<Record<SpinoffTier, string>>;
}

export function emptyRouteInputs(over: Partial<RouteInputs> = {}): RouteInputs {
  return { file: null, server: emptyModelRoutes(), legacyReaders: null, tierModels: { ...DEFAULT_TIER_MODELS }, ...over };
}

export type RouteSource = "local" | "server" | "default";

export interface ResolvedRoute {
  route: string;
  profile: string | null;
  chain: string[];
  effort?: RouteEffort;
  source: RouteSource;
  /** The route this one took its chain from (`builder.complex` for role.* and job.*), when it did. */
  via?: string;
}

/** Where the profile in force came from, and its name (null when none is named anywhere). */
export interface ActiveProfile {
  name: string | null;
  source: "local" | "server" | "none";
  /** The server's own `active`, when a local file's `active` hides it. */
  hiddenServer?: string | null;
  /** True when the name is defined in neither the local file nor the server (only defaults apply). */
  undefinedProfile: boolean;
}

export function activeProfileOf(inputs: RouteInputs): ActiveProfile {
  const local = inputs.file?.active ?? null;
  const server = inputs.server.active;
  const name = local ?? server;
  const source = local ? "local" : server ? "server" : "none";
  const undefinedProfile = name !== null && !hasProfile(inputs, name);
  return { name, source, ...(local && server && server !== local ? { hiddenServer: server } : {}), undefinedProfile };
}

/** Is `name` a profile the file or the server defines? */
export function hasProfile(inputs: RouteInputs, name: string): boolean {
  return Object.hasOwn(inputs.server.profiles, name) || (inputs.file !== null && Object.hasOwn(inputs.file.profiles, name));
}

/** The profile names a launch tries, in order: the active one, then the fallback (local `fallback` when it names any). */
export function profileOrderOf(inputs: RouteInputs): string[] {
  const active = activeProfileOf(inputs).name;
  const fallback = inputs.file && inputs.file.fallback.length > 0 ? inputs.file.fallback : inputs.server.fallback;
  return [...new Set([...(active ? [active] : []), ...fallback])];
}

/** The local file's own spec for `route` in `profile`: its `routes`, else the old `builder` / `checker` keys. */
function localSpec(file: ModelsFile | null, profile: string | null, route: string): RouteSpec | null {
  if (!file || profile === null || !Object.hasOwn(file.profiles, profile)) return null;
  const p = file.profiles[profile]!;
  if (p.routes[route]) return p.routes[route]!;
  if (route.startsWith("builder.")) {
    const tier = route.slice("builder.".length) as SpinoffTier;
    if (p.builder[tier]) return { chain: [p.builder[tier]!] };
  }
  if (route === "checker" && p.checker) return { chain: [p.checker] };
  return null;
}

function serverSpec(server: ModelRoutes, profile: string | null, route: string): RouteSpec | null {
  if (profile === null || !Object.hasOwn(server.profiles, profile)) return null;
  return server.profiles[profile]!.routes[route] ?? null;
}

/** The sweep and subagent routes' built-in models (never Sonnet). */
export const DEFAULT_ROUTE_MODELS: Readonly<Record<string, string>> = {
  "sweep.first": "claude-haiku-5-5",
  "sweep.escalate": "claude-opus-5-5",
  "subagent.explore": "claude-haiku-5-5",
  "subagent.fixup": "claude-opus-5-5",
};

/** A role thread's model when nothing names builder.complex: Opus, provider named (a role run never leans on a project default). */
export const DEFAULT_ROLE_MODEL = `claudeAgent:${DEFAULT_TIER_MODELS.complex}`;

/** A role thread names its provider: a bare id runs on Claude. Pure. */
function withProvider(model: string): string {
  return splitTierModel(model)?.providerInstanceId ? model : `claudeAgent:${model}`;
}

function spec(route: string, profile: string | null, s: RouteSpec, source: RouteSource): ResolvedRoute {
  return { route, profile, chain: [...s.chain], ...(s.effort ? { effort: s.effort } : {}), source };
}

/** One route in one profile (`profile` null = no profile: defaults only). Throws on a name that is no route. Pure. */
export function resolveRouteIn(inputs: RouteInputs, route: string, profile: string | null): ResolvedRoute {
  if (!isRouteName(route)) throw new ModelRoutesError(routeNameRejection(route));
  const local = localSpec(inputs.file, profile, route);
  if (local) return spec(route, profile, local, "local");
  const server = serverSpec(inputs.server, profile, route);
  if (server) return spec(route, profile, server, "server");
  if (route.startsWith("builder.")) {
    const tier = route.slice("builder.".length) as SpinoffTier;
    return { route, profile, chain: [inputs.tierModels[tier]], source: "default" };
  }
  if (route === "checker") return { route, profile, chain: [DEFAULT_CHECKER], source: "default" };
  if (route.startsWith("role.")) {
    // Today's behaviour: a role thread opens on builder.complex when a profile names it, else Opus on Claude.
    // The `spinoff_tier_models` setting never reached role threads, so the default layer's builder.complex does not either.
    const complex = resolveRouteIn(inputs, "builder.complex", profile);
    if (complex.source === "default") return { route, profile, chain: [DEFAULT_ROLE_MODEL], source: "default" };
    return { route, profile, chain: [...new Set(complex.chain.map(withProvider))], ...(complex.effort ? { effort: complex.effort } : {}), source: complex.source, via: "builder.complex" };
  }
  if (route.startsWith("job.")) {
    const complex = resolveRouteIn(inputs, "builder.complex", profile);
    return { ...complex, route, via: "builder.complex" };
  }
  return { route, profile, chain: [DEFAULT_ROUTE_MODELS[route]!], source: "default" };
}

/** One route in the active profile. Pure. */
export function resolveRoute(inputs: RouteInputs, route: string): ResolvedRoute {
  return resolveRouteIn(inputs, route, activeProfileOf(inputs).name);
}

/** The label `show` prints for a route's source: `local`, `server`, `default`, or `default (builder.complex)`. Pure. */
export function sourceLabel(r: ResolvedRoute): string {
  return r.via ? `${r.source} (${r.via})` : r.source;
}

/** Every fixed route, then each `job.<name>` any layer of the active profile names, sorted. Pure. */
export function routeNames(inputs: RouteInputs): string[] {
  const active = activeProfileOf(inputs).name;
  const jobs = new Set<string>();
  const add = (routes: Record<string, RouteSpec> | undefined) => {
    for (const r of Object.keys(routes ?? {})) if (r.startsWith("job.")) jobs.add(r);
  };
  if (active !== null) {
    add(inputs.file?.profiles[active]?.routes);
    add(inputs.server.profiles[active]?.routes);
  }
  return [...FIXED_ROUTES, ...[...jobs].sort()];
}

export function resolveAllRoutes(inputs: RouteInputs): ResolvedRoute[] {
  return routeNames(inputs).map((r) => resolveRoute(inputs, r));
}

/** One model a launch may try: the model and the profile whose chain named it. */
export interface RouteAttempt {
  profile: string | null;
  model: string;
}

/**
 * The models a launch of `route` tries, in order (OS-145 design 4): the active profile's chain, then the same route
 * in each fallback profile. A model already listed is not tried twice. Pure.
 */
export function routeAttempts(inputs: RouteInputs, route: string): RouteAttempt[] {
  const order = profileOrderOf(inputs);
  const out: RouteAttempt[] = [];
  const seen = new Set<string>();
  for (const profile of order.length > 0 ? order : [null]) {
    for (const model of resolveRouteIn(inputs, route, profile).chain) {
      if (seen.has(model)) continue;
      seen.add(model);
      out.push({ profile, model });
    }
  }
  return out;
}

/** The Decisions line a move along a chain records. Pure. */
export function routeMoveNote(route: string, from: string, to: string): string {
  return `route ${route}: ${from} -> ${to} (quota)`;
}

// --- review readers ------------------------------------------------------------------------------------------

export interface ResolvedReview {
  profile: string | null;
  /** Where the readers came from: this profile's server `review`, the old `review_readers` key, or the defaults. */
  source: "server" | "legacy" | "default";
  /** True when anything but the defaults stands (review-leg.ts then uses these legs). */
  stored: boolean;
  value: ReviewReaders;
}

/** The readers `profile` runs on the server, before any local overlay. Pure. */
export function serverReview(inputs: RouteInputs, profile: string | null): Omit<ResolvedReview, "profile"> {
  const own = profile !== null ? inputs.server.profiles[profile]?.review : undefined;
  if (own) return { source: "server", stored: true, value: own };
  if (inputs.legacyReaders) return { source: "legacy", stored: true, value: inputs.legacyReaders };
  return { source: "default", stored: false, value: defaultReviewReaders() };
}

/** The active profile's readers, with the local file's `review` legs laid over the models of the readers it lists. Pure. */
export function resolveReview(inputs: RouteInputs, profile: string | null = activeProfileOf(inputs).name): ResolvedReview {
  const base = serverReview(inputs, profile);
  const local = profile !== null ? inputs.file?.profiles[profile]?.review : undefined;
  const readers = { ...base.value.readers };
  for (const [leg, model] of Object.entries(local ?? {})) {
    const canonical = canonicalLeg(leg);
    if (readers[canonical]) readers[canonical] = { model };
  }
  return { profile, ...base, value: { readers, tiers: base.value.tiers } };
}

// --- writes (all go to model_routes; each returns the new, validated value) ---------------------------------

/** The profile a write lands on: `--profile`, else the active one, else `default`. Pure. */
export function writeProfile(inputs: RouteInputs, named?: string): string {
  if (named !== undefined) return checkProfileName(named, "--profile");
  return activeProfileOf(inputs).name ?? DEFAULT_PROFILE;
}

function withProfile(v: ModelRoutes, profile: string, patch: (p: RoutesProfile) => RoutesProfile): ModelRoutes {
  const current = v.profiles[profile] ?? { routes: {} };
  const next: ModelRoutes = { ...v, profiles: { ...v.profiles, [profile]: patch(current) } };
  // The first profile ever written becomes the active one, so a write on a fresh setting takes effect.
  if (next.active === null) next.active = profile;
  return validateModelRoutes(next);
}

/** Split and check `a,b,c` into a chain. Throws ModelRoutesError naming the bad entry. Pure. */
export function parseChain(text: string): string[] {
  const parts = text.split(",").map((s) => s.trim());
  if (parts.length === 0 || parts.some((p) => !p)) throw new ModelRoutesError(`'${text}' is not a model list: give model ids separated by commas, no empty entries`);
  for (const p of parts) {
    if (/\s/.test(p)) throw new ModelRoutesError(`model '${p}' has a space in it`);
    if (!splitTierModel(p)) throw new ModelRoutesError(`model '${p}' needs a provider AND a model around the first colon, or a bare model id`);
  }
  return [...new Set(parts)];
}

/** Check an effort level by name. Pure. */
export function checkEffort(level: string): RouteEffort {
  if (!isRouteEffort(level)) throw new ModelRoutesError(`effort '${level}' is not an effort level (use ${EFFORT_LEVELS.join(", ")})`);
  return level;
}

export function withRoute(v: ModelRoutes, profile: string, route: string, chain: string[], effort?: RouteEffort): ModelRoutes {
  if (!isRouteName(route)) throw new ModelRoutesError(routeNameRejection(route));
  return withProfile(v, profile, (p) => ({ ...p, routes: { ...p.routes, [route]: { chain, ...(effort ? { effort } : {}) } } }));
}

export function withoutRoute(v: ModelRoutes, profile: string, route: string): ModelRoutes {
  if (!isRouteName(route)) throw new ModelRoutesError(routeNameRejection(route));
  if (!v.profiles[profile]?.routes[route]) throw new ModelRoutesError(`profile '${profile}' sets no ${route} on the server: nothing to unset`);
  const { [route]: _gone, ...routes } = v.profiles[profile]!.routes;
  return validateModelRoutes({ ...v, profiles: { ...v.profiles, [profile]: { ...v.profiles[profile]!, routes } } });
}

export function withActive(v: ModelRoutes, profile: string): ModelRoutes {
  return validateModelRoutes({ ...v, active: checkProfileName(profile, "profile") });
}

/** `review` written onto `profile`, starting from what that profile runs on the server today. */
export function withProfileReview(v: ModelRoutes, profile: string, review: ReviewReaders): ModelRoutes {
  return withProfile(v, profile, (p) => ({ ...p, review: validateReviewReaders(review) }));
}

/** Add a reader or change its model. Throws ModelRoutesError. */
export function addReader(current: ReviewReaders, leg: string, model: string): ReviewReaders {
  try {
    return withReader(current, leg, model);
  } catch (e) {
    if (e instanceof ReviewReadersError) throw new ModelRoutesError(e.message);
    throw e;
  }
}

/** Remove a reader; refused, naming each tier, while a tier still lists it (take it off the tier first). */
export function removeReader(current: ReviewReaders, leg: string): ReviewReaders {
  if (current.readers[leg] === undefined) throw new ModelRoutesError(`no reader named '${leg}'`);
  const listed = REVIEW_TIERS.filter((t) => current.tiers[t].includes(leg));
  if (listed.length > 0) {
    throw new ModelRoutesError(`reader '${leg}' is still on tier ${listed.join(", ")}: take it off first (\`ob models reader tier <tier> <legs...>\`)`);
  }
  const readers = Object.fromEntries(Object.entries(current.readers).filter(([l]) => l !== leg));
  return validateReviewReaders({ readers, tiers: current.tiers });
}

/** Replace one tier's reader list. Throws ModelRoutesError. */
export function setReaderTier(current: ReviewReaders, tier: string, legs: string[]): ReviewReaders {
  if (!(REVIEW_TIERS as readonly string[]).includes(tier)) throw new ModelRoutesError(`unknown tier '${tier}' (use ${REVIEW_TIERS.join(", ")})`);
  try {
    return withTier(current, tier as ReviewTier, legs);
  } catch (e) {
    if (e instanceof ReviewReadersError) throw new ModelRoutesError(e.message);
    throw e;
  }
}

// --- loading -------------------------------------------------------------------------------------------------

export interface ServerRoutes {
  server: ModelRoutes;
  legacyReaders: ReviewReaders | null;
  tierModels: Record<SpinoffTier, string>;
  /** The raw `model_routes` text (empty when unset), for the cache. */
  raw: string;
}

/** The server half of the inputs. Throws (ModelRoutesError, ReviewReadersError, or the IO's own error). */
export async function loadServerRoutes(io: ConfigIO): Promise<ServerRoutes> {
  const [raw, legacy, tiers] = await Promise.all([io.get(MODEL_ROUTES_KEY), io.get(REVIEW_READERS_KEY), io.get(TIER_MODELS_KEY)]);
  const tierModels = parseTierModels(tiers);
  if (tierModels.error) throw new ModelRoutesError(tierModels.error);
  return {
    server: parseModelRoutes(raw),
    legacyReaders: legacy !== null && legacy.trim() !== "" ? parseReviewReaders(legacy) : null,
    tierModels: tierModels.models,
    raw: raw ?? "",
  };
}

export async function saveModelRoutes(io: ConfigIO, v: ModelRoutes): Promise<ModelRoutes> {
  const clean = validateModelRoutes(v);
  await io.set(MODEL_ROUTES_KEY, JSON.stringify(clean));
  return clean;
}

// --- the cache (sync readers: pacing) -----------------------------------------------------------------------
// Pacing (`ob next`, `ob usage`, a role brief) is synchronous and must never wait on the network, so it reads the
// last `model_routes` this machine saw, kept beside the models file. Every successful server read refreshes it.

export function routesCachePath(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(modelsFilePath(env)), "model-routes-cache.json");
}

export function writeRoutesCache(sr: ServerRoutes, env: Record<string, string | undefined> = process.env): void {
  try {
    const path = routesCachePath(env);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ model_routes: sr.raw, tier_models: sr.tierModels, at: new Date().toISOString() }) + "\n");
    renameSync(tmp, path);
  } catch {
    // a cache: a write that fails only means the next sync read is staler
  }
}

/** The cached server half, or empty: a cache never refuses. */
export function readRoutesCache(env: Record<string, string | undefined> = process.env): Pick<RouteInputs, "server" | "tierModels"> {
  const empty = { server: emptyModelRoutes(), tierModels: { ...DEFAULT_TIER_MODELS } };
  const path = routesCachePath(env);
  if (!existsSync(path)) return empty;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { model_routes?: string; tier_models?: Record<string, string> };
    const tierModels = { ...DEFAULT_TIER_MODELS };
    for (const t of SPINOFF_TIERS) if (typeof doc.tier_models?.[t] === "string") tierModels[t] = doc.tier_models[t]!;
    return { server: parseModelRoutes(doc.model_routes ?? ""), tierModels };
  } catch {
    return empty;
  }
}

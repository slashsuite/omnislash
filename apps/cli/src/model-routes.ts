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
// never written), else Opus (Neon its fallback), with the local file's `review` legs laid over the result.
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
  TIER_BANDS,
  TIER_COMPLEXITY,
  builderFormError,
  builderRangeOf,
  builderTierOf,
  isComplexity,
  rangeCoverError,
  rangeRoute,
  rangeText,
  type ComplexityRange,
  type RangeModel,
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
  storedReviewReaders,
  validateReviewReaders,
  withFallback,
  withReader,
  parseReviewRange,
  withRange,
  type ConfigIO,
  type ReviewRange,
  type ReviewReaders,
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
    const formError = builderFormError(Object.keys(routes));
    if (formError) throw new ModelRoutesError(`model_routes profile '${name}': ${formError}`);
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

/** The local file's own spec for a non-builder `route` in `profile`: its `routes`, else the old `checker` key. */
function localSpec(file: ModelsFile | null, profile: string | null, route: string): RouteSpec | null {
  if (!file || profile === null || !Object.hasOwn(file.profiles, profile)) return null;
  const p = file.profiles[profile]!;
  if (p.routes[route]) return p.routes[route]!;
  if (route === "checker" && p.checker) return { chain: [p.checker] };
  return null;
}

// --- OS-177: builder ranges ----------------------------------------------------------------------------------
// The builder routes are a SET of complexity ranges covering 1-10 (`builder.1-3`, `builder.4-6`, ...). A layer
// names them either in the range form, which replaces the whole set, or in the old tier form
// (`builder.simple|medium|complex`, the file's `builder` keys), which sets just the tier's band (1-3, 4-6, 7-10)
// and keeps the rest, as it always did. The default layer is `spinoff_tier_models` over the built-in tiers, as bands.

/** One band of a profile's builder set: its range, its chain and effort, and the layer it came from. */
export interface BuilderBand extends ComplexityRange {
  route: string;
  chain: string[];
  effort?: RouteEffort;
  source: RouteSource;
}

interface BuilderLayer {
  ranges: Array<ComplexityRange & { spec: RouteSpec }>;
  tiers: Partial<Record<SpinoffTier, RouteSpec>>;
}

function builderLayerOf(routes: Record<string, RouteSpec>, oldBuilder: Partial<Record<SpinoffTier, string>> = {}): BuilderLayer {
  const layer: BuilderLayer = { ranges: [], tiers: {} };
  for (const t of SPINOFF_TIERS) if (oldBuilder[t]) layer.tiers[t] = { chain: [oldBuilder[t]!] };
  for (const [route, spec] of Object.entries(routes)) {
    const range = builderRangeOf(route);
    if (range) layer.ranges.push({ ...range, spec });
    const tier = builderTierOf(route);
    if (tier) layer.tiers[tier] = spec; // a `routes` entry beats the old `builder` key, as it always did
  }
  return layer;
}

function band(range: ComplexityRange, s: RouteSpec, source: RouteSource): BuilderBand {
  return { from: range.from, to: range.to, route: rangeRoute(range), chain: [...s.chain], ...(s.effort ? { effort: s.effort } : {}), source };
}

/** `bands` with `range` cut out of whatever it overlaps, and `b` put in its place, sorted. Pure. */
function carve(bands: readonly BuilderBand[], b: BuilderBand): BuilderBand[] {
  const out: BuilderBand[] = [];
  for (const x of bands) {
    if (x.to < b.from || x.from > b.to) {
      out.push(x);
      continue;
    }
    if (x.from < b.from) out.push({ ...x, to: b.from - 1, route: rangeRoute({ from: x.from, to: b.from - 1 }) });
    if (x.to > b.to) out.push({ ...x, from: b.to + 1, route: rangeRoute({ from: b.to + 1, to: x.to }) });
  }
  out.push(b);
  return out.sort((a, c) => a.from - c.from);
}

function applyLayer(bands: BuilderBand[], layer: BuilderLayer, source: RouteSource): BuilderBand[] {
  if (layer.ranges.length > 0) return layer.ranges.map((r) => band(r, r.spec, source)).sort((a, c) => a.from - c.from);
  let out = bands;
  for (const t of SPINOFF_TIERS) if (layer.tiers[t]) out = carve(out, band(TIER_BANDS[t], layer.tiers[t]!, source));
  return out;
}

/** The default layer's set: `spinoff_tier_models` over the built-in tiers, one band per tier. Pure. */
function defaultBuilderBands(tierModels: Readonly<Record<SpinoffTier, string>>): BuilderBand[] {
  return (["simple", "medium", "complex"] as const).map((t) => band(TIER_BANDS[t], { chain: [tierModels[t]] }, "default"));
}

/**
 * The builder set `profile` runs: the default bands, then the server's, then this machine's file (`local: false`
 * leaves the file out, for a server write). Each band names the layer it came from. Pure.
 */
export function builderBandsIn(inputs: RouteInputs, profile: string | null, opts: { local?: boolean } = {}): BuilderBand[] {
  let bands = defaultBuilderBands(inputs.tierModels);
  if (profile === null) return bands;
  const server = inputs.server.profiles[profile];
  if (server) bands = applyLayer(bands, builderLayerOf(server.routes), "server");
  const file = opts.local === false ? undefined : inputs.file?.profiles[profile];
  if (file) bands = applyLayer(bands, builderLayerOf(file.routes, file.builder), "local");
  return bands;
}

/** The band covering score `c` in `profile`. Pure. */
export function builderBandAt(inputs: RouteInputs, c: number, profile: string | null): BuilderBand {
  return builderBandsIn(inputs, profile).find((b) => b.from <= c && c <= b.to)!;
}

/** Each band's first model in the active profile: what a launch picks its builder model from. Pure. */
export function builderModelsOf(inputs: RouteInputs, profile: string | null = activeProfileOf(inputs).name): RangeModel[] {
  return builderBandsIn(inputs, profile).map((b) => ({ from: b.from, to: b.to, model: b.chain[0]! }));
}

/** `1-3, 4-6, 7-10`: a set's ranges, for a refusal. Pure. */
function rangesText(bands: readonly ComplexityRange[]): string {
  return bands.map(rangeText).join(", ");
}

function bandRoute(route: string, profile: string | null, b: BuilderBand): ResolvedRoute {
  return { route, profile, chain: [...b.chain], ...(b.effort ? { effort: b.effort } : {}), source: b.source };
}

/** The score role threads and jobs run at: the old `builder.complex` (they take its chain, as before OS-177). */
const ROLE_COMPLEXITY = TIER_COMPLEXITY.complex;

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

/** A role thread, and a builder band still on the defaults, names its provider: a bare id runs on Claude. Pure. */
export function withProvider(model: string): string {
  return splitTierModel(model)?.providerInstanceId ? model : `claudeAgent:${model}`;
}

function spec(route: string, profile: string | null, s: RouteSpec, source: RouteSource): ResolvedRoute {
  return { route, profile, chain: [...s.chain], ...(s.effort ? { effort: s.effort } : {}), source };
}

/** One route in one profile (`profile` null = no profile: defaults only). Throws on a name that is no route. Pure. */
export function resolveRouteIn(inputs: RouteInputs, route: string, profile: string | null): ResolvedRoute {
  if (!isRouteName(route)) throw new ModelRoutesError(routeNameRejection(route));
  const range = builderRangeOf(route);
  if (range) {
    const bands = builderBandsIn(inputs, profile);
    const b = bands.find((x) => x.from === range.from && x.to === range.to);
    if (!b) throw new ModelRoutesError(`${profile === null ? "the defaults have" : `profile '${profile}' has`} no ${route}: its builder ranges are ${rangesText(bands)}`);
    return bandRoute(route, profile, b);
  }
  const tier = builderTierOf(route);
  if (tier) return bandRoute(route, profile, builderBandAt(inputs, TIER_COMPLEXITY[tier], profile));
  const local = localSpec(inputs.file, profile, route);
  if (local) return spec(route, profile, local, "local");
  const server = serverSpec(inputs.server, profile, route);
  if (server) return spec(route, profile, server, "server");
  if (route === "checker") return { route, profile, chain: [DEFAULT_CHECKER], source: "default" };
  if (route.startsWith("role.")) {
    // Today's behaviour: a role thread opens on builder.complex when a profile names it, else Opus on Claude.
    // The `spinoff_tier_models` setting never reached role threads, so the default layer's builder.complex does not either.
    const complex = bandRoute("builder.complex", profile, builderBandAt(inputs, ROLE_COMPLEXITY, profile));
    if (complex.source === "default") return { route, profile, chain: [DEFAULT_ROLE_MODEL], source: "default" };
    return { route, profile, chain: [...new Set(complex.chain.map(withProvider))], ...(complex.effort ? { effort: complex.effort } : {}), source: complex.source, via: "builder.complex" };
  }
  if (route.startsWith("job.")) {
    const complex = bandRoute("builder.complex", profile, builderBandAt(inputs, ROLE_COMPLEXITY, profile));
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

/** One attempt of a builder launch: the model, its profile, and that profile's band (its route name and effort). */
export interface BuilderAttempt extends RouteAttempt {
  route: string;
  effort?: RouteEffort;
}

/**
 * The models a builder launch at score `c` tries, in order (OS-177): the band covering `c` in the active profile,
 * then the band covering `c` in each fallback profile, whatever ranges each profile splits 1-10 into. A model
 * already listed is not tried twice. Pure.
 */
export function builderAttempts(inputs: RouteInputs, c: number): BuilderAttempt[] {
  const order = profileOrderOf(inputs);
  const out: BuilderAttempt[] = [];
  const seen = new Set<string>();
  for (const profile of order.length > 0 ? order : [null]) {
    const b = builderBandAt(inputs, c, profile);
    for (const model of b.chain) {
      if (seen.has(model)) continue;
      seen.add(model);
      out.push({ profile, model, route: b.route, ...(b.effort ? { effort: b.effort } : {}) });
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
    if (readers[canonical]) readers[canonical] = { ...readers[canonical], model };
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
  // A write with no profile named, on a fresh setting, lands on `default` and makes it active, so it takes effect.
  // A profile named on purpose (`--profile`) is only made ready: `ob models use` puts it live.
  if (next.active === null && profile === DEFAULT_PROFILE) next.active = profile;
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

/**
 * OS-239: a builder or role route must name its provider. A bare id runs on each T3 project's own default
 * provider, so on 2026-11-26 a bare `claude-opus-5-5` sent one project's builders to Gemini and made projects with
 * no default refuse every launch. Other routes (`checker`, `sweep.*`, `job.*`) keep taking a bare id.
 */
export function needsProvider(route: string): boolean {
  return route.startsWith("builder.") || route.startsWith("role.");
}

/** The bare ids in a builder or role route's chain; empty for any other route. Pure. */
export function bareModelsOf(route: string, chain: readonly string[]): string[] {
  return needsProvider(route) ? chain.filter((m) => splitTierModel(m)?.providerInstanceId === null) : [];
}

/** The refusal for a bare id on a builder or role route, or null. Pure. */
export function bareModelRefusal(route: string, chain: readonly string[]): string | null {
  const bare = bareModelsOf(route, chain);
  if (bare.length === 0) return null;
  const first = bare[0]!;
  return `${route}: model ${bare.map((m) => `'${m}'`).join(", ")} has no provider: a builder or role route without one runs on each T3 project's own default model. Give it as <provider>:<model>, such as claudeAgent:${first}`;
}

/** Check an effort level by name. Pure. */
export function checkEffort(level: string): RouteEffort {
  if (!isRouteEffort(level)) throw new ModelRoutesError(`effort '${level}' is not an effort level (use ${EFFORT_LEVELS.join(", ")})`);
  return level;
}

/** Is any route of this set in the range form? */
function hasRanges(routes: Record<string, RouteSpec>): boolean {
  return Object.keys(routes).some((r) => builderRangeOf(r) !== null);
}

/** Does this server set cover 1-10 by itself: a range set (validated complete), or all three old tier keys? */
function ownsFullBuilderSet(routes: Record<string, RouteSpec>): boolean {
  return hasRanges(routes) || SPINOFF_TIERS.every((t) => routes[`builder.${t}`] !== undefined);
}

/** `routes` without any builder route (either form). */
function withoutBuilder(routes: Record<string, RouteSpec>): Record<string, RouteSpec> {
  return Object.fromEntries(Object.entries(routes).filter(([r]) => !r.startsWith("builder.")));
}

/**
 * Set `route` in `profile` on the server (OS-145, OS-177 for the builder ranges):
 * - `builder.<from>-<to>` carves the range into the profile's own server builder set, trimming what it overlaps,
 *   and stores the whole set in the range form. A profile with no full set of its own takes only `builder.1-10`,
 *   so the defaults are never copied onto the server (the range covering 8 would then feed role threads).
 * - `builder.simple|medium|complex` on a profile still in the old form (or with no builder routes) stores the
 *   old key, as before. On a profile in the range form it sets the tier's band when exactly that range exists,
 *   and is refused, naming the ranges, otherwise.
 */
export function withRoute(v: ModelRoutes, profile: string, route: string, chain: string[], effort?: RouteEffort, tierModels: Readonly<Record<SpinoffTier, string>> = DEFAULT_TIER_MODELS): ModelRoutes {
  if (!isRouteName(route)) throw new ModelRoutesError(routeNameRejection(route));
  const bare = bareModelRefusal(route, chain);
  if (bare) throw new ModelRoutesError(bare);
  const s: RouteSpec = { chain, ...(effort ? { effort } : {}) };
  const own = v.profiles[profile]?.routes ?? {};
  const range = builderRangeOf(route);
  const tier = builderTierOf(route);
  if (range) {
    if (!ownsFullBuilderSet(own) && !(range.from === 1 && range.to === 10)) {
      throw new ModelRoutesError(`profile '${profile}' has no full builder set on the server, so ${route} would copy the defaults into it: set builder.1-10 <model> first (\`ob models set builder.1-10 <model>\`), then carve ${rangeText(range)} out of it`);
    }
    const inputs = emptyRouteInputs({ server: v, tierModels });
    const bands = carve(builderBandsIn(inputs, profile, { local: false }), band(range, s, "server"));
    const ranges = Object.fromEntries(bands.map((b) => [b.route, { chain: b.chain, ...(b.effort ? { effort: b.effort } : {}) }]));
    return withProfile(v, profile, (p) => ({ ...p, routes: { ...withoutBuilder(p.routes), ...ranges } }));
  }
  if (tier && hasRanges(own)) {
    const want = rangeRoute(TIER_BANDS[tier]);
    if (!own[want]) {
      const set = Object.keys(own).map(builderRangeOf).filter((r): r is ComplexityRange => r !== null).sort((a, b) => a.from - b.from);
      throw new ModelRoutesError(`profile '${profile}' splits the builder into the ranges ${rangesText(set)}, so ${route} (${rangeText(TIER_BANDS[tier])}) is not one of them: set a range (\`ob models set builder.<from>-<to> <model>\`)`);
    }
    return withProfile(v, profile, (p) => ({ ...p, routes: { ...p.routes, [want]: s } }));
  }
  return withProfile(v, profile, (p) => ({ ...p, routes: { ...p.routes, [route]: s } }));
}

/** One range of a whole builder set, as the dashboard's range editor sends it. */
export interface BuilderRangeEdit extends ComplexityRange {
  chain: string[];
  effort?: RouteEffort;
}

/**
 * Replace `profile`'s whole server builder set with `ranges` (OS-176, the dashboard's range editor). The set must
 * cover 1-10 with no gap or overlap; a refusal is the same `rangeCoverError` text the CLI gives, under the
 * `model_routes profile '<name>':` prefix `validateModelRoutes` puts on it. Checked on the list, so two equal
 * ranges are an overlap rather than one silently replacing the other. Pure.
 */
export function withBuilderRanges(v: ModelRoutes, profile: string, ranges: readonly BuilderRangeEdit[]): ModelRoutes {
  for (const r of ranges) {
    if (!isComplexity(r.from) || !isComplexity(r.to) || r.from > r.to) {
      throw new ModelRoutesError(`model_routes profile '${profile}': builder range ${String(r.from)}-${String(r.to)} must be whole numbers 1 to 10, from no higher than to`);
    }
  }
  const cover = rangeCoverError(ranges);
  if (cover) throw new ModelRoutesError(`model_routes profile '${profile}': ${cover}`);
  for (const r of ranges) {
    const bare = bareModelRefusal(rangeRoute(r), r.chain);
    if (bare) throw new ModelRoutesError(`model_routes profile '${profile}': ${bare}`);
  }
  const set = Object.fromEntries(ranges.map((r) => [rangeRoute(r), { chain: [...r.chain], ...(r.effort ? { effort: r.effort } : {}) }]));
  return withProfile(v, profile, (p) => ({ ...p, routes: { ...withoutBuilder(p.routes), ...set } }));
}

/** `ob models unset builder`: the profile's whole builder set off the server, back to the defaults. */
export const BUILDER_SET = "builder";

export function withoutRoute(v: ModelRoutes, profile: string, route: string): ModelRoutes {
  if (route === BUILDER_SET) {
    const routes = v.profiles[profile]?.routes ?? {};
    if (!Object.keys(routes).some((r) => r.startsWith("builder."))) throw new ModelRoutesError(`profile '${profile}' sets no builder routes on the server: nothing to unset`);
    return validateModelRoutes({ ...v, profiles: { ...v.profiles, [profile]: { ...v.profiles[profile]!, routes: withoutBuilder(routes) } } });
  }
  if (!isRouteName(route)) throw new ModelRoutesError(routeNameRejection(route));
  const own = v.profiles[profile]?.routes ?? {};
  const range = builderRangeOf(route) ?? (builderTierOf(route) && hasRanges(own) ? TIER_BANDS[builderTierOf(route)!] : null);
  if (range && hasRanges(own)) {
    if (!own[rangeRoute(range)]) throw new ModelRoutesError(`profile '${profile}' sets no ${rangeRoute(range)} on the server: nothing to unset`);
    throw new ModelRoutesError(`unsetting ${route} would leave a gap at ${rangeText(range)} in profile '${profile}': set another range over it (\`ob models set builder.<from>-<to> <model>\`), or unset the whole builder set (\`ob models unset builder\`)`);
  }
  if (!v.profiles[profile]?.routes[route]) throw new ModelRoutesError(`profile '${profile}' sets no ${route} on the server: nothing to unset`);
  const { [route]: _gone, ...routes } = v.profiles[profile]!.routes;
  return validateModelRoutes({ ...v, profiles: { ...v.profiles, [profile]: { ...v.profiles[profile]!, routes } } });
}

export function withActive(v: ModelRoutes, profile: string): ModelRoutes {
  return validateModelRoutes({ ...v, active: checkProfileName(profile, "profile") });
}

/**
 * Put `name` live for everyone (`ob models use`, the dashboard's Models page). The server's active is every
 * machine's, so it may only name a profile the server defines; one only in this machine's file is refused by name.
 */
export function useProfile(inputs: RouteInputs, name: string): ModelRoutes {
  if (!Object.hasOwn(inputs.server.profiles, name)) {
    const known = Object.keys(inputs.server.profiles);
    const localOnly = inputs.file && Object.hasOwn(inputs.file.profiles, name) ? ` (it is only in this machine's models file: set "active" there for this machine)` : "";
    throw new ModelRoutesError(`unknown profile '${name}': the server defines no such profile${localOnly} (server profiles: ${known.join(", ") || "none"}); \`ob models set <route> <model> --profile ${name}\` creates it`);
  }
  return withActive(inputs.server, name);
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

/** Remove a reader; refused, naming each range, while a range still lists it (take it off the range first). */
/** Set or clear the reader that stands in for `leg` when it is unavailable. Throws ModelRoutesError. */
export function setReaderFallback(current: ReviewReaders, leg: string, fallback: string | null): ReviewReaders {
  try {
    return withFallback(current, leg, fallback);
  } catch (e) {
    if (e instanceof ReviewReadersError) throw new ModelRoutesError(e.message);
    throw e;
  }
}

export function removeReader(current: ReviewReaders, leg: string): ReviewReaders {
  if (current.readers[leg] === undefined) throw new ModelRoutesError(`no reader named '${leg}'`);
  const listed = current.tiers.filter((r) => r.legs.includes(leg)).map(rangeText);
  if (listed.length > 0) {
    throw new ModelRoutesError(`reader '${leg}' is still on range ${listed.join(", ")}: take it off first (\`ob models reader range <from-to> <legs...>\`)`);
  }
  const readers = Object.fromEntries(Object.entries(current.readers).filter(([l]) => l !== leg));
  return validateReviewReaders({ readers, tiers: current.tiers });
}

/** Replace one complexity range's reader list (`4-6`, or one score `5`), carving it out of the ranges it overlaps. Throws ModelRoutesError. */
export function setReaderRange(current: ReviewReaders, range: string, legs: string[]): ReviewReaders {
  const r = parseReviewRange(range);
  if (!r) throw new ModelRoutesError(`'${range}' is not a complexity range (use <from>-<to> inside 1-10, such as 4-6)`);
  try {
    return withRange(current, r, legs);
  } catch (e) {
    if (e instanceof ReviewReadersError) throw new ModelRoutesError(e.message);
    throw e;
  }
}

/** Replace every review range at once (OS-176, the dashboard's range editor). Throws ModelRoutesError with the CLI's gap and overlap text. */
export function setReaderRanges(current: ReviewReaders, ranges: ReviewRange[]): ReviewReaders {
  try {
    return validateReviewReaders({ readers: current.readers, tiers: ranges });
  } catch (e) {
    if (e instanceof ReviewReadersError) throw new ModelRoutesError(e.message);
    throw e;
  }
}

/** The old verb: a tier name is its band (simple 1-3, medium 4-6, complex 7-10). Kept as an alias for one release (OS-175). */
export function setReaderTier(current: ReviewReaders, tier: string, legs: string[]): ReviewReaders {
  if (!(REVIEW_TIERS as readonly string[]).includes(tier)) throw new ModelRoutesError(`unknown tier '${tier}' (use ${REVIEW_TIERS.join(", ")}, or a range: \`reader range <from-to>\`)`);
  return setReaderRange(current, rangeText(TIER_BANDS[tier as SpinoffTier]), legs);
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
  // A profile's review is written in the form older readers still parse where it can be (storedReviewReaders).
  const profiles = Object.fromEntries(
    Object.entries(clean.profiles).map(([name, p]) => [name, p.review ? { ...p, review: storedReviewReaders(p.review) } : p]),
  );
  await io.set(MODEL_ROUTES_KEY, JSON.stringify({ ...clean, profiles }));
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

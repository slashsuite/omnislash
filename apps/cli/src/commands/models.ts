import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { print, warn } from "../output.ts";
import { ModelsFileError, TIER_BANDS, TIER_COMPLEXITY, builderRangeOf, builderTierOf, initModelsFile, loadModelsFile, modelsFilePath, tierOfComplexity, type ModelsFile } from "../models-file.ts";
import { CREDIT_HIT_WINDOW_HOURS, recentCreditHits } from "../models-credit.ts";
import { formatTrendLine, legTrend, readLegRecords } from "../review-legs.ts";
import { REVIEW_TIERS, ReviewReadersError, type ReviewReaders } from "../review-readers.ts";
import {
  BUILDER_SET,
  ModelRoutesError,
  activeProfileOf,
  builderBandAt,
  builderBandsIn,
  addReader,
  checkEffort,
  parseChain,
  profileOrderOf,
  removeReader,
  resolveAllRoutes,
  resolveReview,
  resolveRoute,
  serverReview,
  setReaderTier,
  sourceLabel,
  useProfile,
  withProfileReview,
  withRoute,
  withoutRoute,
  writeProfile,
  type BuilderBand,
  type ResolvedRoute,
  type RouteInputs,
} from "../model-routes.ts";
import { editModelRoutes, loadRouteInputs, machineConfigIo } from "../model-routes-io.ts";
import { providerOverWeeklyLimit } from "./usage.ts";

// -----------------------------------------------------------------------------
// `ob models` (OB-1969, OS-145): which model runs every use. One server setting, `model_routes`, holds the profiles
// and their routes; this machine's models file (~/.config/ob/models.jsonc) overrides any route of any profile
// here. Reads go to the API server when this machine is a client, else the store. Every write validates through
// model-routes.ts. `list`, `init` and `legs` read only this machine.
// -----------------------------------------------------------------------------

const USAGE = [
  "ob models show [--json]",
  "ob models get <route>",
  "ob models set <route> <model>[,<model>...] [--effort low|medium|high|xhigh|max] [--profile <p>]",
  "ob models unset <route>|builder [--profile <p>]",
  "ob models use <profile>",
  "ob models reader add <leg> <model> [--profile <p>]",
  "ob models reader remove <leg> [--profile <p>]",
  "ob models reader tier <tier> <leg>... [--profile <p>]",
  "ob models list | init | legs [--days <n>]",
].join("\n");

function loadOrRefuse(): ModelsFile | null {
  try {
    return loadModelsFile();
  } catch (e) {
    if (e instanceof ModelsFileError) throw new AppError(e.message);
    throw e;
  }
}

/** Run `fn`, turning the routing module's own errors into named refusals. */
async function refusing<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ModelRoutesError || e instanceof ReviewReadersError || e instanceof ModelsFileError) throw new AppError(e.message);
    throw e;
  }
}

async function io(ctx: Ctx) {
  return machineConfigIo(ctx.store ?? ctx.db);
}

function profileFlag(ctx: Ctx): string | undefined {
  return ctx.flags.profile;
}

function chainText(r: ResolvedRoute): string {
  return `${r.chain.join(", ")}${r.effort ? ` (effort ${r.effort})` : ""}`;
}

/**
 * What `show` calls a band. The standard split (1-3, 4-6, 7-10) keeps its tier names (`builder.simple`), so a file in
 * use today prints exactly as it did before OS-177; any other split prints its ranges with their tier labels
 * (`builder.4-4 (medium)`).
 */
function bandName(b: BuilderBand, standard: boolean): string {
  if (standard) return `builder.${tierOfComplexity(b.from)}`;
  const label = tierOfComplexity(b.from) === tierOfComplexity(b.to) ? tierOfComplexity(b.from) : `${tierOfComplexity(b.from)}-${tierOfComplexity(b.to)}`;
  return `${b.route} (${label})`;
}

function bandChainText(b: BuilderBand): string {
  return `${b.chain.join(", ")}${b.effort ? ` (effort ${b.effort})` : ""}`;
}

/** The score a builder route's own band is found by: a range's low end, or a tier's alias value. Null for any other route. */
function builderScoreOf(route: string): number | null {
  const range = builderRangeOf(route);
  if (range) return range.from;
  const tier = builderTierOf(route);
  return tier ? TIER_COMPLEXITY[tier] : null;
}

function activeLine(inputs: RouteInputs): string {
  const a = activeProfileOf(inputs);
  if (a.name === null) return "active profile: (none: every route uses its default)";
  const where = a.source === "local" ? `this machine's models file${a.hiddenServer ? `, hiding the server's '${a.hiddenServer}'` : ""}` : "server";
  return `active profile: ${a.name} [${where}]${a.undefinedProfile ? " (no layer defines it: every route uses its default)" : ""}`;
}

function readersText(v: ReviewReaders): string[] {
  return REVIEW_TIERS.map((t) => `  ${t.padEnd(7)} ${v.tiers[t].map((l) => `${l}=${v.readers[l]!.model}`).join(", ")}`);
}

async function show(ctx: Ctx): Promise<void> {
  const inputs = await refusing(async () => loadRouteInputs(await io(ctx), { quiet: true, lenient: true }));
  const routes = resolveAllRoutes(inputs);
  const review = resolveReview(inputs);
  const active = activeProfileOf(inputs);
  const bands = builderBandsIn(inputs, active.name);
  const hits = recentCreditHits();
  if (ctx.mode === "json") {
    print(
      JSON.stringify(
        {
          file: modelsFilePath(),
          present: inputs.file !== null,
          active: active.name,
          active_source: active.source,
          hidden_server_active: active.hiddenServer ?? null,
          order: profileOrderOf(inputs),
          server_error: inputs.serverError,
          credit_hits: hits,
          // builder.simple|medium|complex stay here as the bands covering 2, 5 and 8 (the dashboard reads them until OS-177 part C).
          routes: routes.map((r) => ({ route: r.route, profile: r.profile, chain: r.chain, effort: r.effort ?? null, source: r.source, label: sourceLabel(r) })),
          builder_ranges: bands.map((b) => ({ route: b.route, from: b.from, to: b.to, chain: b.chain, effort: b.effort ?? null, source: b.source })),
          review: { profile: review.profile, source: review.source, ...review.value },
        },
        null,
        2,
      ),
    );
    return;
  }
  if (ctx.mode === "quiet") {
    print([...bands.map((b) => `${b.route}\t${b.chain.join(",")}\t${b.source}`), ...routes.filter((r) => !r.route.startsWith("builder.")).map((r) => `${r.route}\t${r.chain.join(",")}\t${sourceLabel(r)}`)].join("\n"));
    return;
  }
  const order = profileOrderOf(inputs);
  const lines = [
    inputs.file ? `models file: ${inputs.file.path}` : `models file: ${modelsFilePath()} (none)`,
    activeLine(inputs),
    ...(order.length > 1 ? [`fallback order: ${order.join(" -> ")}`] : []),
  ];
  if (inputs.serverError) lines.push(`note: model_routes could not be read from the server (${inputs.serverError}); showing this machine's file and the defaults`);
  if (Object.keys(hits).length > 0) {
    lines.push(`out of credits in the last ${CREDIT_HIT_WINDOW_HOURS}h: ${Object.entries(hits).map(([p, at]) => `${p} (${at})`).join(", ")}`);
  }
  lines.push("");
  // The builder set prints as its ranges (OS-177), each with its tier label; the other routes as before.
  const others = routes.filter((r) => !r.route.startsWith("builder."));
  const standard = bands.length === 3 && bands.every((b) => b.from === TIER_BANDS[tierOfComplexity(b.from)].from && b.to === TIER_BANDS[tierOfComplexity(b.from)].to);
  const width = Math.max(...others.map((r) => r.route.length), ...bands.map((b) => bandName(b, standard).length));
  for (const b of bands) lines.push(`${bandName(b, standard).padEnd(width)}  ${bandChainText(b)}   [${b.source}]`);
  for (const r of others) lines.push(`${r.route.padEnd(width)}  ${chainText(r)}   [${sourceLabel(r)}]`);
  lines.push("", `review readers [${review.source}]:`, ...readersText(review.value));
  print(lines.join("\n"));
}

/** `ob models get <route>`: the model to run now. The chain's first entry whose provider is under its weekly limit. */
async function get(ctx: Ctx): Promise<void> {
  const route = ctx.args[1];
  if (!route) throw new UsageError("usage: ob models get <route>");
  const r = await refusing(async () => resolveRoute(await loadRouteInputs(await io(ctx)), route));
  print(pickUnderLimit(r.chain));
}

/** The first model whose provider is not over its weekly limit; the first model when none is, or a reading fails. */
export function pickUnderLimit(chain: readonly string[], over: (model: string) => boolean | null = (m) => providerOverWeeklyLimit(m)): string {
  for (const model of chain) {
    let o: boolean | null;
    try {
      o = over(model);
    } catch {
      o = null;
    }
    if (o === null) return chain[0]!;
    if (!o) return model;
  }
  return chain[0]!;
}

/** The one-line warning a server write owes when this machine's file hides it. */
function localHidesWarning(inputs: RouteInputs, profile: string, route: string): void {
  const f = inputs.file?.profiles[profile];
  if (!f) return;
  const score = builderScoreOf(route);
  if (score !== null) {
    const b = builderBandAt(inputs, score, profile);
    if (b.source === "local") warn(`note: this machine's models file sets ${b.route} for profile '${profile}', so here complexity ${score} still runs ${b.chain.join(", ")}`);
    return;
  }
  const r = resolveRoute({ ...inputs, server: { ...inputs.server, active: profile }, file: { ...inputs.file!, active: profile } }, route);
  if (r.source === "local") warn(`note: this machine's models file sets ${route} for profile '${profile}', so here it still runs ${r.chain.join(", ")}`);
}

async function set(ctx: Ctx): Promise<void> {
  const [, route, models] = ctx.args;
  if (!route || !models) throw new UsageError("usage: ob models set <route> <model>[,<model>...] [--effort <lvl>] [--profile <p>]");
  const rawEffort = ctx.flags.effort;
  const named = profileFlag(ctx);
  await refusing(async () => {
    const chain = parseChain(models);
    const effort = rawEffort === undefined ? undefined : checkEffort(rawEffort);
    let profile = "";
    const { inputs } = await editModelRoutes(await io(ctx), (inputs) => {
      profile = writeProfile(inputs, named);
      return withRoute(inputs.server, profile, route, chain, effort, inputs.tierModels);
    });
    print(`${route} = ${chain.join(", ")}${effort ? ` (effort ${effort})` : ""} [server, profile ${profile}]`);
    localHidesWarning(inputs, profile, route);
  });
}

async function unset(ctx: Ctx): Promise<void> {
  const route = ctx.args[1];
  if (!route) throw new UsageError("usage: ob models unset <route> [--profile <p>]");
  const named = profileFlag(ctx);
  await refusing(async () => {
    let profile = "";
    const { inputs } = await editModelRoutes(await io(ctx), (inputs) => {
      profile = writeProfile(inputs, named);
      return withoutRoute(inputs.server, profile, route);
    });
    if (route === BUILDER_SET) {
      const now = builderBandsIn(inputs, profile);
      print(`builder unset in profile ${profile}: now ${now.map((b) => `${b.route} ${bandChainText(b)} [${b.source}]`).join("; ")}`);
      return;
    }
    const now = resolveRoute({ ...inputs, server: { ...inputs.server, active: profile }, file: inputs.file ? { ...inputs.file, active: profile } : null }, route);
    print(`${route} unset in profile ${profile}: now ${chainText(now)} [${sourceLabel(now)}]`);
  });
}

async function use(ctx: Ctx): Promise<void> {
  const name = ctx.args[1];
  if (!name) throw new UsageError("usage: ob models use <profile>");
  await refusing(async () => {
    let was: string | null = null;
    const { inputs } = await editModelRoutes(await io(ctx), (inputs) => {
      was = inputs.server.active;
      return useProfile(inputs, name);
    });
    print(`active profile: ${name} on the server (was ${was ?? "none"})`);
    const local = inputs.file?.active ?? null;
    if (local && local !== name) warn(`note: this machine's models file sets active '${local}', which still wins here (remove its "active" to follow the server)`);
  });
}

async function reader(ctx: Ctx): Promise<void> {
  const [, verb, ...rest] = ctx.args;
  const named = profileFlag(ctx);
  const change = (v: ReviewReaders): ReviewReaders => {
    if (verb === "add") {
      const [leg, model] = rest;
      if (!leg || !model) throw new UsageError("usage: ob models reader add <leg> <model>");
      return addReader(v, leg, model);
    }
    if (verb === "remove") {
      const [leg] = rest;
      if (!leg) throw new UsageError("usage: ob models reader remove <leg>");
      return removeReader(v, leg);
    }
    if (verb === "tier") {
      const [tier, ...legs] = rest;
      if (!tier || legs.length === 0) throw new UsageError("usage: ob models reader tier <tier> <leg>...");
      return setReaderTier(v, tier, legs);
    }
    throw new UsageError(`unknown models reader subcommand '${verb ?? ""}' (add|remove|tier)`);
  };
  await refusing(async () => {
    let profile = "";
    const { next } = await editModelRoutes(await io(ctx), (inputs) => {
      profile = writeProfile(inputs, named);
      return withProfileReview(inputs.server, profile, change(serverReview(inputs, profile).value));
    });
    const review = next.profiles[profile]!.review!;
    if (ctx.mode === "json") return print(JSON.stringify({ profile, ...review }, null, 2));
    print([`review readers [server, profile ${profile}]:`, ...readersText(review)].join("\n"));
  });
}

function list(ctx: Ctx): void {
  const file = loadOrRefuse();
  if (!file) {
    if (ctx.mode === "json") print(JSON.stringify({ file: modelsFilePath(), present: false, active: null, profiles: [] }));
    else print(`no models file at ${modelsFilePath()} (\`ob models init\` creates one)`);
    return;
  }
  const names = Object.keys(file.profiles);
  const hits = recentCreditHits();
  if (ctx.mode === "json") print(JSON.stringify({ file: file.path, present: true, active: file.active, profiles: names, credit_hits: hits }, null, 2));
  else if (ctx.mode === "quiet") print(names.join("\n"));
  else print(names.map((n) => `${n === file.active ? "*" : " "} ${n}${hits[n] ? `   (out of credits at ${hits[n]})` : ""}`).join("\n"));
}

function init(): void {
  const path = modelsFilePath();
  if (existsSync(path)) throw new AppError(`${path} already exists: refusing to overwrite it (edit it, or move it aside first)`);
  initModelsFile(path, join(import.meta.dir, "..", "..", "models.example.jsonc"));
  print(`wrote ${path} (one profile, 'claude'); edit it, then \`ob models show\``);
}

/** `ob models legs [--days <n>] [--json]` (OB-2133): the skeptical-review legs' run trend per model per day. */
function legs(ctx: Ctx): void {
  const raw = ctx.flags.days;
  const days = raw === undefined ? 14 : Number(raw);
  if (!Number.isInteger(days) || days < 1) throw new UsageError(`--days takes a whole number of days, 1 or more (got '${raw}')`);
  const groups = legTrend(readLegRecords(), { days, now: new Date() });
  if (ctx.mode === "json") return print(JSON.stringify({ days, groups }, null, 2));
  if (groups.length === 0) return print(`no review leg records in the last ${days} days`);
  print(groups.map(formatTrendLine).join("\n"));
}

export async function cmdModels(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0] ?? "show";
  if (sub === "show") return show(ctx);
  if (sub === "get") return get(ctx);
  if (sub === "set") return set(ctx);
  if (sub === "unset") return unset(ctx);
  if (sub === "use") return use(ctx);
  if (sub === "reader") return reader(ctx);
  if (sub === "list") return list(ctx);
  if (sub === "init") return init();
  if (sub === "legs") return legs(ctx);
  throw new UsageError(`unknown models subcommand '${sub}'\n${USAGE}`);
}

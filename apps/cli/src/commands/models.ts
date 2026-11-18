import { defineSeam } from "../test-seams.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { print } from "../output.ts";
import { settingFor } from "../settings.ts";
import { resolveApiBase, resolveApiToken } from "../api/config.ts";
import { ApiClient } from "../api/client.ts";
import { DEFAULT_TIER_MODELS, parseTierModels } from "../t3/dispatch.ts";
import {
  DEFAULT_CHECKER,
  DEFAULT_REVIEW_MODELS,
  canonicalLeg,
  reviewModelFor,
  ModelsFileError,
  SPINOFF_TIERS,
  activeProfile,
  initModelsFile,
  loadModelsFile,
  modelsFilePath,
  writeActive,
  type ModelsFile,
} from "../models-file.ts";
import { CREDIT_HIT_WINDOW_HOURS, recentCreditHits } from "../models-credit.ts";
import { formatTrendLine, legTrend, readLegRecords } from "../review-legs.ts";

// -----------------------------------------------------------------------------
// `ob models [show|list|use <profile>|init]` (OB-1969): the machine's models file. Runs on THIS machine,
// because the file is local to the machine that launches. Only `show` looks at the tracker, for the
// `spinoff_tier_models` setting, and only to say where each role's model came from.
// -----------------------------------------------------------------------------

type ModelSource = "file" | "setting" | "default";

interface ModelRole {
  role: string;
  model: string;
  source: ModelSource;
  /** `file` only: the profile that supplied it. */
  profile?: string;
}

const tierSettingSeam = defineSeam<((ctx: Ctx) => Promise<string | null>) | null>("commands/models.tierSettingReader", null);
/** Test seam: replace the read of `spinoff_tier_models`; `null` puts the real read back. */
export function __setTierSettingReader(r: ((ctx: Ctx) => Promise<string | null>) | null): void {
  tierSettingSeam.set(r);
}

/** `spinoff_tier_models`, raw. `null` when this machine cannot read it (the caller says so). */
async function readTierSetting(ctx: Ctx): Promise<string | null> {
  const tierSettingReader = tierSettingSeam.get();
  if (tierSettingReader) return tierSettingReader(ctx);
  try {
    const base = resolveApiBase();
    if (base) {
      const cfg = (await new ApiClient({ base, token: resolveApiToken() }).spinoffConfig()).config;
      return cfg.tier_models ?? "";
    }
    return await settingFor(ctx.store ?? ctx.db, "spinoff_tier_models");
  } catch {
    return null;
  }
}

function loadOrRefuse(): ModelsFile | null {
  try {
    return loadModelsFile();
  } catch (e) {
    if (e instanceof ModelsFileError) throw new AppError(e.message);
    throw e;
  }
}

/** Every role, its model and where it came from. Pure given its inputs. */
function describeRoles(file: ModelsFile | null, tierSetting: string): ModelRole[] {
  const profile = activeProfile(file);
  const parsed = parseTierModels(tierSetting);
  if (parsed.error) throw new AppError(`${parsed.error}: fix it with \`ob config set spinoff_tier_models '<json>'\``);
  // parseTierModels has already refused a non-JSON value, so this parse cannot fail.
  const named = new Set(Object.keys(tierSetting.trim() ? (JSON.parse(tierSetting) as Record<string, unknown>) : {}));
  const roles: ModelRole[] = [];
  for (const tier of SPINOFF_TIERS) {
    const fromFile = profile?.builder[tier];
    if (fromFile) roles.push({ role: `builder.${tier}`, model: fromFile, source: "file", profile: file!.active });
    else if (named.has(tier)) roles.push({ role: `builder.${tier}`, model: parsed.models[tier], source: "setting" });
    else roles.push({ role: `builder.${tier}`, model: DEFAULT_TIER_MODELS[tier], source: "default" });
  }
  roles.push(
    profile?.checker
      ? { role: "checker", model: profile.checker, source: "file", profile: file!.active }
      : { role: "checker", model: DEFAULT_CHECKER, source: "default" },
  );
  // OB-2107: an alias (`review.sonnet`) is shown as the leg it feeds (`review.opus`), not as a leg of its own.
  const legs = new Set<string>([...Object.keys(DEFAULT_REVIEW_MODELS), ...Object.keys(profile?.review ?? {}).map(canonicalLeg)]);
  for (const leg of legs) {
    const fromFile = reviewModelFor(profile?.review, leg);
    const builtin = (DEFAULT_REVIEW_MODELS as Record<string, string>)[leg];
    if (fromFile) roles.push({ role: `review.${leg}`, model: fromFile, source: "file", profile: file!.active });
    else roles.push({ role: `review.${leg}`, model: builtin!, source: "default" });
  }
  return roles;
}

function sourceLabel(r: ModelRole): string {
  return r.source === "file" ? `file (profile ${r.profile})` : r.source;
}

async function show(ctx: Ctx): Promise<void> {
  const file = loadOrRefuse();
  const raw = await readTierSetting(ctx);
  const roles = describeRoles(file, raw ?? "");
  // OB-1970: profiles that hit a credit or quota error recently (the launch moved past them).
  const hits = file ? recentCreditHits() : {};
  if (ctx.mode === "json") {
    print(
      JSON.stringify(
        { file: modelsFilePath(), present: file !== null, active: file?.active ?? null, fallback: file?.fallback ?? [], credit_hits: hits, tier_setting_readable: raw !== null, roles },
        null,
        2,
      ),
    );
    return;
  }
  if (ctx.mode === "quiet") {
    print(roles.map((r) => `${r.role}\t${r.model}\t${r.source}`).join("\n"));
    return;
  }
  const lines = [
    file ? `models file: ${file.path}` : `models file: ${modelsFilePath()} (none: every role uses its setting or default)`,
    file ? `active profile: ${file.active}${file.fallback.length ? `   fallback: ${file.fallback.join(", ")}` : ""}` : "active profile: (none)",
    "",
  ];
  if (Object.keys(hits).length > 0) {
    lines.splice(2, 0, `out of credits in the last ${CREDIT_HIT_WINDOW_HOURS}h: ${Object.entries(hits).map(([p, at]) => `${p} (${at})`).join(", ")}`);
  }
  const width = Math.max(...roles.map((r) => r.role.length));
  for (const r of roles) lines.push(`${r.role.padEnd(width)}  ${r.model}   [${sourceLabel(r)}]`);
  if (raw === null) lines.push("", "note: spinoff_tier_models could not be read from this machine, so a builder tier shown as [default] may be set there");
  print(lines.join("\n"));
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

function use(ctx: Ctx): void {
  const name = ctx.args[1];
  if (!name) throw new UsageError("usage: ob models use <profile>");
  const file = loadOrRefuse();
  if (!file) throw new AppError(`no models file at ${modelsFilePath()}: \`ob models init\` creates one, then \`ob models use ${name}\``);
  if (!file.profiles[name]) {
    throw new AppError(`unknown profile '${name}' in ${file.path} (profiles: ${Object.keys(file.profiles).join(", ")})`);
  }
  try {
    writeActive(file.path, name);
  } catch (e) {
    if (e instanceof ModelsFileError) throw new AppError(e.message);
    throw e;
  }
  print(`active profile: ${name} (was ${file.active}) in ${file.path}`);
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
  if (sub === "list") return list(ctx);
  if (sub === "use") return use(ctx);
  if (sub === "init") return init();
  if (sub === "legs") return legs(ctx);
  throw new UsageError(`unknown models subcommand '${sub}' (show|list|use <profile>|init|legs)`);
}

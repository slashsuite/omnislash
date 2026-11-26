// OB-2097: `ob overnight`. The subcommand tree, the flags and every printed line live HERE, once; the local command
// and the API client differ only in the backend they pass (the store, or HTTP), so the two cannot drift into two
// formats or two sets of exit codes. The rules (the template, the sections, the run a decision joins) are
// `../overnight.ts`.
import type { Ctx } from "../ctx.ts";
import { AppError, UsageError } from "../errors.ts";
import { print, type Mode } from "../output.ts";
import { inferProjectSpec } from "../project.ts";
import {
  addSummaryLine,
  backfillImportedDates,
  decide,
  listRuns,
  localToday,
  parseDate,
  parseSection,
  renderBackfill,
  renderDecision,
  renderNight,
  renderRunList,
  showNight,
  startRun,
  type BackfillRow,
  type DecideInput,
  type OvernightDecision,
  type OvernightNight,
  type OvernightRun,
  type OvernightRunRow,
} from "../overnight.ts";

export interface OvernightBackend {
  start(input: { project: string; date: string }): Promise<{ run: OvernightRun; created: boolean }>;
  decide(input: DecideInput): Promise<OvernightDecision>;
  summary(input: { project: string; date?: string | undefined; section: string; line: string }): Promise<OvernightRun>;
  show(input: { project: string; date?: string | undefined }): Promise<OvernightNight>;
  list(input: { project?: string | undefined; since?: string | undefined }): Promise<OvernightRunRow[]>;
  backfill(input: { project?: string | undefined; dryRun: boolean }): Promise<BackfillRow[]>;
}

interface OvernightCtx {
  args: string[];
  flags: Record<string, unknown>;
  mode: Mode;
  exit?: number;
}

const SUBCOMMANDS = "start|decide|summary|show|list|backfill";

function flag(ctx: OvernightCtx, name: string): string | undefined {
  const v = ctx.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** `--project`, else the project of the git checkout this runs in (as `ob add` infers it), resolved HERE so an API call never asks the server's cwd. */
function project(ctx: OvernightCtx): string {
  const explicit = flag(ctx, "project") ?? flag(ctx, "repo");
  if (explicit) return explicit;
  const inferred = inferProjectSpec(process.cwd());
  if (inferred) return inferred.name;
  throw new UsageError("could not infer the project from this checkout's git remote; pass --project <name>");
}

function date(ctx: OvernightCtx): string | undefined {
  const d = flag(ctx, "date");
  return d === undefined ? undefined : parseDate(d, "--date");
}

export async function runOvernight(ctx: OvernightCtx, be: OvernightBackend): Promise<void> {
  const sub = ctx.args[0] ?? "list";
  const rest = ctx.args.slice(1);

  if (sub === "start") {
    const { run, created } = await be.start({ project: project(ctx), date: date(ctx) ?? localToday() });
    if (ctx.mode === "json") print(JSON.stringify({ ...run, created }, null, 2));
    else if (ctx.mode === "quiet") print(run.date);
    else {
      print(
        `${created ? "started" : "already started"}: ${run.title} (${run.ref ?? run.id})\n` +
          `log each call with: ob overnight decide "<title>" --what '...' --why '...' --doubt '...' --undo '...' --project ${run.project} --night ${run.date}`,
      );
    }
    return;
  }

  if (sub === "decide") {
    const night = flag(ctx, "night");
    const d = await be.decide({
      title: rest.join(" "),
      what: flag(ctx, "what") ?? "",
      why: flag(ctx, "why") ?? "",
      doubt: flag(ctx, "doubt") ?? null,
      undo: flag(ctx, "undo") ?? null,
      context: flag(ctx, "context") ?? null,
      project: project(ctx),
      night: night === undefined ? null : parseDate(night, "--night"),
      at: flag(ctx, "at") ?? null,
    });
    if (ctx.mode === "json") print(JSON.stringify(d, null, 2));
    else if (ctx.mode === "quiet") print(d.ref ?? d.id);
    else print(renderDecision(d));
    return;
  }

  if (sub === "summary") {
    const section = parseSection(rest[0]);
    const line = flag(ctx, "add");
    if (line === undefined || line.trim() === "") throw new UsageError("overnight summary requires --add '<line>'");
    const run = await be.summary({ project: project(ctx), date: date(ctx), section, line });
    if (ctx.mode === "json") print(JSON.stringify(run, null, 2));
    else if (ctx.mode === "quiet") print(run.ref ?? run.id);
    else print(`added to ${section}: ${run.title} (${run.ref ?? run.id})`);
    return;
  }

  if (sub === "show") {
    const night = await be.show({ project: project(ctx), date: date(ctx) });
    if (ctx.mode === "json") print(JSON.stringify(night, null, 2));
    else if (ctx.mode === "quiet") print(night.decisions.map((d) => d.ref ?? d.id).join("\n"));
    else print(renderNight(night));
    return;
  }

  if (sub === "list") {
    const since = flag(ctx, "since");
    const rows = await be.list({
      project: flag(ctx, "project") ?? flag(ctx, "repo"),
      since: since === undefined ? undefined : parseDate(since, "--since"),
    });
    if (ctx.mode === "json") print(JSON.stringify(rows, null, 2));
    else if (ctx.mode === "quiet") print(rows.map((r) => `${r.date} ${r.project}`).join("\n"));
    else print(renderRunList(rows));
    if (ctx.flags.check === true) {
      const bad = rows.filter((r) => r.problems.length);
      if (bad.length) {
        throw new AppError(bad.map((r) => `overnight run ${r.project} ${r.date} (${r.ref ?? "?"}): ${r.problems.join("; ")}`).join("\n"));
      }
    }
    return;
  }

  if (sub === "backfill") {
    const dryRun = ctx.flags["dry-run"] === true;
    const rows = await be.backfill({ project: flag(ctx, "project") ?? flag(ctx, "repo"), dryRun });
    if (ctx.mode === "json") print(JSON.stringify(rows, null, 2));
    else if (ctx.mode === "quiet") print(rows.map((r) => r.ref ?? r.id).join("\n"));
    else print(renderBackfill(rows, dryRun));
    return;
  }

  throw new UsageError(`unknown overnight subcommand '${sub}' (${SUBCOMMANDS})`);
}

/** The backend over a store this process opened. */
function storeOvernightBackend(store: NonNullable<Ctx["store"]> | Ctx["db"]): OvernightBackend {
  return {
    start: (input) => startRun(store, input),
    decide: (input) => decide(store, input),
    summary: (input) => addSummaryLine(store, input),
    show: (input) => showNight(store, input),
    list: (input) => listRuns(store, input),
    backfill: (input) => backfillImportedDates(store, input),
  };
}

export async function cmdOvernight(ctx: Ctx): Promise<void> {
  await runOvernight({ args: ctx.args, flags: ctx.flags as Record<string, unknown>, mode: ctx.mode }, storeOvernightBackend(ctx.store ?? ctx.db));
}

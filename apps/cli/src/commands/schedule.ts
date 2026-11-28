// OS-310: `ob schedule`, the scheduled job tracker (see ../scheduled-jobs.ts for the record, ../schedule.ts for the
// schedule). Slice 1 stores jobs and shows their runs; the runner that fires them is OS-311.
//
// One procedure serves the store and the API client: each passes a `ScheduleBackend` for the data.
import type { Database } from "bun:sqlite";
import type { Ctx, Flags } from "../ctx.ts";
import type { Store } from "../db/store.ts";
import { UsageError } from "../errors.ts";
import { print, type Mode } from "../output.ts";
import {
  createScheduledJob,
  deleteScheduledJob,
  listScheduledJobRuns,
  listScheduledJobs,
  parseJobName,
  runScheduledJobNow,
  updateScheduledJob,
  type ScheduledJob,
  type ScheduledJobInput,
  type ScheduledJobPatch,
  type ScheduledJobRun,
} from "../scheduled-jobs.ts";
import { refuseUnreadFlags } from "./capture.ts";

/** Where the jobs live: the store on this machine, or the API. */
export interface ScheduleBackend {
  list(all: boolean): Promise<ScheduledJob[]>;
  create(input: ScheduledJobInput): Promise<ScheduledJob>;
  show(ref: string, runs: number): Promise<{ job: ScheduledJob; runs: ScheduledJobRun[] }>;
  update(ref: string, patch: ScheduledJobPatch): Promise<ScheduledJob>;
  run(ref: string): Promise<ScheduledJob>;
  delete(ref: string): Promise<ScheduledJob>;
}

export interface ScheduleCtx {
  mode: Mode;
  flags: Flags;
  args: string[];
}

const SCHEDULE_USAGE = [
  "ob schedule add <name> (--once <iso> | --every <dur> | --cron <expr>)",
  "    (--team <t> --role <r> --prompt <text> | --cmd <shell> [--cwd <path>] [--host <name>]) [--ignore-good-night] [--json]",
  "ob schedule list [--all] [--json]",
  "ob schedule show <name|id> [--runs <n>] [--json]",
  "ob schedule pause|resume|delete|run <name|id>",
].join("\n");

const SUBCOMMANDS = ["add", "list", "show", "pause", "resume", "delete", "run"] as const;

/**
 * `--once <iso>` for `ob schedule`: the global `--once` is a boolean (`ob spinoff watch --once`), so for this command
 * it is rewritten to the string flag `--once-at` before parseArgs. The command is the first positional, past any flags
 * and the values of string flags in `flags` (`ob --db x schedule ...`); only tokens after it and before any `--` change.
 * Any other command's argv is returned as it is. Pure.
 */
export function expandScheduleOnceFlag(argv: string[], flags: Record<string, { type: string; short?: string }>): string[] {
  const takesValue = (tok: string): boolean => {
    if (tok.includes("=")) return false;
    if (tok.startsWith("--")) return flags[tok.slice(2)]?.type === "string";
    return Object.values(flags).some((f) => f.type === "string" && f.short === tok.slice(1));
  };
  let i = 0;
  while (i < argv.length && argv[i]!.startsWith("-") && argv[i] !== "--") i += takesValue(argv[i]!) ? 2 : 1;
  if (argv[i] !== "schedule") return argv;
  const end = argv.indexOf("--", i);
  return argv.map((a, j) => {
    if (j <= i || (end >= 0 && j >= end)) return a;
    if (a === "--once") return "--once-at";
    return a.startsWith("--once=") ? `--once-at=${a.slice("--once=".length)}` : a;
  });
}

/** The default and the cap on `show --runs`. */
const DEFAULT_RUNS = 10;
const MAX_RUNS = 500;

function parseRuns(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RUNS;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_RUNS) throw new UsageError(`--runs must be a whole number from 1 to ${MAX_RUNS}, got '${raw}'`);
  return Number(raw);
}

/** The new job from `add`'s flags: checks flag shape (one schedule, one target); field rules live in `checkJob`. Pure. */
function scheduleInputFromFlags(name: string | undefined, flags: Flags): ScheduledJobInput {
  if (!name) throw new UsageError(`schedule add needs a <name>\n${SCHEDULE_USAGE}`);
  const jobName = parseJobName(name);
  const schedules: Array<[string, string, string | undefined]> = [
    ["once", "--once", flags["once-at"]],
    ["interval", "--every", flags.every],
    ["cron", "--cron", flags.cron],
  ];
  const given = schedules.filter(([, , v]) => v !== undefined);
  if (given.length !== 1) {
    throw new UsageError(given.length === 0 ? "schedule add needs one of --once <iso>, --every <dur> or --cron <expr>" : `pass one schedule, not ${given.map(([, f]) => f).join(" and ")}`);
  }
  const [kind, flag, expr] = given[0]!;
  if (!expr || !expr.trim()) throw new UsageError(`${flag} needs a value`);
  const roleFlags = (["team", "role", "prompt"] as const).filter((f) => flags[f] !== undefined);
  const cmdFlags = (["cmd", "cwd", "host"] as const).filter((f) => flags[f] !== undefined);
  if (roleFlags.length > 0 && cmdFlags.length > 0) {
    throw new UsageError(`a job sends a role a prompt or runs a command, not both: drop ${roleFlags.map((f) => `--${f}`).join(", ")} or ${cmdFlags.map((f) => `--${f}`).join(", ")}`);
  }
  if (roleFlags.length === 0 && cmdFlags.length === 0) {
    throw new UsageError("schedule add needs a target: --team <t> --role <r> --prompt <text>, or --cmd <shell>");
  }
  const respect_good_night = flags["ignore-good-night"] !== true;
  if (cmdFlags.length > 0) {
    return { name: jobName, schedule_kind: kind, schedule_expr: expr, target_kind: "command", command: flags.cmd ?? null, cwd: flags.cwd ?? null, host: flags.host ?? null, respect_good_night };
  }
  return { name: jobName, schedule_kind: kind, schedule_expr: expr, target_kind: "role", team: flags.team ?? null, role: flags.role ?? null, prompt: flags.prompt ?? null, respect_good_night };
}

function scheduleText(j: ScheduledJob): string {
  if (j.schedule_kind === "once") return `once ${j.schedule_expr}`;
  if (j.schedule_kind === "interval") return `every ${j.schedule_expr}`;
  return `cron "${j.schedule_expr}" (UTC)`;
}

function targetText(j: ScheduledJob): string {
  if (j.target_kind === "role") return `${j.team} ${j.role}`;
  const where = [j.host ? `on ${j.host}` : null, j.cwd ? `in ${j.cwd}` : null].filter(Boolean).join(" ");
  return `cmd${where ? ` ${where}` : ""}`;
}

function renderJobLine(j: ScheduledJob): string {
  const state = j.enabled ? "" : " [paused]";
  const next = j.next_run_at ? `next ${j.next_run_at}` : "no next run";
  const last = j.last_status ? `; last ${j.last_status} at ${j.last_run_at}` : "";
  return `#${j.id} ${j.name}${state}: ${scheduleText(j)} -> ${targetText(j)}; ${next}${last}`;
}

function renderJob(j: ScheduledJob, runs: ScheduledJobRun[]): string {
  const lines = [
    `#${j.id} ${j.name}${j.enabled ? "" : " [paused]"}`,
    `  schedule: ${scheduleText(j)}`,
    j.target_kind === "role" ? `  target:   ${j.team} ${j.role}` : `  command:  ${j.command}`,
  ];
  if (j.target_kind === "role") lines.push(...(j.prompt ?? "").split("\n").map((l, i) => (i === 0 ? `  prompt:   ${l}` : `            ${l}`)));
  if (j.cwd) lines.push(`  cwd:      ${j.cwd}`);
  if (j.host) lines.push(`  host:     ${j.host}`);
  lines.push(`  good night: ${j.respect_good_night ? "held while the lock is on" : "ignored"}`);
  lines.push(`  next run: ${j.next_run_at ?? "none"}`);
  if (j.last_run_at) lines.push(`  last run: ${j.last_status} at ${j.last_run_at}${j.last_error ? ` (${j.last_error})` : ""}`);
  lines.push(runs.length === 0 ? "  runs: none yet" : `  runs (newest first):`);
  for (const r of runs) {
    const exit = r.exit_code === null ? "" : ` exit ${r.exit_code}`;
    const host = r.host ? ` on ${r.host}` : "";
    const msg = r.role_message_id === null ? "" : ` message #${r.role_message_id}`;
    lines.push(`    #${r.id} ${r.status}${exit}${host}${msg} ${r.started_at}${r.finished_at ? ` -> ${r.finished_at}` : ""}`);
  }
  return lines.join("\n");
}

function emitJob(ctx: ScheduleCtx, job: ScheduledJob, verb: string): void {
  if (ctx.mode === "json") print(JSON.stringify(job, null, 2));
  else if (ctx.mode === "quiet") print(String(job.id));
  else print(`${verb} ${renderJobLine(job)}`);
}

function oneRef(sub: string, args: string[]): string {
  const ref = args[1];
  if (!ref || args.length > 2) throw new UsageError(`schedule ${sub} takes one <name|id>\n${SCHEDULE_USAGE}`);
  return ref;
}

/** `ob schedule <sub> ...`. */
export async function runSchedule(ctx: ScheduleCtx, backend: ScheduleBackend): Promise<void> {
  const sub = ctx.args[0];
  if (!sub || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new UsageError(`${sub ? `unknown schedule subcommand '${sub}'` : "schedule needs a subcommand"} (${SUBCOMMANDS.join("|")})\n${SCHEDULE_USAGE}`);
  }
  if (sub === "add") {
    refuseUnreadFlags("ob schedule add", ctx.flags, ["once-at", "every", "cron", "team", "role", "prompt", "cmd", "cwd", "host", "ignore-good-night"]);
    if (ctx.args.length > 2) throw new UsageError(`schedule add takes one <name>; quote the prompt or command (got: ${ctx.args.slice(1).join(" ")})`);
    const job = await backend.create(scheduleInputFromFlags(ctx.args[1], ctx.flags));
    emitJob(ctx, job, "added");
    return;
  }
  if (sub === "list") {
    refuseUnreadFlags("ob schedule list", ctx.flags, ["all"]);
    if (ctx.args.length > 1) throw new UsageError(`schedule list takes no arguments\n${SCHEDULE_USAGE}`);
    const jobs = await backend.list(ctx.flags.all === true);
    if (ctx.mode === "json") print(JSON.stringify(jobs, null, 2));
    else if (ctx.mode === "quiet") print(jobs.map((j) => j.id).join("\n"));
    else if (jobs.length === 0) print(ctx.flags.all ? "no scheduled jobs" : "no enabled scheduled jobs (--all includes paused ones)");
    else print(jobs.map(renderJobLine).join("\n"));
    return;
  }
  if (sub === "show") {
    refuseUnreadFlags("ob schedule show", ctx.flags, ["runs"]);
    const ref = oneRef(sub, ctx.args);
    const res = await backend.show(ref, parseRuns(ctx.flags.runs));
    if (ctx.mode === "json") print(JSON.stringify(res, null, 2));
    else if (ctx.mode === "quiet") print(String(res.job.id));
    else print(renderJob(res.job, res.runs));
    return;
  }
  refuseUnreadFlags(`ob schedule ${sub}`, ctx.flags, []);
  const ref = oneRef(sub, ctx.args);
  if (sub === "pause") emitJob(ctx, await backend.update(ref, { enabled: false }), "paused");
  else if (sub === "resume") emitJob(ctx, await backend.update(ref, { enabled: true }), "resumed");
  else if (sub === "run") emitJob(ctx, await backend.run(ref), "due now:");
  else emitJob(ctx, await backend.delete(ref), "deleted");
}

/** The jobs on this machine's store. */
function storeScheduleBackend(store: Database | Store): ScheduleBackend {
  return {
    list: (all) => listScheduledJobs(store, { all }),
    create: (input) => createScheduledJob(store, input),
    show: (ref, runs) => listScheduledJobRuns(store, ref, runs),
    update: (ref, patch) => updateScheduledJob(store, ref, patch),
    run: (ref) => runScheduledJobNow(store, ref),
    delete: (ref) => deleteScheduledJob(store, ref),
  };
}

export async function cmdSchedule(ctx: Ctx): Promise<void> {
  await runSchedule(ctx, storeScheduleBackend(ctx.store ?? ctx.db));
}

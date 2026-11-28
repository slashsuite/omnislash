import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print } from "../output.ts";
import { jobHealth, type JobHealth } from "../jobs.ts";
import { scheduledJobHealth, type ScheduledJobHealth } from "../scheduled-jobs.ts";

/** OS-312: one `ob schedule` job's line: its state, its last run and, when it keeps failing, the streak. */
function renderScheduled(r: ScheduledJobHealth): string {
  const state = r.enabled ? (r.last_status ?? "not run") : "paused";
  const failures = r.consecutive_failures > 0 ? `\t${r.consecutive_failures} fail(s) in a row` : "";
  const next = r.enabled && r.next_run_at ? `, next ${r.next_run_at}` : "";
  return `${r.name.padEnd(16)} ${state.padEnd(11)} last run ${r.last_run_at ?? "never"}${next}${failures}`;
}

/** The daemon fleet's table, then (OS-312) the scheduled jobs under their own heading when there are any. */
export function renderJobs(rows: JobHealth[], scheduled: readonly ScheduledJobHealth[] = []): string {
  const daemon = rows
    .map((r) => {
      const failures = r.consecutive_failures > 0 ? `\t${r.consecutive_failures} fail(s) in a row` : "";
      const unfinished =
        r.consecutive_interruptions > 0 ? `\t${r.consecutive_interruptions} unfinished run(s) in a row` : "";
      return `${r.job.padEnd(16)} ${r.state.padEnd(11)} last success ${r.last_success_at ?? "never"}${failures}${unfinished}`;
    })
    .join("\n");
  if (scheduled.length === 0) return daemon;
  return `${daemon}\n\nscheduled jobs (ob schedule)\n${scheduled.map(renderScheduled).join("\n")}`;
}

/**
 * `ob jobs`: the per-job health table behind alert rules 7/8/9/10 (218, 221). A read: it says what each declared
 * daemon job last did, so "is ingestion alive?" is a question with an answer that is not a log file. OS-312: the
 * text adds the `ob schedule` jobs (rule 13) under their own heading; `--json` and `--quiet` stay the daemon fleet.
 */
export async function cmdJobs(ctx: Ctx): Promise<void> {
  if (ctx.args[0] === "host") {
    throw new UsageError("jobs host is for an API client: it reads what the API host ran for it");
  }
  const rows = await jobHealth(ctx.store);
  if (ctx.mode === "json") {
    print(JSON.stringify(rows, null, 2));
    return;
  }
  if (ctx.mode === "quiet") {
    print(rows.map((r) => r.job).join("\n"));
    return;
  }
  print(renderJobs(rows, await scheduledJobHealth(ctx.store)));
}

import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print } from "../output.ts";
import { jobHealth, type JobHealth } from "../jobs.ts";

export function renderJobs(rows: JobHealth[]): string {
  return rows
    .map((r) => {
      const failures = r.consecutive_failures > 0 ? `\t${r.consecutive_failures} fail(s) in a row` : "";
      const unfinished =
        r.consecutive_interruptions > 0 ? `\t${r.consecutive_interruptions} unfinished run(s) in a row` : "";
      return `${r.job.padEnd(16)} ${r.state.padEnd(11)} last success ${r.last_success_at ?? "never"}${failures}${unfinished}`;
    })
    .join("\n");
}

/**
 * `ob jobs`: the per-job health table behind alert rules 7/8/9/10 (218, 221). A read: it says what each declared
 * daemon job last did, so "is ingestion alive?" is a question with an answer that is not a log file.
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
  print(renderJobs(rows));
}

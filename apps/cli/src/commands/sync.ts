import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print } from "../output.ts";
import { syncGithub } from "../ingest/github.ts";

export async function cmdSync(ctx: Ctx): Promise<void> {
  const source = ctx.flags.source;
  if (source && source !== "github") {
    throw new UsageError("--source must be github");
  }
  const opts = { since: ctx.flags.since, backfill: ctx.flags.backfill };
  const results: Record<string, unknown> = {};
  const store = ctx.store;

  results.github = await syncGithub(store, opts);

  if (ctx.mode === "json") {
    print(JSON.stringify(results, null, 2));
    return;
  }
  const g = results.github as { prs: number; events: number };
  print(`synced — github: ${g.prs} PRs, ${g.events} events`);
}

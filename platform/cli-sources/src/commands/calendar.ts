import type { Ctx } from "../../../../apps/cli/src/ctx.ts";
import { UsageError } from "../../../../apps/cli/src/errors.ts";
import { print } from "../../../../apps/cli/src/output.ts";
import { agendaToday, syncCalendar, type AgendaRow } from "../ingest/calendar.ts";
import { saClock } from "../sa-time.ts";
import { sqliteStoreFor } from "../../../../apps/cli/src/db/store.ts";

export function fmtTime(row: AgendaRow): string {
  if (row.all_day) return "all-day";
  if (!row.start_ts) return "?";
  return saClock(row.start_ts);
}

export function renderAgenda(rows: AgendaRow[]): string {
  if (rows.length === 0) return "no events today";
  return rows.map((r) => `${fmtTime(r)}\t${r.summary ?? "(no title)"}`).join("\n");
}

export async function cmdCal(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0];
  const store = ctx.store ?? sqliteStoreFor(ctx.db);

  if (sub === "sync") {
    const res = await syncCalendar(store, {
      backfill: ctx.flags.backfill,
      since: ctx.flags.since,
      max: ctx.flags.max != null ? Number(ctx.flags.max) : undefined,
    });
    if (ctx.mode === "json") {
      print(JSON.stringify(res, null, 2));
    } else {
      print(`cal sync — ${res.events} events, ${res.ingested} new across ${res.calendars.join(", ")}`);
    }
    return;
  }

  if (sub === "agenda" || sub === undefined) {
    // `ob cal` with no subcommand == today's agenda (also exposed as top-level `ob agenda`).
    return cmdAgenda(ctx);
  }

  throw new UsageError(`unknown cal subcommand '${sub}' (sync|agenda)`);
}

export async function cmdAgenda(ctx: Ctx): Promise<void> {
  const rows = await agendaToday(ctx.store ?? sqliteStoreFor(ctx.db));
  if (ctx.mode === "json") print(JSON.stringify(rows, null, 2));
  else print(renderAgenda(rows));
}

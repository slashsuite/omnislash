import type { Database } from "bun:sqlite";
import { desc } from "drizzle-orm";
import type { Ctx } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print } from "../output.ts";
import { asStore, type Store } from "../db/store.ts";

// ── `ob slack` after ob 208 ──────────────────────────────────────────────────────────────────────
// Scheduled Slack ingestion is RETIRED. The connector read a Slack user token from ~/.slack_token, a
// file that has never existed here, so `com.omnislash.slack-sync` failed on every run from the day it
// was configured. Work Slack is read-only awareness under the messaging footprint, and that awareness
// now comes from the claude.ai Slack connector at the point of use (the /ob-slack-triage skill), so there
// is no token to mint and nothing left to poll.
//
// What remains is this read: `slack_message` holds whatever was ingested while the connector worked,
// the repo's rule is that ingested data stays, and a table with no reader is data that has effectively
// been dropped. It needs no credential and touches no network.

export interface SlackMessageRow {
  id: number;
  ts: string;
  channel: string;
  channel_type: string | null;
  user: string | null;
  text: string | null;
  thread_ts: string | null;
  permalink: string | null;
  person_id: number | null;
  created_at: string;
}

/** Most-recent ingested Slack messages (read-only awareness surface). Store-ported (416). */
export async function recentSlackMessages(db: Database | Store, limit: number): Promise<SlackMessageRow[]> {
  const s = asStore(db);
  return (await s.q
    .select({
      id: s.t.slackMessage.id,
      ts: s.t.slackMessage.ts,
      channel: s.t.slackMessage.channel,
      channel_type: s.t.slackMessage.channel_type,
      user: s.t.slackMessage.user,
      text: s.t.slackMessage.text,
      thread_ts: s.t.slackMessage.thread_ts,
      permalink: s.t.slackMessage.permalink,
      person_id: s.t.slackMessage.person_id,
      created_at: s.t.slackMessage.created_at,
    })
    .from(s.t.slackMessage)
    .orderBy(desc(s.t.slackMessage.ts))
    .limit(limit)) as SlackMessageRow[];
}

export function renderSlackUnread(rows: SlackMessageRow[]): string {
  if (rows.length === 0) return "no slack messages";
  return rows
    .map((r) => {
      const who = r.user ?? "-";
      const text = (r.text ?? "").replace(/\s+/g, " ").slice(0, 80);
      return `${r.channel_type ?? "?"}\t${r.channel}\t${who}\t${text}`;
    })
    .join("\n");
}

export async function cmdSlack(ctx: Ctx): Promise<void> {
  const sub = ctx.args[0] ?? "unread";

  if (sub === "sync") {
    throw new UsageError(
      "slack sync is retired (ob 208): it needed a Slack token that never existed, and work Slack awareness now comes from the Claude Slack connector. `slack unread` still reads what was ingested.",
    );
  }

  if (sub === "unread") {
    const limit = ctx.flags.limit ? Number(ctx.flags.limit) : 20;
    if (!Number.isFinite(limit) || limit <= 0) {
      throw new UsageError("slack unread --limit must be a positive number");
    }
    const rows = await recentSlackMessages(ctx.store ?? ctx.db, limit);
    if (ctx.mode === "json") {
      print(JSON.stringify(rows, null, 2));
      return;
    }
    if (ctx.mode === "quiet") {
      print(rows.map((r) => String(r.id)).join("\n"));
      return;
    }
    print(renderSlackUnread(rows));
    return;
  }

  throw new UsageError(`unknown slack subcommand '${sub}' (unread)`);
}

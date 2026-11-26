import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { nowIso } from "../../../apps/cli/src/db.ts";
import { orm } from "../../../apps/cli/src/db/orm.ts";
import { slackMessage } from "../../../apps/cli/src/db/schema.ts";
import { recentSlackMessages } from "../../../apps/cli/src/commands/slack.ts";
import { daemonJobs } from "../../cli-coord/src/commands/coord.ts";
import { declaredJobs } from "../../../apps/cli/src/jobs.ts";
import { CREDENTIAL_NAMES } from "../../../apps/cli/src/credentials.ts";
import { KNOWN_SECRET_NAMES } from "../../../apps/cli/src/secrets.ts";
import { DEFAULTS } from "../../../apps/cli/src/settings.ts";

// ob 208. Scheduled Slack ingestion is retired, and this file is the two halves of that: the poll and
// its credential are gone and cannot come back by accident, and the rows it once wrote are still
// readable.
//
// The defect was not a missing credential. The connector read a Slack user token from ~/.slack_token,
// a file that has never existed in any copy of this database, so `com.omnislash.slack-sync` failed on
// every run from the day it was configured (ob 218 reported it as JOB FAILING with 60-plus consecutive
// failures, correctly). Work Slack is read-only awareness under the messaging footprint and that
// awareness comes from the claude.ai Slack connector at the point of use, so there was never a token to
// mint: the job itself was the thing that should not exist.

const SRC = join(import.meta.dir, "../../../apps/cli/src");

function seedMessage(db: ReturnType<typeof freshDb>, ts: string, channel: string, text: string): void {
  orm(db)
    .insert(slackMessage)
    .values({
      ts,
      channel,
      channel_type: "channel",
      user: "U_ALICE",
      text,
      thread_ts: null,
      permalink: null,
      person_id: null,
      raw: "{}",
      created_at: nowIso(),
    })
    .run();
}

/** Every .ts file under apps/cli/src, so a reference to the retired token cannot hide in one of them. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("the ingested Slack messages stay readable (208)", () => {
  test("`slack unread` reads the rows newest-first and respects its limit", async () => {
    const db = freshDb();
    seedMessage(db, "1718000000.000100", "C_TEAM", "hey can you look at the deploy pipeline");
    seedMessage(db, "1718000100.000200", "C_ENG", "ping about the postgres migration");

    const rows = await recentSlackMessages(db, 10);
    expect(rows.map((r) => r.channel)).toEqual(["C_ENG", "C_TEAM"]);
    expect((await recentSlackMessages(db, 1)).map((r) => r.channel)).toEqual(["C_ENG"]);
    db.close();
  });

  test("it needs no credential: an empty table is an answer, not an error", async () => {
    const dbPath = freshDbPath();
    const res = await runCli(dbPath, ["slack", "unread"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("no slack messages");
  });

  test("`slack sync` refuses and says what replaced it", async () => {
    const dbPath = freshDbPath();
    const res = await runCli(dbPath, ["slack", "sync"]);
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("retired");
    expect(res.err).toContain("Claude Slack connector");
  });
});

describe("the scheduled poll is retired (208)", () => {
  test("no daemon job and no health-tracked job named slack-sync exists", () => {
    expect(daemonJobs("/Users/nobody").map((j) => j.job)).not.toContain("slack-sync");
    expect(declaredJobs().map((d) => d.job)).not.toContain("slack-sync");
  });

  test("nothing in the CLI expects a Slack token to exist", () => {
    expect(KNOWN_SECRET_NAMES).not.toContain("slack");
    expect(CREDENTIAL_NAMES).not.toContain("slack");
    expect(Object.keys(DEFAULTS)).not.toContain("slack_token_path");
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      // The retirement note in commands/slack.ts explains the path this repo no longer reads, which is
      // why the pattern is a READ of it rather than the word: a config key, a token file being opened,
      // or the advice to store one.
      expect(text, `${file} still reads a Slack token path`).not.toMatch(/slack_token_path|readSlackToken/);
      expect(text, `${file} still tells someone to store a Slack token`).not.toMatch(/secret set slack/);
    }
  });
});

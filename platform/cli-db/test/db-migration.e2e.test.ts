import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, MIGRATIONS, LEGACY_SCHEMA_VERSION } from "../../../apps/cli/src/db.ts";
// The fingerprint moved to src (183) so the replica's schema-skew guard and this safety-net share ONE
// notion of the schema's shape. The computation is unchanged, so the golden snapshot is unchanged.
import { schemaFingerprint, tableNames } from "../../../apps/cli/src/db/fingerprint.ts";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { registerAgent, listAgents } from "../../cli-coord/src/agent.ts";
import { enqueueSpinoff, listSpinoffs } from "../../cli-coord/src/commands/spinoff.ts";
import { saveGenerated, setEdited, markPosted, latestStandup, effectiveText } from "../../../apps/cli/src/commands/standup.ts";
import { buildStatus } from "../../../apps/cli/src/commands/status.ts";

// DB migration safety-net (097). Characterizes the CURRENT raw-bun:sqlite behavior + safety properties
// so the Drizzle migration (095) is provably behaviour-preserving and non-destructive. This whole file
// must stay green after 095 (updating only the schema snapshot, with a reviewed diff).

/** ob 1638 dropped the unused Cue schema; the only tables this safety-net expects to disappear. */
const DROPPED_1638 = ["epic", "ticket_epic", "epic_progress_snapshot", "epic_snapshot", "gap", "audit_run", "scope_change", "stakeholder"];

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
}
function tableCounts(db: Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tableNames(db)) out[t] = (db.query(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n;
  return out;
}

/** Representative, FK-valid data across the main tables, via the exported write paths. */
async function seed(db: Database): Promise<void> {
  (await registerAgent(db, { id: "agent-1", ticket: "CUE-9388", worktree: "/tmp/wt", branch: "b1", status: "working", ttlS: 900 }));
  (await enqueueSpinoff(db, { ticketRef: "CUE-9388", repo: "/r", branch: "b2", mode: "agent", brief: "x" }));
  (await saveGenerated(sqliteStoreFor(db), "2026-07-18", "## What I did\n- shipped"));
  (await setEdited(sqliteStoreFor(db), "2026-07-18", "## What I did\n- shipped (edited)"));
}

/** Reconstruct a genuine PRE-drizzle DB the way the user's live DB was built: open raw, replay the
 *  historical MIGRATIONS chain exactly as the old openDb did (FK off around the run, per-step
 *  user_version), then hand-seed representative FK-valid rows across several tables — including two
 *  fts-backed items — so adoption is proven against real data, not an empty shell. */
function buildLegacyV18Db(path: string): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = OFF;");
  for (let v = 0; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
  db.query("INSERT INTO epic(epic_ref, title, color, created_at, updated_at) VALUES('CUE-9388','Measurement layer','magenta','2026-01-01','2026-01-01')").run();
  db.query("INSERT INTO item(id,type,title,body,status,created_at,updated_at) VALUES('itm-1','task','Wire drizzle migrate','convert the MIGRATIONS array to migrate()','open','2026-01-01','2026-01-01')").run();
  db.query("INSERT INTO item(id,type,title,body,status,created_at,updated_at) VALUES('itm-2','task','Persist PR comments','durable searchable review corpus','done','2026-01-01','2026-01-01')").run();
  db.query("INSERT INTO item_fts(item_id, title, body) VALUES('itm-1','Wire drizzle migrate','convert the MIGRATIONS array to migrate()')").run();
  db.query("INSERT INTO item_fts(item_id, title, body) VALUES('itm-2','Persist PR comments','durable searchable review corpus')").run();
  db.query("INSERT INTO event(ts,source,type,item_id,actor) VALUES('2026-01-02','test','created','itm-1','tester')").run();
  db.query("INSERT INTO spinoff(ticket_ref,repo,branch,worktree,mode,brief,status,epic,request_at) VALUES('CUE-9388','/r','b','/wt','agent','do it','pending','CUE-9388','2026-01-02')").run();
  // an already-completed spinoff, so 0019's reported_at backfill (#41) is proven against real data
  db.query("INSERT INTO spinoff(ticket_ref,repo,branch,worktree,mode,brief,status,epic,request_at) VALUES('CUE-9000','/r','b0','/wt0','agent','shipped it','merged','CUE-9388','2026-01-01')").run();
  const bad = db.query("PRAGMA foreign_key_check").all();
  if (bad.length > 0) throw new Error("legacy seed foreign_key_check failed: " + JSON.stringify(bad));
  db.close();
}

describe("DB migration safety-net (097)", () => {
  test("schema fingerprint is stable (golden the Drizzle migration must reproduce)", () => {
    const db = freshDb();
    expect(userVersion(db)).toBeGreaterThanOrEqual(18); // == MIGRATIONS.length at time of writing
    // every expected table exists
    expect(tableNames(db)).toContain("standup");
    // 1638: the Cue schema is gone, and stays gone.
    for (const t of DROPPED_1638) expect(tableNames(db)).not.toContain(t);
    // full per-table column fingerprint — snapshot is the golden
    expect(schemaFingerprint(db)).toMatchSnapshot();
  });

  test("re-opening a migrated DB does NOT re-migrate or lose data (the live-DB baseline property)", async () => {
    const path = freshDbPath();
    const db1 = openDb(path);
    await seed(db1);
    const v = userVersion(db1);
    const counts = tableCounts(db1);
    db1.close();

    const db2 = openDb(path); // re-open — must be a no-op migration
    expect(userVersion(db2)).toBe(v);
    expect(tableCounts(db2)).toEqual(counts);
    // data is actually readable after re-open
    expect((await listAgents(db2)).some((a) => a.id === "agent-1")).toBe(true);
    expect(effectiveText(await latestStandup(sqliteStoreFor(db2)))).toBe("## What I did\n- shipped (edited)");
    db2.close();
  });

  test("foreign_key_check passes on a fully-seeded DB", async () => {
    const db = freshDb();
    await seed(db);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("CRUD round-trips via the exported functions (behaviour to preserve)", async () => {
    const db = freshDb();
    await seed(db);

    // agent
    expect((await listAgents(db)).some((a) => a.id === "agent-1")).toBe(true);
    // spinoff
    expect((await listSpinoffs(db)).some((s) => s.ticket_ref === "CUE-9388")).toBe(true);
    // standup: edit wins, then posted advances the boundary
    expect(effectiveText((await latestStandup(sqliteStoreFor(db))))).toBe("## What I did\n- shipped (edited)");
    expect((await markPosted(sqliteStoreFor(db), "2026-07-18"))).toBe(true);
    expect((await latestStandup(sqliteStoreFor(db)))!.status).toBe("posted");

    // status snapshot composes without error over the seeded data (inject an empty wayfinder
    // frontier fetcher — 221 — so the snapshot never hits GitHub in tests)
    const s = await buildStatus(db, async () => []);
    expect(Array.isArray(s.agents)).toBe(true);
  });

  test("e2e through the CLI: seed via commands, read via --json", async () => {
    const path = freshDbPath();
    // seed through the real CLI
    expect((await runCli(path, ["agent", "register", "--id", "agent-1", "--status", "working"])).code).toBe(0);

    // read back via --json — structural assertions (timestamps are volatile, so don't pin them)
    const status = await runCli(path, ["status", "--json"]);
    expect(status.code).toBe(0);
    const snap = JSON.parse(status.out);
    expect(snap).toHaveProperty("agents");
    expect(snap).toHaveProperty("in_flight_prs");
    expect(snap.agents.some((a: { id: string }) => a.id === "agent-1")).toBe(true);
  });

  // ── 099: the drizzle-migrate() open path ────────────────────────────────────────────────────────
  // Scenario 1 (fresh DB): 0000 runs → fts5 virtual tables (+ shadow tables) exist and MATCH works.
  // The fingerprint golden (test above, via freshDb) already anchors the fresh schema to the snapshot.
  test("scenario 1 — fresh DB via drizzle migrate() creates the fts5 virtual tables + MATCH works", () => {
    const db = freshDb();
    for (const t of ["item_fts", "pr_comment_fts", "item_fts_data", "pr_comment_fts_data"]) {
      expect(tableNames(db)).toContain(t);
    }
    db.query("INSERT INTO item_fts(item_id, title, body) VALUES('x','hello drizzle world','body text')").run();
    const hits = db.query("SELECT item_id FROM item_fts WHERE item_fts MATCH 'drizzle'").all() as { item_id: string }[];
    expect(hits.map((h) => h.item_id)).toEqual(["x"]);
    db.close();
  });

  // 0001 (126/127): a fresh DB via drizzle migrate() creates the additive Gmail/Calendar tables + fts.
  test("0001 — fresh DB has email_message / calendar_event / email_fts and email_fts MATCH works", () => {
    const db = freshDb();
    for (const t of ["email_message", "calendar_event", "email_fts", "email_fts_data"]) {
      expect(tableNames(db)).toContain(t);
    }
    db.query("INSERT INTO email_message(id, subject, body, ts) VALUES('m1','quarterly review','see attached deck','2026-07-18T00:00:00.000Z')").run();
    db.query("INSERT INTO email_fts(id, subject, body) VALUES('m1','quarterly review','see attached deck')").run();
    const hits = db.query("SELECT id FROM email_fts WHERE email_fts MATCH 'quarterly'").all() as { id: string }[];
    expect(hits.map((h) => h.id)).toEqual(["m1"]);
    db.close();
  });

  // 0004 (099/100): a fresh DB via drizzle migrate() has the WhatsApp tables + person.whatsapp_jid.
  test("0004 — fresh DB has whatsapp_message / whatsapp_fts + person.whatsapp_jid and MATCH works", () => {
    const db = freshDb();
    for (const t of ["whatsapp_message", "whatsapp_fts", "whatsapp_fts_data"]) {
      expect(tableNames(db)).toContain(t);
    }
    // person gained the additive whatsapp_jid column
    const cols = (db.query("PRAGMA table_info(person)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("whatsapp_jid");

    db.query(
      "INSERT INTO whatsapp_message(id, chat_jid, content, ts, created_at) VALUES('m1','27000000003@s.whatsapp.net','lunch at the harbour','2026-07-18T00:00:00.000Z','2026-07-18T00:00:00.000Z')",
    ).run();
    db.query(
      "INSERT INTO whatsapp_fts(message_id, content) SELECT rowid, content FROM whatsapp_message WHERE id='m1'",
    ).run();
    const hits = db.query("SELECT id FROM whatsapp_message WHERE rowid IN (SELECT message_id FROM whatsapp_fts WHERE whatsapp_fts MATCH 'harbour')").all() as { id: string }[];
    expect(hits.map((h) => h.id)).toEqual(["m1"]);
    db.close();
  });

  // 0005 (142): a fresh DB via drizzle migrate() has the three additive person comms-profile columns.
  test("0005 — fresh DB has person.relationship / comms_style / comms_notes", () => {
    const db = freshDb();
    const cols = (db.query("PRAGMA table_info(person)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["relationship", "comms_style", "comms_notes"]) expect(cols).toContain(c);
    // they are usable + nullable (insert with none set, then set them)
    db.query("INSERT INTO person(real_name, created_at, updated_at) VALUES('Taylor','2026-07-19','2026-07-19')").run();
    db.query("UPDATE person SET relationship='colleague', comms_style='formal', comms_notes='prefers email' WHERE real_name='Taylor'").run();
    const row = db.query("SELECT relationship, comms_style, comms_notes FROM person WHERE real_name='Taylor'").get() as {
      relationship: string;
      comms_style: string;
      comms_notes: string;
    };
    expect(row).toEqual({ relationship: "colleague", comms_style: "formal", comms_notes: "prefers email" });
    db.close();
  });

  // 0007 (158): a fresh DB via drizzle migrate() has the additive whatsapp_message.transcript column.
  test("0007 — fresh DB has whatsapp_message.transcript (additive, nullable)", () => {
    const db = freshDb();
    const cols = (db.query("PRAGMA table_info(whatsapp_message)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("transcript");
    // usable + nullable: insert with none set, then set it
    db.query(
      "INSERT INTO whatsapp_message(id, chat_jid, ts, media_type, created_at) VALUES('m1','27000000003@s.whatsapp.net','2026-07-18T00:00:00.000Z','audio','2026-07-18T00:00:00.000Z')",
    ).run();
    expect((db.query("SELECT transcript FROM whatsapp_message WHERE id='m1'").get() as { transcript: string | null }).transcript).toBeNull();
    db.query("UPDATE whatsapp_message SET transcript='hello world' WHERE id='m1'").run();
    expect((db.query("SELECT transcript FROM whatsapp_message WHERE id='m1'").get() as { transcript: string }).transcript).toBe("hello world");
    db.close();
  });

  // 0010 (198b): a fresh DB via drizzle migrate() has the additive whatsapp_message.media_desc column.
  test("0010 — fresh DB has whatsapp_message.media_desc (additive, nullable)", () => {
    const db = freshDb();
    const cols = (db.query("PRAGMA table_info(whatsapp_message)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("media_desc");
    // usable + nullable: insert an image with none set, then set it to a vision description
    db.query(
      "INSERT INTO whatsapp_message(id, chat_jid, ts, media_type, created_at) VALUES('m1','27000000003@s.whatsapp.net','2026-07-18T00:00:00.000Z','image','2026-07-18T00:00:00.000Z')",
    ).run();
    expect((db.query("SELECT media_desc FROM whatsapp_message WHERE id='m1'").get() as { media_desc: string | null }).media_desc).toBeNull();
    db.query("UPDATE whatsapp_message SET media_desc='a photo of a leaking kitchen sink' WHERE id='m1'").run();
    expect((db.query("SELECT media_desc FROM whatsapp_message WHERE id='m1'").get() as { media_desc: string }).media_desc).toBe("a photo of a leaking kitchen sink");
    db.close();
  });

  // 0009 (186b): a fresh DB via drizzle migrate() has the additive whatsapp_message.status column.
  test("0009 — fresh DB has whatsapp_message.status (additive, nullable)", () => {
    const db = freshDb();
    const cols = (db.query("PRAGMA table_info(whatsapp_message)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("status");
    // usable + nullable: insert with none set (NULL = sent), then set it to a receipt state
    db.query(
      "INSERT INTO whatsapp_message(id, chat_jid, ts, is_from_me, created_at) VALUES('m1','27000000003@s.whatsapp.net','2026-07-18T00:00:00.000Z',1,'2026-07-18T00:00:00.000Z')",
    ).run();
    expect((db.query("SELECT status FROM whatsapp_message WHERE id='m1'").get() as { status: string | null }).status).toBeNull();
    db.query("UPDATE whatsapp_message SET status='read' WHERE id='m1'").run();
    expect((db.query("SELECT status FROM whatsapp_message WHERE id='m1'").get() as { status: string }).status).toBe("read");
    db.close();
  });

  // 0008 (169): a fresh DB via drizzle migrate() has the additive whatsapp_chat_pref table with the
  // hidden/ai_disabled flags defaulting to 0 and chat_jid as the primary key (upsert on canonical jid).
  test("0008 — fresh DB has whatsapp_chat_pref (chat_jid PK, hidden/ai_disabled default 0)", () => {
    const db = freshDb();
    expect(tableNames(db)).toContain("whatsapp_chat_pref");
    // defaults: insert only the required chat_jid + updated_at → both flags default to 0
    db.query(
      "INSERT INTO whatsapp_chat_pref(chat_jid, updated_at) VALUES('27000000003@s.whatsapp.net','2026-07-19T00:00:00.000Z')",
    ).run();
    const row = db
      .query("SELECT hidden, ai_disabled FROM whatsapp_chat_pref WHERE chat_jid='27000000003@s.whatsapp.net'")
      .get() as { hidden: number; ai_disabled: number };
    expect(row).toEqual({ hidden: 0, ai_disabled: 0 });
    // chat_jid is the PK → a second row for the same jid is rejected
    expect(() =>
      db
        .query(
          "INSERT INTO whatsapp_chat_pref(chat_jid, updated_at) VALUES('27000000003@s.whatsapp.net','2026-07-19T00:00:01.000Z')",
        )
        .run(),
    ).toThrow();
    db.close();
  });

  // 0012 (190a): a fresh DB via drizzle migrate() has the additive favorite flag on whatsapp_chat_pref,
  // defaulting to 0 (ADD COLUMN — the table itself was created by 0008; no rebuild).
  test("0012 — fresh DB has whatsapp_chat_pref.favorite (defaults to 0)", () => {
    const db = freshDb();
    db.query(
      "INSERT INTO whatsapp_chat_pref(chat_jid, updated_at) VALUES('27000000003@s.whatsapp.net','2026-07-20T00:00:00.000Z')",
    ).run();
    const row = db
      .query("SELECT hidden, ai_disabled, favorite FROM whatsapp_chat_pref WHERE chat_jid='27000000003@s.whatsapp.net'")
      .get() as { hidden: number; ai_disabled: number; favorite: number };
    expect(row).toEqual({ hidden: 0, ai_disabled: 0, favorite: 0 });
    db.close();
  });

  // 0029 (ob 582): a fresh DB via drizzle migrate() has the deploy table — ONE row per deploy target
  // (target PK), holding what the last deploy attempt left actually in service.
  test("0029 — fresh DB has deploy (target PK, one row per target)", () => {
    const db = freshDb();
    expect(tableNames(db)).toContain("deploy");
    const cols = (db.query("PRAGMA table_info(deploy)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(["target", "host", "unit", "sha", "at", "result"]);

    db.query(
      "INSERT INTO deploy(target, host, unit, sha, at, result) VALUES('live','api-host','omnislash-web.service','320207e9a1b2c3d4e5f60718293a4b5c6d7e8f901','2026-09-03T12:00:00.000Z','ok')",
    ).run();
    // target is the PK → a second row for the same target is rejected (the upsert path REPLACES, it
    // never appends), while a different target is a separate row
    expect(() =>
      db
        .query(
          "INSERT INTO deploy(target, host, unit, sha, at, result) VALUES('live','api-host','omnislash-web.service','0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb','2026-09-03T13:00:00.000Z','rolled-back')",
        )
        .run(),
    ).toThrow();
    db.query(
      "INSERT INTO deploy(target, host, unit, sha, at, result) VALUES('web-dev','ob-host','omnislash-web-dev.service','0dfd09b9c8d7e6f5a4b3c2d1e0f1029384756aabb','2026-09-03T13:00:00.000Z','ok')",
    ).run();
    expect((db.query("SELECT count(*) AS n FROM deploy").get() as { n: number }).n).toBe(2);
    db.close();
  });

  // 0015 (#55): a fresh DB via drizzle migrate() has the five additive spinoff token columns, each
  // nullable and defaulting to 0 (ADD COLUMN, the spinoff table itself was created by 0000; no rebuild).
  test("0015 - fresh DB has the spinoff token columns (additive, default 0)", () => {
    const db = freshDb();
    const cols = (db.query("PRAGMA table_info(spinoff)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens", "total_tokens"]) {
      expect(cols).toContain(c);
    }
    // usable + default 0: insert a row with none set, then all five read back as 0
    db.query(
      "INSERT INTO spinoff(ticket_ref, repo, branch, worktree, mode, brief, status, request_at) VALUES('#55','/r','b','/wt','agent','do it','pending','2026-07-21')",
    ).run();
    const row = db
      .query("SELECT input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, total_tokens FROM spinoff WHERE ticket_ref='#55'")
      .get() as Record<string, number>;
    expect(row).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0,
    });
    db.close();
  });

  // 0016 (#56): a fresh DB via drizzle migrate() has the two additive triage-inbox columns on `item`:
  // triage (INTEGER, defaults to 0) and origin_repo (nullable TEXT). ADD COLUMN, no rebuild.
  test("0016 - fresh DB has item.triage (default 0) + item.origin_repo (nullable)", () => {
    const db = freshDb();
    const cols = (db.query("PRAGMA table_info(item)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("triage");
    expect(cols).toContain("origin_repo");
    // default: insert an item without setting either, triage defaults to 0, origin_repo NULL
    db.query(
      "INSERT INTO item(id, type, title, status, created_at, updated_at) VALUES('t1','task','handed over','open','2026-07-21','2026-07-21')",
    ).run();
    const row = db.query("SELECT triage, origin_repo FROM item WHERE id='t1'").get() as {
      triage: number;
      origin_repo: string | null;
    };
    expect(row).toEqual({ triage: 0, origin_repo: null });
    // usable: flag it + record an origin repo
    db.query("UPDATE item SET triage=1, origin_repo='cue-frontend' WHERE id='t1'").run();
    expect(db.query("SELECT triage, origin_repo FROM item WHERE id='t1'").get()).toEqual({
      triage: 1,
      origin_repo: "cue-frontend",
    });
    db.close();
  });

  // 0017 (issue #61, folds #60): a fresh DB via drizzle migrate() has the additive spinoff.base_sha
  // column (nullable TEXT, no default). ADD COLUMN, no rebuild - the spinoff table itself was created
  // by 0000 and already grew the five #55 token columns via 0015.
  test("0017 - fresh DB has spinoff.base_sha (additive, nullable)", () => {
    const db = freshDb();
    const cols = (db.query("PRAGMA table_info(spinoff)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("base_sha");
    // usable + nullable: insert a row with none set, then set it (as launch/adoption would)
    db.query(
      "INSERT INTO spinoff(ticket_ref, repo, branch, worktree, mode, brief, status, request_at) VALUES('#61','/r','b','/wt','agent','do it','pending','2026-07-21')",
    ).run();
    expect((db.query("SELECT base_sha FROM spinoff WHERE ticket_ref='#61'").get() as { base_sha: string | null }).base_sha).toBeNull();
    db.query("UPDATE spinoff SET base_sha='deadbeef' WHERE ticket_ref='#61'").run();
    expect((db.query("SELECT base_sha FROM spinoff WHERE ticket_ref='#61'").get() as { base_sha: string }).base_sha).toBe("deadbeef");
    db.close();
  });

  // 0019 (issue #41): a fresh DB via drizzle migrate() has the additive spinoff.reported_at column
  // (nullable TEXT, no default). ADD COLUMN, no rebuild - the spinoff table itself was created by 0000
  // and already grew 0015's five token columns and 0017's base_sha.
  test("0019 - fresh DB has spinoff.reported_at (additive, nullable)", () => {
    const db = freshDb();
    const cols = (db.query("PRAGMA table_info(spinoff)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("reported_at");
    // usable + nullable: insert a row with none set, then stamp it (as a watch report would)
    db.query(
      "INSERT INTO spinoff(ticket_ref, repo, branch, worktree, mode, brief, status, request_at) VALUES('#41','/r','b','/wt','agent','do it','pending','2026-07-28')",
    ).run();
    expect((db.query("SELECT reported_at FROM spinoff WHERE ticket_ref='#41'").get() as { reported_at: string | null }).reported_at).toBeNull();
    db.query("UPDATE spinoff SET reported_at='2026-07-28T00:00:00.000Z' WHERE ticket_ref='#41'").run();
    expect((db.query("SELECT reported_at FROM spinoff WHERE ticket_ref='#41'").get() as { reported_at: string }).reported_at).toBe("2026-07-28T00:00:00.000Z");
    db.close();
  });

  // 0020 (issue #125): a fresh DB via drizzle migrate() has the additive `launcher` column on BOTH
  // spinoff and agent (nullable TEXT, no default, NO backfill). Two ADD COLUMNs, no rebuild - both
  // tables were created by 0000 and only ever grow appended columns.
  test("0020 - fresh DB has spinoff.launcher + agent.launcher (additive, nullable, no backfill)", () => {
    const db = freshDb();
    const spinoffCols = (db.query("PRAGMA table_info(spinoff)").all() as { name: string }[]).map((c) => c.name);
    const agentCols = (db.query("PRAGMA table_info(agent)").all() as { name: string }[]).map((c) => c.name);
    expect(spinoffCols).toContain("launcher");
    expect(agentCols).toContain("launcher");
    // usable + nullable on both: a row written without one reads NULL ("unknown"), then takes a value
    db.query(
      "INSERT INTO spinoff(ticket_ref, repo, branch, worktree, mode, brief, status, request_at) VALUES('#125','/r','b','/wt','agent','do it','pending','2026-07-28')",
    ).run();
    expect((db.query("SELECT launcher FROM spinoff WHERE ticket_ref='#125'").get() as { launcher: string | null }).launcher).toBeNull();
    db.query("UPDATE spinoff SET launcher='warp' WHERE ticket_ref='#125'").run();
    expect((db.query("SELECT launcher FROM spinoff WHERE ticket_ref='#125'").get() as { launcher: string }).launcher).toBe("warp");
    db.query(
      "INSERT INTO agent(id, started_at, heartbeat_at, ttl_s) VALUES('architect-acme','2026-07-28','2026-07-28',900)",
    ).run();
    expect((db.query("SELECT launcher FROM agent WHERE id='architect-acme'").get() as { launcher: string | null }).launcher).toBeNull();
    db.query("UPDATE agent SET launcher='warp' WHERE id='architect-acme'").run();
    expect((db.query("SELECT launcher FROM agent WHERE id='architect-acme'").get() as { launcher: string }).launcher).toBe("warp");
    db.close();
  });

  // 0022 (issue #126): a fresh DB via drizzle migrate() has the additive session_id column on BOTH
  // spinoff and agent (nullable TEXT, no default). ADD COLUMN on tables 0000 created - no rebuild - and
  // no backfill, because a launch that was never given a session id has nothing to resume.
  test("0022 - fresh DB has spinoff.session_id and agent.session_id (additive, nullable)", async () => {
    const db = freshDb();
    for (const table of ["spinoff", "agent"]) {
      const cols = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols).toContain("session_id");
    }
    db.query(
      "INSERT INTO spinoff(ticket_ref, repo, branch, worktree, mode, brief, status, request_at) VALUES('#126','/r','b','/wt','agent','do it','pending','2026-07-30')",
    ).run();
    expect((db.query("SELECT session_id FROM spinoff WHERE ticket_ref='#126'").get() as { session_id: string | null }).session_id).toBeNull();
    db.query("UPDATE spinoff SET session_id='0f9f1d2c-0000-4000-8000-000000000001' WHERE ticket_ref='#126'").run();
    expect((db.query("SELECT session_id FROM spinoff WHERE ticket_ref='#126'").get() as { session_id: string }).session_id).toBe(
      "0f9f1d2c-0000-4000-8000-000000000001",
    );
    (await registerAgent(db, { id: "resume-1", ticket: "#126", status: "working", sessionId: "0f9f1d2c-0000-4000-8000-000000000002", ttlS: 900 }));
    expect((db.query("SELECT session_id FROM agent WHERE id='resume-1'").get() as { session_id: string }).session_id).toBe(
      "0f9f1d2c-0000-4000-8000-000000000002",
    );
  });

  // 0021 (issue #151): a fresh DB via drizzle migrate() has the additive spinoff.launch_attempts column
  // (INTEGER, default 0). ADD COLUMN, no rebuild. It defaults rather than being nullable because the
  // count is what BOUNDS the retry of a reported spawn failure, and "no launches yet" is 0, not unknown.
  test("0021 - fresh DB has spinoff.launch_attempts (additive, default 0)", () => {
    const db = freshDb();
    const cols = (db.query("PRAGMA table_info(spinoff)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("launch_attempts");
    db.query(
      "INSERT INTO spinoff(ticket_ref, repo, branch, worktree, mode, brief, status, request_at) VALUES('#151','/r','b','/wt','agent','do it','pending','2026-07-30')",
    ).run();
    expect((db.query("SELECT launch_attempts FROM spinoff WHERE ticket_ref='#151'").get() as { launch_attempts: number }).launch_attempts).toBe(0);
    db.query("UPDATE spinoff SET launch_attempts=2 WHERE ticket_ref='#151'").run();
    expect((db.query("SELECT launch_attempts FROM spinoff WHERE ticket_ref='#151'").get() as { launch_attempts: number }).launch_attempts).toBe(2);
    db.close();
  });

});

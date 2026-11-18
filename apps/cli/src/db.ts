import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { AppError } from "./errors.ts";
// The contention vocabulary lives next to the write seam it also serves (317); openDb's own retry
// loop and every command's writes then agree on what "busy" means.
import { isBusyFailure, matchesSqliteError, sqliteReason } from "./db/busy.ts";
// 337: the configured engine, from the one module that parses it. store-kind.ts deliberately depends on
// nothing but errors.ts so this import cannot become the cycle db.ts <-> db/store.ts would be.
import { resolveStoreKind, SQLITE_ESCAPE_HATCH, STORE_ENV } from "./db/store-kind.ts";
import { POSTGRES_SERVABLE_COMMANDS } from "./db/servable.ts";

export function defaultDbPath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
  return join(base, "omnislash", "omnislash.sqlite");
}

export function resolveDbPath(flagDb?: string): string {
  if (flagDb && flagDb.length > 0) return flagDb;
  const env = process.env.OMNISLASH_DB;
  if (env && env.length > 0) return env;
  return defaultDbPath();
}

// Historical pre-drizzle migration chain (v1→v18). RETAINED (and exported) after the move to
// drizzle-kit/migrate() (099) because: the DB-migration safety-net replays it to reconstruct a
// genuine pre-drizzle v18 DB, and LEGACY_SCHEMA_VERSION (below) is derived from its length. It is no
// longer executed by openDb — the drizzle 0000 baseline (generated FROM this chain's final state) is.
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE item (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT,
    status      TEXT NOT NULL,
    project_id  TEXT REFERENCES project(id),
    priority    INTEGER,
    today_rank  INTEGER,
    block_reason TEXT,
    block_owner  TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    closed_at   TEXT
  );

  CREATE TABLE task_detail (
    item_id        TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
    points         INTEGER,
    lifecycle_state TEXT,
    assignee       TEXT,
    pr_url         TEXT,
    branch         TEXT
  );

  CREATE TABLE linear_ref (
    item_id         TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
    linear_id       TEXT,
    url             TEXT,
    cached_title    TEXT,
    cached_state    TEXT,
    cached_priority INTEGER,
    last_synced_at  TEXT
  );

  CREATE TABLE project (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    git_remote  TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE tag (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE item_tag (
    item_id TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
    tag_id  INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, tag_id)
  );

  CREATE TABLE item_link (
    from_item TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
    to_item   TEXT NOT NULL REFERENCES item(id) ON DELETE CASCADE,
    rel_type  TEXT NOT NULL,
    PRIMARY KEY (from_item, to_item, rel_type)
  );

  CREATE TABLE skill_cursor (
    skill      TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (skill, key)
  );

  CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE event (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    source   TEXT,
    type     TEXT,
    item_id  TEXT REFERENCES item(id) ON DELETE SET NULL,
    actor    TEXT,
    cause    TEXT,
    payload  TEXT
  );

  CREATE TABLE lease (
    resource     TEXT PRIMARY KEY,
    holder       TEXT,
    acquired_at  TEXT,
    ttl_s        INTEGER,
    heartbeat_at TEXT
  );

  CREATE INDEX idx_item_type_status ON item(type, status, project_id, priority);
  CREATE INDEX idx_item_link_from ON item_link(from_item);
  CREATE INDEX idx_item_link_to ON item_link(to_item);
  CREATE INDEX idx_item_tag_tag ON item_tag(tag_id);

  CREATE VIRTUAL TABLE item_fts USING fts5(item_id UNINDEXED, title, body);
  `,
  // v2 — measurement layer: epic snapshots, alert acks, event indexes
  `
  CREATE TABLE epic_snapshot (
    epic_ref    TEXT NOT NULL,
    snapshot_at TEXT NOT NULL,
    state       TEXT NOT NULL,
    PRIMARY KEY (epic_ref, snapshot_at)
  );

  CREATE TABLE alert_ack (
    alert_key     TEXT PRIMARY KEY,
    state_hash    TEXT,
    snoozed_at    TEXT NOT NULL
  );

  CREATE INDEX idx_event_item_type_ts ON event(item_id, type, ts);
  CREATE INDEX idx_event_source_type_ts ON event(source, type, ts);
  CREATE INDEX idx_epic_snapshot ON epic_snapshot(epic_ref, snapshot_at);
  `,
  // v3 — richer entities (roadmap/decision/learning) + workflow reference data
  `
  CREATE TABLE roadmap_detail (
    item_id     TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
    target_date TEXT,
    source_ref  TEXT,
    owner       TEXT
  );

  CREATE TABLE decision_detail (
    item_id      TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
    context      TEXT,
    choice       TEXT,
    rationale    TEXT,
    alternatives TEXT,
    decided_at   TEXT
  );

  CREATE TABLE learning_detail (
    item_id  TEXT PRIMARY KEY REFERENCES item(id) ON DELETE CASCADE,
    kind     TEXT,
    progress TEXT,
    source   TEXT,
    why      TEXT
  );

  CREATE TABLE stakeholder (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    scope      TEXT NOT NULL,          -- project | epic
    scope_ref  TEXT NOT NULL,          -- project id or epic ref
    name       TEXT NOT NULL,
    channel    TEXT,                   -- slack | linear | email | ...
    handle     TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE test_user (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    label         TEXT NOT NULL UNIQUE,
    email         TEXT,
    role          TEXT,
    workspace     TEXT,
    env           TEXT,
    secret_ref    TEXT,                -- macOS Keychain item name; ob never stores the secret
    notes         TEXT,
    secret_set_at TEXT,
    last_used     TEXT
  );

  ALTER TABLE item_link ADD COLUMN position INTEGER;

  CREATE INDEX idx_stakeholder_scope ON stakeholder(scope, scope_ref);
  `,
  // v4 — persist PR review comment bodies (durable, searchable review corpus)
  `
  CREATE TABLE pr_comment (
    id          TEXT PRIMARY KEY,   -- GitHub GraphQL node id (idempotent upsert)
    pr          TEXT NOT NULL,      -- owner/repo#number
    repo        TEXT,
    author      TEXT,
    kind        TEXT,               -- review | line
    path        TEXT,               -- file path for line comments
    state       TEXT,               -- review state (reviews only)
    body        TEXT,
    after_ready INTEGER,            -- 1 if posted after the last ready-for-review
    bot         INTEGER,            -- 1 if the author is a bot
    created_at  TEXT
  );

  CREATE INDEX idx_pr_comment_pr ON pr_comment(pr);
  CREATE INDEX idx_pr_comment_author ON pr_comment(author);
  CREATE VIRTUAL TABLE pr_comment_fts USING fts5(id UNINDEXED, body);
  `,
  // v5 — person identity registry: one human across GitHub/Linear/Slack, hand-maintained (033-037)
  `
  CREATE TABLE person (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    real_name      TEXT NOT NULL,
    role           TEXT,
    github_login   TEXT,
    linear_user_id TEXT,
    linear_name    TEXT,
    slack_user_id  TEXT,
    slack_handle   TEXT,
    email          TEXT,
    notes          TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  -- partial-unique per key handle: a handle maps to ≤1 person, so ob whois is unambiguous
  CREATE UNIQUE INDEX idx_person_github ON person(github_login)   WHERE github_login   IS NOT NULL;
  CREATE UNIQUE INDEX idx_person_linear ON person(linear_user_id) WHERE linear_user_id IS NOT NULL;
  CREATE UNIQUE INDEX idx_person_slack  ON person(slack_user_id)  WHERE slack_user_id  IS NOT NULL;
  `,
  // v6 — agent activity registry: who's working on what right now, report-in via ob agent (043-045)
  `
  CREATE TABLE agent (
    id           TEXT PRIMARY KEY,
    ticket       TEXT,
    worktree     TEXT,
    branch       TEXT,
    status       TEXT,
    started_at   TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    ttl_s        INTEGER NOT NULL
  );

  CREATE INDEX idx_agent_heartbeat ON agent(heartbeat_at);
  `,
  // v7 — epic scope audit: gaps + audit runs (epic-scope-audit skill, 051-054)
  `
  CREATE TABLE audit_run (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_ref   TEXT NOT NULL,
    run_at     TEXT NOT NULL,
    coverage   TEXT
  );

  CREATE TABLE gap (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_ref       TEXT NOT NULL,
    title          TEXT NOT NULL,
    title_key      TEXT NOT NULL,
    status         TEXT NOT NULL,
    source         TEXT,
    filed_ticket   TEXT,
    resolved       INTEGER NOT NULL DEFAULT 0,
    first_seen_run INTEGER REFERENCES audit_run(id) ON DELETE SET NULL,
    last_seen_run  INTEGER REFERENCES audit_run(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );

  CREATE UNIQUE INDEX idx_gap_epic_key ON gap(epic_ref, title_key);
  CREATE INDEX idx_audit_run_epic ON audit_run(epic_ref, run_at);
  `,
  // v8 — spinoff launch queue: ob spinoff enqueues, the launchd daemon drains in-session. (055-057)
  `
  CREATE TABLE spinoff (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_ref  TEXT NOT NULL,
    repo        TEXT NOT NULL,
    branch      TEXT NOT NULL,
    worktree    TEXT NOT NULL,
    mode        TEXT NOT NULL,
    brief       TEXT NOT NULL,
    status      TEXT NOT NULL,
    error       TEXT,
    agent_id    TEXT,
    request_at  TEXT NOT NULL,
    launched_at TEXT
  );

  -- no double-pending launch for the same ticket; drain claims pending→launching transactionally
  CREATE UNIQUE INDEX idx_spinoff_active ON spinoff(ticket_ref) WHERE status IN ('pending', 'launching');
  `,
  // v9 — agent reason note (058): a short "why" alongside status (esp. the manual-review outcome)
  `
  ALTER TABLE agent ADD COLUMN note TEXT;
  `,
  // v10 — spinoff epic (061): group/colour a spun-off tab by its epic
  `
  ALTER TABLE spinoff ADD COLUMN epic TEXT;
  `,
  // v11 — epic registry (063/064): epics first-class + hard-FK the epic_ref columns onto epic(epic_ref).
  // Runs with foreign_keys OFF (see migrate) so the table rebuilds — needed because SQLite can't add a
  // FK to an existing column — are safe. Backfill an epic row per distinct existing ref first.
  `
  CREATE TABLE epic (
    epic_ref   TEXT PRIMARY KEY,
    title      TEXT,
    state      TEXT,
    color      TEXT,
    created_at TEXT,
    updated_at TEXT
  );

  INSERT OR IGNORE INTO epic(epic_ref, created_at, updated_at)
    SELECT DISTINCT epic_ref, datetime('now'), datetime('now') FROM audit_run     WHERE epic_ref IS NOT NULL;
  INSERT OR IGNORE INTO epic(epic_ref, created_at, updated_at)
    SELECT DISTINCT epic_ref, datetime('now'), datetime('now') FROM gap           WHERE epic_ref IS NOT NULL;
  INSERT OR IGNORE INTO epic(epic_ref, created_at, updated_at)
    SELECT DISTINCT epic_ref, datetime('now'), datetime('now') FROM epic_snapshot WHERE epic_ref IS NOT NULL;
  INSERT OR IGNORE INTO epic(epic_ref, created_at, updated_at)
    SELECT DISTINCT epic,     datetime('now'), datetime('now') FROM spinoff       WHERE epic     IS NOT NULL;

  -- audit_run first (gap references audit_run.id)
  CREATE TABLE audit_run_new (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_ref TEXT NOT NULL REFERENCES epic(epic_ref),
    run_at   TEXT NOT NULL,
    coverage TEXT
  );
  INSERT INTO audit_run_new (id, epic_ref, run_at, coverage)
    SELECT id, epic_ref, run_at, coverage FROM audit_run;
  DROP TABLE audit_run;
  ALTER TABLE audit_run_new RENAME TO audit_run;
  CREATE INDEX idx_audit_run_epic ON audit_run(epic_ref, run_at);

  CREATE TABLE gap_new (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_ref       TEXT NOT NULL REFERENCES epic(epic_ref),
    title          TEXT NOT NULL,
    title_key      TEXT NOT NULL,
    status         TEXT NOT NULL,
    source         TEXT,
    filed_ticket   TEXT,
    resolved       INTEGER NOT NULL DEFAULT 0,
    first_seen_run INTEGER REFERENCES audit_run(id) ON DELETE SET NULL,
    last_seen_run  INTEGER REFERENCES audit_run(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  INSERT INTO gap_new (id, epic_ref, title, title_key, status, source, filed_ticket, resolved, first_seen_run, last_seen_run, created_at, updated_at)
    SELECT id, epic_ref, title, title_key, status, source, filed_ticket, resolved, first_seen_run, last_seen_run, created_at, updated_at FROM gap;
  DROP TABLE gap;
  ALTER TABLE gap_new RENAME TO gap;
  CREATE UNIQUE INDEX idx_gap_epic_key ON gap(epic_ref, title_key);

  CREATE TABLE epic_snapshot_new (
    epic_ref    TEXT NOT NULL REFERENCES epic(epic_ref),
    snapshot_at TEXT NOT NULL,
    state       TEXT NOT NULL,
    PRIMARY KEY (epic_ref, snapshot_at)
  );
  INSERT INTO epic_snapshot_new (epic_ref, snapshot_at, state)
    SELECT epic_ref, snapshot_at, state FROM epic_snapshot;
  DROP TABLE epic_snapshot;
  ALTER TABLE epic_snapshot_new RENAME TO epic_snapshot;
  CREATE INDEX idx_epic_snapshot ON epic_snapshot(epic_ref, snapshot_at);

  CREATE TABLE spinoff_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_ref  TEXT NOT NULL,
    repo        TEXT NOT NULL,
    branch      TEXT NOT NULL,
    worktree    TEXT NOT NULL,
    mode        TEXT NOT NULL,
    brief       TEXT NOT NULL,
    status      TEXT NOT NULL,
    error       TEXT,
    agent_id    TEXT,
    epic        TEXT REFERENCES epic(epic_ref),
    request_at  TEXT NOT NULL,
    launched_at TEXT
  );
  INSERT INTO spinoff_new (id, ticket_ref, repo, branch, worktree, mode, brief, status, error, agent_id, epic, request_at, launched_at)
    SELECT id, ticket_ref, repo, branch, worktree, mode, brief, status, error, agent_id, epic, request_at, launched_at FROM spinoff;
  DROP TABLE spinoff;
  ALTER TABLE spinoff_new RENAME TO spinoff;
  CREATE UNIQUE INDEX idx_spinoff_active ON spinoff(ticket_ref) WHERE status IN ('pending', 'launching');
  `,
  // v12 — epic rescope log (066): scope-change events with why-done + why-missed, FK'd to epic
  `
  CREATE TABLE scope_change (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    epic_ref      TEXT NOT NULL REFERENCES epic(epic_ref),
    at            TEXT NOT NULL,
    summary       TEXT,
    reason        TEXT,
    missed_reason TEXT,
    added_refs    TEXT
  );
  CREATE INDEX idx_scope_change_epic ON scope_change(epic_ref, at);
  `,
  // v13 — agent epic (069): group ob status work by epic. ADD COLUMN can carry a FK (nullable, no
  // default) without a table rebuild. create-before-ref via ensureEpic in registerAgent.
  `
  ALTER TABLE agent ADD COLUMN epic TEXT REFERENCES epic(epic_ref);
  `,
  // v14 — ticket→epic mapping (070): a cache of each Cue ticket's epic (nearest registered ancestor),
  // synced from Linear's parent chain, so PRs/agents resolve to an epic. FK'd (create-before-ref).
  `
  CREATE TABLE ticket_epic (
    ticket_ref TEXT PRIMARY KEY,
    epic_ref   TEXT NOT NULL REFERENCES epic(epic_ref),
    synced_at  TEXT NOT NULL
  );
  CREATE INDEX idx_ticket_epic_epic ON ticket_epic(epic_ref);
  `,
  // v15 — epic progress (072): cached rollup of the epic's leaf-issue states (done/total + by_state),
  // synced from Linear's child tree. JSON blob {total, done, by_state, synced_at}.
  `
  ALTER TABLE epic ADD COLUMN progress TEXT;
  `,
  // v16 — epic-ref namespace reconciliation (076): snapshots are re-keyed to CUE epics (snapshotEpics),
  // so purge the legacy project-UUID snapshot rows + their orphan registry rows. UUIDs carry lowercase
  // hex; CUE keys are all-caps + digits, so GLOB '*[a-z]*' matches only the UUID refs.
  `
  DELETE FROM epic_snapshot WHERE epic_ref GLOB '*[a-z]*';
  DELETE FROM epic WHERE epic_ref GLOB '*[a-z]*';
  `,
  // v17 — epic progress history (078): daily done/total time-series per epic (type-based, from the
  // rollup) so reports can show a progress DELTA over a window. PK (epic_ref, date) = one row/day.
  `
  CREATE TABLE epic_progress_snapshot (
    epic_ref TEXT NOT NULL REFERENCES epic(epic_ref),
    at       TEXT NOT NULL,
    done     INTEGER NOT NULL,
    total    INTEGER NOT NULL,
    by_state TEXT,
    PRIMARY KEY (epic_ref, at)
  );
  `,

  // v18 — standup store (086): the generated standup (from the scheduled skill run) + the user's edit,
  // one row per day. Effective text = edited_md ?? generated_md. status: generated → edited → posted.
  `
  CREATE TABLE standup (
    date         TEXT PRIMARY KEY,
    generated_md TEXT,
    edited_md    TEXT,
    status       TEXT NOT NULL DEFAULT 'generated',
    generated_at TEXT,
    edited_at    TEXT,
    posted_at    TEXT
  );
  `,
];

// The schema version the historical MIGRATIONS chain produced (v18). Kept as a coherence marker in
// PRAGMA user_version so a fresh drizzle-built DB and an adopted legacy DB report the same version.
export const LEGACY_SCHEMA_VERSION = MIGRATIONS.length;

// drizzle-kit still GENERATES the migrations, and they live next to this file (src/db/migrations):
// meta/_journal.json plus one <tag>.sql each. Resolved off import.meta.url so it works when ob runs
// from source. applyMigrations (below) reads them in drizzle's own format; only the APPLYING moved
// in-house (223).
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./db/migrations", import.meta.url));

// drizzle's bookkeeping table, kept byte-for-byte compatible (same name, same DDL, same rows) so a DB
// this code has touched is still a DB drizzle's own migrate() would understand.
const DRIZZLE_BOOKKEEPING = "__drizzle_migrations";

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(name) != null;
}

// ── applying migrations (223) ──────────────────────────────────────────────────────────────────────
//
// WHY THIS IS NOT drizzle's migrate() ANY MORE. On 2026-08-16 the live tracker became unopenable for
// six minutes: `credential_check` (0026) existed and was empty while 0026 was NOT recorded in
// __drizzle_migrations, so every `ob` re-ran 0026, hit "table already exists", and failed. Forever:
// nothing in that loop can ever make progress, and a half-recorded database is not self-healing.
//
// drizzle's sync migrator (sqlite-core/dialect.js) does wrap the DDL and its bookkeeping INSERT in one
// transaction, and DDL is transactional in SQLite, so a plain race cannot split them -- measured here
// as 128 concurrent openers over 8 rounds against a writer plus mid-migration SIGKILLs, with zero half
// states. But two things it does are still wrong for a database that 13 daemons hit continuously:
//
//   1. It reads "what is the newest applied migration" OUTSIDE the transaction that then applies one,
//      and it opens that transaction with a deferred BEGIN. So every concurrent opener independently
//      decides the same migration is outstanding and they all attempt the DDL; all but one lose, and
//      the losers surface a deterministic "already exists" that is really just contention. Deciding
//      INSIDE a BEGIN IMMEDIATE makes the decision and the apply one critical section, so a loser
//      simply waits on the write lock (covered by busy_timeout) and then sees the work already done.
//   2. It has no way back out of the orphan shape, whatever produced it -- a migration whose objects
//      are all present but which is not recorded. Since drizzle keys "applied" on created_at alone and
//      never on the hash, a database can reach that shape from outside this code path entirely (an
//      earlier-generated variant of the same migration applied against it, a restored backup, a
//      hand-repair) and there is no sequence of `ob` commands that recovers. repairOrphan below is
//      that way out, and it refuses to guess: it adopts a migration only when EVERY statement in it is
//      already satisfied, and reports a genuinely partial one instead.
//
// The guarantee: after any openDb, the database is either fully migrated or exactly as it was before.
// A migration that cannot proceed rolls back and fails loudly naming its tag, and never persists a
// state a later open cannot get out of.

export interface Migration {
  tag: string;
  when: number;
  hash: string;
  statements: string[];
}

/** Read the migration files exactly as drizzle's readMigrationFiles does (same split, same sha256 of
 *  the raw file), but keeping the journal tag, which drizzle drops and which is the one thing a human
 *  reading a failure actually needs. */
export function readMigrations(): Migration[] {
  return migrationJournal().map((entry) => {
    const sqlText = readFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), "utf8");
    return {
      tag: entry.tag,
      when: entry.when,
      hash: createHash("sha256").update(sqlText).digest("hex"),
      statements: sqlText.split("--> statement-breakpoint"),
    };
  });
}

/** Run one statement-breakpoint chunk. PREPARE, never exec: prepare compiles the first statement and
 *  ignores whatever trails it, which is load-bearing because 0014 carries a stray `</content>` line
 *  after its last semicolon that exec() rejects outright. drizzle prepared too, so this is the same
 *  behaviour every already-applied migration was applied under. */
function runStatement(db: Database, statement: string): void {
  db.prepare(statement).run();
}

/** The newest applied migration's `when`, or -1 for a database with no bookkeeping rows. No longer the
 *  "applied" test (OB-1913, see isRecorded): it only says whether an outstanding migration is an old gap,
 *  i.e. something newer is already recorded, and whether adoption has seeded anything yet. */
function newestApplied(db: Database): number {
  const row = db.query(`SELECT MAX(created_at) AS newest FROM "${DRIZZLE_BOOKKEEPING}"`).get() as
    | { newest: number | null }
    | null;
  const newest = row?.newest;
  return newest === null || newest === undefined ? -1 : Number(newest);
}

/** Applied means recorded, per migration (OB-1913): a bookkeeping row carries this migration's own
 *  journal `when`, or its sha256. The `when` is the stable identity (every row drizzle and this code ever
 *  wrote carries the migration's own `when`); a hash match under another `when` counts on purpose, since
 *  the same SQL bytes were already run. The old rule (newest recorded >= `when`) skipped forever any
 *  migration with no row of its own once anything newer was recorded. */
function isRecorded(db: Database, m: Migration): boolean {
  return (
    db.query(`SELECT 1 AS n FROM "${DRIZZLE_BOOKKEEPING}" WHERE created_at = ? OR hash = ? LIMIT 1`).get(m.when, m.hash) != null
  );
}

/** Say when the per-migration rule finds a gap the old newest-timestamp rule skipped: an outstanding
 *  migration with a later one already recorded. Same voice as the repair note. */
function noteGap(db: Database, m: Migration): void {
  if (newestApplied(db) > m.when) {
    console.error(
      `ob: applying migration ${m.tag}: it was never recorded as applied although a later migration is, so it was skipped until now.`,
    );
  }
}

function recordApplied(db: Database, m: Migration): void {
  db.query(`INSERT INTO "${DRIZZLE_BOOKKEEPING}" ("hash", "created_at") VALUES (?, ?)`).run(m.hash, m.when);
}

function rollbackQuietly(db: Database): void {
  try {
    db.exec("ROLLBACK;");
  } catch {
    // the statement that failed may already have rolled the transaction back; nothing to undo then.
  }
}

/** Run `body` inside an EXCLUSIVE write transaction. IMMEDIATE rather than deferred so the write lock
 *  is taken before anything is read: whatever `body` decides from the database is decided under the
 *  lock, and a concurrent migrator waits here (busy_timeout) instead of racing to the same DDL. */
function withWriteLock<T>(db: Database, body: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const result = body();
    db.exec("COMMIT;");
    return result;
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

/** A deterministic "this object is already here" from SQLite: the orphan shape's signature. Kept
 *  separate from busy, which looks superficially similar and means the opposite (try again). */
function isObjectAlreadyPresent(err: unknown): boolean {
  return matchesSqliteError(err, (message) => /already exists/i.test(message) || /duplicate column name/i.test(message));
}

/** A migration that could not be applied. Names the TAG, which is what identifies it to a human, and
 *  the underlying sqlite reason, never the SQL body. */
export class MigrationError extends AppError {
  readonly tag: string;
  constructor(tag: string, cause: unknown) {
    super(
      [
        `migration ${tag} could not be applied: ${sqliteReason(cause)}`,
        `  the database is unchanged (the migration rolled back), and ob cannot open it until this is resolved`,
      ].join("\n"),
    );
    this.tag = tag;
    this.cause = cause;
  }
}

/** Is every statement of `m` already satisfied by this database? Answered by ATTEMPTING each statement
 *  in a transaction that is always rolled back, so no parsing of the SQL is involved and no effect
 *  survives the probe. A statement that SUCCEEDS means the migration still has real work to do, so the
 *  database is genuinely part-applied and adopting it would silently skip that work. */
function migrationIsWhollyRedundant(db: Database, m: Migration): boolean {
  db.exec("BEGIN IMMEDIATE;");
  try {
    let sawObject = false;
    for (const statement of m.statements) {
      if (statement.trim().length === 0) continue;
      // A data statement (a backfill, 1949) creates no object, so it says nothing about whether this
      // migration's objects are present. The pg chain's alreadyApplied skips them the same way.
      if (isDataStatement(statement)) continue;
      try {
        runStatement(db, statement);
        return false;
      } catch (err) {
        if (!isObjectAlreadyPresent(err)) return false;
        sawObject = true;
      }
    }
    // A migration of data statements only proves nothing, so it is never adopted unrun.
    return sawObject;
  } finally {
    rollbackQuietly(db);
  }
}

/** Migrations whose data statements are guarded, so the orphan repair may re-run them (1949). Older ones
 *  are not: 0019 re-stamps every merged row's reported_at, and 0035 copies into a table it later renamed. */
const REPLAY_DATA_ON_REPAIR = new Set(["0037_per_project_refs"]);

/** UPDATE / INSERT / DELETE, once the chunk's leading `--` note is stripped. */
function isDataStatement(statement: string): boolean {
  const body = statement.trim().replace(/^(?:--[^\n]*\n?)+/, "").trim();
  return /^(UPDATE|INSERT|DELETE)\b/i.test(body);
}

/** Recover from the orphan shape: the migration's objects are all present but it is not recorded, so
 *  re-running it can only ever fail. Record it as applied WITHOUT re-running it, which is the same
 *  adopt-rather-than-replay move adoptDrizzleBaselineIfLegacy already makes for the v18 baseline.
 *  Returns false when the database is only PART-way through the migration, because that needs a human
 *  and a guess would lose whatever the remaining statements do. A migration with a backfill that is not
 *  known safe to re-run is refused by tag rather than recorded with its backfill unrun (OB-1913). */
function repairOrphan(db: Database, m: Migration): boolean {
  if (!migrationIsWhollyRedundant(db, m)) return false;
  const replay = REPLAY_DATA_ON_REPAIR.has(m.tag);
  const hasData = m.statements.some(isDataStatement);
  let repaired = false;
  withWriteLock(db, () => {
    if (isRecorded(db, m)) return; // another opener repaired it while we probed
    if (hasData && !replay) {
      throw new MigrationError(
        m.tag,
        new Error(
          "every object it creates is already present but it is not recorded, and its backfill is not known safe to re-run, so it was not repaired",
        ),
      );
    }
    // The probe skipped the data statements, so a backfill whose DDL is present may never have run: re-run
    // it where that is known to be safe.
    if (replay) for (const statement of m.statements) if (isDataStatement(statement)) runStatement(db, statement);
    recordApplied(db, m);
    repaired = true;
  });
  if (!repaired) return true;
  console.error(
    `ob: repaired migration ${m.tag}: every object it creates was already present but it was not recorded as applied, so it has been recorded ${replay ? "after re-running only its data statements" : "without re-running it"}.`,
  );
  return true;
}

/** Apply every outstanding migration, one transaction each, deciding under the write lock. `migrations`
 *  is the test seam (OB-1913); openDb always passes the real chain. */
export function applyMigrations(db: Database, migrations: Migration[] = readMigrations()): void {
  // Outside the per-migration transaction, exactly as drizzle does it, and safe to race on: it is
  // CREATE TABLE IF NOT EXISTS, so concurrent openers converge on the same empty bookkeeping table.
  db.exec(`CREATE TABLE IF NOT EXISTS "${DRIZZLE_BOOKKEEPING}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
  for (const m of migrations) {
    try {
      withWriteLock(db, () => {
        if (isRecorded(db, m)) return; // already applied, or applied by whoever held the lock before us
        for (const statement of m.statements) {
          if (statement.trim().length === 0) continue;
          runStatement(db, statement);
        }
        // After the statements, so an orphan (which fails on "already exists" and is repaired below)
        // prints only the repair note, as pg does.
        noteGap(db, m);
        recordApplied(db, m);
      });
    } catch (err) {
      if (isBusyFailure(err)) throw err; // contention: openDb's retry loop owns this one
      if (!isObjectAlreadyPresent(err) || !repairOrphan(db, m)) throw new MigrationError(m.tag, err);
    }
  }
}

// Baseline adoption for an EXISTING pre-drizzle DB (the user's live DB at merge: built by the legacy
// MIGRATIONS chain, so it has real tables + data but no drizzle bookkeeping). We record the 0000
// baseline as already-applied so applyMigrations SKIPS it: a migration is applied when a row carries its
// own journal `when` or its hash (isRecorded, OB-1913), so seeding a row with 0000's `when` makes 0000 a
// no-op and it never recreates the live tables. No-op
// for a fresh/empty DB (applyMigrations then builds 0000) and for an already-drizzle-managed DB
// (bookkeeping already present).
function adoptDrizzleBaselineIfLegacy(db: Database): void {
  if (hasTable(db, DRIZZLE_BOOKKEEPING)) return; // already managed by drizzle
  if (!hasTable(db, "item")) return; // fresh/empty DB — let applyMigrations create everything from 0000
  const baseline = migrationJournal()[0];
  if (!baseline) throw new Error("drizzle journal has no baseline (0000) entry");
  // hash exactly as drizzle's readMigrationFiles does (sha256 of the raw .sql file), so the seeded row is
  // indistinguishable from a genuine one: both its `when` and its hash mark 0000 applied (isRecorded).
  const sqlText = readFileSync(join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`), "utf8");
  const hash = createHash("sha256").update(sqlText).digest("hex");
  // Under the write lock, and re-checked inside it (223): two openers that both found no bookkeeping
  // a moment ago must not both seed a baseline row, or the DB carries a duplicate 0000 for good.
  withWriteLock(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS "${DRIZZLE_BOOKKEEPING}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`);
    if (newestApplied(db) >= 0) return;
    db.query(`INSERT INTO "${DRIZZLE_BOOKKEEPING}" ("hash", "created_at") VALUES (?, ?)`).run(hash, baseline.when);
  });
}

function migrationJournal(): { tag: string; when: number }[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  return journal.entries;
}

// The `when` half of applyMigrations' rule, asked cheaply (OB-1913): outstanding iff some journal `when`
// has no row. No hashing of files on every open; a hash-only match just means applyMigrations runs and
// finds nothing to do. "Nothing outstanding" means applyMigrations would be a no-op. Worth short-circuiting because it otherwise opens a write
// transaction on EVERY `ob` invocation even with nothing to apply, and that transaction is what dozens
// of concurrent `ob` processes were queueing behind (149).
function migrationsOutstanding(db: Database): boolean {
  if (!hasTable(db, DRIZZLE_BOOKKEEPING)) return true;
  const rows = db.query(`SELECT created_at FROM "${DRIZZLE_BOOKKEEPING}"`).all() as { created_at: number | string | null }[];
  const recorded = new Set(rows.map((r) => Number(r.created_at)));
  return migrationJournal().some((entry) => !recorded.has(entry.when));
}

const OPEN_ATTEMPTS = 6;
const OPEN_RETRY_BASE_MS = 30;

/**
 * Process-wide opt-in that allows creating a database (198). For the test suites, which allocate
 * throwaway databases constantly (wired once in `apps/cli/test/preload.ts`),
 * and as the one-command escape hatch the refusal names.
 */
export const DB_CREATE_ENV = "OMNISLASH_DB_CREATE";

/**
 * Overrides SQLite's `synchronous` pragma for every handle `openDb` returns (1658). Unset means the SQLite
 * default (FULL), which is what a real database wants. The test suites set it to OFF in
 * `apps/cli/test/preload.ts`: their databases are throwaway, and under FULL each write is an fsync, which
 * costs 0.01ms on tmpfs and 4ms or more on a busy btrfs `$HOME` -- enough that a test replaying a few
 * hundred job rows took 8s and another crossed a wall-clock second. Anything outside the four SQLite
 * names is ignored rather than interpolated into a pragma.
 */
export const DB_SYNCHRONOUS_ENV = "OMNISLASH_DB_SYNCHRONOUS";
const SYNCHRONOUS_MODES = new Set(["OFF", "NORMAL", "FULL", "EXTRA"]);

export interface OpenDbOptions {
  /** Create + migrate the database when the file does not exist yet. Off by default (198). */
  create?: boolean;
  /**
   * ob 337: this caller wants THE SQLITE FILE specifically, and has said so, so the two-live-stores
   * guard below does not apply to it. That is a much narrower claim than "this caller wants a database":
   * it is true of the file-level machinery (the replica copies, `ob db snapshot`, `ob backup`, the ob 323
   * exporter reading the source of a migration) and of the store seam's own sqlite branch, and it is
   * false of every command that just wants to read or write the tracker. Only ever set it where the
   * SQLITE-ness is the point; setting it to keep an unported command working is precisely the bug the
   * guard exists to catch.
   */
  deliberateSqlite?: boolean;
  /**
   * What is opening the database, named in the guard's refusal ("'ob next' opens..."). The refusal has to
   * tell a human WHICH command is unported, and openDb is several frames below the place that knows.
   */
  what?: string;
}

/**
 * The two-live-stores refusal (337).
 *
 * THIS IS THE GUARD THE WHOLE PHASED MIGRATION RESTS ON. Every phase of the map is ordered around one
 * rule: there is never more than one authoritative store. Every other failure in the migration can be
 * fixed forward; this one cannot, because once two stores have both taken writes there is no longer a
 * single history to go back to, and the revert that the cutover plan promises stops existing.
 *
 * apps/cli is only PARTLY ported (337 did the smoke-test commands; ~260 call sites remain). Without this,
 * a partly-ported CLI is unusable at cutover: `OMNISLASH_STORE=postgres ob <anything unported>` would open
 * the SQLite file and cheerfully write to it while Postgres was authoritative, and nothing anywhere would
 * say so. With it, the ported commands work and every other one fails loudly and reversibly. That is what
 * makes a PARTIAL port safe to cut over at all, and it is why this landed before any call site did.
 */
export function unportedCommandMessage(what: string, path: string): string {
  return [
    `${STORE_ENV}=postgres, but ${what} opens the SQLite database directly: it is not ported to the store seam yet (ob 337).`,
    `  refusing, because writing ${path} while Postgres is authoritative means TWO LIVE STORES -- the one migration failure that cannot be fixed forward, since neither copy is then the history.`,
    `  to run this command now: ${SQLITE_ESCAPE_HATCH} -- the sqlite path still works, but it is FROZEN at the cutover and nothing has written it since, so treat what it says as history rather than as the tracker`,
    `  these ARE servable from Postgres today: ${[...POSTGRES_SERVABLE_COMMANDS].sort().join(", ")}`,
    `  every other command still refuses, and that is deliberate: refusing is reversible, while serving a`,
    `  command that reads half its data from the wrong engine is not.`,
  ].join("\n");
}

/**
 * The refusal (198). It leads with the missing path, then with the cause that is overwhelmingly the
 * real one: the database exists, somewhere else, and this process was started without the variable that
 * names it. Genuine first-time setup comes second because it happens once per machine.
 */
export function missingDbMessage(path: string): string {
  return [
    `no database at ${path}, and creating one is deliberate: ob will not make a new tracker as a side effect of a command.`,
    `  the real database is probably elsewhere: run with OMNISLASH_DB=<path>, or pass --db <path>`,
    `  a machine that genuinely has no database yet gets one with ${DB_CREATE_ENV}=1 (honours --db and OMNISLASH_DB)`,
  ].join("\n");
}

/**
 * A read-only handle on a database file that already exists: SQLITE_OPEN_READONLY, so every write path
 * raises SQLITE_READONLY at its own statement, and the file is never created.
 *
 * This used to be spelled `file:<path>?mode=ro` at both call sites, and that spelling does not work in
 * bun's sqlite AT ALL -- measured on 1.4.2: every `file:` open throws SQLITE_CANTOPEN ("unable to open
 * database file"), WAL database or rollback-journal, `-wal`/`-shm` present or not. A reader built on it
 * therefore answered "nothing there" on every invocation, which on the config reader meant "no
 * remote_host configured" on a machine that had one. The option below is the same enforcement -- a
 * read-only connection -- by the route bun actually implements.
 */
export function openReadOnly(path: string): Database {
  return new Database(path, { readonly: true });
}

export function openDb(path: string, opts: OpenDbOptions = {}): Database {
  // 337, BEFORE anything else: refuse to open a sqlite file at all when Postgres is the authoritative
  // store, unless the caller is one of the few that genuinely means the file. See
  // unportedCommandMessage. This is first because a guard that runs after the handle exists is not a
  // guard -- the migrations and the WAL switch below are themselves writes to the file.
  if (!opts.deliberateSqlite && resolveStoreKind() === "postgres") {
    throw new AppError(unportedCommandMessage(opts.what ?? "this command", path));
  }
  // 198: a missing file used to be created and migrated by whatever command touched it first. On a
  // machine whose real database is named by OMNISLASH_DB (the server), any command run WITHOUT that
  // variable therefore got a fresh empty tracker at the default path, which answered cheerfully and
  // accepted writes: a second database on the writer machine, and the decoy is the one a later
  // variable-less command finds. Opening an existing database is unchanged, and creation still happens
  // whenever it was asked for ('ob init', the opt-in env var, or a caller that passes create).
  if (!opts.create && process.env[DB_CREATE_ENV] !== "1" && !existsSync(path)) {
    throw new AppError(missingDbMessage(path));
  }
  mkdirSync(dirname(path), { recursive: true });
  let lastError: unknown;
  for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
    let db: Database | undefined;
    try {
      db = new Database(path, { create: true });
      // busy_timeout FIRST: it is the retry budget every statement below inherits, and setting it after
      // journal_mode left the WAL switch itself running with a 0ms budget (149).
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA foreign_keys = ON;");
      const synchronous = process.env[DB_SYNCHRONOUS_ENV]?.toUpperCase();
      if (synchronous !== undefined && SYNCHRONOUS_MODES.has(synchronous)) db.exec(`PRAGMA synchronous = ${synchronous};`);
      adoptDrizzleBaselineIfLegacy(db);
      // Fresh DB: applies 0000 (full v18 schema incl. the fts5 virtual tables). Existing legacy DB: 0000
      // was adopted above, so this is a no-op (and would apply any FUTURE migrations). Each migration
      // runs in its own transaction; 0000 is pure DDL so the ambient foreign_keys pragma is irrelevant.
      if (migrationsOutstanding(db)) applyMigrations(db);
      // Keep the legacy version marker coherent across both paths (fresh + adopted both report v18).
      // Written only when it differs (OB-1913): the write takes the write lock, and an open with nothing
      // to do must not queue behind another writer.
      const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version !== LEGACY_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${LEGACY_SCHEMA_VERSION};`);
      return db;
    } catch (err) {
      db?.close();
      lastError = err;
      // Retry CONTENTION and nothing else (223). SQLITE_BUSY on `PRAGMA journal_mode = WAL` is the one
      // that needs it: busy_timeout does not cover the journal_mode pragma, which returns BUSY rather
      // than blocking. Everything else is deterministic and will fail identically six times over, which
      // is exactly what buried a migration failure behind a "concurrent access" headline for six
      // minutes; a MigrationError already carries the tag and the sqlite reason, so surface it now.
      if (!isBusyFailure(err)) throw err;
      Bun.sleepSync(OPEN_RETRY_BASE_MS * (attempt + 1) + Math.floor(Math.random() * OPEN_RETRY_BASE_MS));
    }
  }
  throw new AppError(
    `could not open the database at ${path} after ${OPEN_ATTEMPTS} attempts, every one of them blocked by another process holding it: ${sqliteReason(lastError)}`,
  );
}

export function nowIso(): string {
  return new Date().toISOString();
}

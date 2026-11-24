// --- ob 321 (Postgres migration, phase 1): the mechanical 1:1 port of src/db/schema.ts ---
//
// SQLite stays authoritative until phase 6 (ob 326). NOTHING imports this file at runtime yet: it is the
// shape phases 322 (search), 323 (the data move) and 324 (the consumers) are built against. Export names
// and column KEYS are identical to the sqlite schema on purpose, so a consumer ports by changing one
// import path rather than by rewriting its queries.
//
// Type rule (map decision 5): text stays text, integer stays integer. Converting integer timestamps to
// timestamptz and 0/1 flags to boolean is ob 327, deliberately NOT here -- a 73-table diff that also
// changes meaning is not reviewable.
//
// Where SQLite and Postgres genuinely disagree, the call is recorded at the site. The four that recur:
//
// 1. `integer().primaryKey({ autoIncrement: true })` -> `integer().primaryKey().generatedByDefaultAsIdentity()`.
//    Postgres has no rowid, so the sequence must be declared. BY DEFAULT rather than ALWAYS because the
//    ob 323 exporter has to insert the EXISTING ids to keep every foreign key intact; ALWAYS would reject
//    those inserts outright. The cost is that 323 must reset each sequence after loading
//    (`setval(pg_get_serial_sequence(...), max(id))`), or the first live insert collides.
// 2. `integer(..., { mode: "boolean" })` -> plain `integer`. The STORAGE is 0/1 in SQLite and stays 0/1
//    here; `default(false)` becomes `default(0)`. The TS-level boolean is part of ob 327's flag work.
// 3. `text(..., { mode: "json" })` -> plain `text`. JSON is stored as text today; jsonb is a storage
//    change, so it belongs to ob 327 too. A json-mode default becomes its serialized string.
// 4. `default(sql`CURRENT_TIMESTAMP`)` on a TEXT column. Postgres refuses that outright (CURRENT_TIMESTAMP
//    is timestamptz, the column is text), and `now()::text` would write a different string shape than
//    SQLite's. `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')` reproduces SQLite's exact
//    stored format, so rows written before and after the cutover parse the same way.
//
// SQLite's INTEGER is 64-bit; Postgres `integer` is 32-bit. Kept as `integer` because the rule is a
// mechanical port, and every integer column here is a count, a rank, a ttl or an id. The one column
// class worth re-reading in ob 327 is the `*_cents` money columns (int4 caps at R21.4m).
//
// NOT PORTED HERE, ON PURPOSE: the 5 FTS5 virtual tables (item_fts, pr_comment_fts, email_fts,
// slack_fts, whatsapp_fts) and the 25 fts5 shadow tables behind them (*_data / *_idx / *_content /
// *_docsize / *_config). They are SQLite storage internals with no Postgres analogue at all -- a
// tsvector column maintained by Postgres needs no shadow tables. Search is ob 322; see the marked seam
// at the bottom of this file.

import { sql } from "drizzle-orm";
import { customType, index, integer, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";

// --- ob 322: full-text search, the Postgres replacement for the 5 fts5 virtual tables ---
//
// Each searchable table gains ONE `search_vec` tsvector column, GENERATED ALWAYS ... STORED from the
// same columns the fts5 table indexed, plus a GIN index on it. That is the whole mechanism: the shadow
// tables, the hand-written INSERT/DELETE sync in items.ts / gmail.ts / github.ts / whatsapp.ts, and the
// "did the index drift from the table" failure mode all disappear, because the column is a function of
// the row and Postgres recomputes it on every write it makes.
//
// GENERATED COLUMN rather than a TRIGGER, deliberately. A trigger is 10 more objects (a function and a
// trigger per table) that can be disabled, dropped or forgotten in a restore, and it re-introduces the
// exact class of drift this phase exists to remove -- a row written while the trigger is off is a row
// missing from the index, silently. A generated column cannot be out of date: Postgres refuses a write
// that would leave it stale, `COPY` recomputes it, and pg_dump/restore rebuilds it from the source
// columns. The one thing a trigger buys (an expression that is not IMMUTABLE) is not needed here.
//
// `ob_search` is a text search configuration created by the 0001 migration: `english` (stemming +
// stopwords) with `unaccent` in front of the stemmer. The unaccent step is not decoration -- fts5's
// unicode61 tokenizer strips diacritics by default, so `cafe` finds `café` today, and plain `english`
// would silently lose that. `to_tsvector(regconfig, text)` is IMMUTABLE whatever the config contains,
// which is what lets this sit in a generated column at all.
export const tsvector = customType<{ data: string; driverData: string }>({
	dataType() {
		return "tsvector";
	},
});

/** The `to_tsvector('ob_search', ...)` expression over a row's searchable columns, NULL-safe. */
function searchVector(...columns: string[]) {
	const haystack = columns.map((c) => `coalesce("${c}", '')`).join(` || ' ' || `);
	return sql.raw(`to_tsvector('ob_search', ${haystack})`);
}

/**
 * A `gin_trgm_ops` index over the same haystack, for the SUBSTRING queries a tsvector cannot answer.
 * The FTS5-vs-tsvector comparison found three query shapes
 * where word matching alone loses a result a user would expect: a fragment of an address or a path that
 * the tsvector parser keeps whole (`acmecorp` inside `alex@acmecorp.example.com`), a mid-word fragment
 * (`vnode`-style substrings of a longer token), and a bare number that the parser swallowed into a
 * signed integer (`322` inside `ob-322`). pg_trgm answers all three from an index instead of a
 * sequential ILIKE.
 */
function trigramHaystack(...columns: string[]) {
	const haystack = columns.map((c) => `coalesce("${c}", '')`).join(` || ' ' || `);
	return sql.raw(`(${haystack}) gin_trgm_ops`);
}

export const item = pgTable("item", {
	id: text().primaryKey(),
	type: text().notNull(),
	title: text().notNull(),
	body: text(),
	status: text().notNull(),
	project_id: text("project_id").references(() => project.id),
	priority: integer(),
	today_rank: integer("today_rank"),
	block_reason: text("block_reason"),
	block_owner: text("block_owner"),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
	closed_at: text("closed_at"),
	// the triage inbox (issue #56): triage = 1 while the item awaits triage (an architect in another repo
	// handed it over); origin_repo records the repo it came from. Cleared (back to 0) when triaged.
	triage: integer().default(0),
	origin_repo: text("origin_repo"),
	// 322: replaces item_fts(title, body).
	search_vec: tsvector("search_vec").generatedAlwaysAs(() => searchVector("title", "body")),
	// ob 1949: the current per-project ref, `<KEY>-<seq>`. See the SQLite schema.
	ref: text(),
	// OB-2083: the item's place in its project's execution queue (see the sqlite schema). NULL = unranked.
	queue_rank: integer("queue_rank"),
},
(table) => [
	index("idx_item_type_status").on(table.type, table.status, table.project_id, table.priority),
	uniqueIndex("idx_item_ref").on(table.ref),
	index("idx_item_search_vec").using("gin", table.search_vec),
	index("idx_item_search_trgm").using("gin", trigramHaystack("title", "body")),
]);

export const taskDetail = pgTable("task_detail", {
	item_id: text("item_id").primaryKey().references(() => item.id, { onDelete: "cascade" }),
	points: integer(),
	lifecycle_state: text("lifecycle_state"),
	assignee: text(),
	pr_url: text("pr_url"),
	branch: text(),
});

export const linearRef = pgTable("linear_ref", {
	item_id: text("item_id").primaryKey().references(() => item.id, { onDelete: "cascade" }),
	linear_id: text("linear_id"),
	url: text(),
	cached_title: text("cached_title"),
	cached_state: text("cached_state"),
	cached_priority: integer("cached_priority"),
	last_synced_at: text("last_synced_at"),
});

export const project = pgTable("project", {
	id: text().primaryKey(),
	name: text().notNull(),
	kind: text().notNull(),
	git_remote: text("git_remote"),
	created_at: text("created_at").notNull(),
	// ob 1949: the per-project ref prefix, [A-Z]{2,4}, unique.
	key: text(),
	// OB-2116: the architect thread title's emoji and display name (see the SQLite schema).
	icon: text(),
	display_name: text("display_name"),
	// OB-2103: the release stage (see the SQLite schema).
	stage: text(),
	// OB-2255: the project's team, in 0046's `group_name` column (see the SQLite schema).
	team_name: text("group_name"),
	// OS-134: the lifecycle status (see the SQLite schema).
	status: text().default("active").notNull(),
},
(table) => [
	uniqueIndex("idx_project_key").on(table.key),
]);

// OB-2255: a team of projects, in 0046's `project_group` table (see the SQLite schema).
export const team = pgTable("project_group", {
	name: text().primaryKey(),
	icon: text(),
	display_name: text("display_name"),
	created_at: text("created_at").notNull(),
});

// OB-2257: what a team role thread hands its replacement during `ob t3 team restart`. The old thread records
// its working state here (`ob t3 team handoff`), ob holds it while the old thread is settled and a new one
// opened, and the new thread is seeded with the body. `consumed_at` and `new_thread_id` are set once the seed
// went out; an unconsumed row is a restart that did not finish, which a re-run picks up.
export const teamHandoff = pgTable("team_handoff", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	team: text().notNull(),
	role: text().notNull(),
	old_thread_id: text("old_thread_id"),
	body: text().notNull(),
	created_at: text("created_at").notNull(),
	consumed_at: text("consumed_at"),
	new_thread_id: text("new_thread_id"),
},
(table) => [
	index("idx_team_handoff_role").on(table.team, table.role, table.id),
]);

// One role run per team role: a T3 thread opened (or reused) by `ob role start <team> <role>`. The row is the
// run's record (when it started, its last activity, why it ended); the partial unique index on (team, role)
// where `ended_at` IS NULL is the one-open-run rule. `thread_id` is null only while the launch is in flight.
// `t3_host` is the T3 base URL the run was opened on, so another machine never judges it gone. Removing a
// team (`t3 team rm --force`) drops its runs with it.
export const roleRun = pgTable("role_run", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	team: text().notNull().references(() => team.name, { onDelete: "cascade" }),
	role: text().notNull(),
	thread_id: text("thread_id"),
	t3_host: text("t3_host").notNull(),
	started_at: text("started_at").notNull(),
	last_activity_at: text("last_activity_at").notNull(),
	item_count: integer("item_count"),
	context_tokens: integer("context_tokens"),
	ended_at: text("ended_at"),
	end_reason: text("end_reason"),
	// OS-55: the note this run leaves its successor (`ob role note`), shown once by the next `ob role brief`.
	successor_note: text("successor_note"),
	note_at: text("note_at"),
	note_shown_at: text("note_shown_at"),
},
(table) => [
	uniqueIndex("idx_role_run_open")
		.on(table.team, table.role)
		.where(sql`ended_at IS NULL`),
]);

// A team role's inbox (`ob send`, `ob inbox`): one row per message to a role, kept on the server so any machine
// reads it and a message to a replaced thread is not lost. `kind` is `message` (sent by hand) or `handoff` (a
// builder's readying note, keyed by `client_key` so a second handoff of one commit adds no row). `read_at` and
// `read_by` (a run or agent id, plain text) mark what a run read; `withdrawn_at` hides a handoff whose ticket
// closed. Removing a team drops its messages with it.
export const roleMessage = pgTable("role_message", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	team: text().notNull().references(() => team.name, { onDelete: "cascade" }),
	role: text().notNull(),
	from_actor: text("from_actor").notNull(),
	kind: text().notNull(),
	ref: text(),
	body: text().notNull(),
	client_key: text("client_key"),
	created_at: text("created_at").notNull(),
	read_at: text("read_at"),
	read_by: text("read_by"),
	withdrawn_at: text("withdrawn_at"),
},
(table) => [
	uniqueIndex("idx_role_message_client_key").on(table.client_key),
	index("idx_role_message_unread").on(table.team, table.role, table.read_at, table.id),
]);

// OB-2271: persona tournaments. A tournament compares candidates (themes, grounds, designs) by matches; each
// match is a set of reader calls (a persona on a model, in one order) scoring both sides 1 to 5 per criterion.
// The runner (OB-2273, or a repo's own script) writes a match file and `ob tournament record` stores it; ob
// validates the shape and never decides a winner. JSON columns are text, as elsewhere in this schema.
export const tournament = pgTable("tournament", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	subject: text().notNull(),
	repo: text().notNull(),
	ref: text(),
	criteria: text().notNull(),                  // json string[]
	status: text().notNull(),                    // open | picked
	picked: text(),
	picked_note: text("picked_note"),
	picked_at: text("picked_at"),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
},
(table) => [
	index("idx_tournament_repo").on(table.repo, table.id),
]);

export const tournamentCandidate = pgTable("tournament_candidate", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	tournament_id: integer("tournament_id").notNull(),
	key: text().notNull(),
	label: text(),
	images: text().notNull(),                    // json string[], paths relative to the repo
	revises: text(),
	created_at: text("created_at").notNull(),
},
(table) => [
	uniqueIndex("idx_tournament_candidate_key").on(table.tournament_id, table.key),
]);

export const tournamentMatch = pgTable("tournament_match", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	tournament_id: integer("tournament_id").notNull(),
	name: text().notNull(),
	round: text().notNull(),
	x: text().notNull(),
	y: text().notNull(),
	winner: text().notNull(),
	tally: text(),                               // json { candidate: number }, as the file gave it
	position: integer().notNull(),               // recorded order; --replace keeps the replaced match's place
	recorded_at: text("recorded_at").notNull(),
},
(table) => [
	uniqueIndex("idx_tournament_match_name").on(table.tournament_id, table.name),
]);

export const tournamentCall = pgTable("tournament_call", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	match_id: integer("match_id").notNull(),
	persona: text().notNull(),
	model: text(),
	fallback: integer(),                         // 1 when the reader ran on its fallback model
	order_n: integer("order_n").notNull(),       // 1 = A shown first, 2 = B shown first
	a: text().notNull(),
	b: text().notNull(),
	winner_key: text("winner_key").notNull(),
	why: text(),
	changes: text(),                             // json { candidate: change asked }
	scores: text().notNull(),                    // json { criterion: { a, b, why } }
},
(table) => [
	index("idx_tournament_call_match").on(table.match_id, table.id),
]);

// OB-2276: GitHub webhooks into ob. One row per delivery GitHub sent (`X-GitHub-Delivery`), so a redelivery is
// a no-op; the event itself is summarised in `event` (source github).
export const githubDelivery = pgTable("github_delivery", {
	delivery_id: text("delivery_id").primaryKey(),
	event: text().notNull(),
	received_at: text("received_at").notNull(),
});

// OB-2276: a red run on `main` that ob told (or, for a project in no team, recorded with nobody to tell). The
// run id is the key, so a run is told once; `recovered_at` is set by the first green run of that workflow after
// it. A row not yet recovered is an `ob alerts` row.
export const ciMainNotice = pgTable("ci_main_notice", {
	run_id: text("run_id").primaryKey(),
	repo: text().notNull(),                      // owner/name
	workflow_id: text("workflow_id").notNull(),
	workflow: text().notNull(),
	conclusion: text().notNull(),                // failure | timed_out | startup_failure
	sha: text(),
	run_url: text("run_url"),
	target: text(),                              // the agent row told (sentinel-<team> | architect-<team>), null = nobody
	told_at: text("told_at").notNull(),
	recovered_at: text("recovered_at"),
},
(table) => [
	index("idx_ci_main_notice_open").on(table.repo, table.workflow_id, table.recovered_at),
]);

// ob 1949: every ref an item has carried, current and former. See the SQLite schema.
export const itemRef = pgTable("item_ref", {
	ref: text().primaryKey(),
	item_id: text("item_id").notNull().references(() => item.id, { onDelete: "cascade" }),
	created_at: text("created_at").notNull(),
},
(table) => [
	index("idx_item_ref_item").on(table.item_id),
]);

// ob 1949: the next seq per project key. See the SQLite schema.
export const refCounter = pgTable("ref_counter", {
	key: text().primaryKey(),
	next_seq: integer("next_seq").notNull(),
});

// `name` is UNIQUE, matching the SQLite table (337). The ob 321 baseline dropped the inline UNIQUE that
// `CREATE TABLE tag (... name TEXT NOT NULL UNIQUE)` carries on the SQLite side, and it is load-bearing
// rather than decorative: addTags upserts a tag with `ON CONFLICT (name) DO NOTHING`, and Postgres
// rejects that outright ("no unique or exclusion constraint matching the ON CONFLICT specification")
// when there is no constraint to infer an arbiter index from. Without it, tagging would fail on Postgres
// and duplicate tag rows would be insertable, splitting one tag across several ids.
export const tag = pgTable("tag", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	name: text().notNull().unique(),
});

export const itemTag = pgTable("item_tag", {
	itemId: text("item_id").notNull().references(() => item.id, { onDelete: "cascade" }),
	tagId: integer("tag_id").notNull().references(() => tag.id, { onDelete: "cascade" }),
},
(table) => [
	index("idx_item_tag_tag").on(table.tagId),
	primaryKey({ columns: [table.itemId, table.tagId], name: "item_tag_item_id_tag_id_pk" }),
]);

export const itemLink = pgTable("item_link", {
	fromItem: text("from_item").notNull().references(() => item.id, { onDelete: "cascade" }),
	toItem: text("to_item").notNull().references(() => item.id, { onDelete: "cascade" }),
	relType: text("rel_type").notNull(),
	position: integer(),
},
(table) => [
	index("idx_item_link_to").on(table.toItem),
	index("idx_item_link_from").on(table.fromItem),
	primaryKey({ columns: [table.fromItem, table.toItem, table.relType], name: "item_link_from_item_to_item_rel_type_pk" }),
]);

export const skillCursor = pgTable("skill_cursor", {
	skill: text().notNull(),
	key: text().notNull(),
	value: text(),
	updatedAt: text("updated_at").notNull(),
},
(table) => [
	primaryKey({ columns: [table.skill, table.key], name: "skill_cursor_skill_key_pk" }),
]);

export const config = pgTable("config", {
	key: text().primaryKey(),
	value: text(),
});

export const event = pgTable("event", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	ts: text().notNull(),
	source: text(),
	type: text(),
	item_id: text("item_id").references(() => item.id, { onDelete: "set null" }),
	actor: text(),
	cause: text(),
	payload: text(),
},
(table) => [
	index("idx_event_source_type_ts").on(table.source, table.type, table.ts),
	index("idx_event_item_type_ts").on(table.item_id, table.type, table.ts),
]);

export const lease = pgTable("lease", {
	resource: text().primaryKey(),
	holder: text(),
	acquired_at: text("acquired_at"),
	ttl_s: integer("ttl_s"),
	heartbeat_at: text("heartbeat_at"),
});

export const alertAck = pgTable("alert_ack", {
	alert_key: text("alert_key").primaryKey(),
	state_hash: text("state_hash"),
	snoozed_at: text("snoozed_at").notNull(),
});

export const roadmapDetail = pgTable("roadmap_detail", {
	itemId: text("item_id").primaryKey().references(() => item.id, { onDelete: "cascade" }),
	targetDate: text("target_date"),
	sourceRef: text("source_ref"),
	owner: text(),
});

export const decisionDetail = pgTable("decision_detail", {
	item_id: text("item_id").primaryKey().references(() => item.id, { onDelete: "cascade" }),
	context: text(),
	choice: text(),
	rationale: text(),
	alternatives: text(),
	decided_at: text("decided_at"),
	// OB-2097: an overnight or architect decision's doubt (how sure, what could be wrong) and undo (how to change it).
	doubt: text(),
	undo: text(),
});

export const learningDetail = pgTable("learning_detail", {
	item_id: text("item_id").primaryKey().references(() => item.id, { onDelete: "cascade" }),
	kind: text(),
	progress: text(),
	source: text(),
	why: text(),
});

// `label` is UNIQUE, matching the SQLite table (337) — the same ob 321 omission as `tag.name`, found by
// the same sweep. Nothing upserts on it today, so this one is a silent-divergence risk rather than an
// error: without it Postgres would accept two test users under one label where SQLite refuses.
export const testUser = pgTable("test_user", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	label: text().notNull().unique(),
	email: text(),
	role: text(),
	workspace: text(),
	env: text(),
	secret_ref: text("secret_ref"),
	notes: text(),
	secret_set_at: text("secret_set_at"),
	last_used: text("last_used"),
});

export const prComment = pgTable("pr_comment", {
	id: text().primaryKey(),
	pr: text().notNull(),
	repo: text(),
	author: text(),
	kind: text(),
	path: text(),
	state: text(),
	body: text(),
	afterReady: integer("after_ready"),
	bot: integer(),
	createdAt: text("created_at"),
	// 322: replaces pr_comment_fts(body).
	search_vec: tsvector("search_vec").generatedAlwaysAs(() => searchVector("body")),
},
(table) => [
	index("idx_pr_comment_author").on(table.author),
	index("idx_pr_comment_pr").on(table.pr),
	index("idx_pr_comment_search_vec").using("gin", table.search_vec),
	index("idx_pr_comment_search_trgm").using("gin", trigramHaystack("body")),
]);

export const person = pgTable("person", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	real_name: text("real_name").notNull(),
	role: text(),
	github_login: text("github_login"),
	linear_user_id: text("linear_user_id"),
	linear_name: text("linear_name"),
	slack_user_id: text("slack_user_id"),
	slack_handle: text("slack_handle"),
	email: text(),
	notes: text(),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
	// maps a WhatsApp sender jid to this person
	whatsapp_jid: text("whatsapp_jid"),
	// ticket 142 — declared communication profile priming suggested replies
	relationship: text("relationship"),
	comms_style: text("comms_style"),
	comms_notes: text("comms_notes"),
	// ob 165 — South African ID number. The CLI masks this everywhere and prints it in full only behind
	// `--reveal`; treat it as a secret, not a display field.
	id_number: text("id_number"),
},
(table) => [
	uniqueIndex("idx_person_slack").on(table.slack_user_id),
	// PARTIAL, matching the SQLite original. Postgres treats NULLs as distinct in a unique
	// index so a full one behaves the same here, but the WHERE is kept for fidelity with the
	// source schema rather than relying on that equivalence.
	uniqueIndex("idx_person_linear")
		.on(table.linear_user_id)
		.where(sql`linear_user_id IS NOT NULL`),
	uniqueIndex("idx_person_github").on(table.github_login),
]);

export const agent = pgTable("agent", {
	id: text().primaryKey(),
	ticket: text(),
	worktree: text(),
	branch: text(),
	status: text(),
	started_at: text("started_at").notNull(),
	heartbeat_at: text("heartbeat_at").notNull(),
	ttl_s: integer("ttl_s").notNull(),
	note: text(),
	// issue #125: WHERE this agent lives — a launcher name (a legacy value on an old row), stamped at
	// register time from the RESOLVED launcher. NULL = unknown.
	launcher: text(),
	// issue #126: the Claude Code session id this agent was LAUNCHED with, so a restarted session can
	// continue that session instead of re-running its brief. NULL = not resumable.
	session_id: text("session_id"),
	// wayfinder 1189, mirrored from migration 0033 on the SQLite side: T3's OWN run enum, written ONLY by
	// the run-state mirror, for a row whose launcher is `t3`. `status` stays ob's workflow words. NULL for
	// a headless builder, which has no run.
	run: text(),
},
(table) => [
	index("idx_agent_heartbeat").on(table.heartbeat_at),
]);

export const spinoff = pgTable("spinoff", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	ticket_ref: text("ticket_ref").notNull(),
	repo: text().notNull(),
	branch: text().notNull(),
	worktree: text().notNull(),
	mode: text().notNull(),
	brief: text().notNull(),
	status: text().notNull(),
	error: text(),
	agent_id: text("agent_id"),
	request_at: text("request_at").notNull(),
	launched_at: text("launched_at"),
	input_tokens: integer("input_tokens").default(0),
	output_tokens: integer("output_tokens").default(0),
	cache_creation_tokens: integer("cache_creation_tokens").default(0),
	cache_read_tokens: integer("cache_read_tokens").default(0),
	total_tokens: integer("total_tokens").default(0),
	// issue #61: the merge-base of (branch, main) captured at launch/adoption, so reconcile can gate
	// "merged" on there being at least one commit past this base. NULL for pre-migration rows.
	base_sha: text("base_sha"),
	// issue #41: when this spinoff's completion was reported by `ob spinoff watch`. NULL = not yet
	// reported. Persisting it is what makes each completion emit exactly once across every ob process.
	reported_at: text("reported_at"),
	// issue #125: the launcher this spinoff was actually launched into, stamped at launch from the
	// RESOLVED launcher. Not derivable later. NULL for rows launched before it existed.
	launcher: text(),
	// issue #151: how many times this row has been launched. It is what bounds the retry of a spawn the
	// app reported as producing no session (#146).
	launch_attempts: integer("launch_attempts").default(0),
	// issue #126: the Claude Code session id this row's launch command was given, re-stamped on every
	// launch attempt. NULL = nothing to continue.
	session_id: text("session_id"),
	// migration 0023: the harness engine this launch was composed for (claude | opencode), stamped at
	// launch so reconcile reads the right token source. NULL = pre-0023 row → reads as `claude`.
	engine: text(),
	// migration 0031 (wayfinder 1120): the T3 Code thread a `--launcher t3` row opened — the id a human
	// reopens the builder with, and what makes a retry idempotent (a re-run ADOPTS the thread already
	// bound to this row's worktree instead of opening a second one). NULL = no thread.
	t3_thread_id: text("t3_thread_id"),
	// migration 0031: the run T3 minted for that thread's launch, so reconcile names the run it read a
	// status from. NULL = an idle thread, or a row with no thread.
	t3_run_id: text("t3_run_id"),
	// migration 0032 (wayfinder 1163): the ob ITEM this row serves. `ticket_ref` is the ref the row was
	// DISPATCHED with — an ob item id only when the ticket was numbered by `ob add`; a hand-charted
	// ticket is dispatched by its wayfinder number while its ob mirror carries its own id (row 591: ref
	// "1124", item 1134). Recorded at dispatch because every join (settle-on-close, the thread view,
	// `ob t3 open`) wants the item, and nothing on the other side can derive it. NULL = pre-0032 row.
	item_id: text("item_id"),
	// migration 0034 (wayfinder 1480): the complexity TIER the architect rated this dispatch
	// (complex|medium|simple), recorded at queue time, and the MODEL the launch actually ran on, stamped at
	// launch. NULL tier = pre-0034 (launches as medium); NULL model = not launched / headless / pre-0034.
	tier: text(),
	model: text(),
	// migration 0039 (OB-1815): the reasoning level `--effort` named at queue time, then the text the launch
	// stamped (`high` | `default (high)` | `default (none listed)`). NULL = none named, not launched, or pre-0039.
	effort: text(),
	// migration 0040 (OB-1992): a clean repo's recorded verdict, reason and gate line (`ob spinoff state`).
	// NULL = not recorded: an OmniSlash row (its verdict is the `State:` line in git) or a pre-0040 row.
	verdict: text(),
	verdict_reason: text("verdict_reason"),
	gate_line: text("gate_line"),
	// migration 0019 (OB-1991): the row's leg in a model trial pair (`a` | `b`) and the model the trial gave it.
	// NULL = not a trial leg.
	trial_leg: text("trial_leg"),
	trial_model: text("trial_model"),
	// migration 0022 (OB-2172): why the last readying note did not reach the architect (`<iso time> <reason>`),
	// after one retry. A later note that is sent clears it. NULL = the last note went, or none was tried.
	note_error: text("note_error"),
	// appended by migration 0004_spinoff_complexity (OS-177, ADD COLUMN lands last): the architect's 1-10 score,
	// the routing key (`tier` is now only the label of its band, still written beside it). NULL = queued before
	// this: the row reads its tier's alias value (simple 2, medium 5, complex 8), or 5 with no tier either.
	complexity: integer(),
	// appended by migration 0005_spinoff_phase (OS-183, ADD COLUMN lands last): the role phase inside the status,
	// moved by the spinoff phase machine (platform/state-machine/src/spinoff-phase.ts): reviewing | pr_ci |
	// updating_pr while launched, gating | owner_merge_call while ready-for-gate. NULL in every other status, and
	// on every row from before this migration (no backfill: a guessed phase is worse than none).
	phase: text(),
},
(table) => [
	// PARTIAL, matching the SQLite original: only ONE active spinoff per ticket, while any
	// number of finished ones may exist. Declared without the WHERE, this rejects the second
	// completed spinoff for a ticket and the data load fails on real history (ob 337).
	uniqueIndex("idx_spinoff_active")
		.on(table.ticket_ref)
		.where(sql`status IN ('pending', 'launching')`),
]);

// OB-1991: a model trial. While one is active, a dispatch at its tier runs twice, once per leg's model, and a
// blind review picks the winner. One active trial at a time (`active` 1); `target` is the number of pairs
// whose verdict is recorded before it ends by itself. A leg's model is `provider:model`, its effort a level or NULL.
export const spinoff_trial = pgTable("spinoff_trial", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	name: text().notNull(),
	tier: text().notNull(),
	target: integer().notNull(),
	a_model: text("a_model").notNull(),
	a_effort: text("a_effort"),
	b_model: text("b_model").notNull(),
	b_effort: text("b_effort"),
	// list prices, USD per million tokens, `input,output,cache_write,cache_read`; NULL = none given
	a_price: text("a_price"),
	b_price: text("b_price"),
	active: integer().default(1).notNull(),
	started_at: text("started_at").notNull(),
	ended_at: text("ended_at"),
	end_reason: text("end_reason"),
	// appended by migration 0004_spinoff_complexity (OS-177): the complexity range the trial runs on (`--range 4-6`);
	// a dispatch whose score falls inside it runs twice. NULL = started before this: the range is the tier's band.
	complexity_from: integer("complexity_from"),
	complexity_to: integer("complexity_to"),
});

// OB-1991: one pair of a trial: the ticket, the two spinoff rows, the blind label of leg a (`X` or `Y`, leg b
// takes the other), and once recorded the scores, the winner (`a` | `b`) and `seq` (1 to target). `status` is
// open | recorded | void; a void pair does not count. `legs` is a JSON snapshot taken at record time (each
// leg's model, effort, launch and handoff times, tokens, review line), so the report needs no branch or worktree.
export const spinoff_trial_pair = pgTable("spinoff_trial_pair", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	trial_id: integer("trial_id").notNull(),
	ticket_ref: text("ticket_ref").notNull(),
	repo: text().notNull(),
	row_a: integer("row_a"),
	row_b: integer("row_b"),
	label_a: text("label_a").notNull(),
	status: text().notNull(),
	seq: integer(),
	score_a: integer("score_a"),
	score_b: integer("score_b"),
	winner: text(),
	notes: text(),
	void_reason: text("void_reason"),
	a_handoff_at: text("a_handoff_at"),
	b_handoff_at: text("b_handoff_at"),
	a_sendbacks: integer("a_sendbacks").default(0),
	b_sendbacks: integer("b_sendbacks").default(0),
	legs: text(),
	// JSON lists: the owner's word per label (`trial feedback`), and fixes to the winner within 7 days (`trial fix`)
	feedback: text(),
	fixes: text(),
	opened_at: text("opened_at").notNull(),
	recorded_at: text("recorded_at"),
});

export const standup = pgTable("standup", {
	date: text().primaryKey(),
	generated_md: text("generated_md"),
	edited_md: text("edited_md"),
	status: text().default("generated").notNull(),
	generated_at: text("generated_at"),
	edited_at: text("edited_at"),
	posted_at: text("posted_at"),
});

// --- 126/127: Gmail + Calendar connectors (comms/PIM substrate, decision #26) ---

export const emailMessage = pgTable("email_message", {
	id: text().primaryKey(),                 // Gmail message id (idempotent upsert)
	thread_id: text("thread_id"),
	from_addr: text("from_addr"),
	to_addr: text("to_addr"),                // json array of recipient addresses
	subject: text(),
	snippet: text(),
	body: text(),
	ts: text(),                              // internalDate as ISO-8601
	labels: text(),                          // json array of Gmail label ids
	person_id: integer("person_id").references(() => person.id, { onDelete: "set null" }),
	raw: text(),                             // json of the raw Gmail message
	// 322: replaces email_fts(subject, body).
	search_vec: tsvector("search_vec").generatedAlwaysAs(() => searchVector("subject", "body")),
},
(table) => [
	index("idx_email_message_thread").on(table.thread_id),
	index("idx_email_message_ts").on(table.ts),
	index("idx_email_message_search_vec").using("gin", table.search_vec),
	index("idx_email_message_search_trgm").using("gin", trigramHaystack("subject", "body")),
]);

export const calendarEvent = pgTable("calendar_event", {
	id: text().notNull(),                    // Google Calendar event id
	calendar_id: text("calendar_id").notNull(),
	summary: text(),
	start_ts: text("start_ts"),
	end_ts: text("end_ts"),
	all_day: integer("all_day"),             // 1 when a date-only (all-day) event
	attendees: text(),                       // json array of attendee objects
	recurring_event_id: text("recurring_event_id"), // set on expanded instances of a recurrence
	recurrence: text(),                      // json RRULE array (master events)
	status: text(),
	person_id: integer("person_id").references(() => person.id, { onDelete: "set null" }),
	updated_ts: text("updated_ts"),
	raw: text(),                             // json of the raw Calendar event
},
(table) => [
	index("idx_calendar_event_start").on(table.start_ts),
	primaryKey({ columns: [table.calendar_id, table.id], name: "calendar_event_calendar_id_id_pk" }),
]);

// --- 128: Slack (work) read-only awareness source ---
// One row per ingested message (mentions / DMs / tracked threads); dedupe on (channel, ts). person_id
// enriches the sender when the Slack user id is registered. raw keeps the untouched Slack API JSON.
// Read-only: nothing here is ever sent to Slack.
export const slackMessage = pgTable("slack_message", {
	id: integer().primaryKey().generatedByDefaultAsIdentity(),
	ts: text().notNull(),
	channel: text().notNull(),
	channel_type: text("channel_type"),
	user: text(),
	text: text(),
	thread_ts: text("thread_ts"),
	permalink: text(),
	person_id: integer("person_id").references(() => person.id, { onDelete: "set null" }),
	raw: text(),
	created_at: text("created_at").notNull(),
	// 322: replaces slack_fts(text).
	search_vec: tsvector("search_vec").generatedAlwaysAs(() => searchVector("text")),
},
(table) => [
	uniqueIndex("idx_slack_message_channel_ts").on(table.channel, table.ts),
	index("idx_slack_message_ts").on(table.ts),
	index("idx_slack_message_search_vec").using("gin", table.search_vec),
	index("idx_slack_message_search_trgm").using("gin", trigramHaystack("text")),
]);

// --- 135: encrypted secret store ---
// AES-256-GCM ciphertext for each named secret. The master key lives ONLY in the macOS Keychain (never
// here / in a backup); this table holds ciphertext + the per-secret random iv + the GCM auth tag (all
// base64). A dump without the Keychain key is inert.
export const secret = pgTable("secret", {
	name: text().primaryKey(),
	ciphertext: text().notNull(),
	iv: text().notNull(),
	auth_tag: text("auth_tag").notNull(),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
});

// --- 099/100: WhatsApp (personal) read-only ingest source ---
// One row per ingested WhatsApp message, mirrored from the Go bridge's messages.db (read-only; ob never
// writes the bridge). `id` is the bridge message id; dedupe is on (chat_jid, id) since a bridge id is
// only unique within a chat. person_id enriches the sender when their whatsapp_jid is registered.
export const whatsappMessage = pgTable("whatsapp_message", {
	id: text().notNull(),                    // bridge message id (unique within a chat)
	chat_jid: text("chat_jid").notNull(),
	chat_name: text("chat_name"),
	sender_jid: text("sender_jid"),
	content: text(),
	ts: text().notNull(),                    // bridge timestamp normalized to ISO-8601
	is_from_me: integer("is_from_me"),       // 1 when the message is outbound (from me)
	media_type: text("media_type"),
	quoted_message_id: text("quoted_message_id"),
	person_id: integer("person_id").references(() => person.id, { onDelete: "set null" }),
	raw: text(),                             // json of the raw bridge row
	transcript: text("transcript"),          // on-demand STT of a voice note (158); null until transcribed
	created_at: text("created_at").notNull(),
	// ticket 186b — bridge delivery/read receipt state for outbound messages: delivered | read | played;
	// sent | delivered | read | played; NULL = inbound or pre-1936. Renders ticks.
	status: text("status"),
	// ticket 198b — cached vision description of an image message so the suggested-reply prompt can
	// "see" photos; null until described. Only the DERIVED text is cached, never image bytes.
	media_desc: text("media_desc"),
	// 322: replaces whatsapp_fts(content). 336: also indexes transcript (voice) and media_desc (image
	// descriptions) — additive recall, same generated-column mechanism. The fts5 table still indexes
	// content only; this is the one place the two engines are allowed to differ on purpose.
	search_vec: tsvector("search_vec").generatedAlwaysAs(() => searchVector("content", "transcript", "media_desc")),
},
(table) => [
	uniqueIndex("idx_whatsapp_message_chat_id").on(table.chat_jid, table.id),
	index("idx_whatsapp_message_ts").on(table.ts),
	index("idx_whatsapp_message_search_vec").using("gin", table.search_vec),
	index("idx_whatsapp_message_search_trgm").using("gin", trigramHaystack("content", "transcript", "media_desc")),
]);

// --- 169: per-chat WhatsApp preferences (hide a chat/person + disable AI per chat) ---
// One row per chat, keyed by the CANONICAL chat_jid (164). A chat with no row behaves as before: shown
// in the feed + AI-suggested replies enabled.
export const whatsappChatPref = pgTable("whatsapp_chat_pref", {
	chat_jid: text("chat_jid").primaryKey(),
	hidden: integer().notNull().default(0),
	ai_disabled: integer("ai_disabled").notNull().default(0),
	updated_at: text("updated_at").notNull(),
	// 190a: this chat is a FAVOURITE — the feed shows favourites-first (falls back to all when none).
	favorite: integer("favorite").notNull().default(0),
});

// --- ob 218: per-job health, the signal `ob alerts` reads ---
// ONE row per declared daemon job, holding its CURRENT state rather than a history.
// first_attempt_at never moves after the first write: it is how the alerts know how long this machine
// has been tracking jobs at all, which is what keeps a job that has simply not come round yet quiet.
export const jobRun = pgTable("job_run", {
	job: text().primaryKey(),
	first_attempt_at: text("first_attempt_at").notNull(),
	last_attempt_at: text("last_attempt_at").notNull(),
	last_success_at: text("last_success_at"),
	last_failure_at: text("last_failure_at"),
	last_error: text("last_error"),           // truncated: a reason to read the log, not the log
	consecutive_failures: integer("consecutive_failures").notNull().default(0),
	updated_at: text("updated_at").notNull(),
	// Runs that recorded an attempt and never recorded a result (221): killed, timed out, or the machine
	// slept. Counted separately from failures because a run that never got to fail proves nothing about
	// the job, and only its REPETITION does.
	consecutive_interruptions: integer("consecutive_interruptions").notNull().default(0),
});

// --- ob 582: what is deployed, per target ---
// ONE row per deploy target (live omnislash-web on the API host, the ob 581 test/dev instance, ...) holding
// the LATEST outcome only: target is the row's identity, and host/unit/sha/at/result are what the last
// deploy (or no-op) attempt left actually in service. The writer is the server's deploy script (and
// the 581 web-dev push); the reader is `ob deploy status`. A no-op deploy still refreshes the row so
// "what's live" cannot go stale, and a rollback is recorded as result=rolled-back rather than silence.
export const deploy = pgTable("deploy", {
	target: text().primaryKey(),
	host: text().notNull(),
	unit: text().notNull(),
	sha: text().notNull(),
	at: text().notNull(),
	result: text().notNull(),
});

// --- ob 219: the last live check of each credential, the job_run idea one layer down ---
// ONE row per credential holding the LATEST verdict only: the question asked of it is always "is it good
// right now", never "how has it behaved over the month". `detail` is a short human reason and NEVER
// carries the credential's value.
export const credentialCheck = pgTable("credential_check", {
	name: text().primaryKey(),
	checked_at: text("checked_at").notNull(),
	ok: integer().notNull(),
	detail: text(),
});

// --- SEAM CLOSED: full-text search landed with ob 322 ---
// The SQLite side still keeps its 5 fts5 virtual tables (item_fts, pr_comment_fts, email_fts,
// slack_fts, whatsapp_fts) plus 25 shadow tables, hand-maintained in app code -- SQLite stays
// authoritative until phase 6 (ob 326), so none of that was touched.
//
// On THIS side none of it exists. Each of the 5 source tables carries a generated `search_vec` tsvector
// column with a GIN index (declared at the table, see the ob 322 block near the top of this file), so
// there is nothing to sync and nothing to drift. The query side is `apps/cli/src/db/pg/search.ts`.

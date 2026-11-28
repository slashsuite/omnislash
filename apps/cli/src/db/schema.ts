import { sqliteTable, index, text, integer, primaryKey, blob, numeric, uniqueIndex } from "drizzle-orm/sqlite-core"
  import { sql } from "drizzle-orm"

export const item = sqliteTable("item", {
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
	// appended by migration 0016 (issue #56, ADD COLUMN lands last), the triage inbox. triage = 1 while
	// the item awaits triage (an architect in another repo handed it over); origin_repo records the repo it
	// came from. Cleared (triage back to 0) when triaged: a priority is set, or ob triage clear/reject.
	triage: integer().default(0),
	origin_repo: text("origin_repo"),
	// appended by migration 0037 (ob 1949): the item's current per-project ref, `<KEY>-<seq>` (PS-12).
	// `id` stays the permanent PK and the legacy bare number; this is how ob names the item to a human.
	// Every ref the item has ever had (this one included) is also a row in item_ref, which is what keeps an
	// old ref resolving after a move.
	ref: text(),
	// appended by migration 0042 (OB-2083): the item's place in its project's execution queue, ascending, NULL
	// = unranked (sorts after every ranked item in its priority band). Not today_rank: that is the one global
	// Today list; this is per project. Written only by setQueueOrder, which renumbers a whole band.
	queue_rank: integer("queue_rank"),
},
(table) => [
	index("idx_item_type_status").on(table.type, table.status, table.project_id, table.priority),
	uniqueIndex("idx_item_ref").on(table.ref),
]);

// ob 1949: every ref an item has carried, current and former. The PK is what stops a ref being handed out
// twice, even after it became an alias. Refs are stored upper-case; input is upper-cased before lookup.
export const itemRef = sqliteTable("item_ref", {
	ref: text().primaryKey(),
	item_id: text("item_id").notNull().references(() => item.id, { onDelete: "cascade" } ),
	created_at: text("created_at").notNull(),
},
(table) => [
	index("idx_item_ref_item").on(table.item_id),
]);

// ob 1949: the next seq per project key. Allocation is one upsert-returning inside the item's own insert
// transaction, so two concurrent adds cannot take the same number. Keyed by KEY, not project, because
// items with no project share OmniSlash's OB counter.
export const refCounter = sqliteTable("ref_counter", {
	key: text().primaryKey(),
	next_seq: integer("next_seq").notNull(),
});

export const taskDetail = sqliteTable("task_detail", {
	item_id: text("item_id").primaryKey().references(() => item.id, { onDelete: "cascade" } ),
	points: integer(),
	lifecycle_state: text("lifecycle_state"),
	assignee: text(),
	pr_url: text("pr_url"),
	branch: text(),
});

export const linearRef = sqliteTable("linear_ref", {
	item_id: text("item_id").primaryKey().references(() => item.id, { onDelete: "cascade" } ),
	linear_id: text("linear_id"),
	url: text(),
	cached_title: text("cached_title"),
	cached_state: text("cached_state"),
	cached_priority: integer("cached_priority"),
	last_synced_at: text("last_synced_at"),
});

export const project = sqliteTable("project", {
	id: text().primaryKey(),
	name: text().notNull(),
	kind: text().notNull(),
	git_remote: text("git_remote"),
	created_at: text("created_at").notNull(),
	// appended by migration 0037 (ob 1949): the per-project ref prefix, [A-Z]{2,4}, unique.
	key: text(),
	// appended by migration 0043 (OB-2116): the architect thread title's emoji and display name. NULL = unset.
	icon: text(),
	display_name: text("display_name"),
	// appended by migration 0045 (OB-2103): the release stage, alpha|beta|rc|stable|legacy. NULL = not set (treated as beta).
	stage: text(),
	// appended by migration 0046 (OB-2245) as the project's group; since OB-2255 it is the project's TEAM
	// (`project_group.name`, exported as `team`). NULL = in no team. A project is in at most one team.
	team_name: text("group_name"),
	// appended by migration 0005 (OS-134): the lifecycle status, active|paused|archived (see project-status.ts).
	// NOT NULL DEFAULT 'active', so every row that existed before the migration reads active.
	status: text().default("active").notNull(),
},
(table) => [
	uniqueIndex("idx_project_key").on(table.key),
]);

// migration 0046 (OB-2245) made this table for project groups; since OB-2255 it holds TEAMS (`ob t3 team`): a
// set of projects with one architect thread and optionally a sentinel and a muse. The table keeps its 0046 name
// (migrations are additive-only). The threads are agent rows `<role>-<team>`, not columns here.
export const team = sqliteTable("project_group", {
	name: text().primaryKey(),
	icon: text(),
	display_name: text("display_name"),
	created_at: text("created_at").notNull(),
});

// OB-2257: what a team role thread hands its replacement during `ob t3 team restart`. The old thread records
// its working state here (`ob t3 team handoff`), ob holds it while the old thread is settled and a new one
// opened, and the new thread is seeded with the body. `consumed_at` and `new_thread_id` are set once the seed
// went out; an unconsumed row is a restart that did not finish, which a re-run picks up.
export const teamHandoff = sqliteTable("team_handoff", {
	id: integer().primaryKey({ autoIncrement: true }),
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
export const roleRun = sqliteTable("role_run", {
	id: integer().primaryKey({ autoIncrement: true }),
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
export const roleMessage = sqliteTable("role_message", {
	id: integer().primaryKey({ autoIncrement: true }),
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
export const tournament = sqliteTable("tournament", {
	id: integer().primaryKey({ autoIncrement: true }),
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

export const tournamentCandidate = sqliteTable("tournament_candidate", {
	id: integer().primaryKey({ autoIncrement: true }),
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

export const tournamentMatch = sqliteTable("tournament_match", {
	id: integer().primaryKey({ autoIncrement: true }),
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

export const tournamentCall = sqliteTable("tournament_call", {
	id: integer().primaryKey({ autoIncrement: true }),
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
export const githubDelivery = sqliteTable("github_delivery", {
	delivery_id: text("delivery_id").primaryKey(),
	event: text().notNull(),
	received_at: text("received_at").notNull(),
});

// OB-2276: a red run on `main` that ob told (or, for a project in no team, recorded with nobody to tell). The
// run id is the key, so a run is told once; `recovered_at` is set by the first green run of that workflow after
// it. A row not yet recovered is an `ob alerts` row.
export const ciMainNotice = sqliteTable("ci_main_notice", {
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

export const tag = sqliteTable("tag", {
	id: integer().primaryKey({ autoIncrement: true }),
	name: text().notNull().unique(),
});

export const itemTag = sqliteTable("item_tag", {
	itemId: text("item_id").notNull().references(() => item.id, { onDelete: "cascade" } ),
	tagId: integer("tag_id").notNull().references(() => tag.id, { onDelete: "cascade" } ),
},
(table) => [
	index("idx_item_tag_tag").on(table.tagId),
	primaryKey({ columns: [table.itemId, table.tagId], name: "item_tag_item_id_tag_id_pk"})
]);

export const itemLink = sqliteTable("item_link", {
	fromItem: text("from_item").notNull().references(() => item.id, { onDelete: "cascade" } ),
	toItem: text("to_item").notNull().references(() => item.id, { onDelete: "cascade" } ),
	relType: text("rel_type").notNull(),
	position: integer(),
},
(table) => [
	index("idx_item_link_to").on(table.toItem),
	index("idx_item_link_from").on(table.fromItem),
	primaryKey({ columns: [table.fromItem, table.toItem, table.relType], name: "item_link_from_item_to_item_rel_type_pk"})
]);

export const skillCursor = sqliteTable("skill_cursor", {
	skill: text().notNull(),
	key: text().notNull(),
	value: text(),
	updatedAt: text("updated_at").notNull(),
},
(table) => [
	primaryKey({ columns: [table.skill, table.key], name: "skill_cursor_skill_key_pk"})
]);

export const config = sqliteTable("config", {
	key: text().primaryKey(),
	value: text(),
});

export const event = sqliteTable("event", {
	id: integer().primaryKey({ autoIncrement: true }),
	ts: text().notNull(),
	source: text(),
	type: text(),
	item_id: text("item_id").references(() => item.id, { onDelete: "set null" } ),
	actor: text(),
	cause: text(),
	payload: text(),
},
(table) => [
	index("idx_event_source_type_ts").on(table.source, table.type, table.ts),
	index("idx_event_item_type_ts").on(table.item_id, table.type, table.ts),
]);

export const lease = sqliteTable("lease", {
	resource: text().primaryKey(),
	holder: text(),
	acquired_at: text("acquired_at"),
	ttl_s: integer("ttl_s"),
	heartbeat_at: text("heartbeat_at"),
});

export const itemFtsData = sqliteTable("item_fts_data", {
	id: integer().primaryKey(),
	block: blob(),
});

export const itemFtsIdx = sqliteTable("item_fts_idx", {
	segid: numeric().notNull(),
	term: numeric().notNull(),
	pgno: numeric(),
},
(table) => [
	primaryKey({ columns: [table.segid, table.term], name: "item_fts_idx_segid_term_pk"})
]);

export const itemFtsContent = sqliteTable("item_fts_content", {
	id: integer().primaryKey(),
	c0: numeric(),
	c1: numeric(),
	c2: numeric(),
});

export const itemFtsDocsize = sqliteTable("item_fts_docsize", {
	id: integer().primaryKey(),
	sz: blob(),
});

export const itemFtsConfig = sqliteTable("item_fts_config", {
	k: numeric().primaryKey().notNull(),
	v: numeric(),
});

export const alertAck = sqliteTable("alert_ack", {
	alert_key: text("alert_key").primaryKey(),
	state_hash: text("state_hash"),
	snoozed_at: text("snoozed_at").notNull(),
});

export const roadmapDetail = sqliteTable("roadmap_detail", {
	itemId: text("item_id").primaryKey().references(() => item.id, { onDelete: "cascade" } ),
	targetDate: text("target_date"),
	sourceRef: text("source_ref"),
	owner: text(),
});

export const decisionDetail = sqliteTable("decision_detail", {
	item_id: text("item_id").primaryKey().references(() => item.id, { onDelete: "cascade" } ),
	context: text(),
	choice: text(),
	rationale: text(),
	alternatives: text(),
	decided_at: text("decided_at"),
	// OB-2097: an overnight or architect decision's doubt (how sure, what could be wrong) and undo (how to change it).
	doubt: text(),
	undo: text(),
});

export const learningDetail = sqliteTable("learning_detail", {
	item_id: text("item_id").primaryKey().references(() => item.id, { onDelete: "cascade" } ),
	kind: text(),
	progress: text(),
	source: text(),
	why: text(),
});

export const testUser = sqliteTable("test_user", {
	id: integer().primaryKey({ autoIncrement: true }),
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

export const prComment = sqliteTable("pr_comment", {
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
},
(table) => [
	index("idx_pr_comment_author").on(table.author),
	index("idx_pr_comment_pr").on(table.pr),
]);

export const prCommentFtsData = sqliteTable("pr_comment_fts_data", {
	id: integer().primaryKey(),
	block: blob(),
});

export const prCommentFtsIdx = sqliteTable("pr_comment_fts_idx", {
	segid: numeric().notNull(),
	term: numeric().notNull(),
	pgno: numeric(),
},
(table) => [
	primaryKey({ columns: [table.segid, table.term], name: "pr_comment_fts_idx_segid_term_pk"})
]);

export const prCommentFtsContent = sqliteTable("pr_comment_fts_content", {
	id: integer().primaryKey(),
	c0: numeric(),
	c1: numeric(),
});

export const prCommentFtsDocsize = sqliteTable("pr_comment_fts_docsize", {
	id: integer().primaryKey(),
	sz: blob(),
});

export const prCommentFtsConfig = sqliteTable("pr_comment_fts_config", {
	k: numeric().primaryKey().notNull(),
	v: numeric(),
});

export const person = sqliteTable("person", {
	id: integer().primaryKey({ autoIncrement: true }),
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
	// appended by migration 0004 (ADD COLUMN lands last) — maps a WhatsApp sender jid to this person
	whatsapp_jid: text("whatsapp_jid"),
	// appended by migration 0005 (ticket 142) — declared communication profile priming suggested replies
	relationship: text("relationship"),
	comms_style: text("comms_style"),
	comms_notes: text("comms_notes"),
	// appended by migration 0023 (ob 165) — South African ID number. The CLI masks this everywhere
	// and prints it in full only behind `--reveal`; treat it as a secret, not a display field.
	id_number: text("id_number"),
},
(table) => [
	// PARTIAL, as the handles are optional: only a present handle has to be unique.
	uniqueIndex("idx_person_slack").on(table.slack_user_id).where(sql`slack_user_id IS NOT NULL`),
	uniqueIndex("idx_person_linear").on(table.linear_user_id).where(sql`linear_user_id IS NOT NULL`),
	uniqueIndex("idx_person_github").on(table.github_login).where(sql`github_login IS NOT NULL`),
]);

export const agent = sqliteTable("agent", {
	id: text().primaryKey(),
	ticket: text(),
	worktree: text(),
	branch: text(),
	status: text(),
	started_at: text("started_at").notNull(),
	heartbeat_at: text("heartbeat_at").notNull(),
	ttl_s: integer("ttl_s").notNull(),
	note: text(),
	// appended by migration 0020 (issue #125, ADD COLUMN lands last): WHERE this agent lives - a launcher
	// name (a legacy value on an old row still reads as itself and is never rewritten), stamped at
	// register time from the RESOLVED launcher (never read back
	// from config, which changes). The agent registry needs its own value rather than joining through
	// spinoff: a hand-made `architect-<team>` row has no spinoff row at all, and the
	// spinoff join only holds while that row is still `launched`. NULL = unknown (a row predating this
	// migration, or a hand-registered agent that never said).
	launcher: text(),
	// appended by migration 0022 (issue #126, ADD COLUMN lands last): the Claude Code session id this
	// agent was LAUNCHED with (`claude --session-id <uuid>`), so a restarted session can continue that
	// session (`--resume <uuid>`) instead of re-running its brief. Minted by ob at launch, never
	// discovered afterwards: `--continue` would resolve to the most recent session for a directory, which
	// can be an unrelated one. NULL = launched before this existed, i.e. not resumable.
	session_id: text("session_id"),
	// appended by migration 0033 (wayfinder 1189, ADD COLUMN lands last): T3's OWN run enum, for a row
	// whose launcher is `t3` (`idle · preparing · queued · starting · running · waiting · completed ·
	// interrupted · failed · cancelled · rolled_back`), written ONLY by the run-state mirror (1120's
	// reconcile) and never self-set. `status` above carries ob's workflow words and nothing else, so the
	// two vocabularies never share a column (1189). NULL is a fact: a headless builder has no run, and
	// nothing here pretends otherwise.
	run: text(),
},
(table) => [
	index("idx_agent_heartbeat").on(table.heartbeat_at),
]);

export const spinoff = sqliteTable("spinoff", {
	id: integer().primaryKey({ autoIncrement: true }),
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
	// appended by migration 0017 (issue #61, folds #60, ADD COLUMN lands last): the merge-base of
	// (branch, main) captured at launch/adoption. Lets reconcile gate "merged" on there being at least
	// one commit past this base, not just "branch --merged main" (which trivially includes a
	// zero-commit branch). NULL for rows created before this migration (no backfill).
	base_sha: text("base_sha"),
	// appended by migration 0019 (issue #41, ADD COLUMN lands last): when this spinoff's completion was
	// reported by `ob spinoff watch`. NULL = not yet reported. Persisting it here (rather than in a
	// per-process id set) is what makes each completion emit exactly once across every ob process; 0019
	// backfills it for rows already `merged`, so watch never replays the historical backlog.
	reported_at: text("reported_at"),
	// appended by migration 0020 (issue #125, ADD COLUMN lands last): the launcher this spinoff was
	// actually launched into (a launcher name, or a legacy value on an old row), stamped at launch from
	// the RESOLVED launcher.
	// Not derivable later: it comes from spinoff_launcher / spinoff_launcher_by_repo, and flipping either
	// would make every historical row claim a home it never had. NULL for rows launched before this
	// migration (no backfill - a guess is worse than "unknown").
	launcher: text(),
	// appended by migration 0021 (issue #151, ADD COLUMN lands last): how many times this row has been
	// launched, incremented once per attempt at the claim (OB-1921). It is what bounds the retry of a spawn the app
	// reported as producing no session (#146): without a count, re-enqueueing on every reported failure
	// would relaunch forever against a deterministic failure.
	launch_attempts: integer("launch_attempts").default(0),
	// appended by migration 0022 (issue #126, ADD COLUMN lands last): the Claude Code session id this
	// row's launch command was given. Re-stamped on every launch attempt, because a launch that produced
	// no session (#146) also produced no conversation to resume. NULL = launched before this existed, or
	// launched into a launcher that does not resume (headless, or the legacy warp); nothing to continue.
	session_id: text("session_id"),
	// appended by migration 0023 (ADD COLUMN lands last): the harness engine this row's launch was
	// composed for — `claude` (Claude Code) or `opencode` (OpenCode). Stamped at launch from the
	// spinoff_engine setting (resolved once, like launcher), because reconcile has to read the token
	// usage from the transcript source of the engine that ACTUALLY ran: a row launched under opencode
	// keeps no `~/.claude/projects` transcript at all. NULL for rows launched before this migration
	// (no backfill — they predate opencode, so they read as `claude` by default).
	engine: text(),
	// appended by migration 0031 (wayfinder 1120, ADD COLUMN lands last): the T3 Code thread this row's
	// launch opened (`--launcher t3`). It is the id that lets a human reopen the builder in T3, and it is
	// what makes a RETRY idempotent: a drain that died between the launch and the stamp finds the thread
	// already bound to this row's worktree and adopts it instead of opening a second one. NULL for every
	// row launched anywhere else (headless, or a legacy value) — a thread is not a process.
	t3_thread_id: text("t3_thread_id"),
	// appended by migration 0031 (wayfinder 1120, ADD COLUMN lands last): the RUN id T3 minted for that
	// thread's launch, stamped with the thread so reconcile can name the run it read a status from rather
	// than re-deriving it. NULL when the thread was created idle (no run yet), or on a row with no thread.
	t3_run_id: text("t3_run_id"),
	// appended by migration 0032 (wayfinder 1163, ADD COLUMN lands last): the ob ITEM this row serves.
	// `ticket_ref` records the ref the row was DISPATCHED with, which is an ob item id only when the
	// ticket was numbered by `ob add`; a ticket charted by hand is dispatched by its wayfinder number
	// while its ob mirror carries its own id (row 591: ref "1124", item 1134). Every join wants the ITEM
	// — settle-on-close, the thread view, `ob t3 open` — so the identity is recorded at dispatch rather
	// than re-derived at each reader. NULL = a row queued before this existed (joined by its ref, plus
	// whatever wayfinder ticket its item's record names).
	item_id: text("item_id"),
	// appended by migration 0034 (wayfinder 1480, ADD COLUMN lands last): the complexity TIER the architect
	// rated this dispatch (`complex|medium|simple`), recorded at QUEUE time like `launcher`, so the drain
	// picks the tier's model rather than the T3 project's default. NULL = queued before 0034 (it launches
	// as `medium`, the same as a dispatch that names no tier).
	tier: text(),
	// appended by migration 0034 (wayfinder 1480): the model the launch ACTUALLY ran on, stamped at launch
	// (or the adopted thread's own model). Stamped rather than re-derived from the tier, because the
	// tier→model map is config and changes. NULL = not launched yet, a headless row, or pre-0034.
	model: text(),
	// appended by migration 0039 (OB-1815, ADD COLUMN lands last): the reasoning level. At QUEUE time it is the
	// level `--effort` named (`low|medium|high|xhigh|max`); the launch then stamps the final text (`high`,
	// `default (high)`, or `default (none listed)`), as `model` is stamped. NULL = not launched with a
	// stamp yet, or queued before 0039 (`ob spinoff show` prints `effort: default`).
	effort: text(),
	// appended by migration 0040 (OB-1992, ADD COLUMN lands last): a clean repo's verdict. Outside OmniSlash the
	// commit carries no `State:` line, so the builder records it here with `ob spinoff state`: the verdict word
	// (`landable|needs-human|blocked|partial`), its one-line reason, and the gate line. NULL = not recorded
	// (an OmniSlash row, whose verdict stays in git, or a clean-repo row dispatched before 0040).
	verdict: text(),
	verdict_reason: text("verdict_reason"),
	gate_line: text("gate_line"),
	// appended by migration 0041 (OB-1991, ADD COLUMN lands last): the row's leg in a model trial pair, `a` or
	// `b`, and the model the trial gave that leg (`provider:model`), which the launch uses in place of the tier's.
	// Leg b's ticket lease and clean-repo builder id carry a `-b` suffix so the two legs never share a key.
	// NULL = not a trial leg (every ordinary dispatch).
	trial_leg: text("trial_leg"),
	trial_model: text("trial_model"),
	// appended by migration 0044 (OB-2172, ADD COLUMN lands last): why the last readying note did not reach the
	// architect thread, as `<iso time> <reason>`, after the handoff retried once. A later note that is sent
	// clears it. NULL = the last note went (or none was tried); `ob spinoff gateable` and `show` print it.
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
	// appended by migration 0007_spinoff_model_ask (OS-132, ADD COLUMN lands last): the model `--model` named at
	// dispatch (`[provider:]model`), which the launch uses in place of the complexity band's model for THIS row only.
	// The models profile and `spinoff_tier_models` are not touched. `model` stays what the launch actually ran on.
	// NULL = none named (the band's model), and every row from before this migration.
	model_ask: text("model_ask"),
},
(table) => [
	// PARTIAL, as 0000 created it: one ACTIVE spinoff per ticket, any number of finished ones. The
	// WHERE was missing here until ob 1638's rebuild of spinoff would have re-created it without it.
	uniqueIndex("idx_spinoff_active")
		.on(table.ticket_ref)
		.where(sql`status IN ('pending', 'launching')`),
]);

// OB-1991: a model trial. While one is active, a dispatch at its tier runs twice, once per leg's model, and a
// blind review picks the winner. One active trial at a time (`active` 1); `target` is the number of pairs
// whose verdict is recorded before it ends by itself. A leg's model is `provider:model`, its effort a level or NULL.
export const spinoff_trial = sqliteTable("spinoff_trial", {
	id: integer().primaryKey({ autoIncrement: true }),
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
export const spinoff_trial_pair = sqliteTable("spinoff_trial_pair", {
	id: integer().primaryKey({ autoIncrement: true }),
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

export const standup = sqliteTable("standup", {
	date: text().primaryKey(),
	generated_md: text("generated_md"),
	edited_md: text("edited_md"),
	status: text().default("generated").notNull(),
	generated_at: text("generated_at"),
	edited_at: text("edited_at"),
	posted_at: text("posted_at"),
});

export const itemFts = sqliteTable("item_fts", {
	itemId: numeric("item_id"),
	title: numeric(),
	body: numeric(),
	itemFts: numeric("item_fts"),
	rank: numeric(),
});

export const prCommentFts = sqliteTable("pr_comment_fts", {
	id: numeric(),
	body: numeric(),
	prCommentFts: numeric("pr_comment_fts"),
	rank: numeric(),
});

// --- 126/127: Gmail + Calendar connectors (comms/PIM substrate, decision #26) ---

export const emailMessage = sqliteTable("email_message", {
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
},
(table) => [
	index("idx_email_message_thread").on(table.thread_id),
	index("idx_email_message_ts").on(table.ts),
]);

export const calendarEvent = sqliteTable("calendar_event", {
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

// email_fts + its fts5 shadow tables (hand-maintained in app code, no triggers — mirrors item_fts /
// pr_comment_fts). Declared here to keep schema.ts a faithful mirror of the DB; the virtual table is
// created by the 0001 migration (drizzle-kit cannot model fts5), the shadow tables by fts5 itself.
export const emailFtsData = sqliteTable("email_fts_data", {
	id: integer().primaryKey(),
	block: blob(),
});

export const emailFtsIdx = sqliteTable("email_fts_idx", {
	segid: numeric().notNull(),
	term: numeric().notNull(),
	pgno: numeric(),
},
(table) => [
	primaryKey({ columns: [table.segid, table.term], name: "email_fts_idx_segid_term_pk"})
]);

export const emailFtsContent = sqliteTable("email_fts_content", {
	id: integer().primaryKey(),
	c0: numeric(),
	c1: numeric(),
	c2: numeric(),
});

export const emailFtsDocsize = sqliteTable("email_fts_docsize", {
	id: integer().primaryKey(),
	sz: blob(),
});

export const emailFtsConfig = sqliteTable("email_fts_config", {
	k: numeric().primaryKey().notNull(),
	v: numeric(),
});

export const emailFts = sqliteTable("email_fts", {
	id: numeric(),
	subject: numeric(),
	body: numeric(),
	emailFts: numeric("email_fts"),
	rank: numeric(),
});

// --- 128: Slack (work) read-only awareness source ---
// One row per ingested message (mentions / DMs / tracked threads); dedupe on (channel, ts). person_id
// enriches the sender when the Slack user id is registered. raw keeps the untouched Slack API JSON.
// Read-only: nothing here is ever sent to Slack.
export const slackMessage = sqliteTable("slack_message", {
	id: integer().primaryKey({ autoIncrement: true }),
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
},
(table) => [
	uniqueIndex("idx_slack_message_channel_ts").on(table.channel, table.ts),
	index("idx_slack_message_ts").on(table.ts),
]);

export const slackFtsData = sqliteTable("slack_fts_data", {
	id: integer().primaryKey(),
	block: blob(),
});

export const slackFtsIdx = sqliteTable("slack_fts_idx", {
	segid: numeric().notNull(),
	term: numeric().notNull(),
	pgno: numeric(),
},
(table) => [
	primaryKey({ columns: [table.segid, table.term], name: "slack_fts_idx_segid_term_pk"})
]);

export const slackFtsContent = sqliteTable("slack_fts_content", {
	id: integer().primaryKey(),
	c0: numeric(),
	c1: numeric(),
});

export const slackFtsDocsize = sqliteTable("slack_fts_docsize", {
	id: integer().primaryKey(),
	sz: blob(),
});

export const slackFtsConfig = sqliteTable("slack_fts_config", {
	k: numeric().primaryKey().notNull(),
	v: numeric(),
});

export const slackFts = sqliteTable("slack_fts", {
	messageId: numeric("message_id"),
	text: numeric(),
	slackFts: numeric("slack_fts"),
	rank: numeric(),
});

// --- 135: encrypted secret store ---
// AES-256-GCM ciphertext for each named secret (raw token OR the google-token JSON). The master key
// lives ONLY in the macOS Keychain (never here / in a backup); this table holds ciphertext + the
// per-secret random iv + the GCM auth tag (all base64). `ob backup` VACUUMs this table safely — a
// dump without the Keychain key is inert.
export const secret = sqliteTable("secret", {
	name: text().primaryKey(),
	ciphertext: text().notNull(),
	iv: text().notNull(),
	auth_tag: text("auth_tag").notNull(),
	created_at: text("created_at").notNull(),
	updated_at: text("updated_at").notNull(),
});

// --- 099/100: WhatsApp (personal) read-only ingest source ---
// One row per ingested WhatsApp message, mirrored from the Go bridge's messages.db (read-only; ob never
// writes the bridge). `id` is the bridge message id; dedupe is on (chat_jid, id) since a bridge id is only
// unique within a chat. person_id enriches the sender when their whatsapp_jid is registered (enrichment
// only — an unmapped sender, incl. @lid privacy ids, still lands with person_id NULL). raw keeps the
// untouched bridge row. The fts5 rowid (message_id) is the whatsapp_message implicit rowid.
export const whatsappMessage = sqliteTable("whatsapp_message", {
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
	// appended by migration 0009 (ticket 186b, ADD COLUMN lands last) — bridge delivery/read receipt
	// state for outbound messages: sent | delivered | read | played (stored `sent` from first ingest since
	// 1936); NULL = inbound, or a row stored before it. Renders ticks.
	status: text("status"),
	// appended by migration 0010 (ticket 198b, ADD COLUMN lands last) — cached vision description of an
	// image message so the suggested-reply prompt can "see" photos; null until described. Only the
	// DERIVED text is cached here — image bytes are never persisted to the prompt store.
	media_desc: text("media_desc"),
},
(table) => [
	uniqueIndex("idx_whatsapp_message_chat_id").on(table.chat_jid, table.id),
	index("idx_whatsapp_message_ts").on(table.ts),
]);

export const whatsappFtsData = sqliteTable("whatsapp_fts_data", {
	id: integer().primaryKey(),
	block: blob(),
});

export const whatsappFtsIdx = sqliteTable("whatsapp_fts_idx", {
	segid: numeric().notNull(),
	term: numeric().notNull(),
	pgno: numeric(),
},
(table) => [
	primaryKey({ columns: [table.segid, table.term], name: "whatsapp_fts_idx_segid_term_pk"})
]);

export const whatsappFtsContent = sqliteTable("whatsapp_fts_content", {
	id: integer().primaryKey(),
	c0: numeric(),
	c1: numeric(),
});

export const whatsappFtsDocsize = sqliteTable("whatsapp_fts_docsize", {
	id: integer().primaryKey(),
	sz: blob(),
});

export const whatsappFtsConfig = sqliteTable("whatsapp_fts_config", {
	k: numeric().primaryKey().notNull(),
	v: numeric(),
});

export const whatsappFts = sqliteTable("whatsapp_fts", {
	messageId: numeric("message_id"),
	content: numeric(),
	whatsappFts: numeric("whatsapp_fts"),
	rank: numeric(),
});

// --- 169: per-chat WhatsApp preferences (hide a chat/person + disable AI per chat) ---
// One row per chat, keyed by the CANONICAL chat_jid (164) — a person's @lid privacy-id and phone-jid
// share ONE pref, and groups + unmapped numbers are supported too (any jid, not just a `person` row).
// A chat with no row behaves as before: shown in the feed + AI-suggested replies enabled. hidden drops
// a chat out of latestPerChat (unless includeHidden); ai_disabled gates the suggested-reply path.
export const whatsappChatPref = sqliteTable("whatsapp_chat_pref", {
	chat_jid: text("chat_jid").primaryKey(),
	hidden: integer().notNull().default(0),
	ai_disabled: integer("ai_disabled").notNull().default(0),
	updated_at: text("updated_at").notNull(),
	// 190a: this chat is a FAVOURITE — the feed shows favourites-first (falls back to all when none).
	// Appended last via the 0012 ADD COLUMN migration, so it sits after updated_at in the physical table.
	favorite: integer("favorite").notNull().default(0),
});

// --- 0024 (ob 218): per-job health, the signal `ob alerts` reads ---
// ONE row per declared daemon job, holding its CURRENT state rather than a history: when it was first
// tracked, when it last attempted, when it last succeeded, why it last failed, and how many failures
// have run back to back. Current state is what the three alert rules ask for, and a row per run would
// make every `ob alerts` a scan of a log that grows by 288 rows a day for gmail-sync alone.
// first_attempt_at never moves after the first write: it is how the alerts know how long this machine
// has been tracking jobs at all, which is what keeps a job that has simply not come round yet quiet.
// Created by migration 0024.
export const jobRun = sqliteTable("job_run", {
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
	// the job, and only its REPETITION does. Last, because 0025 appends it.
	consecutive_interruptions: integer("consecutive_interruptions").notNull().default(0),
});

// --- ob 582: what is deployed, per target ---
// ONE row per deploy target (live omnislash-web on the API host, the ob 581 test/dev instance, ...) holding
// the LATEST outcome only: target is the row's identity, and host/unit/sha/at/result are what the last
// deploy (or no-op) attempt left actually in service. The writer is the server's deploy script (and
// the 581 web-dev push); the reader is `ob deploy status`. A no-op deploy still refreshes the row so
// "what's live" cannot go stale, and a rollback is recorded as result=rolled-back rather than silence.
export const deploy = sqliteTable("deploy", {
	target: text().primaryKey(),
	host: text().notNull(),
	unit: text().notNull(),
	sha: text().notNull(),
	at: text().notNull(),
	result: text().notNull(),
});

// --- 0026 (ob 219): the last live check of each credential, the job_run idea one layer down ---
// A credential check costs a provider call, so it only runs when a person clicks "check now" or types
// `ob creds check`, or from the one daily job that asks (creds-check, ob 1655: `ob creds check --all` at 07:45,
// ahead of the 08:00 alerts digest). This table is what that leaves behind, so the tokens page can say
// "checked 3 minutes ago" without calling again, and so a check that FAILED can surface on the same
// alert list as a failing job. ONE row per credential holding the LATEST verdict only: the question
// asked of it is always "is it good right now", never "how has it behaved over the month".
// `detail` is a short human reason (an HTTP status, an account name, a missing-file path) and NEVER
// carries the credential's value. Created by migration 0026.
export const credentialCheck = sqliteTable("credential_check", {
	name: text().primaryKey(),
	checked_at: text("checked_at").notNull(),
	ok: integer().notNull(),
	detail: text(),
});

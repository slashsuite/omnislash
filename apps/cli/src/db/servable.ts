// ob 337: which `ob` commands are servable from Postgres, and the stand-in handle for the ones that are.
//
// A module that depends on NOTHING but errors.ts and store-kind.ts, for the same reason store-kind.ts is
// one: db.ts's two-live-stores refusal names these commands, and db.ts cannot import store.ts (store.ts
// imports db.ts). Re-exported from store.ts, which is where consumers import it from.
import type { Database } from "bun:sqlite";
import { AppError } from "../errors.ts";
import { SQLITE_ESCAPE_HATCH, STORE_ENV } from "./store-kind.ts";

// --- which commands are servable from Postgres (337) ------------------------
//
// THE POINT OF THIS LIST IS THAT IT IS SHORT AND EXPLICIT.
//
// db.ts's guard refuses to open the SQLite file under OMNISLASH_STORE=postgres, which is what makes a
// partial port safe: an unported command fails loudly instead of quietly writing the dead file. This
// list is the other half -- the commands whose EVERY path has been ported to the store seam, which
// cli.ts therefore opens the Postgres store for instead of a file. Postgres is the default since 337j,
// so this list is consulted on every command now; under an explicit OMNISLASH_STORE=sqlite it is not
// consulted at all and nothing here changes behaviour.
//
// A COMMAND GOES ON THIS LIST ONLY WHEN EVERY PATH IT TOUCHES IS PORTED. "Mostly ported" is the failure
// this whole design exists to prevent: a command that reads half its data from the wrong engine is worse
// than one that refuses, because the refusal is reversible and a wrong answer that was acted on is not.
// Adding a name here without walking its handler is how that gets reintroduced.
//
// Deliberately ABSENT and why:
//   issue/daemon/…         -- their modules are not ported yet.
//   issue landed/drift     -- the git+spinoff "already on main?" path is sqlite-only by construction.
//
// ADDED IN PASS 3 -- `lease`, `agent`, `agents`, and why each is genuinely complete. These are the
// commands that make the tracker WORKABLE rather than merely readable: without them a cut-over `ob`
// could be read but no session could take a ticket or spin off work. Every path was walked:
//   lease   -- coord.ts's cmdLease reaches only lease.ts (fully ported: acquire/release/heartbeat/
//              status/liveHold/recordedHold) plus the pure key builders. No config, no epic, no items.
//   agents  -- cmdAgents reaches listAgents (ported) and agentLauncherMap (ported), then pure
//              formatting via effectiveLauncher. `agents reset` (437) reaches resetAgentsAndLeases
//              (ported: agent + lease tables only).
//   agent   -- register/heartbeat/done/active reach agent.ts (fully ported), lease.ts for the ticket claim a register takes and a done releases, and
//              from spinoff.ts ONLY recordSpinoffSpawnFailure and agentLauncherMap, both of which are
//              ported. `gitInfo` shells out to git and touches no database.
// All three read through `ctx.store`, never `ctx.db`, so under postgres the stand-in handle is never
// reached. pg-coord-337.test.ts runs the whole sequence on both engines and diffs the results.
//
// Two known edges on commands that ARE on the list, both loud rather than silent:
//   `ob add --issue`   creates a GitHub issue through the unported credential path and needs a raw
//                      handle; in postgres mode it throws naming the command.
//   `ob close/reopen`  mirror onto a linked GitHub issue through that same path. The LOCAL close still
//                      happens and stands; the mirror reports the drift on stderr and exits 1, which is
//                      the same contract a GitHub outage already has.
export const POSTGRES_SERVABLE_COMMANDS: ReadonlySet<string> = new Set([
	"next",
	"show",
	"list",
	"today",
	"order",
	"focus",
	"project",
	"config",
	"add",
	"start",
	"ready",
	"block",
	"unblock",
	"close",
	"reopen",
	// pass 3 (the coordination core)
	"lease",
	"agent",
	"agents",
	// OB-2041: `ports` reaches only lease.ts (leaseStatus, acquireLease) through ctx.store, plus machine facts (ss, ufw, route).
	"ports",
	// OB-2006: `wiki` reaches only listProjects, settingFor and one item select, all through ctx.store, plus markdown files on this machine.
	"wiki",
	// OB-2278: `usage` reaches only listSpinoffs, listAgents and listProjects, all through ctx.store, plus transcript files on this machine.
	"usage",
	// OS-182: `skills` reads only the repo_checkouts setting through ctx.store, plus the links in ~/.claude/skills.
	"skills",
	// OB-2286: `ci` and `github` reach only ci-main.ts through storeCiBackend(ctx.store), the same functions the webhook route runs on Postgres.
	"ci",
	"github",
	// 337 pass 4: the item-adjacent writes. Every path they touch is items.ts (appendNote, addTags,
	// removeTags, addLink) plus project.ts for `ob tag --repo`, and both are ported. `ob note` and
	// `ob tag` write through the same syncFts that is sqlite-only by construction -- on Postgres the
	// search vector is a GENERATED column, so there is nothing to sync and nothing to skip by accident.
	"note",
	"tag",
	"untag",
	"link",
	// 337 pass 4: `ob search`. The fts5 MATCH is unchanged for SQLite; postgres mode runs ob 322's
	// tsquery translator against the generated search_vec column, with its pg_trgm fallback. This is the
	// one command where the two engines genuinely do not match the same rows -- Postgres finds MORE on 6
	// of 29 measured queries and loses nothing, which is 322's
	// documented, accepted outcome rather than a defect to be reconciled away. See src/search.ts.
	"search",
	// 337 pass 4: `ob log`, the standup journal. It reads and writes the event store, which keeps its
	// SYNCHRONOUS sqlite-only functions for the 28 unported call sites through the connectors, metrics,
	// alerts and audit -- `ob log` uses the `...For` forms beside them (the settings.ts precedent).
	// `event.ts` is NOT NULL on both engines, so its DESC/ASC orderings cannot meet the NULLS-first vs
	// NULLS-last difference; `id` breaks ties so two events in the same millisecond do not swap places.
	"log",
	// 337 pass 5: `ob spinoff`, and it is the one that makes the tracker USABLE rather than merely
	// workable -- it is how every builder is launched, so a cut-over ob without it could take a ticket but
	// never dispatch one. Every path was walked:
	//   the queue      -- enqueue/list/claim/stamp/land/reclaim, ported in pass 3, plus the leases and the
	//                     agent registry each of them touches (both ported in pass 3).
	//   the CONFIG     -- the launcher routing (spinoff_agent_cmd,
	//                     spinoff_launcher, spinoff_launcher_by_repo), the `--repo` slug map
	//                     (repo_checkouts) all read
	//                     through `settingFor`, via an async `...For` form beside each synchronous one.
	//                     Every pair shares ONE pure decision function, so an engine cannot change the
	//                     answer, only where the text came from.
	//   the ENQUEUE    -- the ticket's tags now go through the ported `itemForIssue` / `trackerRepo` /
	//                     `getTags` rather than `getTagsSync` / `sqliteItemForIssue` / `sqliteTrackerRepo`.
	//   git + the launcher -- worktrees, merge-bases and the spawned agent are facts
	//                     about THIS MACHINE, not about an engine, and are unchanged.
	// Orderings are all on NOT NULL columns (`spinoff.id` asc for the FIFO drain and desc for the list,
	// `agent.started_at` asc), so the NULLS-FIRST/LAST split cannot reach them.
	//
	// Three edges, every one of them LOUD rather than silent:
	//   `ob spinoff watch`   refuses by name: its trigger is fs.watch on the database FILE, so under
	//                        Postgres it would block forever and report nothing (WATCH_UNDER_POSTGRES_MSG).
	//   `ob spinoff #<n>`    fetches the GitHub issue through the unported credential path and needs a raw
	//                        handle; in postgres mode it throws naming the command, exactly as
	//                        `ob add --issue` does. Every other ref shape never reaches it.
	//   the DISPATCH rewrite (`rewriteSpinoffRepoArgv`) stays sqlite-only, and is unreachable here: it runs
	//                        only when a remote_host is configured, which is the replica/split path that
	//                        337 already refuses outright under postgres.
	"spinoff",
	// 337 pass 6: the REPORTING reads -- `ob status`, `ob report` and `ob metrics`. These are the ones
	// made almost entirely of aggregates and ordered reads, so they are where the string-aggregate trap
	// bites hardest: every count() in epicSummaries goes through readNumber, and the ZERO case is asserted
	// separately because "0" is truthy while 0 is not, and that IS the surface-this-epic decision.
	// Every path was walked:
	//   status   -- listAgents, recentlyDoneSpinoffs and the journal were ported in passes 3-5; open
	//               items, in-flight PRs, the epic rollup and the `about`-handle lookup are ported here.
	//   report   -- the standup (items closed, delivered tickets, blocked, focus, journal, rescopes) and
	//               the sprint/quarter builders, including the cursor ADVANCE through setCursorFor: a
	//               cursor advanced on one engine and read from the other replays or skips a standup.
	//   metrics  -- derived in TypeScript from whole event rows rather than from SQL aggregates, which is
	//               what keeps sum()/count()-as-string out of the numbers rather than coercing it away.
	// Orderings: item (`today_rank is null` then rank asc, updated_at desc, id asc), event.id asc for
	// "latest pr_synced facts win", scope_change (at, id) desc, epic_progress_snapshot.at asc,
	// epic.epic_ref asc, person.real_name + id asc. Every one is on a NOT NULL column or an expression
	// that sorts identically on both engines, and every tie now has an id (or author) breaking it.
	//
	// Two sub-paths degrade LOUDLY rather than silently, both because they need a token from the unported
	// credential path in net.ts:
	//   the wayfinder FRONTIER  in `ob status` would otherwise vanish, and an absent section reads exactly
	//                           like an empty frontier. It prints the reason instead, and `--json` carries
	//                           it as `frontier_note`.
	//   `ob report --sprint`'s  Linear cycle lookup takes the same 14-day fallback a missing token or an
	//                           offline machine already takes, with a note naming which happened.
	"status",
	"report",
	"metrics",
	// 337 pass 6: the FLEET pair, and they are what makes a cut-over `ob` able to answer "is my ingestion
	// alive". Both were walked:
	//   daemon  -- cmdDaemon touches no database AT ALL: it renders launchd plists from daemonJobs(),
	//              writes them under ~/Library/LaunchAgents and shells out to launchctl. Those are facts
	//              about this machine, not about an engine, so it is servable by construction rather than
	//              by porting. (It reached openDb only because every command did.)
	//   jobs    -- cmdJobs reads jobHealthFor(store): the job_run table plus three alert settings, both
	//              ported, against the fleet daemonJobs() declares. `ob alerts` keeps the SYNCHRONOUS
	//              jobHealth beside it and the two share one pure computeJobHealth, so the label cannot
	//              differ by engine. The only ordering is a JS localeCompare on the job name, and the one
	//              read has no ORDER BY at all, so the NULLS-first/last split cannot reach it.
	// The recording seam in cli.ts moved onto the store in the same change, which it had to: `spinoff
	// drain` is a declared job AND a servable command, so under postgres the seam was handed the stand-in
	// handle and threw before the handler ran.
	"daemon",
	"jobs",
	// 337 pass 6: THE BACKUP PAIR, and they are the ob 326 precondition rather than a nice-to-have. Both
	// were written against SQLite so completely that the engine was not named -- `VACUUM INTO` has no
	// Postgres form at all -- so an unported `ob backup` would not have failed after the cutover. It would
	// have kept running monthly, kept uploading a release, kept exiting 0, and kept copying the dead
	// SQLite file. See src/db/capture.ts: the copy is now `pg_dump --format=custom`, the artifacts are
	// named `.dump` rather than `.sqlite` because the suffix is what a restore reads the format off, and
	// the connection reaches pg_dump through libpq ENV so no password ever appears in `ps`.
	//   backup  -- cmdBackup reads backup_repo, the three ha_* rows and the two TLS rows through
	//              settingFor; everything else it touches is gh, ssh and the filesystem.
	//   db      -- `ob db backup` (the alias) and `ob db snapshot` (the local hourly history), same
	//              capture path, same rotation policy. Rotation is a question about FILES in a directory,
	//              so it is engine-independent; only the estimate of the next artifact's size changed,
	//              since a logical dump has no file to measure in advance.
	"backup",
	"db",
	// 337 pass 7: the WORK LOOP. `edit`, `rm`, `state` and `triage` were ported with items.ts and
	// workflow.ts and were never added here -- every path they touch (editItem, deleteItem, transitionTo,
	// setBlocked, assertTransition, clearTriage, triageInbox, resolveProject) is on the store seam and is
	// covered by pg-items-337. `state <id> done` mirrors onto a linked GitHub issue through the unported
	// credential path exactly as `ob close` does, with the same loud contract: the LOCAL move stands, the
	// mirror reports the drift on stderr and exits 1.
	"edit",
	"rm",
	"state",
	"triage",
	// 337 pass 7: `ob brief`, the work-state read the /ob-slack-triage skill is built on. Ported here: the
	// event feed, the pr_synced ticket map, the linear_ref lookup and the in-flight grouping,
	// on top of inFlightPrsFor.
	// TWO of its reads had NO ORDER BY at all -- the epic member list and the in-flight item list. SQLite
	// answers those in rowid order and Postgres answers them however its query optimiser likes, so the rendered
	// list would have differed by engine and been unstable on Postgres. Both are ordered by `item.id` asc
	// now, a NOT NULL primary key. Everything else it orders is `event.ts`/`event.id` DESC, both NOT NULL.
	"brief",
	// 337 pass 7: the three entity readers that turned out to be ported already, walked rather than
	// assumed. Each reaches items.ts and nothing else:
	//   decision -- queryItems, getDecisionDetail, getLinks, and `supersede`'s three writes inside one
	//               Store.txn (a link without both status changes is a chain that reads as broken).
	//   learning -- queryItems, getItem, getLearningDetail, getLinks. Read-only.
	//   roadmap  -- queryItems, getRoadmapDetail, addLink, and getRoadmapMembers, whose ordering already
	//               handles the split explicitly: it leads with `position is null` so an unpositioned
	//               member cannot jump to the top of the roadmap on Postgres.
	"decision",
	// OB-2004: `doc` reads and writes items.ts and events.ts only (createItem, editItem, queryItems, referenceVersions),
	// all store-aware, so it serves on Postgres.
	"doc",
	"learning",
	// 739: `ob memory`. show is this machine's MEMORY.md (no store). add appends that file and
	// dual-writes `createItem({type:"learning"})`, which is items.ts, ported. The file half is
	// this machine, not an engine, so it is servable by construction for the learning half.
	"memory",
	"roadmap",
	// 337 branch G: THE CONNECTORS. These are the ones the scheduled sync timers run, so an unported one
	// does not degrade at the cutover -- it REFUSES, and ingestion stops with nothing but failure tickets.
	//   gmail   -- syncGmail (messages.list backfill + history.list incremental + its cursor), searchEmail
	//              (ob 322's tsvector translator; email_fts is gone) and recentEmail. Reaches ingest/gmail,
	//              google.ts, secrets.ts, settings' cursors and person enrichment, all ported.
	//   cal     -- syncCalendar (bounded backfill, syncToken cursor, 410-GONE resync) and agendaToday.
	//   agenda  -- the same read, as its own top-level command.
	//   secret  -- set/get/list/rm/import, all through the ported secret table. The CRYPTOGRAPHY did not
	//              move: same AES-256-GCM, same master key from the Keychain or the 0600 file.
	//   creds   -- the inventory, the recorded verdicts and the paste write-path. Its whatsapp row reads
	//              the bridge's own files over loopback, which is not a database at all.
	//   whatsapp-- syncWhatsapp, the 312 fold, the feed, the thread reader, search, prefs, media, avatar,
	//              transcription and the suggest/converse gates. The bridge's messages.db and whatsapp.db
	//              stay bun:sqlite READ-ONLY, deliberately: they are the Go bridge's files, not ob's store.
	//
	"gmail",
	"cal",
	"agenda",
	"secret",
	"creds",
	"whatsapp",
	// 337 branch K: `ob web`, THE DASHBOARD. It is the one whose absence was already visible -- the
	// dashboard has been DOWN since the cutover, with its launchd job stopped so it would not fail every
	// cycle, because `ob web` refused under Postgres.
	//
	// What made it refuse was worth keeping until now. `apps/dashboard/src/server/ob.ts` opened its own
	// `bun:sqlite` handle per server function and handed `sqliteStoreFor(thatHandle)` to the calls that
	// had already been ported. That COMPILES, and it makes every read come from the frozen SQLite file:
	// the page would have served, rendered and live-updated from data that stopped moving at the cutover,
	// with nothing on stderr and nothing thrown. A dashboard that is down gets fixed; a dashboard that is
	// confidently stale does not get noticed.
	//
	// Every path was walked, and `ob web` has two halves that must BOTH be ported or the page is built
	// out of two databases:
	//   the CLI half -- cmdWeb reads `web_bind` (webBindFor) and the two `web_tls_*` rows
	//                   (webTlsPathsFor, ported here) through the store. Everything else it does is
	//                   spawning the app's build and its server, which are facts about this machine.
	//                   The app's own server mounts the realtime sidecar (OS-214).
	//   the SIDECAR  -- snapshotFrom (buildStatus, latestStandup, latestPerChat, computeAlerts +
	//                   filterSnoozed, lastStandupAt, listSpinoffs, branch_age_days) and the /api/whatsapp routes (media, avatar, thread, transcribe -- ported with
	//                   `whatsapp` in branch G). Change detection is a POLL rather than fs.watch on the
	//                   database FILE, which has no Postgres form and would have failed by never firing.
	//   the PAGE     -- the TanStack server functions run in the spawned child, which resolves the SAME
	//                   store from the SAME configuration. It no longer knows a database path exists.
	//
	// Orderings: `standup.date` (the primary key) desc, `gap.(resolved, epic_ref, id)` asc (all NOT NULL, `id`
	// breaking ties), `scope_change.(at, id)` desc, `epic_snapshot.snapshot_at` desc (NOT NULL, half the
	// composite key) and `event.(ts, id)`. None can meet the NULLS-FIRST-on-Postgres split. Reads that had NO
	// ordering at all are ordered by `item.id` asc now, the same fix `ob brief` needed.
	//
	// The aggregate trap does not reach the metrics surface: every metric is derived in TypeScript from
	// whole event rows rather than from SQL sum()/count(), which is what `ob metrics` already relies on.
	"web",
	// 337 branch K: `ob alerts`, the CLI half of the dashboard's notification centre. It reached the
	// event store, the settings and the person registry through the synchronous sqlite-only halves; all
	// three now go through the store (`eventsBetweenFor`, `settingNumFor`, `getPersonFor`), which is what
	// `ob web` needed anyway -- the snapshot carries the un-acked alert count. Every rule was walked:
	// 1-4 (queryItems + task_detail + the github event streams), 5 (epic_snapshot), 6 (retired; was lastContactBatch
	// + getPersonFor), 7-10 (jobHealth, ported with `ob jobs`), 11 (lastCredentialChecks, ported with
	// `ob creds`). `filterSnoozed` reads the whole (tiny) alert_ack table ONCE instead of a query per
	// surfaced alert, which was free against an in-process handle and is a round trip against a
	// connection.
	"alerts",
	// 456: remaining DATA commands. Every path they touch is on the store (epic writes included, which
	// is what unblocked `sync`).
	"person",
	"whois",
	// OB-2097: the overnight log. Every path is overnight.ts (items.ts + doc.ts) through the store seam.
	"overnight",
	"review-miss",
	// OS-170: `ob machine audit` reads items, spinoff rows and events through the store seam only.
	"machine",
	// OS-310: `ob schedule` reads and writes scheduled_job rows through the store seam only.
	"schedule",
	"review",
	"audit",
	"cursor",
	"test-user",
	"sync",
	// 582: `deploy` -- the one-row-per-target deploy record written by the server's deploy script
	// (and the 581 web-dev push) and read by `ob deploy status`. Every path is commands/deploy.ts, which
	// reaches only the deploy table through the store seam, so it is servable by construction.
	"deploy",
	// 1615: `ob cert`, the LAN certificate `ob web` serves. Its five config rows (tls_domain, tls_email,
	// tls_dir, tls_renew_days, lego_bin) read through settingFor and the Cloudflare token through the
	// ported secret table; everything else is lego, openssl-free X509 parsing and files under tls_dir,
	// which are facts about this machine. Before this it refused on the API host, so the cert could not be issued.
	"cert",
	// 1646: `ob cloudflare` (zones | tunnels | dns list|add|rm). Its two secret reads (cloudflare-api-token,
	// cloudflare-account-id) go through `getSecret(ctx.store, ...)` on the ported secret table, the Cloudflare
	// call is an HTTP fact about this machine, and the daily tunnel-check job row is recorded by cli.ts's
	// recording seam on the store. Before this it refused on the API host, so the `tunnel-check` timer could not run.
	"cloudflare",
]);

/** Is this command's every path ported to the store seam (337)? */
export function isPostgresServable(command: string): boolean {
	return POSTGRES_SERVABLE_COMMANDS.has(command);
}

/**
 * A stand-in for the raw bun:sqlite handle in postgres mode, which THROWS on any use (337).
 *
 * `Ctx.db` is typed `Database` and a hundred unported call sites still reach for it, so a ported command
 * running against Postgres has to be handed something. Handing it a real handle would reopen the file
 * this whole guard exists to keep shut, and handing it an in-memory database would be worse still: the
 * write would succeed, against a database that vanishes at exit. So it is handed this, which cannot be
 * used by accident and says exactly what happened when it is.
 *
 * `close` is the one allowed operation, because cli.ts closes the handle in a finally it must not fail.
 */
export function unusableSqliteHandle(what: string): Database {
	const refuse = (prop: string): never => {
		throw new AppError(
			[
				`${what} reached the SQLite handle while ${STORE_ENV}=postgres (it used db.${prop}).`,
				`  that path is not ported to the store seam yet (ob 337), and opening the file would mean TWO LIVE STORES.`,
				`  to run it now: ${SQLITE_ESCAPE_HATCH} -- the sqlite path still exists, and is frozen at the cutover.`,
			].join("\n"),
		);
	};
	return new Proxy(
		{},
		{
			get(_t, prop) {
				if (prop === "close") return () => {};
				if (prop === "inTransaction") return false;
				if (prop === Symbol.toStringTag) return "UnusableSqliteHandle";
				return refuse(String(prop));
			},
			has() {
				// `asStore` distinguishes a Store from a Database with `"kind" in db`, and this is not a
				// Store, so every membership test must answer false rather than throw.
				return false;
			},
			set(_t, prop) {
				return refuse(String(prop));
			},
		},
	) as unknown as Database;
}

/**
 * The refusal for a replica-served read under OMNISLASH_STORE=postgres (337).
 *
 * `ob` on a client machine answers allowlisted reads from a local SQLite REPLICA of the server's SQLite
 * database, refreshed over ssh. That replica has no Postgres form, and openDb's guard cannot see it --
 * the replica opens its own handle by its own path. So a client that had been switched to postgres would
 * have carried on answering `ob next` from a copy of the engine the cutover had just left, correctly
 * shaped and quietly out of date. Refusing is the same rule as everywhere else in 337, with the same way
 * back.
 */
export function replicaUnderPostgresMessage(what: string, host: string | null): string {
	return [
		`${STORE_ENV}=postgres, but ${what} would be answered from the local SQLite replica${host ? ` of ${host}` : ""}.`,
		`  refusing: the replica is a copy of the SQLITE database, so it would answer from the engine the cutover left, with no error anywhere.`,
		`  to run this command now: ${SQLITE_ESCAPE_HATCH} (the replica's own engine, complete but frozen), or run it on the server itself.`,
	].join("\n");
}

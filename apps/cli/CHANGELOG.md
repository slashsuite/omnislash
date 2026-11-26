# `ob` changelog

Migrations and decisions that explain why `ob` works the way it does today. Each entry keeps the ticket number it came from. Current behaviour is documented in the [guide](docs/guide.md) and the [command reference](docs/commands.md).

## What phase B needed, and what the server now serves (353 found it, 352b served it)

The client landed after the server, so the gaps only showed up once something was actually calling the
endpoints. They are served now.

- **`AcquireLeaseResponse.recorded` / `ReleaseLeaseResponse.recorded`**: who the lease row *names*,
  whether or not the hold is still live. Without it a refused release can only say it released nothing,
  which reads like a bug; with it the client prints #75's teaching message ("held by `<holder>`, not you
  … re-run as it with `--holder <holder>`"), which is the sentence that stops people reaching for
  `--force`. The row is read **before** the release, because a successful release deletes it and there
  would be nothing left to name; a successful release reports `null`, since naming a holder afterwards
  would read as the lease still being someone's. The field stays optional and absent is handled: the
  client says it could not act rather than guessing at a holder.
- **`GET /api/ob/agents/active`**: "should this Mac stay awake?" (098). It is the one agent read whose
  caller is a timer rather than a person, so a refusal there does not annoy anybody, it lets the machine
  sleep in the middle of a build. `active` is derived from the count **on the server**: Postgres returns
  `count()` as a string, and `"0"` is truthy while `"0" > 0` is false, so the same data decides the
  opposite way depending on which side does the arithmetic.

---

## SQLite → Postgres data move (323, retired 457)

Cutover happened. The `ob pg-export` command is gone (457): it was a loaded gun on a live DB.
The exporter internals (`src/pgexport.ts`) remain for history; there is no CLI entry.


## Forty-five commands are servable from Postgres; every other one REFUSES (337)

`apps/cli` was never in any phase of the migration map: phase 4 was scoped as "the files that open the
database OUTSIDE the CLI", so the largest consumer of all — ~265 synchronous `orm()` call sites — had no
phase. Until those are ported, an `ob` command run under `OMNISLASH_STORE=postgres` would open the SQLite
file and write to it while Postgres was authoritative. That is **two live stores**, the single rule the
whole phased migration is ordered around and the only failure that cannot be fixed forward: once both
copies have taken writes, neither one is the history any more.

So `openDb()` refuses in postgres mode, before the handle is opened, naming the command, the file it
declined to write, and the way back (`OMNISLASH_STORE=sqlite`). Two narrow exemptions exist for callers that
mean the SQLite **file** rather than "a database": `openStore({ kind: "sqlite" })` (which the ob 323
exporter needs in order to read the migration's source while the environment already says postgres) and
the replica's throwaway schema-fingerprint scratch file.

**This is what makes a partial port safe.** With it, whatever has been ported works and everything else
fails loudly and reversibly; without it, a partly-ported CLI cannot be cut over at all.

**State of the port.** Ported and **proven against a real embedded Postgres** (each runs the same
sequence on both engines and compares the results key by key, because every failure this phase risks is
silent rather than loud):

| module | what it is behind | proof |
|---|---|---|
| `items.ts`, `workflow.ts` | the item core: `ob add`/`next`/`show`/`list`, tags, links, details, triage, today-ranks, state moves | `test/pg-items-337.test.ts` |
| `config.ts`, `project.ts`, `tracker-link.ts` (link half) | `ob config`, `ob focus`, `ob project`, and the GitHub-issue link `ob show`/`ob close` read | `test/pg-cli-config-337.test.ts` |
| `lease.ts`, `agent.ts`, the spinoff QUEUE in `commands/spinoff.ts` | the coordination core: `ob lease`, `ob agent`, `ob agents`, and the queue half of `ob spinoff` (enqueue, claim, stamp, land, reclaim) | `test/pg-coord-337.test.ts`, and `test/pg-cli-coord-337.test.ts` end to end through `cli.ts` |
| the item-adjacent writes | `ob note`, `ob tag`, `ob untag`, `ob link` — the handlers were already routed through the store seam; every module behind them is ported | `test/cli-item-writes-337.test.ts` (they WRITE) + `test/pg-items-337.test.ts` (both engines agree) |
| `search.ts` | `ob search` — fts5 `MATCH` on SQLite, ob 322's tsquery translator + `pg_trgm` fallback on Postgres | `test/pg-search-337.test.ts` (one corpus, both engines) |
| `events.ts` (the `…For` half), `commands/log.ts` | `ob log` — the standup journal, as `source=journal` rows on the event store | `test/pg-journal-337.test.ts` |
| the spinoff COMMAND in `commands/spinoff.ts` | `ob spinoff` whole: enqueue, drain, reconcile, list, cleanup, brief and the 191 step commands | `test/pg-spinoff-337.test.ts` (one queue, both engines, drain to launch) |
| `commands/status.ts`, `commands/person.ts`'s handle lookup | `ob status` (agents, in-flight PRs, blocked, focus, journal, completed spinoffs) | `test/pg-status-337.test.ts` |
| `commands/brief.ts` | `ob brief <id>\|--in-flight` — the work-state read `/ob-slack-triage` is built on | `test/pg-brief-337.test.ts` (both forms, on Postgres only) |

**These commands are servable from Postgres today** — `cli.ts` opens the store for them rather than the
SQLite file:

```
add  agenda  agent  agents  alerts  backup  block  brief  cal  close  config  creds  daemon  db
decision  edit  focus  gmail  jobs  learning  lease  link  list  log  next  note
project  ready  reopen  rm  roadmap  search  secret  show  spinoff  start
state  status  tag  today  triage  unblock  untag  web  whatsapp
```

`spinoff` is the one whose failure would be **visible rather than logged**: it decides what to launch and
where, so an unported read at the cutover launches the wrong shape rather than printing a wrong number. It
carried the most *config* of any command — several `setting()` reads an earlier pass had deliberately left
synchronous (`spinoff_launcher`, `spinoff_launcher_by_repo`, `repo_checkouts` via `resolveRepo`).
A synchronous read is SQLite-only by construction, so under Postgres every one of
them would have answered from its **DEFAULT** — a repo routed elsewhere launched on the default launcher instead, the
grouping reverted — with nothing on stderr. That is the failure `test/pg-spinoff-337.test.ts` exists for:
every config row it seeds differs from its default, so a defaulted read changes the outcome and the test
says so; "it did not throw" would have passed on all of them.

`edit`, `rm`, `state` and `triage` needed no porting at all: they were routed through the store seam with
`items.ts` and `workflow.ts` and were simply never added to the list. `decision`, `learning` and `roadmap`
were the same, and `roadmap`'s member ordering already handles the NULLs split explicitly (it leads with
`position is null`, so an unpositioned member cannot jump to the top of the roadmap on Postgres).

`brief` did need it, and it is where the **missing** `ORDER BY` bit. Two of its reads — the epic member
list and the in-flight item list — had no ordering at all. SQLite answers those in rowid order; Postgres
answers them however its query optimiser likes, so the rendered list would have differed by engine and been
unstable between runs on the same one. Both are ordered by `item.id` asc now, a NOT NULL primary key. It
also collapsed two round-trip counts that were free against an in-process handle and are not against a
connection: the event table was re-read per filter pass (now once per brief), and the epic form asked
`ticketEpicFor` once per event row (now once per distinct ref, resolved before the filter runs).

`status` is the REPORTING read, and it is where the string-aggregate trap bites hardest: `count()` and
`sum()` come back from Postgres as strings, so an un-coerced gap count concatenates instead of adding and
a zero count is truthy. Every aggregate in it goes through `readNumber`, and `test/pg-status-337.test.ts`
asserts the values AND their `typeof` — including the zero case, which is the one where truthiness flips.
(The `report`/`metrics` half of that proof went with those commands in 1121.)

One sub-path inside it degrades LOUDLY rather than silently, because it needs a token from the unported
credential path in `net.ts`: `ob status`'s **wayfinder frontier** would otherwise just vanish, and an
absent frontier section reads exactly like an empty one. Under Postgres it prints the reason where the
section would have been, and `--json` carries the same string as `frontier_note`.
add  agent  agents  backup  block  close  config  daemon  db  focus  jobs  lease  link  list
log  next  note  project  ready  reopen  search  show  spinoff  start  tag  today  unblock  untag
```

**`backup`, `db`, `daemon` and `jobs` are the ob 326 preconditions.** `ob backup` and `ob db snapshot`
were the two commands whose whole job is to produce a second copy of the database, and both were written
against SQLite so completely that the engine was never named — `VACUUM INTO` has no Postgres form at all.
Left unported they would not have *failed*: `ob backup` would have kept running monthly, kept uploading a
release, kept exiting 0, and kept copying the file Postgres had replaced, and it would have been found the
way ob 237 was, at restore time. `daemon` turned out to be servable by construction (it touches no
database at all, with launchd plists (macOS) or systemd timers (Linux), `launchctl` or `systemctl --user`, and the filesystem), and `jobs` is what lets a cut-over `ob`
answer "is my ingestion alive".

`lease`, `agent` and `agents` are what make a cut-over tracker **workable** rather than merely readable:
without them no session could take a ticket, register itself or see who else was working, so two sessions
would have had nothing stopping them landing in the same worktree. **`spinoff` is what makes it usable**
— it is how every builder is launched, so without it a cut-over `ob` could take a ticket and never
dispatch one.

The list lives in `src/db/servable.ts` (`POSTGRES_SERVABLE_COMMANDS`), and **a command goes on it only
when every path it touches is ported**. "Mostly ported" is the failure the whole design exists to
prevent: a command that reads half its data from the wrong engine is worse than one that refuses,
because the refusal is reversible and a wrong answer that was acted on is not. `test/store-guard-337.test.ts`
holds the list honest in both directions.

Deliberately **absent**, and why:

- `linear`: `attachLinear` is ported, but the command mirrors onto the unported credential path the
  same way `ob add --issue` does.
- `issue`: `landed`, `list`, `link` and `unlink` are fully on the store, but `reconcile` and `drift`
  fetch the issue list through `readGithubToken`, which lives in the unported `net.ts`. One unported
  path is enough to keep the whole command off the list.
- `sync`: `syncLinear` and `syncGithub` are both ported, but it also calls `syncTicketEpics` and
  `syncEpicProgress`, and `epic.ts`'s WRITE half is not. Those sit in a `try/catch` that reports
  `epics: skipped`, so listing it would degrade the epic half *silently*.
- `person`, `standup`, `gap`, `epic-audit`, `scope-change`: each is now
  wholly or almost wholly on the store after branch K, but none of them was walked end to end for this
  change, and "almost" is what this list exists to refuse.

## The dashboard runs on Postgres, and it was DOWN until it did (337, branch K)

`ob web` refused under Postgres from the cutover until this change, and the `omnislash-web` launchd job (macOS) was
stopped so it would not fail every cycle. The dashboard is the surface the owner actually looks at, so this
is the most visible piece of the port and the one whose failure mode was the worst available.

**What it would have done instead of refusing.** `apps/dashboard/src/server/ob.ts` (outside this repo) opened its own
`bun:sqlite` handle per server function (`readonlyDb()` / `writableDb()` by path) and handed
`sqliteStoreFor(thatHandle)` to the handful of calls that had already been ported. That makes the file
COMPILE, and it makes every read come from the SQLite file — which is now a frozen copy nothing writes.
The page would have served, rendered and live-updated from data that stopped moving at the cutover, with
nothing thrown and nothing on stderr. A dashboard that is down gets fixed; a dashboard that is
confidently stale does not get noticed.

So the wrapper is gone and the server functions read through `getStore()`, the per-process singleton, so
the whole server process shares one connection pool (capped at 3, idle-out 30s; see the store seam above) rather than opening a handle per request. The
read-only / writable handle split went with it: it was a SQLite-*file* affordance (open the same file
twice, once refusing writes), and a pooled Postgres connection has no such shape.

**Twenty-four readers took a raw handle; they take a store now.** `commands/standup.ts` whole
(`standupSince`, `lastStandupAt`, `saveGenerated`, `setEdited`, `markPosted`, `getStandup`,
`latestStandup`, `listStandups`, `resolveSince`, `generateAndSave`), `commands/alerts.ts` whole
(`computeAlerts`, `filterSnoozed`, `snoozeAlert`), `commands/gaps.ts` whole, `detail.ts`'s `itemDetail`, `web-tls.ts`'s `webTlsPathsFor`,
and `realtime.ts` whole (`snapshotFrom`, the `/api/whatsapp` routes and the sidecar itself). `listScopeChanges` and its `…For` twin collapsed back into one name, and
`getPerson`/`listPersons` were replaced at the dashboard's call sites by the store forms that already
existed.

**Change detection in the realtime sidecar is a poll, not a file watch.** It used to be `fs.watch` on the
database file plus its `-wal`/`-shm`, which caught every out-of-process writer for free. Postgres has no
such file, and `fs.watch` on a path nothing writes never fires AND never errors — the dashboard would
have kept serving, kept its socket open and silently stopped live-updating, which nobody files as a bug.
The sidecar now re-reads the snapshot every `REALTIME_POLL_MS` (2s) and pushes only when the payload
actually differs, and only while a client is connected. LISTEN/NOTIFY is the obvious later refinement; it
is not what an unattended cutover should depend on.

**Every ordered column was checked against the NULLS split.** `standup.date` desc (the primary key),
`gap.(resolved, epic_ref, id)` asc (all NOT NULL, `id` breaking every tie; `resolved` is a plain integer
on both engines, so it stays 0/1 rather than becoming a boolean whose `"0"` reads as true),
`scope_change.(at, id)` desc, `epic_snapshot.snapshot_at` desc (NOT NULL, half the composite key) and
`event.(ts, id)` desc. None can meet the NULLS-FIRST-on-Postgres split. **Reads with no ordering at
all** were answered in rowid order by SQLite and in any order by Postgres; they are ordered by `item.id`
asc now, the same fix `ob brief` needed.

`alerts` joined the servable list in the same change: it is the CLI half of the dashboard's notification
centre, its count rides the dashboard's own snapshot, and every one of its eleven rules is on the store.
`filterSnoozed` now reads the whole (tiny) `alert_ack` table ONCE rather than issuing a query per
surfaced alert — free against an in-process handle, a round trip each against a connection.

**`ob search` is the one command where the two engines do not match the same rows, on purpose.** SQLite
searches the hand-maintained `item_fts` virtual table; Postgres searches the `search_vec` tsvector column
ob 322 declared `GENERATED ALWAYS ... STORED` on `item` itself, so there is nothing to sync there and no
`syncFts` drift to have. A comparison over 29 representative
queries found that **Postgres found MORE on 6 and less on none**, and `pg_trgm` carries three of those six. The
differences are structural — tsvector stems (`migration` finds "migrating" with no `*`), its parser keeps
an email address or a file path together as one lexeme where fts5's unicode61 splits on punctuation, and
it drops stopwords. The trigram clause runs **only when the word match returned nothing**, which is what
makes it purely additive: it can never displace or reorder a real word hit. This difference is 322's
accepted outcome, not a defect to reconcile away, and `test/pg-search-337.test.ts` pins it in the
direction that matters — nothing SQLite finds is lost. The ORDER of results does differ (fts5 rowid order
vs creation order), so a caller may rely on the set of ids and not the sequence.

Two known edges on commands that ARE servable, both loud rather than silent: `ob add --issue` creates a
GitHub issue through the unported credential path and needs a raw handle, so it throws naming the
command; and `ob close`/`ob reopen` mirror onto a linked GitHub issue through that same path, so the
LOCAL close happens and stands while the mirror reports the drift on stderr and exits 1 — the same
contract a GitHub outage already has.

**How `ob spinoff` was ported, and its three edges.** The blocker was never the queue (ported in pass 3)
but `settings.ts`'s synchronous `setting()`, which cannot follow `config.ts` async while ~90 unported call
sites through whatsapp, net, cert, credentials and the connectors sit in synchronous chains. So the
spinoff path follows the same precedent `settings.ts` and `events.ts` set: an async `…For` form **beside**
each synchronous one (`selectLauncherNameFor`, `rowLauncherNameFor`,
`launchNotReadyFor`, `spinoffTicketTagsFor`,
`resolveRepoFor`, `rowRepoPathFor`,
`epicColorFor`). Each pair shares **one pure decision function**, so the engines cannot answer the same
question differently and there is no second implementation to drift; only the read differs. The
synchronous forms stay for the callers that are *not* ported — the remote-dispatch argv rewrite is the
one left — each of which holds a raw handle postgres mode never issues it.

The three edges, all loud:

- **`ob spinoff watch` refuses by name.** Its trigger is `fs.watch` on the database *file*; a Postgres
  store has no file, so it would block forever and report nothing. Poll `ob spinoff list --status landed`
  instead, or run it with `OMNISLASH_STORE=sqlite`.
- **`ob spinoff #<n>`** fetches the GitHub issue through the unported credential path and needs a raw
  handle, so it throws naming the command — the same edge `ob add --issue` has. Every other ref shape
  (`ob 337`, `CUE-1234`) never reaches it.
- **The dispatch rewrite stays sqlite-only** and is unreachable under postgres: it runs only when a
  `remote_host` is configured, which is the replica/split path 337 already refuses outright.

## The connectors are Postgres-only, and the sync jobs are why (337, branch G)

The four sync jobs run as scheduled timers: `omnislash-sync` (`ob sync`), `omnislash-gmail-sync` (`ob gmail
sync`, every 5 min), `omnislash-cal-sync` (`ob cal sync`, every 15 min) and `omnislash-whatsapp-sync` (`ob
whatsapp sync`, every 60s). If a connector is not ported when the cutover happens, it does not degrade —
it REFUSES, and ingestion stops with nothing but failure tickets to show for it. So the connectors are
converted in place rather than kept dual-engine: they take a `Store`, they are async, and the SQLite
paths are gone.

Converted: `ingest/calendar.ts`, `ingest/gmail.ts`, `ingest/whatsapp.ts`, `ingest/github.ts`,
`syncLinear` in `ingest/linear.ts`, `secrets.ts`, `net.ts`, `google.ts`, `credentials.ts`, and the whole
of `whatsapp/` (bridge config, send, prefs, media, avatar, qr, transcribe, describe, suggest, converse).

**FTS5 IS DELETED FROM THE INGEST PATHS, not branched.** `email_fts`, `whatsapp_fts` and
`pr_comment_fts` were hand-maintained shadow tables — there are no triggers in this repo — so every
insert had to write a second row, and `foldLidChats` (ob 312) had to delete the shadow row BEFORE the row
it pointed at or leave an orphan that would surface a deleted message in search forever, against a rowid
a later message might reuse. ob 322 declared `search_vec` `GENERATED ALWAYS ... STORED` on
`email_message`, `whatsapp_message` and `pr_comment`, so the insert recomputes the index and the index
cannot outlive its row. A message can no longer be stored and left unsearchable, and the fold's ordering
hazard is gone rather than handled.

**Engine facts this branch actually hit**, all now checked rather than reasoned about:

- **Boolean flags.** `whatsapp_chat_pref.hidden`/`ai_disabled`/`favorite` were read as `!!row?.x` and
  `whatsapp_message.is_from_me` was tested for truthiness in five places (the feed row, the thread's
  "you" label, the rendered line's `fromMe`, the last-inbound scan that decides who a draft answers, and
  the outbound style samples). A driver that hands an integer back as a string makes `!!"0"` **true**,
  which hides nothing, favourites everything and mislabels every message — plausible-looking and silent.
  All of them go through `readBool` now. Predicates are `eq(col, 1)`, never `eq(col, true)`: against an
  int4 column that is an outright Postgres type error, not a wrong answer.
- **Ordered nullable columns.** Every ordering in these modules was checked against the schema rather
  than assumed. `whatsapp_message.ts` is NOT NULL, so its four DESC orderings cannot meet the
  NULLS-FIRST (Postgres) vs NULLS-LAST (SQLite) split. `email_message.ts` IS nullable, but its only
  writer derives it from `internalDateToIso`, which returns the epoch instant for a missing value and
  never null. `calendar_event.start_ts` IS nullable, but the agenda's `WHERE` bounds it on both sides and
  a NULL satisfies neither comparison. Every one of those orderings gained an `id` tiebreak so a
  pagination window cannot reshuffle between runs.
- **Numeric aggregates.** `max(ts)` in `latestPerChat` is over a TEXT column, so it needs no `readNumber`
  — that coercion is for numeric aggregates, and `Number()` on an ISO string gives NaN.
- **Discarded promises.** `HttpGoogleClient` now AWAITS its token `persist` (a database write on the
  store-backed sink) and `bridgeStatus` awaits `readToken` (a config lookup), both of which would
  otherwise have failed silently.

**Nothing about the secret store's cryptography moved.** Same AES-256-GCM, same master key from the
macOS Keychain or the 0600 file named by `$OMNISLASH_MASTER_KEY_FILE`, same `MasterKey` seam, same
`redactDetail` pass, same legacy `*_path` token-file fallbacks and their nudges. Only where the
ciphertext rows are read and written changed. No value is logged, printed or returned upward.

The connector tests run against a real embedded Postgres on the real migration chain via
`test/pg/store.ts` (`freshPgStore()`), which builds on ob 325's harness: a local cluster with **no TCP
listener at all**, so a test has no host on which it could reach the live database even deliberately.

**A replica-served read refuses too.** A client machine answers allowlisted reads from a local SQLite
**replica** of the server's SQLite database. That replica has no Postgres form and `openDb()`'s guard
cannot see it (the replica opens its own handle by its own path), so a client switched to postgres would
have carried on answering `ob next` from a copy of the engine the cutover had just left. `cli.ts` refuses
the `replica` and `split` modes under `OMNISLASH_STORE=postgres`, with the same way back.

**Several synchronous sqlite-only companions exist on purpose.** `setting()`/`settingNum()` in
`settings.ts` have ~90 call sites through whatsapp, net, cert, credentials, spinoff and the connectors,
none of them ported; `sqliteLinkedItems`/`sqliteItemForIssue`/`sqliteTrackerRepo` in `tracker-link.ts`
serve the synchronous git+spinoff "already on main?" path behind `ob issue landed`/`drift`;
and `recordEvent`/`eventsBetween`/`eventsForItem` in `events.ts` serve the unported event-store call sites
through the connectors, with `recordEventFor`/`eventsBetweenFor`/`eventsForItemFor` beside them
for ported callers. They read the same tables through a raw handle, and none of them can
answer from the wrong engine: in postgres mode an unported command never gets a handle at all. A ported
caller uses `settingFor()`/`settingNumFor()` and the async forms instead.

`listJournalSync` is **gone** — it had no callers left once the journal read went async through
`listJournal` (and `ob report --standup`, its last named one, was itself deleted in 1121).

Three differences worth knowing when porting the rest, all of which cost real debugging in ob 324:

| difference | what it does if missed | the fix |
|---|---|---|
| `sum()`/`count()`/`max()` come back as **strings** | `a + b` becomes string concatenation with no error (1000 + 2500 = `"10002500"`) | `readNumber` |
| flags are `0`/`1` integers, not booleans | `eq(col, false)` is an outright Postgres type error | `store.bool` / `readBool` |
| json columns are **text** | a parsed object is a string three frames from where it is used | `store.json` / `readJson` |
| `LIKE` is case-**insensitive** on SQLite and case-**sensitive** on Postgres | a pattern written in the case a human would write it matches zero rows, with no error | `likeCI` |

Plus two found by ob 337 itself: `IFNULL` is a SQLite builtin Postgres does not have (use `COALESCE`),
and a `DESC` ordering puts NULLs **first** on Postgres and **last** on SQLite, so an ordered nullable
column needs the null-ness ordered explicitly.

The `LIKE` one: SQLite's `LIKE` folds ASCII case and Postgres's does not, so a pattern written the way
a person writes a word matches on SQLite and matches nothing on Postgres. `likeCI(column, pattern)`
(exported from `src/db/orm.ts`) folds both sides with `lower()`, which is one expression valid in either
dialect and reproduces SQLite's ASCII folding. It gives up an index, which costs nothing on tables this size.

Two related differences that are **not** wrapped, and are worth knowing rather than fixing:

- **The LIKE escape character.** Postgres treats `\` in a pattern as an escape by default; SQLite treats
  it as a literal unless an `ESCAPE` clause says so. So escaping in a pattern, which never worked on
  SQLite, starts working on Postgres: a `%` escaped with `\\` now matches a literal `%`.
- **Text collation.** SQLite orders `TEXT` by `BINARY` (byte order: every upper-case letter before every
  lower-case one); Postgres orders by the database's collation. The ob 325 test cluster is `initdb`'d
  `--locale=C`, so the harness matches SQLite exactly and **cannot** catch a difference here. If the live
  cluster was created with a UTF-8 locale, name sorts would order `apple` before `Zebra` where SQLite ordered `Zebra` first. The check
  is one query if it is ever in doubt:
  `SELECT datcollate FROM pg_database WHERE datname = current_database()`.

**One code path, two engines.** `q` and `t` are TYPED against the SQLite modules and hold the pg-core
objects at runtime, which is only sound because ob 321 kept the names identical —
`test/pg-store-324.test.ts` asserts that table-for-table and column-for-column, so drift fails a test
rather than a query. Three things do differ between the engines, all of them silent rather than loud, and
all of them go through helpers:

- **`.all()` / `.get()` / `.run()` do not exist on pg-core.** Every ported consumer awaits its builder
  instead (drizzle's bun-sqlite builders are thenable, so awaiting is correct on both). The same test
  scans the ported files and fails if a terminator comes back.
- **0/1 flags are not booleans.** Flag columns are `integer` columns on both
  engines (ob 321's mechanical-port rule); `eq(col, false)` is an outright Postgres type error and a row
  read back carries `0`/`1`. Write with `store.bool(v)`, read with `readBool(v)`.
- **JSON stored in text columns comes back as text.** Postgres returns the raw string. Write with `store.json(v)`, read with
  `readJson(v)`.
- **`sum()` and `count()` come back from Postgres as STRINGS.** Un-coerced, adding two balances
  concatenates them: 1000 and 2500 become `"10002500"`. Every aggregate goes through `readNumber(v)`.

`sqliteStoreFor(db)` wraps an already-open handle for code that still holds one (apps/cli's commands, the
test helpers); `commandStore(db)` is the CLI's version, which wraps the handle in sqlite mode and returns
the configured Postgres store after the cutover.

- **`LIKE` is case-sensitive.** See the table above. Match descriptions with `likeCI(col, pattern)`.

Verified against a throwaway **PostgreSQL 17.11** — the version the server runs, which closes the caveat
ob 321 carried forward from having only been checked against 16 — by running the ported consumers against
both engines and diffing 32 results, including the dashboard sections and the flags.

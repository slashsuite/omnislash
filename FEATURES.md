# OmniSlash features

Checked against main at 2cd30da on 2026-11-20.

This is the full list of what OmniSlash does today, read from the source. The short list of claims is in
[`FACTS.md`](FACTS.md); the command reference with every flag is in [`apps/cli/README.md`](apps/cli/README.md).

## Capture and edit
- `ob-add`: Create a work item with a title, type, kind, project, priority, body, tags and links, or a roadmap, decision or learning entry. How to reach it: `ob add <title>`. Source: `apps/cli/src/commands/capture.ts`.
- `ob-triage`: List the triage inbox, the items still waiting for a priority, newest first, and clear an item's triage flag or reject (close) it. How to reach it: `ob triage`, `ob triage clear|reject <id>`. Source: `apps/cli/src/commands/triage.ts`.
- `ob-edit`: Change an item's title, body, priority or project. How to reach it: `ob edit <id>`. Source: `apps/cli/src/commands/capture.ts`.
- `ob-note`: Append a note to an item. How to reach it: `ob note <id> <text>`. Source: `apps/cli/src/commands/capture.ts`.
- `ob-log`: Write a standup journal entry (kudos, suggestion or comment) and list past entries. How to reach it: `ob log <kudos|suggestion|comment> "<text>"`, `ob log list`. Source: `apps/cli/src/commands/log.ts`.
- `ob-tag`: Add work-classification tags to an item. How to reach it: `ob tag <id> <tag>...`. Source: `apps/cli/src/commands/capture.ts`.
- `ob-untag`: Remove tags from an item. How to reach it: `ob untag <id> <tag>...`. Source: `apps/cli/src/commands/capture.ts`.
- `ob-link`: Link two items as roadmap member, spun off from, references, blocks or supersedes. How to reach it: `ob link <id> <rel> <other>`. Source: `apps/cli/src/commands/capture.ts`.
- `ob-rm`: Delete an item from the tracker (a linked GitHub issue is left as it is). How to reach it: `ob rm <id>`. Source: `apps/cli/src/commands/capture.ts`.

## GitHub issue pairing
- `ob-issue`: Keep items and GitHub issues paired: list the pairs, link or unlink an item and an issue, check whether an item's work is already on main (`landed`), and find likely unlinked pairs (`reconcile`) and drift either way (`drift`). How to reach it: `ob issue [list]`, `ob issue link|unlink|landed|reconcile|drift`. Source: `apps/cli/src/commands/issue.ts`.

## Workflow
- `ob-start`: Mark an item started. How to reach it: `ob start <id>`. Source: `apps/cli/src/commands/state.ts`.
- `ob-ready`: Mark an item ready. How to reach it: `ob ready <id>`. Source: `apps/cli/src/commands/state.ts`.
- `ob-block`: Mark an item blocked, with a reason and an owner. How to reach it: `ob block <id> --reason <r>`. Source: `apps/cli/src/commands/state.ts`.
- `ob-unblock`: Clear an item's block. How to reach it: `ob unblock <id>`. Source: `apps/cli/src/commands/state.ts`.
- `ob-close`: Close an item, closing its linked GitHub issue too. How to reach it: `ob close <id>`. Source: `apps/cli/src/commands/state.ts`.
- `ob-reopen`: Reopen an item, reopening its linked GitHub issue too. How to reach it: `ob reopen <id>`. Source: `apps/cli/src/commands/state.ts`.
- `ob-state`: Move an item to any state its type allows, through the same steps as the named commands. How to reach it: `ob state <id> <state>`. Source: `apps/cli/src/commands/state.ts`.

## Query
- `ob-next`: Show today's focus in priority order, or one project's queue, with `critical` work only while weekly Claude usage is at 95% or more. How to reach it: `ob next [--project <p>]`. Source: `apps/cli/src/commands/query.ts`.
- `ob-status`: Show a snapshot of now: agents, T3 Code threads, pull requests in flight, blocked items, the live deploy, focus and journal. How to reach it: `ob status`. Source: `apps/cli/src/commands/status.ts`.
- `ob-list`: List items filtered by state, kind, project, team, priority, type and tag. How to reach it: `ob list`. Source: `apps/cli/src/commands/query.ts`.
- `ob-show`: Show one item in full, with its trail of status changes. How to reach it: `ob show <id>`. Source: `apps/cli/src/commands/query.ts`.
- `ob-brief`: Show an item's work state (status, links, recent activity), or everything in flight. How to reach it: `ob brief <id>`, `ob brief --in-flight`. Source: `apps/cli/src/commands/brief.ts`.
- `ob-search`: Full-text search over item titles and bodies. How to reach it: `ob search <query>`. Source: `apps/cli/src/commands/query.ts`.
- `ob-today`: Put an item on the Today list at a rank, or clear the list. How to reach it: `ob today <id> [--rank N]`, `ob today --clear`. Source: `apps/cli/src/commands/focus.ts`.
- `ob-order`: Place an open item in its project's queue: at the top, or before or after another item. How to reach it: `ob order <ref> --top|--before <ref>|--after <ref>`. Source: `apps/cli/src/commands/focus.ts`.
- `ob-focus`: Set or clear the project in focus. How to reach it: `ob focus <project>`, `ob focus --clear`. Source: `apps/cli/src/commands/focus.ts`.

## Measurement
- `ob-sync`: Ingest GitHub pull request data into the event store. How to reach it: `ob sync [--source github]`. Source: `apps/cli/src/commands/sync.ts`.
- `ob-slack`: Read Slack messages ingested in the past (read only). How to reach it: `ob slack unread`. Source: `apps/cli/src/commands/slack.ts`.
- `ob-alerts`: List active alerts, print the morning digest and optionally push it as a notification, and snooze an alert. How to reach it: `ob alerts [--digest [--notify]]`, `ob alerts snooze <key>`. Source: `apps/cli/src/commands/alerts.ts`.
- `ob-jobs`: Show the health of each background job (state, last success, failure streak, last error), and the jobs the API host ran for a client. How to reach it: `ob jobs`, `ob jobs host [<id> | fetch <id>]`. Source: `apps/cli/src/commands/jobs.ts`.
- `ob-ci`: Show each project's latest completed CI run on main, one line per workflow, and optionally notify about red runs. How to reach it: `ob ci main`. Source: `apps/cli/src/commands/ci.ts`.
- `ob-github`: Check, and with `--yes` create or fix, each project's GitHub webhook. How to reach it: `ob github hooks`. Source: `apps/cli/src/commands/ci.ts`.

## Coordination
- `ob-lease`: Acquire, heartbeat, release and list time-limited resource leases, and run a command while holding one. How to reach it: `ob lease acquire|run|heartbeat|release|status`. Source: `platform/cli-coord/src/commands/coord.ts`.
- `ob-ports`: Show the LAN dev-port range and each port's state, and claim the lowest free port. How to reach it: `ob ports`, `ob ports next`. Source: `apps/cli/src/ports.ts`.
- `ob-agent`: Register an agent with its ticket, worktree, branch, status and note, keep it alive with heartbeats, and mark it done, releasing the leases it took. How to reach it: `ob agent register`, `ob agent heartbeat <id>`, `ob agent done <id>`. Source: `platform/cli-coord/src/commands/coord.ts`.
- `ob-agents`: Show who is working on what now, or wipe the registry and release every lease. How to reach it: `ob agents`, `ob agents reset`. Source: `platform/cli-coord/src/commands/coord.ts`.
- `ob-spinoff`: Dispatch a ticket to a builder in its own git worktree as a T3 Code thread, and manage the launch queue: `queue`, `drain`, `reconcile`, `watch`, `abandon`, `show`, `list`, `check`, `brief`, `cleanup`, `claim`, `stamp`, `land`, `tokens backfill`, `reclaim`, `state`, `handoff`, `ready`, `sendback`, `reopen`, `gateable`, `trial` and `mix`. How to reach it: `ob spinoff <ticket>`, `ob spinoff <subcommand>`. Source: `platform/cli-coord/src/commands/spinoff.ts`.
- `ob-standup`: Save, edit, read and mark posted the daily standup. How to reach it: `ob standup save|set|latest|posted`. Source: `apps/cli/src/commands/standup.ts`.
- `ob-web`: Build and serve the dashboard, or another app in the repo. How to reach it: `ob web`. Source: `apps/cli/src/commands/web.ts`.
- `ob-cert`: Show and renew the LAN TLS certificate the dashboard serves, issued by Let's Encrypt over a DNS challenge. How to reach it: `ob cert status|renew`. Source: `apps/cli/src/commands/cert.ts`.
- `ob-daemon`: Install, remove and check the background client job on macOS launchd or Linux systemd. How to reach it: `ob daemon install|uninstall|status`. Source: `platform/cli-coord/src/commands/coord.ts`.
- `ob-deploy`: Show and record what is deployed per target, and run a deploy. How to reach it: `ob deploy status|record|run`. Source: `apps/cli/src/commands/deploy.ts`.
- `ob-vision`: Compare two screenshots (or a before and after pair in light and dark) against each other or a design. How to reach it: `ob vision compare <left> <right>`. Source: `apps/cli/src/commands/vision.ts`.

## T3 Code
- `ob-t3`: Work with T3 Code: check the connection (`doctor`, `status`), store a credential (`login`), manage teams and their role handoffs and restarts (`team add|edit|join|leave|list|show|rm|handoff|restart`), bind a team's architect, sentinel and muse threads (`architect`, `sentinel`, `muse`), message every architect or thread (`broadcast`), and read projects, the thread tree and a ticket's thread link (`projects`, `tree`, `open`). How to reach it: `ob t3 <subcommand>`. Source: `apps/cli/src/commands/t3.ts`.
- `ob-role`: Keep one run per team role (architect, sentinel, muse): start it, read its status and start brief, leave a note for the next run, end it, and run the periodic role check. How to reach it: `ob role start|status|end|brief|note|tick`. Source: `apps/cli/src/commands/role.ts`.
- `ob-send`: Store a message for a team role and deliver it into that role's thread. How to reach it: `ob send <team> <role> "<text>"`. Source: `apps/cli/src/commands/inbox.ts`.
- `ob-inbox`: List a team role's unread messages, or every message, and mark them read. How to reach it: `ob inbox <team> <role>`. Source: `apps/cli/src/commands/inbox.ts`.

## Sources: Gmail, Calendar and WhatsApp
- `ob-google`: Authorise Google access on this machine, or print a hosted authorise URL. How to reach it: `ob google auth`, `ob google auth-url`. Source: `platform/cli-sources/src/commands/google.ts`.
- `ob-gmail`: Sync, search, list and read email and attachments, and create, list, edit, delete and send drafts (nothing is sent without an explicit confirm). How to reach it: `ob gmail sync|search|list|read|attachment|draft|drafts|draft-edit|draft-delete|send-draft`. Source: `platform/cli-sources/src/commands/gmail.ts`.
- `ob-cal`: Sync Google Calendar and show today's events. How to reach it: `ob cal sync`, `ob cal agenda`. Source: `platform/cli-sources/src/commands/calendar.ts`.
- `ob-agenda`: Show today's calendar events. How to reach it: `ob agenda`. Source: `platform/cli-sources/src/commands/calendar.ts`.
- `ob-whatsapp`: Sync, search and list WhatsApp messages, send a message through the local bridge, manage the bridge, set a bio used in suggested replies, and hide, show, favourite or turn off suggested replies per chat. How to reach it: `ob whatsapp sync|search|recent|send|bridge|bio|hide|show|ai-off|ai-on|favorite|unfavorite`. Source: `platform/cli-whatsapp/src/commands/whatsapp.ts`.

## Entities
- `ob-memory`: Append a fact to this machine's memory file, or print it. How to reach it: `ob memory add "<fact>"`, `ob memory show`. Source: `apps/cli/src/commands/memory.ts`.
- `ob-roadmap`: List roadmaps with progress, or show one. How to reach it: `ob roadmap [list | <id>]`. Source: `apps/cli/src/commands/roadmap.ts`.
- `ob-decision`: List decisions, show one, or supersede one with another. How to reach it: `ob decision [list | <id> | supersede <new> <old>]`. Source: `apps/cli/src/commands/decision.ts`.
- `ob-doc`: Keep reference documents per project: list, add, show (with earlier versions), history and set. How to reach it: `ob doc list|add|show|history|set`. Source: `apps/cli/src/commands/doc.ts`.
- `ob-learning`: List learning items, or show one. How to reach it: `ob learning [list | <id>]`. Source: `apps/cli/src/commands/learning.ts`.
- `ob-review-miss`: Record what a code review missed, by class, and rank the classes. How to reach it: `ob review-miss add`, `ob review-miss top`. Source: `apps/cli/src/commands/reviewmiss.ts`.
- `ob-review`: Show and set the skeptical-review readers and their models per complexity range (1-10). How to reach it: `ob review readers [--complexity <n>] [set|rm|range]`. Source: `apps/cli/src/commands/review.ts`.
- `ob-test-user`: Keep a registry of test accounts with their secrets in the encrypted store: add, list, show and check. How to reach it: `ob test-user add|list|show|check`. Source: `apps/cli/src/commands/testuser.ts`.

## People
- `ob-person`: Keep a registry of people with their handles and contact details: add, set, list, show and remove. How to reach it: `ob person add|set|list|show|rm`. Source: `apps/cli/src/commands/person.ts`.
- `ob-whois`: Resolve a GitHub, Linear or Slack handle, or an email, to a person. How to reach it: `ob whois <handle>`. Source: `apps/cli/src/commands/person.ts`.
- `ob-tournament`: Run a persona tournament between candidates: start it, add candidates, record matches, pick a winner, list and show. How to reach it: `ob tournament add|candidate|record|pick|list|show`. Source: `apps/cli/src/commands/tournament.ts`.
- `ob-overnight`: Keep an overnight decision log: start a night, record decisions and summary lines, show a night and list past runs. How to reach it: `ob overnight start|decide|summary|show|list`. Source: `apps/cli/src/commands/overnight.ts`.

## Admin
- `ob-project`: Register, list, edit, rename and remove projects, print a project's agent rules, and install its architect wiring. How to reach it: `ob project add|list|edit|rename|rm|rules|wire`. Source: `apps/cli/src/commands/admin.ts`.
- `ob-wiki`: Read and refresh the project wiki, check it for stale pages, and read and add to the incident log. How to reach it: `ob wiki [list | <name> | refresh | check | incidents | log]`. Source: `apps/cli/src/commands/wiki.ts`.
- `ob-cursor`: Read and set a skill's saved cursor value. How to reach it: `ob cursor get|set`. Source: `apps/cli/src/commands/admin.ts`.
- `ob-config`: Read and set config values. How to reach it: `ob config [get <k> | set <k> <v>]`. Source: `apps/cli/src/commands/admin.ts`.
- `ob-secret`: Store, read, list, remove and import secrets in an encrypted store (AES-256-GCM). How to reach it: `ob secret set|get|list|rm|import`. Source: `apps/cli/src/commands/secret.ts`.
- `ob-creds`: List every credential OmniSlash depends on, with presence, last check and how to refresh it, and run a live check. How to reach it: `ob creds`, `ob creds check <name> | --all`. Source: `apps/cli/src/commands/creds.ts`.
- `ob-usage`: Show where the Claude tokens went over a day, from this machine's transcripts, and compare days. How to reach it: `ob usage day`. Source: `apps/cli/src/commands/usage.ts`.
- `ob-models`: Show and switch which model runs what, from one machine file of profiles, and report the review legs. How to reach it: `ob models [show|list|use <profile>|init|legs]`. Source: `apps/cli/src/commands/models.ts`.
- `ob-cloudflare`: List Cloudflare zones and tunnel connector versions, and list, add and remove DNS records. How to reach it: `ob cloudflare zones|tunnels|dns list|dns add|dns rm`. Source: `apps/cli/src/commands/cloudflare.ts`.
- `ob-backup`: Back the database up off the machine to a private GitHub release, keeping 12 months. How to reach it: `ob backup`. Source: `apps/cli/src/commands/db.ts`.
- `ob-db`: Take and list local point-in-time database snapshots, back up, and fetch a snapshot from the API host. How to reach it: `ob db snapshot|backup|fetch`. Source: `apps/cli/src/commands/db.ts`.

## API
All routes are served under the prefix `/api/ob`.
- `api-health`: Check that the server is up and which store it uses. How to reach it: `GET /health`. Source: `apps/cli/src/api/contract.ts`.
- `api-next`: Read the worklist, the same list `ob next` prints. How to reach it: `GET /next`. Source: `apps/cli/src/api/contract.ts`.
- `api-items`: Query, create, read, edit, delete and move work items, including notes, tags, links, state changes, Today rank and queue order. How to reach it: `GET /items`, `POST /items`, `GET /items/:id`, `POST /items/:id/close`, `POST /items/:id/reopen`, `POST /items/:id/state`, `POST /items/:id/transition`, `POST /items/:id/rank`, `POST /items/:id/order`, `POST /items/:id/notes`, `POST /items/:id/tags`, `POST /items/:id/links`, `POST /items/:id/edit`, `DELETE /items/:id`. Source: `apps/cli/src/api/contract.ts`.
- `api-snapshot`: Read the dashboard's full snapshot in one call: status, Today list, standup, launches, agents, WhatsApp feed and alert count. How to reach it: `GET /snapshot`. Source: `apps/cli/src/api/contract.ts`.
- `api-today`: Set or clear an item's Today rank. How to reach it: `POST /today`. Source: `apps/cli/src/api/contract.ts`.
- `api-focus`: Read, set or clear the focus project. How to reach it: `GET /focus`, `POST /focus`. Source: `apps/cli/src/api/contract.ts`.
- `api-search`: Full-text search over items. How to reach it: `GET /search`. Source: `apps/cli/src/api/contract.ts`.
- `api-status`: Read the status rollup. How to reach it: `GET /status`. Source: `apps/cli/src/api/contract.ts`.
- `api-agents`: Read the agent registry, register or heartbeat an agent, wipe the registry, and ask whether any agent was active recently. How to reach it: `GET /agents`, `POST /agents`, `POST /agents/reset`, `GET /agents/active`. Source: `apps/cli/src/api/contract.ts`.
- `api-leases`: List, acquire, heartbeat, sweep and release resource leases. How to reach it: `GET /leases`, `POST /leases`, `POST /leases/sweep`, `DELETE /leases/:resource`. Source: `apps/cli/src/api/contract.ts`.
- `api-secrets`: List stored secret names and ages, and read, store or remove one secret. How to reach it: `GET /secrets`, `POST /secrets/read`, `POST /secrets`, `POST /secrets/remove`. Source: `apps/cli/src/api/contract.ts`.
- `api-creds`: Read the credential inventory and run a credential's live check. How to reach it: `GET /creds`, `POST /creds/check`. Source: `apps/cli/src/api/contract.ts`.
- `api-spinoffs`: Drive the launch queue: list, enqueue, claim, stamp, check, hand off, send back, reopen, land and clean up builder launches. How to reach it: `GET /spinoffs`, `POST /spinoffs`, `POST /spinoffs/check`, `POST /spinoffs/planned-files`, `POST /spinoffs/serving`, `GET /spinoffs/config`, `POST /spinoffs/launchable`, `POST /spinoffs/claim`, `POST /spinoffs/stamp`, `POST /spinoffs/land`, `POST /spinoffs/tokens`, `POST /spinoffs/ready`, `POST /spinoffs/sendback`, `POST /spinoffs/reopen`, `POST /spinoffs/note-error`, `POST /spinoffs/verdict`, `POST /spinoffs/trial`, `POST /spinoffs/reclaim`, `POST /spinoffs/cleanup-guard`. Source: `apps/cli/src/api/contract.ts`.
- `api-config`: Read the config table and set or unset one value. How to reach it: `GET /config`, `POST /config`. Source: `apps/cli/src/api/contract.ts`.
- `api-issues`: Read and change the pairing between items and GitHub issues, and find pairs that look unlinked. How to reach it: `GET /issues`, `POST /issues/link`, `POST /issues/unlink`, `GET /issues/pairing`, `GET /issues/github`, `GET /issues/reconcile`. Source: `apps/cli/src/api/contract.ts`.
- `api-triage`: Read the triage inbox and clear or reject an item in it. How to reach it: `GET /triage`, `POST /triage/:id/clear`, `POST /triage/:id/reject`. Source: `apps/cli/src/api/contract.ts`.
- `api-whatsapp`: Search and list ingested WhatsApp messages, read the chat list and Status tray, set per-chat preferences, and send a confirmed message. How to reach it: `GET /whatsapp/search`, `GET /whatsapp/recent`, `POST /whatsapp/send`, `POST /whatsapp/prefs`, `GET /whatsapp/prefs/hidden`, `GET /whatsapp/prefs/favorites`, `GET /whatsapp/status`, `GET /whatsapp/chats`. Source: `apps/cli/src/api/contract.ts`.
- `api-gmail`: Search, list, sync and read ingested email and attachments, and create, list, edit, delete and send Gmail drafts (sending needs an explicit confirm). How to reach it: `GET /gmail/search`, `GET /gmail/list`, `POST /gmail/sync`, `GET /gmail/messages/:id`, `GET /gmail/messages/:id/attachments`, `POST /gmail/drafts`, `GET /gmail/drafts`, `GET /gmail/drafts/:id`, `POST /gmail/drafts/:id/edit`, `DELETE /gmail/drafts/:id`, `POST /gmail/drafts/:id/send`. Source: `apps/cli/src/api/contract.ts`.
- `api-cal`: Read today's calendar events and sync Google Calendar. How to reach it: `GET /cal/agenda`, `POST /cal/sync`. Source: `apps/cli/src/api/contract.ts`.
- `api-google`: Run the Google OAuth flow from a browser: mint an authorize URL, redirect to consent and store the result. How to reach it: `GET /google/auth`, `GET /google/callback`, `POST /google/auth-url`. Source: `apps/cli/src/api/contract.ts`.
- `api-projects`: List, register, edit and remove projects. How to reach it: `GET /projects`, `POST /projects`, `POST /projects/:name/edit`, `DELETE /projects/:name`. Source: `apps/cli/src/api/contract.ts`.
- `api-teams`: Manage teams and their members, role runs, handoffs, successor notes, role inboxes, start briefs and the role tick. How to reach it: `GET /teams`, `POST /teams`, `POST /teams/leave`, `GET /teams/:name`, `POST /teams/:name/edit`, `POST /teams/:name/join`, `DELETE /teams/:name`, `POST /teams/:name/handoffs`, `GET /teams/:name/handoffs/latest`, `POST /teams/:name/handoffs/:id/consume`, `GET /teams/:name/runs`, `POST /teams/:name/runs`, `POST /teams/:name/runs/:id`, `GET /teams/:name/tick`, `GET /teams/:name/brief`, `POST /teams/:name/notes`, `POST /teams/:name/runs/:id/note-shown`, `POST /teams/:name/inbox`, `GET /teams/:name/inbox`, `POST /teams/:name/inbox/read`. Source: `apps/cli/src/api/contract.ts`.
- `api-brief`: Read the work-state brief of an item, or of everything in flight. How to reach it: `GET /brief`. Source: `apps/cli/src/api/contract.ts`.
- `api-log`: Read and capture standup journal entries. How to reach it: `GET /log`, `POST /log`. Source: `apps/cli/src/api/contract.ts`.
- `api-jobs`: Read the health of each declared background job. How to reach it: `GET /jobs`. Source: `apps/cli/src/api/contract.ts`.
- `api-deploys`: Start a live deploy, optionally pinned to a commit. How to reach it: `POST /deploys/run`. Source: `apps/cli/src/api/contract.ts`.
- `api-alerts`: Read active alerts and snooze or acknowledge one. How to reach it: `GET /alerts`, `POST /alerts/snooze`, `POST /alerts/ack`. Source: `apps/cli/src/api/contract.ts`.
- `api-decisions`: List decisions, read one with its chain, and supersede one with another. How to reach it: `GET /decisions`, `GET /decisions/:id`, `POST /decisions/supersede`. Source: `apps/cli/src/api/contract.ts`.
- `api-docs`: List, create, read and replace reference documents, keeping earlier versions. How to reach it: `GET /docs`, `POST /docs`, `GET /docs/:id`, `POST /docs/:id/set`. Source: `apps/cli/src/api/contract.ts`.
- `api-learnings`: List learning items and read one. How to reach it: `GET /learnings`, `GET /learnings/:id`. Source: `apps/cli/src/api/contract.ts`.
- `api-roadmaps`: List roadmaps with progress, read one with its members, and add a member. How to reach it: `GET /roadmaps`, `GET /roadmaps/:id`, `POST /roadmaps/:id/members`. Source: `apps/cli/src/api/contract.ts`.
- `api-standup`: Read the newest standup, save generated or edited standup text, and mark it posted. How to reach it: `GET /standup/latest`, `POST /standup/save`, `POST /standup/set`, `POST /standup/posted`. Source: `apps/cli/src/api/contract.ts`.
- `api-slack`: Read Slack messages ingested in the past. How to reach it: `GET /slack/unread`. Source: `apps/cli/src/api/contract.ts`.
- `api-people`: List, register, read, update and delete people. How to reach it: `GET /people`, `POST /people`, `GET /people/show`, `POST /people/set`, `POST /people/rm`. Source: `apps/cli/src/api/contract.ts`.
- `api-whois`: Resolve a handle or email to a person. How to reach it: `GET /whois`. Source: `apps/cli/src/api/contract.ts`.
- `api-host-jobs`: Start a job on the API host and read recent jobs or one job's result. How to reach it: `POST /host-jobs`, `GET /host-jobs`, `GET /host-jobs/:id`. Source: `apps/cli/src/api/contract.ts`.
- `api-db-snapshots`: Download one database snapshot from the host's history. How to reach it: `GET /db/snapshots/:name`. Source: `apps/cli/src/api/contract.ts`.
- `api-tournaments`: List, start and read tournaments, and record candidates, matches and the pick. How to reach it: `GET /tournaments`, `POST /tournaments`, `GET /tournaments/:id`, `POST /tournaments/:id/candidates`, `POST /tournaments/:id/matches`, `POST /tournaments/:id/pick`. Source: `apps/cli/src/api/contract.ts`.
- `api-github`: Receive GitHub webhooks, and check or fix each project's webhook. How to reach it: `POST /github/webhook`, `GET /github/hooks`, `POST /github/hooks`. Source: `apps/cli/src/api/contract.ts`.
- `api-ci`: Read each project's latest CI run on main, and send notices for red runs and recoveries. How to reach it: `GET /ci/main`, `POST /ci/main/notify`. Source: `apps/cli/src/api/contract.ts`.
- `api-overnight`: Keep the overnight decision log: start a night, record decisions and summary lines, and read a night or the list of runs. How to reach it: `POST /overnight/start`, `POST /overnight/decide`, `POST /overnight/summary`, `POST /overnight/show`, `GET /overnight/runs`. Source: `apps/cli/src/api/contract.ts`.
- `api-review-misses`: Record a review-miss class and read the ranked classes. How to reach it: `POST /review-misses`, `GET /review-misses/top`. Source: `apps/cli/src/api/contract.ts`.
- `api-cursors`: Read and set a skill cursor value. How to reach it: `GET /cursors`, `POST /cursors`. Source: `apps/cli/src/api/contract.ts`.
- `api-test-users`: List, register, read and check test accounts. How to reach it: `GET /test-users`, `POST /test-users`, `GET /test-users/show`, `POST /test-users/check`. Source: `apps/cli/src/api/contract.ts`.
- `api-sync`: Run the GitHub ingest on the API host. How to reach it: `POST /sync`. Source: `apps/cli/src/api/contract.ts`.

## Dashboard
- `dashboard-home`: The dashboard's home page, with the OB header; for now it only says the dashboard pages are moving here. How to reach it: `/`. Source: `apps/ob-dashboard/src/routes/index.tsx`.
- `dashboard-alerts`: The alert centre: every active alert grouped by rule, each with Ack and Snooze buttons, kept live as the data changes. How to reach it: `/alerts`. Source: `apps/ob-dashboard/src/routes/alerts.tsx`.
- `dashboard-tokens`: Every credential OmniSlash depends on, with whether it is present, a Check now button, a write-only box to paste a new value, how to refresh it, and the WhatsApp pairing QR. How to reach it: `/tokens`. Source: `apps/ob-dashboard/src/routes/tokens.tsx`.

## Agent skills
- `skill-ob-architect`: Primes a thread as its team's architect, which plans, dispatches every build with `ob spinoff`, and gates and merges the pull requests. How to reach it: the `ob-architect` skill. Source: `skills/ob-architect/SKILL.md`.
- `skill-ob-ask-one-by-one`: Puts every question or decision to the owner through the question tool, one question at a time. How to reach it: the `ob-ask-one-by-one` skill. Source: `skills/ob-ask-one-by-one/SKILL.md`.
- `skill-ob-babysit-pr`: Watches a pull request after its builder hands it off, until it is gated and merged. How to reach it: the `ob-babysit-pr` skill. Source: `skills/ob-babysit-pr/SKILL.md`.
- `skill-ob-cli`: Loads the live `ob` command surface, grouped by section, and the conventions for running it. How to reach it: the `ob-cli` skill. Source: `skills/ob-cli/SKILL.md`.
- `skill-ob-going-to-bed`: Works the whole buildable queue overnight without the owner, logging each key decision for the morning. How to reach it: the `ob-going-to-bed` skill. Source: `skills/ob-going-to-bed/SKILL.md`.
- `skill-ob-good-morning`: Gathers what each architect shipped and left for the owner, shows a short digest, and walks every open item one question at a time. How to reach it: the `ob-good-morning` skill. Source: `skills/ob-good-morning/SKILL.md`.
- `skill-ob-good-night`: Ends the working day: stops builders after a checkpoint, tells every role thread to stop, pauses their watchdogs, and locks work until 07:00. How to reach it: the `ob-good-night` skill. Source: `skills/ob-good-night/SKILL.md`.
- `skill-ob-land`: Lands a ticket through its GitHub pull request: the builder rebases, gates, pushes and opens it; another role gates and merges it. How to reach it: the `ob-land` skill. Source: `skills/ob-land/SKILL.md`.
- `skill-ob-leaving-pr-comments`: Leaves a GitHub comment on the owner's behalf only after the owner confirms the exact text. How to reach it: the `ob-leaving-pr-comments` skill. Source: `skills/ob-leaving-pr-comments/SKILL.md`.
- `skill-ob-live-proof-local-tracker`: Runs a real end-to-end proof of an `ob` command without writing to the live tracker. How to reach it: the `ob-live-proof-local-tracker` skill. Source: `skills/ob-live-proof-local-tracker/SKILL.md`.
- `skill-ob-marketing-copy`: Writes or changes marketing site copy: facts first, an approved outline, several drafts, a persona knockout and the owner's pick. How to reach it: the `ob-marketing-copy` skill. Source: `skills/ob-marketing-copy/SKILL.md`.
- `skill-ob-muse`: Primes a thread as a team's muse, which explores the owner's thinking and hands the architect a design once confirmed. How to reach it: the `ob-muse` skill. Source: `skills/ob-muse/SKILL.md`.
- `skill-ob-new-project`: Scaffolds a new project on the standard stack, creates its private GitHub repo after confirmation, and registers it with `ob project add`. How to reach it: the `ob-new-project` skill. Source: `skills/ob-new-project/SKILL.md`.
- `skill-ob-new-ticket-implement`: Creates a ticket, a git worktree for it, and hands it to `ob spinoff` in one step, or carves follow-up work off a ticket the same way. How to reach it: the `ob-new-ticket-implement` skill. Source: `skills/ob-new-ticket-implement/SKILL.md`.
- `skill-ob-refine`: Runs the learning loop for the current session on demand, filing durable facts to memory and reusable procedures as skill tickets. How to reach it: the `ob-refine` skill. Source: `skills/ob-refine/SKILL.md`.
- `skill-ob-resolving-merge-conflicts`: Resolves an in-progress git merge or rebase conflict. How to reach it: the `ob-resolving-merge-conflicts` skill. Source: `skills/ob-resolving-merge-conflicts/SKILL.md`.
- `skill-ob-sentinel`: Primes a thread as a team's sentinel, which gates, merges and deploys every pull request of the team's repos. How to reach it: the `ob-sentinel` skill. Source: `skills/ob-sentinel/SKILL.md`.
- `skill-ob-skeptical-review`: Runs an adversarial review of a diff, where readers presume every changed line is wrong until shown right. How to reach it: the `ob-skeptical-review` skill. Source: `skills/ob-skeptical-review/SKILL.md`.
- `skill-ob-slack-triage`: Finds unanswered Slack messages addressed to the user, ranks them, and drafts replies from the `ob` work state for the user to edit. How to reach it: the `ob-slack-triage` skill. Source: `skills/ob-slack-triage/SKILL.md`.
- `skill-ob-spinoff`: The procedure a dispatched builder follows: build in its worktree, pass the gate, commit with a `State:` line, open its pull request and hand off. How to reach it: the `ob-spinoff` skill. Source: `skills/ob-spinoff/SKILL.md`.
- `skill-ob-spinoff-handoff`: Hands an interactive build to the architect to gate, on the owner's word. How to reach it: the `ob-spinoff-handoff` skill. Source: `skills/ob-spinoff-handoff/SKILL.md`.
- `skill-ob-take-a-site-to-production`: Takes a new website live on its real domain, or audits one already live: accounts, billing limits, DNS, email, TLS, caching, search, monitoring, legal pages and handover. How to reach it: the `ob-take-a-site-to-production` skill. Source: `skills/ob-take-a-site-to-production/SKILL.md`.
- `skill-ob-ui-testing`: How to write, configure and fix UI tests (Playwright, Storybook, DOM tests) and what belongs in each layer. How to reach it: the `ob-ui-testing` skill. Source: `skills/ob-ui-testing/SKILL.md`.
- `skill-ob-usage-review`: The daily Claude token review: reads `ob usage day --compare`, names at most three levers, and turns each adopted one into a rule or ticket. How to reach it: the `ob-usage-review` skill. Source: `skills/ob-usage-review/SKILL.md`.
- `skill-ob-ux-hill-climb`: Scores a site's UI against rival sites on eight metrics in light and dark, and re-scores until every cell beats the best rival. How to reach it: the `ob-ux-hill-climb` skill. Source: `skills/ob-ux-hill-climb/SKILL.md`.
- `skill-ob-verify-an-auth-gated-page-without-oauth`: Reaches and verifies a signed-in page of a local TanStack Start and Cloudflare D1 app when Google OAuth cannot be completed. How to reach it: the `ob-verify-an-auth-gated-page-without-oauth` skill. Source: `skills/ob-verify-an-auth-gated-page-without-oauth/SKILL.md`.
- `skill-ob-vision-understand`: Reads a screenshot or image with a local vision model, so nothing leaves the machine. How to reach it: the `ob-vision-understand` skill. Source: `skills/ob-vision-understand/SKILL.md`.
- `skill-ob-wire-ob-architect-into-a-repo`: Sets up another repo so the `ob` planning workflow and its architect work in it. How to reach it: the `ob-wire-ob-architect-into-a-repo` skill. Source: `skills/ob-wire-ob-architect-into-a-repo/SKILL.md`.

## Planned
- `parallel-conflict-checks`: checks for conflicts between builders working in parallel.
- `team-server`: a team server with per-user access.

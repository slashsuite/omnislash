import { parseArgs } from "node:util";
import { openDb, resolveDbPath } from "./db.ts";
import { replicaUnderPostgresMessage } from "./db/servable.ts";
import {
  commandStore,
  getStore,
  isPostgresServable,
  postgresIdleTimeoutForCommand,
  resetStore,
  sqliteStoreFor,
  unusableSqliteHandle,
  type Store,
} from "./db/store.ts";
import { resolveStoreKind } from "./db/store-kind.ts";
import { resolveApiBase } from "./api/config.ts";
import type { HostJobWait } from "./api/host-job-client.ts";
import { runApi } from "./api/run.ts";
import type { ApiDownload, ApiTransport } from "./api/client.ts";
import { AppError, UsageError } from "./errors.ts";
import { modeFromFlags, printedBytes, resetPrintedBytes } from "./output.ts";
import type { Ctx, Flags } from "./ctx.ts";
import {
  cmdAdd,
  cmdEdit,
  cmdLink,
  cmdNote,
  cmdRm,
  cmdTag,
  cmdUntag,
  rewriteAddProjectArgv,
} from "./commands/capture.ts";
import {
  cmdBlock,
  cmdClose,
  cmdReady,
  cmdReopen,
  cmdStart,
  cmdState,
  cmdUnblock,
} from "./commands/state.ts";
import { cmdList, cmdNext, cmdSearch, cmdShow } from "./commands/query.ts";
import { cmdBrief } from "./commands/brief.ts";
import { cmdFocus, cmdOrder, cmdToday } from "./commands/focus.ts";
import { cmdPorts } from "./ports.ts";
import { cmdConfig, cmdCursor, cmdProject } from "./commands/admin.ts";
import { cmdWiki } from "./commands/wiki.ts";
import { cmdSync } from "./commands/sync.ts";
import { cmdAlerts } from "./commands/alerts.ts";
import { cmdDaemon, cmdLease, cmdAgent, cmdAgents } from "../../../platform/cli-coord/src/commands/coord.ts";
import { cmdRoadmap } from "./commands/roadmap.ts";
import { cmdDecision } from "./commands/decision.ts";
import { cmdDoc } from "./commands/doc.ts";
import { cmdLearning } from "./commands/learning.ts";
import { cmdMemory } from "./commands/memory.ts";
import { cmdTestUser } from "./commands/testuser.ts";
import { cmdReviewMiss } from "./commands/reviewmiss.ts";
import { cmdReview } from "./commands/review.ts";
import { cmdPerson, cmdWhois } from "./commands/person.ts";
import { cmdTournament } from "./commands/tournament.ts";
import { cmdCi, cmdGithub } from "./commands/ci.ts";
import { cmdOvernight } from "./commands/overnight.ts";
import { cmdModels } from "./commands/models.ts";
import { cmdUsage } from "./commands/usage.ts";
import { cmdCloudflare } from "./commands/cloudflare.ts";
import { cmdLog } from "./commands/log.ts";
import { cmdStatus } from "./commands/status.ts";
import { cmdSpinoff, rewriteSpinoffRepoArgv, spinoffEnqueueRef, ticketProjectRepoFor } from "../../../platform/cli-coord/src/commands/spinoff.ts";
import { cmdWeb } from "./commands/web.ts";
import { cmdCert } from "./commands/cert.ts";
import { cmdStandup } from "./commands/standup.ts";
import { cmdBackup, cmdDb } from "./commands/db.ts";
import { cmdGmail } from "../../../platform/cli-sources/src/commands/gmail.ts";
import { cmdCal, cmdAgenda } from "../../../platform/cli-sources/src/commands/calendar.ts";
import { cmdSlack } from "./commands/slack.ts";
import { cmdWhatsapp } from "../../../platform/cli-whatsapp/src/commands/whatsapp.ts";
import { cmdGoogle, type GoogleAuthDeps } from "../../../platform/cli-sources/src/commands/google.ts";
import { cmdSecret } from "./commands/secret.ts";
import { cmdCreds } from "./commands/creds.ts";
import { cmdVision, expandVisionPairFlags } from "./commands/vision.ts";
import { cmdT3 } from "./commands/t3.ts";
import { cmdTriage } from "./commands/triage.ts";
import { cmdIssue } from "./commands/issue.ts";
import { cmdJobs } from "./commands/jobs.ts";
import { cmdDeploy } from "./commands/deploy.ts";
import { jobForInvocation, recordJobAttempt, recordJobResult } from "./jobs.ts";
import {
  configuredRemoteHost,
  RemoteConfigUnreadable,
  hopGuardMessage,
  isHop,
  planExecution,
  remoteWriter,
  sshExec,
  unreachableMessage,
  type RemoteExec,
} from "./remote.ts";
import {
  markReplicaDirty,
  openReplicaForRead,
  readMeta,
  refreshReplica,
  replicaPath,
  stalenessNotice,
} from "./replica.ts";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

/**
 * The ONE flag table `parseArgs` reads. Exported (#1301) so the flag-drift backstop can assert that
 * every flag `HELP` names is in it: the help text and this table are two places that must agree, and
 * until 1301 nothing checked that they did.
 */
export const FLAGS = {
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  table: { type: "boolean" },
  db: { type: "string" },
  local: { type: "boolean" },
  "no-daemon": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  type: { type: "string" },
  kind: { type: "string" },
  key: { type: "string" },
  project: { type: "string" },
  priority: { type: "string" },
  body: { type: "string" },
  tag: { type: "string", multiple: true },
  link: { type: "string" },
  url: { type: "string" },
  title: { type: "string" },
  reason: { type: "string" },
  summary: { type: "string" },
  missed: { type: "string" },
  refs: { type: "string" },
  owner: { type: "string" },
  rank: { type: "string" },
  // OB-2083: `ob order <ref> --top | --before <ref> | --after <ref>`.
  top: { type: "boolean" },
  before: { type: "string" },
  after: { type: "string" },
  clear: { type: "boolean" },
  open: { type: "boolean" },
  status: { type: "string" },
  since: { type: "string" },
  // OB-2278: `ob usage day --until <iso> --compare`.
  until: { type: "string" },
  compare: { type: "boolean" },
  days: { type: "string" },
  query: { type: "string" },
  max: { type: "string" },
  "updated-after": { type: "string" },
  by: { type: "string" },
  limit: { type: "string" },
  remote: { type: "string" },
  icon: { type: "string" },
  "display-name": { type: "string" },
  stage: { type: "string" },
  // OB-2255: teams. `--team` on list, spinoff list and spinoff gateable; `--projects` on t3 team add; `--remove` on t3 sentinel|muse.
  team: { type: "string" },
  projects: { type: "string" },
  remove: { type: "boolean" },
  // OB-2257: `t3 team handoff <team> --role <r> --show` prints the role's latest handoff.
  show: { type: "boolean" },
  points: { type: "string" },
  backfill: { type: "boolean" },
  digest: { type: "boolean" },
  notify: { type: "boolean" },
  ttl: { type: "string" },
  timeout: { type: "string" },
  within: { type: "string" },
  wait: { type: "boolean" },
  ssh: { type: "boolean" },
  source: { type: "string" },
  "target-date": { type: "string" },
  "source-ref": { type: "string" },
  context: { type: "string" },
  choice: { type: "string" },
  rationale: { type: "string" },
  alternatives: { type: "string" },
  "decided-at": { type: "string" },
  "learn-kind": { type: "string" },
  progress: { type: "string" },
  why: { type: "string" },
  role: { type: "string" },
  email: { type: "string" },
  workspace: { type: "string" },
  env: { type: "string" },
  "secret-ref": { type: "string" },
  scope: { type: "string" },
  "scope-ref": { type: "string" },
  channel: { type: "string" },
  handle: { type: "string" },
  class: { type: "string" },
  pr: { type: "string" },
  notes: { type: "string" },
  position: { type: "string" },
  "dry-run": { type: "boolean" },
  queue: { type: "boolean" },
  once: { type: "boolean" },
  dep: { type: "string" },
  repo: { type: "string" },
  variant: { type: "string" },
  github: { type: "string" },
  linear: { type: "string" },
  "linear-name": { type: "string" },
  slack: { type: "string" },
  "slack-handle": { type: "string" },
  "whatsapp-jid": { type: "string" },
  relationship: { type: "string" },
  "comms-style": { type: "string" },
  "comms-notes": { type: "string" },
  about: { type: "string" },
  item: { type: "string" },
  ticket: { type: "string" },
  worktree: { type: "string" },
  branch: { type: "string" },
  id: { type: "string" },
  holder: { type: "string" },
  "no-lease": { type: "boolean" },
  "spawn-failed": { type: "boolean" },
  // 1205: `ob spinoff handoff --no-note` (alias `ready`) stamps without announcing. The architect stamps on the human's
  // behalf during a land, and the architect IS the thread the note goes to: so the caller that is its own
  // audience says so, and nothing is queued.
  "no-note": { type: "boolean" },
  // OB-1825: `ob spinoff check --architect <json> --checker <json> [--resolutions <json>]`, and the deliberate
  // `ob spinoff <ref> --no-check '<why>'`. A string, so an empty reason reaches the refusal instead of the parser.
  // OB-2131: `--questions-resolved` was replaced by `--resolutions`; it stays declared only so the refusal names it.
  architect: { type: "string" },
  checker: { type: "string" },
  resolutions: { type: "string" },
  "questions-resolved": { type: "boolean" },
  "no-check": { type: "string" },
  // OB-2230: `ob spinoff <ref> --no-flake-slot '<why>'`. A string, so an empty reason reaches the refusal.
  "no-flake-slot": { type: "string" },
  // OB-2107: `ob spinoff <ref> --effort high --opus-high '<his ask>'`, the quote that lets Opus run above its default.
  "opus-high": { type: "string" },
  // OB-1991: the model trial. `ob spinoff <ref> --no-trial` is one build while a trial is active; `ob spinoff trial`
  // takes the legs (--a/--b with their list prices), the blind scores (--x/--y), a forfeit or void, the diffs
  // directory, and the feedback label and rating.
  "no-trial": { type: "boolean" },
  raised: { type: "boolean" },
  a: { type: "string" },
  b: { type: "string" },
  "a-price": { type: "string" },
  "b-price": { type: "string" },
  x: { type: "string" },
  y: { type: "string" },
  forfeit: { type: "string" },
  void: { type: "boolean" },
  diffs: { type: "string" },
  rating: { type: "string" },
  label: { type: "string" },
  // 1552: the builder rates its own tier on handoff (`--tier-fit lower|right|higher`, `--tier-fit-why '<one line>'`).
  "tier-fit": { type: "string" },
  "tier-fit-why": { type: "string" },
  // OB-2044: `ob spinoff handoff --ci-unchecked '<why>'` hands off without reading the PR's CI, and records the reason.
  "ci-unchecked": { type: "string" },
  // OB-1992: `ob spinoff handoff --report <file>` (Done check and review onto the Decisions trail), and
  // `ob spinoff state <ref> <verdict> --gate <line>` (a clean repo's verdict, recorded on its row).
  report: { type: "string" },
  gate: { type: "string" },
  all: { type: "boolean" },
  "all-launchers": { type: "boolean" },
  window: { type: "string" },
  refresh: { type: "boolean" },
  launcher: { type: "string" },
  "in-flight": { type: "boolean" },
  agent: { type: "boolean" },
  interactive: { type: "boolean" },
  brief: { type: "string" },
  note: { type: "string", short: "m" },
  force: { type: "boolean" },
  client: { type: "string" },
  "client-id": { type: "string" },
  "client-secret": { type: "string" },
  scopes: { type: "string" },
  to: { type: "string" },
  yes: { type: "boolean", short: "y" },
  // OB-1909: `whatsapp send --resend` sends past an unknown-outcome identical send of the last 24 h.
  resend: { type: "boolean" },
  subject: { type: "string" },
  cc: { type: "string" },
  "body-file": { type: "string" },
  // OB-2187: `ob t3 broadcast architects|threads --message-file <path>`.
  "message-file": { type: "string" },
  // OB-2004: `ob doc show <id> --version <n>` reads an earlier version (1 = the oldest).
  version: { type: "string" },
  "reply-to": { type: "string" },
  confirm: { type: "boolean" },
  // OB-1910: `gmail send-draft --confirm --hash <hex>` binds the send to the draft the human read.
  hash: { type: "string" },
  attach: { type: "string", multiple: true },
  "no-attach": { type: "boolean" },
  name: { type: "string" },
  proxied: { type: "boolean" },
  // 1643: `cloudflare tunnels --floor <version>` — an advisory's exact cutoff (e.g. 2026.10.2), where
  // the default fleet rule is month-granular.
  floor: { type: "string" },
  date: { type: "string" },
  // OB-2007: `ob wiki log <area> "<title>" --what ... --cause ... --fix ... [--ticket OB-N] [--new-area]`
  what: { type: "string" },
  cause: { type: "string" },
  fix: { type: "string" },
  "new-area": { type: "boolean" },
  // OB-2097: `ob overnight decide ... --doubt <text> --undo <text> --night <YYYY-MM-DD>`, `summary <section> --add <line>`, `list --check`.
  doubt: { type: "string" },
  undo: { type: "string" },
  night: { type: "string" },
  add: { type: "string" },
  check: { type: "boolean" },
  tier: { type: "string" },
  effort: { type: "string" }, // OB-1815: spinoff --effort low|medium|high|xhigh|max
  answers: { type: "string" },
  shareable: { type: "string" },
  adguard: { type: "boolean" },
  router: { type: "boolean" },
  unattended: { type: "boolean" },
  issue: { type: "boolean" },
  map: { type: "string" },
  exec: { type: "string" },
  when: { type: "string" },
  overdue: { type: "boolean" },
  from: { type: "string" },
  triage: { type: "boolean" },
  file: { type: "string", multiple: true },
  "no-github": { type: "boolean" },
  book: { type: "string" },
  "external-id": { type: "string" },
  "id-number": { type: "string" },
  reveal: { type: "boolean" },
  category: { type: "string" },
  alias: { type: "string", multiple: true },
  secret: { type: "string" },
  confirmed: { type: "string" },
  // OB-2271: `ob tournament` (add, candidate, record).
  criteria: { type: "string" },
  ref: { type: "string" },
  image: { type: "string", multiple: true },
  revises: { type: "string" },
  match: { type: "string" },
  replace: { type: "boolean" },
  path: { type: "string" },
  "issued-on": { type: "string" },
  bind: { type: "string" },
  // 220: TLS for `ob web` (both listeners) and the Let's Encrypt rehearsal switch for `ob cert renew`.
  "tls-cert": { type: "string" },
  "tls-key": { type: "string" },
  // OB-2160: `ob web --prebuilt` serves the dist on disk without building (the server's unit).
  prebuilt: { type: "boolean" },
  // OB-2199 step 1: `ob web --app <name>` serves apps/<name> on `--port`, and `--no-sidecar-port` opens no :5051 listener.
  app: { type: "string" },
  port: { type: "string" },
  "no-sidecar-port": { type: "boolean" },
  staging: { type: "boolean" },
  session: { type: "string" },
  // 1414, OB-2255: `ob t3 architect|sentinel|muse --thread <id>` adopts the caller's own T3 thread as that team role.
  thread: { type: "string" },
  // 191: the drain's claim/stamp/land steps, which cross the wire as ordinary `ob` sub-invocations.
  outcome: { type: "string" },
  "base-sha": { type: "string" },
  // 1301: `ob spinoff stamp --engine <e>` — the harness the launch resolved (claude|opencode), beside its
  // launcher. HELP, README, the API client and the store's `stampSpinoff` all already implemented it; only
  // this table was missing the key, so `parseArgs` rejected the invocation before any of them ran. That hit
  // the split drain's own stamp too, whose argv (`stampArgv`) carries `--engine` on every launch. The engine
  // is a launch fact like the launcher — reconcile reads a row's token transcript FROM it — so a re-stamp
  // after a partial failure has to be able to record it: the help was right and this table was wrong.
  engine: { type: "string" },
  // 1120: `ob spinoff stamp` records the T3 thread (and run) a `t3` launch opened — or adopted. They are
  // flags rather than a blob for the same reason every other stamp field is: the partial-failure message
  // prints the exact command that finishes the job, and a human has to be able to retype it.
  "t3-thread": { type: "string" },
  "t3-run": { type: "string" },
  // 1480: `ob spinoff stamp --model <id>` — the model a t3 launch ran on (its tier's, or an adopted thread's).
  model: { type: "string" },
  error: { type: "string" },
  "input-tokens": { type: "string" },
  "output-tokens": { type: "string" },
  "cache-creation-tokens": { type: "string" },
  "cache-read-tokens": { type: "string" },
  "total-tokens": { type: "string" },
  // 323: `ob pg-export`. `--from` and `--to`/`--to-file` are required, never defaulted.
  "to-file": { type: "string" },
  truncate: { type: "boolean" },
  "verify-only": { type: "boolean" },
  "allow-missing-target-tables": { type: "boolean" },
  "allow-missing-target-columns": { type: "boolean" },
  out: { type: "string" },
  // 200: `ob db snapshot`.
  dir: { type: "string" },
  list: { type: "boolean" },
  "keep-hourly": { type: "string" },
  "keep-daily": { type: "string" },
  "max-bytes": { type: "string" },
  // 468: `ob vision compare`. `--on`/`--off` each take two paths; expandVisionPairFlags
  // rewrites `--on a b` to `--on a --on b` before parseArgs.
  as: { type: "string" },
  design: { type: "string" },
  "no-enforce": { type: "boolean" },
  on: { type: "string", multiple: true },
  off: { type: "string", multiple: true },
  // 582: `ob deploy record` fields.
  target: { type: "string" },
  host: { type: "string" },
  unit: { type: "string" },
  sha: { type: "string" },
  result: { type: "string" },
  at: { type: "string" },
  // 1102: `ob t3`. `--base-url` points the seam at a non-default T3 server;
  // `--access` picks the MCP access level `ob t3 login` approves.
  "base-url": { type: "string" },
  access: { type: "string" },
  // 1124: `ob t3 tree --subagents` includes T3's delegated child threads (excluded by default).
  subagents: { type: "boolean" },
} as const;

export const HANDLERS: Record<string, (ctx: Ctx) => void | Promise<void>> = {
  add: cmdAdd,
  edit: cmdEdit,
  triage: cmdTriage,
  note: cmdNote,
  tag: cmdTag,
  untag: cmdUntag,
  link: cmdLink,
  issue: cmdIssue,
  rm: cmdRm,
  start: cmdStart,
  ready: cmdReady,
  block: cmdBlock,
  unblock: cmdUnblock,
  close: cmdClose,
  reopen: cmdReopen,
  state: cmdState,
  next: cmdNext,
  status: cmdStatus,
  list: cmdList,
  show: cmdShow,
  brief: cmdBrief,
  search: cmdSearch,
  today: cmdToday,
  order: cmdOrder,
  focus: cmdFocus,
  project: cmdProject,
  wiki: cmdWiki,
  cursor: cmdCursor,
  config: cmdConfig,
  sync: cmdSync,
  slack: cmdSlack,
  whatsapp: cmdWhatsapp,
  alerts: cmdAlerts,
  jobs: cmdJobs,
  lease: cmdLease,
  ports: cmdPorts,
  agent: cmdAgent,
  agents: cmdAgents,
  spinoff: cmdSpinoff,
  standup: cmdStandup,
  web: cmdWeb,
  cert: cmdCert,
  daemon: cmdDaemon,
  deploy: cmdDeploy,
  db: cmdDb,
  backup: cmdBackup,
  roadmap: cmdRoadmap,
  decision: cmdDecision,
  doc: cmdDoc,
  learning: cmdLearning,
  memory: cmdMemory,
  "test-user": cmdTestUser,
  "review-miss": cmdReviewMiss,
  review: cmdReview,
  person: cmdPerson,
  whois: cmdWhois,
  tournament: cmdTournament,
  ci: cmdCi,
  github: cmdGithub,
  overnight: cmdOvernight,
  models: cmdModels,
  usage: cmdUsage,
  cloudflare: cmdCloudflare,
  log: cmdLog,
  gmail: cmdGmail,
  cal: cmdCal,
  agenda: cmdAgenda,
  google: cmdGoogle,
  secret: cmdSecret,
  creds: cmdCreds,
  vision: cmdVision,
  t3: cmdT3,
};

export const HELP = `ob — OmniSlash personal task tracker

Usage: ob <command> [<args>] [--flags]
       ob --help | ob help    print this help on stdout and exit 0

Item refs (1949): every item is shown by its per-project ref <KEY>-<seq> (PS-12, OB-1700), the key coming
from its project ('project edit --key'); an item with no project is numbered under OB, and an item in a
project with no key has no ref yet and keeps showing its legacy number. Every <id> argument takes the ref (any case), an old ref a move left behind (an alias, printed as
'was:' by show), or the legacy global number. A bare number is the legacy number, EXCEPT where it is also another item's OB-<n> key: then every typed <id> command REFUSES, names both items and changes nothing; type the ref. Moving an item to
another project gives it a new ref and keeps the old one as an alias. --json keeps "id" (the legacy number,
the internal key) and adds "ref"; -q and the write echoes (add, close, state, ...) print the ref.
Spinoffs are named by it too: branch/worktree/builder ps-12, lease ticket:PS-12, commit scope feat(PS-12).

Capture & edit:
  add <title> [--type --kind --project|--repo --priority --body|--body-file <file> --tag <t>... --link <url>]
                            --body-file <file> reads the body from a file on THIS machine (--body and --body-file together are refused)
                            a flag 'add' does not read is refused by name, e.g. 'ob add does not take --subject'
                            --kind is store-side only: an API client refuses it, by name, with the reason
                            --from needs --triage; --map and --exec need --issue (and --link is not read with --issue); the detail flags need their type
                            --link <github issue url> is refused (as 'issue link' is) when another item already holds that issue;
                            [--issue [--map <name>] [--exec <mode>]]  opt-in: also create a GitHub
                            issue on wayfinder_repo (labelled wayfinder:task [+ map:<name>] [+ exec:<mode>])
                            as the source of truth, with a local mirror item linked to it
                            [--triage [--from <repo>]]  flag the item for the triage inbox (an architect in
                            another repo handing work over); --from names the origin repo, else it is
                            auto-captured from the current git repo. Defaults to open, priority none.
                            task infer --project/--kind from the cwd git remote when omitted.
                            On an API client or with remote_host set that inference runs HERE before
                            the wire (243): the server's cwd is never the checkout meant, so the
                            project crosses already resolved. A cwd with no inferable remote still
                            errors with the same message, here, rather than guessing.
  triage                    list the triage inbox (items awaiting triage, newest first): id, title,
                            origin repo, note snippet. Setting a priority (edit --priority) triages an
                            item and clears its flag.
    triage clear <id>       clear the triage flag (keep the item; it has been triaged)
    triage reject <id>      close the item (it will not be worked) exactly as 'close' does: validated,
                            on the trail, GitHub mirror, spinoff land; any close clears the flag
  edit <id> [--title --body|--body-file <file> --priority --project|--repo]
                            --body-file <file> replaces the body with the file's text, read on THIS machine; a flag 'edit' does not read is refused by name
  note <id> <text>          append a note
  log <kudos|suggestion|comment> "<text>" [--about <handle>] [--item <id>]
                            standup journal entry  |  log list [--since --type]
  tag <id> <tag>... [--repo <r>]  /  untag <id> <tag>...
                            work-classification tags (flat convention, see README):
                            frontend backend new-work rework maintenance
                            security-fix bug-fix based-off-design based-off-acs
                            --repo also sets the item's repo/project (alias of --project)
  link <id> <rel> <other>   rel: roadmap_member|spun_off_from|references|blocks|supersedes
  rm <id>

Two trackers, one truth (77): ob item numbers <-> GitHub issues on wayfinder_repo:
  issue [list]              the current ob<->issue pairs (id · #issue · status · title)
  issue link <id> <#n|url>  pair an EXISTING item with an EXISTING issue (the gap 'add --issue' leaves:
                            work that already had a GitHub ticket but was added to ob without it).
                            Stored as the issue URL on the item's ref row, the same place add --issue
                            puts it, so 'ob show' renders it. Refuses an issue already linked elsewhere,
                            and REFUSES an item that already carries a Linear ref (one ref row per item,
                            so linking would overwrite it). The refusal points at 'ob issue unlink <id>'
                            -- never at deleting the item
  issue unlink <id>         clear WHICHEVER reference the item holds, GitHub issue or a leftover Linear
                            ref (138). Clears the reference only: the item keeps its notes, tags, links,
                            history and state, and nothing in Linear is written
  issue landed <id|#n>      IS THIS ALREADY ON MAIN? Run it BEFORE dispatching work. Local git + the
                            spinoff table only, no network. THE TWO NUMBERINGS ARE SEPARATE: ob ids and
                            issue numbers are independent sequences that collide (main carries
                            'Merge ob 75' while GitHub #75 is an unrelated open ticket), so evidence is
                            only ever read WITH its marker: 'ob <n>' proves things about ob, '#<n>'
                            about issues, and a bare number in a scope ('docs(27):') proves neither.
                            A LINK is the only bridge between them. Four signals, each reported with its
                            evidence: merge-commit ('Merge ob <n>'/'Merge #<n>:' subject, multi-ticket
                            'Merge #123 + #128' included) · commit-ref (a LEADING scope '(ob <n>)'/
                            '(#<n>)' or a closing 'Closes #<n>'; a mention in prose is not a claim) ·
                            merged-branch (a '<n>-*' branch merged into main, PROVED to carry commits of
                            its own and attributed to a numbering by its spinoff row; a just-created
                            zero-commit branch is never a hit) · spinoff-row (held to that same proof).
                            'signals hit' lists ONLY what fired. FOUR answers, never two: ALREADY ON MAIN ·
                            no evidence on main (not proof of absence) · COULD NOT TELL (evidence matched
                            the NUMBER but not the numbering) · COULD NOT READ (git could not be read, so
                            nothing was checked). COULD NOT TELL is what a '#<n>' whose <n> is ALSO an
                            UNLINKED ob item earns (129: main carries 'Merge #122' for ob item 122 while
                            GitHub #122 is an unrelated ticket): it reads as either ticket, so it is
                            reported as ambiguous for BOTH numberings and counted for neither, rather than
                            silently picked. THE HOUSE RULE: an unlinked ob item lands as 'Merge ob <n>',
                            never '#<n>' -- link the pair and the marker means what it says again. A BARE
                            NUMBER is the internal item id, not the OB-<n> the ticket shows (they are
                            different items, OB-1700): when OB-<n> is another item the output says so;
                            ask by ref ('issue landed OB-1697') for the ticket you mean.
                            CLEAN REPO (OB-1992, any repo but OmniSlash): its subjects carry no ref, so
                            the answer comes from the spinoff row and the merged branch that row recorded,
                            and the output says 'clean repo: subjects carry no ref'.
                            'main' is origin/main when the checkout has one (the architect's local main
                            never moves, lands push from a land worktree, 1874), else local main; a local
                            main ahead of origin/main wins. Reads the ref as last fetched, no network.
                            Refuses a checkout that is not wayfinder_repo. [--repo <path>] picks the
                            checkout to read. -q prints landed / could-not-tell / not-landed
  issue reconcile [--limit N]   likely UNLINKED pairs (title-token overlap + branch-slug match) for a
                            HUMAN to confirm; prints the 'ob issue link' line, links nothing itself
  issue drift               tracker drift both ways: open issues whose feature already looks like it is
                            on main, and closed issues whose ob item is still open for its type
                            (a task not done, a roadmap not archived, a decision still draft)

Workflow:
  EVERY STATUS CHANGE TAKES A NOTE (1515): start/ready/close/reopen/block/unblock/state, spinoff
                            enqueue/stamp/handoff/land/reconcile, 'agent done' and 'lease release --force'
                            accept --note/-m "<why>" (block also accepts it in place of --reason). The move
                            is recorded either way — when · who · from → to, note optional — and 'ob show'
                            prints the trail under Decisions, newest first. It never leaves this machine.
  start <id> | ready <id> | close <id> | reopen <id>   ('state <id> done' mirrors exactly like close;
                            'rm <id>' deletes local tracking only and never touches the issue)
                            close/reopen CLOSE OR REOPEN THE LINKED GITHUB ISSUE TOO (77) and print
                            exactly which issue they touched. Narrow by design: only the one issue the
                            item's link names, only on wayfinder_repo (a link to any other repo is
                            reported and left alone), and nothing at all when there is no link.
                            [--no-github] skips the GitHub call only · [--dry-run] previews BOTH moves
                            and writes NOTHING (the item is not closed either), validating the
                            transition so the preview cannot promise an impossible move.
                            close also lands the item's spinoff rows; over the API their token counts
                            are read HERE, on the client (the API host has no transcripts), and sent
                            with the close (OB-1993). A zero read never overwrites a recorded count.
                            The local move always stands; if GitHub fails, the item is still closed,
                            the mismatch is printed and the exit code is 1.
                            close on a SPIKE (OB-1826) retires its row as failed with a 'spike: <note>' error, never landed, and tells its thread it is closed; the worktree stays for the architect to
                            remove (git worktree remove --force <wt>; git branch -D <branch>).
                            close ALSO MARKS LANDED (1589) the ticket's own building/handed-off spinoff rows
                            (the same item join as below), so 'ob spinoff list' reads landed without a reconcile;
                            best effort — a failure is a warning naming 'ob spinoff reconcile', never a rollback.
                            close ALSO SETTLES the ticket's T3 threads (1120): every spinoff row for it
                            that ran with --launcher t3 has its thread settled, so a finished builder
                            leaves T3's active list (the 3-day auto-settle is the backstop). A row is THIS
                            ticket's when it RECORDS the ob item (spinoff.item_id, stamped at dispatch,
                            1163) or when its ref is the wayfinder number the item's own record names, so
                            a hand-charted ticket — dispatched by that number while its ob mirror carries
                            its own id — still settles. Best effort and never a rollback — a thread that
                            could not be settled is named on stderr and the close stands, and a close that
                            found no row at all says so rather than returning silently (1163). Nothing is
                            asked of T3 when the ticket has no t3 rows.
                            On a SPLIT client the rows come over the API and the settle runs HERE, where T3 is.
                            AND IT ANNOUNCES THE LAND BACK (1133): each of those builder threads also gets
                            the sentence it otherwise has to infer — 'landed: <ticket> is on main (squash
                            <sha>)', the sha being the commit on main naming the ticket and UNREPORTED when
                            it cannot be read, never guessed. The reply goes FIRST and the settle follows:
                            measured on the pinned build, a delivered message re-activates a thread (so a
                            settle first is undone by the reply) and a settle during the note's own turn is
                            refused, so close waits (bounded, 30s) for that turn to end and then settles.
                            The note is an EXPLICIT STOP (1188) — a message is the only vehicle T3 offers
                            and every one of them starts a turn, so it says 'INFORMATIONAL … do not start
                            or continue any work, end your turn now', which is what stops the reply from
                            buying a fresh builder turn on every land. And the settle is RETRIED over a
                            bounded window (1188: up to 6 asks, each waiting up to 20s for the live turn)
                            rather than one shot, so a builder that outlasts the reply still ends settled
                            in the same invocation; after that it is named once on stderr and T3's 3-day
                            auto-settle is the backstop. A close never hangs on an agent past that bound.
                            A row with no recorded t3_thread_id is a NAMED SKIP, never a failure and never a
                            guess at which thread was meant. A send that fails is a warning: the land stands
                            and the exit code is unchanged.
                            AND IT WITHDRAWS THE NOTE THAT IS NO LONGER TRUE (1205): a readying note still
                            QUEUED in the architect's thread asks for a gate this close just gave, and T3
                            delivers a queued message when the architect's turn ends (minutes later) where
                            it reads as a builder declaring work still to be gated (the 23:08 stale gate
                            request for an already-landed 738). A t3 row's note for THIS ticket is withdrawn
                            from the architect's queue; another ticket's queued note is a live
                            declaration and is left where it is. Silent when nothing is held (the ordinary
                            land), a line when one was withdrawn, a warning when T3 refused — never a
                            rollback, and a ticket with no t3 rows asks T3 nothing at all. A queue that does not
                            come back in ONE live page is a warning too (partial) — T3 recomputes page offsets
                            per read, so a later page can step over an item — even when a note from the pages
                            that were read was withdrawn, and is never read as a clean empty queue
                            RUN FROM A BUILDER'S OWN WORKTREE (OB-1670, #80; since OB-1686 / #82 the architect merges
                            and closes, so a builder no longer runs this), that builder's own thread is neither told it landed nor
                            settled (its now-stale handoff note is still withdrawn). Named once: 't3: <ticket> closed from its own builder's worktree'.
                            A close from main (the architect's) is unchanged
  block <id> --reason <r> [--owner <who>] [--note <why>] | unblock <id> [--note <why>]
                            --note names the same thing as --reason on block; the transition records it.
                            block refuses a done item, an already-blocked one, and a type with no 'blocked'
                            (decision, roadmap, learning). unblock restores the status the item was
                            blocked from (else 'open')
  state <id> <state>        validated per type/kind; accepts --note/-m. Same doors as the named verbs:
                            'blocked' is block, a move off 'blocked' clears the block, 'done' is close
                            (mirror + spinoff land), 'open' on a done item is reopen (mirror)

Query:
  next [--project <slug|repo>]  today's focus (today_rank -> priority -> kind -> queue_rank -> updated);
                            --project shows one project's queue, so the top buildable item is the next dispatch (OB-2083)
                            priorities, best first: urgent, flake, high, medium, low, none (or 0-5);
                            flake is a flaky test, so it sits above high (OB-2060)
  status                    NOW snapshot: agents · T3 threads (1124, with a 'needs you' line; ONE line saying
                            it could not be read when T3 is down) · in-flight PRs by state · blocked · live
                            deploy (when not ok) · focus · journal
  list [--open --status --kind --project|--repo --team <name> --priority --type --tag
        --since --updated-after --by priority|updated|created --limit <n>]
                            --team (OB-2255) keeps only items whose project is in the team; an unknown team exits 1 naming it
  show <id>                 full detail, including the Decisions trail (1515): one line per status change,
                            newest first (when · who · from → to · note). Machine-readable in --json
  brief <id>                work-state for an item: status · links · recent activity;
        | --in-flight       --in-flight = open PRs (by state) + open items — grounds a "status of X?" reply (--json for skills)
  search <query>            FTS over title+body
  today <id> [--rank N] | today --clear
  order <ref> --top [--priority <p>] | --before <ref> | --after <ref>
                            place an open item in its project's queue (OB-2083). The queue is the priority bands, and
                            inside a band queue_rank ascending (ranked before unranked). --before/--after next to an
                            item of ANOTHER priority moves it into that band (sets its priority); --top keeps its own
                            band, or takes --priority. The band is renumbered 1..n; today_rank is never touched.
                            The target must be open and in the same project
  focus <project> | focus --clear

Measurement (v2):
  sync [--source github] [--since <when>] [--backfill]   ingest GitHub PR data into the event store
  slack unread [--limit N]  Slack messages ingested before ob 208 retired the poll (read-only; work
                            Slack awareness now comes from the Claude Slack connector, not from ob)
  alerts [--digest [--notify]] | alerts snooze <key>   proactive surfacing; --notify pushes only action alerts (jobs, credentials, blocked), never aging
                            --digest prints the one-message morning summary; with --notify (the 08:00 server
                            job, 1655) that message is also pushed ONCE to notify.<ha_notify_service>
                            through Home Assistant (ha_host, token = the ha secret, never printed), only when
                            at least one alert exists. Silent when clean; never one push per alert.
                            rules 1-4 cover items and people; rules 7-10 cover the DAEMON FLEET (218/221):
                            job failing (N consecutive failures) · job stale (no success within a
                            multiple of the job's own declared cadence) · job never ran (declared in
                            daemonJobs() and installed nowhere) · job interrupted (N runs in a row
                            started and never finished, so it is being killed or timing out). Tuned by
                            alert_job_failures, alert_job_stale_multiple, alert_job_stale_floor_hours,
                            alert_job_interruptions; silence one for good with
                            "config set alert_job_ignore <job>,<job>", or snooze it like any alert.
  jobs host [<id> | fetch <id>] [--json|--quiet]   (OB-1808) what the API host ran for a client: 'ob db|backup|cert' from an API client run as a job. The list, one job with its exit code and scrubbed output, or 'fetch' to take a succeeded pull's files into this checkout. A job the host died under reads 'lost': run it again
  ci main [--project <p>] [--notify] [--json]
                            (OB-2276) each project's latest completed push run on main, one line per workflow:
                            conclusion, short SHA, run URL; '<project>: no runs on main' for a repo with none and
                            'no GitHub remote recorded' for a project with no remote. --notify is the catch-up behind
                            the GitHub webhook receiver (POST /api/ob/github/webhook, no bearer, checked by its
                            X-Hub-Signature-256 against secret github-webhook-secret): a red run (failure, timed_out,
                            startup_failure; never cancelled) not yet told is told once to the project's team's
                            sentinel, else its architect, with repo, workflow, SHA, subject, failing jobs and run URL;
                            the first green run of that workflow after it sends one 'main is green again' line. A
                            project in no team is told nobody and shows as a 'main red' alert (rule 12) until green.
                            The hourly ci-main server job runs it. Exit 1 when a repo could not be read or a note
                            could not be sent. Served: the host reads GitHub with its 'github' secret
  github hooks [--yes] [--json]
                            (OB-2276) per project with a GitHub remote, whether its webhook to the receiver exists
                            and sends workflow_run, check_suite, pull_request and push. Without --yes a dry run:
                            prints what it would create or fix and changes nothing. --yes creates or fixes them, signed
                            with secret github-webhook-secret (refused, naming it, when it is not set)
  jobs                      per-job health behind rules 7-10: state, last success, failure streak,
                            unfinished-run streak, last error, one row per job daemonJobs() declares.
                            Recorded by ob itself around every job invocation, so a connector cannot
                            forget to report. The state answers "is this working", not "should this
                            alert": a job in a failure streak below alert_job_failures reads "degraded"
                            rather than "ok", and "ok" needs a success on record. An attempt with no
                            result is never "ok" either: it reads "running" inside one cadence and
                            "interrupted" beyond it.

Coordination (v2):
  lease acquire <resource> [--ttl <s>] [--wait] [--holder <id>]   TTL resource mutex; exits 1 when denied
                            default TTL 1200s (20m) for ticket: / worktree: / port: / app:<name>; pass --ttl for a longer gate
                            heartbeat every 10m while working (ob agent heartbeat beats the holder's live leases and acquires its expired ones afresh, never revived, OB-1922)
                            --wait blocks until the hold lapses or is released — no 60s timeout; never --force from a skill
                            --wait waits out an unreachable ob API (a deploy restart): one 'ob API unreachable, still waiting' line, then 'ob API back' (OB-2157)
                            in a T3 shell (T3CODE_THREAD_ID set) a --wait that has to wait puts '⏳<label>' in front of the thread's title
                            ('⏳🌐 · <title>'; labels as for lease run) and takes it off when the wait ends, however it ends; a failed retitle
                            is one stderr line, never a lease failure (OB-2153, OB-2169)
                            acquire never marks a hold (🔒 is lease run's: an acquire exits at once, so nothing would take it off, OB-2169)
                            key classes: ticket:<ref> · worktree:<abs-path> · app:<name> (single-instance GUI) · port:<n> · spinoff:<id> (a queue row's launch claim) · cpu:<name> (a machine-wide CPU slot; cpu:browser, OB-2071) · flake:slot (the one flake fix on the machine, taken and released by ob spinoff, OB-2230)
                            re-acquiring your own live lease keeps its acquired_at (the lease's age) and only extends the expiry
                            keys are canonicalised (ticket:#96 = ticket:96, worktree: paths resolved through symlinks) so a lease matches what the guards check
                            --holder names a STABLE owner (architect-acme, the branch); the default <pid>@<host> dies with this ob process
  lease run <resource> [--holder <id>] [--ttl <s>] [--max <s>] -- <command...>   hold a lease for as long as a command runs (OB-2071): waits for it
                            (one stderr line names the current holder), runs the command with stdio passed through, heartbeats while it
                            runs, and ALWAYS releases (normal exit, failure, Ctrl-C, SIGTERM); exits with the command's code, or 128+signal
                            when ob itself is signalled (the signal is forwarded to the command first). 127 when the command cannot start.
                            Default holder <branch>:<pid>@<host> (unique per run), default --ttl 300s, beat every 60s: a run killed
                            without a signal frees the slot when its lease lapses (within 5 minutes). EVERY local Storybook or Playwright run goes through
                            'ob lease run cpu:browser -- <command>', never bare, so only one browser run loads the desktop at a time.
                            A cpu: run is stopped at a 10 minute cap counted from the grant, not the wait (OB-2229): ob prints one line,
                            SIGTERMs the command (SIGKILL 10s later), releases the lease and exits 124. Longer work is split into
                            several leased runs. --max <s> (a whole number, 1 to 600 on a cpu: key) lowers the cap, never raises it;
                            other keys have no cap unless --max sets one. A nested run is covered by its parent's cap.
                            Through TaskSlash (OB-2234): a cpu: run, when 'taskslash status --json' exits 0 within 2s, takes no lease
                            (OB-2254: the PATH client is used only when its status answers, else ~/.cargo/bin/taskslash, with one stderr
                            line naming the PATH client that did not answer) and runs 'taskslash run --kind browser
                            --name ob:<resource>:<command, first 120 chars> -- sh -c <record pid; exec timeout -k 10 <cap>> <command>', so the daemon admits it against the machine's headroom
                            and the cap counts from admission, stops the command's whole process group and still exits 124. Under a finite
                            RTTIME limit the taskslash client runs in the escape unit below. ob passes every signal to the job's group (to
                            the client while it is still queued). One stderr line: 'lease run: through taskslash'; no title marker (taskslash
                            prints its own waiting lines). No daemon: the lease, as above, with no new line. A daemon gone after the check
                            makes taskslash exit 1, passed through. OB_LEASE_RUN_TASKSLASH=0 never uses it.
                            A nested 'lease run' for a resource its parent already holds runs at once (OB_LEASE_RUN_HELD); refused
                            under the ssh remote_host mode (the command would run on the server)
                            An unreachable ob API (a deploy restart) is waited out, never run past: one 'ob API unreachable, still
                            waiting for <resource>' line, then 'ob API back'; a release it cannot reach is retried for 60s, once when signalled (OB-2157).
                            Escapes T3's RLIMIT_RTTIME (OB-2161): when ob's own hard 'Max realtime timeout' is finite (T3 Code sets 0/0,
                            and at 0 the kernel SIGKILLs browsers that arm a thread CPU timer) and systemd-run is on PATH, the command
                            runs as a transient user service (systemd-run --user --wait --pipe, unit ob-lease-run-<pid>-<random>) in the
                            caller's cwd and environment (passed in a 0600 file under $XDG_RUNTIME_DIR, deleted on start), so it reads
                            unlimited. Exit codes, stdio and signals pass through; ob sends each signal to the unit, and a second signal,
                            or 10s after a SIGTERM without an exit, stops it. No user manager: runs directly. OB_LEASE_RUN_ESCAPE=0 never escapes, =1 always.
                            A holder whose lease was taken while it could not beat prints one 'LOST <resource>' line and runs on.
                            In a T3 shell the run marks its thread: '⏳<label>' while it waits (OB-2153), '🔒<label>' once it holds the
                            lease, until the command ends and the lease is released, however it ends, so the sidebar shows who holds a
                            slot (OB-2169). One marker per resource, front of the title, space separated, then ' · ':
                            '🔒🌐 ⏳🔌5101 · <title>'; a run only moves its own. Label: the resource's icon (cpu:browser → 🌐), else its
                            class icon and the value (port → 🔌, port:5101 → 🔌5101), else the value after the class (probe:x → x, a
                            worktree: path → its last segment). Two resources with one label share a marker. A nested run of the same
                            resource marks nothing; of another resource, it marks its own beside the outer. A failed retitle is one stderr line.
  lease heartbeat <resource> [--holder <id>]   keep a long gate's lease alive (exits 1 if you don't hold it, or if it
                            has EXPIRED: a lapsed lease is never revived, since another holder could have taken it; acquire it again)
  lease release <resource> [--holder <id>] [--force]   PASS THE SAME --holder YOU ACQUIRED WITH: release is symmetric with
                            acquire, so a --holder acquire needs a --holder release (the default <pid>@<host> is a new pid every
                            invocation and matches nothing). Releases your own hold or an EXPIRED one; exits 1 and names the
                            recorded holder when it released nothing. --force is ONLY for breaking a LIVE holder that is gone
                            --note/-m "<why>" (1515) records the forced release on the ticket item's Decisions trail
  lease status (or lease)    active leases (held / expired; an expired lease is reclaimable). Also sweeps rows expired
                            for over a day (stderr names them); a row expired for less than that stays listed
  ports [--all] [--json]    (OB-2041) the LAN dev-port range 5100-5199 an iPad or iPhone on this machine's LAN (the /24 around its LAN address) can reach, one state per port:
                            free · leased (holder) · listening (pid, process, bound address) · leased+listening. Flags a server bound
                            to loopback ("loopback only ... start it with --host") and a listener with no lease ("unleased"); prints
                            the LAN URL http://<lan-ip>:<port> (never localhost) and whether the ufw range rule is present (read from
                            /etc/ufw/user.rules, no sudo; "unknown" if unreadable). Missing rule: prints the exact 'sudo ufw allow ...'
                            line for the owner to run; ob never runs sudo or touches the firewall. Free ports collapse to ranges unless --all.
                            Each source degrades on its own: no ss -> listening "unknown"; lease API down -> lease state "unavailable"; either way free ports read "unknown", not free.
                            The ufw rule counts only when it allows tcp 5100:5199 inbound to any local address from exactly that /24 (a VPN default route gives no LAN address, so no URL)
  ports next [--holder <id>] [--ticket <ref>] [--ttl <s>] [--quiet]   claim the lowest port neither leased nor listening: acquires port:<n>
                            through the lease call (a refusal tries the next one), prints the port then its LAN URL; --quiet prints the
                            number alone, so PORT=$(ob ports next -q --holder ob-1234), then start the server with --host --port "$PORT" --strictPort. Holder defaults to the lowercase --ticket, else
                            <pid>@<host>; default --ttl 8h, whole seconds (a dev server outlives the 20m lease default). Needs the lease API. No LAN address found: no URL printed.
                            Release: ob lease release port:<n> --holder <id>
                            Under the legacy remote_host ssh mode both forms refuse by name (ss/ufw are read here, leases on the server): unset it and use OMNISLASH_API.
  agent register [--ticket --worktree --branch --status --note --launcher --session --ttl --id --holder] [--no-lease] [--spawn-failed] (1579: on a t3 thread --status needs-human puts 🙋 in front of the thread title, any later status takes it off; best effort, a title that cannot be set only warns. OB-1710: a team role row's (architect-*, sentinel-*, muse-*) needs-human also clears to planning by itself, marker and all, when the owner's next message has started a run, noticed by spinoff reconcile; a queued ob note or a scheduled run never clears it, and a builder's needs-human is never touched) | agent heartbeat <id> | agent done <id> [--no-lease] [--note/-m <why>]
                            register ≠ launch (417): a registry write only — never launches anything and
                            never opens a tab. Only 'ob spinoff' starts an agent. register with --ticket CLAIMS ticket:<ref> (refused if another live agent holds it) except a handed-off spinoff for that builder does not re-claim ticket: or worktree: (577: register still updates note/status; does not agent done); heartbeat
                            refreshes its leases; done releases only leases THIS agent acquired (341: an inherited
                            architect hold is kept, never dropped). --no-lease opts out (deliberate second registrant)
                            'agent done --no-lease' clears the ROW ALONE (225), for a caller that judges each lease
                            separately: it is the database half a reconcile dispatches, and that caller
                            keeps a lease whose own TTL is current
                            --status planning|working|readying|needs-human|blocked — ob's OWN workflow words, and the
                            only ones this column takes. T3's thread enum (idle|preparing|queued|starting|running|waiting|
                            completed|interrupted|failed|cancelled|rolled_back) lives in the SEPARATE 'run' field, written
                            only by the run-state mirror (1120/1189): ob agents prints 'status · run' ('working · running')
                            and --json carries both. A retired word (launching|resolving-comments|manual-review|failed)
                            still READS off an old row but is refused here, and 'waiting' is T3's (a run parked on the
                            human), never an alias for needs-human
                            --holder <id> registers UNDER a lease you already hold (the architect holding ticket:<n> for a gate
                            dispatching a builder for it): a hold by that holder is compatible, not a conflict, and is left
                            untouched (its TTL is not shortened, and only its holder heartbeats it)
                            --spawn-failed reports a launch that produced NO SESSION, not a run that went badly: it also
                            invalidates the spinoff row that queued it, re-queueing it as pending for ONE retry, then
                            marking it failed; either way the row leaves launched so list stops calling it live
                            --launcher t3 records WHERE this agent lives (a spinoff launch stamps it
                            from the resolved launcher; omitted on a re-register keeps the recorded value).
                            'warp', the retired interactive launcher and headless are REMOVED (#79, ob 1109, 1589): a name that is not
                            t3 is rejected here, while rows that recorded an old launcher still read as the
                            value they recorded
                            --session <id> records the harness session this row was launched with; omitted on a
                            re-register, the stored id is kept
  agents [--all]            who's working on what now (a needs-human row's note prints as '🙋 needs you: <reason>', cut at a word boundary, 1579; status · run: ob's workflow word, then T3's run state when
                            there is one — 'working · running'). ob's words are planning|working|readying|needs-human|
                            blocked; T3's live in the separate 'run' field and are never merged into 'status' (1189)
                            live only; --all includes expired. TTL hides a row here; it does not block the next drain (ob 767)
                            the CROSS-LAUNCHER view: each row shows where it lives (t3, a recorded headless, or the
                            legacy 'warp' on a row from before #79 removed it, which still renders as warp and is
                            never rewritten; from the agent row, else its launching spinoff; '-' = unknown/legacy)
                            a launcher claims NO workflow word: until the agent registers itself a fresh row reads '-'
                            (or just its T3 run). A legacy headless builder has NO run (the field is null), and
                            'launching'/'failed' are the SPINOFF row's words, not this row's: 'ob spinoff list' is
                            where a launch that produced nothing shows
  agents reset [--dry-run]  WIPE the agent registry AND release every lease (ticket:* worktree:* port:* spinoff:*).
                            Bare command MUTATES — no --yes, no prompt.
                            --dry-run is opt-in preview only: prints every agent id and every lease resource that
                            would go, exit 0, change nothing. Does not touch spinoff rows, items or worktrees.
                            Live processes stay up; next register/heartbeat recreates that agent row; next lease
                            acquire recreates that hold.
  spinoff <ticket|#issue> [--repo <path|slug> --branch --worktree <path> --launcher t3 --tier complex|medium|simple --effort low|medium|high|xhigh|max --opus-high '<his ask>' --brief - --note <tier rationale> --holder <id> --no-check '<why>' --no-flake-slot '<why>' --no-trial]   enqueue AND launch NOW (1589; --no-trial: one build while a model trial is active, OB-1991): claim the row, open or adopt its T3 thread, stamp it, in ONE invocation; prints the thread id, or a named refusal and exit 1. No daemon, no queue-and-wait (1697: a ref that equals a spinoff subcommand word — abandon, drain, list, … — is refused, nothing queued or launched; 'ob spinoff abandon 782' once launched a builder for a ticket called abandon). In a CLEAN repo (OB-1992, any repo but OmniSlash) the default branch is a slug of the ticket title (40 characters at most, -2/-3 when taken locally or on origin; --branch overrides) while the row, worktree, builder id and leases keep the ref, and the launch prompt ends with the one-line rule that nothing of ob goes in that repo's PR
                            a ticket:/worktree: lease another live session holds REFUSES before anything is written (names the holder, exit 1, no pending row left behind); --holder <id> dispatches UNDER a hold you already have (the architect holding ticket:<n>)
                            OVER THE API (split, 360) the same invocation runs: POST /spinoffs (the row), claim on the server, the T3 launch HERE, stamp on the server. A crash between the claim and the stamp leaves a claim that LAPSES (spinoff:<id>, 300s) and 'ob spinoff reclaim' takes it back
  spinoff queue <ticket|#issue> [same flags]   enqueue ONLY (no launch): the row waits as queued until 'ob spinoff drain' or a later 'ob spinoff <ref>' launches it
                            --tier complex|medium|simple (1480) RATES the build and picks the model a t3 thread runs on: complex=Opus, medium=Sonnet, simple=Haiku by default (the claude-opus|sonnet|haiku-5-5 catalog ids) (spinoff_tier_models overrides any tier; the active profile of ~/.config/ob/models.jsonc overrides both, see 'ob models'), on the T3 project's OWN provider instance (the instanceId of its default selection; only the model is swapped), unless the tier's value is provider-qualified (1549), '<provider>:<model>' e.g. {"simple":"opencode:opencode-go/deepseek-v4.1-flash"}, which runs on THAT provider instance (split on the first colon; a bare id keeps the project's provider) and is stamped qualified in spinoff.model. Recorded on the row (spinoff.tier) at queue time; the model the launch actually ran on is STAMPED (spinoff.model, the adopted thread's own on an adoption) and printed by ob spinoff show/list/gateable. NO --tier = medium, and the queue line says 'tier: medium (default)'. An URGENT ticket (priority urgent, OB-2075) always runs on the complex tier (Opus), whatever --tier names or omits: the row records complex, a lower tier named is raised and the line says 'tier: complex (urgent, raised from medium)', and a priority raised after queueing is picked up at launch. flake, high and lower keep the tier named; a model-trial leg and a ref with no item are left alone. A FLAKE ticket (priority flake, OB-2230) is the one flake fix on the whole machine: its launch takes the machine-wide flake:slot lease (6 hour TTL, kept alive by 'ob agent heartbeat') in the same transaction as ticket: and worktree:, a dispatch that finds flake:slot held by another builder exits 1 naming the holder and its ticket and queues nothing, and the handoff, 'ob close', 'spinoff abandon' and a failed launch release it (a send-back or reopen takes it again, refused while another flake fix holds it), and a flake ticket runs no model trial. --no-flake-slot '<why>' launches without taking it and records 'flake-slot -> no-flake-slot' with the reason on the Decisions trail. Its launch prompt carries a paragraph telling the builder to run every test through flake-box (no lease and no time cap inside the box); a machine without /usr/local/bin/flake-box warns, and the paragraph says so. An unknown tier is a usage error; a tier model T3's catalog does not list on that instance, a provider T3 does not advertise or reports unusable, or a malformed spinoff_tier_models, fails the row with a NAMED refusal, never a fallback to the project default. Re-dispatching a still-PENDING ref with --tier re-rates it; a relaunch at another tier whose worktree still has an unsettled thread on a different model is refused naming that thread (settle it, then drain) rather than adopted on the old model, except for an urgent ticket (OB-2075), which adopts it.
                            --effort low|medium|high|xhigh|max (OB-1815) picks the REASONING LEVEL the builder's model runs at, beside --tier's model: it goes to T3 as modelSelection.options [{id:"effort",value:<level>}] (a Claude model) or [{id:"variant",...}] (an OpenCode model), whichever the model lists. NO --effort sends no options and the row stamps what the model defaults to: 'default (high)', or 'default (none listed)' when the model lists no default. T3's own 'ultrathink' (a one-turn prompt keyword, not a level) and OpenCode's variant words are refused at the flag as not a level. A level the tier's model does not list (--effort max on a model listing low..xhigh), a model that lists no effort or variant option, or a repo with no T3 project is a NAMED refusal BEFORE anything is queued (exit 2, no pending row); 'queue' skips that check and the launch refuses instead. A tier model missing from T3's short capabilities list is looked up by name (orchestrator_capabilities search) and used when found, not refused for being omitted. Recorded on the row (spinoff.effort) at queue time; the launch STAMPS the text it ran at ('high' | 'default (high)' | 'default (none listed)'), printed by 'ob spinoff show' as 'effort:' and by the queue/launched lines. Re-dispatching a still-PENDING ref with --effort re-rates it, as --tier does; an ADOPTED thread keeps its own effort (T3's thread record does not report one).
                            --opus-high '<his ask, quoted>' (OB-2107): Opus runs above its default effort ONLY when the owner explicitly asks. --effort high|xhigh|max on a tier whose model is Opus (after the urgent-forces-complex rule, so an urgent ticket on any tier) is REFUSED by name before anything is queued unless --opus-high quotes his ask; the quote goes in front of the dispatch's --note on the ticket's Decisions trail ('opus-high on the owner's ask: "<quote>"'). 'spinoff queue' runs this check too, a model-trial leg on Opus at high or above needs the same --opus-high, and a ticket made urgent after it was queued at one of those levels on a lower tier is refused at launch (re-dispatch it). Haiku, OpenCode models and --effort low|medium are never affected.
                            LAUNCHER RESOLUTION, most specific first: --launcher (recorded on THIS row at queue time) > spinoff_launcher_by_repo[repo basename] (when it names a known launcher) > spinoff_launcher > t3
                            --launcher routes ONE spinoff without touching global config: the drain honours the row's own value, so a queue-then-restore-the-setting sequence can no longer re-route it silently. An unknown value is a usage error, never a fallback
                            the ONLY routable launcher is t3 (ob 1109 retired the interactive app, 1589 removed headless); any other --launcher value — headless included — is a usage error naming t3, and 'ob config set spinoff_launcher' refuses one the same way. Rows that recorded headless still READ as headless
                            --launcher t3 (1120) opens a T3 Code THREAD: the launch claims the row, ensures the ob-owned worktree, then launches a thread in the T3 project whose checkout this repo is, bound to that worktree ({type:existing_worktree}, never a T3-created one), titled '<ticket> · <ticket title>' by ob, collapsing to the branch when the ticket has no title and to the number alone when that branch IS the number, with the TICKET'S BRIEF as its message (1162: its title + '## What to build' + '## Acceptance' + '## Do not', read off the checkout's wayfinder/tickets/<ref>-*.md at enqueue and stored on the row, then the directive to run the ob-spinoff skill; Context/Work log stay out, a long ticket is cut with a marker, and a --brief wins outright), the ticket's runtimeMode (frontmatter, default full-access) and the row's TIER model on the PROJECT's own provider instance (1480, see --tier) — a project with no default model is a NAMED refusal rather than a guess at whatever the catalog lists first. The thread id and run id are stamped on the row (spinoff.t3_thread_id/t3_run_id) and the agent row is registered with --launcher t3 and the thread id in session_id. ONE THREAD PER WORKTREE: every launch first looks for a thread already bound to this row's worktree (T3's own title filter, then the worktreePath as the identity — never the title) and ADOPTS it, so a launch that died between the launch and the stamp leaves exactly one thread when it is re-run. ob's queue states (queued/launching/building/handed-off/landed/failed, 1513) are unchanged: they are ob's, and T3 has no 'waiting to be launched for a ticket'. OVER THE API (SPLIT) it is the same in the same places: the queue is served and the launch runs HERE, where T3 is, so a client opens or adopts the thread locally and sends the ids in the stamp; nothing is deferred, and a host older than 1120 drops the two new stamp fields rather than failing
                            --repo accepts a local path OR an org/name slug (resolved: existing dir > repo_checkouts setting > ~/dev/<name>); --worktree points at an existing checkout explicitly and takes precedence over the derived <repo>.<branch> path, and adopts a branch already checked out elsewhere instead of failing
                            with remote_host set the enqueue is DISPATCHED, so --repo is resolved to a machine-independent SLUG on THIS machine first (217): the path is canonicalised (relative + symlinks), a wt worktree <repo>.<branch> yields its REPO's slug, and only that slug crosses the wire -- a path would otherwise be resolved against the SERVER's filesystem, which holds none of these checkouts. A path outside every checkout, or one no slug resolves back to, REFUSES here (naming what to add to repo_checkouts) instead of being dispatched; with no --repo at all the cwd is resolved the same way, here. The row then carries the slug, and the drain resolves it back to a checkout on the machine that launches it
                            the row also RECORDS the ob item it serves (spinoff.item_id, 1163), resolved on the machine that holds the tracker: the ref itself when it IS an item, the item LINKED to a #<n> issue, else the mirror whose own record names the wayfinder/tickets/<ref>-*.md path this ref is (a hand-charted ticket is dispatched by its wayfinder number while its ob mirror carries a different id, so the two are not the same number). Every join reads that identity -- settle-on-close, the Threads block in ob status, ob t3 tree/open -- and it is also listed by ob spinoff show/list. A ref that resolves to no item records NULL rather than a guess
                            with no --repo the repo is the TICKET'S OWN PROJECT checkout (OB-2130: repo_checkouts, else ~/dev/<project>), whatever the cwd, so 'ob spinoff SS-5' from the OmniSlash checkout builds in slashslash and says so on stderr ('SS-5 is a slashslash ticket: building in <path>'); 'spinoff brief' resolves the same way. A project with no checkout here, an item with no project, or a checkout that is already the cwd's repo keeps the cwd. --repo overrides both. A launch to a project checkout with no T3 project is REFUSED before any row or worktree exists ('no T3 project is registered for <path>')
                            otherwise --repo defaults to the cwd
                            a #<n> ref (e.g. '#35') resolves to that GitHub issue on wayfinder_repo, its title+body seed the brief, branch derived from it; a bare ref stays the ob/wayfinder path
                            always interactive (563): the T3 thread opens in the worktree with the TICKET'S BRIEF as its message (1162) — the ticket's title + what to build + acceptance + do not, then the directive to run the ob-spinoff skill; still no operating-procedure wrapper and no self-terminate. You steer; you hand it off (ob spinoff handoff / /ob-spinoff-handoff; the old ob spinoff ready and /ob-spinoff-done still work). --agent is a usage error. --interactive is a silent alias
                            THE ENGINE (spinoff_engine, 'claude' default) is resolved ONCE at launch (the same way the launcher is) and stamped on the row (spinoff.engine). It chooses the session scheme AND the token reader at reconcile: claude keeps its totals in ~/.claude/projects jsonl, opencode in its own SQLite session table, and neither can be read by the other's reader — so a later setting flip can never read a launched row's usage as zeros
  spinoff drain [--repo <slug|path> | --all] [--holder <id>] [--note <why>]   MANUAL one-shot (1589: no daemon job runs it any more): reclaim lapsed claims, reconcile landed, then launch the queued rows of ONE repo that are not lease-blocked (#97): the rows 'ob spinoff queue' left, or a legacy queue
                            SCOPED BY DEFAULT (OB-1796): the repo is the cwd's, resolved the way 'ob spinoff <ref>' resolves it; --repo <slug|path> names another; --all drains every repo and prints how many each launched. Another repo's queued row is neither claimed nor failed: it stays queued and the report names it as skipped. Run outside any resolvable repo it exits 2 (a usage error) naming why and launches nothing (it never falls back to everything). Reclaim and reconcile stay global (they judge merges, not launches). No confirmation prompt: an architect runs this unattended
                            agent count is not a reason to leave a row pending (ob 767): expired/stale builders do not occupy a launch slot; ob agent done is not required to free the next tab
                            a pending row whose ticket:/worktree: lease is held by another live session stays PENDING and is reported (⏸), never failed; it launches itself on a later drain
                            --holder <id> drains UNDER a lease you already hold (same flag as 'agent register', #75): the architect holding ticket:<n> for its gate is the one dispatching it, so its own
                            hold is compatible rather than a collision, and is left exactly as it is (not re-taken, TTL not shortened). A hold by any OTHER live holder still leaves the row pending (⏸)
                            SPLIT once remote_host is set (191): the CLAIM ('ob spinoff claim') and the STAMP ('ob spinoff stamp') run on the SERVER and the launch runs HERE, so the agents run on this machine while the rows move on the authoritative DB. The claim goes FIRST (it is the exclusion that stops two machines launching one row) and is ONE conditional UPDATE, so exactly one drain can win it
                            every pass starts with 'ob spinoff reclaim', which takes back rows a drain claimed and never stamped: the claim holds lease spinoff:<id> for 300s, so a machine that died mid-pass leaves a claim that LAPSES rather than a row stranded forever (bounded by the same launch_attempts retry as #151; the second abandonment fails the row terminally). OB-1921: a running launch heartbeats its claim, a claim lease that cannot be taken leaves the row pending, a launching row with NO claim on record is reclaimed once older than 300s, and launch_attempts is counted once per attempt, at the claim
  spinoff reconcile [--holder <id>] [--note <why>]   mark building spinoffs 'landed' once their branch merges into origin/main (local main when there is no origin, 1871) AND has commits past its captured base_sha (git-state + unique-commit gate, so a just-launched zero-commit branch is never flagged done), OR the ticket is done, OR a LANDING commit naming it is on origin/main (a merge subject, a conventional scope like 'feat(ob N)'/'chore(ob N)', or an explicit closing keyword like 'Closes ob N' -- never a 'chart('/'docs(' note, and never one older than the row's captured base_sha, 1201) (local main need not move; do not fast-forward it). a handed-off row lands on its branch being merged or on its ticket being DONE (1596: a squash never makes the branch an ancestor, and 'ob close' is the land), but a commit naming an open ticket does not retire it. folded into drain; 'ob close <ticket>' now marks that ticket's own building/handed-off rows landed itself (1589), so reconcile is the sweep for everything else
                            also MIRRORS every launcher-t3 row that is building or handed-off (never a merged or failed one) T3 run state onto its EXISTING AGENT row's 'run' field (1120/1189); it never creates an agent row: a missing one is reported as a skip (OB-1923), and a finished run (completed/interrupted/cancelled/rolled_back) no longer refreshes the row's heartbeat, so it ages out: the thread's own status verbatim (idle/preparing/queued/starting/running/waiting/completed/interrupted/cancelled/rolled_back), written to 'run' BESIDE ob's own workflow 'status', which the mirror never touches -- 'ob agents' prints them as 'status · run'. A pending question reads as 'waiting'. The spinoff QUEUE status is never touched (T3 has no 'waiting to be launched for a ticket'). A status this build does not know is REPORTED and written nowhere, and an unreachable T3 (or a machine with no credential) is reported per row rather than failing the sweep: the queue is fine, T3 is not
                            REFUSES to mark a row landed while a THIRD party holds its ticket:/worktree: lease (an architect mid-review); the row's own agent is not foreign, and landing releases that agent's leases
                            --holder <id> is not a third party either (#136): the architect named there IS the reviewer landing it, so its own hold does not block the landing it is performing
  spinoff watch [--once]    BLOCK, watching the DB dir; git-state reconcile on each change and print each newly-done spinoff (ticket·branch·outcome); --once exits 0 after the first NEW completion
                             fires on LANDED (merge into main) AND on HANDED-OFF (ob 391: a human handed the interactive spinoff to the architect to gate, branch need not be on main)
                            the ONE spinoff subcommand that is sqlite-only (337): its trigger is fs.watch on the database FILE, so under OMNISLASH_STORE=postgres it REFUSES by name rather than blocking forever reporting nothing -- poll 'ob spinoff list --status landed' there, or run it with OMNISLASH_STORE=sqlite
                            each completion is reported EXACTLY ONCE, persistently (spinoff.reported_at), so a fresh watch never replays the already-reported backlog and --once fires only on a genuinely new one
                            reported_at is stamped only AFTER the line is printed (74), so a watch killed mid-report re-reports that completion on the next run instead of losing it forever
   spinoff handoff [ticket|id] [--no-note] [--note <one-line summary>] [--report <file>] [--tier-fit lower|right|higher] [--tier-fit-why <one line>] [--ci-unchecked <why>]  hand a building interactive spinoff to the architect: the row becomes handed-off so the architect's watch fires (1513: 'ob spinoff ready' is an alias; a --status filter or API caller may still say ready-for-gate) (ob 391/426/471/577). that stamp is the human land yes: needs-human on the last commit does not block land (amends 442). blocked/partial/missing State still do not land. refuses if the worktree is dirty (prints the dirty paths; does not invent a commit), and refuses when that worktree does NOT EXIST or the row has already LANDED (1188): a checkout deleted with the land used to pass the dirty check meant to catch it, and a woken builder could announce MERGED work to the architect (nothing to gate; <ticket> landed as <sha>). either way: no stamp, no note. ONE EXCEPTION, because the cleanup is safe and the note is the hazard: a REPEAT on a row ALREADY handed-off whose checkout is gone still releases the builder's leftover ticket:/worktree: holds (426) and skips the announce with a named reason. no merge. does NOT call agent done. releases the BUILDER's ticket:/worktree: holds (holder = agent_id or branch, including worktree:omnislash.<branch>) so the architect can acquire them; never a team role's hold (341). a later agent register from that builder (heartbeat --note, session.idle --status needs-human) updates note/status only and does not re-claim those keys (577). already handed-off still releases leftover builder leases. --json leases_released is true when any were released. no arg → this worktree/branch. prints ticket, branch, worktree, State: and its reason line (1579), landable: yes, and architect: gate and merge the PR (the handoff is the human yes): since OB-1686 (#82) the builder opens the PR, hands off with its URL and stops (it never merges, deploys or closes), and the architect gates and merges it. --tier-fit (1552) is the builder's rating of its own tier: lower | right | higher (anything else is a usage error). Omitted, it prints a one-line hint and the handoff still goes ahead. Given, it lands on the ticket's Decisions trail as a 'tier-fit: <rating> (ran <tier> on <model>)' line with the reason, and in the readying note to the architect; --tier-fit-why adds the one-line reason. Each handoff records its own rating, so a repeat handoff adds a new one. --report <file> (OB-1992) puts the file's text (the Done check, the review, the gate line) on the ticket's Decisions trail with the note; a missing or empty file is a usage error before anything is stamped. In a CLEAN repo (every repo but OmniSlash) the handoff first reads the branch name, every commit message past main and the PR title and body (gh pr view) and REFUSES, naming each hit, when any carries ob: a ticket ref, a State:/Gate:/Visual: line, an ob command, or the words architect, spinoff, omnislash, AGENTS.md (not "builder", which is ordinary text). The diff is never scanned. Its verdict is the one recorded with 'ob spinoff state', and the readying note says so. OB-2044: a builder hands off only once its PR's CI passes. With an OPEN PR for the branch (gh pr list for the branch) the handoff REFUSES, stamping nothing, when the PR head is not your HEAD (push first), when any check failed (named, with its link; a conclusion other than success, skipped or neutral), when any check is still pending, or when no check has reported yet and the repo has a workflow that runs on pull_request (wait for the checks with 'gh pr checks <N>' in its watch mode). It also REFUSES with 'COULD NOT READ CI' when gh cannot be read (not installed, not signed in, network): CI is never assumed green. No open PR means no CI check (a blocked or partial row opens none); a repo with no pull_request workflow and no checks passes with 'no CI checks on PR #N'. A green PR puts 'ci: gate pass, ui-review pass on <sha7>' in the readying note's gate line and on the Decisions trail. the architect's own --no-note stamp is guarded the same way, so it stamps once the head's CI is green. --ci-unchecked <why> skips the read and records 'ci: UNCHECKED (--ci-unchecked: <why>)' on the trail and in the note (the human's /ob-spinoff-handoff too); a blank reason is a usage error.
                            ALSO TELLS THE TEAM (1133, OB-2255): the same command sends a readying note into the team thread of the ticket's project (the sentinel thread when the team has one, else the architect thread: the thread id off the 'sentinel-<team>' or 'architect-<team>' registry row that 'ob t3 sentinel|architect' recorded) with t3_thread_send and mode queue, so a busy thread is never interrupted. The note is COMPOSED from facts ob already holds and never re-typed: ticket, branch, worktree, commits ahead of the row's base_sha, the last State: line, the gate the builder reported (its latest 'agent register --status readying --note', read BEFORE the stamp overwrites it) and the review line inside that note. Anything ob cannot know is printed as unreported, never invented. Idempotent and re-announceable: the send carries a clientRequestId derived from the row and the branch's head SHA (OB-1805), so 'handoff' twice on one commit sends ONE note while any new or amended commit sends a second, different one; the output says 'note: queued for <sha7>', never 'told', because T3 does not report a dropped repeat. A team with no architect thread says so by name ('no architect thread: run ob t3 architect <team>'), a project in no team prints '<project> is in no team: ob t3 team join <team> <project>, or ob t3 architect in its checkout', and either way it still stamps; a legacy row that ran under the headless launcher sends nothing and reads no credential. A send that fails is a loud named warning and exit 1: the stamp and the lease release STAND, because a notifier is not a gate. Nothing parses a thread for landability: the State: trailer in git stays the verdict
                            AND THE NOTE DATES ITSELF (1267): T3 holds a QUEUED note until the architect's turn ends, the architect's turns are long, so a note can arrive after the work it announces has already landed (measured three times in one night: 738, 1189, 1190 (each costing a re-verification pass over work already landed). There is NO hook at delivery, so the note is composed as an unmistakable SNAPSHOT: 'row: <id> · <status> (as composed)' and 'composed: <iso timestamp> (T3 delivers a queued note when your turn ends)', plus a closing block naming the checks that answer 'is this still true?') 'ob spinoff show <row-id>' for the row's RECORDED status and 'ob spinoff gateable' (the list ob-land reads) for a merged row or a checkout that went with the land: and saying plainly that either way there is nothing left to gate. The first line is 'handed off: <ticket>' (1513; 'ready for the gate: <ticket>' before it), and ob close matches EITHER, so a queued note from before the rename is still withdrawn. The status and the timestamp are passed IN as facts, so the composer stays pure and its shape stays testable without a server
                            --no-note STAMPS ONLY (1205): the caller is the thread the note would be sent TO. ob-land has the architect stamp on the human's behalf (the stamp is the land yes and the human said land) so the architect's own gate action used to arrive minutes later, queued to the END of its own turn, as a message that looks like a builder's declaration (the 23:08 stale gate request for an already-landed 738). The stamp, the agent bump to readying and the builder lease release are unchanged; the announce prints a named skip instead of sending. Unrelated to what the note says: a BUILDER's stamp keeps announcing, and /ob-spinoff-handoff (alias /ob-spinoff-done) keeps announcing. Even a forgotten flag is not a hazard: ob close withdraws a note still queued in the architect's thread for the ticket it just landed (see close)
                            A SPIKE (OB-1826) hands off differently: a ticket tagged exactly 'spike' skips the dirty-worktree rule (it tries things) and may commit DOCUMENTATION ONLY past its base_sha
                            (OB-2227: a .md file outside apps/, platform/, domains/, skills/ and ops/; a deletion or rename counts as touching the path), else the handoff REFUSES naming each other path
                            (and refuses when git cannot say). It stamps nothing: the row stays building and never reaches 'spinoff gateable'; the architect's note says the answers are on the parent
                            (ob note) and to close the spike, and names the open PR for a doc commit (read with gh pr view; no PR or a gh failure never refuses, the note then has no URL). See 'spinoff check' for the gate and 'close' for the end.
   spinoff state <ticket|id> <landable|needs-human|blocked|partial> [--reason <line>] [--gate <line>] [--json]  (OB-1992) record a CLEAN repo's verdict on its spinoff row, since its commits carry no State: line. Every reader of the verdict (handoff, gateable, show, the readying note) reads the row first and falls back to the last commit's State: line when nothing is recorded. Refused for an OmniSlash row (its verdict is the State: line in the commit), for a merged row, and for any other word
   spinoff mix [--since <date>] [--json|-q]   read-only dispatch mix (1550): share of dispatches per tier against the 50/30/20 simple/medium/complex target, over the RATED rows only (a pre-0034 row with no tier cannot be placed and is counted in its own '(no tier)' line, never folded into medium), then per model and per work tag: count, landed, re-dispatched at a higher tier, blocked (failed), in flight. re-dispatched is DERIVED from later rows of the same repo+ticket, not stamped (a row with no tier stamp is never claimed re-dispatched); provider is not on the row yet and a missing model stamp is counted and said, never invented. --since keeps rows requested on/after that date. an ABANDONED row (1697) is excluded entirely (not a launch, not a landing) and counted in a note; no new tables, no writes; -q prints '<tier> <count> <pct>%' A closed spike (a failed row whose error starts 'spike:') is excluded and counted in a note, like an abandoned one.
  spinoff abandon <row-id|ticket> [--note <why>] [--force] [--json]   (1697) retire a launched-but-unbuilt spinoff the architect started by mistake, WITHOUT 'ob close' (which stamps it landed and poisons spinoff mix). In order: interrupt the row's T3 thread and wait for it to settle (a thread that will not settle refuses and changes nothing; --force retires the row anyway, warning exit 1), stamp the row failed with the error 'abandoned: <note>', release the builder's ticket:/worktree: leases and run 'agent done'. REFUSES a landed row, an already failed/abandoned one, and a row with commits past its base_sha (that work is a land or a needs-human; --force abandons it anyway) or whose commit count git cannot read. NEVER removes the worktree or branch: remove them with wt. A bare number is the row id, as in 'spinoff show'. Runs HERE (T3 is on this machine); the row and leases are written through the API in API mode
   spinoff sendback <ticket|id> --note '<what to fix>'   architect command (OB-1805): send a handed-off spinoff back to its builder. the row becomes building again (so 'ob spinoff gateable' stops listing it until the builder hands off again), the note is queued into the builder's T3 thread, and the builder is told to run 'ob spinoff handoff' when done. refuses by name when the row is not handed-off or has no builder thread, and changes nothing; --note is required. if T3 refuses the note the row is put back to handed-off and the error says so. a handoff's readying note is keyed on the row plus the branch HEAD SHA, so every new commit (or amend) sends the architect a new note and a repeat on one commit stays one; handoff prints 'note queued for <sha7>', never 'told', because T3 does not say when it dropped a repeat
   spinoff reopen <row|ticket> --note '<why>'   OB-2180: put a row that was marked landed by mistake back to building (e.g. a reconcile that landed it before its PR merged). refused for a row that is not landed, and for one reconcile would land again: its ticket is done (reopen the ticket first), a landing commit naming the ticket is on main since its base_sha (the sha named), or its branch is merged into main with commits of its own; the git checks read the checkout where the command runs (on an API client its own; the host only moves the row). the note goes on the ticket's trail. the builder's next 'ob agent register' brings back its agent row and ticket lease
   spinoff gateable [--team <name>] [--json|-q]   (--team, OB-2255: only rows a member project of the team built, matched by the row's repo slug or its checkout; an unknown team exits 1) architect list of handed-off spinoffs plus what to rebuild after land (454/471). no merge, no close, no drain, no watch. empty is exit 0. per row: ticket, id, branch, worktree, repo, last State: verdict plus its reason on its own marked line (1579: '🙋 needs you:' / '⛔ blocked on:' / '🧩 missing:', one line cut at a word boundary; an old wall-of-text State falls back to its first non-gate sentence; --json adds reason), landable (handed-off + State: landable (or the pre-1513 State: ready) or needs-human; blocked/partial/missing State/missing worktree are listed not-landable), a files: line (OB-2131: the planned files of the ticket's newest go check against the branch diff, 'files: <t> of <n> planned touched, <u> unplanned', plus '(read why: under half the planned files touched)'; or 'files: no go check', 'files: no planned files on the go check', 'files: no diff to compare'; --json adds files {planned, touched, unplanned}), rebuild from the locked path table (not moon affected). missing worktree still lists the row (rebuild = worktree missing) and does not fail the command. --json; -q = ticket ids only. runs HERE: store/API for rows, local git for diffs
   spinoff trial start --target <n> --a <provider:model>[#effort] --b <provider:model>[#effort] [--tier medium] [--a-price in,out,cw,cr] [--b-price in,out,cw,cr] [--name <n>]   (OB-1991) start a MODEL TRIAL: the next <n> dispatches at the trial tier (default medium), counted across every architect and repo from the store, each run TWICE from the same brief: leg a on --a, leg b on --b (branch, worktree, builder id and ticket: lease get a -b suffix). Neither builder is told. Prices are list dollars per million tokens (input, output, cache write, cache read). Refused while a trial is active. 'ob spinoff <ref> --no-trial' is one build; other tiers are never paired; a pair opens only while open plus recorded pairs are below the target. A leg whose launch fails voids the pair and the other leg goes on as a single build (the output says so). 'gateable' shows a pair as ONE entry with both row ids and a pair field, and no model
   spinoff trial status | stop    the active trial's counts; stop ends it and voids its open pairs, naming them (both legs keep building as ordinary rows)
   spinoff trial pair <ticket|#pair> [--diffs <dir>] [--json]   the BLIND view of a pair: labels X and Y, row ids, status, handoff; never a model or a branch. --diffs writes exactly X.diff and Y.diff into <dir>
   spinoff trial record <ticket|#pair> --x <0-10|blocked|partial> --y <...> [--notes <file>] | --forfeit <X|Y> | --void [--reason <why>]   the blind review's verdict: higher score wins, a TIE goes to leg a; blocked, partial or a leg more than 24h later than the other scores 0. The loser's row is marked failed 'lost trial pair <n>' (close its PR, deleting its branch, with a comment; land the winner only). --notes is JSON {X:{done:[bool...],defects:[...],notes:"..."},Y:{...}}, refused when its done count differs from the ticket's ## Done when. Stores per leg: wall, active, launch to landed, steers, gate first time, tokens (in, out, cache write, cache read), list-price dollars and opencode's own cost. --forfeit scores the named leg 0 (stale 24h, one leg handed off); --void drops the pair from the count (stale 48h, neither leg). The target-th verdict ends the trial
   spinoff trial feedback <ticket|#pair> --label <X|Y> --note <text> [--rating 1-5] | fix <ticket|#pair> --note <text>   the owner's feedback on a leg; a fix to the winner within 7 days of the verdict
   spinoff trial report [--json]   the ONLY place that unblinds: per pair (models, scores, winner, measures) and per-model totals. Dollars are list price times tokens, a comparison between the models, not the bill. A measure not taken reads 'not recorded', never 0
  spinoff show <ticket|id>  one row's full detail (the branch's State: verdict and its reason on one marked line, 1579; fields + brief, including the TIER it was rated and the MODEL its launch ran on, 1480; a --launcher t3 row also prints its T3 thread and run ids, 1120; and the ob ITEM the row serves when it differs from the ref it was dispatched with, 1163; and the files: line 'spinoff gateable' prints, OB-2131, --json adds files). never enqueues. numeric id = that row; ticket/branch = newest match
  spinoff list [--status <s>] [--team <name>]   (--team, OB-2255: as on gateable) queued/launching/building/handed-off/landed/failed launches (1513: --status takes either these words or the old pending/launched/ready-for-gate/merged; output prints only the new words), each with the LAUNCHER it went into (t3, or a legacy value such as headless on an old row, stamped at launch, or at QUEUE time on a row that named one with --launcher; '-' = not routed yet, resolved from config at drain), the ENGINE stamped beside it (claude|opencode, next to the launcher, WHERE the agent lives vs WHICH harness ran in it), and its token total (e.g. 106.5k tok: at reconcile the agent's usage is summed from the TRANSCRIPT SOURCE of the engine the row was STAMPED with, claude's ~/.claude/projects jsonl, or opencode's own session table, never from today's spinoff_engine; a pre-engine row reads as claude). --json adds landed: true when the ticket is done, or a LANDING commit (a merge subject, a conventional scope, or an explicit closing keyword, never a 'chart('/'docs(' note, and never older than the row's base_sha -- 1201) names it on origin/main (local main need not move). An API client reads done ids from one GET /items?status=done and origin/main on THIS machine (937); omitting the flag leaves a relaunch unable to close landed tabs
  spinoff check <ref> --architect <json|file> --checker <json|file> [--resolutions <json|file>] [--json|-q]   measure twice (OB-1825, OB-2131): compute and record the verdict for the item's current body. It gates on questions only: go = every checker question has a resolution; no-go = one has none, and the unresolved questions are printed with their text. Scores, gap, a 0 and disjoint file lists are printed as 'read:' lines (either side under 70, a criterion at 0, over 15 apart, no shared path) and stored; they do not refuse. --resolutions is a JSON list with exactly one entry per checker question, in order: [{"q":<1-based>,"how":"edit"|"dismiss","note":"<what changed, or why none is needed>"}]; a missing or extra index, an empty note or another how is refused by name. With no checker questions it is optional. Stored beside the checker sheet, which is kept as received. --questions-resolved is replaced by --resolutions and is refused. A body whose newest check is an old investigate or read the gap still refuses: check it again. --json adds read and resolutions. Exit 0 on go, 1 on no-go. Architect scores under 2 need low.<criterion>.why and .raises, or it records nothing. ob calls no model: the architect runs the checker (skills/ob-architect)
                            THE DISPATCH GATE: 'spinoff <ref>' and 'spinoff queue <ref>' refuse a NEW dispatch, leaving no row, with no '## Drilled' section, no '## Done when' item or no go for the item's current body (one refusal names every missing section) (a later edit or 'ob note' needs a new check). --no-check '<why>' overrides and goes on the Decisions trail; an empty reason is refused. A ticket with a LIVE spinoff row (queued, launching, building or handed-off) is a re-dispatch and is not gated; one whose only rows are failed or landed needs a fresh check (OB-1924), unless its ref resolves to no ob item, which is refused first
                            A SPIKE (OB-1826, a ticket tagged exactly 'spike', so 'spike-mechanism' is not one) is gated on its shape, not a score: the body needs non-empty '## Questions', '## Box' and
                            '## Done when' sections and an outgoing spun_off_from link to the ticket it serves (ob link <spike> spun_off_from <parent>); any missing piece is refused BY NAME, leaving no row.
                            It needs no recorded check; '--no-check' still overrides. It may edit, test and run commands, never commits or opens a PR, and answers with 'ob note' on the parent.
  spinoff brief <ticket> [--repo --branch --brief -]   print the launch message enqueue would store, dry-run, no launch (1162): the ticket's TITLE + '## What to build' + '## Acceptance' + '## Do not', read off the repo checkout's wayfinder/tickets/<ref>-*.md, then the directive to run the ob-spinoff skill. Context/Work log stay out; a long ticket is cut with a marker; no file -> the ob item's title+body; neither -> today's pointer text, unchanged; a caller's --brief wins outright
  spinoff cleanup [--repo <path>] [--dry-run] [--force]   HUMAN-RUN: remove worktrees + local branches left by DONE/merged tasks.
                            git state = source of truth: a worktree merged into origin/main (local main when it is ahead or there is no origin, 1760) AND clean → 'git worktree remove' + 'git branch -D' (-d judges against HEAD, stale when you land from a land worktree);
                            dirty/unmerged → SKIP with a reason (never deletes unmerged/dirty work); also prunes dangling merged branches.
                            SQUASH MERGES COUNT (OB-2141): a branch is also merged when a MERGED GitHub PR has it as its head ref AND that
                            PR's head sha equals the local branch tip (a branch that gained commits after the merge stays unmerged). One
                            paginated read per repo, uncapped: gh api --paginate repos/{owner}/{repo}/pulls?state=closed (gh resolves the repo).
                            If it fails (no gh, no network, no GitHub remote) every branch keeps the git-only answer and the summary
                            prints 'github: could not read merged PRs (<reason>); squash-merged branches were not recognised'. reconcile and
                            list's landed signal read the same merged set.
                            --dry-run previews only; --force also removes dirty/unmerged (git worktree remove --force + branch -D).
                            LIVE ROWS ARE KEPT (OB-2159), even with --force: a worktree or branch whose spinoff row (by worktree path or
                            branch) is queued, launching, building or handed-off is skipped with 'live spinoff row <id> <ref> (<status>):
                            retire it with ob spinoff abandon <ref> if it is stale'; the dry run lists it. A row read that fails skips
                            the candidate ('could not read spinoff rows: <reason>').
                            LEASED → SKIP even with --force: a worktree/branch another live session holds (worktree:<path> or a
                            ticket:<ref> mapped to it) is never removed; break it with 'ob lease release <resource> --force' first.
                            LIVE T3 RUN → SKIP even with --force (1120): a worktree a --launcher t3 row owns, whose thread has a
                            run in flight (an active run id, or a live status on a thread that is neither settled nor archived).
                            Could-not-tell (T3 unreachable, credential rejected, thread unreadable) is also SKIP, never remove.
                            IN USE → SKIP even with --force: a process launched from a path inside the worktree (same #121 process
                            table as the cleanup's own probe). Could-not-tell (unreadable table) is also SKIP, never remove.
                            Swept branches' agent-registry rows are marked done. Never touches the main checkout.
                            LOCAL BY DEFINITION (191): the git half always runs against the checkout you named, never the server's own clone of the same repo. With remote_host set it is SPLIT, and its whole database half is one 'ob agent done <branch>' per branch it removed, dispatched AFTER the removal
  spinoff claim --id <n> [--holder <id>]   SERVER side (191): atomically move ONE row pending→launching, take its ticket:/worktree: leases and answer with the row (--json). The drain's first step; also the way to hand-claim a row
  spinoff stamp --id <n> --outcome launched|failed [--worktree --base-sha --launcher --session --engine --t3-thread --t3-run --effort <stamped text> --raised --error] [--note <why>]   SERVER side (191): record what the launch did and register the agent. The command a partial-failure message tells you to retype. launched needs a launching (claimed) row; failed takes any live row; a landed or failed row is refused by name (OB-1920)
  spinoff land --id <n> [--input-tokens --output-tokens --cache-creation-tokens --cache-read-tokens --total-tokens] [--note <why>]   SERVER side (191): reconcile's write half: retire a merged row with the token totals read from the agent's transcript on the machine that has the worktree. Only a building or handed-off row lands; anything else is refused by name (OB-1920)
  spinoff tokens backfill [--since <date>] [--dry-run] [--json]   (OB-1993) recover the token count of LANDED rows that recorded none: each is read on THIS machine (its Claude transcripts, or opencode's DB for an opencode row) and the non-zero ones are recorded through a token-only write that refuses a row that is not landed or already has a count, and never changes a status. --dry-run lists what it would record and writes nothing; a row that reads zero here is printed as not recoverable. --since keeps rows launched on/after that date. Over the API the read is here and the write is the server's
  spinoff reclaim           take back rows claimed by a drain that never came back (claim lease lapsed): back to pending, or failed once the retries are spent. Run at the head of every drain; safe to run by hand. A crashed 'ob spinoff <ref>' (claim taken, never stamped) is recovered the same way

  standup save|set|latest|posted   save/set (stdin) · latest [--json] · posted
                            'posted' is a status, not a second timestamp: a standup carries ONE time, the moment its content
                            was assembled (generated_at, else edited_at), and both posted_at and the "since last standup"
                            boundary are set to it, so the next standup starts where this one's content ended.
  web [--bind <addr>] [--tls-cert <pem> --tls-key <pem>] [--prebuilt] [--app <name>] [--port <n>] [--no-sidecar-port]
                            build + self-host the read-only dashboard (production build) on :5050. Long-running (the daemon 'web' job supervises it).
                            OB-2199 step 1: --app <name> serves apps/<name> instead of the dashboard (refused by name when there is no such directory);
                            --port <n> sets the port (default 5050); --no-sidecar-port opens no standalone :5051 realtime listener and prints no
                            realtime line (the app's own serve.ts mounts its sidecar on its own origin). With --prebuilt, a missing apps/<name>/dist
                            refuses and names bunx moon run <name>:build.
                            OB-2160: --prebuilt serves the apps/dashboard/dist already on disk and never builds; it refuses to start,
                            naming the missing path, when that dist is absent. The server's unit runs it, and the deploy builds the
                            dashboard BEFORE the restart, so a deploy's restart is down for the process start, not the vite build.
                            Runs on POSTGRES since 337: the page, its realtime sidecar and its /api/whatsapp
                            routes all read through the configured store, so the dashboard is on the same engine as ob.
                            The dashboard AND its realtime sidecar (:5051) bind --bind, else OMNISLASH_WEB_BIND, else the
                            'web_bind' config row, else 127.0.0.1. Loopback by default: a laptop serves nobody but itself,
                            and a LAN bind (e.g. the always-on server's LAN address) is always something you typed.
                            0.0.0.0 binds EVERY interface. LAN only by house rule, never exposed past the router.
                            TLS (220) is OPT-IN and BOTH listeners take the same material, because the page derives its
                            socket's scheme from its own origin (https means wss). --tls-cert/--tls-key > OMNISLASH_WEB_TLS_CERT/
                            OMNISLASH_WEB_TLS_KEY > the web_tls_cert/web_tls_key config rows. Two outcomes (1383):
                            nothing configured = plain HTTP and no error (a laptop); configured = TLS or a refusal to
                            start. A cert/key that is ABSENT (not issued yet) or UNUSABLE (empty/not PEM/a directory/a
                            key readable beyond its owner) exits non-zero naming the path and the fix ('ob cert renew',
                            'ob cert status'): a configured install never falls back to cleartext. Issue the cert
                            BEFORE configuring it. Half a pair (cert without key) is a usage error.
                            OB-1933: a served cert with fewer than 7 days left prints a WARNING after the TLS line (an
                            expired one still serves, with the warning). A key that is not the cert's own is refused.
                            Exits with the serve child's code when it crashes; a forwarded SIGTERM/SIGINT exits 0.
  cert over the API (OB-1808): 'status' waits and prints; 'renew' starts a job and returns, --wait follows it
  cert status | renew [--force] [--staging] [--json]
                            the LAN certificate 'ob web' serves (220). Let's Encrypt over a DNS-01 challenge, driven by
                            lego (the 'lego_bin' row): no inbound connection, no port opened, no A record published. The
                            name ('tls_domain') resolves to the LAN address through a Pi-hole Local DNS record, and the
                            _acme-challenge TXT is written and deleted by lego through the Cloudflare API. The token comes
                            from the encrypted store ('cloudflare-api-token') into the child's environment only: never a
                            file, never a unit, never an argument, so never in 'ps' or the journal. Runs on the API host
                            (served from Postgres, 1615).
                            status: subject, names, issuer, days left, and where the material is. renew: issue or renew,
                            then install fullchain.pem (0644) + privkey.pem (0600) into 'tls_dir' atomically; the
                            dashboard picks new material up on restart. --force renews early, --staging uses Let's
                            Encrypt's staging CA (untrusted material, for a rehearsal that cannot hit a rate limit).
                            NOT configured ('tls_domain' empty) = "nothing to renew" and exit 0: it is a declared job, so
                            failing on a laptop that wants no TLS would raise a JOB FAILING alert every day for nothing.
                            OB-1933: status checks the pair 'ob web' serves (flag > env > config rows), else the 'tls_dir'
                            pair, and says which. Exit 1 (output still printed, JSON has ok/problems/paths_agree) when the
                            cert or key is missing, the cert is expired, the key has group/other bits, the key does not
                            match the cert, or the served and installed paths differ. Not configured exits 0. renew
                            installs the key first and the cert last (the cert rename restarts the dashboard).
  daemon install | uninstall | status       Mac launchd or Linux systemd --user. 1589 retired the spinoff-drain job, the only client job, so install writes NO drain unit; install and uninstall both REMOVE an existing omnislash-spinoff-drain unit / com.omnislash.spinoff-drain plist and say so, and say when no client job remains (server jobs live on the API host)
  deploy status | deploy record --target <t> --host <h> --unit <u> --sha <s> --result <ok|rolled-back|refused>
                             [--at <iso>] | deploy run [--sha <sha>] [--ssh]
                             the ob record of what is deployed, per target (582): ONE row per
                             deploy target (live omnislash-web on the API host, the 581 test/dev instance, ...) holding
                             target, host, unit, git SHA, at, and the last attempt's result. ob-deploy.sh writes
                             it on every run -- a deploy, a no-op ("already at SHA", which still refreshes the
                             row so what's live cannot go stale), a rollback (result=rolled-back, sha = what was
                             restored), a refusal -- so 'deploy status' answers "is that SHA actually serving?"
                             without grepping journalctl. status: one line per target (--json for the rows).
                             record: what the deploy scripts call, not a human guessing.
                             run (636, OB-1809): start live ob-deploy.sh fire-and-forget and return. It is
                             POST /deploys/run: the server starts omnislash-deploy.service, which is outside
                             the web service, so the deploy survives the restart of the API that started it.
                             Refused (exit 1) while a deploy is already running. Does not wait for
                             smoke/restart. Proof later is 'ob status' (live, when not ok) / 'ob deploy status'.
                             --ssh: the LAST RESORT for when the API is down: ssh-kick the script instead.
                             Never automatic, since a kick whose answer was lost may have started. An ssh
                             failure records refused for live, when the API can take it, and exits 1.
                             --sha (1534): deploy EXACTLY that commit. There is no deploy timer any more --
                             a land deploys its own squash SHA (ob-land step 5), so a deploy names what it
                             put live. If origin/main is not the pinned SHA by the time the server looks,
                             ob-deploy.sh refuses without fetching, building or restarting, and records
                             refused at the SHA still serving. A short (7+ char) SHA is accepted.
  vision compare <left> <right> [--as design|old|flag] [--design <path>] [--json] [--no-enforce]
  vision compare --as old|design --on <before-on> <after-on> --off <before-off> <after-off>
                            [--design <mockup>] [--json] [--no-enforce]
                            layout and chrome-tone mlx-vlm diff of two UI screenshots (468, 477, 480). LOCAL ONLY
                            (decision #31): one --image LEFT RIGHT plus one single-image chrome list
                            per side; nothing leaves the machine. Named listing-header chrome
                            (Chats/Calls and labelled chrome) is the set-diff of those two lists —
                            a two-image absent/present claim is dropped when both lists contain that
                            chrome and does not enforce-fail --as design. Inbox title / search-field
                            grey-versus-grey (lighter/darker same hue family) claims are dropped (480);
                            hue-family change or appear/disappear is kept. Two-image still reports
                            layout/geometry. --as design expects match (structure and chrome tone).
                            --as old reports only unless --on/--off or --design is set. --as flag
                            expects change. --off expects match (flag-off After must equal Before).
                            --on expects change (flag-on After must show new chrome). --design expects
                            match against After-on (or the positional right). Default: exit 0 only
                            when every implied expect holds. --no-enforce prints diffs and exits 0
                            after a successful model run. Usage errors exit 2. mlx/binary failure
                             exits 1 and never invents diffs. Ignore copy/names/numbers/dates/avatars/
                              mocked fixture text. Structured walk: icon tone, label/count baseline,
                              row pad, selected wash, bounded list well (N/A if that chrome is absent).
                              Page-title grey-versus-grey is not a diff. Report structure and chrome tone
                              (idle vs active, icon vs label, fill vs page).

T3 Code (1102), the execution-plane seam:
  t3 doctor                 is the ob→T3 transport healthy, end to end, with NAMED failures and a
                            one-line remedy per stage: server reachable, version + channel (drift against
                            the map's pinned build is reported, not fatal), credential present and valid
                            (expiring when), which projects are mapped, which provider instances and
                            models are advertised. Exits 1 naming the FAILING stage when the server is
                            down or the credential is stale/missing; exits 0 otherwise.
  t3 login [--ttl <ttl>] [--access <level>] [--base-url <url>]
                            mint (or renew) the MCP credential and store it OUTSIDE the repo, mode 600
                            (path in doctor's output and docs/t3-integration.md). T3 advertises no refresh
                            grant, so renewal is re-minting: this is that path, and doctor points here.
                            Uses MCP OAuth (authorization-code + PKCE) approved with a one-time
                            't3 auth pairing create' code, so no browser is needed. The credential is a
                            30-day bearer; --access picks the MCP level (default full-access, the level
                            whose scopes cover launch + update).
  t3 team add <name> [--projects <a,b>] [--icon <emoji>] [--display-name <text>]
  t3 team edit <name> [--icon <emoji>] [--display-name <text>]
  t3 team join <name> <project>... | t3 team leave <project>...
  t3 team list [--json|-q] | t3 team show <name> [--json|-q] | t3 team rm <name> [--force]
                            teams (OB-2255): one or more projects that share one architect thread (drills, checks,
                            dispatches; the team's point of contact), plus an optional sentinel thread (gates, merges,
                            deploys, closes) and an optional muse thread (captures a ramble, verifies it, then tickets
                            it). Names are lowercase letters, digits and hyphens. add: makes the team and joins
                            --projects; a re-add with the same labels answers with the name, different labels exit 1
                            and point at 'team edit'. edit: '' clears a label. join: a project is in at most one team,
                            so joining a project that is in another team exits 1 naming it (leave it first); an
                            unknown team or project exits 1. leave: the projects leave whatever team they are in.
                            list: name, icon, display name, members, role=thread pairs, tab-separated ('-' when none).
                            show: the members and each role's thread with its agent row and pin, or 'none' with the
                            command that adds it. rm: exits 1 while the team has members or role rows; --force clears
                            both (members leave, the <role>-<name> agent rows go, and their threads are unpinned,
                            warning when T3 refuses). Notes already sent to a thread stay there.
  t3 team handoff <team> --role <architect|sentinel|muse> --body-file <file> | --body <text>
  t3 team handoff <team> --role <role> --show [--json|-q]
                            a role thread's handoff (OB-2257), held by ob through 't3 team restart'. The old thread
                            runs it when the restart asks: everything its replacement needs to carry on (work in
                            flight, what it waits on, open questions, its scheduled tasks' prompts). The row records
                            the thread that wrote it ('from' in --show): T3CODE_THREAD_ID when run inside T3, else
                            the role's bound thread (OB-2275). A handoff written by a thread that is no longer the
                            role's bound thread (a replaced thread still reporting) is queued to the bound thread
                            and marked consumed at once, so it never seeds a later restart; a failed forward leaves
                            it unconsumed and exits 1. --show prints the newest (exit 1 when none); -q prints only
                            the body. Stored in team_handoff (migration 0050); over the API via
                            /teams/<team>/handoffs.
  t3 team restart <team> | --all [--role <r>[,<r>]] [--force] [--timeout <minutes>] [--json|-q]
                            replace each bound role thread with a fresh one that carries on its work (OB-2257), one
                            role at a time, architect, sentinel, muse; --role limits it, --all does every team. Per
                            role: a thread with a run in flight, a pending request or queued messages is skipped
                            naming why (--force interrupts it and goes on). The thread running the command
                            (T3CODE_THREAD_ID) is always skipped, --force or not: run it from a terminal or another
                            thread. ob sends the thread a queued handoff request (write
                            it, record it with 't3 team handoff', then delete your own scheduled tasks), waits up to
                            --timeout (default 15) for the handoff with a heartbeat line each minute (none in time:
                            skipped, the old thread stays bound), waits for the thread to go idle, settles and unpins
                            it, opens the new thread in the same T3 project (bound to <role>-<team>, titled, pinned,
                            auto-settle off) and seeds it with '/ob-<role>' plus the handoff to carry on from, then
                            marks the handoff consumed, and queues one line with the new id ('<team> <role> moved to
                            thread <new> (was <old>)') to each other live role thread of the team and each building
                            spinoff thread of its projects, not the caller (OB-2275). A restart seeds only from a
                            handoff the replaced thread wrote. Scheduled tasks cannot move: the new thread re-creates them
                            from the handoff. A re-run resumes: a thread settled after its handoff is replaced from
                            the held handoff without asking again. Exit 1 when any role failed or was skipped for a
                            reason other than having no thread. -q prints the new thread ids.
  t3 architect [<team>] [--thread <id>]
                            ensure the team's ONE architect thread. Idempotent by THREAD ID, never by title: agent row
                            'architect-<team>' (launcher t3) carries the thread id in session_id, so a second call
                            reads the thread back and says 'already live ... nothing created'. A thread that is
                            settled, archived or gone is replaced. With no <team> it takes the team of the project
                            whose checkout holds the cwd; a project in no team becomes a team of one under its own
                            name, and stdout says so. A new thread opens in the cwd's checkout on its T3 project's
                            default model, seeded once with '/ob-architect' plus one orientation line; --thread <id>
                            ADOPTS that live thread instead (the one the architect skill runs in, from T3's
                            t3_thread_configuration) and is never seeded; refused when the thread is not live or a
                            different live thread is already recorded. Every call titles the thread
                            '<icon> <display name or name> · architect' (e.g. '⚔️ Slash · architect'), PINS it and turns
                            its AUTO-SETTLE OFF (T3's global setting is untouched, so builders keep the sweep); if T3
                            refuses auto-settle the title stands, a warning names the thread and the sidebar fix
                            (Auto-settle behavior, Disabled), and it exits 1. Refuses by name when the checkout is not
                            a T3 project or the project has no default model. --json is the outcome; -q the thread id.
                            SPLIT: the T3 calls run here; the team and the agent row go over the API on a client.
  t3 sentinel <team> [--thread <id>] | t3 sentinel <team> --remove
  t3 muse <team> [--thread <id>] | t3 muse <team> --remove
                            the same as 't3 architect' for the optional roles (rows 'sentinel-<team>' and 'muse-<team>',
                            seeded with '/ob-sentinel' or '/ob-muse'), but <team> is required. --remove drops the row
                            and unpins its thread (an unpin failure warns on stderr; the row still goes).
                            HANDOFF ROUTING: 'ob spinoff handoff' sends its readying note to the team's sentinel thread
                            when one is bound, else to its architect thread, and 'ob close' withdraws a held note from
                            the same thread. A project in no team sends no note and prints
                            '<project> is in no team: ob t3 team join <team> <project>, or ob t3 architect in its
                            checkout'; the stamp stands either way.
                            Every 'ob t3' subcommand refuses a flag it does not read with exit 2, before any T3 call.
  t3 broadcast architects <message> [--message-file <path>] [--dry-run] [--json|-q]
  t3 broadcast threads <message> [--message-file <path>] [--dry-run] [--json|-q]
                            send one message to every ACTIVE architect, or to every active T3 thread
                            (OB-2187). Active is T3's own active list: not settled, not archived, top level
                            (no subagents), in every project, running or idle. architects: the recorded
                            thread of each architect-<team> row and nothing else (OB-2255; no title matching).
                            threads: every active thread, architects included. The caller's own
                            thread (T3CODE_THREAD_ID) is left out and named as skipped. Each send is
                            QUEUED (arrives when that thread's turn ends, never interrupts a run) and keyed
                            on the message as delivered (sender line included) and the thread, so
                            re-running the same broadcast delivers it once.
                            The message gets one leading line, 'Broadcast from <sender> to all active
                            <audience>:', and is otherwise sent as given. --dry-run lists the recipients
                            and sends nothing. One line per thread (sent, skipped and why, FAILED and why),
                            then a count; exit 1 if any send failed. An unreachable T3 fails before any
                            send. An empty message refuses. No prompt: it stays inside T3.
  t3 status [--json|-q]     what T3 is doing, without a browser (1124): the HEALTH stages 'ob t3 doctor'
                            computes (server, credential, version -- the same measurement, never a second
                            implementation), then every project's threads NEWEST FIRST with their status,
                            settled flag, pending-question count, branch, worktree and the ob ticket/row
                            each belongs to (joined by spinoff.t3_thread_id, or the architect's agent row --
                            IDS, never a parsed title). The ticket shown is the ob ITEM the row records
                            (spinoff.item_id, 1163), falling back to the ref the row was dispatched with,
                            so a hand-charted ticket reads as its mirror id rather than the wayfinder
                            number its worktree is named after. Threads needing the human are listed again under
                            'needs you': the INTERIM rule is pendingRequestCount > 0 or a waiting run
                            (wayfinder 1103 item 7 has not landed; when it does, it replaces this, it does
                            not extend it). Subagent threads are excluded -- ob launches top-level threads
                            and stamps rows on those. Unreachable T3 or a rejected credential: the health
                            stages are printed and the command exits 1 naming the remedy ('ob t3 doctor' /
                            'ob t3 login'), never an empty successful list. An unreadable thread, a
                            truncated page, and a failure of the OB ROWS (which leaves the threads shown
                            unattributed rather than hiding them) are each named; the rows case exits 1
                            too. -q = thread ids, or the reason there are none.
  t3 projects [--json|-q]   T3's registered projects, read LIVE: id, title, workspaceRoot, repository
                            identity, default model and script count (1124). Deliberately NOT mirrored
                            into an ob table: 1120 resolves the project from the checkout, so a copy would
                            be a second truth that goes stale the first time a project is renamed. -q = ids.
  t3 tree [--subagents] [--json|-q]
                            the architect -> builder graph (1124): T3's own parentThreadId /
                            relationshipToParent over the threads, joined to ob's rows so each node names
                            its ticket (or its architect agent id, or '-' when T3 has a thread ob knows
                            nothing about). A node whose parent is not in the set is a root -- the normal
                            case, because ob's builders are TOP-LEVEL threads in their project (the map's
                            decision): the project group is the tree, and only a delegated subagent nests.
                            Subagents are EXCLUDED by default; --subagents includes them. Read-only. An
                            unreadable thread or a truncated page is NAMED in the human output too (the
                            same diagnostics --json carries -- an incomplete tree must not read as a
                            complete one), and a failure of the OB ROWS is its own line, with the nodes
                            shown unattributed and the exit code non-zero.
  t3 open <ticket|thread-id> [--json|-q]
                            resolve a ticket's stamped T3 thread and print T3's own link for it,
                            t3-thread://v1/<threadId> (1124). A ticket matches a spinoff row's ticket ref
                            or branch, newest row first; anything with a colon (or a bare uuid) is taken
                            as a thread id. The thread is then READ from T3, so a stale id fails loudly
                            instead of printing a link to nothing, and an unreachable T3 fails like every
                            other read command. The CLI cannot focus a GUI window: it prints the link, and
                            T3 Code opens the thread from it. -q = the link alone.

Sources (126/127) — Gmail + Calendar (ingest + write scopes; never auto-sends):
  google auth [--client <client_secret.json> | --client-id --client-secret] [--scopes <s,...>]
                            loopback OAuth on THIS machine -> secret 'google' (offline).
                            default scopes: gmail.modify + calendar (read/write; not mail.google.com).
                            API client (420): RUNS here (browser + 127.0.0.1), persists via
                            secret set google (host store). Creds: those flags, else secret google (424).
  google auth-url           print the HOSTED authorize URL for tap-to-reauth (1305): SERVED over the
                            API -- the API host mints a one-time state, the phone finishes consent at
                            /api/ob/google/callback, and the token is stored as secret 'google'
                            the same way. Needs the API client (OMNISLASH_API / ~/.omnislash_api_url);
                            'google auth' above RUNS here (the desktop loopback path) and is unchanged.
                            Redirect URI must be registered in the Google console: pin it with
                            'ob config set google_oauth_redirect_uri <uri>' (else derived from
                            the request origin).
  gmail sync [--backfill] [--days N|--since <when>|--query <q>] [--max N]
                            poll Gmail into email_message (+FTS); history cursor.
                            backfill is bounded to a recent window (default the last 30 days,
                            fixed as after:<seconds> when it starts); --query is a raw Gmail
                            query (overrides the window); --max caps messages fetched per run
                            (default 500). a capped backfill resumes on the next run with the
                            same window, older mail first; once the window is listed out the
                            cursor is the profile historyId read when the backfill started.
                            a 404/403 on one message is skipped (cursor still advances);
                            a 404 on history.list (stale historyId) falls back to bounded backfill;
                            only session-bad errors abort (401, quota, timeout, network).
                            Google HTTP calls time out (30s) so a hang cannot hold the job.
                            SERVED over the API (415): runs ON THE HOST using secret 'google'.
  gmail search <query>      FTS over ingested email (subject+body).
                            SERVED over the API (415): the rows live in Postgres.
  gmail list [--since --limit]   recent ingested email.
                            SERVED over the API (415), same reason.
  gmail read <message-id> [--json]
                            one message, read-only (1680): from/to/cc/date/subject, the text body
                            (text/plain, else the html stripped to text) and its attachments (filename,
                            mime, size, attachment id). SERVED over the API: runs ON THE HOST.
  gmail attachment <message-id> [--name <filename>] [--out <dir>] [--force]
                            save a message's attachments (all, or the one --name) and print the paths
                            (1680). Default dir $TMPDIR/ob-gmail/<message-id>/. Never overwrites: if a
                            file exists it refuses before writing any (--force replaces, or pick
                            another --out). The file is written on THIS machine. SERVED over the API.
  gmail draft --to <addr> [--subject <s>] --body <text>|--body-file <file> [--cc <addr>] [--reply-to <message-id>]
              [--from <addr>] [--attach <file>]...
                            create a Gmail DRAFT and print its id + a preview (1757). Never sends.
                            --reply-to threads it on that message (subject defaults to 'Re: ...');
                            --body-file is read on THIS machine. SERVED over the API: runs ON THE HOST.
                            --attach <file> (repeatable, 1680) makes it multipart/mixed; the files are
                            read on THIS machine (10 MB total), and the preview lists each one.
                            --from <addr> (OB-1961) sends it as one of your Gmail Send-as addresses: the address
                            must be listed in Gmail and be the primary or verified, else it refuses (exit 2)
                            naming the usable ones. A new address is added in Gmail's Settings > Accounts >
                            Send mail as. The preview always has a from line ('Gmail default' when unset).
  gmail drafts [--limit N]  list your Gmail drafts, newest first: id, recipient, subject (OB-1750; default 20).
                            Trashed drafts are listed too, marked [trash] (OB-1752). Reads only. SERVED over the API: runs ON THE HOST.
  gmail draft-edit <draft-id> [--from <addr>] [--to <addr>] [--cc <addr>] [--subject <s>] [--body <text>|--body-file <file>]
              [--attach <file>]... [--no-attach]
                            change an existing draft IN PLACE (OB-1750; the id stays). Only the fields you pass
                            change: --cc '' clears Cc, --attach replaces the files, --no-attach drops them, and
                            with neither the files, thread and reply headers are kept. The draft is rewritten
                            as plain text. --from <addr> replaces the From (same Send-as check as draft);
                            without it the draft's existing From is kept. Never sends. SERVED over the API: runs ON THE HOST.
  gmail draft-delete <draft-id> --confirm
                            delete a draft (OB-1750). Gmail removes it outright (no Trash), so without --confirm
                            it prints the draft and refuses (exit 2); --yes is not --confirm. Never sends.
                            SERVED over the API.
  gmail send-draft <draft-id> --confirm --hash <hex>
                            send an EXISTING draft. Without both --confirm and --hash it prints the draft
                            with its hash and refuses (exit 2); --yes is not --confirm. The host re-reads
                            the draft and sends only while it still has that hash (it covers the From
                            too, OB-1961), so an edit after the preview refuses (exit 2, naming the new hash); a draft in Trash never sends
                            (OB-1910). There is no one-shot send. Agents draft; only a human's word sends.
                            SERVED over the API.
  cal sync [--backfill] [--since <when>] [--max N]
                            poll Google Calendar into calendar_event (syncToken cursor).
                            full sync is bounded to the last 30d forward (--since to widen);
                            --max caps events processed PER CALENDAR (default 500).
                            SERVED over the API (415): runs ON THE HOST using secret 'google'.
  cal agenda | agenda       today's events (the South African day; clock times in SA time).
                            SERVED over the API (415): the rows live in Postgres.
  whatsapp sync [--backfill] [--since <when>|--days N] [--max N]
                            (an API client: a host job it follows, OB-1809)
                            ingest the WhatsApp bridge's messages.db (READ-ONLY; never sends) into
                            whatsapp_message (+FTS); cursor on the bridge timestamp. Ordered
                            oldest-first + capped (--max, default 2000) so a big history resumes
                            across runs. Senders map to a person via person.whatsapp_jid. A
                            delivery/read receipt only moves forward (sent<delivered<read<played) and
                            each run re-reads the last 48h of outbound receipts, so one that lands
                            after the cursor passed its message still arrives (1936).
  whatsapp search <query>   FTS over ingested WhatsApp messages (content, voice
                            transcripts, image descriptions).
                            SERVED over the API (366): the rows live in Postgres.
  whatsapp recent [--limit N] [--since <when>]   most-recent ingested messages.
                            SERVED over the API (366), same reason.
  whatsapp send --to <jid> (--body <text> | --file <path>...) [--yes] [--resend]
                            send a WhatsApp message via the bridge (ob→127.0.0.1 only; an API client
                            goes through POST /whatsapp/send, which reaches the server's bridge, and
                            sends each file in its own request, up to 11.9 MB each).
                            --file <path> (repeatable, ob 1683) attaches a PDF (as a document, with its
                            filename) or a jpg/png (as an image); --body becomes the caption of the
                            FIRST file. One message per file. Any other file type is refused. The gate
                            also lists each file's name, size and mime.
                            HARD safety gate: prints the recipient + full message and requires an
                            interactive y/N confirm before sending; --yes/-y skips the prompt (still
                            a human typing it). Over the API the gate is on this terminal, and the
                            server refuses a body without confirm:true. Nothing is retried: when the
                            answer is lost the error says to check 'whatsapp recent' first.
                            OB-1909: a bridge 5xx (it may have gone) is recorded, and for 24 h an
                            identical send (same recipient, text, file name and size) refuses until
                            you check the chat; --resend sends it anyway. A multi-file send that stops
                            part way names what went and prints the command for the rest.
                            Records an event(source='whatsapp', type='sent').
                            On success it also PERSISTS the sent message into whatsapp_message right
                            away (reading the bridge's messages.db READ-ONLY for the real message id),
                            so it shows in the thread immediately instead of on the next 60s sync;
                            --json reports that id (null when it could not be resolved, in which case
                            the sync backfills the row as before).
  whatsapp bridge run|start|stop|status
                            manage the local Go bridge's lifecycle. Over the API only status is served
                            (a host job); the rest is the server's own process, and refused. run: FOREGROUND, blocking (the
                            ob web model) — spawns the binary at whatsapp_bridge_bin and waits on it, so
                            the whatsapp-bridge daemon job (KeepAlive+RunAtLoad) supervises the real
                            process (crash → immediate restart). start: same spawn but DETACHED +
                            returns (manual/interactive). Both use cwd=the bin's dir, env
                            WHATSAPP_BRIDGE_PORT parsed from whatsapp_bridge_url, log
                            ~/.local/share/omnislash/logs/whatsapp-bridge.log + a pidfile, and refuse on
                            missing binary / port-in-use - an occupant matching our pidfile pid or the
                            bridge's own executable path is OURS, never called foreign (#119). stop kills
                            it (pidfile, else the port's listener when it is verifiably ours). status →
                            one of four states: down · not authenticated (needs a QR) · healthy ·
                            unknown, each printed with the signals it came from and what they do NOT
                            prove (the bridge has no auth endpoint: /api/health reports the websocket
                            transport, the log tail is the direct session reading, the pairing store
                            only proves a session existed, messages.db only proves past ingest). When
                            the log names a cause it is named (1347): a 405 'Client outdated' means the
                            bridge's whatsmeow library is older than the client version WhatsApp now
                            accepts - the session is FINE and the fix is a rebuild
                            (the bridge build script), never a re-pair; a stale
                            'logged-in' line in a log nobody has written to recently is read as history,
                            never as the current session. A zero-result 'whatsapp sync' says which kind
                            of zero it was. A process holding the port that matches neither our pidfile
                            nor our binary is NOT our bridge: running=false, state unknown, with the pid
                            and executable named - it is never asked /api/health and never called healthy
                            (1936). Re-auth is HITL: ob prints the instructions, tail the log + scan the
                            QR yourself.
  whatsapp bio [<text>] [--clear]
                            global self-bio (#28): a short "about me" woven into EVERY suggested reply
                            as a trusted block. No text → show the current bio; <text> → set it;
                            --clear → remove it. Stored in the self_bio config, applies to all chats.
  whatsapp hide|show <chat_jid>
                            per-chat pref (169): hide drops a chat from the dashboard feed; show
                            un-hides it. 'whatsapp show' with no jid lists the hidden chats. Keyed by
                            the CANONICAL jid (an @lid + its phone-jid share one pref).
  whatsapp ai-off|ai-on <chat_jid>
                            per-chat pref (169): ai-off disables Claude-suggested replies for a chat
                            (dashboard hides Suggest + the server refuses); ai-on re-enables them.
  whatsapp favorite|unfavorite <chat_jid>
                            per-chat pref (190a): favorite marks a chat a favourite (the dashboard feed
                            shows favourites-first); unfavorite clears it. 'whatsapp favorite' with no
                            jid lists the favourited chats. Same canonical-jid keying.

Entities (v3):
  add --type roadmap  <title> [--target-date --source-ref --owner]
  add --type decision <title> [--context --choice --rationale --alternatives]
  add --type learning <title> [--learn-kind --progress --source --why]
  memory add "<fact>"       append a bullet to this machine's MEMORY.md (XDG
                            ~/.local/share/omnislash/MEMORY.md, override OMNISLASH_MEMORY_PATH),
                            cap at 4k chars by dropping oldest bullets, and
                            add --type learning the same fact. Local file; OpenCode
                            prepends the capped file into session context (740).
  memory show               print MEMORY.md (empty file → empty stdout)
  roadmap [list | <id>]     roadmap view + progress / on-track
  decision [list | <id> | supersede <new> <old>]
  doc [list [--project <p>] | add <title> --project <p> --body <text>|--body-file <file> | show <id|ref> [--version <n>] | history <id|ref> | set <id|ref> --body <text>|--body-file <file> [--title <t>]]
                            reference documents (OB-2004): living "what is currently set" records, e.g. a dating profile.
                            Not tasks: never in 'ob next', 'ob list --open', 'ob status' or the aging alert, no status to move
                            ('ob close/start/block' refuse). Filed under a project (--project is required on add); found by
                            'ob search'; 'ob show' works on one. Every change to the title or body ('doc set', 'ob edit', 'ob note')
                            keeps the text it replaced: 'doc history' lists those versions newest first (1 = oldest) and
                            'doc show --version 1' prints the original byte for byte. --body-file is read on THIS machine.
                            'ob rm' removes one. SERVED over the API.
  learning [list | <id>]
  review-miss add --pr <url> --class <tag> "<finding>" | review-miss top [--scope <s>]
  review readers [--tier simple|medium|complex] [--json|-q]
                            the skeptical-review readers and their models per task tier (OB-2173): the server's review_readers
                            setting, the one the dashboard's Reviewers page edits. No --tier prints every reader, its model and
                            the tiers it is on; --tier prints that tier's readers as '<leg> <model>' (-q: leg names only, one per
                            line, what a builder's review runs). Unset = opus, deepseek and luna on every tier.
  review readers set <leg> --model <id> | review readers rm <leg> | review readers tier <tier> <leg>...
                            set adds a reader or changes its model (a new reader joins no tier); rm removes one from every tier,
                            refused while it is a tier's only reader; tier replaces that tier's list. Every tier keeps at least
                            one reader and names only readers that exist, or the write is refused by name. A leg is
                            [a-z0-9-]+. SERVED over the API (the config table).
  test-user add <label> [--role --email --workspace --env --secret-ref --notes] | list | show <label> | check <label>
                            test-account registry — secret VALUE read from stdin on add, stored in the encrypted secret store under test-user:<label> (not the Keychain)

People (v5):
  person add "<real name>" [--role --github --linear --linear-name --slack --slack-handle --whatsapp-jid --email --notes
                            --relationship --comms-style --comms-notes --id-number]
  person set <id> [<same flags>] | person list | person show <id|handle|name> [--reveal] | person rm <id>
                            --id-number is a SA identity number and is MASKED (...1083) on every output
                            path, JSON included; only 'person show --reveal' prints it in full, and
                            'person list'/'whois' never do (a transcript or screenshot is the real leak)
  whois <handle>            resolve any github/linear/slack handle or email -> the person
  tournament add --subject <text> --repo <slug> --criteria <a,b,...> [--ref <ticket>]
                            start a persona tournament (OB-2271; rules OB-2038) and print its id. The criteria are
                            what every reader call scores, 1 to 5 per side with a reason
  tournament candidate <id> <key> [--label <text>] [--image <path>]... [--revises <key>]
                            register a candidate, or update the fields given (images are repo-relative paths)
  tournament record <id> --match <file> [--replace]
                            store one match file the runner wrote: {name, round, x, y, winner, tally?, calls:[{persona,
                            model, fallback, order 1|2, a, b, winner A|B, winnerId, why, changes, scores:{<criterion>:
                            {a, b, why}}}]}. ob validates and stores; it never decides a winner. Refused, naming why:
                            a score not an integer 1 to 5, a declared criterion or its reason missing, an undeclared
                            criterion, winner not x or y, winnerId not a or b, a top-level 'scores' (rename it
                            'tally'), or a match name already recorded (--replace overwrites it in its place).
                            Candidates the file names that are not registered are created with no label
  tournament pick <id> <candidate> [--note <why>]
                            the owner's pick between the finalists; the tournament reads picked
  tournament list [--repo <slug>] [--json|-q]
                            every tournament: id, repo, open or picked, subject, candidate and match counts
  tournament show <id> [--json]
                            subject, criteria, candidates, matches in recorded order (round, winner, call count;
                            --json carries every call's scores and any tally), the finalists (x and y of the last
                            Rematch, else Final) and the pick. Each subcommand refuses a flag it does not read
  overnight start [--project <p>] [--date YYYY-MM-DD]
                            the overnight decision log (OB-2097), in ob, not a file. Creates the night's run doc
                            (an 'ob doc' titled 'Overnight review: <project>, <date>', tagged overnight) from the
                            summary template, or prints the existing one. --date defaults to today (local), the
                            night the run started; the project to this checkout's (as 'ob add' infers it)
  overnight decide "<title>" --what <text> --why <text> [--doubt <text>] [--undo <text>] [--context <text>]
                            [--project <p>] [--night YYYY-MM-DD]
                            record a decision: an accepted decision item in the project (what in choice, why in
                            rationale, doubt and undo in their own fields; missing ones show 'not recorded').
                            --night joins it to that night's run (tag overnight:<date>) and is refused when the run
                            does not exist; without --night it is a daytime architect decision. A later change is an
                            'ob note' on the decision, or a new decision that supersedes it
  overnight summary shipped|review|skipped|next --add <line> [--project <p>] [--date YYYY-MM-DD]
                            append a bullet to that section of the night's summary (replacing '- none'); each edit
                            is a doc version. --date defaults to the project's latest run
  overnight show [--project <p>] [--date YYYY-MM-DD] [--json]
                            the night: summary, then its decisions in the order made with what, why, doubt, undo
                            and notes; a summary whose four headings are missing, extra or out of order prints a
                            'problem:' line. --date defaults to the project's latest run
  overnight list [--project <p>] [--since YYYY-MM-DD] [--check]
                            one line per run: date, project, decision count, Review these count. --check exits 1
                            naming each run whose summary headings are wrong

Admin:
  project add <name> --kind <k> [--remote <url>] [--key <KEY>] [--icon <emoji>] [--display-name <text>] | project list
                            (list: id, kind, name, remote, key, icon, display name, stage, tab-separated; every column on
                            every row, the stage '-' when unset)
                            --key (1949) sets the project's ref key: 2-4 letters A-Z, unique (a taken or malformed key exits 1;
                            over the API 409/400). Without --key an agreed project takes its agreed key (omnislash OB, pixelslash PS,
                            hackcove HC, acme-shop TH, advisor-quotes AQ, stayawake SA, claude-skills CS, ha-frontend HAF,
                            hack-cove-themes HCT); any other project has none until one is set.
  project edit <name> [--remote <url>] [--kind <k>] [--key <KEY>] [--icon <emoji>] [--display-name <text>] [--stage <s>]
                            change an existing project's remote, kind, ref key, icon, display name and/or stage.
                            A project joins a team with 'ob t3 team join <team> <project>'.
                            --stage (OB-2103) records the release stage architects and builders read; 'none' clears it,
                            and unset is treated as beta. Anything else exits 2 naming the five:
                              alpha   anything may break, no compatibility work owed
                              beta    breaks allowed, each flagged with ! and a Breaking: line
                              rc      very cautious: a break needs an impact note and the owner's yes before dispatch
                              stable  no break on the current version; a break waits for the next major
                              legacy  not maintained: take no work unless the owner says
                            --icon (at most 16 UTF-16 code units, a ZWJ flag fits) and --display-name (at most 40
                            characters) label the project (OB-2116); '' clears either. A team of one that
                            'ob t3 architect' makes from the project takes both as the team's labels.
                            A new --key numbers every item of the project that has no ref yet; a CHANGED key renumbers them and keeps
                            the old refs as aliases (1949). Change an existing project's remote and/or kind (1621); no flag is a usage
                            error, an unknown name exits 1 naming it. 'project add' on a name that EXISTS no longer silently keeps the old row:
                            the same kind/remote answers with its id, a different one exits 1 and points here.
  project rename <old> <new>   rename a project in place (OB-1846): the row moves to the new name's slug with its kind, remote and KEY,
                            and every item follows, so each item keeps its ref (FS-67 still resolves) and a 'focus' on it follows too.
                            Exits 1, naming which, on an unknown old name or a new name another project already holds, and changes nothing.
  project rm <name> [--force]   remove the project row (1621). Exits 1, naming the count, while OPEN items still reference it
                            (open = not closed for its type: a task or learning not done,
                            a roadmap not archived, a decision still draft); --force removes anyway. Clears 'ob focus' when it pointed here. Every item still pointing at it (done ones too) is detached (project cleared): item.project
                            is a foreign key, so a dangling reference cannot be kept. Served over the API like the other project commands.
  project rules <project> [--json]   print the project's stage line, then the repo's PRIVATE agent rules (1803), served from OmniSlash's
                            repos/<project>/AGENTS.md: the ob-specific half (tracker, visual-upload recipe, landing, dispatch) a repo that went public cannot carry.
                            The first line is 'Stage: <s> (<rule>)', or 'Stage: not set, treat as beta (...)' (OB-2103); a project with no AGENTS.md prints
                            only that line. --json answers {project, stage, stage_line, rules}. The same block rides on every spinoff launch prompt for that
                            repo; the architect reads it in Step 0. The rules are read here; the stage comes from the store, or one GET /projects on an API client.
  project wire <project> [--dir <path>] [--json]   install the project's opencode architect wiring (repos/<project>/opencode: SOUL.md, agents/, commands/, plugins/)
                            into <path>/.opencode (default: this directory), only the files the checkout does not TRACK as its own, so a repo that still
                            commits its wiring keeps it and ob's own untracked copies are refreshed. Installed files are git-excluded, so the tree stays clean.
                            Every spinoff launch does this for its worktree, and ABORTS the launch (a failed row) when the install or the git
                            exclude cannot be written; the manual command only reports that. Both subs run on THIS machine (rules reads only the stage over the API).
  wiki [list] [--json|-q]   the project wiki (OB-2006): pages in the checkout's wiki/ (OB_WIKI_DIR overrides): projects/<slug>.md, topics/<name>.md; lists them
  wiki <name> [--json]      print a page; a project page gets a fresh facts block and a '## Live (this machine, now)' section (path, open item counts, last 5 closed)
  wiki refresh [<project>]  rewrite only the facts block of every project page (or one), creating a missing page
  wiki check                exit 1 naming stale project pages, projects with no page, pages for no project and incident files with a malformed entry (topics ignored); run by hand, not in CI
  wiki incidents [<area>] [--json|-q]  the incident log (OB-2007): no area lists each area with its entry count and latest entry; an area prints wiki/incidents/<area>.md. Look here before diagnosing a day-to-day failure
  wiki log <area> "<title>" --what <text> [--cause <text>] [--fix <text>] [--ticket OB-N[,OB-M]] [--date YYYY-MM-DD] [--new-area]  add an entry to the area's log, newest first after you fix or diagnose a failure (cause defaults to unknown, fix to open, date to today). Writes into the wiki of the OmniSlash checkout you stand in; an area outside home-assistant|network|deploy|daemon|sources|ops needs --new-area
  cursor get <skill> <key> | cursor set <skill> <key> <value>
  config [get <k> | set <k> <v>]
                            over the API (353) the config table IS the server's, so 'config get/set' reads
                            and writes the SERVER's settings -- the one way a client flips e.g. spinoff_engine.
                            The client's OWN pointer is NOT a config key (it is OMNISLASH_API / ~/.omnislash_api_url),
                            so 'config get/set remote_host' REFUSES rather than writing into the server's table
  remote_host (a config key)   e.g. ob@<server>, the server holding the authoritative DB (183). UNSET (the
                            default) means nothing changes: ob opens the local DB and behaves exactly as
                            it always has. Set, ob becomes a CLIENT: an allowlist of read commands answers
                            from the local read-only replica, and EVERYTHING ELSE runs on the server over
                            ssh. THREE classes, not two (189): 'daemon' and 'web' are
                            SPLIT: the handler runs HERE (its side effect is this machine) and its database
                            half is dispatched to the server as an ob sub-invocation. The local half runs
                            FIRST, so a partial run leaves something you can SEE with no row rather than a
                            row for a launcher that never started, and it says so and exits non-zero. --local
                            refuses a split command (its database half IS the server); OB_REMOTE=0 runs it
                            wholly locally. 'spinoff drain', 'spinoff reconcile' and 'spinoff cleanup' joined
                            the class in 191, once drain's per-row sweep was separated into 'spinoff claim'
                            and 'spinoff stamp' (nothing is REFUSED any more; the mechanism remains for the
                            next command that needs it). See the client/server section of
                             the README.
  secret set <name> | get <name> | list | rm <name> | import
                            encrypted token store (AES-256-GCM; master key in macOS Keychain).
                            set reads the value from STDIN; list never prints values; import copies
                            the legacy token files (google/github/ha) into the store. set and rm drop
                            the credential's last "ob creds check" verdict (it reads unchecked until
                            the next check; no live check runs from set).
                            On an API client (OMNISLASH_API) set/get/list/rm go over HTTPS and decryption
                            still happens on the API host; import stays local and refuses by name.
  creds                     every credential ob depends on, not just the stored ones: presence, the last
                            recorded check, and how each is refreshed (paste / OAuth / a QR scan).
                            Covers the ones OUTSIDE the store too: the Keychain master key and the
                            WhatsApp linked-device session (274 — the dashboard Tokens page shows its
                            pairing QR). Not the router password or the Claude Code login (425):
                            nothing should create those, so they are not on this list.
                            Reads only; never a value.
  creds check <name> | creds check --all
                            ask the provider whether the credential still works, and record the verdict so
                            the dashboard can show it without calling again. Runs when asked, and daily at
                            07:45 as creds check --all (the creds-check server job, 1655: every spec in the
                            inventory, so a credential added later is picked up with no job change). Exits 1
                            when any verdict is FAILED and names which, so that job is a JOB FAILING alert
                            like gmail-sync. It does not notify: the 08:00 digest push below does.
                            A failed check becomes an alert row (rule 11); an absent credential does not.
                            opencode-go / opencode-zen (1656): the keys behind the skeptical-review legs and
                            jev. Go reads GET /zen/go/v1/usage and FAILS on a rejected key, a missing window, or a window
                            used up (status not ok, or 100%); weekly / monthly use at 90%+ is a WARNING "running low", still ok (OB-1843);
                            Zen has no balance
                            endpoint, so its check (GET /zen/v1/models) proves the key only and says so.
  usage day [--since <iso>] [--until <iso>] [--compare] [--limit <n>] [--json]
                            where the Claude tokens went (OB-2278), from the transcripts on THIS machine
                            (~/.claude/projects, CLAUDE_CONFIG_DIR or OB_USAGE_TRANSCRIPTS overrides). Default window: the
                            last 24 hours. Prints the ESTIMATED list-price total, by model, by token class (cache read,
                            cache write, output, input), main vs subagent, the ob projects (average context; only projects in
                            'ob project list', by the cwd each session ran in: ~/dev/<name>, ~/dev/<name>.<branch>,
                            ~/.t3/worktrees/<name>/, a spinoff row's worktree; every other cwd is ONE 'not an ob project'
                            line, printed last) and the top sessions (peak context), each named by its thread where the
                            spinoff rows and the agent registry map the checkout (a builder worktree -> its ticket, a team
                            role's checkout -> its role); if that read fails the slugs are printed, every session goes on
                            the 'not an ob project' line, and the totals are the same. Adds the weekly window from
                            ~/.t3/caches/claudeAgent.json (OB_USAGE_T3_CACHE overrides). --compare puts the window of the same
                            length just before beside every figure, with the change. --limit sets the top lists (default 10).
                            A message split over several records counts once; a '<synthetic>' record counts zero. No
                            database; runs locally even on an API client. No transcript directory: names the path, exits 2.
  models [show|list|use <profile>|init|legs] [--json]
                            which model runs what, from ONE machine file, ~/.config/ob/models.jsonc (OB_MODELS_FILE overrides
                            the path) (OB-1969). The file holds profiles, one per account: each names the builder model per tier
                            (builder.complex|medium|simple, '<provider>:<model>' as spinoff_tier_models does), the architect's
                            checker model and the skeptical-review legs (review.opus|deepseek|luna; OB-2107: an older file's review.sonnet is read as review.opus, and the opus leg runs at the model's default effort). 'active' names the profile
                            in force. PRECEDENCE per role: the active profile, then the spinoff_tier_models setting (builder tiers
                            only), then the built-in default; a role a profile leaves out falls through, so a machine with no file
                            behaves as before. show (the default) prints the active profile and, per role, the model and its source
                            (file (profile X) | setting | default). list names the profiles, '*' marks the active one. use <profile>
                            sets "active" by editing that one value (comments survive); an unknown profile exits 1 naming the
                            profiles. init copies apps/cli/models.example.jsonc to the path and refuses if a file is there. A file
                            that does not parse, an unknown profile or a builder key that is not a tier refuses by name, exit 1:
                            never a silent fallback. 'ob spinoff --tier' and the review legs (skills/ob-skeptical-review/review-leg.ts)
                            read the file on the machine that launches. No secret in it. Runs locally even on an API client.
                            FALLBACK (OB-1970): on a credit or quota error (a provider code such as insufficient_quota or
                            credit_balance_too_low, else the message text as a named last resort; a rate limit or any other
                            error never moves it) a spinoff launch, or a first turn the run mirror sees end on one, is relaunched
                            ONCE per remaining profile in "fallback" order, printing '<ticket>: <A> out of credits, relaunched on
                            <B>' and stamping the model with '(profile B)'. Every profile spent fails the row with a named
                            'blocked: every models profile is out of credits' refusal listing each one tried. A review leg retries
                            on the next profile's model for that leg the same way. Hits are kept in models-state.json beside the
                            file (not the DB); show and list mark a profile that hit one in the last 6h, --json as credit_hits.
  models legs [--days <n>] [--json]
                            the skeptical-review legs' run trend (OB-2133). review-leg.ts writes one record per leg attempt (a credit
                            retry is two) to review-legs.jsonl beside the models file: start, end, wall seconds, leg, model, variant,
                            profile, the diff size (git diff --shortstat origin/main...HEAD, or OB_REVIEW_DIFF_BASE), brief and output
                            bytes, tokens (claude legs, from the session transcript; null for opencode legs, whose standalone run leaves
                            no usage on disk), the exit code or signal, whether it ended on a credit error, and stop (steps or
                            max-turns when it hit its 40-turn cap, OB-2140). A caller's SIGTERM or SIGINT still records the attempt it
                            cut short; one the leg's own wall-clock limit ended (15 min, OB_REVIEW_LEG_TIMEOUT_S) has signal 'timeout'
                            and the leg exits 124. legs prints one line per UTC day and model over the last --days (default 14):
                            '<date> <model> runs <n> wall p50 <s>s p90 <s>s per100 <s>s failed <k> credit <c> timeout <t>'
                            (nearest-rank percentiles; per100 is the median seconds per 100 changed diff lines, '-' with no diff;
                            credit-error and timed-out attempts count only in credit and timeout, not in the wall figures or failed).
                            --json gives {days, groups}. No records:
                            'no review leg records in the last <n> days', exit 0. Runs locally even on an API client.
  cloudflare zones | tunnels [--floor <version>] | dns list <zone> | dns add <zone> <type> <name> <content> [--proxied] [--ttl <s>] [--yes] | dns rm <zone> <record-id|name> [--yes]
                            Cloudflare zones, DNS records (1756) and tunnel connector versions (1643),
                            token from the store (cloudflare-api-token; cloudflare-account-id narrows
                            "zones" to the account and is REQUIRED for "tunnels", whose endpoints are
                            account-scoped), never printed. <zone> is a zone name or id; a record <name>
                            may be relative (www, @). add takes A|AAAA|CNAME|TXT|NS
                            (ttl 1=auto or 60..86400; --proxied only on A|AAAA|CNAME). WRITES need --yes: add and
                            rm print the exact change and, without --yes, are a DRY RUN that sends no write and
                            exits 0. rm matches one record (by id or name) and refuses an ambiguous name, listing the
                            ids. tunnels prints, per non-deleted tunnel, name, status, connector count and the
                            distinct cloudflared versions (read from /cfd_tunnel/<id>/connections — the list's own
                            conns field is empty); a tunnel is STALE when a connector is a release-month behind the
                            fleet's newest version or below --floor (an advisory's exact cutoff), and the exit code is
                            1 when anything is stale, 0 when clean, so a scheduled job can use it (tunnel-check,
                            daily 07:30, does). A failed read is its own error and is never reported as stale.
                            No bulk edit, no zone create, no cloudflared is installed or restarted here, and the
                            DNS-01 path of "ob cert" is untouched.
                            The call is made from THIS machine; on an API client only the token is fetched over the API.
  backup over the API (OB-1808): starts a job on the API host and returns, --wait follows it (--dry-run always waits)
  backup [--dry-run]        monthly off-machine backup: DB dump → private GitHub release (12-mo prune)
                            (alias: db backup). 337: the DB half is 'pg_dump --format=custom' of the
                            POSTGRES database, verified with 'pg_restore --list' before it counts as a
                            backup, and the artifact is named omnislash-YYYY-MM-DD.dump -- the suffix IS
                            the format, since a restore starts with somebody finding this file in a
                            release a year later. Restore with 'pg_restore --clean --if-exists --dbname
                            omnislash <file>', or '--table <name>' for one table. The connection reaches
                            pg_dump through the libpq environment, so no password is ever visible in ps.
                            --dry-run no longer takes the copy: it prints the command it would run.
                            Auth (550, 1575): GH_TOKEN or GITHUB_TOKEN counts; then 'gh auth status';
                            failing both, the 'github' token from the ob secret store is handed to
                            gh as GH_TOKEN for this run only (never printed or written). Do not 'gh
                            auth login' on the server.
  db fetch <snapshot> [--out <dir>] [--force]   (OB-1808) bring one snapshot from the API host's history to this machine, 0600 (default $TMPDIR/ob-db-snapshots; refuses to overwrite without --force). On the host, prints where it already is
  db over the API (OB-1808): 'db backup' and 'db snapshot' start a job and return, --wait follows it; --list and --dry-run wait. 'db snapshot --dir' is refused: it names a host path that rotation prunes
  db snapshot [--dir <path>] [--keep-hourly N] [--keep-daily N] [--max-bytes N] [--dry-run] [--list]
                            LOCAL point-in-time history (200): a pg_dump into a rotated directory
                            (default ~/.local/share/omnislash/snapshots, or OMNISLASH_SNAPSHOT_DIR; 337 --
                            there is no database FILE to hang it off any more). A consistent logical
                            copy restored with pg_restore, which can pull out a single table.
                            Runs hourly as omnislash-db-snapshot.timer on the server. Retention:
                            the newest 24, plus the newest survivor of each of the next 7 days, capped
                            at 2 GiB and refusing to write when the volume would drop under 512 MiB
                            free. It covers a bad write / bad migration / fat-fingered 'ob rm', NOT
                            losing the volume (that is the host-side weekly vzdump) and NOT
                            point-in-time recovery between
                             snapshots (that is the basebackup + WAL archive on the database host). Pre-cutover
                            .sqlite snapshots are left strictly alone: rotation only considers .dump
                             names, so the last copies of the old engine are never pruned. --list prints
                             what is retained.

Global flags: --json  --table  -q/--quiet  --db <path>  (or OMNISLASH_DB)  --local
     --db <path>              the database to use. LOCAL-ONLY (213): it names a file on THIS machine and is
                              never sent to the server, so with remote_host set every command that would
                              consult the server REFUSES rather than running against a different database.
                              Run it against the named database with OB_REMOTE=0. With no remote_host it
                              behaves exactly as it always has.
     --local                  answer from the local read-only replica and never dispatch over ssh (offline
                              work, debugging). A write under --local raises SQLITE_READONLY rather than
                              landing in a file the next refresh overwrites.

Env: OMNISLASH_API            the ob API's base url, e.g. https://ob.example.org (353). SETTING IT MAKES
                              THIS MACHINE AN API CLIENT: every data command goes over HTTPS with a bearer
                              token to the server ob 352 mounts at /api/ob, ON THE LAN AND OFF IT, and ob
                              opens NO database at all -- no Postgres driver, no connection url, no pg_hba
                              entry. There is deliberately no dual mode (map decision D2): a client that
                              can reach the data two ways eventually reaches it the wrong way and says
                              nothing, so an unreachable API is an error rather than a quiet fall back to
                              a database.
                                 ROUTED through the API: add, agent, agents, agenda, alerts, block, brief, cal, close, creds,
                                decision, deploy, edit, focus, gmail, issue, jobs, learning, lease, link, list, log,
                               next, note, project, ready, reopen, roadmap, rm,
                               order, search, secret, show, slack unread, spinoff, start, state, status, standup, tag, today,
                               triage, unblock, untag, whatsapp search, whatsapp recent.
                              SECRETS cross the wire (357), and only these: 'ob secret get' returns a
                              decrypted VALUE over TLS, behind Cloudflare Access and behind the bearer
                              token, with the DECRYPTION and the master key staying on the API host. The
                              name travels in a POST body, never in a url, so it stays out of access logs;
                              'ob secret list' returns names and ages and has no field a value could be in.
                              'ob secret import' is NOT served and refuses by name: it copies the token
                              FILES on the machine it runs on, so over the API it would import the wrong
                              machine's.
                              SPINOFF IS SPLIT (360), so it works from anywhere the laptop is: the QUEUE
                              half goes over the API (/spinoffs -- rows, enqueue, launchable, claim, stamp,
                              land, reclaim, cleanup's lease+agent guard) and the LAUNCH half stays on this
                              machine, where the checkouts are. 'spinoff <ref>' (and a manual 'spinoff drain') claims a row
                              over the wire (ONE conditional update, so two launches cannot both win it),
                              opens the T3 thread HERE, then stamps the outcome; 'reconcile' judges merges from
                              THIS machine's git (branch on local main, OR ticket done via GET /items?status=done, OR a LANDING commit naming it on origin/main -- never a 'chart('/'docs(' note, and never one older than the row's base_sha, 1201) and records the landing over the API; 'list --json' sets landed from that same done/origin signal; 'cleanup' removes
                              worktrees on this disk and asks the API which of them a live session holds.
                               Only 'spinoff watch' refuses, and it names this machine rather than the API
                               host: it blocks on fs.watch of the database FILE, and a client has none.
                               WHATSAPP IS SERVED (366, OB-1809): the bridge runs on the API host. sync is a
                               host job; search, recent, send, bio (the config routes) and the chat prefs are routes. send still
                               asks the human on THIS terminal, before any request exists. 'whatsapp bridge
                               status' is a host job too; run, start and stop refuse by name: the bridge is
                               the server's own long-running process.
                               GMAIL/CAL ARE SERVED (415): search/list/agenda read the store; sync runs
                               ON THE HOST using secret 'google' so a laptop never needs ~/.google_token.
                               'google auth' is SPLIT (420): it RUNS on THIS machine (browser + 127.0.0.1)
                               and persists via the secret API (host store). Creds: flags, else secret google (424).
                               'google auth-url' (1305) IS SERVED: the API host mints a one-time state and
                               returns the consent URL, so a phone can finish at /api/ob/google/callback
                               (the two browser routes, state-guarded rather than bearer-guarded).
                               ISSUE IS SPLIT (389): list/link/unlink and reconcile go over the API
                               (pairing is store; reconcile uses the host's GitHub credential).
                               'issue landed' and 'issue drift' take pairing from the API and run git
                               HERE — they never send you to the API host (that checkout is the wrong one).
                               'ob add --issue' creates the GitHub issue on the host and pairs it.
                                 'ob link', 'ob edit', 'ob rm', 'ob today', 'ob focus' are store
                                 data and are served.
                                  416 KILLED THE UNROUTED THIRD CLASS: EVERY command is API-routed or local-only.
                                  SERVED (416): project, brief, log, jobs, alerts, decision,
                                  learning, roadmap, standup (save/set/latest/posted). slack unread is served
                                  (ingested rows); slack sync stays retired (208).
                                  SERVED (456): person, whois,
                                  review-miss, cursor, test-user, sync. sync runs ON THE HOST
                                  (GitHub token stays there).
                                    LOCAL and about THIS MACHINE (D3): daemon still runs here (it only writes
                                     launchd plists); so does 'vision compare' -- it shells to
                                     this machine's mlx-vlm and never to the API host.
                                    MEMORY IS SPLIT (739): MEMORY.md is this machine's XDG file (show reads
                                    it here, add appends here). The learning dual-write is tracker data and
                                    goes over POST /items. Never dispatched over ssh (the server has a
                                    different filesystem). OpenCode prepends the capped file
                                    into session context (740).
                                 A flag whose meaning has no endpoint behind it refuses too rather than being
                                 dropped: the roadmap/decision/learning detail on 'add',
                                 --repo on 'tag', --dry-run on close/reopen.
                                 TOURNAMENT IS SERVED (OB-2271): every 'ob tournament' subcommand goes
                                 over /tournaments/*; 'record' reads the match file here and sends it.
                                 CI AND GITHUB ARE SERVED (OB-2276): 'ob ci main' goes over /ci/main and
                                 /ci/main/notify, 'ob github hooks' over /github/hooks; the host holds the
                                 'github' secret and the notice rows.
                               LOCAL refuse, run on the API host: web.
                                THE API HOST RUNS, as a job a client follows or checks (OB-1808): backup, db, cert.
                              Unset (the default today) = the direct Postgres path below, unchanged.
     OMNISLASH_API_URL_FILE   file holding that url instead, default ~/.omnislash_api_url.
     OMNISLASH_API_TOKEN      the bearer token, for a one-off without touching a file.
     OB_API_TOKEN_FILE        the token file BOTH ENDS use, default ~/.ob_api_token, mode 0600 (352). A
                              FILE and not an 'ob secret' on purpose: the secret store is a table inside
                              the database the API fronts. The token is sent in the Authorization header
                              only -- never in argv, never in a url, and never in an error message.
     OB_API_TIMEOUT_MS        client: ms one API call may take, default 150000 (1616). A hang is a named
                              error (which call, how long), not a wait. OB_API_REQUEST_TIMEOUT_MS is the
                              server's own per-request bound (default 120000, a 504 'timeout');
                              OMNISLASH_STORE_TIMEOUT_MS bounds a Postgres txn/NOTIFY (default 30000). The
                             ingest routes (/sync, /gmail/sync, /cal/sync, /creds/check) get 10x the API
                             budgets. Plain reads that bypass the API are not bounded.
     OB_API_RETRY_MS          client: ms a call may spend riding out a short outage, default 30000 (OB-2160). A
                              refused connection (nothing was sent: a deploy restarting omnislash-web) is retried
                              for every method, a reset only for a GET, a timeout never; backoff 0.5s doubling
                              to 4s, one stderr line when it starts. 0 = fail at once, as before.
       OMNISLASH_MEMORY_PATH    this machine's MEMORY.md (739). Default
                                $XDG_DATA_HOME/omnislash/MEMORY.md else
                                ~/.local/share/omnislash/MEMORY.md. Personal XDG, not git.
                                OpenCode prepends the capped file into session context (740).
      OMNISLASH_DB             the database path (--db wins)
      OMNISLASH_DB_CREATE=1    allow this invocation to CREATE the database if it does not exist (198).
                               Off by default, so a command run without OMNISLASH_DB cannot quietly start a
                               second, empty tracker at the default path. The server already has a database.
     OMNISLASH_STORE          which database engine is authoritative (324/337, the Postgres migration):
                              'postgres' (THE DEFAULT since 337j, and what unset means) or 'sqlite'.
                              It governs ob and the daemon alike.
                              The default is BUILT IN rather than carried in the environment, because the
                              cutover is done: Postgres holds the data, the SQLite file is a frozen copy
                              nothing writes, and a shell that forgot to export a variable would answer
                              from it confidently and wrongly. No OMNISLASH_* variable is needed at all.
These ob commands are SERVED FROM POSTGRES (337): add, agenda, agent,
                                 agents, alerts, backup, block, brief, cal, close, config,
                                 creds, cursor, daemon, db, decision, deploy, edit,
                                focus, gmail, jobs, learning, lease, link, list, log,
                               memory, next, note, order, person, project, tournament, ci, github, ready, reopen,
                                 review-miss, rm, roadmap, search, secret, show,
                                 spinoff, start, state, status, sync, tag, test-user, today,
                               triage, unblock, untag, web, whatsapp, whois.
                              EVERY OTHER COMMAND REFUSES rather than falling back
                              to SQLite: writing the sqlite file while Postgres is authoritative would
                              mean two live stores, which is the one migration failure that cannot be
                              fixed forward. The refusal names the command, what IS servable, and the way
                              back. A replica-served read refuses too -- the replica is a copy of the
                              SQLite database, so it would answer from the engine the cutover left.
                              OMNISLASH_STORE=sqlite is the escape hatch, kept for the commands not ported
                              yet and for the foreign sqlite files ob reads (the WhatsApp bridge store).
                              What it opens is FROZEN at the cutover: history, not the
                              tracker.
     OMNISLASH_PG_URL         the Postgres connection url. Wins over the token file below; for a one-off
                              against a different cluster, without editing a file.
     OMNISLASH_PG_URL_FILE    file holding that url, default ~/.omnislash_pg_url, mode 0600 -- and that
                              default is all a fresh machine needs. It is a FILE and not an 'ob secret'
                              on purpose: the secret store is a table inside the database the url is
                              needed to reach. PERCENT-ENCODE the password: 'openssl rand -base64' emits
                              +, / and =, which are url syntax, so a raw one fails to parse.
     OMNISLASH_SNAPSHOT_DIR   where 'ob db snapshot' writes its rotated local history (--dir wins).
                              Default <the database's directory>/snapshots.
     OMNISLASH_WEB_BIND       the address 'ob web' binds (dashboard :5050 + realtime :5051). --bind wins; the
                              'web_bind' config row is the persistent form. Default 127.0.0.1.
     OMNISLASH_WEB_TLS_CERT   the PEM chain + private key 'ob web' serves on BOTH listeners (220). Set together or
     OMNISLASH_WEB_TLS_KEY    not at all; --tls-cert/--tls-key win, the web_tls_cert/web_tls_key rows are the
                              persistent form. Unset = plain HTTP, which is not an error; set to a file that
                              does not exist = 'ob web' refuses to start (1383). The server's
                              omnislash-web.service sets them to /etc/omnislash/tls/{fullchain,privkey}.pem.
     OMNISLASH_MASTER_KEY_FILE
                              file holding base64 of the 32-byte secret-store master key, mode 0600.
                              Wins over the macOS Keychain everywhere; required off macOS.
     OB_REMOTE=0              disable remote dispatch entirely for one invocation: ob opens the local DB
                              read/write exactly as it does with no remote_host set. This is how the
                              client's own remote_host pointer is set, changed or cleared.
     OB_REMOTE_HOP=1          set by ob itself on the ssh hop. An ob that starts with it AND has
                              remote_host configured REFUSES rather than hopping again (the loop guard).

Exit codes: 0 ok (including an empty result, and requested help)  |  1 runtime error  |  2 usage error
            (a bad flag, an unknown command, or no command at all)

--json guarantee: a --json invocation either prints PARSEABLE JSON on stdout or exits NON-ZERO with a
            reason on stderr, never both silent and successful. An empty result set is still valid JSON
            ([] or {}), so a scripted consumer can JSON.parse stdout whenever the exit code is 0.`;

export interface RunDeps {
  /** ob 183: the ssh seam, injected by tests so nothing ever shells out or touches the network. */
  exec?: RemoteExec;
  /** ob 353: the HTTP seam, injected by tests so the suite reaches no network and needs no token. */
  api?: { base?: string; token?: string; transport?: ApiTransport; download?: ApiDownload };
  /** Injected so a test never depends on where it ran (243: apiAdd infers project from this cwd). */
  cwd?: string;
  /** 420: google-auth seams (loopback / exchange / openUrl). Tests inject; no live Google. */
  googleAuth?: GoogleAuthDeps;
  /** ob 636: ssh seam for `ob deploy run`. Tests inject; production omits. */
  deploySsh?: (argv: readonly string[]) => { code: number };
  /** ob 1756: the fetch `ob cloudflare` uses, injected by tests so nothing reaches Cloudflare. */
  cloudflareFetch?: typeof fetch;
  /** OB-1808: how an API client waits on a host job. Tests inject; production omits. */
  hostJobWait?: HostJobWait;
  /** ob 1655: the fetch `ob creds check` uses, injected by tests so nothing reaches GitHub. */
  credsFetch?: typeof fetch;
  /** ob 1655: the fetch the `ob alerts --notify` Home Assistant push uses, injected by tests so nothing reaches HA. */
  notifyFetch?: typeof fetch;
}

/**
 * A read-only handle for the config a DISPATCH-TIME path resolution needs (217, `repo_checkouts`), taken
 * before any database is open and while the invocation is still headed for the server. The replica is the
 * client's copy of the authoritative config, so it answers first; the local database answers when there is
 * no replica yet (pre-cutover), and an empty in-memory one when neither can be opened, which degrades to
 * the `~/dev/<name>` lookup rather than failing a dispatch over a config read.
 */
function openForPathResolution(dbPath: string): Database {
  try {
    if (existsSync(replicaPath(dbPath))) return openReplicaForRead(dbPath);
  } catch {
    // fall through to the local database
  }
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return new Database(":memory:");
  }
}

export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: expandVisionPairFlags(argv), options: FLAGS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
  const flags = parsed.values as Flags;
  const positionals = parsed.positionals;
  const command = positionals[0];

  // #134: help that was ASKED FOR is not an error — `ob --help` / `ob help` print to stdout and exit 0,
  // so `ob --help >/dev/null && echo OK` is a valid "does ob load?" probe. A bare `ob` is still a usage
  // error (no command was given), which is what the README documents as exit 2.
  if (flags.help || command === "help") {
    console.log(HELP);
    return 0;
  }
  if (!command) {
    console.log(HELP);
    return 2;
  }

  const handler = HANDLERS[command];
  if (!handler) {
    process.stderr.write(`error: unknown command '${command}'\n`);
    return 2;
  }

  const mode = modeFromFlags(flags);
  resetPrintedBytes();

  // ob 353, THE CLIENT SEAM, and it is deliberately the FIRST thing after the command resolves: an API
  // client opens no database at all, so this must run before resolveDbPath, before the replica, and before
  // openDb. With no base url configured this is null and everything below is untouched (the ob 337
  // Postgres path); with one configured EVERY data command goes over HTTP, on the LAN and off it, because
  // a client that can reach the data two ways eventually reaches it the wrong way and says nothing.
  const apiBase = deps.api?.base ?? resolveApiBase();
  if (apiBase) {
    return await runApi({
      command,
      args: positionals.slice(1),
      flags,
      base: apiBase,
      transport: deps.api?.transport,
      download: deps.api?.download,
      token: deps.api?.token,
      cwd: deps.cwd,
      googleAuth: deps.googleAuth,
      deploySsh: deps.deploySsh,
      cloudflareFetch: deps.cloudflareFetch,
      hostJobWait: deps.hostJobWait,
      // The local-only commands that still run here get their real handler and a store that refuses by
      // name. Passed in rather than imported by the router, so the routing module stays free of commands.
      localHandler: handler,
    });
  }

  const dbPath = resolveDbPath(flags.db);

  // ob 183: the client/server seam: handler resolved, no database open yet. With no `remote_host`
  // configured this whole block is inert and everything below runs exactly as it always has, which is
  // both the pre-cutover behaviour AND what must happen on the server itself.
  let remoteHost: string | null;
  try {
    remoteHost = configuredRemoteHost(dbPath);
  } catch (err) {
    // OB-1912: an unreadable `remote_host` fails closed, before any database is opened for writing.
    if (!(err instanceof RemoteConfigUnreadable)) throw err;
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }
  if (remoteHost && isHop()) {
    // The loop guard: a server that accidentally points at itself must fail fast, not ssh forever.
    process.stderr.write(`error: ${hopGuardMessage(remoteHost)}\n`);
    return 1;
  }
  const plan = planExecution({
    command,
    args: positionals.slice(1),
    flags: flags as unknown as Record<string, unknown>,
    host: remoteHost,
    hop: isHop(),
  });

  // ob 189: a command whose side effect belongs to this machine and whose DB half is not separable yet.
  // Refusing is the honest state of a mechanism that is not built: it says what it would have done and on
  // which machine, and it exits non-zero, rather than acting correctly on the wrong host.
  if (plan.mode === "refused") {
    process.stderr.write(`error: ${plan.reason}\n`);
    return 1;
  }

  if (plan.mode === "remote" && plan.host) {
    // 217 / 243 / 308: machine-local values are resolved HERE, before the argv crosses the wire.
    // `spinoff --repo` becomes a slug (the server has none of these checkouts). `add` without
    // --project infers project+kind from THIS cwd's git remote (the server's cwd is /opt/omnislash
    // or the ob user's home). 308: closed before the dispatch runs so a replica handle is not held
    // for the whole ssh call. A value the server cannot be asked about is refused rather than
    // dispatched: nothing runs and nothing is written.
    const resolver = openForPathResolution(dbPath);
    let spinoff;
    try {
      // OB-2130: with no --repo, the ticket's own project names the repo before this cwd does.
      const enqueueRef = flags.repo === undefined ? spinoffEnqueueRef(command, positionals.slice(1)) : null;
      const fromProject = enqueueRef ? await ticketProjectRepoFor(resolver, enqueueRef) : null;
      if (fromProject) process.stderr.write(`${fromProject.notice}\n`);
      spinoff = rewriteSpinoffRepoArgv({
        argv,
        command,
        args: positionals.slice(1),
        flags: flags as unknown as Record<string, unknown>,
        db: resolver,
        ticketRepo: fromProject?.repo,
      });
    } finally {
      resolver.close();
    }
    if (spinoff.error) {
      process.stderr.write(`error: ${spinoff.error}\n`);
      return 1;
    }
    const dispatch = rewriteAddProjectArgv({
      argv: spinoff.argv,
      command,
      flags: flags as unknown as Record<string, unknown>,
    });
    if (dispatch.error) {
      process.stderr.write(`error: ${dispatch.error}\n`);
      return 1;
    }
    const exec = deps.exec ?? sshExec();
    const result = exec.stream(plan.host, dispatch.argv);
    if (result.connectionFailed) {
      // Offline writes REFUSE and are never queued: a replayed outbox against state that has moved on is
      // a corruption engine (#181). "Could not reach the host" and "it ran on the server and failed" need
      // opposite reactions, so they are never reported as the same thing.
      process.stderr.write(`error: ${unreachableMessage(plan.host, dispatch.argv)}\n`);
      return 1;
    }
    // Trigger (a): the server's state has moved, so the next read refreshes before it answers. Marked
    // whatever the exit code, since a command that failed partway may still have written.
    markReplicaDirty(dbPath);
    return result.code;
  }

  let replicaStale: string | null = null;
  // A split command reads from the replica exactly as an allowlisted read does (its DB half is the only
  // thing that goes to the server), so it takes the same refresh and the same staleness notice.
  if ((plan.mode === "replica" || plan.mode === "split") && plan.host) {
    const exec = deps.exec ?? sshExec();
    const missing = !existsSync(replicaPath(dbPath));
    let unreachable = false;
    // Trigger (b): a dirty (or absent) replica refreshes synchronously first, so `ob add … && ob next`
    // shows the new item. A refresh that cannot reach the server does NOT fail the read: it answers from
    // the stale copy and says so.
    if (!flags.local && (missing || readMeta(dbPath).dirty)) {
      const outcome = refreshReplica({ dbPath, host: plan.host, exec });
      unreachable = outcome.error !== null;
    }
    const notice = stalenessNotice({ meta: readMeta(dbPath), unreachable });
    replicaStale = notice.message;
  }

  // openDb USED to run out here, outside the try (149). A concurrent-access failure inside it therefore
  // escaped run() entirely, so `ob <cmd> --json` exited 1 with a raw Bun stack on stderr and NOTHING on
  // stdout, which is exactly how "ob lease status --json returned empty stdout" presented to a caller
  // that only looked at stdout. Every exit from here on carries a reason on stderr.
  // 337: under OMNISLASH_STORE=postgres a command whose EVERY path is ported skips the SQLite file
  // entirely and is served from the Postgres store. Everything else still goes through openDb, whose
  // guard refuses it by name. In sqlite mode -- the default, and every invocation today -- this is
  // false and nothing below changes.
  const servedFromPostgres =
    plan.mode === "local" && resolveStoreKind() === "postgres" && isPostgresServable(command);

  let db;
  let store: Store | undefined;
  try {
    // 337: the replica IS a SQLite copy of the SQLite server database, so a replica-served read under
    // OMNISLASH_STORE=postgres would answer from the engine the cutover just left, silently and with no
    // file to blame. openDb's guard cannot catch it (the replica opens its own handle), so it is
    // refused here, by the same rule and with the same way back.
    if (resolveStoreKind() === "postgres" && (plan.mode === "replica" || plan.mode === "split")) {
      throw new AppError(replicaUnderPostgresMessage(`'ob ${command}'`, plan.host));
    }
    if (servedFromPostgres) {
      // The handle is a stand-in that throws on any use: a ported handler never touches it, and an
      // unported path inside one that does says so instead of writing a file nobody is reading.
      db = unusableSqliteHandle(`'ob ${command}'`);
      store = await commandStore(db, { idleTimeout: postgresIdleTimeoutForCommand(command) });
    } else if (plan.mode === "replica" || plan.mode === "split") db = openReplicaForRead(dbPath);
    // `replica token`/`status` read the filesystem, and opening the real DB read/write would grow its
    // -wal and move the change token they exist to report. They get a handle they never use.
    else if (plan.mode === "nodb") db = new Database(":memory:");
    // 198: creating a database is deliberate (OMNISLASH_DB_CREATE=1). Every command opens what is already
    // there or refuses with the path it declined to create. `what` (337) so the two-live-stores refusal
    // names the command a human actually typed rather than "this command".
    else db = openDb(dbPath, { what: `'ob ${command}'` });
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
  // stderr, never stdout: a `--json` consumer's stdout stays byte-identical, so the guarantee below
  // holds for a replica-served read exactly as it does for a local one.
  if (replicaStale) process.stderr.write(`${replicaStale}\n`);

  // ob 189: the DB half of a split command. Wrapped so the replica is marked dirty only when a
  // sub-invocation actually ran: `daemon` and `web` are split members with an EMPTY database half, and
  // marking dirty for them would cost the next read a whole refresh for a server that never moved.
  let dispatchedWrite = false;
  const writer =
    plan.mode === "split" && plan.host ? remoteWriter(plan.host, deps.exec ?? sshExec()) : null;

  // 337: the store this invocation's ported handlers use. A servable command in postgres mode already
  // has one (above). Everything else wraps the handle already open, rather than opening anything a
  // second time, so a ported handler and an unported one share one connection and one transaction
  // scope. Deliberately NOT commandStore here: that would hand an UNPORTED command a Postgres store
  // whenever the handle came from a path openDb's guard does not cover (the `nodb` scratch handle), and
  // a command reads its data through whichever store it is given.
  const activeStore = store ?? sqliteStoreFor(db);

  const ctx: Ctx = {
    db,
    store: activeStore,
    dbPath,
    mode,
    flags,
    args: positionals.slice(1),
    deploySsh: deps.deploySsh,
    cloudflareFetch: deps.cloudflareFetch,
    credsFetch: deps.credsFetch,
    notifyFetch: deps.notifyFetch,
    // Only in split mode. Absent means there is no server, and the handler writes to `db` as it always
    // has, which is both the pre-cutover behaviour and what the server itself does with this same code.
    ...(writer
      ? {
          remote: {
            write(argv: string[]) {
              dispatchedWrite = true;
              return writer.write(argv);
            },
          },
        }
      : {}),
  };

  // ob 218, THE RECORDING SEAM. A helper each connector calls would be easy to write and easy to forget,
  // and forgetting is exactly how four jobs failed silently for weeks. This layer cannot be bypassed:
  // it already knows which command ran and whether it threw, so a connector added next year is covered
  // by having been declared in daemonJobs(), not by its author remembering anything.
  //
  // Only in `local` mode. In `remote` mode the invocation is dispatched whole and the SERVER records it
  // against the authoritative database; in `replica`/`split`/`nodb` the handle here is read-only or a
  // scratch in-memory database, and a health row written there would be a fact nothing ever reads.
  //
  // 337: recorded through the STORE, not the raw handle. `spinoff drain` is both a declared job and a
  // servable command, so in postgres mode this seam was handed the stand-in handle and threw before the
  // handler ever ran -- the job-health row is part of the command's every path, so it moves engines with
  // it. In sqlite mode the store wraps the handle already open and nothing changes.
  // ob 1643: `ob cloudflare tunnels --floor <v>` is a human checking an advisory, not the daily tunnel-check
  // job; recorded, a strict floor would raise JOB FAILING for a run nobody scheduled.
  const job = plan.mode === "local" && !(command === "cloudflare" && flags.floor)
    ? jobForInvocation(command, ctx.args, flags as unknown as Record<string, unknown>)
    : null;
  if (job) await recordJobAttempt(activeStore, job);

  try {
    await handler(ctx);
    let code = ctx.exit ?? 0;
    // The guarantee (149): a `--json` invocation either prints parseable JSON or exits non-zero with a
    // reason on stderr, never both silent and successful. A command whose result set is empty must still
    // emit `[]`/`{}`; reaching here with 0 bytes means a handler forgot to, and a scripted consumer would
    // otherwise attribute the JSON.parse failure to itself. Settled BEFORE the job row is recorded
    // (OB-1934), so the row says what the caller saw: a failed run, not an ok one that then exits 1.
    let jobError: string | null = code === 0 ? null : `exit ${code}`;
    if (mode === "json" && code === 0 && printedBytes() === 0) {
      process.stderr.write(`error: '${command}' produced no --json output (this is a bug in ob, not in the caller)\n`);
      code = 1;
      jobError = "no --json output";
    }
    // Success is "the command exited 0", which is narrower than "the run did useful work": ob 177's
    // gmail wedge exits NON-zero and is caught, but a run that quietly ingests nothing and exits 0 is
    // recorded here as a success. Closing that gap needs a per-source did-it-move signal, which is a
    // separate ticket; this seam deliberately claims only what it can see.
    // Long-running supervisors (whatsapp bridge run) close the singleton after spawn so they
    // do not hold pool slots for days (401). Re-open for the health row; sqlite still uses
    // the handle this invocation already has.
    if (job) await recordJobResult(activeStore.kind === "postgres" ? await getStore() : activeStore, job, { ok: code === 0, error: jobError });
    return code;
  } catch (err) {
    if (job) await recordJobResult(activeStore.kind === "postgres" ? await getStore() : activeStore, job, { ok: false, error: (err as Error).message });
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    if (err instanceof AppError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  } finally {
    db.close();
    // The Postgres connection is this process's own (getStore's singleton), so it is closed here for the
    // same reason the handle is: a CLI invocation must not leave a socket open behind it.
    if (activeStore.kind === "postgres") await resetStore();
    // Whatever the exit code, for the same reason a whole-command dispatch marks it: a split command
    // that failed partway may still have written on the server.
    if (dispatchedWrite) markReplicaDirty(dbPath);
  }
}

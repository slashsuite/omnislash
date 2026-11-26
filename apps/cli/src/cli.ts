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
import { cmdMachine } from "./commands/machine.ts";
import { cmdReview } from "./commands/review.ts";
import { cmdGate } from "./commands/gate.ts";
import { cmdPerson, cmdWhois } from "./commands/person.ts";
import { cmdTournament } from "./commands/tournament.ts";
import { cmdCi, cmdGithub } from "./commands/ci.ts";
import { cmdOvernight } from "./commands/overnight.ts";
import { cmdTags } from "./commands/tags.ts";
import { cmdModels } from "./commands/models.ts";
import { cmdApiToken } from "./commands/api-token.ts";
import { cmdUsage } from "./commands/usage.ts";
import { cmdCloudflare } from "./commands/cloudflare.ts";
import { cmdLog } from "./commands/log.ts";
import { cmdStatus } from "./commands/status.ts";
import { cmdSpinoff, refuseOverUsageBeforeDispatch, rewriteSpinoffRepoArgv, spinoffEnqueueRef, ticketProjectRepoFor } from "../../../platform/cli-coord/src/commands/spinoff.ts";
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
import { cmdSkills, expandSkillsFixFlag } from "./commands/skills.ts";
import { cmdVision, expandVisionPairFlags } from "./commands/vision.ts";
import { cmdT3 } from "./commands/t3.ts";
import { cmdRole } from "./commands/role.ts";
import { cmdInbox, cmdSend } from "./commands/inbox.ts";
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
import { renderRootHelp, resolveHelp } from "./help.ts";

export {
  COMMAND_HELP,
  ENV_VARS,
  GLOBAL_FLAGS,
  renderCommandHelp,
  renderEnvHelp,
  renderRootHelp,
  renderSubcommandHelp,
  resolveHelp,
} from "./help.ts";

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
  // OS-170: `ob machine audit --stale-days N`.
  "stale-days": { type: "string" },
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
  // OS-108: `ob spinoff <ref> --over-usage '<why>'`, past the critical-only usage line. A string, so an empty reason reaches the refusal.
  "over-usage": { type: "string" },
  // OS-134: `ob spinoff <ref> --allow-paused '<why>'`, past a paused or archived project. A string, so an empty reason reaches the refusal.
  "allow-paused": { type: "string" },
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
  range: { type: "string" }, // OS-177: spinoff trial start --range 4-6
  complexity: { type: "string" }, // OS-177: spinoff --complexity 1-10, the routing key (--tier is its alias)
  effort: { type: "string" }, // OB-1815: spinoff --effort low|medium|high|xhigh|max
  profile: { type: "string" }, // OS-145: ob models set|unset|reader --profile <p>
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
  repair: { type: "string" }, // OS-172: ob state <id> <to> --repair '<why>'
  "no-deliver": { type: "boolean" },
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
  // 220: TLS for `ob web` and the Let's Encrypt rehearsal switch for `ob cert renew`.
  "tls-cert": { type: "string" },
  "tls-key": { type: "string" },
  // OB-2160: `ob web --prebuilt` serves the dist on disk without building (the server's unit).
  prebuilt: { type: "boolean" },
  // OB-2199 step 1: `ob web --app <name>` serves apps/<name> on `--port` (default ob-dashboard, OS-214).
  app: { type: "string" },
  port: { type: "string" },
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
  // OS-163: `ob spinoff land --pr-url <url>`, the merged PR a reconcile on another machine read.
  "pr-url": { type: "string" },
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
  // OS-222: `ob db clone --grant-role <role> | --no-grant` (`--target` is shared with deploy record).
  "grant-role": { type: "string" },
  "no-grant": { type: "boolean" },
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
  // OS-55: `ob role brief --peek` prints the waiting note without marking it shown.
  peek: { type: "boolean" },
  // `ob inbox <team> <role> --read <id>... --by <run|agent id>`: the first id; more follow as positionals.
  read: { type: "string" },
} as const;

export const HANDLERS: Record<string, (ctx: Ctx) => void | Promise<void>> = {
  add: cmdAdd,
  edit: cmdEdit,
  triage: cmdTriage,
  note: cmdNote,
  tag: cmdTag,
  untag: cmdUntag,
  tags: cmdTags,
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
  machine: cmdMachine,
  review: cmdReview,
  gate: cmdGate,
  person: cmdPerson,
  whois: cmdWhois,
  tournament: cmdTournament,
  ci: cmdCi,
  github: cmdGithub,
  overnight: cmdOvernight,
  models: cmdModels,
  "api-token": cmdApiToken,
  usage: cmdUsage,
  cloudflare: cmdCloudflare,
  log: cmdLog,
  gmail: cmdGmail,
  cal: cmdCal,
  agenda: cmdAgenda,
  google: cmdGoogle,
  secret: cmdSecret,
  creds: cmdCreds,
  skills: cmdSkills,
  vision: cmdVision,
  t3: cmdT3,
  role: cmdRole,
  send: cmdSend,
  inbox: cmdInbox,
};

export const HELP = renderRootHelp();

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
    parsed = parseArgs({ args: expandSkillsFixFlag(expandVisionPairFlags(argv), FLAGS), options: FLAGS, allowPositionals: true, strict: true });
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
    const helpArgs = command === "help" ? positionals.slice(1) : positionals;
    const resolved = resolveHelp(helpArgs);
    if ("error" in resolved) {
      process.stderr.write(`error: ${resolved.error}\n`);
      return 2;
    }
    console.log(resolved.text);
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
      // OS-108: the server cannot see this machine's usage or thread, so the usage gate is asked here.
      try {
        const overUsage = (flags as unknown as Record<string, unknown>)["over-usage"];
        await refuseOverUsageBeforeDispatch(resolver, command, positionals.slice(1), typeof overUsage === "string" ? overUsage : undefined);
      } catch (err) {
        if (!(err instanceof AppError) && !(err instanceof UsageError)) throw err;
        process.stderr.write(`error: ${err.message}\n`);
        return err instanceof UsageError ? 2 : 1;
      }
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

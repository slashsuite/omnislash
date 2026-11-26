// ob 352 -- THE SHARED CONTRACT between the API server (phase A, this ticket) and the `ob` client that
// calls it (phase B, ob 353).
//
// Both halves import THIS file. That is the whole point of it: a client and a server that agree only by
// coincidence is the class of bug this repo keeps paying for, and it is the one bug an HTTP boundary
// makes invisible -- a field renamed on one side arrives as `undefined` on the other, and `undefined`
// renders as an empty column rather than as an error.
//
// Nothing here has a runtime dependency. Every import is `import type`, so this module erases entirely at
// build time and can be pulled into either side without dragging bun:sqlite, drizzle or the store in.
//
// Design: PURPOSE-BUILT endpoints. Each one is a verb ob already has, taking
// structured values and returning a typed result. Three shapes were rejected deliberately and must not be
// drifted back toward:
//   - generic CRUD over tables (`PATCH /items/:id {status:"done"}`) -- it makes the CLIENT responsible for
//     what closing an item MEANS: the linked GitHub issue, the event record.
//   - store-level query/mutate over HTTP -- SQL over the wire, a far wider surface to secure, and it puts
//     the schema in the client's hands.
//   - `POST /rpc/<command>` with argv -- remote command execution with a token in front, no typed
//     contract, and an API nobody can reason about without reading the CLI.
//
// ARGUMENT PARSING STAYS IN THE CLI. The API takes values, never argv: `--priority high` is parsed on the
// laptop into `{ priority: "high" }` and VALIDATED again here, because a server that trusts its client is
// a server with no contract at all.
import type { ItemView } from "../output.ts";
import type { ItemDetail } from "../detail.ts";
import type { StatusSnapshot } from "../commands/status.ts";
import type { AgentRow, AgentStatusRow } from "../../../../platform/cli-coord/src/agent.ts";
import type { LeaseHold, LeaseStatusRow } from "../../../../platform/cli-coord/src/lease.ts";
import type { CredentialCheckRow, CredentialStatus } from "../credentials.ts";
import type { LeaseBlocked, ReclaimEntry, SpinoffMode, SpinoffRow } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import type { CheckResult } from "../../../../platform/cli-coord/src/spinoff-check.ts";
import type { TokenUsage } from "../../../../platform/cli-coord/src/spinoff-tokens.ts";
import type { WhatsappHit } from "../../../../platform/cli-whatsapp/src/ingest/whatsapp.ts";
import type { EmailHit } from "../../../../platform/cli-sources/src/ingest/gmail.ts";
import type {
  GmailDeleteDraftResult,
  GmailDraftEdit,
  GmailDraftPreview,
  GmailDraftRequest,
  GmailSendDraftResult,
} from "../../../../platform/cli-sources/src/gmail-draft.ts";
import type {
  GmailAttachmentsResult,
  GmailMessageRead,
} from "../../../../platform/cli-sources/src/gmail-message.ts";
import type { AgendaRow } from "../../../../platform/cli-sources/src/ingest/calendar.ts";
import type { Project } from "../project.ts";
import type { Team, TeamView } from "../team.ts";
import type { TeamHandoff } from "../team-handoff.ts";
import type { RoleRun } from "../role-run.ts";
import type { RoleBriefStoreFacts } from "../role-brief.ts";
import type { TickFinding } from "../role-tick.ts";
import type { RoleMessage } from "../inbox.ts";
import type { JournalEntry, JournalType } from "../commands/log.ts";
import type { JobHealth } from "../jobs.ts";
import type { Alert } from "../commands/alerts.ts";
import type { Snapshot } from "../realtime.ts";
import type { StatusPage } from "../../../../platform/cli-whatsapp/src/whatsapp/status.ts";
import type { WhatsappChatItem } from "../../../../platform/cli-whatsapp/src/ingest/whatsapp.ts";
import type { StandupRow } from "../commands/standup.ts";
import type { SlackMessageRow } from "../commands/slack.ts";
import type { RoadmapMember, Progress, OnTrack } from "../commands/roadmap.ts";
import type { PersonRow, PersonFields } from "../commands/person.ts";
import type { CiMainReport, CiOutcome, HookPlanRow } from "../ci-main.ts";
import type { Tournament, TournamentCandidate, TournamentListRow, TournamentMatch, TournamentView } from "../tournament.ts";
import type { OvernightDecision, OvernightNight, OvernightRun, OvernightRunRow } from "../overnight.ts";
import type { RankedClass } from "../commands/reviewmiss.ts";
import type { MachineAudit } from "../machine-audit.ts";
import type { TestUserRow } from "../commands/testuser.ts";

export type {
  ItemView,
  ItemDetail,
  StatusSnapshot,
  AgentRow,
  AgentStatusRow,
  LeaseHold,
  LeaseStatusRow,
  CredentialStatus,
  CredentialCheckRow,
  SpinoffRow,
  SpinoffMode,
  LeaseBlocked,
  ReclaimEntry,
  TokenUsage,
  WhatsappHit,
  EmailHit,
  AgendaRow,
  Project,
  JournalEntry,
  JournalType,
  JobHealth,
  Alert,
  Snapshot,
  StandupRow,
  SlackMessageRow,
  RoadmapMember,
  Progress,
  OnTrack,
  PersonRow,
  PersonFields,
  RankedClass,
  TestUserRow,
};

/** A recorded hold, with `expired` saying whether it is still live (lease.ts's recordedHold). */
export type RecordedHold = LeaseHold & { expired: boolean };

/**
 * Every path the API serves lives under this prefix.
 *
 * It is namespaced under `/api/ob` rather than mounted at the root because the host is the DASHBOARD
 * server (D4) -- the same process serves the web UI's routes and its static assets, and an API route that
 * shadowed `/status` would take the page with it.
 */
export const OB_API_PREFIX = "/api/ob";

/** The header the bearer token travels in. It NEVER travels in a query string or a path (D5). */
export const OB_API_AUTH_HEADER = "authorization";

// --- the errors a client has to be able to tell apart -------------------------------------------------
//
// A code rather than a status alone, because several distinct refusals share a status: a 400 from a bad
// priority name and a 400 from an illegal state transition want different handling on the client, and
// string-matching an English message is how that goes wrong.

export const OB_API_ERROR_CODES = [
  /** No token, or the wrong one. The two are DELIBERATELY indistinguishable (D5). */
  "unauthorized",
  /** OS-178: a scoped token asked for a route family (or a method) it is not granted. */
  "forbidden",
  /** No token file is configured on the server, so the API serves nothing rather than serving openly. */
  "api_disabled",
  /** The method+path is not one this API serves. The response names what IS served. */
  "unknown_endpoint",
  /** The request body or query failed validation. `message` names the field. */
  "invalid_request",
  /** The named item / agent / lease does not exist. */
  "not_found",
  /** The request was well-formed but the domain refused it (an illegal transition, a held lease). */
  "refused",
  /** The store (or the handler behind it) did not answer inside the server's request deadline (1616). */
  "timeout",
  /** A shared store the handler needs was locked by someone else or unreadable; try again (OB-1935). */
  "busy",
  /** The handler threw. The message is the thrown message; no stack ever crosses the wire. */
  "internal",
] as const;

export type ObApiErrorCode = (typeof OB_API_ERROR_CODES)[number];

export interface ObApiErrorBody {
  error: {
    code: ObApiErrorCode;
    message: string;
    /** For `unknown_endpoint`: every route this API serves, so a refusal is self-documenting. */
    served?: string[] | undefined;
  };
}

// --- slow routes (1616) -------------------------------------------------------------------------------

/**
 * Routes that legitimately run for minutes: an ingest on the API host (a Gmail backfill, a GitHub sweep) or a
 * live credential check. They get SLOW_ROUTE_TIMEOUT_FACTOR times the ordinary request/client deadline, on
 * both ends, so a long sync is not turned into a 504 and then retried on top of itself.
 */
const OB_API_SLOW_ROUTES = ["/gmail/sync", "/cal/sync", "/sync", "/creds/check", "/whatsapp/send"] as const;
export const SLOW_ROUTE_TIMEOUT_FACTOR = 10;

/** `route` is the path under the prefix, with or without a query string. */
export function apiTimeoutFor(route: string, baseMs: number): number {
  const path = route.split("?")[0]!.replace(/\/+$/, "");
  return (OB_API_SLOW_ROUTES as readonly string[]).includes(path) ? baseMs * SLOW_ROUTE_TIMEOUT_FACTOR : baseMs;
}

// --- the endpoints ------------------------------------------------------------------------------------

export interface ObApiRoute {
  method: "GET" | "POST" | "DELETE";
  /** Path under the prefix, with `:param` segments. */
  path: string;
  /**
   * OS-178: the route family a scoped token is granted by. Every family is in exactly one of
   * OB_API_SCOPABLE_FAMILIES or OB_API_ADMIN_FAMILIES, and a test fails on one that is in neither.
   */
  family: string;
  /** What it does, one line -- this is what an `unknown_endpoint` refusal lists. */
  what: string;
  /**
   * OS-179: what a scoped token may do on this route, granted per route rather than per family. Unmarked is
   * admin only (403 to a scoped token); `read` admits a GET; `write` admits any method. Only a route in an
   * OB_API_SCOPABLE_FAMILIES family may carry it, and every such route filters to the token's projects.
   */
  scoped?: "read" | "write" | undefined;
}

/**
 * THE SERVED SURFACE. Short and explicit, in the same spirit as ob 337's servable list: a command that is
 * not here is not reachable over HTTP, and asks for it are refused BY NAME rather than half-answered.
 */
export const OB_API_ROUTES: readonly ObApiRoute[] = [
  { method: "GET", path: "/health", family: "health", what: "liveness plus which store the server is on" },
  { method: "GET", path: "/next", family: "next", what: "the worklist", scoped: "read" },
  { method: "GET", path: "/items", family: "items", what: "query items (state, project, type, tag, kind, priority, limit)", scoped: "read" },
  { method: "POST", path: "/items", family: "items", what: "create an item", scoped: "write" },
  { method: "GET", path: "/items/:id", family: "items", what: "one item with its detail", scoped: "read" },
  { method: "POST", path: "/items/:id/close", family: "items", what: "close it, mirroring onto its linked GitHub issue", scoped: "write" },
  { method: "POST", path: "/items/:id/reopen", family: "items", what: "reopen it, mirroring onto its linked GitHub issue", scoped: "write" },
  { method: "POST", path: "/items/:id/state", family: "items", what: "start / ready / block / unblock / set a state", scoped: "write" },
  // OB-1762: the native app's item sheet. One call, and the answer is the FRESH detail, so the sheet redraws
  // without a second round trip (the dashboard's transitionItem / setTodayRank, over HTTP).
  { method: "POST", path: "/items/:id/transition", family: "items", what: "start / ready / block / unblock / close / reopen, answering the fresh item detail (OB-1762)", scoped: "write" },
  { method: "POST", path: "/items/:id/rank", family: "items", what: "rank into Today (or the next slot; clear: true removes it), answering the fresh item detail (OB-1762)", scoped: "write" },
  { method: "POST", path: "/items/:id/order", family: "items", what: "place it in its project's queue: top, before or after another item; a move across a priority band sets the priority, answering the fresh item detail (OB-2083)", scoped: "write" },
  { method: "GET", path: "/snapshot", family: "snapshot", what: "the dashboard's full snapshot (status rollup incl. the Today list, standup, spinoffs, agents, WhatsApp feed + Status tray, alert count; OB-1762)" },
  { method: "POST", path: "/items/:id/notes", family: "items", what: "append a note to the body", scoped: "write" },
  { method: "POST", path: "/items/:id/tags", family: "items", what: "add and/or remove tags", scoped: "write" },
  { method: "POST", path: "/items/:id/links", family: "items", what: "add an item-to-item link (rel + other id)", scoped: "write" },
  { method: "POST", path: "/items/:id/edit", family: "items", what: "edit title, body, priority, project", scoped: "write" },
  { method: "DELETE", path: "/items/:id", family: "items", what: "delete an item" },
  { method: "POST", path: "/today", family: "today", what: "set or clear today's rank" },
  { method: "GET", path: "/focus", family: "focus", what: "the current focus project" },
  { method: "POST", path: "/focus", family: "focus", what: "set or clear the focus project" },
  { method: "GET", path: "/search", family: "search", what: "full-text search (?q=)", scoped: "read" },
  { method: "GET", path: "/status", family: "status", what: "the status rollup" },
  { method: "GET", path: "/agents", family: "agents", what: "the agent registry", scoped: "read" },
  { method: "POST", path: "/agents", family: "agents", what: "register / heartbeat / finish an agent, claiming its ticket lease", scoped: "write" },
  { method: "POST", path: "/agents/reset", family: "agents", what: "wipe the agent registry and release every lease (437)" },
  { method: "GET", path: "/agents/active", family: "agents", what: "is any agent alive in the last ?within_min minutes (StayAwake)", scoped: "read" },
  { method: "GET", path: "/leases", family: "leases", what: "every lease with its computed expiry", scoped: "read" },
  { method: "POST", path: "/leases", family: "leases", what: "acquire or heartbeat a lease", scoped: "write" },
  { method: "POST", path: "/leases/sweep", family: "leases", what: "delete leases expired for over a day (OB-1922)" },
  { method: "DELETE", path: "/leases/:resource", family: "leases", what: "release a lease", scoped: "write" },
  { method: "GET", path: "/secrets", family: "secrets", what: "the stored secrets' NAMES and ages -- never a value" },
  { method: "POST", path: "/secrets/read", family: "secrets", what: "decrypt ONE secret and return its value" },
  { method: "POST", path: "/secrets", family: "secrets", what: "store one secret's value" },
  { method: "POST", path: "/secrets/remove", family: "secrets", what: "delete one secret" },
  { method: "GET", path: "/creds", family: "creds", what: "the credential inventory: presence, age, last verdict" },
  { method: "POST", path: "/creds/check", family: "creds", what: "run one credential's live check, or every checkable one" },
  // ob 360: the spinoff QUEUE. Every launch stays on the client; none of these opens a tab.
  { method: "GET", path: "/spinoffs", family: "spinoffs", what: "the launch queue's rows (?status=)", scoped: "read" },
  { method: "POST", path: "/spinoffs", family: "spinoffs", what: "enqueue a launch", scoped: "write" },
  { method: "POST", path: "/spinoffs/check", family: "spinoffs", what: "record a measure-twice verdict: both score sheets in, the server computes and records it (OB-1825)", scoped: "write" },
  { method: "POST", path: "/spinoffs/overlap", family: "spinoffs", what: "a ticket's declared files (op declared), or one overlap decision recorded on its trail (op record), for the dispatch overlap warning (OS-47)", scoped: "write" },
  { method: "POST", path: "/spinoffs/planned-files", family: "spinoffs", what: "each row's planned files from its ticket's newest go check, for the files: line of gateable and show (OB-2131)", scoped: "write" },
  { method: "POST", path: "/spinoffs/serving", family: "spinoffs", what: "the rows that SERVE one item — the join settle-on-close uses, resolved where the store is (1226)", scoped: "write" },
  { method: "GET", path: "/spinoffs/config", family: "spinoffs", what: "the launcher configuration the launching machine needs", scoped: "read" },
  { method: "POST", path: "/spinoffs/launchable", family: "spinoffs", what: "what a drain could launch now: live counts, pending rows, holds", scoped: "write" },
  { method: "POST", path: "/spinoffs/claim", family: "spinoffs", what: "claim ONE pending row for the caller (the atomic exclusion)", scoped: "write" },
  { method: "POST", path: "/spinoffs/stamp", family: "spinoffs", what: "record the outcome of a launch the caller performed", scoped: "write" },
  { method: "POST", path: "/spinoffs/land", family: "spinoffs", what: "retire a merged row: status, tokens, its agent and leases", scoped: "write" },
  { method: "POST", path: "/spinoffs/tokens", family: "spinoffs", what: "record the token count a client read for a landed row that has none (OB-1993)", scoped: "write" },
  { method: "POST", path: "/spinoffs/ready", family: "spinoffs", what: "mark a launched row ready-for-gate, printed handed-off (human declared; no merge, no lease release)", scoped: "write" },
  { method: "POST", path: "/spinoffs/sendback", family: "spinoffs", what: "move a handed-off row back to building (architect send-back; the T3 note to the builder is sent by the client)", scoped: "write" },
  { method: "POST", path: "/spinoffs/resume", family: "spinoffs", what: "move a handed-off row back to building because the work continues on the same row (OS-235), not a send-back", scoped: "write" },
  { method: "POST", path: "/spinoffs/reopen", family: "spinoffs", what: "move a landed row back to building (OB-2180: a wrong land; the client has already checked main for a landing commit)" },
  { method: "POST", path: "/spinoffs/note-error", family: "spinoffs", what: "record or clear why a row's readying note did not reach the architect (OB-2172)", scoped: "write" },
  { method: "POST", path: "/spinoffs/verdict", family: "spinoffs", what: "record a clean repo's verdict on its row (`ob spinoff state`, OB-1992)", scoped: "write" },
  { method: "POST", path: "/spinoffs/phase", family: "spinoffs", what: "move a row's role phase inside its status through the phase machine (`ob spinoff phase`, OS-183)", scoped: "write" },
  { method: "POST", path: "/spinoffs/trial", family: "spinoffs", what: "one model-trial operation: start, status, stop, a pair's open/attach/void, record, report (OB-1991)" },
  { method: "POST", path: "/spinoffs/reclaim", family: "spinoffs", what: "take back rows claimed by a drain that never stamped them" },
  { method: "POST", path: "/spinoffs/cleanup-guard", family: "spinoffs", what: "the holds and agent row covering ONE worktree/branch a sweep wants to remove", scoped: "write" },
  // `ob config` over the API: the config table the SERVER keeps, so a client flips a setting like
  // `spinoff_engine` without a database path. The client's OWN pointer is not a config key (see the
  // client handler's `remote_host` refusal).
  { method: "GET", path: "/config", family: "config", what: "the config table (?key= for one key)" },
  { method: "POST", path: "/config", family: "config", what: "set one config value, or unset it with value:null" },
  // `ob issue` (169 + 389): pairing is DATA and is served. `landed`/`drift` SPLIT like spinoff:
  // pairing + store facts over the API; git runs on THIS machine. `reconcile` and `add --issue` use
  // the GitHub credential on the API host, so they are served rather than refused.
  { method: "GET", path: "/issues", family: "issues", what: "the ob item <-> GitHub issue pairs" },
  { method: "POST", path: "/issues/link", family: "issues", what: "pair an existing item with an existing issue" },
  { method: "POST", path: "/issues/unlink", family: "issues", what: "clear whichever reference an item holds (issue or Linear)" },
  { method: "GET", path: "/issues/pairing", family: "issues", what: "store facts landed/drift need: pairs, spinoffs, unlinked ids, tracker repo" },
  { method: "GET", path: "/issues/github", family: "issues", what: "the wayfinder-labelled GitHub issues (credential stays on the host)" },
  { method: "GET", path: "/issues/reconcile", family: "issues", what: "candidate unlinked ob<->issue pairs (?limit=)" },
  // `ob triage` (375): the cross-architect inbox as DATA. `reject` closes the item SERVER-side (clear +
  // `done`); the client never closes -- exactly what the local command's `reject` does.
  { method: "GET", path: "/triage", family: "triage", what: "the triage inbox: items awaiting triage, newest first" },
  { method: "POST", path: "/triage/:id/clear", family: "triage", what: "clear the triage flag, keeping the item open" },
  { method: "POST", path: "/triage/:id/reject", family: "triage", what: "close the item through the same door as /close (validated, on the trail, mirrored, spinoff rows landed); any close clears the flag" },
  // `ob whatsapp` (366): search/recent are ingested messages in Postgres.
  { method: "GET", path: "/whatsapp/search", family: "whatsapp", what: "FTS over ingested WhatsApp messages (?q=&limit=)" },
  { method: "GET", path: "/whatsapp/recent", family: "whatsapp", what: "most-recent ingested WhatsApp messages (?limit=&since=)" },
  // OB-1809: the rest of `ob whatsapp`. The bridge runs on this host, so these reach it from anywhere. The send's
  // human gate stays on the caller's terminal, and the route refuses a body without the literal confirm:true.
  { method: "POST", path: "/whatsapp/send", family: "whatsapp", what: "send through this host's bridge; refused unless the body carries confirm:true, set only after a human confirmed the exact text and recipient (OB-1809)" },
  { method: "POST", path: "/whatsapp/prefs", family: "whatsapp", what: "set one chat's hide/show/ai-off/ai-on/favorite/unfavorite and answer its prefs (OB-1809)" },
  { method: "GET", path: "/whatsapp/prefs/hidden", family: "whatsapp", what: "the hidden chats (OB-1809)" },
  { method: "GET", path: "/whatsapp/prefs/favorites", family: "whatsapp", what: "the favourite chats (OB-1809)" },
  // `ob gmail` / `ob cal` / `ob agenda` (415): store reads plus sync ON THE HOST using secret `google`.
  // `ob google auth` (420) is the DESKTOP half: loopback RUNS on THIS machine, persist via POST /secrets.
  // 1305 adds the HOSTED half: /google/auth + /google/callback are the only BROWSER routes (no bearer --
  // the one-time `state` is their guard) and persist through the same secret path, so a phone can finish
  // a re-auth. /google/auth-url mints through the same state store for `ob google auth-url`.
  { method: "GET", path: "/gmail/search", family: "gmail", what: "FTS over ingested email (?q=&limit=)" },
  { method: "GET", path: "/gmail/list", family: "gmail", what: "most-recent ingested email (?limit=&since=)" },
  { method: "POST", path: "/gmail/sync", family: "gmail", what: "poll Gmail on the API host using secret google" },
  // 1757: a DRAFT is all an agent can make; sending an existing draft needs `confirm: true` (a human's --confirm).
  { method: "GET", path: "/gmail/messages/:id", family: "gmail", what: "read one Gmail message: headers, text body, attachment list (1680)" },
  { method: "GET", path: "/gmail/messages/:id/attachments", family: "gmail", what: "a message's attachments with bytes (?name= for one) (1680)" },
  { method: "POST", path: "/gmail/drafts", family: "gmail", what: "create a Gmail DRAFT, optionally with attachments and a Send-as `from` (never sends)" },
  { method: "GET", path: "/gmail/drafts", family: "gmail", what: "the newest Gmail drafts with recipients and subject (?limit=) (OB-1750)" },
  { method: "GET", path: "/gmail/drafts/:id", family: "gmail", what: "a draft's recipients, subject and body preview" },
  { method: "POST", path: "/gmail/drafts/:id/edit", family: "gmail", what: "replace from/to/cc/subject/body/attachments of a draft in place; never sends (OB-1750)" },
  { method: "DELETE", path: "/gmail/drafts/:id", family: "gmail", what: "delete a draft outright; refused without ?confirm=true (OB-1750)" },
  { method: "POST", path: "/gmail/drafts/:id/send", family: "gmail", what: "send an EXISTING draft; refused without confirm: true" },
  { method: "GET", path: "/cal/agenda", family: "cal", what: "today's calendar events from the store" },
  { method: "POST", path: "/cal/sync", family: "cal", what: "poll Google Calendar on the API host using secret google" },
  { method: "GET", path: "/google/auth", family: "google", what: "302 to Google consent for a state minted by auth-url (browser; the state is the guard)" },
  { method: "GET", path: "/google/callback", family: "google", what: "verify+burn state, exchange the code, store secret google (browser)" },
  { method: "POST", path: "/google/auth-url", family: "google", what: "mint a state and return the authorize URL (`ob google auth-url`)" },
  // 416: already Postgres-servable. Purpose-built endpoints, not POST /rpc.
  { method: "GET", path: "/projects", family: "projects", what: "the project table", scoped: "read" },
  { method: "POST", path: "/projects", family: "projects", what: "register a project (refuses a name that exists with a different kind/remote)" },
  { method: "POST", path: "/projects/:name/edit", family: "projects", what: "change a project's remote and/or kind" },
  { method: "DELETE", path: "/projects/:name", family: "projects", what: "remove a project row (?force=true past open items)" },
  { method: "GET", path: "/teams", family: "teams", what: "teams with their members and role threads (OB-2255)", scoped: "read" },
  { method: "POST", path: "/teams", family: "teams", what: "add a team (optionally with its first projects)" },
  { method: "POST", path: "/teams/leave", family: "teams", what: "take projects out of whatever team they are in" },
  { method: "GET", path: "/teams/:name", family: "teams", what: "one team with its members and role threads", scoped: "read" },
  { method: "POST", path: "/teams/:name/edit", family: "teams", what: "change a team's icon and/or display name" },
  { method: "POST", path: "/teams/:name/join", family: "teams", what: "put projects into a team (refused for a project in another team)" },
  { method: "DELETE", path: "/teams/:name", family: "teams", what: "remove a team (?force=true clears its members and role rows)" },
  { method: "POST", path: "/teams/:name/handoffs", family: "teams", what: "record a role thread's handoff for `ob t3 team restart` (OB-2257); from_thread_id names the writer (OB-2275)", scoped: "write" },
  { method: "GET", path: "/teams/:name/handoffs/latest", family: "teams", what: "a role's newest handoff (?role=; ?from=<thread> keeps that thread's, ?created_before=<iso> those recorded by then, OB-2275), or null", scoped: "read" },
  { method: "POST", path: "/teams/:name/handoffs/:id/consume", family: "teams", what: "mark a handoff seeded into its replacement thread", scoped: "write" },
  { method: "GET", path: "/teams/:name/runs", family: "teams", what: "the team's open role runs (?role= keeps one role's)", scoped: "read" },
  { method: "POST", path: "/teams/:name/runs", family: "teams", what: "open a role run's marker and take its lease, or answer the open run (created false)", scoped: "write" },
  { method: "POST", path: "/teams/:name/runs/:id", family: "teams", what: "record a role run's thread id or activity, or end it (end_reason releases its lease)", scoped: "write" },
  { method: "GET", path: "/teams/:name/tick", family: "teams", what: "what needs the team's architect, from the store (`ob role tick`, OS-67): stale builders, unfixed flakes, idle projects; each with its stamp", scoped: "read" },
  { method: "GET", path: "/teams/:name/brief", family: "teams", what: "the store facts of a role's start brief (?role=); a read, so the waiting note stays until note-shown", scoped: "read" },
  { method: "POST", path: "/teams/:name/notes", family: "teams", what: "store a role's successor note on its open run, else its last ended one ({role, body}; 40 lines, 4000 characters)", scoped: "write" },
  { method: "POST", path: "/teams/:name/runs/:id/note-shown", family: "teams", what: "mark a run's successor note shown (after `ob role brief` printed it or `ob role start` delivered it)", scoped: "write" },
  { method: "POST", path: "/teams/:name/inbox", family: "teams", what: "store a message for a team role (`ob send`); a handoff's client_key stores it once", scoped: "write" },
  { method: "GET", path: "/teams/:name/inbox", family: "teams", what: "a team role's messages, oldest first (?role=; unread and not withdrawn unless ?unread=false)", scoped: "read" },
  { method: "POST", path: "/teams/:name/inbox/read", family: "teams", what: "mark a role's messages read by a run or agent ({role, ids, by})", scoped: "write" },
  { method: "GET", path: "/brief", family: "brief", what: "work-state brief (?q= id, or ?in_flight=true)" },
  { method: "GET", path: "/log", family: "log", what: "standup journal entries (?type=&since=)" },
  { method: "POST", path: "/log", family: "log", what: "capture a journal entry (kudos|suggestion|comment)" },
  { method: "GET", path: "/jobs", family: "jobs", what: "per-job health of the declared daemon fleet" },
  { method: "POST", path: "/deploys/run", family: "deploys", what: "start the live deploy fire-and-forget through systemd ({sha?} pins it); the bearer token is required, with no exemption (OB-1809)" },
  { method: "GET", path: "/alerts", family: "alerts", what: "active unsnoozed alerts" },
  { method: "POST", path: "/alerts/snooze", family: "alerts", what: "snooze one alert by key, answering the fresh alert list" },
  { method: "POST", path: "/alerts/ack", family: "alerts", what: "ack (dismiss) one alert by key, answering the fresh alert list (OB-1762)" },
  { method: "GET", path: "/decisions", family: "decisions", what: "decision items (?status=)", scoped: "read" },
  { method: "GET", path: "/decisions/:id", family: "decisions", what: "one decision with its chain", scoped: "read" },
  { method: "POST", path: "/decisions/supersede", family: "decisions", what: "new decision supersedes old (one txn)" },
  { method: "GET", path: "/docs", family: "docs", what: "reference documents, newest updated first (?project=) (OB-2004)" },
  { method: "POST", path: "/docs", family: "docs", what: "create a reference document ({title, project, body})" },
  { method: "GET", path: "/docs/:id", family: "docs", what: "one reference document: its whole body and its earlier versions" },
  { method: "POST", path: "/docs/:id/set", family: "docs", what: "replace a reference's title and/or body in place; the replaced text is kept as a version" },
  { method: "GET", path: "/learnings", family: "learnings", what: "learning items (?status=)" },
  { method: "GET", path: "/learnings/:id", family: "learnings", what: "one learning item with detail" },
  { method: "GET", path: "/roadmaps", family: "roadmaps", what: "roadmap items with progress" },
  { method: "GET", path: "/roadmaps/:id", family: "roadmaps", what: "one roadmap with members and on-track" },
  { method: "POST", path: "/roadmaps/:id/members", family: "roadmaps", what: "add a member to a roadmap" },
  { method: "GET", path: "/standup/latest", family: "standup", what: "the newest standup row" },
  { method: "POST", path: "/standup/save", family: "standup", what: "save generated standup markdown" },
  { method: "POST", path: "/standup/set", family: "standup", what: "save edited standup markdown" },
  { method: "POST", path: "/standup/posted", family: "standup", what: "mark today's standup posted and advance the cursor" },
  { method: "GET", path: "/slack/unread", family: "slack", what: "most-recent ingested Slack messages (?limit=). No poll." },
  // 456: remaining DATA commands.
  { method: "GET", path: "/people", family: "people", what: "the person registry" },
  { method: "POST", path: "/people", family: "people", what: "register a person" },
  { method: "GET", path: "/people/show", family: "people", what: "one person by id, handle, or name (?q=&reveal=)" },
  { method: "POST", path: "/people/set", family: "people", what: "update a person's fields" },
  { method: "POST", path: "/people/rm", family: "people", what: "delete a person by id" },
  { method: "GET", path: "/whois", family: "whois", what: "resolve a handle to a person (?handle=)" },
  // OB-1808: `db`, `backup` and `cert` run ON the API host, as a job a client polls, because they
  // shell out for minutes and must not hold a request open. The client names a kind, never an argv.
  { method: "POST", path: "/host-jobs", family: "host-jobs", what: "start a host job, or return the identical one already running (OB-1808)" },
  { method: "GET", path: "/host-jobs", family: "host-jobs", what: "recent host jobs, newest first, without output (OB-1808)" },
  { method: "GET", path: "/host-jobs/:id", family: "host-jobs", what: "one host job: status, exit code and, once finished, its scrubbed output (OB-1808)" },
  { method: "GET", path: "/db/snapshots/:name", family: "db", what: "download one snapshot from the host's rotated history (OB-1808)" },
  // OB-2271: `ob tournament`, persona tournaments. ob validates and stores; it never decides a winner.
  { method: "GET", path: "/tournaments", family: "tournaments", what: "every tournament with its candidate and match counts (?repo=; OB-2271)" },
  { method: "POST", path: "/tournaments", family: "tournaments", what: "start a tournament: subject, repo, criteria, ref (OB-2271)" },
  { method: "GET", path: "/tournaments/:id", family: "tournaments", what: "one tournament with its candidates, matches and calls, finalists and pick (OB-2271)" },
  { method: "POST", path: "/tournaments/:id/candidates", family: "tournaments", what: "register a candidate or update its label, images, revises (OB-2271)" },
  { method: "POST", path: "/tournaments/:id/matches", family: "tournaments", what: "record a match file (the parsed JSON); replace=true overwrites one by name (OB-2271)" },
  { method: "POST", path: "/tournaments/:id/pick", family: "tournaments", what: "record the owner's pick of a candidate (OB-2271)" },
  // OB-2276: GitHub webhooks, `ob ci main` and `ob github hooks`. The webhook carries no bearer token: GitHub's
  // X-Hub-Signature-256 over the body, keyed on the github-webhook-secret secret, is its guard.
  { method: "POST", path: "/github/webhook", family: "github", what: "GitHub's webhook receiver: no bearer, X-Hub-Signature-256 required; 202, 200 for ping or a redelivery (OB-2276)" },
  { method: "GET", path: "/ci/main", family: "ci", what: "each project's latest completed push run on main per workflow (?project=; OB-2276)" },
  { method: "POST", path: "/ci/main/notify", family: "ci", what: "the catch-up: tell each red run on main the receiver missed, and each recovery (OB-2276)" },
  { method: "GET", path: "/github/hooks", family: "github", what: "per project, whether its webhook to the receiver exists and is right; changes nothing (OB-2276)" },
  { method: "POST", path: "/github/hooks", family: "github", what: "create or fix each project's webhook to the receiver (OB-2276)" },
  // OB-2097: `ob overnight`, the overnight decision log. A night is a run doc per project per date, a decision a
  // `decision` item; the project is resolved on the caller's machine and always sent.
  { method: "POST", path: "/overnight/start", family: "overnight", what: "create the night's run doc from the template, or return the existing one (OB-2097)" },
  { method: "POST", path: "/overnight/decide", family: "overnight", what: "record a decision with what, why, doubt, undo; --night joins it to a run (OB-2097)" },
  { method: "POST", path: "/overnight/summary", family: "overnight", what: "append a bullet to one section of a night's summary (OB-2097)" },
  { method: "POST", path: "/overnight/show", family: "overnight", what: "a night: its summary, problems and decisions in the order made (OB-2097)" },
  { method: "GET", path: "/overnight/runs", family: "overnight", what: "one row per run with decision and Review these counts (?project=&since=; OB-2097)" },
  { method: "POST", path: "/review-misses", family: "review-misses", what: "record a review-miss class" },
  { method: "GET", path: "/review-misses/top", family: "review-misses", what: "ranked review-miss classes (?scope=&limit=)" },
  { method: "GET", path: "/machine/audit", family: "machine", what: "rows the lifecycle machines cannot resolve, stale spinoff rows and would-refuse events (?since=&stale_days=; OS-170)" },
  { method: "GET", path: "/cursors", family: "cursors", what: "one skill_cursor value (?skill=&key=)" },
  { method: "POST", path: "/cursors", family: "cursors", what: "set a skill_cursor value" },
  { method: "GET", path: "/test-users", family: "test-users", what: "the test-user registry (?role=&env=)" },
  { method: "POST", path: "/test-users", family: "test-users", what: "register a test user and store its secret (host keychain)" },
  { method: "GET", path: "/test-users/show", family: "test-users", what: "one test user (?label=)" },
  { method: "POST", path: "/test-users/check", family: "test-users", what: "existence-check a test-user secret" },
  // OB-1765 (OB-1760 phase 0d): the native WhatsApp screen's reads. Read-only; sends stay confirm-gated and local.
  { method: "GET", path: "/whatsapp/status", family: "whatsapp", what: "the current WhatsApp Status tray, or a history page when ?before= is set (?limit=&before=&sender=; OB-1765)" },
  { method: "GET", path: "/whatsapp/chats", family: "whatsapp", what: "the chat list: the latest message per chat, newest first (?limit=&hidden=; OB-1765)" },
  { method: "POST", path: "/sync", family: "sync", what: "GitHub ingest on the API host" },
] as const;

/**
 * OS-178: the families a scoped token may be granted, read only (GET). Everything else, and every write
 * method, is 403 to a scoped token. Writes and spinoffs come in OS-179.
 */
export const OB_API_SCOPABLE_FAMILIES: readonly string[] = ["items", "next", "search", "projects", "spinoffs", "agents", "leases", "teams", "decisions"];

/** OS-178: the families only the admin token reaches. Named, so a new family must be classified. */
export const OB_API_ADMIN_FAMILIES: readonly string[] = [
  "alerts", "brief", "cal", "ci", "config", "creds", "cursors", "db", "deploys", "docs",
  "focus", "github", "gmail", "google", "health", "host-jobs", "issues", "jobs", "learnings", "log", "machine",
  "overnight", "people", "review-misses", "roadmaps", "secrets", "slack", "snapshot", "standup",
  "status", "sync", "test-users", "today", "tournaments", "triage", "whatsapp", "whois",
];

/**
 * OS-178: the OB_API_ROUTES entry a request is, or null. `rest` is the path under the prefix, already
 * split and decoded; a `:param` pattern segment matches any one segment. A literal match wins over a
 * parameter one, so `/agents/active` is never read as some `/agents/:x`.
 */
export function matchApiRoute(method: string, segments: readonly string[]): ObApiRoute | null {
  let best: ObApiRoute | null = null;
  let bestLiterals = -1;
  for (const r of OB_API_ROUTES) {
    if (r.method !== method) continue;
    const pattern = r.path.split("/").filter((s) => s.length > 0);
    if (pattern.length !== segments.length) continue;
    let literals = 0;
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i]!.startsWith(":")) continue;
      if (pattern[i] !== segments[i]) {
        ok = false;
        break;
      }
      literals++;
    }
    if (ok && literals > bestLiterals) {
      best = r;
      bestLiterals = literals;
    }
  }
  return best;
}

/** `METHOD /api/ob/path  -- what`, for the self-documenting refusal. */
export function describeRoutes(): string[] {
  return OB_API_ROUTES.map((r) => `${r.method} ${OB_API_PREFIX}${r.path}  -- ${r.what}`);
}

/**
 * The commands that are NOT served and never will be, each with the reason it stays on the machine in
 * front of the human (map D3). A client asks for these locally; the API's job is to say plainly that it
 * is not the place to ask, so a future client cannot quietly acquire a second way to run them.
 */
export const OB_API_LOCAL_ONLY: Readonly<Record<string, string>> = {
  // ob 360: `spinoff` is SPLIT, not local. Its queue (rows, the ticket, the leases) is data and is served
  // under /spinoffs; the worktree and the agent spawn stay on the machine in front of the human. It is NOT
  // listed here any more precisely because the previous classification sent people to this host, which
  // holds neither the checkouts nor the launcher -- the one machine that cannot do the job.
  daemon: "writes this machine's launchd plists",
  web: "starts the dashboard on the API host",
  // 456: person/whois/…/sync are DATA and ARE served.
  vision: "mlx-vlm compare of local screenshot files on THIS machine (468; nothing leaves the machine)",
  // 1102/1120: `t3` is SPLIT, like `spinoff`. `doctor`/`login` drive THIS machine's T3 Code server and
  // its own MCP credential file (~/.omnislash/t3-mcp-credential.json), which a remote API host has neither
  // of, so they RUN here -- but a team role's idempotency is an agent-registry row (`architect-<team>` and the
  // rest carry the thread id) plus the team itself, which are tracker DATA, so its database half goes over the API. Not listed here any more for the
  // same reason `spinoff` is not: the classification is per-half, and the handler owns both.
  models: "the models file is local to the machine that launches (~/.config/ob/models.jsonc, OB-1969); nothing reads it over the API",
  "api-token": "writes the scoped API tokens file on THIS machine (~/.ob_api_tokens.json, OS-178); a token is never sent over HTTP",
  skills: "reads and repoints the skill links in ~/.claude/skills on THIS machine (OS-182)",
  gate: "runs the gate.json of the checkout it is run in, on THIS machine (OS-210)",
  usage: "reads the Claude transcripts on THIS machine (~/.claude/projects, OB-2278); the thread names alone come over the API",
};

// --- /config ------------------------------------------------------------------------------------------

export interface ConfigEntry {
  key: string;
  value: string | null;
}

export interface ConfigResponse {
  config: ConfigEntry[];
}

export interface ConfigSetRequest {
  key: string;
  /** null unsets the key. An empty string is refused, so a forgotten value cannot blank a setting. */
  value: string | null;
}

export interface ConfigSetResponse {
  key: string;
  value: string | null;
}

// --- /issues ------------------------------------------------------------------------------------------
//
// ob 169 + 389: the DATA half of `ob issue` (list/link/unlink/reconcile) plus the pairing snapshot
// landed/drift consume. `landed` and `drift` read THIS machine's git checkout (D3) and RUN here; they
// take pairing + spinoff facts from the API rather than refusing and sending the caller to the host
// (the 360-class bug: the host has the wrong checkout). `reconcile` and `ob add --issue` use the
// GitHub credential on the API host, so they are served.
//
// The repo is resolved SERVER-side, exactly as the local command does: a bare `#<n>` has no repo, so the
// server defaults it to `wayfinder_repo`; only a full URL carries its own `owner/name` across the wire.

export interface IssueLinkView {
  /** The ob item id. */
  id: string;
  status: string;
  title: string;
  /** The GitHub issue number. */
  issue: number;
  /** `owner/name` the issue lives in. */
  repo: string;
}

export interface IssuesResponse {
  issues: IssueLinkView[];
}

export interface IssueLinkRequest {
  item_id: string;
  number: number;
  /** Only a URL carries its own repo; a bare `#<n>` leaves this null and the server defaults it. */
  repo?: string | null | undefined;
}

export interface IssueLinkResponse {
  id: string;
  issue: number;
  repo: string;
  url: string;
}

export interface IssueUnlinkRequest {
  item_id: string;
}

export interface IssueUnlinkResponse {
  id: string;
  /** What was cleared: `issue` | `linear`, or null when the item carried no reference. */
  kind: "issue" | "linear" | null;
  issue: number | null;
  linear_id: string | null;
  url: string | null;
}

/** One spinoff row the landed/drift git half needs (namespace + unique-commit proof). */
export interface IssuePairingSpinoff {
  ticket_ref: string;
  branch: string;
  base_sha: string | null;
  status: string;
}

/**
 * Store facts `ob issue landed` / `ob issue drift` consume on THIS machine. Git is not in here.
 */
export interface IssuePairingResponse {
  tracker_repo: string;
  /** `type` is absent from an older server; the client reads that as a task (OB-1929). */
  issues: Array<IssueLinkView & { type?: string | undefined }>;
  unlinked_ob_ids: number[];
  spinoffs: IssuePairingSpinoff[];
  item_ids: string[];
}

export interface GithubIssueView {
  number: number;
  title: string;
  state: string;
}

export interface GithubIssuesResponse {
  repo: string;
  issues: GithubIssueView[];
}

export interface IssueReconcileCandidate {
  item_id: string;
  item_title: string;
  item_status: string;
  issue: number;
  issue_title: string;
  issue_state: string;
  score: number;
  reasons: string[];
}

export interface IssueReconcileResponse {
  repo: string;
  candidates: IssueReconcileCandidate[];
}

export interface ItemLinkRequest {
  rel: string;
  to: string;
}

export interface ItemLinkResponse {
  /** 1949: the item's current ref (`PS-12`), so the client's echo reads it; absent from an older server. */
  ref?: string | null | undefined;
  id: string;
}

export interface EditItemRequest {
  title?: string | undefined;
  body?: string | undefined;
  priority?: string | null | undefined;
  project?: string | null | undefined;
  /** OS-26: why, and who, for the priority change this edit may record on the trail. */
  note?: string | undefined;
  actor?: string | undefined;
}

export interface EditItemResponse {
  /** 1949: the item's current ref (`PS-12`), so the client's echo reads it; absent from an older server. */
  ref?: string | null | undefined;
  id: string;
}

export interface DeleteItemResponse {
  /** 1949: the item's current ref (`PS-12`), so the client's echo reads it; absent from an older server. */
  ref?: string | null | undefined;
  id: string;
}

export interface TodayRequest {
  id?: string | null | undefined;
  rank?: number | undefined;
  clear?: boolean | undefined;
}

export interface TodayResponse {
  /** 1949: the item's current ref (`PS-12`), so the client's echo reads it; absent from an older server. */
  ref?: string | null | undefined;
  id?: string | undefined;
  cleared?: boolean | undefined;
}

export interface FocusRequest {
  project?: string | null | undefined;
  clear?: boolean | undefined;
}

export interface FocusResponse {
  focus_project: string | null;
  cleared?: boolean | undefined;
}

// --- /triage ------------------------------------------------------------------------------------------
//
// ob 375: `ob triage`'s DATA half. The inbox listing carries exactly what the local command renders --
// id, title, origin repo and a body SNIPPET (the same ≤57-char truncation `ob triage` prints), so the
// client renders the response verbatim with no further reshaping. `reject` CLOSES the item server-side:
// the client never issues a close, because the endpoint does the whole job (clear + `done`) in one call.

export interface TriageItemView {
  id: string;
  title: string;
  /** The repo the handing-over architect flagged it from (`ob add --triage --from`), or null. */
  origin_repo: string | null;
  /** A body snippet: the first line, ≤57 chars plus '...' when truncated. */
  note: string;
}

export interface TriageResponse {
  /** Items awaiting triage, newest first (the same order `ob triage` lists). */
  items: TriageItemView[];
}

/** The outcome of a clear/reject: the id and the item's status AFTER the move. */
export interface TriageActionResponse {
  /** 1949: the item's current ref (`PS-12`), so the client's echo reads it; absent from an older server. */
  ref?: string | null | undefined;
  id: string;
  status: string;
}

// --- GET /next ----------------------------------------------------------------------------------------

export interface NextResponse {
  /** Open items in worklist order: today-rank first, then effective priority, kind, queue rank (OB-2083), recency. `?project=` narrows it to one project's queue. */
  items: ItemView[];
  /** How many items are sitting in the triage inbox -- the banner `ob next` prints. */
  triage_count: number;
  /** The focus project the effective priorities were computed against, or null. */
  focus_project: string | null;
}

// --- GET /items ---------------------------------------------------------------------------------------

export type ItemsSort = "priority" | "created" | "updated";

/** The query, as VALUES. Booleans are real booleans here; the CLI turns `--open` into `true`. */
export interface ItemsQuery {
  open?: boolean | undefined;
  status?: string | undefined;
  type?: string | undefined;
  /** A project id OR name -- resolved on the server, because the name map lives there. */
  project?: string | undefined;
  /** OB-2255: only items in the team's member projects; an unknown team is a 404 naming it. */
  team?: string | undefined;
  tag?: string | undefined;
  kind?: string | undefined;
  /** A priority NAME (`critical`|`urgent`|`flake`|`high`|`medium`|`low`|`none`) or its 0-6 integer, as a string. */
  priority?: string | undefined;
  since?: string | undefined;
  updated_after?: string | undefined;
  by?: ItemsSort | undefined;
  limit?: number | undefined;
}

export interface ItemsResponse {
  items: ItemView[];
  focus_project: string | null;
}

// --- POST /items --------------------------------------------------------------------------------------

export interface CreateItemRequest {
  type: string;
  title: string;
  body?: string | null | undefined;
  status?: string | undefined;
  /** A project id or name; resolved server-side, and stored as given when it names no known project. */
  project?: string | null | undefined;
  /** A priority NAME or its 0-6 integer, as a string. */
  priority?: string | null | undefined;
  tags?: string[] | undefined;
  triage?: boolean | undefined;
  origin_repo?: string | null | undefined;
  /** Create a GitHub issue on wayfinder_repo and pair it. Credential stays on the host. */
  issue?: boolean | undefined;
  map?: string | null | undefined;
  exec?: string | null | undefined;
  /** `ob add --link <url>`: stored as the item's ref-row URL when `issue` is not set. */
  link_url?: string | null | undefined;
}

export interface CreateItemResponse {
  id: string;
  item: ItemView;
  issue?: { number: number; url: string } | null | undefined;
}

// --- GET /items/:id -----------------------------------------------------------------------------------

export interface ItemResponse {
  item: ItemDetail;
}

// --- POST /items/:id/close, POST /items/:id/reopen ----------------------------------------------------
//
// Two endpoints rather than a `state` with a magic value, because closing and reopening are the two moves
// that touch the OTHER tracker (#77). `state` cannot do them: a client that could reach `done` through
// the generic verb would have a second, undocumented door to the half-close #77 exists to shut, so the
// generic verb REFUSES `done` by name and points here.

export interface TrackerMoveRequest {
  /**
   * Mirror the move onto the linked GitHub issue. Default TRUE -- moving both trackers is what `ob close`
   * / `ob reopen` MEAN (#77), and the client passes `false` for `--no-github`.
   */
  github?: boolean | undefined;
  /** Why (ob 1515). Optional; recorded as a decision on the item. An older host ignores it. */
  note?: string | undefined;
  /** Who moved it (`--holder`); a human at the keyboard when omitted. An older host ignores it. */
  actor?: string | undefined;
  /**
   * OB-1993, OS-163: what the CLIENT (the machine with the transcripts, the checkout and `gh`) read for each of the
   * item's landable spinoff rows, keyed by row id: its tokens, and its branch's merged PR URL when it found one. The
   * close records these instead of reading on the server, which has none. A row absent here has its tokens read on
   * the server and records no PR.
   */
  landById?: Record<number, { tokens: TokenUsage; pr_url?: string | null }> | undefined;
}

export type CloseItemRequest = TrackerMoveRequest;
export type ReopenItemRequest = TrackerMoveRequest;

/**
 * The outcome, carrying BOTH halves. The local move always stands; the GitHub half reports what it did or
 * why it could not, and `issue_error` is the drift the client must print loudly and exit 1 on. Returning
 * this rather than a bare 200 is the D1 argument in one object: the meaning of closing stayed on the
 * server, and the client is TOLD what happened rather than deciding it.
 */
export interface TrackerMoveResponse {
  id: string;
  /** 1949: the item's current ref (`PS-12`), so the client's echo reads it; absent from an older server. */
  ref?: string | null | undefined;
  /** The item's status after the local move. */
  status: string;
  issue: number | null;
  issue_url: string | null;
  issue_state: string | null;
  /** True when the issue was already in the wanted state. Null when no issue was touched. */
  already: boolean | null;
  /** Why the GitHub half did nothing: `no-link` | `flag` | `foreign-repo` | `dry-run`, or null. */
  skipped: string | null;
  /** Non-null means the two trackers are OUT OF SYNC and the client must say so. */
  issue_error: string | null;
}

export type CloseItemResponse = TrackerMoveResponse;
export type ReopenItemResponse = TrackerMoveResponse;

// --- POST /items/:id/state ----------------------------------------------------------------------------

export const OB_API_STATE_ACTIONS = ["start", "ready", "block", "unblock", "set"] as const;
export type ObApiStateAction = (typeof OB_API_STATE_ACTIONS)[number];

export interface StateRequest {
  action: ObApiStateAction;
  /** Required for `block`. */
  reason?: string | undefined;
  /** Optional owner for `block`. */
  owner?: string | undefined;
  /** Required for `set` -- the target state, validated against the item's own vocabulary. */
  status?: string | undefined;
  /** Why (ob 1515). Optional; recorded as a decision on the item. An older host ignores it. */
  note?: string | undefined;
  /** Who moved it (`--holder`); a human at the keyboard when omitted. An older host ignores it. */
  actor?: string | undefined;
}

export interface StateResponse {
  /** 1949: the item's current ref (`PS-12`), so the client's echo reads it; absent from an older server. */
  ref?: string | null | undefined;
  id: string;
  status: string;
  /** OB-1928: present when a `set` to `open` reopened a done item, so the reopen's GitHub mirror is reported. */
  tracker?: TrackerMoveResponse | undefined;
}

// --- POST /items/:id/notes ----------------------------------------------------------------------------

export interface NoteRequest {
  text: string;
}

export interface NoteResponse {
  /** 1949: the item's current ref (`PS-12`), so the client's echo reads it; absent from an older server. */
  ref?: string | null | undefined;
  id: string;
  /** The body AFTER the append, so the caller sees the note it just wrote rather than assuming it. */
  body: string | null;
}

// --- POST /items/:id/tags -----------------------------------------------------------------------------

export interface TagsRequest {
  add?: string[] | undefined;
  remove?: string[] | undefined;
}

export interface TagsResponse {
  /** 1949: the item's current ref (`PS-12`), so the client's echo reads it; absent from an older server. */
  ref?: string | null | undefined;
  id: string;
  /** The tags AFTER the change -- the read-back, not an echo of the request. */
  tags: string[];
}

// --- GET /snapshot, POST /items/:id/transition, POST /items/:id/rank (OB-1762) --------------------------
//
// The native app (OB-1760) cannot call the dashboard's TanStack server fns, so what its Today screen and
// item sheet need is served here. Same cores the server fns call (snapshotFrom, the workflow cores, the
// alert engine); nothing re-implemented.

export interface SnapshotResponse {
  snapshot: Snapshot;
}

export const OB_API_TRANSITION_ACTIONS = ["start", "ready", "block", "unblock", "close", "reopen"] as const;
export type ObApiTransitionAction = (typeof OB_API_TRANSITION_ACTIONS)[number];

export interface TransitionRequest {
  action: ObApiTransitionAction;
  /** Required for `block` (a `note` may stand in). */
  reason?: string | undefined;
  owner?: string | undefined;
  /** `close` / `reopen` mirror onto the linked GitHub issue unless `github: false` (#77), as on the CLI. */
  github?: boolean | undefined;
  note?: string | undefined;
  actor?: string | undefined;
}

/** The answer to a transition or a rank: the item's fresh `ob show`-level detail. */
export interface ItemDetailResponse {
  item: ItemDetail;
  /** `close` / `reopen` only: the GitHub half's outcome. Non-null `issue_error` means the trackers are out of sync. */
  tracker?: TrackerMoveResponse | undefined;
}

/** OB-2083: exactly one of `top`, `before`, `after`. */
export interface OrderRequest {
  /** First in its band (the item's own, or `priority`'s). */
  top?: boolean | undefined;
  /** With `top`: put it first in this band, setting the priority. A name or 0-6. */
  priority?: string | undefined;
  /** Place it right before / after this item (same project, open). A different band's priority is adopted. */
  before?: string | undefined;
  after?: string | undefined;
  /** OS-26: why, and who, for the priority change a move across bands records on the trail. */
  note?: string | undefined;
  actor?: string | undefined;
}

/** The answer to an order: the fresh detail, plus what the move did. */
export interface OrderResponse extends ItemDetailResponse {
  order: {
    /** The effective priority after the move (its band). */
    priority: string;
    /** True when the move crossed into another band and wrote the priority. */
    priority_changed: boolean;
    /** The new queue rank (1 is next). */
    rank: number;
  };
}

export interface RankRequest {
  /** An explicit rank; absent or null takes the next free slot. */
  rank?: number | null | undefined;
  /** Remove the item from Today instead. */
  clear?: boolean | undefined;
}

// --- GET /search --------------------------------------------------------------------------------------

export interface SearchResponse {
  query: string;
  items: ItemView[];
  focus_project: string | null;
}

// --- GET /status --------------------------------------------------------------------------------------

export interface StatusResponse {
  status: StatusSnapshot;
}

// --- GET /agents, POST /agents ------------------------------------------------------------------------

export interface AgentsResponse {
  agents: AgentStatusRow[];
}

/** `set-run` (OB-1923) writes T3's run word on an EXISTING row and never inserts; `found: false` when there is none. */
export const OB_API_AGENT_ACTIONS = ["register", "heartbeat", "done", "set-run"] as const;
export type ObApiAgentAction = (typeof OB_API_AGENT_ACTIONS)[number];

/**
 * Registering an agent. `worktree`, `branch` and `session_id` are facts about the CLIENT's machine, so the
 * client reads them (git, its own session) and passes them as values -- the server has no cwd worth
 * asking. Everything else, including the ticket-lease claim a register performs (#97), stays here.
 */
export interface AgentRequest {
  action: ObApiAgentAction;
  id: string;
  ticket?: string | null | undefined;
  worktree?: string | null | undefined;
  branch?: string | null | undefined;
  status?: string | null | undefined;
  /** T3's run word (1189). The run-state mirror is the only writer; `status` above stays ob's. */
  run?: string | null | undefined;
  note?: string | null | undefined;
  launcher?: string | null | undefined;
  session_id?: string | null | undefined;
  ttl_s?: number | undefined;
  /** Skip the ticket-lease claim (the deliberate second registrant). */
  no_lease?: boolean | undefined;
  /** A lease the CALLER already holds; a hold of the caller's own is compatible, not a collision (#75). */
  holder?: string | null | undefined;
}

export interface AgentResponse {
  /** Null for a `heartbeat`/`done`/`set-run` naming an agent that does not exist. */
  agent: AgentRow | null;
  /** True when a heartbeat/done/set-run found the row. Always true for a successful register. */
  found: boolean;
  /** The ticket lease key this register claimed, or null when it claimed none. */
  ticket_lease: string | null;
  /** Lease keys a `done` released. */
  released: string[];
  /** Lease keys a `done` must not drop: inherited architect holds, or a ticket another live agent is on (341). */
  kept?: string[] | undefined;
  /** OB-1922: on a `heartbeat`, this holder's expired leases it acquired again as fresh leases. Optional. */
  reacquired_leases?: string[] | undefined;
  /** OS-110: on a `heartbeat`, the row's ticket:/worktree: keys another session now holds live. Empty when none. */
  lost_leases?: Array<{ resource: string; holder: string; since: string | null }> | undefined;
}

// --- GET /agents/active -------------------------------------------------------------------------------
//
// "Should this Mac stay awake?" (098). StayAwake asks it on a timer, so it is the one agent read with a
// caller that is not a human, and a client that could not answer it would let the machine sleep on a
// live build. Its own endpoint rather than a flag on `GET /agents`, because it is a COUNT over a window
// rather than a listing, and returning the whole registry to derive a boolean is the shape that makes a
// 2-second poller expensive.

// --- POST /agents/reset (437) -------------------------------------------------------------------------

export interface AgentsResetRequest {
  /** Preview only. Lists every agent id and lease resource that would go; writes nothing. */
  dry_run?: boolean | undefined;
}

export interface AgentsResetResponse {
  dry_run: boolean;
  /** Agent ids that went (or would go). */
  agents: string[];
  /** Lease resources that went (or would go). */
  leases: string[];
}

export interface AgentActiveQuery {
  /** The liveness window in minutes (`ob agent active --within`). Defaults to 20, as the CLI does. */
  within_min?: number | undefined;
}

export interface AgentActiveResponse {
  /** Whether ANY agent heartbeated inside the window. */
  active: boolean;
  /**
   * How many did. A real NUMBER: Postgres returns count() as a STRING, and `"0"` is truthy while
   * `"0" > 0` is false, so this is the field where that trap would decide whether a laptop sleeps.
   */
  count: number;
  within_min: number;
}

// --- leases -------------------------------------------------------------------------------------------

export interface LeasesResponse {
  leases: LeaseStatusRow[];
}

/** OB-1922: POST /leases/sweep, what `ob lease status` runs first: rows expired for over a day, deleted. */
export interface SweepLeasesResponse {
  swept: string[];
}

export interface AcquireLeaseRequest {
  resource: string;
  holder: string;
  ttl_s: number;
  /** `heartbeat` refreshes an existing hold and refuses to create one; `acquire` takes or refreshes. */
  heartbeat?: boolean | undefined;
}

export interface AcquireLeaseResponse {
  resource: string;
  ok: boolean;
  /** The holder that now has it -- on a refusal, the LIVE holder that blocked the caller. */
  holder: string;
  /**
   * ob 353: the row as RECORDED, whether or not it is still live. Optional, and absent is handled: the
   * client needs it to print #75's teaching message on a refused heartbeat -- "X is held by <holder>, not
   * <you> ... re-run as it with --holder <holder>" -- which cannot be written from `ok: false` alone.
   * Without it the client says it could not act and does not guess at a holder.
   */
  recorded?: RecordedHold | null | undefined;
  /** OB-1922: set when a heartbeat was refused because the caller's own lease had expired. Optional. */
  error?: "LeaseExpiredError" | undefined;
}

export interface ReleaseLeaseResponse {
  resource: string;
  released: boolean;
  /** ob 353: as above -- who the row names, so a release that released nothing can say why. Optional. */
  recorded?: RecordedHold | null | undefined;
}

// --- secrets ------------------------------------------------------------------------------------------
//
// ob 357. This is the one endpoint family where a SECRET VALUE crosses the wire, which it never did
// before: `ob secret get` decrypted on the machine that held the master key and printed to that machine's
// stdout. The owner weighed the trade and asked for it, because a laptop off the LAN could not
// read a token it owns, and that blocked real work. What makes it acceptable is stacked, not singular:
// TLS to Cloudflare, an Access service-token policy in front of the tunnel, the API's own bearer token,
// and -- the part that does not move -- DECRYPTION STAYS SERVER-SIDE against the master key on the API host.
// The client receives plaintext; it never receives the key, the ciphertext, the iv or the auth tag.
//
// WHY THE READ IS A POST AND NOT `GET /secrets/:name`. The secret name never goes in the URL, because
// a URL can be logged.
//
// The value is in neither shape's URL, so that is not the question. The question is the NAME, and a name
// is not nothing: `linear`, `ha`, `cloudflare` is an inventory of what is worth stealing and of when each
// one was last reached for. A path lands in Cloudflare's access logs, in the tunnel's logs, in any proxy
// between, and in whatever the host process logs about its own requests -- none of which is under this
// repo's control, and all of which outlive the request. A POST body lands in none of them.
//
// Three more reasons it is worth breaking the `/items/:id` symmetry for:
//   - a GET is semantically cacheable and retryable. `cache-control: no-store` is set, but that is a
//     request to every intermediary rather than a guarantee from any of them, and a POST needs no such
//     request to be uncacheable.
//   - it makes ONE invariant checkable instead of a per-endpoint judgement: NOTHING about a secret --
//     name or value -- ever appears in a URL. api-secrets-357.test.ts asserts exactly that over every
//     request the client makes, which is an assertion a `GET /secrets/:name` design could not carry.
//   - it removes the percent-encoding path from the read entirely (the ob 352 `decodeURIComponent` bug),
//     because there is no encoded segment to decode.
//
// The cost is that this is not RESTful, and that cost is already accepted: D1 chose purpose-built verbs
// over CRUD everywhere else in this API too.
//
// `secret import` is deliberately NOT served. It copies the token FILES on the machine it runs on into the
// store; served, it would import the SERVER's files while the caller meant their laptop's, and silently do
// something other than what was asked. The client refuses it by name.

export interface SecretListEntry {
  name: string;
  updated_at: string;
}

/** NAMES and ages. There is no field here that could hold a value, and that is the point of the shape. */
export interface SecretsResponse {
  secrets: SecretListEntry[];
}

export interface ReadSecretRequest {
  name: string;
}

export interface ReadSecretResponse {
  name: string;
  /** The decrypted plaintext. The ONLY field in this whole contract that ever carries one. */
  value: string;
}

export interface SetSecretRequest {
  name: string;
  value: string;
}

/** The read-back, minus the value: what was written and when, so the caller sees the row it just made. */
export interface SetSecretResponse {
  name: string;
  set: true;
  updated_at: string;
}

export interface RemoveSecretRequest {
  name: string;
}

export interface RemoveSecretResponse {
  name: string;
  removed: boolean;
}

// --- creds --------------------------------------------------------------------------------------------
//
// ob 357. The credential inventory (219) and its live checks, which answer "is the thing there and did it
// work" without ever carrying the thing. Presence is read on the API HOST and that is the right machine:
// the store, the master key and the token files all live there, so a laptop asking its own filesystem
// would be answering about the wrong computer.
//
// `POST /creds/check` is the one endpoint in this API that deliberately makes an outbound call, and only
// because a person typed `ob creds check`. It records a boolean and a sentence; `redactDetail` already
// scrubs any value a provider echoed back before that sentence is stored.

export interface CredsResponse {
  credentials: CredentialStatus[];
}

export interface CredsCheckRequest {
  /** One credential by name, or `all` for every checkable one. Exactly one of the two. */
  name?: string | undefined;
  all?: boolean | undefined;
}

export interface CredsCheckResponse {
  checks: CredentialCheckRow[];
}

// --- the spinoff queue (360) --------------------------------------------------------------------------
//
// `ob spinoff` is the same HYBRID split ob 352/353 made for commands like `secret`, applied one command
// over: the DATA half is served, the LAUNCH half is not. The queue reads and writes, the ticket and the
// leases are rows in Postgres and go over HTTP; the worktree and the agent spawn are about the machine in
// front of the human and stay there. A spinoff from the office therefore needs the laptop PLUS the API,
// which is exactly what the owner has -- whereas the old refusal sent him to the API host, which has neither
// his checkouts nor a launcher.
//
// TWO PROPERTIES OF THE DRAIN SURVIVE THE SPLIT AND ARE THE REASON IT IS SHAPED THIS WAY:
//
//   ob 308's race fix. The claim is ONE conditional `UPDATE ... WHERE status='pending' RETURNING *`, and it
//   still runs in ONE place -- inside `POST /spinoffs/claim`, against the authoritative database, through
//   the same `claimSpinoffRow` the local drain calls. Two drains that both ask get one row between them,
//   because the exclusion is decided by the database and not by the client. Nothing here reads-then-writes.
//
//   ob 191's split. The claim goes FIRST (it is the exclusion), the launch happens on the client in
//   between, and the stamp records what the launch did. The endpoints ARE those steps, so the partial
//   failure contract is unchanged: a launch that happened and a stamp that did not is reported with the
//   command that finishes the job, and the claim lease lapses so `reclaim` re-queues the row.
//
// NO ID TRAVELS IN A URL. A spinoff id, a holder and a branch go in POST bodies, following ob 357's rule
// and the reasoning behind it: a path lands in Cloudflare's logs, in the tunnel's, in any proxy between and
// in whatever the host logs about its own requests, and none of those are under this repo's control.

/** Everything the LAUNCH half needs from the database, as VALUES (`SpinoffLaunchConfig` on the wire). */
export interface SpinoffConfig {
  repo_checkouts: Record<string, string>;
  launcher: string;
  launcher_by_repo: Record<string, string>;
  /** The harness this store launches under (`claude` | `opencode`), resolved by the SERVER like the
   *  launcher (readSpinoffLaunchConfig) — a client has no business re-reading nothing settable on it. */
  engine: string;
  /** 1480: `spinoff_tier_models`, raw. Absent from a host older than 1480: the client uses the defaults. */
  tier_models?: string | undefined;
}

export interface SpinoffConfigResponse {
  config: SpinoffConfig;
}

export interface SpinoffsQuery {
  /**
   * `pending` | `launching` | `launched` | `ready-for-gate` | `merged` | `failed` — the stored values, which
   * the response rows carry too. Since 1513 a host also accepts the printed words (`queued` | `building` |
   * `handed-off` | `landed`). Absent means every row.
   */
  status?: string | undefined;
}

/**
 * Ask which rows serve one ITEM (1226) — the join settle-on-close wants, and one a client with no store
 * cannot resolve for itself, because it turns on whether some item's record NAMES a row's ref as a ticket
 * path. A POST body rather than a query parameter: an id in a url is logged by every proxy in front (357).
 */
export interface SpinoffServingRequest {
  item_id: string;
}

export interface SpinoffsResponse {
  spinoffs: SpinoffRow[];
  /**
   * `POST /spinoffs/serving` only: the candidate rows whose ref the resolution could NOT settle — a ref two
   * items both name as a ticket path, or a tracker read that failed (1226). Their threads are deliberately
   * left alone (a wrong join costs a real builder turn, 1188), so they are NAMED rather than dropped: an
   * empty `spinoffs` on its own reads exactly like "this ticket never dispatched anything".
   */
  unresolved?: Array<{ id: number; ticket_ref: string }> | undefined;
}

/**
 * Enqueue. `repo` is a machine-independent SLUG resolved by the CLIENT (217), because only the machine
 * with the checkouts can turn a directory into one, and a path would name nothing on the API host.
 */
export interface EnqueueSpinoffRequest {  ticket_ref: string;
  repo: string;
  branch: string;
  worktree?: string | null | undefined;
  mode: SpinoffMode;
  brief: string;
  launcher?: string | null | undefined;
  /** 1480: the complexity tier (`complex|medium|simple`). Absent = the default tier, recorded as such. */
  tier?: string | null | undefined;
  /** OS-177: the complexity score 1-10 (`--complexity`), the routing key. Wins over `tier` when both are sent. */
  complexity?: number | null | undefined;
  /** OB-1815: the reasoning level `--effort` named (`low|medium|high|xhigh|max`). Absent = none named. */
  effort?: string | null | undefined;
  /** OB-1825: `--note`, for the Decisions trail's `— → queued` line. */
  note?: string | null | undefined;
  /** OB-1825: the `--no-check` reason. Absent means the measure-twice gate applies; blank is refused. */
  no_check?: string | null | undefined;
  /** OB-2230: the `--no-flake-slot` reason: a flake row launches without taking `flake:slot`. Blank is refused. */
  no_flake_slot?: string | null | undefined;
  /** OS-108: the `--over-usage` reason, checked on the client (the usage cache is there) and recorded on the trail here. */
  over_usage?: string | null | undefined;
  /** OS-134: the `--allow-paused` reason: a paused or archived project's ticket is queued anyway. Blank is refused. */
  allow_paused?: string | null | undefined;
  /** OB-2230: is `flake-box` on the client that will launch the builder? Absent reads as present. */
  flake_box?: boolean | null | undefined;
  /** OB-1825: `--holder`, who the trail names for the note and the override. Absent means the human. */
  actor?: string | null | undefined;
  /** OB-1991: which leg of a model-trial pair this row is (`a|b`). Absent = not a trial leg. */
  trial_leg?: string | null | undefined;
  /** OB-1991: the model the trial launches this leg on, over the tier's model. */
  trial_model?: string | null | undefined;
}

/** OB-1991: `ob spinoff trial ...`, one store operation per call (the shapes live in cli-coord's spinoff-trial.ts). */
export type SpinoffTrialRequest = import("../../../../platform/cli-coord/src/spinoff-trial.ts").TrialOpRequest;
export type SpinoffTrialResponse = import("../../../../platform/cli-coord/src/spinoff-trial.ts").TrialOpResponse;

/** OB-1825: the server computes the verdict and records it; the client only reads the two JSONs. */
export interface SpinoffCheckRequest {
  ticket_ref: string;
  /** `--holder`, who the trail names for the verdict. Absent means the human. */
  actor?: string | null | undefined;
  architect: unknown;
  checker: unknown;
  /** OB-2131: one `{q, how, note}` per checker question, validated on the server. Absent is none. */
  resolutions?: unknown;
}

/** OB-2131: the planned files of each row's newest go check, for the `files:` line. */
export interface SpinoffPlannedFilesRequest {
  rows: Array<{ id: number; ticket_ref: string; item_id: string | null }>;
}

export interface SpinoffPlannedFilesResponse {
  /** `files` null: that row's ticket has no go check. */
  planned: Array<{ id: number; files: string[] | null }>;
}

/**
 * OS-47: the dispatch overlap warning's store half. `declared`: each ticket's declared files (its newest go
 * check, directories and globs kept), null when it has none. `record`: one `overlap` decision on the ticket's trail.
 */
export type SpinoffOverlapRequest =
  | { op: "declared"; refs: Array<{ ticket_ref: string; item_id: string | null }> }
  | { op: "record"; ticket_ref: string; rows: Array<{ ref: string; row: number; paths: string[] }>; note: string | null; actor: string | null };

export type SpinoffOverlapResponse =
  | { op: "declared"; declared: Array<{ ticket_ref: string; files: string[] | null }> }
  | { op: "record"; recorded: boolean };

export type SpinoffCheckResponse = CheckResult;

export interface EnqueueSpinoffResponse {
  row: SpinoffRow;
  /** True when an active row for this ticket already existed and `row` is that one. */
  deduped: boolean;
  /**
   * The item id the ref is ALSO the id of, when its ticket path bound the row to a different item (1226) —
   * so the dispatch can say the coincidence aloud. Resolved on the host that holds the store, so the client
   * needs no read of its own (and none with an id in a url, 357). Null in the ordinary case.
   */
  collision?: string | null | undefined;
  /** OB-1825: a warning from the measure-twice gate, for the client to show (a `--no-check` with no trail). */
  warning?: string | null | undefined;
  /**
   * OB-2075: the item is urgent, so the row is on the complex tier (Opus). Absent from an older host, which
   * read as false.
   */
  urgent?: boolean | undefined;
  /** OB-2075: the lower tier the caller named that the urgent rule raised to complex; null when none was. */
  raised_from?: number | null | undefined;
  /** OB-2230: the item is at priority `flake`: the row takes flake:slot and its brief carries the flake-box paragraph. */
  flake?: boolean | undefined;
}

/** A live foreign hold on a row's ticket/worktree, as reported per row rather than per sweep. */
export interface SpinoffHold {
  resource: string;
  holder: string;
}

/**
 * One pending row plus the two per-row facts the LAUNCH decision needs and only the tracker knows: the
 * ticket's tags (#161's "which app does this agent rebuild").
 */
export interface LaunchableSpinoff {
  row: SpinoffRow;
  tags: string[];
  /** A live foreign hold (#97), or null. Non-null means the row stays PENDING and is reported. */
  hold: SpinoffHold | null;
  /**
   * The ticket's own ob title (1143), read on the HOST because that is where the item lives. The client
   * drain names the T3 thread with it — the launch runs on the client, the store does not — so a thread
   * opened from a laptop reads the same as one opened next to the database. Null when the ref resolves to
   * no item; the launcher then falls back to the branch.
   */
  ticket_title: string | null;
  /** OB-2075: the item is urgent: the row sent is on complex, and an adopted thread keeps its own model. */
  urgent?: boolean | undefined;
  /** OB-2075: the tier the host raised this row from, or null. The row's tier is recorded at the stamp, not here. */
  raised_from?: number | null | undefined;
  /** OS-134: why the row's paused or archived project keeps it pending, or null. Non-null means it is not launched. */
  paused?: string | null | undefined;
}

/**
 * What the caller may attempt. Agent count is not a reason to leave a row pending (ob 767): the
 * client launches every pending row that is not lease-blocked (#97) or launcher-not-ready (#118/#161).
 */
export interface LaunchableRequest {
  /** `--holder`: a hold that is ALREADY the caller's is compatible, not a collision (#75/#136). */
  holder?: string | null | undefined;
  /** The CALLER's own lease-holder id. Read on the client, because the server's pid is not the caller. */
  caller?: string | null | undefined;
}

export interface LaunchableResponse {
  /** Live BUILD agents across all repos (architect-* excluded). Informational; not a limiter (ob 767). */
  active: number;
  /** Pending rows oldest-first (FIFO). */
  rows: LaunchableSpinoff[];
  remaining_pending: number;
}

export interface ClaimSpinoffRequest {
  id: number;
  holder?: string | null | undefined;
}

export interface ClaimSpinoffResponse {
  /** The row the caller now owns, or null when another drain won the conditional update (308). */
  claimed: SpinoffRow | null;
  /** With `claimed`: not launchable (a live foreign hold on its ticket/worktree), and the caller stamps it failed.
   *  With `claimed: null`: the claim lease could not be taken, so the row stays pending (OB-1921). */
  error: string | null;
}

export interface StampSpinoffRequest {
  id: number;
  outcome: "launched" | "failed";
  worktree?: string | null | undefined;
  base_sha?: string | null | undefined;
  launcher?: string | null | undefined;
  session_id?: string | null | undefined;
  engine?: string | null | undefined;
  /** 1120: the T3 thread this launch opened — or ADOPTED from a previous attempt — and its run. They
   *  cross the wire like every other fact about the client's machine: the thread lives on the client's
   *  T3 server, the row lives here. */
  t3_thread_id?: string | null | undefined;
  t3_run_id?: string | null | undefined;
  /** 1480: the model that T3 launch ran on — a client fact, like the thread id. */
  model?: string | null | undefined;
  /** OB-1815: the effort text that launch ran at (`high`, `default (high)`, `default (none listed)`). */
  effort?: string | null | undefined;
  /** OB-2075: the launch ran an urgent item on complex (not an adopted thread); the host then records the row as complex. */
  raised?: boolean | undefined;
  error?: string | null | undefined;
  /** OS-145: the moves this launch made along its route on a quota error, for the host to write on the Decisions trail. */
  route_moves?: RouteMove[] | undefined;
}

/** OS-145: one move along a route (models `from` -> `to`), with its Decisions line. */
export interface RouteMove {
  from: string;
  to: string;
  note: string;
}

export interface StampSpinoffResponse {
  id: number;
  outcome: string;
}

export interface LandSpinoffRequest {
  id: number;
  tokens: TokenUsage;
  /** OS-163: the branch's merged PR, read on the client; recorded on the landed event for the timeline. */
  pr_url?: string | null | undefined;
  holder?: string | null | undefined;
  caller?: string | null | undefined;
}

/**
 * OB-1993: a token-only write for a row that already landed with no count (`ob spinoff tokens backfill`). The
 * client reads the transcripts, the server records. Refused (409) for a row that is not landed or has a count.
 */
export interface RecordSpinoffTokensRequest {
  id: number;
  tokens: TokenUsage;
}

export interface RecordSpinoffTokensResponse {
  id: number;
  total_tokens: number;
}

export interface LandSpinoffResponse {
  id: number;
  landed: boolean;
  /** Why it was not landed: a THIRD party holds the ticket/worktree (#97). Null when it landed. */
  blocked: SpinoffHold | null;
}

export interface ReadySpinoffRequest {
  /** Spinoff row id. Preferred when the client already resolved the row. */
  id?: number | undefined;
  /** Ticket ref (or `#<n>`) when the client has no id. */
  ticket_ref?: string | undefined;
  /**
   * The builder's rating of its own tier (`--tier-fit`, 1552): `lower` | `right` | `higher`. The HOST
   * records it on the ticket's decisions trail, because the host owns the trail; a value that is not one
   * of the three is a 400 and nothing is stamped.
   */
  tier_fit?: string | null | undefined;
  /** The one-line reason for the rating (`--tier-fit-why`). Meaningless without `tier_fit`. */
  tier_fit_why?: string | null | undefined;
  /** OB-1992: the handoff `--note`, with any `--report` file's text, for the ticket's Decisions trail. */
  note?: string | null | undefined;
}

export interface SendBackSpinoffRequest {
  /** Spinoff row id. */
  id: number;
  /** What to fix: recorded on the ticket's decisions trail and the agent row's note. */
  note: string;
  /** Undo a send-back whose note could not be delivered: put the row back to handed-off. */
  restore?: boolean | undefined;
  /** OS-211: with `restore`, the verdict the row carried before the send-back cleared it, put back with the row. */
  verdict?: { verdict: string | null; verdict_reason: string | null; gate_line: string | null } | null | undefined;
  /** OS-108: the `--over-usage` reason, checked on the client and recorded on the trail here. */
  over_usage?: string | null | undefined;
}

export interface SendBackSpinoffResponse {
  row: SpinoffRow;
}

/** OB-2180: `ob spinoff reopen`. The git check (no landing commit on main) is the client's, made before it asks. */
export interface ReopenSpinoffRequest {
  /** Spinoff row id. */
  id: number;
  /** Why the land is undone: recorded on the ticket's decisions trail. */
  note: string;
}

export interface ReopenSpinoffResponse {
  row: SpinoffRow;
}

/** OS-235: `ob spinoff resume`. More work on a handed-off row: back to building, out of the sentinel inbox. */
export interface ResumeSpinoffRequest {
  /** Spinoff row id. */
  id: number;
  /** The work that continues: recorded on the ticket's decisions trail. */
  note: string;
}

export interface ResumeSpinoffResponse {
  row: SpinoffRow;
}

/** OB-1992: `ob spinoff state`. A clean repo's verdict lives on the row, not in its commits. */
export interface SpinoffVerdictRequest {
  /** Spinoff row id. */
  id: number;
  /** landable | needs-human | blocked | partial */
  verdict: string;
  reason?: string | null | undefined;
  gate?: string | null | undefined;
}

export interface SpinoffVerdictResponse {
  row: SpinoffRow;
}

/** OS-183: `ob spinoff phase`. A bad phase word is a 400; a phase the row's status does not hold is a 409. */
export interface SpinoffPhaseRequest {
  /** Spinoff row id. */
  id: number;
  /** reviewing | pr_ci | updating_pr | gating | owner_merge_call */
  phase: string;
  actor?: string | null | undefined;
}

export interface SpinoffPhaseResponse {
  row: SpinoffRow;
  /** The phase the row was in before; null when it had none. */
  from: string | null;
}

/** OB-2172: the readying note's outcome, sent by a client after its handoff: `failed` records `note_error`, `sent` clears it. */
export interface SpinoffNoteErrorRequest {
  /** Spinoff row id. */
  id: number;
  outcome: "sent" | "failed";
  /** T3's reason, for `failed`. */
  reason?: string | null | undefined;
}

export interface SpinoffNoteErrorResponse {
  /** True when the row was written. */
  recorded: boolean;
}

export interface ReadySpinoffResponse {
  row: SpinoffRow;
  already: boolean;
  /** True when this call released at least one builder ticket:/worktree: hold (426). */
  leasesReleased: boolean;
  /**
   * The builder's own readying note, read BEFORE the stamp overwrote it (1133) — the gate it reported and
   * the review line inside it. Optional: a host older than 1133 does not send it, and the readying note
   * then says the gate is unreported rather than inventing one.
   */
  builder_note?: string | null | undefined;
  /**
   * The `tier-fit:` line the HOST recorded on the ticket's decisions trail (1552), or null when the builder
   * rated no tier. The client puts this same line in the readying note so the trail and the note agree; an
   * older host sends none (it also records none), and the note then reads unreported.
   */
  tierFit?: string | null | undefined;
  /** OB-1826: the row serves a spike, so it was not stamped handed-off (it stays building until `ob close`). */
  spike?: boolean | undefined;
}

export interface ReclaimSpinoffsResponse {
  reclaimed: ReclaimEntry[];
}

/** One candidate a local cleanup sweep found in git and wants to remove. */
export interface CleanupGuardRequest {
  branch?: string | null | undefined;
  /** The worktree path, or "" for a dangling branch with no worktree. */
  path?: string | null | undefined;
  caller?: string | null | undefined;
}

export interface CleanupGuardResponse {
  /** A live foreign hold covering it (its worktree key, or any ticket that maps to it), else null. */
  hold: SpinoffHold | null;
  /** Whether an agent-registry row exists for the branch, for the `--dry-run` preview. */
  agent: boolean;
}

// --- /whatsapp (366) ----------------------------------------------------------------------------------
//
// `ob whatsapp` is SPLIT the same way `secret` and `spinoff` are. search/recent are ingested
// messages already in Postgres (337/324), so they are served. sync reads THIS machine's bridge
// messages.db; send has a HITL confirm and only makes sense next to the bridge; bridge/bio/prefs
// are this machine too. The client refuses those by name, and the refusal names THIS machine --
// not "run it on the API host", which has no bridge.

export interface WhatsappSearchQuery {
  q: string;
  limit?: number | undefined;
}

export interface WhatsappRecentQuery {
  limit?: number | undefined;
  since?: string | undefined;
}

export interface WhatsappHitsResponse {
  hits: WhatsappHit[];
}

export type WhatsappSearchResponse = WhatsappHitsResponse;

// OB-1765: the native WhatsApp screen. Same cores the sidecar's /api/whatsapp/status and the dashboard snapshot
// call, the shapes unchanged. Read-only: a send is never reachable from here.
export type { StatusPage as WhatsappStatusResponse, WhatsappChatItem };
export const WHATSAPP_CHATS_CAP = 200;
export const WHATSAPP_CHATS_DEFAULT = 50;
export interface WhatsappStatusQuery {
  limit?: number | undefined;
  /** An ISO ts: a history page of posts strictly before it. Absent: the current 24h tray. */
  before?: string | undefined;
  /** Narrow a history page to one sender (the "load earlier" of one person). */
  sender?: string | undefined;
}
export interface WhatsappChatsQuery {
  limit?: number | undefined;
  /** Include chats the human hid. Default false, as in the feed. */
  hidden?: boolean | undefined;
}
export interface WhatsappChatsResponse {
  chats: WhatsappChatItem[];
}
export type WhatsappRecentResponse = WhatsappHitsResponse;

// --- the rest of `ob whatsapp` (OB-1809) ----------------------------------------------------------------

interface WhatsappSendFile {
  /** A base name only: the server writes it into a private temp directory, and the allow-list reads its extension. */
  name: string;
  data_base64: string;
}

export interface WhatsappSendRequest {
  to: string;
  /** The text, or with `file` the caption (may then be empty). Sent exactly as the human read it. */
  body: string;
  /** The gate. The literal true, set only after a human confirmed; anything else is refused. */
  confirm: boolean;
  file?: WhatsappSendFile | undefined;
  /** OB-1909: send even though an identical send of the last 24 h may already have gone. Set only by the human's --resend. */
  resend?: boolean | undefined;
}

export interface WhatsappSendResponse {
  ok: boolean;
  to: string;
  response: { success?: boolean; message?: string };
  /** The bridge's message id, or null when it could not be identified (the row then lands on the next sync). */
  id: string | null;
}

export const WHATSAPP_PREF_ACTIONS = ["hide", "show", "ai-off", "ai-on", "favorite", "unfavorite"] as const;
export type WhatsappPrefAction = (typeof WHATSAPP_PREF_ACTIONS)[number];

export interface WhatsappPrefRequest {
  chat_jid: string;
  action: WhatsappPrefAction;
}

export interface WhatsappPrefResponse {
  chat_jid: string;
  hidden: boolean;
  ai_disabled: boolean;
  favorite: boolean;
}

export interface WhatsappPrefChatsResponse {
  chats: string[];
}

// --- /gmail + /cal (415) ------------------------------------------------------------------------------
//
// `ob gmail` / `ob cal` / `ob agenda` are DATA, as `ob whatsapp` is.
// search/list/agenda read email_message / calendar_event in Postgres. sync runs ON THE API HOST
// against secret `google` (or the host's token file), so a laptop never needs `~/.google_token`.
// `ob google auth` (420) is the DESKTOP half: loopback RUNS on THIS machine; persist via POST /secrets.
// 1305 adds the HOSTED half (see the /google types below): browser routes guarded by a one-time state.

export interface GmailSearchQuery {
  q: string;
  limit?: number | undefined;
}

export interface GmailListQuery {
  limit?: number | undefined;
  since?: string | undefined;
}

export interface GmailHitsResponse {
  hits: EmailHit[];
}

export type GmailSearchResponse = GmailHitsResponse;
export type GmailListResponse = GmailHitsResponse;

export interface GmailSyncRequest {
  backfill?: boolean | undefined;
  query?: string | undefined;
  days?: number | undefined;
  since?: string | undefined;
  max?: number | undefined;
}

export interface GmailSyncResponse {
  messages: number;
  skipped: number;
  ingested: number;
  cursor: string | null;
}

// 1757: drafts. `POST /gmail/drafts/:id/send` refuses (400) unless the body is `{ "confirm": true, "hash": "<hex>" }`;
// OB-1910: the host re-reads the draft and sends only while it still hashes to `hash`.
export type GmailDraftCreateRequest = GmailDraftRequest;
export type GmailDraftResponse = GmailDraftPreview;
export interface GmailSendDraftRequest {
  confirm: true;
  hash: string;
}
export type GmailSendDraftResponse = GmailSendDraftResult;
// OB-1750: `GET /gmail/drafts` lists, `POST /gmail/drafts/:id/edit` edits in place (an absent field is kept, a
// present `attachments` replaces the files, `cc: ""` clears Cc), `DELETE /gmail/drafts/:id?confirm=true` removes it.
export interface GmailDraftListResponse {
  drafts: GmailDraftPreview[];
}
export type GmailDraftEditRequest = GmailDraftEdit;
export type GmailDraftDeleteResponse = GmailDeleteDraftResult;

// 1680: read a message and fetch its attachments. Read-only; the CLI writes any file on its own machine.
export type GmailMessageResponse = GmailMessageRead;
export type GmailAttachmentsResponse = GmailAttachmentsResult;

export interface CalSyncRequest {
  backfill?: boolean | undefined;
  since?: string | undefined;
  max?: number | undefined;
}

export interface CalSyncResponse {
  events: number;
  ingested: number;
  calendars: string[];
}

export interface AgendaResponse {
  events: AgendaRow[];
}

// --- /google (1305) -----------------------------------------------------------------------------------
//
// The HOSTED OAuth half. `GET /google/auth` and `GET /google/callback` are the API's ONLY unauthenticated
// routes (a browser cannot send a bearer token), so they are guarded by a one-time `state` instead; the
// MINT stays on `POST /google/auth-url` (authenticated), because an unauthenticated mint would let anyone
// who can reach this host start a flow and replace the stored token with their own Google account. The
// callback persists through the same secret path the loopback flow uses.

export interface GoogleAuthUrlResponse {
  /** Google's consent URL, carrying a freshly minted single-use state. */
  url: string;
}

// --- 416: already-servable commands over purpose-built endpoints --------------------------------------

export interface ProjectsResponse {
  projects: Project[];
}

export interface ProjectCreateRequest {
  name: string;
  kind: string;
  remote?: string | null | undefined;
  /** 1949: the ref key (`PS`); omitted takes the agreed key for a known id, or none. */
  key?: string | null | undefined;
  /** OB-2116: the architect title's emoji and display name. */
  icon?: string | null | undefined;
  display_name?: string | null | undefined;
}

export interface ProjectCreateResponse {
  project: Project;
}

export interface ProjectEditRequest {
  remote?: string | undefined;
  kind?: string | undefined;
  /** 1949: numbers the project's items under it; a change keeps their old refs as aliases. */
  key?: string | undefined;
  /** OB-2116: the architect title's emoji; '' clears it. */
  icon?: string | undefined;
  /** OB-2116: the architect title's name; '' clears it. */
  display_name?: string | undefined;
  /** OB-2103: the release stage, alpha|beta|rc|stable|legacy; 'none' clears it. */
  stage?: string | undefined;
  /** OS-134: the lifecycle status, active|paused|archived. */
  status?: string | undefined;
}

export interface ProjectEditResponse {
  project: Project;
}

/** OB-1846: `ob project rename <old> <new>`; the old name is the path segment. */
export interface ProjectRenameRequest {
  name: string;
}

export interface ProjectRenameResponse {
  project: Project;
}

export interface ProjectRemoveResponse {
  project: Project;
}

// --- OB-2255: teams (`ob t3 team`) ---------------------------------------------------------------------

export interface TeamsResponse {
  teams: TeamView[];
}

export interface TeamResponse {
  team: TeamView;
}

export interface TeamCreateRequest {
  name: string;
  icon?: string | null | undefined;
  display_name?: string | null | undefined;
  /** The team's first projects; one already in another team is refused (409). */
  projects?: string[] | undefined;
}

/** '' clears a field. */
export interface TeamEditRequest {
  icon?: string | undefined;
  display_name?: string | undefined;
}

export interface TeamJoinRequest {
  projects: string[];
}

export interface TeamJoinResponse {
  team: TeamView;
  joined: string[];
}

export interface TeamLeaveRequest {
  projects: string[];
}

export interface TeamLeaveResponse {
  /** Each project and the team it left (null when it was in none). */
  left: Array<{ project: string; team: string | null }>;
}

// OB-2257: a role thread's handoff, held through `ob t3 team restart`.
export interface TeamHandoffRequest {
  role: string;
  body: string;
  /** OB-2275: the thread writing it, when the client knows it (`T3CODE_THREAD_ID`); absent means the role's bound thread. */
  from_thread_id?: string | undefined;
}

export interface TeamHandoffConsumeRequest {
  new_thread_id: string;
}

export interface TeamHandoffResponse {
  handoff: TeamHandoff | null;
}

// Role runs: one run per team role (`ob role`).
export interface RoleRunMarkRequest {
  role: string;
  t3_host: string;
}

export interface RoleRunUpdateRequest {
  thread_id?: string | undefined;
  item_count?: number | null | undefined;
  context_tokens?: number | null | undefined;
  last_activity_at?: string | undefined;
  end_reason?: string | undefined;
}

// `ob role tick`'s findings (OS-67), read on the server where the store is.
export interface RoleTickResponse {
  findings: TickFinding[];
}

// A role's start brief and successor note (`ob role brief`, `ob role note`, OS-55).
export interface RoleBriefResponse {
  facts: RoleBriefStoreFacts;
}

export interface RoleNoteRequest {
  role: string;
  body: string;
}

export interface RoleRunResponse {
  run: RoleRun;
  /** On a mark: false when the role already had an open run, which is the run answered. */
  created?: boolean | undefined;
}

export interface RoleRunsResponse {
  runs: RoleRun[];
}

// A team role's inbox (`ob send`, `ob inbox`).
export interface RoleMessageRequest {
  role: string;
  from: string;
  kind?: "message" | "handoff" | undefined;
  ref?: string | null | undefined;
  body: string;
  client_key?: string | null | undefined;
}

export interface RoleMessageResponse {
  message: RoleMessage;
  /** False when a message with the same client_key was already stored, which is the one answered. */
  created: boolean;
}

export interface RoleMessagesResponse {
  messages: RoleMessage[];
}

export interface RoleMessagesReadRequest {
  role: string;
  ids: number[];
  by: string;
}

export interface TeamRemoveResponse {
  team: Team;
  /** The projects that left the team (only under force). */
  members: string[];
  /** The `<role>-<team>` agent rows dropped (only under force). */
  threads: string[];
}

export interface BriefQuery {
  q?: string | undefined;
  in_flight?: boolean | undefined;
}

export interface BriefResponse {
  brief: unknown;
}

export interface LogQuery {
  type?: JournalType | undefined;
  since?: string | undefined;
}

export interface LogListResponse {
  entries: JournalEntry[];
}

export interface LogCreateRequest {
  type: JournalType;
  text: string;
  about?: string | null | undefined;
  item?: string | null | undefined;
}

export interface LogCreateResponse {
  entry: JournalEntry;
}

// 1121: /report and /metrics are gone with the measurement layer, and /audit with it.

export interface JobsResponse {
  jobs: JobHealth[];
}

// 582: one row per deploy target (live omnislash-web on the API host, the 581 test/dev instance, ...).
export interface DeployRow {
  target: string;
  host: string;
  unit: string;
  sha: string;
  at: string;
  result: "ok" | "rolled-back" | "refused";
}

export interface DeploysResponse {
  deploys: DeployRow[];
}

export interface DeployRecordRequest {
  target: string;
  host: string;
  unit: string;
  sha: string;
  /** ISO timestamp; absent = the server stamps now. */
  at?: string | undefined;
  result: "ok" | "rolled-back" | "refused";
}

export interface DeployRecordResponse {
  deploy: DeployRow;
}

/** OB-1809: start the live deploy. `sha` pins it; ob-deploy.sh refuses anything but origin/main's tip. */
export interface DeployRunRequest {
  sha?: string | undefined;
}

export interface DeployRunResponse {
  kicked: true;
  target: string;
  sha?: string | undefined;
}

export interface AlertsResponse {
  alerts: Alert[];
}

export interface AlertSnoozeRequest {
  key: string;
}

export interface AlertSnoozeResponse {
  snoozed: string;
  /** OB-1762: the alert list AFTER the snooze, so a client redraws without a second call. Absent from an older host. */
  alerts?: Alert[] | undefined;
}

/** POST /alerts/ack. Ack and snooze are one write (suppress until the alert's state moves); two names so a UI can label either. */
export type AlertAckRequest = AlertSnoozeRequest;

export interface AlertAckResponse {
  acked: string;
  /** The alert list AFTER the ack. */
  alerts: Alert[];
}

// --- /docs (OB-2004) ---------------------------------------------------------------------------------

export interface DocListRow {
  id: string;
  ref: string | null;
  title: string;
  project: string | null;
  updated_at: string;
}

export interface DocsResponse {
  docs: DocListRow[];
}

export interface DocVersion {
  /** 1 is the oldest version kept. */
  n: number;
  title: string;
  body: string;
  /** When this text was replaced by the next one. */
  replaced_at: string;
}

export interface DocResponse extends DocListRow {
  body: string;
  status: string;
  created_at: string;
  /** Earlier versions, oldest first. */
  versions: DocVersion[];
}

export interface DocCreateRequest {
  title: string;
  project: string;
  body: string;
}

export interface DocSetRequest {
  title?: string | undefined;
  body?: string | undefined;
}

export interface DecisionListRow {
  id: string;
  status: string;
  title: string;
}

export interface DecisionsResponse {
  decisions: DecisionListRow[];
}

export interface DecisionShowResponse {
  id: string;
  title: string;
  status: string;
  detail: Record<string, unknown> | null;
  references: Array<{ direction: string; id: string }>;
  supersedes: string[];
  superseded_by: string[];
}

export interface DecisionSupersedeRequest {
  new_id: string;
  old_id: string;
}

export interface DecisionSupersedeResponse {
  newId: string;
  oldId: string;
  newStatus: string;
  oldStatus: string;
}

export interface LearningListRow {
  id: string;
  status: string;
  kind: string | null;
  progress: string | null;
  title: string;
}

export interface LearningsResponse {
  learnings: LearningListRow[];
}

export interface LearningShowResponse {
  id: string;
  title: string;
  status: string;
  detail: Record<string, unknown> | null;
  references: Array<{ direction: string; id: string }>;
}

export interface RoadmapListRow {
  id: string;
  status: string;
  title: string;
  progress: Progress;
}

export interface RoadmapsResponse {
  roadmaps: RoadmapListRow[];
}

export interface RoadmapShowResponse {
  id: string;
  title: string;
  status: string;
  created_at: string;
  target_date: string | null;
  source_ref: string | null;
  owner: string | null;
  body: string | null;
  members: RoadmapMember[];
  progress: Progress;
  on_track: OnTrack;
}

export interface RoadmapAddMemberRequest {
  item_id: string;
  position?: number | undefined;
}

export interface RoadmapAddMemberResponse {
  /** 1949: the item's current ref (`PS-12`), so the client's echo reads it; absent from an older server. */
  ref?: string | null | undefined;
  id: string;
}

export interface StandupLatestResponse {
  standup: StandupRow | null;
}

export interface StandupWriteRequest {
  md: string;
  date?: string | undefined;
}

export interface StandupWriteResponse {
  date: string;
}

export interface StandupPostedResponse {
  date: string;
  posted: boolean;
}

export interface SlackUnreadQuery {
  limit?: number | undefined;
}

export interface SlackUnreadResponse {
  messages: SlackMessageRow[];
}

// --- GET /health --------------------------------------------------------------------------------------

export interface HealthResponse {
  ok: true;
  /** `postgres` or `sqlite` -- which engine the API is actually fronting. */
  store: string;
}

// --- 456: remaining DATA commands --------------------------------------------------------------------

export interface PeopleResponse {
  people: PersonRow[];
}

export interface PersonCreateRequest {
  real_name: string;
  fields?: PersonFields | undefined;
}

export interface PersonCreateResponse {
  person: PersonRow;
}

export interface PersonShowResponse {
  person: PersonRow;
}

export interface PersonSetRequest {
  id: number;
  fields: PersonFields;
}

export interface PersonSetResponse {
  person: PersonRow;
}

export interface PersonRmRequest {
  id: number;
}

export interface PersonRmResponse {
  id: number;
}

export interface WhoisResponse {
  person: PersonRow;
}

export interface ReviewMissAddRequest {
  pr: string;
  class: string;
  finding: string;
  scope?: string | undefined;
}

export interface ReviewMissAddResponse {
  class: string;
  scope: string;
  pr: string;
}

/** OS-170: `GET /machine/audit`, the same object `ob machine audit --json` prints. */
export type MachineAuditResponse = MachineAudit;

export interface ReviewMissTopResponse {
  ranked: RankedClass[];
}

export interface CursorGetResponse {
  value: string;
}

export interface CursorSetRequest {
  skill: string;
  key: string;
  value: string;
}

export interface CursorSetResponse {
  value: string;
}

export interface TestUsersResponse {
  users: Array<TestUserRow & { secret_present: boolean }>;
}

export interface TestUserCreateRequest {
  label: string;
  value: string;
  role?: string | null | undefined;
  email?: string | null | undefined;
  workspace?: string | null | undefined;
  env?: string | null | undefined;
  secret_ref?: string | null | undefined;
  notes?: string | null | undefined;
}

export interface TestUserCreateResponse {
  user: TestUserRow;
}

export interface TestUserShowResponse {
  user: TestUserRow;
  secret_present: boolean;
  staleness: string | null;
}

export interface TestUserCheckRequest {
  label: string;
}

export interface TestUserCheckResponse {
  label: string;
  secret_ref: string;
  secret_present: boolean;
}

export interface SyncRequest {
  source?: "github" | undefined;
  since?: string | undefined;
  backfill?: boolean | undefined;
}
export interface SyncResponse {
  github?: { prs: number; events: number } | undefined;
}

// --- /ci/main, /github/hooks (OB-2276) -----------------------------------------------------------------------

export interface CiMainResponse {
  reports: CiMainReport[];
}
export interface CiMainNotifyRequest {
  project?: string | null | undefined;
}
export interface CiMainNotifyResponse {
  reports: CiMainReport[];
  outcomes: CiOutcome[];
}
export interface GithubHooksResponse {
  rows: HookPlanRow[];
  dry_run: boolean;
}

// --- /tournaments/* (OB-2271) ---------------------------------------------------------------------------
//
// The rows are the core's own shapes (tournament.ts), so the client prints them with the same functions.

export interface TournamentListResponse {
  tournaments: TournamentListRow[];
}
export interface TournamentResponse {
  tournament: Tournament;
}
export interface TournamentViewResponse {
  tournament: TournamentView;
}
export interface TournamentAddRequest {
  subject: string;
  repo: string;
  criteria: string[];
  ref?: string | null | undefined;
}
export interface TournamentCandidateRequest {
  key: string;
  label?: string | null | undefined;
  images?: string[] | null | undefined;
  revises?: string | null | undefined;
}
export interface TournamentCandidateResponse {
  candidate: TournamentCandidate;
}
export interface TournamentRecordRequest {
  /** The match file as parsed JSON; the server validates it. */
  match: unknown;
  replace?: boolean | undefined;
}
export interface TournamentMatchResponse {
  match: TournamentMatch;
}
export interface TournamentPickRequest {
  candidate: string;
  note?: string | null | undefined;
}

// --- /overnight/* (OB-2097) -------------------------------------------------------------------------------
//
// The core's own shapes (overnight.ts), so the client renders them with the same functions the local command does.

export interface OvernightStartRequest {
  project: string;
  date: string;
}
export interface OvernightStartResponse {
  run: OvernightRun;
  created: boolean;
}
export interface OvernightDecideRequest {
  title: string;
  what: string;
  why: string;
  doubt?: string | null | undefined;
  undo?: string | null | undefined;
  context?: string | null | undefined;
  project: string;
  night?: string | null | undefined;
}
export interface OvernightDecisionResponse {
  decision: OvernightDecision;
}
export interface OvernightSummaryRequest {
  project: string;
  date?: string | undefined;
  section: string;
  line: string;
}
export interface OvernightRunResponse {
  run: OvernightRun;
}
export interface OvernightShowRequest {
  project: string;
  date?: string | undefined;
}
export interface OvernightNightResponse {
  night: OvernightNight;
}
export interface OvernightRunsResponse {
  runs: OvernightRunRow[];
}

// --- OB-1808: commands the API host runs as a job ---------------------------------------------------------

/** A closed set. The server builds the child's argv from this, never from a string a caller sent. */
export type HostJobKind =
  | "backup"
  | "db-backup"
  | "db-snapshot"
  | "db-snapshot-list"
  | "cert-status"
  | "cert-renew"
  | "whatsapp-sync"
  | "whatsapp-bridge-status";

export interface HostJobOptions {
  dryRun?: boolean | undefined;
  force?: boolean | undefined;
  staging?: boolean | undefined;
  json?: boolean | undefined;
  quiet?: boolean | undefined;
  /** `whatsapp-sync` only (OB-1809). */
  backfill?: boolean | undefined;
  since?: string | undefined;
  days?: string | undefined;
  max?: string | undefined;
}

export interface HostJobRequest {
  kind: HostJobKind;
  options?: HostJobOptions | undefined;
}

/** `lost` is a job that died without recording an exit: the host restarted under it. */
export type HostJobStatus = "running" | "ok" | "failed" | "lost";

export interface HostJobRow {
  id: string;
  kind: HostJobKind;
  /** The command as it ran on the host, for a human reading the list. */
  command: string;
  status: HostJobStatus;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
  /** This start joined an identical job already running. */
  reused?: boolean | undefined;
  /** Only on GET /host-jobs/:id, and only once the job has finished. Scrubbed. */
  stdout?: string | undefined;
  stderr?: string | undefined;
  truncated?: boolean | undefined;
}

export interface HostJobResponse {
  job: HostJobRow;
}

export interface HostJobsResponse {
  jobs: HostJobRow[];
}

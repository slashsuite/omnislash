// ob 353 + 416: which `ob` commands go over the API, which stay on this machine.
//
// This is the ob 337 servable list reinstated over a different transport, and it is short and explicit for
// the same reason that one is: a command that reaches half of its data the wrong way is worse than one
// that refuses, because a refusal is reversible and an answer that was acted on is not.
//
// The local-only reasons come from ob 352's `OB_API_LOCAL_ONLY` rather than being restated here, so the
// server's 404 and the client's refusal cannot give two different accounts of why a command is local.
//
// Two classes, and nothing falls between them (416). A HANDLER that is in neither fails the 416 test.
// unroutedRefusal stays as the safety net for that bug, and is not reachable for any known command.
//
//   API_ROUTED     every data path goes over HTTP. No database is opened, on the LAN or off it (D2).
//   LOCAL_ONLY     the command is about THIS MACHINE (D3), or its store path is not ported (337).
//                  `daemon` genuinely touches no database, so it runs; the others refuse up front.
import { OB_API_LOCAL_ONLY } from "./contract.ts";

/**
 * Commands served by an endpoint.
 *
 * Every entry here is a command whose DATA lives in Postgres and whose handler serves it over HTTP; a
 * command that also has a machine-local half keeps that half local inside its handler.
 */
export const API_ROUTED_COMMANDS: ReadonlySet<string> = new Set([
	// OB-1808: the API host runs these as a job the client polls (api/host-jobs.ts).
	"backup",
	"db",
	"cert",
	"next",
	"list",
	"show",
	"add",
	"link",
	"edit",
	"rm",
	"today",
	"order",
	"focus",
	"close",
	"reopen",
	"start",
	"ready",
	"block",
	"unblock",
	"state",
	"note",
	"tag",
	"untag",
	"search",
	"status",
	"agent",
	"agents",
	"lease",
	// OB-2041: SPLIT like `issue landed`: the lease half goes over the API, ss/ufw/route are read HERE.
	"ports",
	// 357. `secret` and `creds` were not local-only -- they were simply unported, and the refusal that came
	// with that left a laptop off the LAN unable to read a token it owns. They are here now, with `secret
	// import` refused by name inside the handler, because import is about THIS machine's files.
	"secret",
	"creds",
	// 1756: `cloudflare` calls the Cloudflare API from THIS machine; its token comes over POST /secrets/read.
	"cloudflare",
	// `config` is the SERVER's settings table over the wire, so a client flips a setting (spinoff_engine)
	// without a database path. The client's own API pointer (OMNISLASH_API / ~/.omnislash_api_url) is NOT a
	// config key, and the handler refuses `remote_host` by name rather than writing it into the server.
	"config",
	// 169 + 389: `issue` is SPLIT like `spinoff`. Pairing (list/link/unlink) and reconcile are the store
	// (and the host's GitHub cred) and are served under /issues. `landed`/`drift` take pairing from the
	// API and run git HERE — they must not send the caller to the API host (wrong checkout).
	"issue",
	// 375: `triage` is a pure DATA command over the store -- list the inbox, clear/reject an item -- so
	// the whole of it is served: GET /triage, POST /triage/:id/clear|reject.
	"triage",
	// 360. `spinoff` was LOCAL_ONLY and that classification was the bug: its queue half is data (337c had
	// already ported every write to the store) and its launch half is this machine, and NEITHER of them is
	// the API host, which holds no checkouts and no launcher. It is here for the same reason `secret` is:
	// the command is split, and its handler keeps the local half local -- `watch` is refused by name inside,
	// because fs.watch on a database file has nothing to watch when there is no database.
	"spinoff",
	// 366. `whatsapp` is SPLIT like `spinoff`. search/recent are pure DATA (whatsapp_message
	// lives in Postgres since 337/324). OB-1809: the bridge runs on the API host, so the rest is served too:
	// sync is a host job, send/bio and the chat prefs are routes. `send` keeps its gate on the caller's
	// terminal. Only `bridge` is refused by name: it is the server's own long-running process.
	"whatsapp",
	// 415. `gmail` / `cal` / `agenda` are DATA (email_message / calendar_event live in Postgres) and
	// sync runs ON THE API HOST against secret `google` (or the host token file). The laptop must not
	// need `~/.google_token`. 420: `google` stays ROUTED (split, like `secret`). `auth`
	// RUNS here (loopback + 127.0.0.1) and persists via the secret API. 1305 adds the HOSTED half
	// (`auth-url`): the server mints the state and a phone finishes at /api/ob/google/callback.
	"gmail",
	"cal",
	"agenda",
	"google",
	// 416. Already Postgres-servable (337). Purpose-built endpoints, not POST /rpc.
	"project",
	// OB-2006: the pages are files on this machine, the facts come over the API (projects, items, config).
	"wiki",
	"brief",
	"log",
	"jobs",
	"alerts",
	"decision",
	// OB-2004: reference documents. list/show/history/add/set each reach a purpose-built /docs endpoint.
	"doc",
	"learning",
	"memory",
	"roadmap",
	// 416: save/set/latest/posted hit the standup table. generate is gone (ob 619).
	"standup",
	// 416 SPLIT: unread reads ingested slack_message rows. sync stays retired (208) — no poll revival.
	"slack",
	// 456: remaining DATA commands. Purpose-built endpoints. sync executes ON THE HOST (GitHub ingest).
	"person",
	"whois",
	// OB-2271: persona tournaments are data, served under /tournaments/*; a match file is read on the caller's
	// machine and sent as JSON, so it never has to be on the host.
	"tournament",
	// OB-2276: `ci main` and `github hooks` are served under /ci/* and /github/*: the host holds the `github` secret,
	// the notice rows and the T3 send, so the client only prints.
	"ci",
	"github",
	// OB-2097: the overnight decision log is data (decision items and run docs), served under /overnight/*.
	"overnight",
	"review-miss",
	// OB-2173: `review readers` is the review_readers row of the config table.
	"review",
	"cursor",
	"test-user",
	"sync",
	// 582: `deploy` is DATA -- one row per deploy target, written by the deploy scripts (ob-deploy.sh
	// on the server, the 581 web-dev push from this machine) and read by `deploy status`. OB-1809: `deploy run`
	// is POST /deploys/run; `--ssh` is the named last resort for when the API is down.
	"deploy",
	// 1120: `t3` is SPLIT like `spinoff`. `doctor`/`login` are about THIS machine's T3 server and its
	// credential file and run here inside the handler; a team (OB-2255) and its role rows cross the wire,
	// while a role's thread is opened, pinned and titled here, where T3 is.
	"t3",
	// `role` is SPLIT like `t3`: the runs and the team cross the wire, the run's thread is read, launched and
	// settled here, where T3 is.
	"role",
	// A team role's inbox: the messages live on the server, so any machine sends and reads them.
	"send",
	"inbox",
]);

export function isApiRouted(command: string): boolean {
	return API_ROUTED_COMMANDS.has(command);
}

/** Where a LOCAL_ONLY refusal points the caller. */
export type LocalOnlyWhere = "this-machine" | "api-host" | "unported";

export interface LocalOnlyCommand {
	/**
	 * "run": the command is about this machine AND touches no tracker data, so it runs here unchanged.
	 * "refuse": it is about this machine and ALSO needs the data, which an API client cannot give it.
	 */
	readonly disposition: "run" | "refuse";
	/** Why it belongs to this machine, in the words the refusal prints. */
	readonly reason: string;
	/**
	 * Where the refusal sends the caller. Default `this-machine` (416): name THIS machine, not
	 * "run it on the API host", unless the job is truly host-only (`api-host`) or the store path
	 * is not ported (`unported`).
	 */
	readonly where?: LocalOnlyWhere;
}

function local(
	reason: string,
	where: LocalOnlyWhere = "this-machine",
	disposition: "run" | "refuse" = "refuse",
): LocalOnlyCommand {
	return { disposition, reason, where };
}

/**
 * Every command that is not API-routed. 416 killed the unrouted third class: a HANDLER lives here
 * or in API_ROUTED_COMMANDS. `web` was on the server's local-only list already; it is
 * listed here now so a client refuses it BY NAME instead of falling through to unroutedRefusal.
 */
export const LOCAL_ONLY_COMMANDS: ReadonlyMap<string, LocalOnlyCommand> = new Map<string, LocalOnlyCommand>([
	["daemon", local(OB_API_LOCAL_ONLY.daemon!, "this-machine", "run")],
	["web", local(OB_API_LOCAL_ONLY.web!, "api-host")],
	["vision", local(OB_API_LOCAL_ONLY.vision!, "this-machine", "run")],
	["models", local(OB_API_LOCAL_ONLY.models!, "this-machine", "run")],
	["usage", local(OB_API_LOCAL_ONLY.usage!, "this-machine", "run")],
	["api-token", local(OB_API_LOCAL_ONLY["api-token"]!, "this-machine", "run")],
]);

export function localOnly(command: string): LocalOnlyCommand | null {
	return LOCAL_ONLY_COMMANDS.get(command) ?? null;
}

/** The refusal for a LOCAL_ONLY command that also needs the tracker's data (D3). */
export function localOnlyRefusal(command: string, reason: string, where: LocalOnlyWhere = "this-machine"): string {
	if (where === "unported") {
		return [
			`'ob ${command}' is a LOCAL command and the ob API does not serve it: ${reason}.`,
			`  store path not ported (337). An API client opens no database (map decision D2), and a lying`,
			`  endpoint that cannot run this on Postgres is worse than a refusal.`,
			`  there is no endpoint.`,
		].join("\n");
	}
	if (where === "api-host") {
		return [
			`'ob ${command}' is a LOCAL command and the ob API does not serve it: ${reason}, and it reads and writes the tracker.`,
			`  ob reaches the tracker's data over the API only (map decision D2, no direct database), so this command cannot be`,
			`  completed on this machine -- and it refuses here rather than doing half of its work and failing partway.`,
			`  run it on the machine that has both the checkouts and the database: the API host.`,
		].join("\n");
	}
	return [
		`'ob ${command}' is a LOCAL command and the ob API does not serve it: ${reason}.`,
		`  it belongs on THIS machine. There is no endpoint.`,
		`  run it here (unset OMNISLASH_API), not on the API host.`,
	].join("\n");
}

/** The refusal for a command with no endpoint yet. Safety net: a known HANDLER must never reach this. */
export function unroutedRefusal(command: string, base: string): string {
	return [
		`'ob ${command}' is not routed through the ob API yet (ob 353 ported the working loop: ${[...API_ROUTED_COMMANDS].join(", ")}).`,
		`  this machine is an API client (${base}) and has no direct database path, so the command refuses rather than`,
		`  answering from a database that is not the one the API serves.`,
		`  this is a bug in ob's routing (416): every HANDLER belongs in API_ROUTED_COMMANDS or LOCAL_ONLY_COMMANDS.`,
	].join("\n");
}

/** The refusal when a LOCAL_ONLY "run" command reaches for the tracker's data after all. */
export function localStoreRefusal(command: string, what: string): string {
	return [
		`'ob ${command}' runs locally on an API client, but it reached the tracker's data (${what}).`,
		`  an API client opens no database at all (map decision D2), so there is nothing behind that read.`,
		`  this is a bug in ob's routing, not in the caller: the command belongs in API_ROUTED_COMMANDS or its data half`,
		`  belongs behind an endpoint.`,
	].join("\n");
}

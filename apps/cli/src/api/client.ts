// ob 353: the HTTP transport, and the one place a bearer token is ever attached to a request.
//
// Every path, the prefix, the header name and the error envelope come from ob 352's shared contract, so
// this file cannot drift from the server by so much as a spelling. The token goes in the Authorization
// header and nowhere else -- not in the url, not in a query parameter, not in argv, and not in any message
// this module produces. `redactToken` is the backstop for the last of those: a transport error from fetch
// can carry the request back with it, so every error text goes through it before it reaches stderr.
import { closeSync, openSync, renameSync, rmSync } from "node:fs";
import { AppError, UsageError } from "../errors.ts";
import { CallTimeoutError, timeoutFromEnv, withDeadline } from "../deadline.ts";
import { resolveAccessCredentials } from "./config.ts";
import {
	OB_API_AUTH_HEADER,
	OB_API_PREFIX,
	apiTimeoutFor,
	describeRoutes,
	type AcquireLeaseRequest,
	type AcquireLeaseResponse,
	type AgentActiveQuery,
	type AgentActiveResponse,
	type HostJobRequest,
	type HostJobResponse,
	type HostJobsResponse,
	type AgentRequest,
	type AgentResponse,
	type AgentsResetRequest,
	type AgentsResetResponse,
	type AgentsResponse,
	type CreateItemRequest,
	type CreateItemResponse,
	type CredsCheckRequest,
	type CredsCheckResponse,
	type CredsResponse,
	type ItemResponse,
	type ItemsQuery,
	type ItemsResponse,
	type LeasesResponse,
	type SweepLeasesResponse,
	type NextResponse,
	type NoteRequest,
	type NoteResponse,
	type ObApiErrorBody,
	type ReadSecretRequest,
	type ReadSecretResponse,
	type ReleaseLeaseResponse,
	type RemoveSecretRequest,
	type RemoveSecretResponse,
	type SearchResponse,
	type SecretsResponse,
	type SetSecretRequest,
	type SetSecretResponse,
  type ClaimSpinoffRequest,
  type ClaimSpinoffResponse,
  type CleanupGuardRequest,
  type CleanupGuardResponse,
  type ConfigResponse,
  type ConfigSetRequest,
  type ConfigSetResponse,
  type EnqueueSpinoffRequest,
  type SpinoffCheckRequest,
  type SpinoffCheckResponse,
	type EnqueueSpinoffResponse,
	type DeleteItemResponse,
	type EditItemRequest,
	type EditItemResponse,
	type FocusRequest,
	type FocusResponse,
	type GithubIssuesResponse,
	type GoogleAuthUrlResponse,
	type ItemLinkRequest,
	type ItemLinkResponse,
	type IssueLinkRequest,
	type IssueLinkResponse,
	type IssuePairingResponse,
	type IssueReconcileResponse,
	type IssuesResponse,
	type IssueUnlinkRequest,
	type IssueUnlinkResponse,
	type TodayRequest,
	type OrderRequest,
	type OrderResponse,
	type TodayResponse,
	type LandSpinoffRequest,
	type LandSpinoffResponse,
	type RecordSpinoffTokensRequest,
	type RecordSpinoffTokensResponse,
	type ReadySpinoffRequest,
	type SendBackSpinoffRequest,
	type SendBackSpinoffResponse,
	type ReopenSpinoffRequest,
	type ReopenSpinoffResponse,
	type SpinoffVerdictRequest,
	type SpinoffVerdictResponse,
	type SpinoffNoteErrorRequest,
	type SpinoffNoteErrorResponse,
	type SpinoffTrialRequest,
	type SpinoffTrialResponse,
	type ReadySpinoffResponse,
	type LaunchableRequest,
	type LaunchableResponse,
	type ReclaimSpinoffsResponse,
	type SpinoffConfigResponse,
type SpinoffsQuery,
  type SpinoffsResponse,
  type SpinoffServingRequest,
  type SpinoffPlannedFilesRequest,
  type SpinoffPlannedFilesResponse,
  type StampSpinoffRequest,
  type StampSpinoffResponse,
  type TriageActionResponse,
  type TriageResponse,
  type WhatsappRecentResponse,
  type WhatsappSendRequest,
  type WhatsappSendResponse,
  type WhatsappPrefRequest,
  type WhatsappPrefResponse,
  type WhatsappPrefChatsResponse,
  type DeployRunRequest,
  type DeployRunResponse,
  type WhatsappSearchResponse,
  type GmailSearchResponse,
  type GmailListResponse,
  type GmailSyncRequest,
  type GmailSyncResponse,
  type GmailDraftCreateRequest,
  type GmailDraftDeleteResponse,
  type GmailDraftEditRequest,
  type GmailDraftListResponse,
  type GmailDraftResponse,
  type GmailSendDraftRequest,
  type GmailSendDraftResponse,
  type GmailMessageResponse,
  type GmailAttachmentsResponse,
  type CalSyncRequest,
  type CalSyncResponse,
  type AgendaResponse,
  type ProjectsResponse,
  type ProjectCreateRequest,
  type ProjectCreateResponse,
  type ProjectEditRequest,
  type ProjectEditResponse,
  type ProjectRemoveResponse,
  type TeamsResponse,
  type TeamResponse,
  type TeamCreateRequest,
  type TeamEditRequest,
  type TeamJoinResponse,
  type TeamLeaveResponse,
  type TeamRemoveResponse,
  type TeamHandoffResponse,
  type ProjectRenameRequest,
  type ProjectRenameResponse,
  type BriefResponse,
  type LogListResponse,
  type LogCreateRequest,
  type LogCreateResponse,
  type JobsResponse,
  type DeploysResponse,
  type DeployRecordRequest,
  type DeployRecordResponse,
  type AlertsResponse,
  type AlertSnoozeResponse,
  type DecisionsResponse,
  type DocCreateRequest,
  type DocResponse,
  type DocSetRequest,
  type DocsResponse,
  type DecisionShowResponse,
  type DecisionSupersedeRequest,
  type DecisionSupersedeResponse,
  type LearningsResponse,
  type LearningShowResponse,
  type RoadmapsResponse,
  type RoadmapShowResponse,
  type RoadmapAddMemberRequest,
  type RoadmapAddMemberResponse,
  type StandupLatestResponse,
  type StandupWriteRequest,
  type StandupWriteResponse,
  type StandupPostedResponse,
  type SlackUnreadResponse,
  type PeopleResponse,
  type PersonCreateRequest,
  type PersonCreateResponse,
  type PersonShowResponse,
  type PersonSetRequest,
  type PersonSetResponse,
  type PersonRmRequest,
  type PersonRmResponse,
  type WhoisResponse,
  type CiMainResponse,
  type CiMainNotifyResponse,
  type GithubHooksResponse,
  type TournamentListResponse,
  type TournamentResponse,
  type TournamentViewResponse,
  type TournamentAddRequest,
  type TournamentCandidateRequest,
  type TournamentCandidateResponse,
  type TournamentRecordRequest,
  type TournamentMatchResponse,
  type TournamentPickRequest,
  type OvernightDecideRequest,
  type OvernightDecisionResponse,
  type OvernightNightResponse,
  type OvernightRunResponse,
  type OvernightRunsResponse,
  type OvernightShowRequest,
  type OvernightStartRequest,
  type OvernightStartResponse,
  type OvernightSummaryRequest,
  type ReviewMissAddRequest,
  type ReviewMissAddResponse,
  type ReviewMissTopResponse,
  type CursorGetResponse,
  type CursorSetRequest,
  type CursorSetResponse,
  type TestUsersResponse,
  type TestUserCreateRequest,
  type TestUserCreateResponse,
  type TestUserShowResponse,
  type TestUserCheckRequest,
  type TestUserCheckResponse,
  type SyncRequest,
  type SyncResponse,
	type StateRequest,
	type StateResponse,
	type StatusResponse,
	type TagsRequest,
	type TagsResponse,
	type TrackerMoveRequest,
	type TrackerMoveResponse,
} from "./contract.ts";

export interface ApiRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
	/** Aborted when the client's deadline passes (1616), so a real transport tears the socket down. */
	signal?: AbortSignal;
}

export interface ApiRawResponse {
	status: number;
	body: string;
}

/**
 * The seam every test injects. The default is fetch; a test hands a function that returns canned bodies,
 * so the suite reaches no network at all and a command that should never reach HTTP can be PROVEN not to.
 */
export type ApiTransport = (req: ApiRequest) => Promise<ApiRawResponse>;

export class ApiError extends AppError {
	readonly status: number;
	/**
	 * True when the request never got a response at all: refused, reset, DNS (OB-2157). A deploy restart of
	 * omnislash-web refuses connections for a few seconds, and a waiting lease treats that as "not yet".
	 * False for a call timeout and for every HTTP status.
	 */
	readonly unreachable: boolean;
	constructor(message: string, status: number, opts: { unreachable?: boolean } = {}) {
		super(message);
		this.status = status;
		this.unreachable = opts.unreachable ?? false;
	}
}

/** The API could not be reached at all (OB-2157): see `ApiError.unreachable`. */
export function isApiUnreachable(err: unknown): boolean {
	return err instanceof ApiError && err.unreachable;
}

/**
 * The API gave no answer: unreachable, or a call that timed out (status 0). Either may clear on the next
 * try, so a waiting lease keeps waiting on it; an HTTP status is an answer and is never transient here.
 */
export function isApiTransient(err: unknown): boolean {
	return err instanceof ApiError && (err.unreachable || err.status === 0);
}

/**
 * The server maps a UsageError to a 400 `invalid_request`, so anything the API answered with that code was
 * a usage error on the server, which exits 2 there, not 1. A client keeps its exit codes across the hop
 * (OB-1807): a 400 comes back as the UsageError it was, and a 409 (a refusal) stays the AppError it was.
 */
export async function usageOn400<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) throw new UsageError(e.message);
    throw e;
  }
}

/** Strip a token out of any text before it is printed, however it got in there. */
export function redactToken(text: string, token: string): string {
	return redactSecrets(text, [token]);
}

/**
 * Strip every given credential out of any text before it is printed (357).
 *
 * The bearer token was the only one of these until secrets started crossing the wire. Now `ob secret set`
 * puts a plaintext VALUE in a request body, and a transport error, a proxy's error page or a 500 echoed
 * back can carry a request back with it -- so the value has to be scrubbed on exactly the same paths the
 * token already is. Everything in `ApiClient.call` that builds a message goes through here.
 */
export function redactSecrets(text: string, values: readonly string[]): string {
	let out = text;
	for (const value of values) {
		if (!value) continue;
		out = out.split(value).join("<redacted>");
	}
	return out;
}

/**
 * How long one API call may take before the client gives up and names it (1616). Longer than the server's own
 * request deadline (API_REQUEST_TIMEOUT_MS), so a slow store answers with the server's named 504 first and
 * this only fires when the server itself never answers. `OB_API_TIMEOUT_MS` overrides it.
 */
const API_CLIENT_TIMEOUT_MS = 150_000;

export interface ApiClientOptions {
	base: string;
	token: string;
	transport?: ApiTransport;
	/** Per-call deadline in ms (1616). Default `OB_API_TIMEOUT_MS`, else API_CLIENT_TIMEOUT_MS. */
	timeoutMs?: number;
	/** OB-1808: the byte-stream seam for file downloads. Default fetch. */
	download?: ApiDownload;
	/** OB-2160: the short-outage retry. Defaults: `OB_API_RETRY_MS` (else 30s), a real sleep, Date.now, stderr. */
	retry?: Partial<ApiRetry>;
}

/**
 * OB-2160: every live deploy restarts omnislash-web, and for that moment the port refuses connections. A command
 * that hits it waits the blip out instead of failing: a refused connection never reached the server, so it is
 * retried for every method; a reset may have reached it, so only a GET retries one; a timeout never retries
 * (the server took the request). Backoff 0.5s doubling to 4s, for at most `totalMs` in all.
 */
export interface ApiRetry {
	/** Total time a call may spend retrying. 0 turns the retry off (the old fail-fast). */
	totalMs: number;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	/** The one stderr line a client prints when it first starts retrying. */
	warn: (line: string) => void;
}

export const API_RETRY_ENV = "OB_API_RETRY_MS";
export const API_RETRY_DEFAULT_MS = 30_000;
const RETRY_FIRST_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 4_000;

/** `OB_API_RETRY_MS`: a non-negative integer (0 = off), anything else is the default. */
export function retryMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[API_RETRY_ENV];
	if (raw === undefined || raw.trim() === "") return API_RETRY_DEFAULT_MS;
	const parsed = Number(raw);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : API_RETRY_DEFAULT_MS;
}

function errorCode(err: unknown): string | undefined {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

/**
 * The connection was refused: nothing was sent. Bun's fetch can report it as `code: "ConnectionRefused"` or as
 * `ECONNREFUSED` (CI saw the second, OB-2291); both mean refused, and the closed-port fetch in
 * api-retry-2160.test.ts pins that the code is one of the two.
 */
export function isConnectionRefused(err: unknown): boolean {
	const code = errorCode(err);
	return code === "ConnectionRefused" || code === "ECONNREFUSED";
}

/** The connection dropped mid-request: the server may have seen it. Bun reports `ECONNRESET`. */
export function isConnectionReset(err: unknown): boolean {
	const code = errorCode(err);
	return code === "ECONNRESET" || code === "ConnectionClosed" || code === "EPIPE";
}

/** OB-1808: a file comes back as bytes, which the text transport would corrupt. Tests hand a canned Response. */
export type ApiDownload = (req: ApiRequest) => Promise<Response>;

function fetchTransport(): ApiTransport {
	return async (req) => {
		const res = await fetch(req.url, {
			method: req.method,
			headers: req.headers,
			body: req.body,
			signal: req.signal,
		});
		return { status: res.status, body: await res.text() };
	};
}

type QueryValue = string | number | boolean | undefined | null;

function queryString(params: Record<string, QueryValue>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === "") continue;
		search.set(key, String(value));
	}
	const rendered = search.toString();
	return rendered ? `?${rendered}` : "";
}

const path = {
	next: "/next",
	items: "/items",
	item: (id: string) => `/items/${encodeURIComponent(id)}`,
	close: (id: string) => `/items/${encodeURIComponent(id)}/close`,
	reopen: (id: string) => `/items/${encodeURIComponent(id)}/reopen`,
	state: (id: string) => `/items/${encodeURIComponent(id)}/state`,
	notes: (id: string) => `/items/${encodeURIComponent(id)}/notes`,
	tags: (id: string) => `/items/${encodeURIComponent(id)}/tags`,
	links: (id: string) => `/items/${encodeURIComponent(id)}/links`,
	edit: (id: string) => `/items/${encodeURIComponent(id)}/edit`,
	order: (id: string) => `/items/${encodeURIComponent(id)}/order`,
	today: "/today",
	focus: "/focus",
	search: "/search",
	status: "/status",
	agents: "/agents",
	agentsReset: "/agents/reset",
	agentActive: "/agents/active",
	leases: "/leases",
	lease: (resource: string) => `/leases/${encodeURIComponent(resource)}`,
	leasesSweep: "/leases/sweep",
	// 357: no `:name` anywhere below. A secret's NAME travels in a POST body so it stays out of access
	// logs, and there is nothing to percent-encode, which is the ob 352 malformed-escape class gone too.
	secrets: "/secrets",
	secretRead: "/secrets/read",
	secretRemove: "/secrets/remove",
  creds: "/creds",
  credsCheck: "/creds/check",
  config: "/config",
  // 1305: the hosted Google auth half. Server-side state mint; the client just prints the URL.
  googleAuthUrl: "/google/auth-url",
	issues: "/issues",
	issueLink: "/issues/link",
	issueUnlink: "/issues/unlink",
	issuePairing: "/issues/pairing",
	issueGithub: "/issues/github",
	issueReconcile: "/issues/reconcile",
	triage: "/triage",
	triageClear: (id: string) => `/triage/${encodeURIComponent(id)}/clear`,
	triageReject: (id: string) => `/triage/${encodeURIComponent(id)}/reject`,
	whatsappSearch: "/whatsapp/search",
	whatsappRecent: "/whatsapp/recent",
	whatsappSend: "/whatsapp/send",
	whatsappPrefs: "/whatsapp/prefs",
	gmailSearch: "/gmail/search",
	gmailList: "/gmail/list",
	gmailSync: "/gmail/sync",
	gmailMessage: (id: string) => `/gmail/messages/${encodeURIComponent(id)}`,
	gmailAttachments: (id: string) => `/gmail/messages/${encodeURIComponent(id)}/attachments`,
	gmailDrafts: "/gmail/drafts",
	gmailDraft: (id: string) => `/gmail/drafts/${encodeURIComponent(id)}`,
	gmailEditDraft: (id: string) => `/gmail/drafts/${encodeURIComponent(id)}/edit`,
	gmailSendDraft: (id: string) => `/gmail/drafts/${encodeURIComponent(id)}/send`,
	calAgenda: "/cal/agenda",
	calSync: "/cal/sync",
	projects: "/projects",
	teams: "/teams",
	brief: "/brief",
	log: "/log",
	jobs: "/jobs",
	deploys: "/deploys",
	deployRun: "/deploys/run",
	alerts: "/alerts",
	alertsSnooze: "/alerts/snooze",
	docs: "/docs",
	doc: (id: string) => `/docs/${encodeURIComponent(id)}`,
	docSet: (id: string) => `/docs/${encodeURIComponent(id)}/set`,
	decisions: "/decisions",
	decision: (id: string) => `/decisions/${encodeURIComponent(id)}`,
	decisionSupersede: "/decisions/supersede",
	learnings: "/learnings",
	learning: (id: string) => `/learnings/${encodeURIComponent(id)}`,
	roadmaps: "/roadmaps",
	roadmap: (id: string) => `/roadmaps/${encodeURIComponent(id)}`,
	roadmapMembers: (id: string) => `/roadmaps/${encodeURIComponent(id)}/members`,
	standupLatest: "/standup/latest",
	standupSave: "/standup/save",
	standupSet: "/standup/set",
	standupPosted: "/standup/posted",
	slackUnread: "/slack/unread",
	people: "/people",
	peopleShow: "/people/show",
	peopleSet: "/people/set",
	peopleRm: "/people/rm",
	whois: "/whois",
	// OB-2271: persona tournaments.
	tournaments: "/tournaments",
	// OB-2276: CI on main and the GitHub hooks.
	ciMain: "/ci/main",
	ciMainNotify: "/ci/main/notify",
	githubHooks: "/github/hooks",
	// OB-2097: the overnight decision log.
	overnightStart: "/overnight/start",
	overnightDecide: "/overnight/decide",
	overnightSummary: "/overnight/summary",
	overnightShow: "/overnight/show",
	overnightRuns: "/overnight/runs",
	reviewMisses: "/review-misses",
	reviewMissesTop: "/review-misses/top",
	cursors: "/cursors",
	testUsers: "/test-users",
	testUsersShow: "/test-users/show",
	testUsersCheck: "/test-users/check",
	sync: "/sync",
	// 360: the spinoff queue. No `:id` anywhere -- a row id, a holder and a branch travel in POST bodies,
	// for the same reason a secret's name does: a path is logged in places a body is not.
	spinoffs: "/spinoffs",
	spinoffServing: "/spinoffs/serving",
	spinoffCheck: "/spinoffs/check",
	spinoffPlannedFiles: "/spinoffs/planned-files",
	spinoffConfig: "/spinoffs/config",
	spinoffLaunchable: "/spinoffs/launchable",
	spinoffClaim: "/spinoffs/claim",
	spinoffStamp: "/spinoffs/stamp",
	spinoffLand: "/spinoffs/land",
	spinoffTokens: "/spinoffs/tokens",
	spinoffReady: "/spinoffs/ready",
	spinoffSendBack: "/spinoffs/sendback",
	spinoffReopen: "/spinoffs/reopen",
	spinoffVerdict: "/spinoffs/verdict",
	spinoffNoteError: "/spinoffs/note-error",
	spinoffTrial: "/spinoffs/trial",
	spinoffReclaim: "/spinoffs/reclaim",
	spinoffCleanupGuard: "/spinoffs/cleanup-guard",
	hostJobs: "/host-jobs",
};

export class ApiClient {
	private readonly base: string;
	private readonly token: string;
	private readonly transport: ApiTransport;
	private readonly timeoutMs: number;
	private readonly downloader: ApiDownload;
	private readonly retry: ApiRetry;
	private warnedRetry = false;

	constructor(options: ApiClientOptions) {
		this.base = options.base;
		this.token = options.token;
		this.transport = options.transport ?? fetchTransport();
		this.downloader = options.download ?? ((req) => fetch(req.url, { method: req.method, headers: req.headers, signal: req.signal }));
		this.timeoutMs = options.timeoutMs ?? timeoutFromEnv("OB_API_TIMEOUT_MS", API_CLIENT_TIMEOUT_MS);
		this.retry = {
			totalMs: options.retry?.totalMs ?? retryMsFromEnv(),
			sleep: options.retry?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
			now: options.retry?.now ?? Date.now,
			warn: options.retry?.warn ?? ((line) => process.stderr.write(`${line}\n`)),
		};
	}

	/**
	 * Run one attempt, and again while it fails with a connection the server never took (OB-2160). `resets` says
	 * whether a reset is safe to retry too (a GET). Anything else, a timeout included, is thrown at once, and the
	 * last error is thrown as it was when the budget runs out.
	 */
	private async retrying<T>(attempt: () => Promise<T>, resets: boolean): Promise<T> {
		const { totalMs, sleep, now, warn } = this.retry;
		const start = now();
		let delay = RETRY_FIRST_DELAY_MS;
		for (;;) {
			try {
				return await attempt();
			} catch (err) {
				if (err instanceof CallTimeoutError) throw err;
				const retryable = isConnectionRefused(err) || (resets && isConnectionReset(err));
				const left = totalMs - (now() - start);
				if (!retryable || left <= 0) throw err;
				if (!this.warnedRetry) {
					this.warnedRetry = true;
					const what = isConnectionRefused(err) ? "refused the connection" : "dropped the connection";
					warn(`ob API at ${this.base} ${what}, retrying for up to ${Math.round(totalMs / 1000)}s (a deploy restarts it)`);
				}
				await sleep(Math.min(delay, left));
				delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
			}
		}
	}

	/**
	 * @param redact credential values carried in THIS request's body (357), scrubbed out of every message
	 * this method can produce. The bearer token is always in the list; a `secret set` adds its value.
	 */
	private async call<T>(method: string, route: string, body?: unknown, redact: readonly string[] = []): Promise<T> {
		const secrets = [this.token, ...redact];
		const scrub = (text: string): string => redactSecrets(text, secrets);
		const url = `${this.base}${OB_API_PREFIX}${route}`;
		const headers: Record<string, string> = { ...this.authHeaders(), Accept: "application/json" };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		let res: ApiRawResponse;
		try {
			res = await this.retrying(() => {
				// A fresh controller per attempt: an aborted one would cancel the retry before it was sent.
				const abort = new AbortController();
				return withDeadline(
					`${method} ${route}`,
					apiTimeoutFor(route, this.timeoutMs),
					() =>
						this.transport({
							method,
							url,
							headers,
							signal: abort.signal,
							...(body === undefined ? {} : { body: JSON.stringify(body) }),
						}),
					() => abort.abort(),
				);
			}, method === "GET");
		} catch (err) {
			// A hang is not "could not reach": the host took the request and never answered (1616). Say which
			// call and for how long, so the journal line is the diagnosis.
			if (err instanceof CallTimeoutError) {
				throw new ApiError(
					scrub(`the ob API at ${this.base} did not answer ${err.call} within ${err.ms}ms (timed out, not unreachable)`),
					0,
				);
			}
			// "could not reach the host" and "it ran and failed" need opposite reactions, so they are never
			// reported as the same thing -- the same rule the deleted ssh split had for a failed connection.
			throw new ApiError(
				[
					`could not reach the ob API at ${this.base}: ${scrub((err as Error).message)}`,
					`  ob has no local database path to fall back to (map decision D2), so this is the whole answer, not a degraded one.`,
				].join("\n"),
				0,
				{ unreachable: true },
			);
		}
		if (res.status === 401 || res.status === 403) {
			throw new ApiError(
				[
					`the ob API at ${this.base} rejected this token (HTTP ${res.status}).`,
					`  the server compares it against ITS OWN token file; re-copy or rotate it from the API host.`,
				].join("\n"),
				res.status,
			);
		}
		if (res.status < 200 || res.status >= 300) {
			throw new ApiError(scrub(this.explain(res)), res.status);
		}
		if (!res.body.trim()) return undefined as T;
		try {
			return JSON.parse(res.body) as T;
		} catch {
			throw new ApiError(
				`the ob API at ${this.base} answered ${res.status} with a body that is not JSON (${res.body.length} bytes)`,
				res.status,
			);
		}
	}

	private authHeaders(): Record<string, string> {
		const headers: Record<string, string> = { [OB_API_AUTH_HEADER]: `Bearer ${this.token}` };
		// Cloudflare Access (ob 354) gates the tunnel in front of the API and needs its own pair. Absent
		// on the LAN, where there is no Access to satisfy, so this is additive rather than a second mode.
		const access = resolveAccessCredentials();
		if (access) {
			headers["CF-Access-Client-Id"] = access.id;
			headers["CF-Access-Client-Secret"] = access.secret;
		}
		return headers;
	}

	/**
	 * OB-1808: stream one file to `dest`, written 0600 and renamed into place only when whole. The deadline covers
	 * the wait for the answer, not the transfer: a large dump takes as long as it takes.
	 */
	private async download(route: string, dest: string): Promise<number> {
		const scrub = (text: string): string => redactSecrets(text, [this.token]);
		const url = `${this.base}${OB_API_PREFIX}${route}`;
		let abort = new AbortController();
		let res: Response;
		try {
			// OB-2160: a refused connection only. A reset mid-download is not retried here.
			res = await this.retrying(() => {
				abort = new AbortController();
				const signal = abort.signal;
				return withDeadline(`GET ${route}`, this.timeoutMs, () =>
					this.downloader({
						method: "GET",
						url,
						headers: this.authHeaders(),
						signal,
					}),
				);
			}, false);
		} catch (err) {
			abort.abort();
			throw new ApiError(`could not fetch from the ob API at ${this.base}: ${scrub((err as Error).message)}`, 0);
		}
		if (res.status < 200 || res.status >= 300) {
			throw new ApiError(scrub(this.explain({ status: res.status, body: await res.text() })), res.status);
		}
		// Every file this returns is binary. A web page with a 200 is a sign-in page from something in front of the
		// API, and saving it as a dump would report success for a file that is not one.
		if ((res.headers.get("content-type") ?? "").includes("text/html")) {
			await res.body?.cancel();
			throw new ApiError(`the ob API at ${this.base} answered ${route} with a web page, not a file: is Cloudflare Access asking to sign in?`, res.status);
		}
		const part = `${dest}.part`;
		try {
			// The mode is set before any byte lands, so a dump is never readable by others part way through.
			rmSync(part, { force: true });
			closeSync(openSync(part, "wx", 0o600));
			const bytes = await Bun.write(part, res);
			renameSync(part, dest);
			return bytes;
		} catch (err) {
			rmSync(part, { force: true });
			throw new ApiError(`the download from the ob API at ${this.base} did not finish: ${scrub((err as Error).message)}`, 0);
		}
	}

	private explain(res: ApiRawResponse): string {
		try {
			const parsed = JSON.parse(res.body) as ObApiErrorBody;
			if (parsed?.error?.message) {
				const lines = [parsed.error.message];
				// `unknown_endpoint` carries the served surface: a client that has drifted past the server it
				// is talking to finds out WHAT it may ask for, rather than only that it asked wrongly.
				if (parsed.error.code === "unknown_endpoint") {
					const served = parsed.error.served ?? describeRoutes();
					lines.push(`  this API serves:`, ...served.map((s) => `    ${s}`));
				}
				if (parsed.error.code === "api_disabled") {
					lines.push(`  that is the SERVER's token file, not this machine's: nothing here will fix it.`);
				}
				return lines.join("\n");
			}
		} catch {
			// not the envelope; fall through to the raw shape below
		}
		const snippet = res.body.trim().slice(0, 300);
		return `the ob API at ${this.base} answered HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`;
	}

	next(project?: string): Promise<NextResponse> {
		return this.call("GET", `${path.next}${queryString({ project })}`);
	}

	/** OB-2083: place an item in its project's queue. */
	order(id: string, body: OrderRequest): Promise<OrderResponse> {
		return this.call("POST", path.order(id), body);
	}

	items(query: ItemsQuery): Promise<ItemsResponse> {
		return this.call("GET", `${path.items}${queryString(query as Record<string, QueryValue>)}`);
	}

	createItem(body: CreateItemRequest): Promise<CreateItemResponse> {
		return this.call("POST", path.items, body);
	}

	item(id: string): Promise<ItemResponse> {
		return this.call("GET", path.item(id));
	}

	close(id: string, body: TrackerMoveRequest): Promise<TrackerMoveResponse> {
		return this.call("POST", path.close(id), body);
	}

	reopen(id: string, body: TrackerMoveRequest): Promise<TrackerMoveResponse> {
		return this.call("POST", path.reopen(id), body);
	}

	state(id: string, body: StateRequest): Promise<StateResponse> {
		return this.call("POST", path.state(id), body);
	}

	note(id: string, body: NoteRequest): Promise<NoteResponse> {
		return this.call("POST", path.notes(id), body);
	}

	tags(id: string, body: TagsRequest): Promise<TagsResponse> {
		return this.call("POST", path.tags(id), body);
	}

	search(q: string): Promise<SearchResponse> {
		return this.call("GET", `${path.search}${queryString({ q })}`);
	}

	status(): Promise<StatusResponse> {
		return this.call("GET", path.status);
	}

	agents(all: boolean): Promise<AgentsResponse> {
		return this.call("GET", `${path.agents}${queryString({ all: all || undefined })}`);
	}

	agent(body: AgentRequest): Promise<AgentResponse> {
		return this.call("POST", path.agents, body);
	}

	agentsReset(body: AgentsResetRequest = {}): Promise<AgentsResetResponse> {
		return this.call("POST", path.agentsReset, body);
	}

	agentActive(query: AgentActiveQuery): Promise<AgentActiveResponse> {
		return this.call("GET", `${path.agentActive}${queryString({ within_min: query.within_min })}`);
	}

	leases(): Promise<LeasesResponse> {
		return this.call("GET", path.leases);
	}

	/** OB-1922: delete leases expired for over a day. */
	sweepLeases(): Promise<SweepLeasesResponse> {
		return this.call("POST", path.leasesSweep, {});
	}

	acquireLease(body: AcquireLeaseRequest): Promise<AcquireLeaseResponse> {
		return this.call("POST", path.leases, body);
	}

	releaseLease(resource: string, query: { holder: string; force?: boolean }): Promise<ReleaseLeaseResponse> {
		return this.call(
			"DELETE",
			`${path.lease(resource)}${queryString({ holder: query.holder, force: query.force || undefined })}`,
		);
	}

	/** NAMES and ages. The response type has no field a value could arrive in (357). */
	secrets(): Promise<SecretsResponse> {
		return this.call("GET", path.secrets);
	}

	readSecret(body: ReadSecretRequest): Promise<ReadSecretResponse> {
		return this.call("POST", path.secretRead, body);
	}

	/**
	 * The one call that puts a plaintext VALUE on the wire. It is declared to `call` as a value to redact,
	 * so a transport failure or a non-2xx body that carried the request back cannot print it to stderr.
	 */
	setSecret(body: SetSecretRequest): Promise<SetSecretResponse> {
		return this.call("POST", path.secrets, body, [body.value]);
	}

	removeSecret(body: RemoveSecretRequest): Promise<RemoveSecretResponse> {
		return this.call("POST", path.secretRemove, body);
	}

	/** 1305: mint a hosted OAuth state on the server and get Google's consent URL for it. */
	googleAuthUrl(): Promise<GoogleAuthUrlResponse> {
		return this.call("POST", path.googleAuthUrl);
	}

	creds(): Promise<CredsResponse> {
		return this.call("GET", path.creds);
	}

	credsCheck(body: CredsCheckRequest): Promise<CredsCheckResponse> {
		return this.call("POST", path.credsCheck, body);
	}

	// --- the config table ---------------------------------------------------------------------------

	config(key?: string): Promise<ConfigResponse> {
		return this.call("GET", key ? `${path.config}?key=${encodeURIComponent(key)}` : path.config);
	}

  configSet(body: ConfigSetRequest): Promise<ConfigSetResponse> {
    return this.call("POST", path.config, body);
  }

  // --- the ob<->issue pairs (169) ---------------------------------------------------------------------

  issueLinks(): Promise<IssuesResponse> {
    return this.call("GET", path.issues);
  }

  issueLink(body: IssueLinkRequest): Promise<IssueLinkResponse> {
    return this.call("POST", path.issueLink, body);
  }

  issueUnlink(body: IssueUnlinkRequest): Promise<IssueUnlinkResponse> {
    return this.call("POST", path.issueUnlink, body);
  }

  issuePairing(): Promise<IssuePairingResponse> {
    return this.call("GET", path.issuePairing);
  }

  githubIssues(): Promise<GithubIssuesResponse> {
    return this.call("GET", path.issueGithub);
  }

  issueReconcile(limit?: number): Promise<IssueReconcileResponse> {
    return this.call("GET", `${path.issueReconcile}${queryString({ limit })}`);
  }

  itemLink(id: string, body: ItemLinkRequest): Promise<ItemLinkResponse> {
    return this.call("POST", path.links(id), body);
  }

  editItem(id: string, body: EditItemRequest): Promise<EditItemResponse> {
    return this.call("POST", path.edit(id), body);
  }

  deleteItem(id: string): Promise<DeleteItemResponse> {
    return this.call("DELETE", path.item(id));
  }

  today(body: TodayRequest): Promise<TodayResponse> {
    return this.call("POST", path.today, body);
  }

  focus(): Promise<FocusResponse> {
    return this.call("GET", path.focus);
  }

  focusSet(body: FocusRequest): Promise<FocusResponse> {
    return this.call("POST", path.focus, body);
  }

  // --- the triage inbox (375) ------------------------------------------------------------------------

  triage(): Promise<TriageResponse> {
    return this.call("GET", path.triage);
  }

  triageClear(id: string): Promise<TriageActionResponse> {
    return this.call("POST", path.triageClear(id));
  }

  triageReject(id: string): Promise<TrackerMoveResponse> {
    return this.call("POST", path.triageReject(id));
  }

  // --- ingested WhatsApp (366) -----------------------------------------------------------------------
  //
  // Ingested messages, then the rest of `ob whatsapp` (OB-1809). `sync` is a host job; `bridge` is never served.

  whatsappSearch(q: string, limit?: number): Promise<WhatsappSearchResponse> {
    return this.call("GET", `${path.whatsappSearch}${queryString({ q, limit })}`);
  }

  whatsappRecent(query: { limit?: number; since?: string } = {}): Promise<WhatsappRecentResponse> {
    return this.call("GET", `${path.whatsappRecent}${queryString({ limit: query.limit, since: query.since })}`);
  }

  /** Never retried: a send that timed out may still have gone. The caller has already asked the human. */
  whatsappSend(body: WhatsappSendRequest): Promise<WhatsappSendResponse> {
    return this.call("POST", path.whatsappSend, body);
  }

  whatsappPref(body: WhatsappPrefRequest): Promise<WhatsappPrefResponse> {
    return this.call("POST", path.whatsappPrefs, body);
  }

  whatsappPrefChats(list: "hidden" | "favorites"): Promise<WhatsappPrefChatsResponse> {
    return this.call("GET", `${path.whatsappPrefs}/${list}`);
  }

  // --- ingested Gmail + Calendar (415) ----------------------------------------------------------------
  //
  // Store reads plus sync ON THE HOST. `ob google auth` never reaches these (420: persist is POST /secrets);
  // `ob google auth-url` (1305) is its own endpoint, above.

  gmailSearch(q: string, limit?: number): Promise<GmailSearchResponse> {
    return this.call("GET", `${path.gmailSearch}${queryString({ q, limit })}`);
  }

  gmailList(query: { limit?: number; since?: string } = {}): Promise<GmailListResponse> {
    return this.call("GET", `${path.gmailList}${queryString({ limit: query.limit, since: query.since })}`);
  }

  gmailSync(body: GmailSyncRequest = {}): Promise<GmailSyncResponse> {
    return this.call("POST", path.gmailSync, body);
  }

  /** 1680: read one message (headers, text, attachment list) on the host. Read-only. */
  gmailMessage(id: string): Promise<GmailMessageResponse> {
    return this.call("GET", path.gmailMessage(id));
  }

  /** 1680: a message's attachments with their bytes (`name` picks one); the caller writes the files. */
  gmailAttachments(id: string, name?: string): Promise<GmailAttachmentsResponse> {
    return this.call("GET", `${path.gmailAttachments(id)}${queryString({ name })}`);
  }

  /** 1757: create a Gmail DRAFT on the host. Never sends. */
  gmailDraftCreate(body: GmailDraftCreateRequest): Promise<GmailDraftResponse> {
    return this.call("POST", path.gmailDrafts, body);
  }

  gmailDraftShow(id: string): Promise<GmailDraftResponse> {
    return this.call("GET", path.gmailDraft(id));
  }

  /** OB-1750: the newest drafts. Reads only. */
  gmailDraftList(limit?: number): Promise<GmailDraftListResponse> {
    return this.call("GET", `${path.gmailDrafts}${queryString({ limit })}`);
  }

  /** OB-1750: edit a draft in place. Never sends. */
  gmailDraftEdit(id: string, body: GmailDraftEditRequest): Promise<GmailDraftResponse> {
    return this.call("POST", path.gmailEditDraft(id), body);
  }

  /** OB-1750: delete a draft outright. The `confirm: true` literal is the type: there is no unconfirmed call. */
  gmailDraftDelete(id: string, opts: { confirm: true }): Promise<GmailDraftDeleteResponse> {
    return this.call("DELETE", `${path.gmailDraft(id)}${queryString({ confirm: opts.confirm ? "true" : undefined })}`);
  }

  /** 1757: send an EXISTING draft. The `confirm: true` literal is the type: there is no unconfirmed call. */
  gmailSendDraft(id: string, body: GmailSendDraftRequest): Promise<GmailSendDraftResponse> {
    return this.call("POST", path.gmailSendDraft(id), body);
  }

  calAgenda(): Promise<AgendaResponse> {
    return this.call("GET", path.calAgenda);
  }

  calSync(body: CalSyncRequest = {}): Promise<CalSyncResponse> {
    return this.call("POST", path.calSync, body);
  }

	// --- the spinoff queue (360) ----------------------------------------------------------------------
	//
	// The DATA half of `ob spinoff`. Nothing below opens a tab, creates a worktree or probes a process
	// table: those happen on this machine, in the client handler, between the claim and the stamp.

	spinoffConfig(): Promise<SpinoffConfigResponse> {
		return this.call("GET", path.spinoffConfig);
	}

	spinoffs(query: SpinoffsQuery): Promise<SpinoffsResponse> {
		return this.call("GET", `${path.spinoffs}${queryString({ status: query.status })}`);
	}

	/** 1226: the rows that SERVE one item — an id in the BODY, never in the url (357). */
	spinoffServing(body: SpinoffServingRequest): Promise<SpinoffsResponse> {
		return this.call("POST", path.spinoffServing, body);
	}

	/** OB-2131: the planned files of each row's ticket's newest go check. */
	spinoffPlannedFiles(body: SpinoffPlannedFilesRequest): Promise<SpinoffPlannedFilesResponse> {
		return this.call("POST", path.spinoffPlannedFiles, body);
	}

	/** OB-1825: record a measure-twice verdict. The server computes it. */
	spinoffCheck(body: SpinoffCheckRequest): Promise<SpinoffCheckResponse> {
		return this.call("POST", path.spinoffCheck, body);
	}

	enqueueSpinoff(body: EnqueueSpinoffRequest): Promise<EnqueueSpinoffResponse> {
		return this.call("POST", path.spinoffs, body);
	}

	spinoffLaunchable(body: LaunchableRequest): Promise<LaunchableResponse> {
		return this.call("POST", path.spinoffLaunchable, body);
	}

	/** The exclusion (308): one conditional update on the server, so two drains cannot both win a row. */
	claimSpinoff(body: ClaimSpinoffRequest): Promise<ClaimSpinoffResponse> {
		return this.call("POST", path.spinoffClaim, body);
	}

	stampSpinoff(body: StampSpinoffRequest): Promise<StampSpinoffResponse> {
		return this.call("POST", path.spinoffStamp, body);
	}

	landSpinoff(body: LandSpinoffRequest): Promise<LandSpinoffResponse> {
		return this.call("POST", path.spinoffLand, body);
	}

	recordSpinoffTokens(body: RecordSpinoffTokensRequest): Promise<RecordSpinoffTokensResponse> {
		return this.call("POST", path.spinoffTokens, body);
	}

	readySpinoff(body: ReadySpinoffRequest): Promise<ReadySpinoffResponse> {
		return this.call("POST", path.spinoffReady, body);
	}

	sendBackSpinoff(body: SendBackSpinoffRequest): Promise<SendBackSpinoffResponse> {
		return this.call("POST", path.spinoffSendBack, body);
	}

	/** OB-2180: a landed row back to building. */
	reopenSpinoff(body: ReopenSpinoffRequest): Promise<ReopenSpinoffResponse> {
		return this.call("POST", path.spinoffReopen, body);
	}

	recordSpinoffVerdict(body: SpinoffVerdictRequest): Promise<SpinoffVerdictResponse> {
		return this.call("POST", path.spinoffVerdict, body);
	}

	/** OB-2172: record (failed) or clear (sent) a row's readying-note failure. */
	recordSpinoffNoteError(body: SpinoffNoteErrorRequest): Promise<SpinoffNoteErrorResponse> {
		return this.call("POST", path.spinoffNoteError, body);
	}

	/** OB-1991: one model-trial operation, run where the store is. */
	spinoffTrial(body: SpinoffTrialRequest): Promise<SpinoffTrialResponse> {
		return this.call("POST", path.spinoffTrial, body);
	}

	reclaimSpinoffs(): Promise<ReclaimSpinoffsResponse> {
		return this.call("POST", path.spinoffReclaim, {});
	}

	spinoffCleanupGuard(body: CleanupGuardRequest): Promise<CleanupGuardResponse> {
		return this.call("POST", path.spinoffCleanupGuard, body);
	}

	// --- 416: already-servable commands ----------------------------------------------------------------

	projects(): Promise<ProjectsResponse> {
		return this.call("GET", path.projects);
	}

	projectCreate(body: ProjectCreateRequest): Promise<ProjectCreateResponse> {
		return this.call("POST", path.projects, body);
	}

	projectEdit(name: string, body: ProjectEditRequest): Promise<ProjectEditResponse> {
		return this.call("POST", `${path.projects}/${encodeURIComponent(name)}/edit`, body);
	}

	projectRename(name: string, body: ProjectRenameRequest): Promise<ProjectRenameResponse> {
		return this.call("POST", `${path.projects}/${encodeURIComponent(name)}/rename`, body);
	}

	projectRemove(name: string, force: boolean): Promise<ProjectRemoveResponse> {
		return this.call("DELETE", `${path.projects}/${encodeURIComponent(name)}${queryString({ force: force ? "true" : undefined })}`);
	}

	// --- OB-2255: teams ---

	teams(): Promise<TeamsResponse> {
		return this.call("GET", path.teams);
	}

	team(name: string): Promise<TeamResponse> {
		return this.call("GET", `${path.teams}/${encodeURIComponent(name)}`);
	}

	teamCreate(body: TeamCreateRequest): Promise<TeamResponse> {
		return this.call("POST", path.teams, body);
	}

	teamEdit(name: string, body: TeamEditRequest): Promise<TeamResponse> {
		return this.call("POST", `${path.teams}/${encodeURIComponent(name)}/edit`, body);
	}

	teamJoin(name: string, projects: string[]): Promise<TeamJoinResponse> {
		return this.call("POST", `${path.teams}/${encodeURIComponent(name)}/join`, { projects });
	}

	teamLeave(projects: string[]): Promise<TeamLeaveResponse> {
		return this.call("POST", `${path.teams}/leave`, { projects });
	}

	teamRemove(name: string, force: boolean): Promise<TeamRemoveResponse> {
		return this.call("DELETE", `${path.teams}/${encodeURIComponent(name)}${queryString({ force: force ? "true" : undefined })}`);
	}

	// --- OB-2257: team handoffs ---

	teamHandoffCreate(name: string, role: string, body: string, fromThreadId?: string | null): Promise<TeamHandoffResponse> {
		return this.call("POST", `${path.teams}/${encodeURIComponent(name)}/handoffs`, { role, body, ...(fromThreadId ? { from_thread_id: fromThreadId } : {}) });
	}

	teamHandoffLatest(name: string, role: string, filter: { from?: string | null; createdBefore?: string | null } = {}): Promise<TeamHandoffResponse> {
		const q = { role, ...(filter.from ? { from: filter.from } : {}), ...(filter.createdBefore ? { created_before: filter.createdBefore } : {}) };
		return this.call("GET", `${path.teams}/${encodeURIComponent(name)}/handoffs/latest${queryString(q)}`);
	}

	teamHandoffConsume(name: string, id: number, newThreadId: string): Promise<TeamHandoffResponse> {
		return this.call("POST", `${path.teams}/${encodeURIComponent(name)}/handoffs/${id}/consume`, { new_thread_id: newThreadId });
	}

	brief(query: { q?: string; in_flight?: boolean } = {}): Promise<BriefResponse> {
		return this.call("GET", `${path.brief}${queryString({ q: query.q, in_flight: query.in_flight === true ? "true" : undefined })}`);
	}

	logList(query: { type?: string; since?: string } = {}): Promise<LogListResponse> {
		return this.call("GET", `${path.log}${queryString({ type: query.type, since: query.since })}`);
	}

	logCreate(body: LogCreateRequest): Promise<LogCreateResponse> {
		return this.call("POST", path.log, body);
	}

	jobs(): Promise<JobsResponse> {
		return this.call("GET", path.jobs);
	}

	hostJobStart(req: HostJobRequest): Promise<HostJobResponse> {
		return this.call("POST", path.hostJobs, req);
	}

	hostJobList(): Promise<HostJobsResponse> {
		return this.call("GET", path.hostJobs);
	}

	hostJob(id: string): Promise<HostJobResponse> {
		return this.call("GET", `${path.hostJobs}/${encodeURIComponent(id)}`);
	}

	dbSnapshotFetch(name: string, dest: string): Promise<number> {
		return this.download(`/db/snapshots/${encodeURIComponent(name)}`, dest);
	}

	deploys(): Promise<DeploysResponse> {
		return this.call("GET", path.deploys);
	}

	deployRecord(body: DeployRecordRequest): Promise<DeployRecordResponse> {
		return this.call("POST", path.deploys, body);
	}

	deployRun(body: DeployRunRequest): Promise<DeployRunResponse> {
		return this.call("POST", path.deployRun, body);
	}

	alerts(): Promise<AlertsResponse> {
		return this.call("GET", path.alerts);
	}

	alertsSnooze(key: string): Promise<AlertSnoozeResponse> {
		return this.call("POST", path.alertsSnooze, { key });
	}

	docs(project?: string): Promise<DocsResponse> {
		return this.call("GET", `${path.docs}${queryString({ project })}`);
	}

	doc(id: string): Promise<DocResponse> {
		return this.call("GET", path.doc(id));
	}

	docCreate(body: DocCreateRequest): Promise<DocResponse> {
		return this.call("POST", path.docs, body);
	}

	docSet(id: string, body: DocSetRequest): Promise<DocResponse> {
		return this.call("POST", path.docSet(id), body);
	}

	decisions(status?: string): Promise<DecisionsResponse> {
		return this.call("GET", `${path.decisions}${queryString({ status })}`);
	}

	decision(id: string): Promise<DecisionShowResponse> {
		return this.call("GET", path.decision(id));
	}

	decisionSupersede(body: DecisionSupersedeRequest): Promise<DecisionSupersedeResponse> {
		return this.call("POST", path.decisionSupersede, body);
	}

	learnings(status?: string): Promise<LearningsResponse> {
		return this.call("GET", `${path.learnings}${queryString({ status })}`);
	}

	learning(id: string): Promise<LearningShowResponse> {
		return this.call("GET", path.learning(id));
	}

	roadmaps(): Promise<RoadmapsResponse> {
		return this.call("GET", path.roadmaps);
	}

	roadmap(id: string): Promise<RoadmapShowResponse> {
		return this.call("GET", path.roadmap(id));
	}

	roadmapAddMember(roadmapId: string, body: RoadmapAddMemberRequest): Promise<RoadmapAddMemberResponse> {
		return this.call("POST", path.roadmapMembers(roadmapId), body);
	}

	standupLatest(): Promise<StandupLatestResponse> {
		return this.call("GET", path.standupLatest);
	}

	standupSave(body: StandupWriteRequest): Promise<StandupWriteResponse> {
		return this.call("POST", path.standupSave, body);
	}

	standupSet(body: StandupWriteRequest): Promise<StandupWriteResponse> {
		return this.call("POST", path.standupSet, body);
	}

	standupPosted(date?: string): Promise<StandupPostedResponse> {
		return this.call("POST", path.standupPosted, date ? { date } : {});
	}

	slackUnread(limit?: number): Promise<SlackUnreadResponse> {
		return this.call("GET", `${path.slackUnread}${queryString({ limit })}`);
	}

	people(): Promise<PeopleResponse> {
		return this.call("GET", path.people);
	}
	peopleCreate(body: PersonCreateRequest): Promise<PersonCreateResponse> {
		return this.call("POST", path.people, body);
	}
	peopleShow(q: string, reveal?: boolean): Promise<PersonShowResponse> {
		return this.call("GET", `${path.peopleShow}${queryString({ q, reveal: reveal === true ? "true" : undefined })}`);
	}
	peopleSet(body: PersonSetRequest): Promise<PersonSetResponse> {
		return this.call("POST", path.peopleSet, body);
	}
	peopleRm(body: PersonRmRequest): Promise<PersonRmResponse> {
		return this.call("POST", path.peopleRm, body);
	}
	whois(handle: string): Promise<WhoisResponse> {
		return this.call("GET", `${path.whois}${queryString({ handle })}`);
	}
	// --- OB-2276: CI on main and the GitHub hooks ---
	ciMain(query: { project?: string } = {}): Promise<CiMainResponse> {
		return this.call("GET", `${path.ciMain}${queryString({ project: query.project })}`);
	}
	ciMainNotify(body: { project?: string | null }): Promise<CiMainNotifyResponse> {
		return this.call("POST", path.ciMainNotify, body);
	}
	githubHooks(apply: boolean): Promise<GithubHooksResponse> {
		return apply ? this.call("POST", path.githubHooks, {}) : this.call("GET", path.githubHooks);
	}
	// --- OB-2271: persona tournaments ---
	tournamentList(query: { repo?: string } = {}): Promise<TournamentListResponse> {
		return this.call("GET", `${path.tournaments}${queryString({ repo: query.repo })}`);
	}
	tournamentAdd(body: TournamentAddRequest): Promise<TournamentResponse> {
		return this.call("POST", path.tournaments, body);
	}
	tournamentShow(id: number): Promise<TournamentViewResponse> {
		return this.call("GET", `${path.tournaments}/${id}`);
	}
	tournamentCandidate(id: number, body: TournamentCandidateRequest): Promise<TournamentCandidateResponse> {
		return this.call("POST", `${path.tournaments}/${id}/candidates`, body);
	}
	tournamentRecord(id: number, body: TournamentRecordRequest): Promise<TournamentMatchResponse> {
		return this.call("POST", `${path.tournaments}/${id}/matches`, body);
	}
	tournamentPick(id: number, body: TournamentPickRequest): Promise<TournamentResponse> {
		return this.call("POST", `${path.tournaments}/${id}/pick`, body);
	}
	overnightStart(body: OvernightStartRequest): Promise<OvernightStartResponse> {
		return this.call("POST", path.overnightStart, body);
	}
	overnightDecide(body: OvernightDecideRequest): Promise<OvernightDecisionResponse> {
		return this.call("POST", path.overnightDecide, body);
	}
	overnightSummary(body: OvernightSummaryRequest): Promise<OvernightRunResponse> {
		return this.call("POST", path.overnightSummary, body);
	}
	overnightShow(body: OvernightShowRequest): Promise<OvernightNightResponse> {
		return this.call("POST", path.overnightShow, body);
	}
	overnightRuns(query: { project?: string; since?: string } = {}): Promise<OvernightRunsResponse> {
		return this.call("GET", `${path.overnightRuns}${queryString({ project: query.project, since: query.since })}`);
	}
	reviewMissAdd(body: ReviewMissAddRequest): Promise<ReviewMissAddResponse> {
		return this.call("POST", path.reviewMisses, body);
	}
	reviewMissTop(query: { scope?: string; limit?: number } = {}): Promise<ReviewMissTopResponse> {
		return this.call("GET", `${path.reviewMissesTop}${queryString(query)}`);
	}
	cursorGet(skill: string, key: string): Promise<CursorGetResponse> {
		return this.call("GET", `${path.cursors}${queryString({ skill, key })}`);
	}
	cursorSet(body: CursorSetRequest): Promise<CursorSetResponse> {
		return this.call("POST", path.cursors, body);
	}
	testUsers(query: { role?: string; env?: string } = {}): Promise<TestUsersResponse> {
		return this.call("GET", `${path.testUsers}${queryString(query)}`);
	}
	testUserCreate(body: TestUserCreateRequest): Promise<TestUserCreateResponse> {
		return this.call("POST", path.testUsers, body, [body.value]);
	}
	testUserShow(label: string): Promise<TestUserShowResponse> {
		return this.call("GET", `${path.testUsersShow}${queryString({ label })}`);
	}
	testUserCheck(body: TestUserCheckRequest): Promise<TestUserCheckResponse> {
		return this.call("POST", path.testUsersCheck, body);
	}
	sync(body: SyncRequest = {}): Promise<SyncResponse> {
		return this.call("POST", path.sync, body);
	}
}

// ob 353: the working loop, run against ob 352's API instead of against a database.
//
// Each handler here is the CLIENT half of a command whose data half is an endpoint. It parses the argv it
// was given, resolves the facts that are about THIS MACHINE (the cwd's git remote, the checkout's branch),
// makes ONE typed call, and renders the answer with the same pure renderer the local command uses.
//
// (The server's handlers live in `handlers.ts` beside this. Same directory, opposite ends of one wire.)
//
// A flag whose meaning has no endpoint behind it REFUSES BY NAME rather than being dropped: `ob add
// --issue` needs the server's GitHub credential path, `ob tag --repo` also edits the project, `--dry-run`
// previews a mirror the server does not offer. Silently ignoring any of those would be the ob 237 failure
// in miniature -- a command that ran, exited 0, and did not do what it said.
//
// There is no database here and no fallback to one. An unreachable API is an error (map decision D2).
import { stageIn } from "../stage.ts";
import { checkoutOf, runRole, runTeam, t3SubcommandReads, type TeamBackend } from "../commands/t3-team.ts";
import { AppError, UsageError } from "../errors.ts";
import { emitId, print, printRaw, renderItems, warn, type Mode } from "../output.ts";
import { handleMemory } from "../memory.ts";
import type { Flags } from "../ctx.ts";
import { parsePriority, priorityName, PRIORITY_OPTIONS } from "../priority.ts";
import { orderMoveFromFlags } from "../commands/focus.ts";
import { VALID_TYPES } from "../status.ts";
import { triageBanner } from "../commands/triage.ts";
import { runWiki, type WikiCtx } from "../commands/wiki.ts";
import { mirrorDriftWarning, renderIssueSync } from "../commands/state.ts";
import { renderStatusReport, statusJson, attachT3Threads, type StatusReport } from "../commands/status.ts";
import { apiT3RowSource } from "../t3/read.ts";
import { titleSyncWarning } from "../t3/dispatch.ts";
import { agentNoteText } from "../../../../platform/cli-coord/src/spinoff-state-reason.ts";
import { failedChecks, renderCredentialChecks, renderCredentialInventory } from "../commands/creds.ts";
import { renderSecretList } from "../commands/secret.ts";
import { confirmWhatsappSend, renderHits } from "../../../../platform/cli-whatsapp/src/commands/whatsapp.ts";
import { describeAttachment, MAYBE_ALREADY_GONE_TAIL, partialSendMessage } from "../../../../platform/cli-whatsapp/src/whatsapp/send.ts";
import {
	draftEditFromFlags,
	draftIdArg,
	draftRequestFromFlags,
	GMAIL_SUBS,
	messageIdArg,
	refuseUnconfirmed,
	confirmedSendHash,
	refuseUnconfirmedDelete,
	renderCreatedDraft,
	renderDeleted,
	renderDraftList,
	renderEditedDraft,
	renderHits as renderEmailHits,
	renderRead,
	renderSent,
	saveFetchedAttachments,
	sendDraftId,
} from "../../../../platform/cli-sources/src/commands/gmail.ts";
import { renderAgenda } from "../../../../platform/cli-sources/src/commands/calendar.ts";
import {
	API_CLIENT_CREDS_USAGE,
	clientCredsFromStoredGoogleJson,
	resolveClientCredsFromFlags,
	runGoogleAuth,
	type ClientCreds,
	type GoogleAuthDeps,
} from "../../../../platform/cli-sources/src/commands/google.ts";
import { mergeGoogleToken, previousGoogleToken, type GoogleToken } from "../../../../platform/cli-sources/src/google.ts";
import { parseProjectLabel, parseProjectPatch, projectRepoPrivate, renderProjectList } from "../commands/admin.ts";
import { briefQuiet, renderBrief, type AnyBrief } from "../commands/brief.ts";
import { isJournalType, JOURNAL_TYPES, renderJournalCapture, renderJournalList } from "../commands/log.ts";
import { renderJobs } from "../commands/jobs.ts";
import {
	DEPLOY_RESULTS,
	DEPLOY_SHA_RE,
	LIVE_DEPLOY_TARGET,
	defaultLiveDeploySsh,
	renderDeploys,
	runLiveDeploy,
} from "../commands/deploy.ts";
import { renderAlertDigest, renderAlerts } from "../commands/alerts.ts";
import { renderDecisionList } from "../commands/decision.ts";
import { bodyFromFlags, DOC_USAGE, emitDoc, emitDocHistory, emitDocList, emitDocWritten, pickVersion } from "../commands/doc.ts";
import { renderLearningList } from "../commands/learning.ts";
import { renderRoadmapList } from "../commands/roadmap.ts";
import { effectiveText } from "../commands/standup.ts";
import { renderSlackUnread } from "../commands/slack.ts";
import {
	personDisplay,
	personFieldsFromFlags,
	redactPerson,
	renderPersonList,
	renderPersonShow,
} from "../commands/person.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { expandHome } from "../net.ts";
import { CREDENTIAL_NAMES } from "../credentials.ts";
import { inferProjectSpec, originRepo } from "../project.ts";
import {
	computeDrift,
	landedIn,
	parseIssueArg,
	readRepoState,
	sameRepo,
	ticketRefMention,
	type CheckedRef,
	type LandedStoreFacts,
	type LinkedItem,
} from "../tracker-link.ts";
import { keyProblem } from "../refs.ts";
import {
	addReads,
	editReads,
	INFER_PROJECT_ERROR,
	refuseUnreadFlags,
	VALID_RELS,
} from "../commands/capture.ts";
import { renderDrift, renderLanded, renderReconcile, resolveTrackerCheckout, rivalRefNote } from "../commands/issue.ts";
import { AGENT_STATUSES, DEFAULT_AGENT_TTL_S, agentStateLabel, formatAgentsReset, parseAgentStatus } from "../../../../platform/cli-coord/src/agent.ts";
import {
	DEFAULT_LEASE_TTL_S,
	formatReacquiredLeases,
	formatNotHeld,
	LeaseExpiredError,
	leaseHolderId,
	normalizeLeaseResource,
	waitUntilAcquired,
	LeaseWaitSignalled,
} from "../../../../platform/cli-coord/src/lease.ts";
import { planLeaseRun, runUnderLease } from "../../../../platform/cli-coord/src/lease-run.ts";
import { leaseWaitTitle } from "../../../../platform/cli-coord/src/lease-wait-title.ts";
import { ApiError, usageOn400, type ApiClient } from "./client.ts";
import { apiBackup, apiCert, apiDb, apiJobs, apiWhatsappBridgeStatus, apiWhatsappSync, type HostJobWait } from "./host-job-client.ts";
import { KNOWN_SECRETS } from "../secrets.ts";
import { DEFAULTS } from "../settings.ts";
import { runCloudflare } from "../cloudflare.ts";
import { outcomeFrom, renderItemDetail } from "./render.ts";
import { apiAgentRegistry, apiHandoffTarget, apiSpinoff, launchConfig } from "./spinoff-client.ts";
import { WHATSAPP_PREF_ACTIONS, type AgentRequest, type CreateItemRequest, type ItemsQuery, type ObApiStateAction, type WhatsappPrefAction } from "./contract.ts";
// 1120: `ob t3` is SPLIT. A team's thread is opened HERE (this machine runs T3) and its registry row (the
// thread id that makes the command idempotent) goes over the API (OB-2255).
import { checkoutRootOf, dropQueuedReadyNotes, ownCloseLine, retiredCloseLine, splitOwnRows, renderLandReplyOutcome, renderSettleOutcome, renderStaleNoteOutcome, replyLandedToBuilders, settleThreadWithRetry, t3Seam, unjoinedSettleLine, worktreeRepoOf, type T3Seam } from "../t3/dispatch.ts";
import { isReadyableStatus, landCommitFor, parseJsonMap, resolveRepoIn, type SpinoffRow } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { readRowTokens, type TokenUsage } from "../../../../platform/cli-coord/src/spinoff-tokens.ts";
import { itemDispatchRefs, unresolvedRefWarning } from "../../../../platform/cli-coord/src/spinoff-item.ts";
import { homedir } from "node:os";
import type { Ctx } from "../ctx.ts";
import { machineIo, runPorts, type PortsIo } from "../ports.ts";
import { runReview } from "../commands/review.ts";
import { runTournament, type TournamentBackend } from "../commands/tournament.ts";
import { runCi, runGithub, type CiBackend, type CiCtx } from "../commands/ci.ts";
import { runOvernight, type OvernightBackend } from "../commands/overnight.ts";

export interface ApiCtx {
	client: ApiClient;
	mode: Mode;
	flags: Flags;
	args: string[];
	/** A non-zero exit WITHOUT the error path's stderr shape, exactly as Ctx.exit means locally. */
	exit?: number;
	/** The cwd every machine-fact is read relative to. Injected so a test never depends on where it ran. */
	cwd: string;
	/** git branch/worktree for `ob agent register`. Injected for the same reason. */
	git: (cwd: string) => { branch?: string; worktree?: string };
	/** 420: google-auth seams (loopback / exchange / openUrl). Tests inject; production uses the real ones. */
	googleAuth?: GoogleAuthDeps;
	/** ob 636: ssh seam for `ob deploy run`. Tests inject; production omits. */
	deploySsh?: (argv: readonly string[]) => { code: number };
	/** ob 1756: the fetch `ob cloudflare` uses. Tests inject; production omits (global fetch). */
	cloudflareFetch?: typeof fetch;
	/** OB-1808: how a client waits on a host job. Tests inject; production uses the real clock. */
	hostJobWait?: HostJobWait;
}

function str(flags: Flags, key: string): string | undefined {
	const v = (flags as unknown as Record<string, unknown>)[key];
	return typeof v === "string" ? v : undefined;
}

function requireId(ctx: ApiCtx, command: string): string {
	const id = ctx.args[0];
	if (!id) throw new UsageError(`${command} requires an <id>`);
	return id;
}

/**
 * A flag this client cannot honour over the API. It REFUSES rather than dropping it: the command did not
 * do what the flag said, and the caller has to be told that before the write, not after.
 */
function unsupported(what: string, why: string): never {
	throw new UsageError(
		[
			`${what} is not available through the ob API: ${why}.`,
			`  refusing rather than running the command without it, which would exit 0 having done something else.`,
			`  run it on the API host, where ob reaches the store directly.`,
		].join("\n"),
	);
}

// --- reads -------------------------------------------------------------------------------------------

async function apiNext(ctx: ApiCtx): Promise<void> {
	const project = ctx.flags.repo ?? ctx.flags.project;
	// The query string drops an empty value, which would print every project's queue; the local command errors.
	if (project === "") throw new AppError("no project '' (see: ob project list)");
	const res = await ctx.client.next(project);
	if (ctx.mode === "human" || ctx.mode === "table") {
		const banner = triageBanner(res.triage_count);
		if (banner) print(banner);
	}
	print(renderItems(res.items, ctx.mode));
}

async function apiList(ctx: ApiCtx): Promise<void> {
	const { flags } = ctx;
	if (flags.priority && parsePriority(flags.priority) === null) {
		throw new UsageError(`invalid --priority '${flags.priority}' (expected: ${PRIORITY_OPTIONS})`);
	}
	let limit: number | undefined;
	if (flags.limit) {
		limit = Number(flags.limit);
		if (!Number.isInteger(limit) || limit < 0) throw new UsageError(`invalid --limit '${flags.limit}'`);
	}
	const by = flags.by;
	if (by !== undefined && by !== "priority" && by !== "created" && by !== "updated") {
		throw new UsageError(`invalid --by '${by}' (expected: priority, created, updated)`);
	}
	const query: ItemsQuery = {
		open: flags.open,
		status: flags.status,
		type: flags.type,
		project: flags.repo ?? flags.project,
		team: flags.team,
		kind: flags.kind,
		tag: flags.tag ? flags.tag[flags.tag.length - 1] : undefined,
		since: flags.since,
		updated_after: flags["updated-after"],
		priority: flags.priority,
		by,
		limit,
	};
	const res = await ctx.client.items(query);
	print(renderItems(res.items, ctx.mode));
}

async function apiShow(ctx: ApiCtx): Promise<void> {
	const id = requireId(ctx, "show");
	const res = await ctx.client.item(id);
	print(renderItemDetail(res.item, ctx.mode));
}

async function apiSearch(ctx: ApiCtx): Promise<void> {
	const q = ctx.args.join(" ").trim();
	if (q.length === 0) throw new UsageError("search requires a <query>");
	const res = await ctx.client.search(q);
	print(renderItems(res.items, ctx.mode));
}

async function apiStatus(ctx: ApiCtx): Promise<void> {
	const res = await ctx.client.status();
	// The enrichment (the triage count, journal handles -> names) is built from reads
	// the endpoint does not carry yet, so the renderer degrades VISIBLY rather
	// than acquiring a wrong value. Every field it needs is optional for exactly this reason.
	const report = res.status as StatusReport;
	// 1124: T3 lives on THIS machine, not on the API host, so its thread block is read here -- from the
	// same rows the endpoint served (the client's own spinoff/agent reads) plus the local T3 server.
	await attachT3Threads(report, apiT3RowSource(ctx.client));
	print(ctx.mode === "json" ? statusJson(report) : renderStatusReport(report));
}

// --- writes ------------------------------------------------------------------------------------------

async function apiAdd(ctx: ApiCtx): Promise<void> {
	const type = ctx.flags.type ?? "task";
	// --kind is part of the store-side project resolution; POST /items does not carry it. Refuse it with the
	// reason (the house form for a flag with no endpoint), not as an unknown flag, because HELP lists it.
	if (ctx.flags.kind !== undefined) {
		unsupported(
			"'ob add --kind'",
			"the project's kind is resolved on the store side and POST /items does not carry it, so the item would be created without the kind you asked for",
		);
	}
	refuseUnreadFlags("ob add", ctx.flags, addReads(ctx.flags, type, "api"));
	const title = ctx.args[0];
	if (!title) throw new UsageError("add requires a <title>");
	// The file is read HERE, on this machine, before the wire: the server cannot see the caller's path.
	const text = bodyFromFlags(ctx.flags);
	if (!VALID_TYPES.includes(type)) {
		throw new UsageError(`invalid --type '${type}' (supported: ${VALID_TYPES.join(", ")})`);
	}
	if (ctx.flags.priority && parsePriority(ctx.flags.priority) === null) {
		throw new UsageError(`invalid --priority '${ctx.flags.priority}' (expected: ${PRIORITY_OPTIONS})`);
	}
	// 389: --issue creates the GitHub issue ON the API host (the credential lives there).
	// --link <url> is the ref-row URL, served on the same POST.
	if (type === "roadmap" || type === "decision" || type === "learning") {
		unsupported(
			`'ob add --type ${type}'`,
			"its detail row (the roadmap/decision/learning fields) is not part of POST /items yet, and creating the item without it would lose what you typed",
		);
	}
	const triage = !!ctx.flags.triage;
	// 243: infer from THIS machine's cwd before the wire. The API host's cwd is /opt/omnislash
	// (or the ob user's home), so inference there always fails or guesses the wrong project.
	// An explicit --project/--repo is already machine-independent and passes through untouched.
	const explicit = ctx.flags.repo ?? ctx.flags.project ?? null;
	let project = explicit;
	if (!project) {
		const spec = inferProjectSpec(ctx.cwd);
		if (!spec) throw new UsageError(INFER_PROJECT_ERROR);
		project = spec.name;
	}
	const body: CreateItemRequest = {
		type,
		title,
		body: text ?? null,
		project,
		priority: ctx.flags.priority ?? null,
		tags: ctx.flags.tag,
		triage,
		// A fact about the cwd, which the server cannot see.
		origin_repo: triage ? (ctx.flags.from ?? originRepo(ctx.cwd)) : null,
		issue: ctx.flags.issue === true,
		map: ctx.flags.map ?? null,
		exec: ctx.flags.exec ?? null,
		link_url: ctx.flags.issue ? null : (ctx.flags.link ?? null),
	};
	const res = await ctx.client.createItem(body);
	if (res.issue) {
		const ref = res.item?.ref ?? null;
		if (ctx.mode === "json") print(JSON.stringify({ id: res.id, ...(ref ? { ref } : {}), issue: res.issue.number, url: res.issue.url }));
		else if (ctx.mode === "quiet") print(ref ?? res.id);
		else print(`${ref ?? res.id}  → issue #${res.issue.number} ${res.issue.url}`);
		return;
	}
	emitId(ctx, res.id, res.item?.ref);
}

async function apiLink(ctx: ApiCtx): Promise<void> {
	const [from, rel, to] = ctx.args;
	if (!from || !rel || !to) throw new UsageError("link requires <id> <rel> <other-id>");
	if (!VALID_RELS.includes(rel)) {
		throw new UsageError(`invalid rel '${rel}' (expected: ${VALID_RELS.join(", ")})`);
	}
	const res = await ctx.client.itemLink(from, { rel, to });
	emitId(ctx, res.id, res.ref);
}

async function apiEdit(ctx: ApiCtx): Promise<void> {
	refuseUnreadFlags("ob edit", ctx.flags, editReads(ctx.flags, "api"));
	const id = requireId(ctx, "edit");
	if (ctx.flags.priority && parsePriority(ctx.flags.priority) === null) {
		throw new UsageError(`invalid --priority '${ctx.flags.priority}' (expected: ${PRIORITY_OPTIONS})`);
	}
	const text = bodyFromFlags(ctx.flags);
	const res = await ctx.client.editItem(id, {
		title: ctx.flags.title,
		body: text,
		priority: ctx.flags.priority,
		project: ctx.flags.repo ?? ctx.flags.project,
	});
	emitId(ctx, res.id, res.ref);
}

async function apiRm(ctx: ApiCtx): Promise<void> {
	const id = requireId(ctx, "rm");
	const res = await ctx.client.deleteItem(id);
	emitId(ctx, res.id, res.ref);
}

async function apiToday(ctx: ApiCtx): Promise<void> {
	const id = ctx.args[0];
	if (ctx.flags.clear && !id) {
		await ctx.client.today({ clear: true });
		print("cleared today");
		return;
	}
	if (!id) throw new UsageError("today requires an <id> (or --clear)");
	if (ctx.flags.clear) {
		const res = await ctx.client.today({ id, clear: true });
		emitId(ctx, res.id ?? id, res.ref);
		return;
	}
	let rank: number | undefined;
	if (ctx.flags.rank !== undefined) {
		const n = Number(ctx.flags.rank);
		if (!Number.isInteger(n)) throw new UsageError(`invalid --rank '${ctx.flags.rank}'`);
		rank = n;
	}
	const res = await ctx.client.today({ id, rank });
	emitId(ctx, res.id ?? id, res.ref);
}

async function apiOrder(ctx: ApiCtx): Promise<void> {
	const id = requireId(ctx, "order");
	const move = orderMoveFromFlags(ctx.flags);
	const res = await ctx.client.order(id, {
		top: "top" in move ? true : undefined,
		priority: "top" in move && move.priority !== undefined ? priorityName(move.priority) : undefined,
		before: "before" in move ? move.before : undefined,
		after: "after" in move ? move.after : undefined,
	});
	const ref = res.item.ref ?? res.item.id;
	if (ctx.mode === "json") {
		print(JSON.stringify({ id: res.item.id, ...(res.item.ref ? { ref: res.item.ref } : {}), ...res.order }));
	} else if (ctx.mode === "quiet") print(ref);
	else print(`${ref}  queue rank ${res.order.rank} in ${res.order.priority}${res.order.priority_changed ? " (priority changed)" : ""}`);
}

async function apiFocus(ctx: ApiCtx): Promise<void> {
	if (ctx.flags.clear) {
		await ctx.client.focusSet({ clear: true });
		if (ctx.mode === "json") print(JSON.stringify({ focus_project: null, cleared: true }));
		else print("cleared focus");
		return;
	}
	const name = ctx.args[0];
	if (!name) {
		const res = await ctx.client.focus();
		if (ctx.mode === "json") print(JSON.stringify({ focus_project: res.focus_project ?? null }));
		else print(res.focus_project ?? "");
		return;
	}
	const res = await ctx.client.focusSet({ project: name });
	if (ctx.mode === "json") print(JSON.stringify({ focus_project: res.focus_project }));
	else print(res.focus_project ?? "");
}

async function apiNote(ctx: ApiCtx): Promise<void> {
	const id = ctx.args[0];
	const text = ctx.args.slice(1).join(" ");
	if (!id || text.length === 0) throw new UsageError("note requires <id> <text>");
	const res = await ctx.client.note(id, { text });
	emitId(ctx, res.id, res.ref);
}

async function apiTag(ctx: ApiCtx): Promise<void> {
	const id = ctx.args[0];
	const tags = ctx.args.slice(1);
	if (!id || tags.length === 0) throw new UsageError("tag requires <id> <tag>...");
	if (ctx.flags.repo !== undefined || ctx.flags.project !== undefined) {
		unsupported("'ob tag --repo/--project'", "it also MOVES the item to that project, and POST /items/:id/tags only tags");
	}
	const res = await ctx.client.tags(id, { add: tags });
	emitId(ctx, res.id, res.ref);
}

async function apiUntag(ctx: ApiCtx): Promise<void> {
	const id = ctx.args[0];
	const tags = ctx.args.slice(1);
	if (!id || tags.length === 0) throw new UsageError("untag requires <id> <tag>...");
	const res = await ctx.client.tags(id, { remove: tags });
	emitId(ctx, res.id, res.ref);
}

/** A landing verb and its GitHub mirror, rendered from the outcome the server reports. */
function emitMove(ctx: ApiCtx, id: string, want: "closed" | "open", res: Parameters<typeof outcomeFrom>[0]): void {
	const outcome = outcomeFrom(res);
	print(renderIssueSync(res.id ?? id, outcome, want, ctx.mode, res.ref));
	const drift = mirrorDriftWarning(id, outcome, want);
	if (drift) {
		warn(drift);
		ctx.exit = 1;
	}
}

/**
 * OB-1993: the close is the land (1589), and a land records the builder's tokens. Those live in THIS machine's
 * transcripts (or opencode DB), never on the API host, so the client asks which rows serve the item, reads each
 * one the close will land (building or handed-off) and sends the counts with the close. Best effort: a read
 * that fails sends nothing, and the server reads as it always did.
 */
async function closeTokensById(ctx: ApiCtx, itemId: string): Promise<Record<number, TokenUsage>> {
	const out: Record<number, TokenUsage> = {};
	try {
		const res = await ctx.client.spinoffServing({ item_id: itemId });
		for (const row of res.spinoffs) if (isReadyableStatus(row.status)) out[row.id] = readRowTokens(row);
	} catch (e) {
		// An older host (no serving route) is silent; anything else is named, since the land then reads on the server.
		if (!(e instanceof ApiError && e.status === 404)) warn(`spinoff: ${itemId}: token counts not read here (${(e as Error).message}); the land records what the server reads`);
	}
	return out;
}

function refuseDryRun(ctx: ApiCtx, command: string): void {
	if (ctx.flags["dry-run"]) {
		unsupported(`'ob ${command} --dry-run'`, "the API has no preview endpoint, and running it for real is not what --dry-run means");
	}
}

async function apiClose(ctx: ApiCtx): Promise<void> {
	const id = requireId(ctx, "close");
	refuseDryRun(ctx, "close");
	const tokensById = await closeTokensById(ctx, id);
	const res = await ctx.client.close(id, { github: ctx.flags["no-github"] ? false : undefined, note: ctx.flags.note, actor: ctx.flags.holder, tokensById });
	emitMove(ctx, id, "closed", res);
	// 1120: landing also retires the ticket's T3 threads, and T3 is on THIS machine, so the settle runs
	// here rather than on the host that performed the close. Best effort and loud: the close has already
	// happened, so a settle that cannot run is a warning, never a rollback.
	await settleClosedTicketThreads(ctx, id);
}

/**
 * Settle every T3 thread this ticket's spinoff rows opened (1120). The rows come over the API (they are
 * tracker data); the threads are settled here, because this is the machine with the T3 server.
 *
 * WHICH ROWS SERVE THE CLOSED ITEM IS DECIDED WHERE THE STORE IS (1163, 1226): this machine has no
 * database, and the decision turns on evidence only the tracker holds — namely whether some item's record
 * NAMES the row's ref as a ticket path, which is what stops a ref that collides with another item's id
 * (ref "1133": the readying-note ticket, whose mirror is item 1135) from joining that item's rows. So the
 * join is asked for in one read (`POST /spinoffs/serving`, the item id in the BODY — 357) rather than
 * re-derived here, and every send and every settle below still runs HERE, where T3 is.
 *
 * Nothing is asked of T3 when the ticket has no `t3` rows, and nothing else is asked of the API until the
 * one read shows there is nothing to settle: that is the only case that reads the row table again (has
 * this machine ever launched anything?) and the item's own record (which refs it answers to).
 */
async function settleClosedTicketThreads(ctx: ApiCtx, itemId: string): Promise<void> {
	let mine: SpinoffRow[];
	let unresolved = 0;
	try {
		const res = await ctx.client.spinoffServing({ item_id: itemId });
		mine = res.spinoffs;
		unresolved = res.unresolved?.length ?? 0;
		// 1226: a row the SERVER could not settle (a ref two items both name, or a failed read here) is
		// named. Its thread is left alone on purpose, and silence would let that read as "nothing to settle".
		for (const row of res.unresolved ?? []) warn(unresolvedRefWarning(itemId, row));
	} catch (err) {
		// 1205: a resolution that FAILED must not throw away the rows it can still vouch for — and 1226
		// decides WHICH those are. A row's record is trustworthy here exactly when a RESOLUTION chose it:
		// dispatch stamps the ref ITSELF only when no item names `wayfinder/tickets/<ref>-…`, so
		// `item_id !== ticket_ref` is path evidence while `item_id === ticket_ref` may be the old bare-id
		// stamp — the collision this ticket fixes, on the one path that cannot check it. Acting on that
		// would re-bind row 595 to the strip's item and tell the readying-note builder it had landed, which
		// is the outcome the pinned acceptance forbids; a MISSED settle, by contrast, self-heals on the next
		// close (and in 3 days without one). So the unchecked rows are left ALONE and named — never acted on
		// and never dropped in silence.
		try {
			const rows = (await ctx.client.spinoffs({})).spinoffs;
			mine = rows.filter((row) => row.item_id === itemId && row.item_id !== row.ticket_ref);
			const legacy = rows.filter((row) => row.item_id == null).length;
			const coincidence = rows.filter((row) => row.item_id === itemId && row.item_id === row.ticket_ref).length;
			unresolved = legacy + coincidence;
			warn(
				`t3: ${itemId} closed, but the rows that serve it could not be resolved (${(err as Error).message}), so ${unresolved} row${unresolved === 1 ? "" : "s"} could not be confirmed and ${unresolved === 1 ? "was" : "were"} left alone (${legacy} recording no item, ${coincidence} whose ref is also its own id)`,
			);
		} catch (err2) {
			warn(`t3: ${itemId} closed, but its T3 threads were not settled: ${(err2 as Error).message}`);
			return;
		}
	}
	// 1205: FIRST, and before anything that can wait or return early. A readying note STILL HELD by the
	// architect's thread for a row this land just retired was queued with `mode: queue`, so T3 delivers it
	// when the architect's turn ends: minutes AFTER the land it announces. The withdrawal depends on the
	// ARCHITECT's thread, never on a builder's, so it must not sit behind the no-thread-id return below (the
	// 1142 field-drop case) nor behind the land reply's own bounded wait (up to 30s), which is a window a
	// architect can end its turn inside. Same rows the serving read returned, and a legacy row (no `item_id`)
	// is IN them: the server resolved its ref where the store is (1226), which is the read this machine
	// cannot make — 1205's "a stamped row plus a legacy one is a real fleet mid-migration" is now the join's
	// own answer rather than a second arm bolted onto a string match.
	// OB-1670 (#80): a builder closing its own ticket from its own worktree keeps its own row out of the
	// land reply and the settle (`splitOwnRows`); its stale handoff note is withdrawn with the rest (1205).
	const { own, others, retired } = splitOwnRows(mine, checkoutRootOf());
	for (const row of own) if (ctx.mode === "human") print(ownCloseLine(itemId, row));
	for (const row of retired) if (ctx.mode === "human") print(retiredCloseLine(itemId, row));
	await withdrawHeldReadyNotes(ctx, itemId, mine);
	const threadIds = others.map((r) => r.t3_thread_id).filter((id): id is string => !!id);
	if (threadIds.length === 0) {
		// A no-op that reports itself (1163) — the line this fix exists to add. Null when silence is right:
		// no thread was ever launched here, or the item's record names no other ref (never dispatched). And
		// never alongside an unresolved candidate (1226): "no spinoff row serves it" would contradict it.
		if (mine.length > 0 || unresolved > 0) return;
		let anyThreads = false;
		try {
			const rows = (await ctx.client.spinoffs({})).spinoffs;
			anyThreads = rows.some((r) => r.t3_thread_id);
			const item = (await ctx.client.item(itemId)).item;
			const line = unjoinedSettleLine(itemId, itemDispatchRefs({ id: itemId, body: item.body }), anyThreads);
			if (line) warn(line);
		} catch (err) {
			// A read that FAILED is its own fact, not "this ticket has no rows": folding it into the no-op
			// line would be the same silent join this change exists to remove, so it is named instead. A
			// machine that has never launched anything has nothing to be told, and stays quiet.
			if (anyThreads) {
				warn(`t3: ${itemId} closed, but its spinoff rows could not be joined to it: ${(err as Error).message}`);
			}
		}
		return;
	}
	// 1133: the land, announced back, BEFORE the settle, and to the SAME rows 1163 just joined. Measured on
	// the pinned build: a delivered message RE-ACTIVATES a thread, so a settle that runs first is undone by
	// the reply; and the reply waits (bounded) for its own turn to end, which is what lets the settle below
	// stick. A row with no recorded thread id is a named skip; a failed send is a warning, never a rollback
	// and never an exit code — this path's exit 1 means the GitHub mirror drifted, and a notifier is not a
	// gate.
	try {
		const replies = await replyLandedToBuilders(others, itemId, {
			// The sha is looked up per ROW, through the row's own dispatch ref: a hand-charted ticket's row
			// carries the ref it was dispatched under (1124), while the closed item is its mirror (1134) — and
			// it is the dispatch ref the squash subject names.
			landShaFor: (row) => landCommitFor(worktreeRepoOf(row.worktree) ?? row.worktree, row.ticket_ref),
		});
		for (const reply of replies) {
			const rendered = renderLandReplyOutcome(reply);
			if (rendered.warning) warn(rendered.line);
			else if (ctx.mode === "human") print(rendered.line);
		}
	} catch (err) {
		warn(`t3: ${itemId} closed, but its builders were not told it landed: ${(err as Error).message}`);
	}
	// 1120/1133/1188: the settle, now that the land reply's own turn has ended. The retry inside
	// `settleThreadWithRetry` is what makes a re-activated builder that outlasts the reply's wait end up
	// settled in the SAME invocation instead of riding T3's 3-day auto-settle.
	let seam: T3Seam;
	try {
		seam = await t3Seam();
	} catch (err) {
		warn(`t3: ${itemId} closed, but its T3 threads were not settled: ${(err as Error).message}`);
		return;
	}
	for (const threadId of threadIds) {
		const settled = await settleThreadWithRetry(seam, threadId);
		const rendered = renderSettleOutcome({ ticket: itemId, threadId, ...settled });
		if (rendered.warning) warn(rendered.line);
		else if (ctx.mode === "human") print(rendered.line);
	}
}
/**
 * Withdraw the readying notes this land has made moot, from the rows the close already joined (1205).
 *
 * The architect's identity and its thread id come over the API (tracker data), while the QUEUE that holds
 * the note is read and withdrawn from HERE, where T3 is — the same split as the land reply above. Best
 * effort: the close stands whatever this does, and only a withdrawal or a failure says a word (the
 * ordinary land finds an empty architect queue, and `renderStaleNoteOutcome` prints nothing for that).
 */
async function withdrawHeldReadyNotes(ctx: ApiCtx, itemId: string, rows: SpinoffRow[]): Promise<void> {
	if (rows.length === 0) return;
	try {
		// OB-2255: the note went to the ticket's team's sentinel, else its architect, so it is withdrawn there.
		// The route is the ticket's, not the repo's, so it is read once.
		let route: ReturnType<typeof apiHandoffTarget> | null = null;
		const outcomes = await dropQueuedReadyNotes({
			rows,
			registry: apiAgentRegistry(ctx.client),
			targetFor: () => (route ??= apiHandoffTarget(ctx.client, { ticket_ref: itemId })),
		});
		for (const o of outcomes) {
			const rendered = renderStaleNoteOutcome(o);
			if (!rendered) continue;
			if (rendered.warning) warn(rendered.line);
			else if (ctx.mode === "human") print(rendered.line);
		}
	} catch (err) {
		warn(`t3: ${itemId} closed, but a queued readying note was not withdrawn: ${(err as Error).message}`);
	}
}

/** OB-2255: the API-backed `TeamBackend`: teams and role rows over the wire, the cwd's checkout resolved here. */
function apiTeamBackend(ctx: ApiCtx): TeamBackend {
	const { client } = ctx;
	const orNull = async <T>(run: () => Promise<T>): Promise<T | null> => {
		try {
			return await run();
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) return null;
			throw e;
		}
	};
	return {
		list: async () => (await client.teams()).teams,
		show: (name) => orNull(async () => (await client.team(name)).team),
		add: async (input) => (await client.teamCreate(input)).team,
		edit: (name, patch) => orNull(async () => (await client.teamEdit(name, patch)).team),
		join: (name, projects) => client.teamJoin(name, projects),
		leave: async (projects) => (await client.teamLeave(projects)).left,
		remove: (name, force) => client.teamRemove(name, force),
		dropRow: async (id) => (await client.agent({ action: "done", id, no_lease: true })).found,
		registry: apiAgentRegistry(client),
		cwdRepo: async () => {
			const cfg = launchConfig((await client.spinoffConfig()).config);
			const resolved = resolveRepoIn(cfg, checkoutOf(ctx.cwd), homedir());
			return worktreeRepoOf(resolved) ?? resolved;
		},
		projects: async () => (await client.projects()).projects,
		handoffRecord: async (team, role, body, from) => (await client.teamHandoffCreate(team, role, body, from)).handoff!,
		handoffLatest: async (team, role, filter) => (await client.teamHandoffLatest(team, role, filter)).handoff,
		handoffConsume: async (team, id, newThreadId) => {
			await client.teamHandoffConsume(team, id, newThreadId);
		},
	};
}

async function apiT3(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0] ?? "doctor";
	// OB-2255: an unread flag is refused by name before anything crosses the wire, as the local path does.
	refuseUnreadFlags(`ob t3 ${sub}`, ctx.flags, t3SubcommandReads(ctx.args));
	if (sub === "broadcast") {
		// OB-2187: the architect rows come over the API, the threads are read and sent to here, where T3 is.
		const { broadcastInput, emitBroadcast } = await import("../commands/t3.ts");
		const { broadcast } = await import("../t3/broadcast.ts");
		const { audience, text } = broadcastInput(ctx.args, ctx.flags);
		const rows = audience === "architects" ? (await ctx.client.agents(true)).agents : [];
		emitBroadcast(ctx, await broadcast({ audience, text, rows, dryRun: ctx.flags["dry-run"] === true }));
		return;
	}
	if (sub === "team") {
		await runTeam(ctx, apiTeamBackend(ctx));
		return;
	}
	if (sub === "architect" || sub === "sentinel" || sub === "muse") {
		await runRole(ctx, apiTeamBackend(ctx), sub);
		return;
	}
	const { unreachableDatabase, unreachableStore } = await import("./run.ts");
	const { cmdT3 } = await import("../commands/t3.ts");
	const { __setT3RowSource, apiT3RowSource } = await import("../t3/read.ts");
	const local: Ctx = {
		db: unreachableDatabase("t3"),
		store: unreachableStore("t3"),
		dbPath: "",
		mode: ctx.mode,
		flags: ctx.flags,
		args: ctx.args,
	};
	// 1124: the read subcommands join T3's threads to ob's rows, and on a client those rows come over
	// the API -- so the join is answered from the endpoint while the THREADS are read here, where T3 is.
	const restore = __setT3RowSource(apiT3RowSource(ctx.client));
	try {
		await cmdT3(local);
	} finally {
		restore();
	}
	ctx.exit = local.exit;
}

/** The role backend over the API: the runs, the team and the inbox cross the wire; T3 stays the caller's. */
export function apiRoleBackend(ctx: ApiCtx): import("../commands/role.ts").RoleBackend {
	const { client } = ctx;
	return {
		team: apiTeamBackend(ctx),
		open: async (team, role) => (await client.roleRuns(team, role)).runs,
		mark: async (team, role, t3Host) => {
			const res = await client.roleRunMark(team, { role, t3_host: t3Host });
			return { run: res.run, created: res.created === true };
		},
		update: async (team, id, patch) => (await client.roleRunUpdate(team, id, patch)).run,
		// OS-55: the brief's store facts and the note live on the server; pacing and gate facts are read here.
		briefFacts: async (team, role) => (await client.roleBrief(team, role)).facts,
		noteShown: async (team, runId) => {
			await client.roleNoteShown(team, runId);
		},
		note: async (team, role, body) => (await client.roleNote(team, { role, body })).run,
		readMessages: async (team, role, ids, by) => (await client.roleMessagesRead(team, role, ids, by)).messages,
	};
}

/** `ob role tick` over the API (OS-67): the findings are read on the server, the inbox and runs cross the wire, T3 is here. */
function apiTickBackend(ctx: ApiCtx): import("../commands/role-tick.ts").TickBackend {
	const { client } = ctx;
	return {
		role: apiRoleBackend(ctx),
		inbox: apiInboxBackend(ctx),
		teams: () => apiTeamBackend(ctx).list(),
		checkouts: async () => launchConfig((await client.spinoffConfig()).config).repoCheckouts,
		findings: async (team) => (await client.roleTick(team)).findings,
	};
}

/** `ob role` over the API: the runs and the team cross the wire, the thread is read, launched and settled here. */
async function apiRole(ctx: ApiCtx): Promise<void> {
	const { runRoleCommand } = await import("../commands/role.ts");
	await runRoleCommand(ctx, apiRoleBackend(ctx), undefined, apiTickBackend(ctx));
}

/** `ob send` / `ob inbox` over the API: the messages live on the server, so any machine reaches them. */
export function apiInboxBackend(ctx: ApiCtx): import("../commands/inbox.ts").InboxBackend {
	const { client } = ctx;
	return {
		send: async (input) => {
			const res = await client.roleMessageSend(input.team, {
				role: input.role,
				from: input.from,
				kind: input.kind,
				ref: input.ref ?? null,
				body: input.body,
				client_key: input.clientKey ?? null,
			});
			return { message: res.message, created: res.created };
		},
		list: async (team, role, all) => (await client.roleMessages(team, role, !all)).messages,
		read: async (team, role, ids, by) => (await client.roleMessagesRead(team, role, ids, by)).messages,
	};
}

async function apiSend(ctx: ApiCtx): Promise<void> {
	const { runSend } = await import("../commands/inbox.ts");
	const { deliverToRole } = await import("../role-deliver.ts");
	const { t3Seam } = await import("../t3/dispatch.ts");
	const inbox = apiInboxBackend(ctx);
	// OS-56: the messages and the runs live on the server; the delivery into T3 runs here, where T3 is.
	await runSend(ctx, inbox, (team, role) => deliverToRole(apiRoleBackend(ctx), inbox, () => t3Seam(), team, role));
}

async function apiInbox(ctx: ApiCtx): Promise<void> {
	const { runInbox } = await import("../commands/inbox.ts");
	await runInbox(ctx, apiInboxBackend(ctx));
}

async function apiReopen(ctx: ApiCtx): Promise<void> {
	const id = requireId(ctx, "reopen");
	refuseDryRun(ctx, "reopen");
	const res = await ctx.client.reopen(id, { github: ctx.flags["no-github"] ? false : undefined, note: ctx.flags.note, actor: ctx.flags.holder });
	emitMove(ctx, id, "open", res);
}

function simpleState(action: ObApiStateAction, command: string): (ctx: ApiCtx) => Promise<void> {
	return async (ctx) => {
		const id = requireId(ctx, command);
		const reason = ctx.flags.reason ?? (action === "block" ? ctx.flags.note : undefined);
		if (action === "block" && !reason) throw new UsageError("block requires --reason <r> (or --note <r>)");
		const res = await ctx.client.state(id, {
			action,
			reason,
			owner: ctx.flags.owner,
			note: ctx.flags.note,
			actor: ctx.flags.holder,
		});
		emitId(ctx, res.id, res.ref);
	};
}

async function apiState(ctx: ApiCtx): Promise<void> {
	const id = ctx.args[0];
	const to = ctx.args[1];
	if (!id || !to) throw new UsageError("state requires <id> <state>");
	// `state <id> done` IS `close <id>` (#77): landing an item also closes its linked GitHub issue. The
	// endpoint refuses `done` for exactly that reason, so the client routes it to the door that does the
	// whole job rather than letting the refusal reach a human who meant to land something.
	if (to === "done") {
		refuseDryRun(ctx, "state");
		const tokensById = await closeTokensById(ctx, id);
		const res = await ctx.client.close(id, { github: ctx.flags["no-github"] ? false : undefined, note: ctx.flags.note, actor: ctx.flags.holder, tokensById });
		emitMove(ctx, id, "closed", res);
		return;
	}
	const res = await ctx.client.state(id, {
		action: "set",
		status: to,
		reason: ctx.flags.reason,
		owner: ctx.flags.owner,
		note: ctx.flags.note,
		actor: ctx.flags.holder,
	});
	// OB-1928: a `set open` on a done item is a reopen, and the server mirrored it; report it like `ob reopen`.
	if (res.tracker) {
		emitMove(ctx, id, "open", res.tracker);
		return;
	}
	emitId(ctx, res.id, res.ref);
}

// --- the coordination core ---------------------------------------------------------------------------

async function apiAgents(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === "reset") {
		if (ctx.args[1] !== undefined) {
			throw new UsageError(`unexpected argument '${ctx.args[1]}' (agents reset [--dry-run])`);
		}
		const dryRun = ctx.flags["dry-run"] === true;
		const res = await ctx.client.agentsReset({ dry_run: dryRun });
		if (ctx.mode === "json") {
			print(JSON.stringify({ dry_run: res.dry_run, agents: res.agents, leases: res.leases }, null, 2));
			return;
		}
		if (ctx.mode === "quiet") {
			print([...res.agents, ...res.leases].join("\n"));
			return;
		}
		print(formatAgentsReset({ agents: res.agents, leases: res.leases }, res.dry_run));
		return;
	}
	if (sub !== undefined) {
		throw new UsageError(`unknown agents subcommand '${sub}' (reset)`);
	}
	const res = await ctx.client.agents(ctx.flags.all === true);
	// The server already resolved each row's effective launcher (its own, else its spinoff's).
	const rows = res.agents;
	if (ctx.mode === "json") {
		print(JSON.stringify(rows, null, 2));
		return;
	}
	if (ctx.mode === "quiet") {
		print(rows.map((r) => r.id).join("\n"));
		return;
	}
	if (rows.length === 0) {
		print("no active agents");
		return;
	}
	print(
		rows
			.map((r) => {
				const state = r.expired ? "expired" : agentStateLabel(r.status, r.run);
				const note = r.note ? `\t— ${agentNoteText(r.status ?? "", r.note)}` : "";
				return `${r.id}\t${state}\t${r.launcher ?? "-"}\t${r.ticket ?? "-"}\t${r.branch ?? "-"}\tbeat ${r.heartbeat_at}${note}`;
			})
			.join("\n"),
	);
}

async function apiAgent(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	const self = leaseHolderId();

	// "Should this Mac stay awake?" (098). StayAwake polls it, so it is the one agent read whose caller is
	// a timer rather than a person: a refusal here does not annoy anybody, it lets the machine sleep in the
	// middle of a build. The server derives `active` from the count, so the two cannot disagree about what
	// counts as alive.
	if (sub === "active") {
		const min = ctx.flags.within ? Number(ctx.flags.within) : undefined;
		if (min !== undefined && (!Number.isFinite(min) || min <= 0)) {
			throw new UsageError("agent active --within must be a positive number of minutes");
		}
		const res = await ctx.client.agentActive({ within_min: min });
		if (ctx.mode === "json") print(JSON.stringify({ active: res.active, count: res.count, within_min: res.within_min }));
		else print(res.active ? `active (${res.count} within ${res.within_min}m)` : `dormant (none within ${res.within_min}m)`);
		return;
	}

	if (sub === "register") {
		// 417: same rule as cmdAgent — register is a registry write (POST /agents).
		// It must never open a local launch or write a launch request or open a tab.
		const rawStatus = str(ctx.flags, "status");
		const status = rawStatus ? parseAgentStatus(rawStatus) : null;
		if (rawStatus && !status) {
			throw new UsageError(`--status must be one of ${AGENT_STATUSES.join("|")}`);
		}
		if (ctx.flags["spawn-failed"] === true) {
			unsupported("'ob agent register --spawn-failed'", "invalidating the spinoff row is not part of POST /agents yet");
		}
		const ttlS = ctx.flags.ttl ? Number(ctx.flags.ttl) : DEFAULT_AGENT_TTL_S;
		if (!Number.isFinite(ttlS) || ttlS <= 0) {
			throw new UsageError("agent register --ttl must be a positive number of seconds");
		}
		const id = str(ctx.flags, "id") ?? self;
		// The branch and worktree are THIS checkout's, so they are read here and sent. The deleted ssh
		// split resolved machine facts on the client for the same reason.
		const git = ctx.git(ctx.cwd);
		const req: AgentRequest = {
			action: "register",
			id,
			ticket: str(ctx.flags, "ticket") ?? null,
			worktree: str(ctx.flags, "worktree") ?? git.worktree ?? null,
			branch: str(ctx.flags, "branch") ?? git.branch ?? null,
			status: status ?? null,
			note: str(ctx.flags, "note") ?? null,
			launcher: str(ctx.flags, "launcher") ?? null,
			session_id: str(ctx.flags, "session") ?? null,
			ttl_s: ttlS,
			no_lease: ctx.flags["no-lease"] === true,
			holder: str(ctx.flags, "holder") ?? null,
		};
		// A ticket held by a live foreign session comes back as a 409 whose message is the CLI's own
		// refusal wording (the server raises the same AppError `ob agent register` does), so it is printed
		// as-is rather than re-worded here.
		const res = await ctx.client.agent(req);
		const row = res.agent;
		if (!row) throw new UsageError(`register '${id}' returned no agent row`);
		// 1579: the thread is on THIS machine's T3, so the client moves its title, as cmdAgent does.
		const titleWarning = await titleSyncWarning(row, status);
		if (titleWarning) warn(titleWarning);
		if (ctx.mode === "json") print(JSON.stringify(row, null, 2));
		else if (ctx.mode === "quiet") print(row.id);
		else print(`registered ${row.id} — ${row.status}${row.ticket ? ` on ${row.ticket}` : ""}`);
		return;
	}

	if (sub === "heartbeat") {
		const id = ctx.args[1] ?? str(ctx.flags, "id") ?? self;
		const res = await ctx.client.agent({ action: "heartbeat", id });
		// OB-1922: an expired lease is acquired afresh, never revived, and the builder is told.
		if (res.reacquired_leases && res.reacquired_leases.length > 0) warn(`note: ${formatReacquiredLeases(id, res.reacquired_leases)}`);
		if (ctx.mode !== "quiet") print(`beat ${id}`);
		return;
	}

	if (sub === "done") {
		const id = ctx.args[1] ?? str(ctx.flags, "id") ?? self;
		const res = await ctx.client.agent({ action: "done", id, no_lease: ctx.flags["no-lease"] === true });
		const kept = res.kept ?? [];
		if (ctx.mode === "json") {
			print(JSON.stringify({ id, done: res.found, released: res.released, kept }, null, 2));
		} else if (ctx.mode !== "quiet") {
			const bits = [res.found ? `done ${id}` : `no agent '${id}'`];
			if (res.released.length) bits.push(`released ${res.released.join(", ")}`);
			if (kept.length) bits.push(`kept ${kept.join(", ")}`);
			print(bits.join(", "));
		}
		return;
	}

	throw new UsageError(`unknown agent subcommand '${sub ?? ""}' (register|heartbeat|done)`);
}

/** What a refused release/heartbeat says when the server carried no recorded row to name a holder from. */
function notHeldWithoutRow(verb: "release" | "heartbeat", resource: string, caller: string): string {
	const nothing = verb === "release" ? "nothing released" : "nothing beaten";
	return `${resource} is not ${caller}'s to ${verb}, ${nothing}: run 'ob lease status' to see who the row names`;
}

/** OB-2041: `ob ports` reads THIS machine (ss, ufw, route) and the shared lease table over the API. */
async function apiPorts(ctx: ApiCtx): Promise<void> {
	const io: PortsIo = {
		...machineIo,
		leases: async () => (await ctx.client.leases()).leases,
		acquire: async (resource, holder, ttlS) => {
			const r = await ctx.client.acquireLease({ resource, holder, ttl_s: ttlS });
			return { ok: r.ok, holder: r.holder };
		},
		defaultHolder: leaseHolderId,
	};
	await runPorts({ args: ctx.args, flags: ctx.flags as unknown as Record<string, unknown>, mode: ctx.mode }, io);
}

async function apiLease(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	const holderOf = (): string => {
		const v = ctx.flags.holder;
		return typeof v === "string" && v.trim() ? v.trim() : leaseHolderId();
	};

	if (sub === "acquire") {
		// normalizeLeaseResource is pure, and the key must be canonical BEFORE it crosses the wire or the
		// two sides protect different strings.
		const resource = ctx.args[1] ? normalizeLeaseResource(ctx.args[1]) : undefined;
		if (!resource) throw new UsageError("lease acquire requires a <resource>");
		const ttlS = ctx.flags.ttl ? Number(ctx.flags.ttl) : DEFAULT_LEASE_TTL_S;
		if (!Number.isFinite(ttlS) || ttlS <= 0) {
			throw new UsageError("lease acquire --ttl must be a positive number of seconds");
		}
		const holder = holderOf();
		const wait = ctx.flags.wait === true;
		const attempt = () => ctx.client.acquireLease({ resource, holder, ttl_s: ttlS });
		let result: Awaited<ReturnType<typeof attempt>>;
		try {
			result = wait ? await waitUntilAcquired(attempt, { resource, log: warn, title: leaseWaitTitle(resource, warn) }) : await attempt();
		} catch (err) {
			// A titled wait stopped by Ctrl-C or SIGTERM: the title is back, so exit as the signal would have (OB-2153).
			if (!(err instanceof LeaseWaitSignalled)) throw err;
			ctx.exit = err.exitCode;
			return;
		}
		if (ctx.mode === "json") {
			print(JSON.stringify({ resource, ok: result.ok, holder: result.holder }, null, 2));
		} else if (ctx.mode === "quiet") {
			if (result.ok) print(holder);
		} else if (result.ok) {
			print(`acquired ${resource} (holder ${result.holder}, ttl ${ttlS}s)`);
		} else {
			print(`denied: ${resource} held by ${result.holder}`);
		}
		if (!result.ok) ctx.exit = 1;
		return;
	}

	if (sub === "run") {
		const { resource, holder, command, ttlS, heartbeatMs, capS } = planLeaseRun(ctx.args, ctx.flags);
		ctx.exit = await runUnderLease({
			resource,
			holder,
			command,
			heartbeatMs,
			capS,
			io: {
				acquire: async () => {
					const r = await ctx.client.acquireLease({ resource, holder, ttl_s: ttlS });
					return { ok: r.ok, holder: r.holder };
				},
				release: async () => (await ctx.client.releaseLease(resource, { holder, force: false })).released,
			},
			log: warn,
		});
		return;
	}

	if (sub === "release") {
		const resource = ctx.args[1] ? normalizeLeaseResource(ctx.args[1]) : undefined;
		if (!resource) throw new UsageError("lease release requires a <resource>");
		const holder = holderOf();
		const force = ctx.flags.force === true;
		const res = await ctx.client.releaseLease(resource, { holder, force });
		if (ctx.mode === "json") {
			print(JSON.stringify({ resource, released: res.released, holder, force, recorded: res.recorded ?? null }, null, 2));
		} else if (ctx.mode !== "quiet") {
			if (res.released) print(force ? `released ${resource} (forced)` : `released ${resource}`);
			else if (res.recorded) print(formatNotHeld("release", resource, holder, res.recorded));
			else print(notHeldWithoutRow("release", resource, holder));
		}
		// A release that released nothing is a FAILURE the caller must see (#75).
		if (!res.released) ctx.exit = 1;
		return;
	}

	if (sub === "heartbeat") {
		const resource = ctx.args[1] ? normalizeLeaseResource(ctx.args[1]) : undefined;
		if (!resource) throw new UsageError("lease heartbeat requires a <resource>");
		const holder = holderOf();
		const res = await ctx.client.acquireLease({ resource, holder, ttl_s: DEFAULT_LEASE_TTL_S, heartbeat: true });
		if (ctx.mode === "json") {
			print(JSON.stringify({ resource, beat: res.ok, holder, recorded: res.recorded ?? null, ...(res.error ? { error: res.error } : {}) }, null, 2));
		} else if (ctx.mode !== "quiet") {
			if (res.ok) print(`beat ${resource} (holder ${holder})`);
			// OB-1922: the caller's own lease, expired: the server refused to revive it.
			else if (res.error === "LeaseExpiredError") print(new LeaseExpiredError(resource, holder).message);
			else if (res.recorded) print(formatNotHeld("heartbeat", resource, holder, res.recorded));
			else print(notHeldWithoutRow("heartbeat", resource, holder));
		}
		if (!res.ok) ctx.exit = 1;
		return;
	}

	if (sub === "status" || sub === undefined) {
		// OB-1922: the sweep is housekeeping, so no API failure of it fails the read (a server from before
		// the sweep answers 404; any other failure is said and the listing still prints).
		let swept: string[] = [];
		try {
			swept = (await ctx.client.sweepLeases()).swept;
		} catch (err) {
			if (!(err instanceof ApiError)) throw err;
			if (ctx.mode !== "quiet" && ctx.mode !== "json") warn(`note: expired leases not swept: ${err.message}`);
		}
		const { leases: rows } = await ctx.client.leases();
		if (swept.length > 0 && ctx.mode !== "quiet" && ctx.mode !== "json") {
			warn(`swept ${swept.length} lease(s) expired for over a day: ${swept.join(", ")}`);
		}
		if (ctx.mode === "json") {
			print(JSON.stringify(rows, null, 2));
			return;
		}
		if (ctx.mode === "quiet") {
			print(rows.map((r) => r.resource).join("\n"));
			return;
		}
		if (rows.length === 0) {
			print("no active leases");
			return;
		}
		print(
			rows
				.map((r) => {
					const state = r.expired ? "expired" : "held";
					return `${r.resource}\t${state}\t${r.holder ?? "-"}\tttl=${r.ttl_s ?? "-"}s\tsince ${r.acquired_at ?? "-"}\tbeat ${r.heartbeat_at ?? "-"}`;
				})
				.join("\n"),
		);
		return;
	}

	throw new UsageError(`unknown lease subcommand '${sub}' (acquire|run|release|heartbeat|status)`);
}

// --- the credential store (357) -----------------------------------------------------------------------
//
// `ob secret get` is the one command in ob whose whole job is to produce a credential on stdout, and over
// the API that means a plaintext value crosses the wire. The owner weighed that and asked for it (the trade
// and its three layers are written out in contract.ts); what this half owes him is that the value goes
// from the response straight to stdout and touches nothing else on the way -- no log, no error message,
// no `--json` envelope, and no URL. The name does not go in a URL either: every call below is a POST.

async function apiSecret(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];

	if (sub === "get") {
		const name = ctx.args[1];
		if (!name) throw new UsageError("secret get requires a <name>");
		const res = await ctx.client.readSecret({ name });
		// Verbatim to stdout, exactly as the local command does, so `$(ob secret get linear)` is the same
		// string on either path. printRaw and not print: no trailing formatting, no mode branching, and
		// nothing that could put the value through a renderer.
		printRaw(`${res.value}\n`);
		return;
	}

	if (sub === "set") {
		const name = ctx.args[1];
		if (!name) throw new UsageError("secret set requires a <name> (value is read from stdin)");
		const value = (await Bun.stdin.text()).trim();
		if (!value) {
			throw new UsageError("secret set: no value on stdin (pipe the value in, e.g. `pbpaste | ob secret set <name>`)");
		}
		const res = await ctx.client.setSecret({ name, value });
		if (ctx.mode === "json") print(JSON.stringify({ name: res.name, set: true }));
		else if (ctx.mode !== "quiet") print(`set secret \`${res.name}\``);
		return;
	}

	if (sub === "list") {
		const res = await ctx.client.secrets();
		print(renderSecretList(res.secrets, ctx.mode));
		return;
	}

	if (sub === "rm") {
		const name = ctx.args[1];
		if (!name) throw new UsageError("secret rm requires a <name>");
		const res = await ctx.client.removeSecret({ name });
		if (ctx.mode === "json") print(JSON.stringify({ name: res.name, removed: res.removed }));
		else if (ctx.mode !== "quiet") print(`removed secret \`${res.name}\``);
		return;
	}

	if (sub === "import") {
		// NOT served, and refused rather than routed: `import` copies the token FILES on the machine it runs
		// on into the store. Sent to the API it would import the SERVER's files while the person meant the
		// ones on the laptop in front of them -- a command that exits 0 having done something else.
		const files = Object.values(KNOWN_SECRETS).map((k) => `${DEFAULTS[k.pathSetting]} (${k.label}, unless setting ${k.pathSetting} moves it)`);
		unsupported(
			"'ob secret import'",
			`it reads the plaintext token FILES on the machine it runs on, and over the API that would import the SERVER's files rather than this machine's: ${files.join(", ")}. To store one from here: ob secret set <name>`,
		);
	}

	throw new UsageError(`unknown secret subcommand '${sub ?? ""}' (set|get|list|rm|import)`);
}

// `ob cloudflare` (1756): the Cloudflare call is made from THIS machine; only the token travels, over the
// same POST /secrets/read `ob secret get` uses. A missing name is null, not an error, so the account id
// (an optional zone filter) can be absent.
async function apiCloudflare(ctx: ApiCtx): Promise<void> {
	await runCloudflare(ctx.args, ctx.flags, ctx.mode, {
		fetch: ctx.cloudflareFetch ?? fetch,
		secret: async (name) => {
			try {
				return (await ctx.client.readSecret({ name })).value;
			} catch (e) {
				if (e instanceof ApiError && e.status === 404) return null;
				throw e;
			}
		},
	});
}

async function apiCreds(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];

	if (sub === "check") {
		const name = ctx.args[1];
		const all = ctx.flags.all === true;
		if (!name && !all) throw new UsageError(`creds check requires a <name> (${CREDENTIAL_NAMES.join("|")}) or --all`);
		// The check runs where the credentials are, which is the API host. That is the point rather than a
		// limitation: a laptop asking Cloudflare with a token it cannot read would be checking nothing.
		const res = await ctx.client.credsCheck(all ? { all: true } : { name });
		print(renderCredentialChecks(res.checks, ctx.mode));
		const failed = failedChecks(res.checks, ctx.mode);
		if (failed) print(failed);
		if (res.checks.some((r) => !r.ok)) ctx.exit = 1; // same exit contract as the local command (1655)
		return;
	}

	if (sub !== undefined) throw new UsageError(`unknown creds subcommand '${sub}' (check)`);

	const res = await ctx.client.creds();
	print(renderCredentialInventory(res.credentials, ctx.mode));
}

/** OB-2173: `ob review readers` over the config endpoint (the review_readers key). */
async function apiReview(ctx: ApiCtx): Promise<void> {
	await runReview(ctx.args, ctx.flags, ctx.mode, {
		get: async (k) => (await ctx.client.config(k)).config[0]?.value ?? null,
		set: async (k, v) => {
			await ctx.client.configSet({ key: k, value: v });
		},
	});
}

async function apiConfig(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	// The client's OWN pointer is not a config key: it is OMNISLASH_API / ~/.omnislash_api_url (353), and
	// `remote_host` is the OLD ssh-hop key. Writing it into the SERVER's table from a client would make
	// the server point somewhere else, so both get and set refuse by name.
	const refuseRemoteHost = (key: string): void => {
		throw new UsageError(
			[
				`'config ${sub} ${key}' is about THIS machine's API pointer, not a server setting.`,
				`  ob reads its API address from OMNISLASH_API (env) or ~/.omnislash_api_url (file), never a config key.`,
				`  refusing rather than reading/writing '${key}' in the SERVER's config table.`,
			].join("\n"),
		);
	};

	if (sub === undefined) {
		const res = await ctx.client.config();
		if (ctx.mode === "json") {
			print(JSON.stringify(res.config, null, 2));
			return;
		}
		print(res.config.map((r) => `${r.key}=${r.value ?? ""}`).join("\n"));
		return;
	}
	if (sub === "get") {
		const key = ctx.args[1];
		if (!key) throw new UsageError("config get requires <key>");
		if (key === "remote_host") refuseRemoteHost(key);
		const res = await ctx.client.config(key);
		print(res.config[0]?.value ?? "");
		return;
	}
	if (sub === "set") {
		const key = ctx.args[1];
		const value = ctx.args.slice(2).join(" ");
		if (!key) throw new UsageError("config set requires <key> <value>");
		if (key === "remote_host") refuseRemoteHost(key);
		await ctx.client.configSet({ key, value });
		print(value);
		return;
	}
	throw new UsageError(`unknown config subcommand '${sub}' (get|set)`);
}

function factsFromPairing(pairing: {
	unlinked_ob_ids: number[];
	spinoffs: Array<{ ticket_ref: string; branch: string; base_sha: string | null; status: string }>;
}): LandedStoreFacts {
	const allSpinoffs = pairing.spinoffs.map((s) => ({
		ticket_ref: s.ticket_ref,
		branch: s.branch,
		base_sha: s.base_sha,
	}));
	return {
		unlinkedObItems: new Set(pairing.unlinked_ob_ids),
		mergedSpinoffs: pairing.spinoffs
			.filter((s) => s.status === "merged")
			.map((s) => ({ ticket_ref: s.ticket_ref, branch: s.branch, base_sha: s.base_sha })),
		allSpinoffs,
	};
}

function linksFromPairing(pairing: {
	issues: Array<{ id: string; type?: string; status: string; title: string; issue: number; repo: string }>;
}): LinkedItem[] {
	return pairing.issues.map((l) => ({
		item_id: l.id,
		type: l.type,
		status: l.status,
		title: l.title,
		ref: { repo: l.repo, number: l.issue },
	}));
}

async function apiIssueLanded(ctx: ApiCtx): Promise<void> {
	const arg = ctx.args[1];
	if (!arg) throw new UsageError("issue landed requires an <item-id|#issue>");
	const pairing = await ctx.client.issuePairing();
	const checkout = resolveTrackerCheckout({
		cwd: ctx.cwd,
		explicit: ctx.flags.repo,
		trackerRepo: pairing.tracker_repo,
	});
	const refs: CheckedRef[] = [];
	let itemId: string | null = null;
	let issue: number | null = null;
	if (arg.startsWith("#") || arg.includes("://")) {
		const parsed = parseIssueArg(arg);
		issue = parsed.number;
		refs.push({ namespace: "issue", number: issue, via: "asked" });
		const linked = pairing.issues.find(
			(l) => l.issue === issue && sameRepo(l.repo, parsed.repo ?? pairing.tracker_repo),
		);
		if (linked) {
			itemId = linked.id;
			if (/^\d+$/.test(itemId)) refs.push({ namespace: "ob", number: Number(itemId), via: "link" });
		}
	} else {
		// 1949: a `PS-12` ref (or an alias) is resolved by the server to its item, whose current ref is checked too.
		const viaRef = pairing.item_ids.includes(arg) ? null : ticketRefMention(arg)?.namespace === "ref" ? (await ctx.client.item(arg).catch(() => null))?.item ?? null : null;
		if (!pairing.item_ids.includes(arg) && !viaRef) throw new AppError(`no item with id '${arg}'`);
		itemId = viaRef?.id ?? arg;
		if (/^\d+$/.test(itemId)) refs.push({ namespace: "ob", number: Number(itemId), via: "asked" });
		for (const r of new Set([arg, viaRef?.ref].filter((x): x is string => !!x))) {
			const m = ticketRefMention(r);
			if (m?.namespace === "ref" && !refs.some((x) => x.namespace === "ref" && x.key === m.key && x.number === m.number)) {
				refs.push({ ...m, via: "asked" });
			}
		}
		const link = pairing.issues.find((l) => l.id === itemId);
		if (link) {
			issue = link.issue;
			refs.push({ namespace: "issue", number: issue, via: "link" });
		}
	}
	const state = await readRepoState(checkout, undefined, factsFromPairing(pairing));
	const report = landedIn(state, refs);
	// OB-1700: a bare number is the internal id; say when the ticket shown as OB-<n> is another item.
	const rivalNote = rivalRefNote(arg, /^\d+$/.test(arg) ? ((await ctx.client.item(`OB-${Number(arg)}`).catch(() => null))?.item?.id ?? null) : null);
	if (ctx.mode === "json") {
		print(JSON.stringify({ item: itemId, issue, ...report, ...(rivalNote ? { note: rivalNote } : {}) }, null, 2));
		return;
	}
	if (ctx.mode === "quiet") {
		print(report.answer === "landed" ? "landed" : report.answer === "could-not-tell" ? "could-not-tell" : "not-landed");
		return;
	}
	print(renderLanded(report, arg, itemId !== null && issue !== null, rivalNote));
}

async function apiIssueDrift(ctx: ApiCtx): Promise<void> {
	const [pairing, gh] = await Promise.all([ctx.client.issuePairing(), ctx.client.githubIssues()]);
	const checkout = resolveTrackerCheckout({
		cwd: ctx.cwd,
		explicit: ctx.flags.repo,
		trackerRepo: pairing.tracker_repo,
	});
	const rows = await computeDrift({
		checkout,
		trackerRepo: pairing.tracker_repo,
		issues: gh.issues.map((i) => ({
			number: i.number,
			title: i.title,
			state: i.state,
			assignees: [],
			labels: [],
			body: null,
			url: "",
		})),
		facts: factsFromPairing(pairing),
		links: linksFromPairing(pairing),
	});
	if (ctx.mode === "json") {
		print(JSON.stringify({ repo: pairing.tracker_repo, drift: rows }, null, 2));
		return;
	}
	if (ctx.mode === "quiet") {
		print(rows.map((r) => `#${r.issue}`).join("\n"));
		return;
	}
	print(renderDrift(pairing.tracker_repo, rows));
}

async function apiIssueReconcile(ctx: ApiCtx): Promise<void> {
	const limit = ctx.flags.limit ? Number(ctx.flags.limit) : 25;
	if (!Number.isFinite(limit) || limit <= 0) throw new UsageError(`invalid --limit '${ctx.flags.limit}'`);
	const res = await ctx.client.issueReconcile(limit);
	if (ctx.mode === "json") {
		print(JSON.stringify({ repo: res.repo, candidates: res.candidates }, null, 2));
		return;
	}
	if (ctx.mode === "quiet") {
		print(res.candidates.map((c) => `${c.item_id} #${c.issue}`).join("\n"));
		return;
	}
	print(renderReconcile(res.repo, res.candidates));
}

async function apiIssue(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0] ?? "list";

	// 389: landed/drift SPLIT — pairing from the API, git HERE. Do not send the caller to the host.
	if (sub === "landed") {
		await apiIssueLanded(ctx);
		return;
	}
	if (sub === "drift") {
		await apiIssueDrift(ctx);
		return;
	}
	if (sub === "reconcile") {
		await apiIssueReconcile(ctx);
		return;
	}

	if (sub === "list") {
		const res = await ctx.client.issueLinks();
		const links = res.issues;
		if (ctx.mode === "json") {
			print(JSON.stringify(links, null, 2));
			return;
		}
		if (ctx.mode === "quiet") {
			print(links.map((l) => l.id).join("\n"));
			return;
		}
		if (links.length === 0) {
			print("No ob item is linked to a GitHub issue. Pair them with 'ob issue link <id> #<n>'.");
			return;
		}
		print(links.map((l) => `ob ${l.id}\t#${l.issue}\t${l.status}\t${l.title}`).join("\n"));
		return;
	}

	if (sub === "link") {
		const itemArg = ctx.args[1];
		const issueArg = ctx.args[2];
		if (!itemArg || !issueArg) throw new UsageError("issue link requires <item-id> <#n|url>");
		// parseIssueArg is pure, so the short-form-vs-URL split happens HERE; only a URL carries a repo.
		const parsed = parseIssueArg(issueArg);
		const res = await ctx.client.issueLink({ item_id: itemArg, number: parsed.number, repo: parsed.repo ?? null });
		if (ctx.mode === "json") print(JSON.stringify({ id: res.id, issue: res.issue, url: res.url }));
		else if (ctx.mode === "quiet") print(res.id);
		else print(`ob ${res.id} <-> issue #${res.issue}  ${res.url}`);
		return;
	}

	if (sub === "unlink") {
		const itemArg = ctx.args[1];
		if (!itemArg) throw new UsageError("issue unlink requires an <item-id>");
		const res = await ctx.client.issueUnlink({ item_id: itemArg });
		if (ctx.mode === "json") {
			print(
				JSON.stringify({
					id: res.id,
					unlinked: res.issue,
					cleared: res.kind ? { kind: res.kind, url: res.url } : null,
				}),
			);
			return;
		}
		if (ctx.mode === "quiet") {
			print(res.id);
			return;
		}
		if (!res.kind) {
			print(`ob ${res.id} carries no reference to clear (nothing changed)`);
			return;
		}
		print(
			res.kind === "issue"
				? `ob ${res.id} no longer linked to issue #${res.issue} (the item and everything attached to it is untouched)`
				: `ob ${res.id} no longer carries its Linear reference (${res.linear_id ?? "no id"} ${res.url}); ` +
						`nothing in Linear was touched, and the item and everything attached to it is untouched`,
		);
		return;
	}

	throw new UsageError(`unknown 'issue' subcommand '${sub}' (list|link|unlink|landed|reconcile|drift)`);
}

/**
 * `ob triage` (375): the inbox as DATA. The render is the same one `cmdTriage` produces locally — the
 * count line, the `id<TAB>title` rows with `·from <origin_repo>` and `- <note>` — because the SERVER
 * computes the snippet with the same truncator, so nothing here reshapes the answer. The whole close of
 * `reject` happens on the server; this client only ever sends clear/reject, never a close.
 */
async function apiTriage(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];

	if (sub === "clear" || sub === "reject") {
		const id = ctx.args[1];
		if (!id) throw new UsageError(`triage ${sub} requires an <id>`);
		// OB-1928: reject is a close on the server, mirror included, so it prints and settles T3 threads as
		// `ob close` does (apiClose).
		if (sub === "reject") {
			emitMove(ctx, id, "closed", await ctx.client.triageReject(id));
			await settleClosedTicketThreads(ctx, id);
			return;
		}
		const res = await ctx.client.triageClear(id);
		emitId(ctx, res.id, res.ref);
		return;
	}

	if (sub !== undefined) throw new UsageError(`unknown triage subcommand '${sub}'`);

	const res = await ctx.client.triage();
	if (ctx.mode === "json") {
		print(JSON.stringify(res.items, null, 2));
		return;
	}
	if (ctx.mode === "quiet") {
		print(res.items.map((i) => i.id).join("\n"));
		return;
	}

	if (res.items.length === 0) {
		print("Triage inbox is empty.");
		return;
	}

	const lines = [`Triage inbox: ${res.items.length} item(s) awaiting triage`];
	for (const i of res.items) {
		const from = i.origin_repo ? `  ·from ${i.origin_repo}` : "";
		const note = i.note;
		lines.push(`  ${i.id}\t${i.title}${from}${note ? `\t- ${note}` : ""}`);
	}
	print(lines.join("\n"));
}

/**
 * `ob whatsapp` (366, OB-1809): the bridge is on the API host, so all of it is served but `bridge run|start|stop`.
 * sync and bridge status are host jobs, the rest are routes. send's human gate runs here, on the caller's terminal.
 */
async function apiWhatsapp(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0] ?? "sync";

	if (sub === "search") {
		const query = ctx.args.slice(1).join(" ");
		if (!query) throw new UsageError("whatsapp search requires a <query>");
		const limit = ctx.flags.limit ? Number(ctx.flags.limit) : undefined;
		const res = await ctx.client.whatsappSearch(query, limit);
		if (ctx.mode === "json") print(JSON.stringify(res.hits, null, 2));
		else print(renderHits(res.hits));
		return;
	}

	if (sub === "recent") {
		const limit = ctx.flags.limit ? Number(ctx.flags.limit) : undefined;
		if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
			throw new UsageError("whatsapp recent --limit must be a positive number");
		}
		const res = await ctx.client.whatsappRecent({ since: str(ctx.flags, "since"), limit });
		if (ctx.mode === "json") print(JSON.stringify(res.hits, null, 2));
		else if (ctx.mode === "quiet") print(res.hits.map((h) => h.id).join("\n"));
		else print(res.hits.length === 0 ? "no whatsapp messages" : renderHits(res.hits));
		return;
	}

	if (sub === "sync") return apiWhatsappSync(ctx);
	if (sub === "send") return apiWhatsappSend(ctx);

	if (sub === "bio") {
		const text = ctx.args.slice(1).join(" ").trim();
		// The bio is one config key.
		const clear = ctx.flags.clear === true;
		if (clear || text) await ctx.client.configSet({ key: "self_bio", value: clear ? null : text });
		const self_bio = clear ? "" : text || ((await ctx.client.config("self_bio")).config[0]?.value ?? "");
		if (ctx.mode === "json") print(JSON.stringify({ self_bio }, null, 2));
		else if (clear) print("self-bio cleared");
		else if (text) print(`self-bio set:\n${self_bio}`);
		else print(self_bio || "(no self-bio set — `ob whatsapp bio \"<about you>\"` to set one)");
		return;
	}

	if ((WHATSAPP_PREF_ACTIONS as readonly string[]).includes(sub)) {
		const jid = ctx.args[1];
		// The two bare forms that list, as they do locally.
		if (!jid && (sub === "show" || sub === "favorite")) {
			const { chats } = await ctx.client.whatsappPrefChats(sub === "show" ? "hidden" : "favorites");
			if (ctx.mode === "json") print(JSON.stringify(chats, null, 2));
			else print(chats.length > 0 ? chats.join("\n") : sub === "show" ? "no hidden chats" : "no favourite chats");
			return;
		}
		if (!jid) throw new UsageError(`whatsapp ${sub} requires a <chat_jid>`);
		const pref = await ctx.client.whatsappPref({ chat_jid: jid, action: sub as WhatsappPrefAction });
		if (ctx.mode === "json") print(JSON.stringify(pref, null, 2));
		else {
			print(
				`${jid} — ${pref.hidden ? "hidden" : "visible"}, AI ${pref.ai_disabled ? "off" : "on"}, ${pref.favorite ? "favourite" : "not favourite"}`,
			);
		}
		return;
	}

	if (sub === "bridge") {
		if ((ctx.args[1] ?? "status") === "status") return apiWhatsappBridgeStatus(ctx);
		throw new UsageError(
			`'ob whatsapp bridge ${ctx.args[1]}' is refused: the bridge is the server's own long-running process (the omnislash-whatsapp-bridge unit), and no caller needs to run it. 'ob whatsapp bridge status' reads its health, and everything else in 'ob whatsapp' reaches it through the ob API.`,
		);
	}

	throw new UsageError(
		`unknown subcommand 'ob whatsapp ${sub}' (sync|search|recent|send|bridge|bio|hide|show|ai-off|ai-on|favorite|unfavorite)`,
	);
}

/** Leaves room in the server's 16 MB body cap once base64 has grown the file by a third. */
const WHATSAPP_SEND_MAX_FILE_BYTES = 11_900_000;

/** No answer, or a server that gave up: the bridge may still have delivered it. */
function sendOutcomeUnknown(e: unknown): boolean {
	return e instanceof ApiError && (e.status === 0 || e.status >= 500);
}

/**
 * OB-1809: `ob whatsapp send` over the API. The gate is the same function the local command runs, on this
 * terminal, before any request exists; only a yes puts confirm:true in a body. Every attachment is checked
 * first, so a bad one refuses before the human is asked. Nothing here retries: a timed-out send may have gone.
 */
async function apiWhatsappSend(ctx: ApiCtx): Promise<void> {
	const to = ctx.flags.to;
	const body = ctx.flags.body;
	if (!to) throw new UsageError("whatsapp send requires --to <jid>");
	const files = (ctx.flags.file ?? []).map(describeAttachment);
	if (!body && files.length === 0) throw new UsageError("whatsapp send requires --body <text> (or --file <path>)");
	for (const f of files) {
		if (f.size > WHATSAPP_SEND_MAX_FILE_BYTES) {
			throw new AppError(`cannot send ${f.name} over the ob API: ${f.size} bytes is over the ${WHATSAPP_SEND_MAX_FILE_BYTES} byte limit`);
		}
	}

	if (!(await confirmWhatsappSend(ctx.flags, to, body, files))) return;
	const resend = ctx.flags.resend === true ? { resend: true } : {};

	if (files.length === 0) {
		try {
			const res = await ctx.client.whatsappSend({ to, body: body ?? "", confirm: true, ...resend });
			if (ctx.mode === "json") print(JSON.stringify(res, null, 2));
			else print(`sent to ${res.to}`);
		} catch (e) {
			if (!sendOutcomeUnknown(e)) throw e;
			throw new AppError(`${(e as Error).message}. The message may have gone: check ob whatsapp recent before sending it again.`);
		}
		return;
	}
	// One message per file, in order, the caption on the first, as locally. A failure stops the rest and says how far it got.
	const results = [];
	for (const [i, f] of files.entries()) {
		try {
			const file = { name: f.name, data_base64: readFileSync(f.path).toString("base64") };
			results.push(await ctx.client.whatsappSend({ to, body: i === 0 ? (body ?? "") : "", confirm: true, file, ...resend }));
		} catch (e) {
			// OB-1909: the host's "an identical send may already have gone" refusal is shown as it is (after a file went, with what went).
			const maybeGone = e instanceof ApiError && e.status === 409 && e.message.includes(MAYBE_ALREADY_GONE_TAIL);
			if (maybeGone && results.length === 0) throw e;
			const message = partialSendMessage({
				to,
				body,
				files: ctx.flags.file ?? [],
				sent: results.length,
				failedUnknown: maybeGone || sendOutcomeUnknown(e),
			});
			throw new AppError(`${(e as Error).message}\n${message}`);
		}
	}
	if (ctx.mode === "json") print(JSON.stringify(results, null, 2));
	else print(`sent ${results.length} file${results.length === 1 ? "" : "s"} to ${to}`);
}

function syncNumber(flags: Flags, key: "days" | "max"): number | undefined {
	const raw = flags[key];
	if (raw == null) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * `ob gmail` (415): search/list are store reads; sync runs on the API HOST using secret `google`.
 * 1757: draft creates a Gmail DRAFT on the host; send-draft sends an existing one only with --confirm --hash (OB-1910)
 * (without it, it shows the draft and refuses). An unknown sub refuses by name and does not call the API.
 */
async function apiGmail(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];

	if (sub === "search") {
		const query = ctx.args.slice(1).join(" ");
		if (!query) throw new UsageError("gmail search requires a <query>");
		const limit = ctx.flags.limit ? Number(ctx.flags.limit) : undefined;
		const res = await ctx.client.gmailSearch(query, limit);
		if (ctx.mode === "json") print(JSON.stringify(res.hits, null, 2));
		else print(renderEmailHits(res.hits));
		return;
	}

	if (sub === "list") {
		const res = await ctx.client.gmailList({
			since: str(ctx.flags, "since"),
			limit: ctx.flags.limit ? Number(ctx.flags.limit) : undefined,
		});
		if (ctx.mode === "json") print(JSON.stringify(res.hits, null, 2));
		else print(renderEmailHits(res.hits));
		return;
	}

	if (sub === "sync") {
		const res = await ctx.client.gmailSync({
			backfill: ctx.flags.backfill,
			query: str(ctx.flags, "query"),
			days: syncNumber(ctx.flags, "days"),
			since: str(ctx.flags, "since"),
			max: syncNumber(ctx.flags, "max"),
		});
		if (ctx.mode === "json") print(JSON.stringify(res, null, 2));
		else {
			print(
				`gmail sync — ${res.messages} fetched, ${res.skipped} skipped, ${res.ingested} new (cursor ${res.cursor ?? "-"})`,
			);
		}
		return;
	}

	if (sub === "read") {
		const res = await ctx.client.gmailMessage(messageIdArg(ctx.args));
		print(renderRead(res, ctx.mode));
		return;
	}

	if (sub === "attachment") {
		// The host fetches from Gmail; the files are written HERE, on the machine the human is on.
		const res = await ctx.client.gmailAttachments(messageIdArg(ctx.args), str(ctx.flags, "name"));
		print(saveFetchedAttachments(res, ctx.flags, ctx.mode));
		return;
	}

	if (sub === "draft") {
		const res = await ctx.client.gmailDraftCreate(draftRequestFromFlags(ctx.flags));
		print(ctx.mode === "json" ? JSON.stringify(res, null, 2) : renderCreatedDraft(res));
		return;
	}

	if (sub === "drafts") {
		const res = await ctx.client.gmailDraftList(ctx.flags.limit ? Number(ctx.flags.limit) : undefined);
		print(ctx.mode === "json" ? JSON.stringify(res.drafts, null, 2) : renderDraftList(res.drafts));
		return;
	}

	if (sub === "draft-edit") {
		const id = draftIdArg(ctx.args, "draft-edit");
		const res = await ctx.client.gmailDraftEdit(id, draftEditFromFlags(ctx.flags));
		print(ctx.mode === "json" ? JSON.stringify(res, null, 2) : renderEditedDraft(res));
		return;
	}

	if (sub === "draft-delete") {
		const id = draftIdArg(ctx.args, "draft-delete");
		if (ctx.flags.confirm !== true) refuseUnconfirmedDelete(await ctx.client.gmailDraftShow(id));
		const res = await ctx.client.gmailDraftDelete(id, { confirm: true });
		print(ctx.mode === "json" ? JSON.stringify(res, null, 2) : renderDeleted(res));
		return;
	}

	if (sub === "send-draft") {
		const id = sendDraftId(ctx.args);
		const hash = confirmedSendHash(ctx.flags);
		if (hash === undefined) refuseUnconfirmed(await ctx.client.gmailDraftShow(id));
		// OB-1910: the client only carries the hash; the host re-reads the draft and decides the match.
		// A refusal on the host (stale hash, Trash) is a 400: exit 2 here too, as the local command does.
		const res = await usageOn400(ctx.client.gmailSendDraft(id, { confirm: true, hash }));
		print(ctx.mode === "json" ? JSON.stringify(res, null, 2) : renderSent(res));
		return;
	}

	throw new UsageError(`unknown gmail subcommand '${sub ?? ""}' (${GMAIL_SUBS})`);
}

/**
 * `ob cal` (415): agenda is a store read; sync runs on the API HOST using secret `google`.
 * Bare `ob cal` is today's agenda. An unknown sub refuses by name and does not call the API.
 */
async function apiCal(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];

	if (sub === "sync") {
		const res = await ctx.client.calSync({
			backfill: ctx.flags.backfill,
			since: str(ctx.flags, "since"),
			max: syncNumber(ctx.flags, "max"),
		});
		if (ctx.mode === "json") print(JSON.stringify(res, null, 2));
		else print(`cal sync — ${res.events} events, ${res.ingested} new across ${res.calendars.join(", ")}`);
		return;
	}

	if (sub === "agenda" || sub === undefined) {
		return apiAgenda(ctx);
	}

	throw new UsageError(`unknown cal subcommand '${sub}' (sync|agenda)`);
}

/** `ob agenda` (415): today's events, same render as the local command. */
async function apiAgenda(ctx: ApiCtx): Promise<void> {
	const res = await ctx.client.calAgenda();
	if (ctx.mode === "json") print(JSON.stringify(res.events, null, 2));
	else print(renderAgenda(res.events));
}

/** Client creds for `google auth`, plus the stored `google` value they came from (null when flags supplied them). */
async function resolveApiGoogleClientCreds(ctx: ApiCtx): Promise<{ creds: ClientCreds; stored: string | null }> {
	const fromFlags = resolveClientCredsFromFlags(ctx.flags);
	if (fromFlags) return { creds: fromFlags, stored: null };
	let value = "";
	try {
		const res = await ctx.client.readSecret({ name: "google" });
		value = res.value;
	} catch (e) {
		if (e instanceof ApiError && e.status === 404) {
			throw new UsageError(API_CLIENT_CREDS_USAGE);
		}
		throw e;
	}
	const creds = clientCredsFromStoredGoogleJson(value);
	if (!creds) throw new UsageError(API_CLIENT_CREDS_USAGE);
	return { creds, stored: value };
}

/**
 * `ob google` (420): SPLIT, like `secret`. `auth` is the local half — loopback
 * OAuth (browser + 127.0.0.1) RUNS here, then the minted JSON is persisted via the already-routed
 * secret API (`secret set google`) so the host store gets it. No local DB. No `~/.google_token`.
 * Unknown sub is a usage error. Creds: `--client` /
 * `--client-id` / `--client-secret`, else stored secret `google` (424).
 *
 * 1305 adds `auth-url`: the HOSTED half. The API mints a one-time state and answers with Google's
 * consent URL, so the phone can finish at /api/ob/google/callback. `auth` itself is unchanged.
 */
async function apiGoogle(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === "auth-url") {
		const res = await ctx.client.googleAuthUrl();
		print(res.url);
		return;
	}
	if (sub !== "auth") {
		throw new UsageError(`unknown google subcommand '${sub ?? ""}' (auth|auth-url)`);
	}
	const { creds, stored } = await resolveApiGoogleClientCreds(ctx);
	const { unreachableDatabase, unreachableStore } = await import("./run.ts");
	const { scopes } = await runGoogleAuth(
		{
			db: unreachableDatabase("google"),
			store: unreachableStore("google"),
			dbPath: "",
			mode: ctx.mode,
			flags: ctx.flags,
			args: ctx.args,
		},
		{
			...ctx.googleAuth,
			creds,
			persist: async (json) => {
				// Merge over the stored token read above (no extra call) so a response with no
				// refresh_token keeps it (OB-1916). With --client flags nothing was read: no merge.
				const value = stored
					? JSON.stringify(mergeGoogleToken(previousGoogleToken(stored), JSON.parse(json) as GoogleToken), null, 2)
					: json;
				await ctx.client.setSecret({ name: "google", value });
			},
		},
	);
	print(`stored Google token as secret \`google\` (scopes: ${scopes.join(", ")}). Run \`ob gmail sync\`.`);
}

// --- 416: already-servable commands -------------------------------------------------------------------

async function apiProject(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === "add") {
		const name = ctx.args[1];
		if (!name) throw new UsageError("project add requires a <name>");
		const kind = ctx.flags.kind;
		if (!kind) throw new UsageError("project add requires --kind (side, home, admin, learning)");
		const key = str(ctx.flags, "key");
		if (key !== undefined) {
			const problem = keyProblem(key.trim().toUpperCase());
			if (problem) throw new UsageError(problem);
		}
		const icon = str(ctx.flags, "icon");
		const displayName = str(ctx.flags, "display-name");
		const res = await ctx.client.projectCreate({
			name,
			kind,
			remote: str(ctx.flags, "remote") ?? null,
			...(key ? { key } : {}),
			...(icon !== undefined ? { icon: parseProjectLabel("icon", icon) } : {}),
			...(displayName !== undefined ? { display_name: parseProjectLabel("display-name", displayName) } : {}),
		});
		emitId(ctx, res.project.id);
		return;
	}
	if (sub === "edit") {
		const name = ctx.args[1];
		if (!name) throw new UsageError("project edit requires a <name>");
		const patch = parseProjectPatch({
			remote: str(ctx.flags, "remote"),
			kind: str(ctx.flags, "kind"),
			key: str(ctx.flags, "key"),
			icon: str(ctx.flags, "icon"),
			displayName: str(ctx.flags, "display-name"),
			stage: str(ctx.flags, "stage"),
		});
		const res = await ctx.client.projectEdit(name, patch);
		emitId(ctx, res.project.id);
		return;
	}
	if (sub === "rename") {
		const [, oldName, newName] = ctx.args;
		if (!oldName || !newName) throw new UsageError("project rename requires <old> <new>");
		const res = await ctx.client.projectRename(oldName, { name: newName });
		emitId(ctx, res.project.id);
		return;
	}
	if (sub === "rm") {
		const name = ctx.args[1];
		if (!name) throw new UsageError("project rm requires a <name>");
		const res = await ctx.client.projectRemove(name, ctx.flags.force === true);
		emitId(ctx, res.project.id);
		return;
	}
	// 1803: the repo-private half is files on THIS machine (OmniSlash's `repos/`), so it never crosses the wire.
	if (sub === "rules" || sub === "wire") {
		// OB-2103: only the stage crosses it, one `GET /projects` read.
		await projectRepoPrivate(sub, ctx.args[1], ctx.flags.dir, ctx.mode, async (n) => stageIn((await ctx.client.projects()).projects, n));
		return;
	}
	if (sub === "list" || sub === undefined) {
		const res = await ctx.client.projects();
		if (ctx.mode === "json") print(JSON.stringify(res.projects, null, 2));
		else if (ctx.mode === "quiet") print(res.projects.map((p) => p.id).join("\n"));
		else print(renderProjectList(res.projects));
		return;
	}
	throw new UsageError(`unknown project subcommand '${sub}' (add|edit|rename|rm|list|rules|wire)`);
}

/** OB-2006: the wiki pages are files on THIS machine; the project list, items and checkouts come over the API. */
async function apiWiki(ctx: ApiCtx): Promise<void> {
	const w: WikiCtx = {
		args: ctx.args,
		mode: ctx.mode,
		flags: ctx.flags,
		src: {
			projects: async () => (await ctx.client.projects()).projects,
			checkouts: async () => {
				const res = await ctx.client.config("repo_checkouts");
				return parseJsonMap(res.config.find((c) => c.key === "repo_checkouts")?.value ?? "");
			},
			tasks: async (projectId) =>
				(await ctx.client.items({ project: projectId })).items.map((i) => ({
					id: i.id,
					type: i.type,
					ref: i.ref,
					title: i.title,
					status: i.status,
					priority: i.priority ?? "none",
					closed_at: i.closed_at,
				})),
		},
	};
	await runWiki(w);
	if (w.exit !== undefined) ctx.exit = w.exit;
}

async function apiBrief(ctx: ApiCtx): Promise<void> {
	if (ctx.flags["in-flight"]) {
		const res = await ctx.client.brief({ in_flight: true });
		const b = res.brief as AnyBrief;
		if (ctx.mode === "json") print(JSON.stringify(b, null, 2));
		else if (ctx.mode === "quiet") print(briefQuiet(b));
		else print(renderBrief(b));
		return;
	}
	const arg = ctx.args[0];
	if (!arg) throw new UsageError("brief requires an <id> or --in-flight");
	const res = await ctx.client.brief({ q: arg });
	const b = res.brief as AnyBrief;
	if (ctx.mode === "json") print(JSON.stringify(b, null, 2));
	else if (ctx.mode === "quiet") print(briefQuiet(b));
	else print(renderBrief(b));
}

async function apiLog(ctx: ApiCtx): Promise<void> {
	const first = ctx.args[0];
	if (first === "list") {
		const typeFlag = str(ctx.flags, "type");
		if (typeFlag && !isJournalType(typeFlag)) {
			throw new UsageError(`--type must be one of ${JOURNAL_TYPES.join("|")}`);
		}
		const res = await ctx.client.logList({ type: typeFlag, since: str(ctx.flags, "since") });
		if (ctx.mode === "json") print(JSON.stringify(res.entries, null, 2));
		else if (ctx.mode === "quiet") print(res.entries.map((e) => e.text).join("\n"));
		else print(renderJournalList(res.entries));
		return;
	}
	if (!first) throw new UsageError(`log requires a type (${JOURNAL_TYPES.join("|")}) or 'list'`);
	if (!isJournalType(first)) {
		throw new UsageError(`log type must be one of ${JOURNAL_TYPES.join("|")} (got '${first}')`);
	}
	const text = ctx.args.slice(1).join(" ");
	if (text.length === 0) throw new UsageError(`log ${first} requires a "<text>"`);
	const res = await ctx.client.logCreate({
		type: first,
		text,
		about: str(ctx.flags, "about") ?? null,
		item: str(ctx.flags, "item") ?? null,
	});
	if (ctx.mode === "json") print(JSON.stringify(res.entry));
	else if (ctx.mode !== "quiet") print(renderJournalCapture(res.entry));
}

async function apiDeploy(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === "record") {
		const target = str(ctx.flags, "target");
		const host = str(ctx.flags, "host");
		const unit = str(ctx.flags, "unit");
		const sha = str(ctx.flags, "sha");
		const result = str(ctx.flags, "result");
		if (!target || !host || !unit || !sha || !result) {
			throw new UsageError("deploy record requires --target --host --unit --sha --result");
		}
		if (!DEPLOY_RESULTS.includes(result as never)) {
			throw new UsageError(`--result must be one of ${DEPLOY_RESULTS.join("|")}, not '${result}'`);
		}
		const at = str(ctx.flags, "at");
		const res = await ctx.client.deployRecord({
			target,
			host,
			unit,
			sha,
			at: at || undefined,
			result: result as "ok" | "rolled-back" | "refused",
		});
		if (ctx.mode === "json") print(JSON.stringify(res.deploy, null, 2));
		else if (ctx.mode !== "quiet") {
			const d = res.deploy;
			// OB-1926: a write older than the stored row is ignored; the read-back says which one stands.
			print(
				d.sha === sha && d.result === result
					? `recorded ${d.result} for ${d.target} @ ${d.sha.slice(0, 8)}`
					: `ignored: the ${d.target} row is newer (${d.result} @ ${d.sha.slice(0, 8)}, ${d.at})`,
			);
		}
		return;
	}
	if (sub === "run") {
		const pin = ctx.flags.sha;
		if (pin !== undefined && (typeof pin !== "string" || !DEPLOY_SHA_RE.test(pin))) {
			throw new UsageError(`deploy run --sha must be a commit id (7-40 lowercase hex), not '${String(pin)}'`);
		}
		await (ctx.flags.ssh === true ? kickOverSsh(ctx, pin) : kickOverApi(ctx, pin));
		if (ctx.mode === "json") print(JSON.stringify({ kicked: true, target: LIVE_DEPLOY_TARGET, ...(pin === undefined ? {} : { sha: pin }) }));
		else if (ctx.mode !== "quiet") print(pin === undefined ? "live deploy kicked" : `live deploy kicked, pinned to ${pin}`);
		return;
	}
	if (sub !== undefined && sub !== "status") {
		throw new UsageError(`unknown deploy subcommand '${sub}' (status|record|run)`);
	}
	const res = await ctx.client.deploys();
	if (ctx.mode === "json") print(JSON.stringify(res.deploys, null, 2));
	else if (ctx.mode === "quiet") print(res.deploys.map((r) => r.target).join("\n"));
	else print(renderDeploys(res.deploys));
}

/**
 * OB-1809: the kick is an API call now. It never falls back to ssh by itself: a kick whose answer was lost may
 * have started, and a second one on top of it is a person's call, made with --ssh after reading the status.
 */
async function kickOverApi(ctx: ApiCtx, pin: string | undefined): Promise<void> {
	const fallback = `ob deploy run --ssh${pin === undefined ? "" : ` --sha ${pin}`}`;
	try {
		await ctx.client.deployRun(pin === undefined ? {} : { sha: pin });
	} catch (e) {
		if (!(e instanceof ApiError)) throw e;
		if (e.status === 0 || e.status >= 500) {
			throw new AppError(`${e.message}. The deploy may have started: check ob deploy status first. The last resort if the API is down: ${fallback}`);
		}
		throw e;
	}
}

/** The named last resort for when the API is down, so nothing about it may need the API to answer. */
async function kickOverSsh(ctx: ApiCtx, pin: string | undefined): Promise<void> {
	let kicked: boolean;
	try {
		const outcome = await runLiveDeploy({
			list: async () => (await ctx.client.deploys()).deploys,
			record: async (input) => void (await ctx.client.deployRecord(input)),
			ssh: ctx.deploySsh ?? defaultLiveDeploySsh,
			sha: pin,
		});
		kicked = outcome.kicked;
	} catch (e) {
		// The API is the usual reason for the last resort: a failed list stops before a refusal could overwrite the live row.
		throw new AppError(`ssh to ob-host failed; could not record it either: ${(e as Error).message}`);
	}
	if (!kicked) throw new AppError("ssh to ob-host failed; recorded refused for live");
}

async function apiAlerts(ctx: ApiCtx): Promise<void> {
	if (ctx.args[0] === "snooze") {
		const key = ctx.args[1];
		if (!key) throw new UsageError("alerts snooze requires a <key>");
		const res = await ctx.client.alertsSnooze(key);
		if (ctx.mode === "json") print(JSON.stringify({ snoozed: res.snoozed }, null, 2));
		else if (ctx.mode !== "quiet") print(`snoozed ${res.snoozed}`);
		return;
	}
	if (ctx.flags.notify) {
		throw new UsageError("alerts --notify pushes through Home Assistant with the token on the server: run it there (the omnislash-alerts timer does)");
	}
	const res = await ctx.client.alerts();
	if (ctx.mode === "json") print(JSON.stringify(res.alerts, null, 2));
	else if (ctx.mode === "quiet") print(res.alerts.map((a) => a.key).join("\n"));
	else if (ctx.flags.digest) print(renderAlertDigest(res.alerts));
	else print(renderAlerts(res.alerts));
}

async function apiDoc(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === undefined || sub === "list") {
		emitDocList(ctx, (await ctx.client.docs(str(ctx.flags, "project"))).docs);
		return;
	}
	if (sub === "add") {
		const title = ctx.args.slice(1).join(" ");
		if (title.trim().length === 0) throw new UsageError("doc add requires a <title>");
		const project = str(ctx.flags, "project");
		if (project === undefined) throw new UsageError("doc add requires --project <project>");
		const body = bodyFromFlags(ctx.flags);
		if (body === undefined) throw new UsageError("doc add requires --body <text> or --body-file <file>");
		emitDocWritten(ctx, await ctx.client.docCreate({ title, project, body }));
		return;
	}
	if (sub === "show" || sub === "history" || sub === "set") {
		const id = ctx.args[1];
		if (!id) throw new UsageError(`doc ${sub} requires an <id|ref>`);
		if (sub === "set") {
			emitDocWritten(ctx, await ctx.client.docSet(id, { title: str(ctx.flags, "title"), body: bodyFromFlags(ctx.flags) }));
			return;
		}
		const doc = await ctx.client.doc(id);
		if (sub === "history") emitDocHistory(ctx, doc);
		else emitDoc(ctx, doc, str(ctx.flags, "version") !== undefined ? pickVersion(doc, str(ctx.flags, "version")!) : undefined);
		return;
	}
	throw new UsageError(`unknown doc subcommand '${sub}'. usage: ${DOC_USAGE}`);
}

async function apiDecision(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === undefined || sub === "list") {
		const res = await ctx.client.decisions(str(ctx.flags, "status"));
		if (ctx.mode === "json") print(JSON.stringify(res.decisions, null, 2));
		else if (ctx.mode === "quiet") print(res.decisions.map((i) => i.id).join("\n"));
		else print(renderDecisionList(res.decisions));
		return;
	}
	if (sub === "supersede") {
		const newId = ctx.args[1];
		const oldId = ctx.args[2];
		if (!newId || !oldId) throw new UsageError("decision supersede requires <newId> <oldId>");
		const r = await ctx.client.decisionSupersede({ new_id: newId, old_id: oldId });
		if (ctx.mode === "json") print(JSON.stringify(r, null, 2));
		else if (ctx.mode !== "quiet") print(`${r.newId} (accepted) supersedes ${r.oldId} (superseded)`);
		else print(r.newId);
		return;
	}
	const d = await ctx.client.decision(sub);
	if (ctx.mode === "json") print(JSON.stringify(d, null, 2));
	else if (ctx.mode === "quiet") print(d.id);
	else {
		const lines = [`${d.id}  ${d.title}`, `  status:       ${d.status}`];
		const field = (label: string, key: string) => {
			const v = d.detail?.[key];
			if (v !== null && v !== undefined && v !== "") lines.push(`  ${label.padEnd(12)}${String(v)}`);
		};
		field("context:", "context");
		field("choice:", "choice");
		field("rationale:", "rationale");
		field("alternatives:", "alternatives");
		field("doubt:", "doubt");
		field("undo:", "undo");
		field("decided_at:", "decided_at");
		for (const r of d.references) lines.push(`  references:   ${r.direction === "out" ? "->" : "<-"} ${r.id}`);
		if (d.supersedes.length > 0) lines.push(`  supersedes:   ${d.supersedes.join(" -> ")}`);
		if (d.superseded_by.length > 0) lines.push(`  superseded_by:${" "}${d.superseded_by.join(" -> ")}`);
		print(lines.join("\n"));
	}
}

async function apiLearning(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === undefined || sub === "list") {
		const res = await ctx.client.learnings(str(ctx.flags, "status"));
		if (ctx.mode === "json") print(JSON.stringify(res.learnings, null, 2));
		else if (ctx.mode === "quiet") print(res.learnings.map((r) => r.id).join("\n"));
		else print(renderLearningList(res.learnings));
		return;
	}
	const d = await ctx.client.learning(sub);
	if (ctx.mode === "json") print(JSON.stringify(d, null, 2));
	else if (ctx.mode === "quiet") print(d.id);
	else {
		const lines = [`${d.id}  ${d.title}`, `  status:   ${d.status}`];
		const field = (label: string, key: string) => {
			const v = d.detail?.[key];
			if (v !== null && v !== undefined && v !== "") lines.push(`  ${label.padEnd(9)} ${String(v)}`);
		};
		field("kind:", "kind");
		field("progress:", "progress");
		field("source:", "source");
		field("why:", "why");
		for (const r of d.references) lines.push(`  ref:      ${r.direction === "out" ? "->" : "<-"} ${r.id}`);
		print(lines.join("\n"));
	}
}

async function apiMemory(ctx: ApiCtx): Promise<void> {
	await handleMemory(ctx.args, ctx.mode, async (fact) => {
		const res = await ctx.client.createItem({ type: "learning", title: fact });
		return res.id;
	});
}

async function apiRoadmap(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === undefined || sub === "list") {
		const res = await ctx.client.roadmaps();
		if (ctx.mode === "json") print(JSON.stringify(res.roadmaps, null, 2));
		else if (ctx.mode === "quiet") print(res.roadmaps.map((r) => r.id).join("\n"));
		else print(renderRoadmapList(res.roadmaps));
		return;
	}
	if (sub === "add") {
		const roadmapId = ctx.args[1];
		const itemId = ctx.args[2];
		const positionArg = ctx.args[3];
		if (!roadmapId || !itemId) throw new UsageError("roadmap add requires <roadmapId> <itemId> [position]");
		let position: number | undefined;
		if (positionArg !== undefined) {
			position = Number(positionArg);
			if (!Number.isInteger(position)) throw new UsageError(`invalid position '${positionArg}'`);
		}
		const res = await ctx.client.roadmapAddMember(roadmapId, { item_id: itemId, position });
		emitId(ctx, res.id, res.ref);
		return;
	}
	const d = await ctx.client.roadmap(sub);
	if (ctx.mode === "json") print(JSON.stringify(d, null, 2));
	else if (ctx.mode === "quiet") print(d.members.map((m) => m.id).join("\n"));
	else {
		const lines = [`${d.id}  ${d.title}`, `  status:      ${d.status}`];
		if (d.target_date) lines.push(`  target:      ${d.target_date}`);
		if (d.source_ref) lines.push(`  source-ref:  ${d.source_ref}`);
		if (d.owner) lines.push(`  owner:       ${d.owner}`);
		lines.push(`  progress:    ${d.progress.done}/${d.progress.total} (${Math.round(d.progress.fraction * 100)}%)`);
		const trackLine =
			d.on_track.verdict === "no_target"
				? "no target date"
				: `${d.on_track.verdict} (elapsed ${Math.round((d.on_track.elapsedFraction ?? 0) * 100)}%)`;
		lines.push(`  on-track:    ${trackLine}`);
		if (d.members.length > 0) {
			lines.push("  members:");
			for (const m of d.members) {
				const marker = m.status === "done" || m.status === "archived" || m.status === "merged" || m.closed_at !== null ? "x" : " ";
				lines.push(`    [${marker}] ${m.id}\t${m.status.padEnd(9)}\t${m.title}`);
			}
		}
		print(lines.join("\n"));
	}
}

async function apiStandup(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === "save") {
		const md = (await Bun.stdin.text()).trim();
		if (!md) throw new UsageError("ob standup save reads the standup markdown from stdin");
		const res = await ctx.client.standupSave({ md });
		print(`saved standup for ${res.date}`);
		return;
	}
	if (sub === "set") {
		const md = (await Bun.stdin.text()).trim();
		if (!md) throw new UsageError("ob standup set reads the edited markdown from stdin");
		const res = await ctx.client.standupSet({ md });
		print(`updated standup for ${res.date}`);
		return;
	}
	if (sub === "posted") {
		const res = await ctx.client.standupPosted();
		print(res.posted ? `marked ${res.date} posted` : `no standup for ${res.date}`);
		return;
	}
	if (sub === "latest" || sub === undefined) {
		const res = await ctx.client.standupLatest();
		if (ctx.mode === "json") print(JSON.stringify(res.standup));
		else print(res.standup ? (effectiveText(res.standup) ?? "(empty)") : "no standup yet");
		return;
	}
	throw new UsageError(`unknown standup subcommand '${sub}' (save|set|latest|posted)`);
}

async function apiSlack(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0] ?? "unread";
	if (sub === "sync") {
		throw new UsageError(
			"slack sync is retired (ob 208): it needed a Slack token that never existed, and work Slack awareness now comes from the Claude Slack connector. `slack unread` still reads what was ingested.",
		);
	}
	if (sub === "unread") {
		const limit = ctx.flags.limit ? Number(ctx.flags.limit) : 20;
		if (!Number.isFinite(limit) || limit <= 0) {
			throw new UsageError("slack unread --limit must be a positive number");
		}
		const res = await ctx.client.slackUnread(limit);
		if (ctx.mode === "json") print(JSON.stringify(res.messages, null, 2));
		else if (ctx.mode === "quiet") print(res.messages.map((r) => String(r.id)).join("\n"));
		else print(renderSlackUnread(res.messages));
		return;
	}
	throw new UsageError(`unknown slack subcommand '${sub}' (unread)`);
}

function flagStr(ctx: ApiCtx, key: string): string | undefined {
	return str(ctx.flags, key);
}

async function apiPerson(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === "add") {
		const realName = ctx.args[1];
		if (!realName) throw new UsageError('person add requires a "<real name>"');
		const res = await ctx.client.peopleCreate({
			real_name: realName,
			fields: personFieldsFromFlags(ctx.flags as Record<string, unknown>, false),
		});
		if (ctx.mode === "json") print(JSON.stringify({ id: res.person.id, real_name: res.person.real_name }));
		else if (ctx.mode === "quiet") print(String(res.person.id));
		else print(`${res.person.id}\t${personDisplay(res.person)}`);
		return;
	}
	if (sub === "set") {
		const id = Number(ctx.args[1]);
		if (!Number.isInteger(id)) throw new UsageError("person set requires a numeric <id>");
		const res = await ctx.client.peopleSet({
			id,
			fields: personFieldsFromFlags(ctx.flags as Record<string, unknown>, true),
		});
		if (ctx.mode === "json") print(JSON.stringify({ id: res.person.id, real_name: res.person.real_name }));
		else print(`${res.person.id}\t${personDisplay(res.person)}`);
		return;
	}
	if (sub === "list") {
		const res = await ctx.client.people();
		if (ctx.mode === "json") print(JSON.stringify(res.people, null, 2));
		else if (ctx.mode === "quiet") print(res.people.map((r) => r.real_name).join("\n"));
		else print(renderPersonList(res.people));
		return;
	}
	if (sub === "show") {
		const key = ctx.args[1];
		if (!key) throw new UsageError("person show requires an <id>, <handle>, or <name>");
		const res = await ctx.client.peopleShow(key, ctx.flags.reveal === true);
		if (ctx.mode === "json") print(JSON.stringify(res.person, null, 2));
		else print(renderPersonShow(res.person, ctx.flags.reveal === true));
		return;
	}
	if (sub === "rm") {
		const id = Number(ctx.args[1]);
		if (!Number.isInteger(id)) throw new UsageError("person rm requires a numeric <id>");
		await ctx.client.peopleRm({ id });
		if (ctx.mode !== "quiet") print(`removed person ${id}`);
		return;
	}
	throw new UsageError(`unknown person subcommand '${sub ?? ""}' (add|set|list|show|rm)`);
}

async function apiWhois(ctx: ApiCtx): Promise<void> {
	const handle = ctx.args[0];
	if (!handle) throw new UsageError("whois requires a <handle>");
	const res = await ctx.client.whois(handle);
	if (ctx.mode === "json") print(JSON.stringify(redactPerson(res.person), null, 2));
	else if (ctx.mode === "quiet") print(res.person.real_name);
	else print(personDisplay(res.person));
}

/**
 * `ob tournament` (OB-2271) over the API. The command is `runTournament`, the local one; only the backend differs.
 * The match file is read here, on the caller's machine, and sent parsed. A 400 is the caller's error (exit 2)
 * and a 409 the store's refusal (exit 1), exactly as locally.
 */
async function apiTournament(ctx: ApiCtx): Promise<void> {
	const c = ctx.client;
	const be: TournamentBackend = {
		add: async (input) => (await usageOn400(c.tournamentAdd(input))).tournament,
		candidate: async (id, input) => (await usageOn400(c.tournamentCandidate(id, { key: input.key, label: input.label ?? null, images: input.images ? [...input.images] : null, revises: input.revises ?? null }))).candidate,
		record: async (id, match, replace) => (await usageOn400(c.tournamentRecord(id, { match, replace }))).match,
		pick: async (id, candidate, note) => (await usageOn400(c.tournamentPick(id, { candidate, note }))).tournament,
		list: async (repo) => (await usageOn400(c.tournamentList({ repo }))).tournaments,
		show: async (id) => (await usageOn400(c.tournamentShow(id))).tournament,
	};
	await runTournament({ args: ctx.args, flags: ctx.flags as unknown as Record<string, unknown>, mode: ctx.mode }, be);
}

/**
 * `ob ci main` and `ob github hooks` (OB-2276) over the API. The GitHub reads and the T3 sends happen on the API
 * host, which holds the `github` secret and the notice rows; the command and its printing are the local ones.
 */
function apiCiBackend(ctx: ApiCtx): CiBackend {
	const c = ctx.client;
	return {
		list: async (project) => (await usageOn400(c.ciMain({ project }))).reports,
		notify: async (project) => usageOn400(c.ciMainNotify({ project: project ?? null })),
		hooks: async (apply) => (await usageOn400(c.githubHooks(apply))).rows,
	};
}

async function apiCi(ctx: ApiCtx): Promise<void> {
	const c: CiCtx = { args: ctx.args, flags: ctx.flags as unknown as Record<string, unknown>, mode: ctx.mode };
	await runCi(c, apiCiBackend(ctx));
	if (c.exit) ctx.exit = c.exit;
}

async function apiGithub(ctx: ApiCtx): Promise<void> {
	const c: CiCtx = { args: ctx.args, flags: ctx.flags as unknown as Record<string, unknown>, mode: ctx.mode };
	await runGithub(c, apiCiBackend(ctx));
	if (c.exit) ctx.exit = c.exit;
}

/**
 * `ob overnight` (OB-2097) over the API. The command is `runOvernight`, the local one; only the backend differs.
 * A 400 is the caller's error (exit 2) and a 409 the store's refusal (exit 1), exactly as locally.
 */
async function apiOvernight(ctx: ApiCtx): Promise<void> {
	const c = ctx.client;
	const be: OvernightBackend = {
		start: (input) => usageOn400(c.overnightStart(input)),
		decide: async (input) => (await usageOn400(c.overnightDecide(input))).decision,
		summary: async (input) => (await usageOn400(c.overnightSummary(input))).run,
		show: async (input) => (await usageOn400(c.overnightShow(input))).night,
		list: async (input) => (await usageOn400(c.overnightRuns(input))).runs,
	};
	await runOvernight({ args: ctx.args, flags: ctx.flags as Record<string, unknown>, mode: ctx.mode }, be);
}

async function apiReviewMiss(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === "add") {
		const pr = ctx.flags.pr;
		const cls = ctx.flags.class;
		if (!pr) throw new UsageError("review-miss add requires --pr <url>");
		if (!cls) throw new UsageError("review-miss add requires --class <tag>");
		const finding = ctx.args.slice(1).join(" ");
		if (!finding) throw new UsageError('review-miss add requires a "<finding>"');
		const res = await ctx.client.reviewMissAdd({ pr, class: cls, finding, scope: ctx.flags.scope });
		if (ctx.mode === "json") print(JSON.stringify({ class: res.class, scope: res.scope, pr: res.pr }));
		else if (ctx.mode !== "quiet") print(`recorded review_miss: ${res.class} (scope: ${res.scope})`);
		return;
	}
	if (sub === "top") {
		const limit = ctx.flags.limit ? Number(ctx.flags.limit) : 10;
		if (Number.isNaN(limit) || limit < 1) throw new UsageError("--limit must be a positive integer");
		const res = await ctx.client.reviewMissTop({ scope: ctx.flags.scope, limit });
		if (ctx.mode === "json") print(JSON.stringify(res.ranked, null, 2));
		else if (res.ranked.length === 0) {
			if (ctx.mode !== "quiet") print("no review misses recorded");
		} else print(res.ranked.map((r) => `${r.class}\t${r.count}\t${r.last_seen}\tweight=${r.weight.toFixed(3)}`).join("\n"));
		return;
	}
	throw new UsageError(`unknown review-miss subcommand '${sub ?? ""}' (add|top)`);
}

async function apiCursor(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === "get") {
		const [, skill, key] = ctx.args;
		if (!skill || !key) throw new UsageError("cursor get requires <skill> <key>");
		const res = await ctx.client.cursorGet(skill, key);
		print(res.value);
		return;
	}
	if (sub === "set") {
		const [, skill, key, ...rest] = ctx.args;
		const value = rest.join(" ");
		if (!skill || !key) throw new UsageError("cursor set requires <skill> <key> <value>");
		const res = await ctx.client.cursorSet({ skill, key, value });
		print(res.value);
		return;
	}
	throw new UsageError("cursor requires get|set");
}

async function apiTestUser(ctx: ApiCtx): Promise<void> {
	const sub = ctx.args[0];
	if (sub === "add") {
		const label = ctx.args[1];
		if (!label) throw new UsageError("test-user add requires a <label>");
		const value = (await Bun.stdin.text()).trim();
		if (!value) {
			throw new UsageError("test-user add: no secret value on stdin (pipe it in, e.g. `pbpaste | ob test-user add <label>`)");
		}
		const res = await ctx.client.testUserCreate({
			label,
			value,
			role: flagStr(ctx, "role") ?? null,
			email: flagStr(ctx, "email") ?? null,
			workspace: flagStr(ctx, "workspace") ?? null,
			env: flagStr(ctx, "env") ?? null,
			secret_ref: flagStr(ctx, "secret-ref") ?? null,
			notes: flagStr(ctx, "notes") ?? null,
		});
		if (ctx.mode === "json") print(JSON.stringify({ id: res.user.id, label: res.user.label, secret_ref: res.user.secret_ref }));
		else if (ctx.mode === "quiet") print(String(res.user.id));
		else print(`${res.user.id}\t${res.user.label}\t(secret stored: ${res.user.secret_ref})`);
		return;
	}
	if (sub === "list") {
		const res = await ctx.client.testUsers({ role: flagStr(ctx, "role"), env: flagStr(ctx, "env") });
		if (ctx.mode === "json") print(JSON.stringify(res.users, null, 2));
		else if (ctx.mode === "quiet") print(res.users.map((r) => r.label).join("\n"));
		else print(res.users.map((r) => `${r.label}\t${r.role ?? ""}\t${r.email ?? ""}\t${r.workspace ?? ""}\t${r.env ?? ""}\tsecret:${r.secret_present ? "yes" : "no"}`).join("\n"));
		return;
	}
	if (sub === "show") {
		const label = ctx.args[1];
		if (!label) throw new UsageError("test-user show requires a <label>");
		const res = await ctx.client.testUserShow(label);
		if (ctx.mode === "json") print(JSON.stringify({ ...res.user, secret_present: res.secret_present, staleness: res.staleness }, null, 2));
		else {
			const lines = [
				`id:            ${res.user.id}`,
				`label:         ${res.user.label}`,
				`role:          ${res.user.role ?? ""}`,
				`email:         ${res.user.email ?? ""}`,
				`workspace:     ${res.user.workspace ?? ""}`,
				`env:           ${res.user.env ?? ""}`,
				`secret_ref:    ${res.user.secret_ref ?? ""}`,
				`secret_present: ${res.secret_present ? "yes" : "no"}`,
				`secret_set_at: ${res.user.secret_set_at ?? "(unknown)"}`,
				`last_used:     ${res.user.last_used ?? ""}`,
				`notes:         ${res.user.notes ?? ""}`,
			];
			if (res.staleness) lines.push(`⚠ ${res.staleness}`);
			print(lines.join("\n"));
		}
		return;
	}
	if (sub === "check") {
		const label = ctx.args[1];
		if (!label) throw new UsageError("test-user check requires a <label>");
		const res = await ctx.client.testUserCheck({ label });
		if (ctx.mode === "json") print(JSON.stringify(res));
		else print(`${res.label}: store secret '${res.secret_ref}' ${res.secret_present ? "present" : "absent"}`);
		return;
	}
	throw new UsageError(`unknown test-user subcommand '${sub ?? ""}' (add|list|show|check)`);
}

async function apiSync(ctx: ApiCtx): Promise<void> {
	const source = ctx.flags.source;
	if (source && source !== "github") throw new UsageError("--source must be github");
	const res = await ctx.client.sync({ source: source as "github" | undefined, since: ctx.flags.since, backfill: ctx.flags.backfill === true });
	if (ctx.mode === "json") print(JSON.stringify(res, null, 2));
	else {
		const g = res.github;
		print(g ? `synced — github: ${g.prs} PRs, ${g.events} events` : "synced");
	}
}

/**
 * The API-mode handler table. Its keys MUST match API_ROUTED_COMMANDS exactly; api-client-353.test.ts
 * asserts that, so a command cannot be declared routed and then have no handler (or the reverse).
 */
export const API_HANDLERS: Record<string, (ctx: ApiCtx) => Promise<void>> = {
	backup: apiBackup,
	db: apiDb,
	cert: apiCert,
	next: apiNext,
	list: apiList,
	show: apiShow,
	search: apiSearch,
	status: apiStatus,
	add: apiAdd,
	link: apiLink,
	edit: apiEdit,
	rm: apiRm,
	today: apiToday,
	order: apiOrder,
	focus: apiFocus,
	note: apiNote,
	tag: apiTag,
	untag: apiUntag,
	close: apiClose,
	reopen: apiReopen,
	start: simpleState("start", "start"),
	ready: simpleState("ready", "ready"),
	block: simpleState("block", "block"),
	unblock: simpleState("unblock", "unblock"),
	state: apiState,
	agent: apiAgent,
	agents: apiAgents,
	lease: apiLease,
	ports: apiPorts,
	secret: apiSecret,
	cloudflare: apiCloudflare,
	creds: apiCreds,
	config: apiConfig,
	// 169 + 389: `issue` is SPLIT -- list/link/unlink/reconcile are the store (and GitHub cred);
	// landed/drift take pairing from the API and run git HERE.
	issue: apiIssue,
	triage: apiTriage,
	// 360: `spinoff` is SPLIT -- the queue is served, the launch happens on this machine.
	spinoff: apiSpinoff,
	// 1120: `t3` is SPLIT -- doctor/login run here, the architect's thread is opened here, its row is served.
	t3: apiT3,
	role: apiRole,
	send: apiSend,
	inbox: apiInbox,
	// 366: `whatsapp` is SPLIT -- all served (OB-1809) but `bridge run|start|stop`, which refuse by name inside.
	whatsapp: apiWhatsapp,
	// 415: gmail/cal/agenda are served (sync runs on the host).
	// 420/424: google auth RUNS here (loopback) and persists via POST /secrets.
	// 1305: google auth-url is served (the API mints the state and returns the consent URL).
	gmail: apiGmail,
	cal: apiCal,
	agenda: apiAgenda,
	google: apiGoogle,
	project: apiProject,
	wiki: apiWiki,
	brief: apiBrief,
	log: apiLog,
	jobs: apiJobs,
	deploy: apiDeploy,
	alerts: apiAlerts,
	decision: apiDecision,
	doc: apiDoc,
	learning: apiLearning,
	memory: apiMemory,
	roadmap: apiRoadmap,
	standup: apiStandup,
	slack: apiSlack,
	person: apiPerson,
	whois: apiWhois,
	tournament: apiTournament,
	// OB-2276: CI on main and the GitHub hooks; the host reads GitHub and tells the threads.
	ci: apiCi,
	github: apiGithub,
	// OB-2097: the overnight decision log, the same command as locally over an HTTP backend.
	overnight: apiOvernight,
	"review-miss": apiReviewMiss,
	review: apiReview,
	cursor: apiCursor,
	"test-user": apiTestUser,
	sync: apiSync,
};

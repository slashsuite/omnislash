// ob 352 -- the endpoint handlers. One function per purpose-built endpoint, each taking a Store and
// already-validated values, each returning a contract type.
//
// Every one of them calls the SAME core the CLI command calls. That is the point of the whole design: the
// meaning of `close` (the local move, the linked GitHub issue, the event record) lives in one place and is
// reached one way, so the API cannot be a second, subtly different tracker.
//
// Nothing here reads a request, a header or a token; nothing here formats output. Routing and auth are in
// server.ts, and the human-readable rendering stays in the CLI where it belongs.
import { builderIdOf, refKey } from "../../../../platform/cli-coord/src/clean-repo.ts";
import { recordNoFlakeSlot, refuseHeldFlakeSlot } from "../../../../platform/cli-coord/src/spinoff-flake.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Store } from "../db/store.ts";
import { AppError, UsageError } from "../errors.ts";
import {
   addLink,
   addTags,
   appendNote,
  clearTriage,
  createItem,
  deleteItem,
  editItem,
  getItem,
  getTags,
  removeTags,
  triageInbox as triageInboxRows,
} from "../items.ts";
import { triageSnippet } from "../commands/triage.ts";
import { itemView } from "../output.ts";
import { itemDetail } from "../detail.ts";
import { snapshotFrom, WHATSAPP_STATUS_CAP, WHATSAPP_STATUS_DEFAULT } from "../realtime.ts";
import { listWorklist, nextWorklist, type ItemQuery } from "../worklist.ts";
import { searchItemIds } from "../search.ts";
import { getFocusProject, getConfig, setConfig, deleteConfig, allConfig } from "../config.ts";
import { buildStatus } from "../commands/status.ts";
import {
  candidatePairs,
  clearRef,
  gatherLandedStoreFacts,
  issueClashMessage,
  linkUrlClashMessage,
  linkedItems,
  linkIssue,
  listIssues,
  trackerRepo,
  unlinkedOpenItems,
} from "../tracker-link.ts";
import { createIssue, issueLabels } from "../github-issues.ts";
import { VALID_RELS } from "../commands/capture.ts";
import { parsePriority, PRIORITY_OPTIONS, priorityName } from "../priority.ts";
import { clearTodayRank, setQueueOrder, setTodayRank, type QueueMove } from "../workflow.ts";
import { syncIssueState } from "../tracker-link.ts";
import { bareNumberCollision, bareNumberCollisionMessage, keyProblem, ProjectKeyError, refsFor } from "../refs.ts";
import { blockItem, moveItem, readyItem, reopenItem, startItem, unblockItem } from "../workflow.ts";
import { closeAndLand } from "../close.ts";
import {
  acquireLease,
  foreignHold,
  heartbeatLease,
  LeaseExpiredError,
  sweepExpiredLeases,
  heartbeatLeasesByHolder,
  lostLeasesOf,
  leaseStatus,
  recordedHold,
  releaseLease,
} from "../../../../platform/cli-coord/src/lease.ts";
import {
  DEFAULT_AGENT_TTL_S,
  DEFAULT_AGENT_STATUS,
  agentsActiveWithin,
  effectiveLauncher,
  getAgent,
  heartbeatAgent,
  listAgents,
  registerAgent,
  resetAgentsAndLeases,
  setAgentRun,
} from "../../../../platform/cli-coord/src/agent.ts";
import { declaredFilesFor, plannedFilesFor, recordSpinoffCheck, refuseUncheckedDispatch } from "../../../../platform/cli-coord/src/spinoff-check.ts";
import { recordOverlap } from "../../../../platform/cli-coord/src/spinoff-overlap.ts";
import {
  agentLauncherMap,
  claimSpinoffRow,
  cleanupLeaseKeys,
  enqueueSpinoff,
  assertHandoffWorktree,
  findSpinoffForReady,
  landSpinoff,
  recordSpinoffTokens,
  listSpinoffs,
  markSpinoffReady,
  markSpinoffSentBack,
  markSpinoffReopened,
  liveBuildAgentsByRepo,
  pendingSpinoffs,
  readSpinoffLaunchConfig,
  reclaimSpinoffs,
  restoreSentBackRow,
  rowLeaseKeys,
  withFlakeBoxBrief,
  spinoffLeaseKeys,
  spinoffTicketTagsFor,
  stampSpinoff,
  recordSpinoffVerdict,
  recordReadyNoteOutcome,
  trialStoreDeps,
  ticketTitleFor,
  urgentLaunchRow,
  recordOverUsage, recordOverUsageUndone,
  type LauncherName,
} from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { isSpikeTagged } from "../../../../platform/cli-coord/src/spinoff-spike.ts";
import { runTrialOp } from "../../../../platform/cli-coord/src/spinoff-trial.ts";
import { tierFitOf, type SpinoffEffort, type SpinoffTier } from "../t3/dispatch.ts";
import { spinoffRowsServingItem } from "../../../../platform/cli-coord/src/spinoff-item.ts";
import { toStoredSpinoffStatus } from "../../../../platform/cli-coord/src/spinoff-vocab.ts";
import { claimTicketLease, finishAgent, legTicketFor } from "../../../../platform/cli-coord/src/agent-register.ts";
import { getProject, UnknownTeamError } from "../project.ts";
import {
  addTeam,
  editTeam,
  getTeam,
  joinTeam,
  leaveTeam,
  teamInUseRefusal,
  teamView,
  listTeamViews,
  parseTeamLabel,
  removeTeam,
} from "../team.ts";
import { consumeTeamHandoff, latestTeamHandoff, parseTeamRole, recordTeamHandoff, type HandoffFilter } from "../team-handoff.ts";
import { markRoleNoteShown, markRoleRun, openRoleRuns, parseEndReason, updateRoleRun, writeRoleNote } from "../role-run.ts";
import { roleBriefStoreFacts } from "../role-brief.ts";
import { tickFindings } from "../role-tick.ts";
import { listRoleMessages, markRoleMessagesRead, sendRoleMessage, ROLE_MESSAGE_KINDS, type RoleMessageKind } from "../inbox.ts";
import { clearCredentialCheck, defaultMasterKey, getSecret, listSecrets, masterKeyForWrite, removeSecret, setSecret, type MasterKey } from "../secrets.ts";
import {
  DEFAULT_SCOPES,
  buildAuthUrl,
  clientCredsFromStoredGoogleJson,
  httpExchangeAuthCode,
  tokenResponseToGoogleToken,
  type ClientCreds,
  type TokenExchangeResponse,
  type TokenExchanger,
} from "../../../../platform/cli-sources/src/commands/google.ts";
import {
  GOOGLE_REDIRECT_URI_KEY,
  GoogleStateBusyError,
  hostedRedirectUri,
  stateRefusalSentence,
  type GoogleStateStore,
} from "../../../../platform/cli-sources/src/google-hosted.ts";
import {
  CREDENTIAL_NAMES,
  credentialInventory,
  redactDetail,
  runCredentialCheck,
  type CheckDeps,
  type Probes,
} from "../credentials.ts";
import type {
  AcquireLeaseRequest,
  ClaimSpinoffRequest,
  ClaimSpinoffResponse,
  CleanupGuardRequest,
  CleanupGuardResponse,
  EnqueueSpinoffRequest,
  SpinoffCheckRequest,
  SpinoffCheckResponse,
  EnqueueSpinoffResponse,
  LandSpinoffRequest,
  LandSpinoffResponse,
  RecordSpinoffTokensRequest,
  RecordSpinoffTokensResponse,
  ReadySpinoffRequest,
  SendBackSpinoffRequest,
  SendBackSpinoffResponse,
  ReopenSpinoffRequest,
  ReopenSpinoffResponse,
  SpinoffVerdictRequest,
  SpinoffVerdictResponse,
  SpinoffNoteErrorRequest,
  SpinoffNoteErrorResponse,
  SpinoffTrialRequest,
  SpinoffTrialResponse,
  ReadySpinoffResponse,
  LaunchableRequest,
  LaunchableResponse,
  LaunchableSpinoff,
  ReclaimSpinoffsResponse,
  SpinoffConfigResponse,
  SpinoffsQuery,
  SpinoffsResponse,
  SpinoffServingRequest,
  SpinoffPlannedFilesRequest,
  SpinoffPlannedFilesResponse,
  SpinoffOverlapRequest,
  SpinoffOverlapResponse,
  StampSpinoffRequest,
  StampSpinoffResponse,
  AcquireLeaseResponse,
  AgentActiveResponse,
  AgentRequest,
  AgentResponse,
  AgentsResetResponse,
  AgentsResponse,
  CreateItemRequest,
  CreateItemResponse,
  DeleteItemResponse,
  EditItemRequest,
  EditItemResponse,
  FocusRequest,
  FocusResponse,
  GithubIssuesResponse,
  GoogleAuthUrlResponse,
  ItemLinkRequest,
  ItemLinkResponse,
  IssuePairingResponse,
  IssueReconcileResponse,
  TodayRequest,
  TodayResponse,
  CredsCheckRequest,
  CredsCheckResponse,
  CredsResponse,
  HealthResponse,
  ItemResponse,
  ItemsResponse,
  LeasesResponse,
  SweepLeasesResponse,
  NextResponse,
  NoteRequest,
  NoteResponse,
  ReadSecretRequest,
  ReadSecretResponse,
  ReleaseLeaseResponse,
  RemoveSecretRequest,
  RemoveSecretResponse,
  SearchResponse,
  SecretsResponse,
  SetSecretRequest,
  SetSecretResponse,
  StateRequest,
  StateResponse,
  StatusResponse,
  TriageActionResponse,
  TriageResponse,
  TagsRequest,
  TagsResponse,
  TrackerMoveRequest,
  TrackerMoveResponse,
  ConfigResponse,
  ConfigSetRequest,
  ConfigSetResponse,
  IssueLinkRequest,
  IssueLinkResponse,
  IssuesResponse,
  IssueUnlinkRequest,
  IssueUnlinkResponse,
  WhatsappRecentQuery,
  WhatsappRecentResponse,
  WhatsappSendRequest,
  WhatsappSendResponse,
  WhatsappPrefRequest,
  WhatsappPrefResponse,
  WhatsappPrefChatsResponse,
  WhatsappSearchQuery,
  WhatsappSearchResponse,
  GmailSearchQuery,
  GmailSearchResponse,
  GmailListQuery,
  GmailListResponse,
  GmailSyncRequest,
  GmailSyncResponse,
  CalSyncRequest,
  CalSyncResponse,
  AgendaResponse,
  ProjectsResponse,
  ProjectCreateRequest,
  ProjectCreateResponse,
  ProjectEditRequest,
  ProjectEditResponse,
  ProjectRemoveResponse,
  TeamsResponse,
  TeamResponse,
  TeamCreateRequest,
  TeamEditRequest,
  TeamJoinRequest,
  TeamJoinResponse,
  TeamLeaveRequest,
  TeamLeaveResponse,
  TeamRemoveResponse,
  TeamHandoffRequest,
  TeamHandoffConsumeRequest,
  RoleRunMarkRequest,
  RoleRunResponse,
  RoleRunsResponse,
  RoleRunUpdateRequest,
  RoleBriefResponse,
  RoleTickResponse,
  RoleNoteRequest,
  RoleMessageRequest,
  RoleMessageResponse,
  RoleMessagesResponse,
  RoleMessagesReadRequest,
  TeamHandoffResponse,
  ProjectRenameResponse,
  BriefResponse,
  LogQuery,
  LogListResponse,
  LogCreateRequest,
  LogCreateResponse,
  JobsResponse,
  DeploysResponse,
  DeployRecordRequest,
  DeployRecordResponse,
  AlertsResponse,
  AlertSnoozeRequest,
  AlertSnoozeResponse,
  AlertAckRequest,
  AlertAckResponse,
  ItemDetailResponse,
  RankRequest,
  OrderRequest,
  OrderResponse,
  SnapshotResponse,
  TransitionRequest,
  DecisionsResponse,
  DocCreateRequest,
  DocResponse,
  DocSetRequest,
  DocsResponse,
  DecisionShowResponse,
  DecisionSupersedeRequest,
  DecisionSupersedeResponse,
  LearningsResponse,
  LearningShowResponse,
  RoadmapsResponse,
  RoadmapShowResponse,
  RoadmapAddMemberRequest,
  RoadmapAddMemberResponse,
  StandupLatestResponse,
  StandupWriteRequest,
  StandupWriteResponse,
  StandupPostedResponse,
  SlackUnreadQuery,
  SlackUnreadResponse,
} from "./contract.ts";
import { latestPerChat, recentWhatsapp, searchWhatsapp } from "../../../../platform/cli-whatsapp/src/ingest/whatsapp.ts";
import { recentEmail, searchEmail, syncGmail } from "../../../../platform/cli-sources/src/ingest/gmail.ts";
import { agendaToday, syncCalendar } from "../../../../platform/cli-sources/src/ingest/calendar.ts";
import { mergeGoogleToken, previousGoogleToken, type GmailDraftClient, type GoogleClient } from "../../../../platform/cli-sources/src/google.ts";
import {
  createGmailDraft,
  deleteGmailDraft,
  editGmailDraft,
  gmailDraftClientFor,
  listGmailDrafts,
  sendGmailDraft,
  showGmailDraft,
  type GmailDeleteDraftResult,
  type GmailDraftEdit,
  type GmailDraftPreview,
  type GmailDraftRequest,
  type GmailSendDraftResult,
} from "../../../../platform/cli-sources/src/gmail-draft.ts";
import {
  fetchGmailAttachments,
  readGmailMessage,
  type GmailAttachmentsResult,
  type GmailMessageRead,
} from "../../../../platform/cli-sources/src/gmail-message.ts";
import { ApiFault } from "./fault.ts";
import { inScope, type ProjectScope } from "../project-scope.ts";

/**
 * OB-1754: the OB-1751 refusal, on the server. In API mode the CLI sends what the human typed, so a bare number that is
 * the internal id of one item AND the `OB-<n>` key of another must be refused HERE, naming both, and write nothing.
 * Every item endpoint is called with typed input (the dashboard does not use them), so there is no trusted bypass.
 * A 400 `invalid_request`: the client prints the message and exits non-zero.
 */
/**
 * Refuse a bare number that reads as two different items. Returns the id to look up.
 *
 * OS-178: with a scope, a reading the token cannot see is no reading at all. When only the OB-<n> item is
 * visible the number means that item; when only the id item (or neither) is, it means the id, which then
 * resolves or 404s as usual. Only when both are visible is it refused, with a message naming neither, since
 * the full message carries ids and refs.
 */
async function refuseAmbiguousBareNumber(store: Store, id: string, scope?: ProjectScope): Promise<string> {
  const collision = await bareNumberCollision(store, id);
  if (!collision) return id;
  if (!scope) throw new ApiFault("invalid_request", 400, bareNumberCollisionMessage(collision));
  const visible = async (itemId: string) => {
    const row = await getItem(store, itemId);
    return row !== null && inScope(scope, row.project_id);
  };
  const [idVisible, keyVisible] = await Promise.all([visible(collision.idItem), visible(collision.keyItem)]);
  if (idVisible && keyVisible) throw new ApiFault("invalid_request", 400, `'${id}' is ambiguous; ask for the item by its ref`);
  return keyVisible ? collision.keyItem : id;
}

/**
 * `trusted`: `id` is an internal id this handler already resolved (an earlier `requireItem`, or a row it just created), not typed input.
 * `scope` (OS-178): a scoped token's projects. An item outside them is the same 404 as a missing one, so its existence does not leak.
 */
async function requireItem(store: Store, id: string, opts: { trusted?: boolean; scope?: ProjectScope } = {}) {
  const lookup = opts.trusted ? id : await refuseAmbiguousBareNumber(store, id, opts.scope);
  const item = await getItem(store, lookup);
  if (!item || !inScope(opts.scope, item.project_id)) throw new ApiFault("not_found", 404, `no item '${id}'`);
  return item;
}

/** OS-178: the focus project is a project id, so a scoped token sees it only when it is one of its own. */
function focusInScope(scope: ProjectScope | undefined, focus: string | null): string | null {
  return !scope || (focus !== null && scope.ids.has(focus)) ? focus : null;
}

/** OS-178: a `?project=` a scoped token names must be one of its projects; any other is the unknown-project 404. */
async function requireScopedProject(store: Store, scope: ProjectScope | undefined, project: string | undefined): Promise<void> {
  if (!scope || project === undefined) return;
  const p = await getProject(store, project);
  if (!p || !scope.ids.has(p.id)) throw new ApiFault("not_found", 404, `no project '${project}'`);
}

export async function health(store: Store): Promise<HealthResponse> {
  return { ok: true, store: store.kind };
}

/** `ob config` (list) and `ob config get <k>`: the config table, one key or all of it. A missing key reads
 *  as `{ key, value: null }` rather than 404, so the CLI's `print(value ?? "")` semantics hold unchanged. */
export async function configRead(store: Store, key: string | null): Promise<ConfigResponse> {
  if (key !== null) {
    return { config: [{ key, value: await getConfig(store, key) }] };
  }
  return { config: await allConfig(store) };
}

/** `ob config set <k> <v>`: the server stays the source of truth, so the write is a plain upsert. */
export async function configSet(store: Store, req: ConfigSetRequest): Promise<ConfigSetResponse> {
  if (req.value === null) await deleteConfig(store, req.key);
  else await setConfig(store, req.key, req.value);
  return { key: req.key, value: req.value };
}

// --- the ob<->issue pairs (169) -----------------------------------------------------------------------
//
// `ob issue link`/`unlink`/`list` are the STORE half of the command, and the store is the server's. The
// repo defaults server-side (a bare `#<n>` names no repo), and the clash check `ob issue link` makes -- an
// issue already paired with a DIFFERENT item -- is made here too, because the client cannot see the link
// table. `landed`/`drift` take pairing facts from here and run git on the client (389). `reconcile` and
// `add --issue` use the GitHub credential on this host.

/** `ob issue list`: every item that carries a GitHub issue link, sorted by issue number like the CLI. */
export async function issueLinks(store: Store): Promise<IssuesResponse> {
  const links = (await linkedItems(store)).sort((a, b) => a.ref.number - b.ref.number);
  return {
    issues: links.map((l) => ({ id: l.item_id, status: l.status, title: l.title, issue: l.ref.number, repo: l.ref.repo })),
  };
}

/** `ob issue link <id> <#n|url>`. The repo is resolved HERE (default `wayfinder_repo`), not on the client. */
export async function issueLink(store: Store, req: IssueLinkRequest): Promise<IssueLinkResponse> {
  const item = await requireItem(store, req.item_id);
  const repo = req.repo ?? (await trackerRepo(store));
  // The same clash `ob issue link` refuses: one issue number belongs to ONE item.
  const clash = await issueClashMessage(store, { repo, number: req.number }, item.id);
  if (clash) throw new ApiFault("refused", 409, clash);
  const link = await linkIssue(store, item.id, { repo, number: req.number });
  return { id: item.id, issue: link.number, repo: link.repo, url: link.url };
}

/** `ob issue unlink <id>`: clear whichever reference the item holds, GitHub issue or Linear (138). */
export async function issueUnlink(store: Store, req: IssueUnlinkRequest): Promise<IssueUnlinkResponse> {
  const item = await requireItem(store, req.item_id);
  const cleared = await clearRef(store, item.id);
  return {
    id: item.id,
    kind: cleared?.kind ?? null,
    issue: cleared?.kind === "issue" ? cleared.issue : null,
    linear_id: cleared?.kind === "linear" ? cleared.linear_id : null,
    url: cleared?.url ?? null,
  };
}

/** Store facts `ob issue landed` / `drift` consume on the client. No git. */
export async function issuePairing(store: Store): Promise<IssuePairingResponse> {
  const [facts, links, repo, idRows] = await Promise.all([
    gatherLandedStoreFacts(store),
    linkedItems(store),
    trackerRepo(store),
    store.q.select({ id: store.t.item.id }).from(store.t.item) as Promise<Array<{ id: string }>>,
  ]);
  return {
    tracker_repo: repo,
    issues: links.map((l) => ({
      id: l.item_id,
      status: l.status,
      type: l.type,
      title: l.title,
      issue: l.ref.number,
      repo: l.ref.repo,
    })),
    unlinked_ob_ids: [...facts.unlinkedObItems],
    spinoffs: facts.allSpinoffs.map((s) => {
      const merged = facts.mergedSpinoffs.some((m) => m.branch === s.branch && m.ticket_ref === s.ticket_ref);
      return { ticket_ref: s.ticket_ref, branch: s.branch, base_sha: s.base_sha, status: merged ? "merged" : "other" };
    }),
    item_ids: idRows.map((r) => r.id),
  };
}

/** The wayfinder-labelled GitHub issues. Credential stays on this host. */
export async function githubIssues(store: Store): Promise<GithubIssuesResponse> {
  const repo = await trackerRepo(store);
  const issues = await listIssues(store, repo);
  return {
    repo,
    issues: issues.map((i) => ({ number: i.number, title: i.title, state: i.state })),
  };
}

/** `ob issue reconcile`: candidate pairs. Never links anything. */
export async function issueReconcile(store: Store, limit: number): Promise<IssueReconcileResponse> {
  const repo = await trackerRepo(store);
  const issues = await listIssues(store, repo);
  const linked = new Set((await linkedItems(store)).map((l) => l.ref.number));
  const candidates = candidatePairs(
    await unlinkedOpenItems(store),
    issues.map((i) => ({ number: i.number, title: i.title, state: i.state })),
    linked,
  ).slice(0, limit);
  return { repo, candidates };
}

/** An item's current ref, or null (1949): what a write's response echoes so the client prints `PS-12`. */
async function refOf(store: Store, id: string): Promise<string | null> {
  return (await refsFor(store, [id])).get(id) ?? null;
}

/** `ob link <from> <rel> <to>`. */
export async function itemLink(store: Store, from: string, req: ItemLinkRequest): Promise<ItemLinkResponse> {
  if (!VALID_RELS.includes(req.rel)) {
    throw new ApiFault("invalid_request", 400, `invalid rel '${req.rel}' (expected: ${VALID_RELS.join(", ")})`);
  }
  from = (await requireItem(store, from)).id;
  const to = (await requireItem(store, req.to)).id;
  await addLink(store, from, req.rel, to);
  return { id: from, ref: await refOf(store, from) };
}

/** `ob edit <id>`. */
export async function edit(
  store: Store,
  id: string,
  req: EditItemRequest & { priorityValue?: number | null },
): Promise<EditItemResponse> {
  id = (await requireItem(store, id)).id;
  const fields: Parameters<typeof editItem>[2] = {};
  if (req.title !== undefined) fields.title = req.title;
  if (req.body !== undefined) fields.body = req.body;
  if (req.priorityValue !== undefined) fields.priority = req.priorityValue;
  if (req.project !== undefined) {
    if (req.project === null || req.project === "") {
      fields.projectId = null;
    } else {
      const p = await getProject(store, req.project);
      fields.projectId = p ? p.id : req.project;
    }
  }
  await editItem(store, id, fields, { note: req.note, actor: req.actor });
  return { id, ref: await refOf(store, id) };
}

/** `ob rm <id>`. */
export async function remove(store: Store, id: string): Promise<DeleteItemResponse> {
  const row = await requireItem(store, id);
  await deleteItem(store, row.id);
  return { id: row.id, ref: row.ref ?? null };
}

/** `ob today`. */
export async function today(store: Store, req: TodayRequest): Promise<TodayResponse> {
  if (req.clear && !req.id) {
    await clearTodayRank(store);
    return { cleared: true };
  }
  if (!req.id) throw new ApiFault("invalid_request", 400, "today requires an id (or clear without one)");
  const id = (await requireItem(store, req.id)).id;
  if (req.clear) {
    await clearTodayRank(store, id);
    return { id, ref: await refOf(store, id), cleared: true };
  }
  await setTodayRank(store, id, req.rank);
  return { id, ref: await refOf(store, id) };
}

/** `ob focus` read. */
export async function focusRead(store: Store): Promise<FocusResponse> {
  return { focus_project: await getFocusProject(store) };
}

/** `ob focus` set/clear. */
export async function focusSet(store: Store, req: FocusRequest): Promise<FocusResponse> {
  if (req.clear) {
    await deleteConfig(store, "focus_project");
    return { focus_project: null, cleared: true };
  }
  const name = req.project?.trim();
  if (!name) throw new ApiFault("invalid_request", 400, "focus set requires a project");
  const project = await getProject(store, name);
  if (!project) throw new ApiFault("not_found", 404, `no project '${name}' (create it with: ob project add ${name} --kind <k>)`);
  await setConfig(store, "focus_project", project.id);
  return { focus_project: project.id };
}

// --- /triage (375) ------------------------------------------------------------------------------------
//
// The same functions `ob triage` calls -- `triageInbox`, `clearTriage`, `closeAndLand` -- so the inbox has
// one set of semantics whether `ob` reached the store directly or over HTTP. The snippet lives in the
// shared commands/triage.ts module for the same reason: the note a client renders is byte-identical to
// the one the local command prints, because both halves call the same truncator.

/** `ob triage`: the inbox, newest first, each row carrying the snippet the local renderer prints. */
export async function triageInbox(store: Store): Promise<TriageResponse> {
  const rows = await triageInboxRows(store);
  return {
    items: rows.map((i) => ({
      id: i.id,
      title: i.title,
      origin_repo: i.origin_repo,
      note: triageSnippet(i.body),
    })),
  };
}

/**
 * `ob triage clear <id>`: drop the flag, keep the item exactly as it is. A missing item is a named 404,
 * the same sentence `requireItem` gives every other endpoint.
 */
export async function triageClear(store: Store, id: string): Promise<TriageActionResponse> {
  id = (await requireItem(store, id)).id;
  await clearTriage(store, id);
  const after = await requireItem(store, id, { trusted: true });
  return { id, ref: after.ref ?? null, status: after.status };
}

/**
 * `ob triage reject <id>`: the whole close, through `closeAndLand` like `/close` (validated, on the trail,
 * spinoff rows landed, issue mirrored), and the close clears the flag. The client never closes; it would be
 * a second door to the same move, and a half-close (flag cleared, item still open) is exactly the state the
 * local command never leaves.
 */
export async function triageReject(store: Store, id: string): Promise<TrackerMoveResponse> {
  id = (await requireItem(store, id)).id;
  // OB-1928: the same close door as `/close`: validated, on the trail, clears the flag, lands the spinoff
  // rows, then mirrors onto the linked issue (a GitHub failure is `issue_error`, never a 500).
  const marked = await closeAndLand(store, id);
  if (marked.error) console.error(`spinoff: ${id} closed, but its spinoff rows were not marked landed: ${marked.error}`);
  return trackerMove(store, id, "closed", { github: true });
}

// --- /whatsapp (366) ----------------------------------------------------------------------------------
//
// The same functions `ob whatsapp search` / `ob whatsapp recent` call, so a hit over HTTP is the same
// row the local command would have printed. sync/send/bridge have no handlers here on purpose.

/** `ob whatsapp search <query>`: FTS over ingested message content. */
export async function whatsappSearch(store: Store, query: WhatsappSearchQuery): Promise<WhatsappSearchResponse> {
  const hits = await searchWhatsapp(store, query.q, query.limit ?? 20);
  return { hits };
}

/** `ob whatsapp recent [--limit] [--since]`: most-recent ingested messages. */
export async function whatsappRecent(store: Store, query: WhatsappRecentQuery): Promise<WhatsappRecentResponse> {
  const hits = await recentWhatsapp(store, { since: query.since, limit: query.limit ?? 20 });
  return { hits };
}

/**
 * OB-1765: the Status tray (last 24h) or, with `before`, a history page. The sidecar's /api/whatsapp/status
 * over HTTP: the same two cores, the same caps.
 */
export async function whatsappStatus(store: Store, query: WhatsappStatusQuery): Promise<WhatsappStatusResponse> {
  const limit = Math.min(query.limit ?? WHATSAPP_STATUS_DEFAULT, WHATSAPP_STATUS_CAP);
  return query.before
    ? statusHistoryPage(store, { limit, before: query.before, senderJid: query.sender })
    : statusTray(store);
}

/** OB-1765: the chat list (latest message per chat), the dashboard feed's reader. Read-only. */
export async function whatsappChats(store: Store, query: WhatsappChatsQuery): Promise<WhatsappChatsResponse> {
  const limit = Math.min(query.limit ?? WHATSAPP_CHATS_DEFAULT, WHATSAPP_CHATS_CAP);
  return { chats: await latestPerChat(store, { limit, includeHidden: query.hidden === true }) };
}

// --- /gmail + /cal (415) ------------------------------------------------------------------------------
//
// The same functions `ob gmail` / `ob cal` / `ob agenda` call. sync takes an optional GoogleClient so
// tests inject a fixture and never hit Google; production leaves it undefined and the ingest layer
// builds HttpGoogleClient from secret `google` (or the host token file).

/** `ob gmail search <query>`: FTS over ingested email. */
export async function gmailSearch(store: Store, query: GmailSearchQuery): Promise<GmailSearchResponse> {
  const hits = await searchEmail(store, query.q, query.limit ?? 20);
  return { hits };
}

/** `ob gmail list [--limit] [--since]`: most-recent ingested email. */
export async function gmailList(store: Store, query: GmailListQuery): Promise<GmailListResponse> {
  const hits = await recentEmail(store, { since: query.since, limit: query.limit ?? 20 });
  return { hits };
}

/** `ob gmail sync`: poll Gmail on THIS host using secret `google`. `client` is the test seam. */
export async function gmailSync(
  store: Store,
  req: GmailSyncRequest = {},
  client?: GoogleClient,
): Promise<GmailSyncResponse> {
  return syncGmail(store, req, client);
}

/** `ob gmail read <id>`: one message's headers, text and attachment list. Read-only. */
export async function gmailMessageRead(store: Store, id: string, client?: GmailDraftClient): Promise<GmailMessageRead> {
  return readGmailMessage(client ?? (await gmailDraftClientFor(store)), id);
}

/** `ob gmail attachment <id>`: the attachments' bytes (all, or the one `name`). The CLI saves them. */
export async function gmailMessageAttachments(
  store: Store,
  id: string,
  name?: string,
  client?: GmailDraftClient,
): Promise<GmailAttachmentsResult> {
  return fetchGmailAttachments(client ?? (await gmailDraftClientFor(store)), id, name);
}

/** `ob gmail draft`: create a Gmail DRAFT on THIS host. Never sends. `client` is the test seam. */
export async function gmailDraftCreate(
  store: Store,
  req: GmailDraftRequest,
  client?: GmailDraftClient,
): Promise<GmailDraftPreview> {
  return createGmailDraft(client ?? (await gmailDraftClientFor(store)), req);
}

/** OB-1750 `ob gmail drafts`: the newest drafts with their recipients and subjects. Reads only. */
export async function gmailDraftList(store: Store, limit?: number, client?: GmailDraftClient): Promise<{ drafts: GmailDraftPreview[] }> {
  return { drafts: await listGmailDrafts(client ?? (await gmailDraftClientFor(store)), limit) };
}

/** OB-1750 `ob gmail draft-edit <id>`: replace fields of an EXISTING draft in place. Never sends. */
export async function gmailDraftEdit(
  store: Store,
  id: string,
  edit: GmailDraftEdit,
  client?: GmailDraftClient,
): Promise<GmailDraftPreview> {
  return editGmailDraft(client ?? (await gmailDraftClientFor(store)), id, edit);
}

/** OB-1750 `ob gmail draft-delete <id> --confirm`: remove a draft outright. `confirm` must be literally true. */
export async function gmailDraftDelete(
  store: Store,
  id: string,
  confirm: boolean,
  client?: GmailDraftClient,
): Promise<GmailDeleteDraftResult> {
  return deleteGmailDraft(client ?? (await gmailDraftClientFor(store)), id, confirm);
}

/** `ob gmail send-draft <id>` without --confirm reads this: what WOULD be sent. */
export async function gmailDraftShow(store: Store, id: string, client?: GmailDraftClient): Promise<GmailDraftPreview> {
  return showGmailDraft(client ?? (await gmailDraftClientFor(store)), id);
}

/**
 * `ob gmail send-draft <id> --confirm --hash <hex>`: send an EXISTING draft. `confirm` must be literally
 * true, and OB-1910: the draft is re-read here and sends only while it still hashes to `hash`.
 */
export async function gmailSendDraft(
  store: Store,
  id: string,
  confirm: boolean,
  hash: string,
  client?: GmailDraftClient,
): Promise<GmailSendDraftResult> {
  // sendGmailDraft refuses confirm !== true or an empty hash (UsageError → 400) before Gmail is asked to send.
  return sendGmailDraft(client ?? (await gmailDraftClientFor(store)), id, confirm, hash);
}

/** `ob cal agenda` / `ob agenda` / `ob cal`: today's events. */
export async function calAgenda(store: Store): Promise<AgendaResponse> {
  return { events: await agendaToday(store) };
}

/** `ob cal sync`: poll Calendar on THIS host using secret `google`. `client` is the test seam. */
export async function calSync(
  store: Store,
  req: CalSyncRequest = {},
  client?: GoogleClient,
): Promise<CalSyncResponse> {
  return syncCalendar(store, req, client);
}

// --- /google (1305) -----------------------------------------------------------------------------------
//
// The HOSTED OAuth half: a browser-reachable authorize + callback so a phone can finish a re-auth with no
// 127.0.0.1 receiver. It is NOT a second credential path — the minted JSON is persisted through the SAME
// `setSecret(store, "google")` the desktop loopback (420) and `POST /secrets` use.
//
// These two routes are the ONLY unauthenticated ones on the API (a browser cannot send a bearer token),
// so `state` is the guard and the server bypasses bearer auth for them by exact path (server.ts). The
// authenticated `/google/auth-url` mints through the same store for `ob google auth-url`.

export interface GoogleHostedDeps {
  /** The one-time state store shared by the mint routes and the callback. */
  states: GoogleStateStore;
  /** Token exchanger — production is the real Google call; tests inject a fixture. */
  exchange?: TokenExchanger;
  /** Clock seam for tests. */
  now?: () => number;
  /** Master key for reading secret `google` and writing the refreshed one. */
  secrets?: SecretDeps;
}

/** Client creds from the existing secret `google` — the same fields a prior auth stored (424). */
async function hostedClientCreds(store: Store, deps: GoogleHostedDeps): Promise<ClientCreds> {
  return (await hostedStoredGoogle(store, deps)).creds;
}

/** The stored `google` value and the client creds in it; the callback merges over that same value (OB-1916). */
async function hostedStoredGoogle(store: Store, deps: GoogleHostedDeps): Promise<{ creds: ClientCreds; stored: string }> {
  const value = await getSecret(store, "google", keyOf(deps.secrets).get());
  const creds = value ? clientCredsFromStoredGoogleJson(value) : null;
  if (!value || !creds) {
    throw new UsageError(
      "no OAuth client credentials in secret `google` — store client_id/client_secret (or run `ob google auth` once on a desktop)",
    );
  }
  return { creds, stored: value };
}

/** The redirect_uri: the configured one, else the origin this request arrived on (LAN tap). */
export async function googleRedirectUri(store: Store, req: Request, url: URL): Promise<string> {
  return hostedRedirectUri(await getConfig(store, GOOGLE_REDIRECT_URI_KEY), req, url);
}

/**
 * The browser half: 302 to Google for a state that was ALREADY minted (by `ob google auth-url`).
 *
 * It deliberately does not mint. A mint here would be unauthenticated (a phone browser has no bearer), and
 * then anyone who can reach this host could start a flow and complete the callback with THEIR Google
 * account — which persists their refresh token over the owner's. State proves a callback matches a flow;
 * it cannot say who was allowed to start one. So the mint stays on the bearer-authenticated endpoint and
 * this route only resumes it, without burning (the callback is the one that burns).
 */
export async function googleAuthRedirect(
  store: Store,
  state: string | null,
  deps: GoogleHostedDeps,
): Promise<{ ok: true; url: string } | { ok: false; reason: string }> {
  const found = deps.states.inspect(state, deps.now?.() ?? Date.now());
  if (!found.ok) return { ok: false, reason: stateRefusalSentence(found.reason) };
  const creds = await hostedClientCreds(store, deps);
  return {
    ok: true,
    url: buildAuthUrl({
      clientId: creds.clientId,
      redirectUri: found.redirectUri,
      scopes: DEFAULT_SCOPES,
      state: state as string,
    }),
  };
}

/** Mint a state and build Google's consent URL for `POST /google/auth-url`. */
export async function googleAuthStart(
  store: Store,
  redirectUri: string,
  deps: GoogleHostedDeps,
): Promise<GoogleAuthUrlResponse> {
  const creds = await hostedClientCreds(store, deps);
  let state: string;
  try {
    state = deps.states.mint(redirectUri, deps.now?.() ?? Date.now());
  } catch (e) {
    // OB-1935: the persisted store could not be locked, read or saved. A 503 with the sentence, not a stack.
    if (e instanceof GoogleStateBusyError) throw new ApiFault("busy", 503, e.message);
    throw e;
  }
  return { url: buildAuthUrl({ clientId: creds.clientId, redirectUri, scopes: DEFAULT_SCOPES, state }) };
}

export type GoogleCallbackOutcome = { ok: true; refreshToken: boolean } | { ok: false; reason: string };

/**
 * Verify + burn the state, exchange the code, and persist through the existing secret path.
 *
 * Never throws for an OAuth refusal: the callback route renders the reason as a page. Fail CLOSED — the
 * state is burned before the code is even looked at, and no branch repeats the code or the state.
 */
export async function googleCallback(
  store: Store,
  input: { state?: string | null; code?: string | null; error?: string | null },
  deps: GoogleHostedDeps,
): Promise<GoogleCallbackOutcome> {
  const burned = deps.states.burn(input.state, deps.now?.() ?? Date.now());
  if (!burned.ok) return { ok: false, reason: stateRefusalSentence(burned.reason) };
  if (input.error) return { ok: false, reason: `Google returned '${input.error}' before a code was issued` };
  const code = input.code?.trim();
  if (!code) return { ok: false, reason: "no authorization code on the callback" };
  const { creds, stored } = await hostedStoredGoogle(store, deps);
  const exchange = deps.exchange ?? httpExchangeAuthCode;
  let resp: TokenExchangeResponse;
  try {
    resp = await exchange({
      code,
      redirectUri: burned.redirectUri,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
    });
  } catch (e) {
    // `httpExchangeAuthCode` throws a status-only AppError, so the message is ours and cannot carry the
    // code; anything else is reported generically rather than risk a body that echoed the request.
    return {
      ok: false,
      reason: e instanceof AppError ? e.message : "the code exchange with Google failed — start again",
    };
  }
  if (!resp.access_token) return { ok: false, reason: "the token exchange returned no access_token" };
  const token = tokenResponseToGoogleToken(resp, creds, deps.now?.() ?? Date.now());
  // Merge over the stored token so a response with no refresh_token keeps the stored one (OB-1916).
  // previousGoogleToken parses in a try/catch: an unparseable stored value means no merge, never an error.
  const merged = mergeGoogleToken(previousGoogleToken(stored), token);
  await setSecret(store, "google", JSON.stringify(merged, null, 2), (await writeKeyOf(deps.secrets, store)).get());
  await clearCredentialCheck(store, "google");
  return { ok: true, refreshToken: Boolean(resp.refresh_token) };
}

export async function next(store: Store, project?: string, scope?: ProjectScope): Promise<NextResponse> {
  await requireScopedProject(store, scope, project);
  const { items, focusProject, triageCount } = await nextWorklist(store, { project, allowedProjects: scope?.ids });
  return {
    items: items.map((i) => itemView(i, focusProject)),
    triage_count: triageCount,
    focus_project: focusInScope(scope, focusProject),
  };
}

export async function items(store: Store, query: ItemQuery, scope?: ProjectScope): Promise<ItemsResponse> {
  await requireScopedProject(store, scope, query.project);
  // OS-178: teams is an admin family, and an unknown team's 404 would tell a scoped token which names exist.
  if (scope && query.team !== undefined) throw new ApiFault("forbidden", 403, "the team filter is not granted to a scoped token");
  const { items: rows, focusProject } = await listWorklist(store, query, { allowedProjects: scope?.ids }).catch((e) => {
    if (e instanceof UnknownTeamError) throw new ApiFault("not_found", 404, e.message);
    throw e;
  });
  return { items: rows.map((i) => itemView(i, focusProject)), focus_project: focusInScope(scope, focusProject) };
}

export async function create(
  store: Store,
  input: CreateItemRequest & { priorityValue: number | null },
): Promise<CreateItemResponse> {
  // A project NAME is resolved to its id here rather than stored raw, because `ob add --project <name>`
  // does the same: an item filed under the name and read back by id is an item that vanishes from its
  // own project's list.
  let projectId: string | null = null;
  if (input.project) {
    const p = await getProject(store, input.project);
    projectId = p ? p.id : input.project;
  }
  // One issue, one item (OB-1929): refuse before anything is created, as `issueLink` does.
  if (!input.issue) {
    const clash = await linkUrlClashMessage(store, input.link_url);
    if (clash) throw new ApiFault("refused", 409, clash);
  }
  let created: { number: number; url: string } | null = null;
  if (input.issue) {
    const repo = await trackerRepo(store);
    created = await createIssue(store, {
      repo,
      title: input.title,
      body: input.body ?? null,
      labels: issueLabels({ map: input.map, exec: input.exec }),
    });
  }
  let id = await createItem(store, {
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    status: input.status,
    projectId,
    priority: input.priorityValue,
    tags: input.tags,
    triage: input.triage,
    originRepo: input.origin_repo ?? null,
    linkUrl: created ? created.url : (input.link_url ?? null),
  });
  const row = await requireItem(store, id, { trusted: true });
  id = row.id;
  return { id, item: itemView(row, await getFocusProject(store)), issue: created };
}

export async function item(store: Store, id: string, scope?: ProjectScope): Promise<ItemResponse> {
  id = (await requireItem(store, id, { scope })).id; // so a missing item is a 404 rather than itemDetail's own throw
  const detail = await itemDetail(store, id);
  if (scope) {
    // OS-178: links (parents and children among them) to an item outside the scope are dropped, not named.
    const kept = [];
    for (const l of detail.links) {
      const other = await getItem(store, l.other);
      if (other && inScope(scope, other.project_id)) kept.push(l);
    }
    detail.links = kept;
  }
  return { item: detail };
}

/**
 * Close, then mirror onto the linked GitHub issue (#77). The LOCAL close is written first and always
 * stands; a GitHub failure comes back as `issue_error` rather than as a 500, because a 500 would tell the
 * client the close did not happen when it did, and the client would retry into an already-closed item.
 */
export async function close(store: Store, id: string, req: TrackerMoveRequest): Promise<TrackerMoveResponse> {
  id = (await requireItem(store, id)).id;
  // 1589: the close is the land, so the item's own building / handed-off rows read `landed` now. Best
  // effort: a failure is logged, never a 500 over a close that happened (OB-1928: closeAndLand).
  // OB-1993: the tokens are the client's reading (this host has no builder transcripts); a row it did not send reads here.
  // OS-163: a row's merged PR comes from the client (it has gh and the checkout); the server never reads one
  const marked = await closeAndLand(store, id, { note: req.note, actor: req.actor }, req.landById ?? {});
  if (marked.error) console.error(`spinoff: ${id} closed, but its spinoff rows were not marked landed: ${marked.error}`);
  return trackerMove(store, id, "closed", req);
}

export async function reopen(store: Store, id: string, req: TrackerMoveRequest): Promise<TrackerMoveResponse> {
  id = (await requireItem(store, id)).id;
  await reopenItem(store, id, { note: req.note, actor: req.actor });
  return trackerMove(store, id, "open", req);
}

async function trackerMove(
  store: Store,
  id: string,
  want: "closed" | "open",
  req: TrackerMoveRequest,
): Promise<TrackerMoveResponse> {
  const outcome = await syncIssueState(store, id, want, { skip: req.github === false });
  const row = await requireItem(store, id, { trusted: true });
  id = row.id;
  return {
    id,
    ref: row.ref ?? null,
    status: row.status,
    issue: outcome.link ? outcome.link.number : null,
    issue_url: outcome.link ? outcome.link.url : null,
    issue_state: outcome.change ? outcome.change.state : null,
    already: outcome.change ? outcome.change.already : null,
    skipped: outcome.skipped,
    issue_error: outcome.error,
  };
}

export async function state(store: Store, id: string, req: StateRequest): Promise<StateResponse> {
  const row = await requireItem(store, id);
  id = row.id;
  const decision = { note: req.note, actor: req.actor };
  switch (req.action) {
    case "start":
      await startItem(store, id, decision);
      break;
    case "ready":
      await readyItem(store, id, decision);
      break;
    case "block": {
      // 1515: `note` is the same words as `reason`, exactly as it is on the CLI's block (`--note` may
      // stand in for `--reason`), so an API caller that says why only once is not refused.
      const reason = req.reason?.trim() || req.note?.trim();
      if (!reason) throw new ApiFault("invalid_request", 400, "block requires a reason (or a note)");
      await blockItem(store, id, reason, req.owner?.trim() || null, decision);
      break;
    }
    case "unblock": {
      if (row.status !== "blocked") throw new ApiFault("refused", 409, `item '${id}' is not blocked`);
      await unblockItem(store, id, decision);
      break;
    }
    case "set": {
      const to = req.status?.trim();
      if (!to) throw new ApiFault("invalid_request", 400, "set requires a status");
      // `done` is the one target this verb will not take. Landing an item closes the LINKED GITHUB ISSUE
      // too (#77), and a generic state-setter that quietly skipped that half would be the undocumented
      // second door to a half-close. Refuse by name and point at the endpoint that does it properly.
      if (to === "done") {
        throw new ApiFault(
          "refused",
          409,
          `refusing to set '${id}' to 'done' through /state: landing an item also closes its linked GitHub issue. Use POST /items/${id}/close`,
        );
      }
      // OB-1928: the one move function `ob state` also uses. A reopen owes the mirror `/reopen` runs.
      const moved = await moveItem(store, id, to, {
        reason: req.reason?.trim() || null,
        owner: req.owner?.trim() || null,
        decision,
      });
      if (moved === "reopened") {
        const tracker = await trackerMove(store, id, "open", { note: req.note, actor: req.actor });
        return { id, ref: tracker.ref ?? null, status: tracker.status, tracker };
      }
      break;
    }
  }
  const after = await requireItem(store, id, { trusted: true });
  return { id, ref: after.ref ?? null, status: after.status };
}

/**
 * OB-1762: the dashboard's `transitionItem`, over HTTP. It dispatches to the SAME handlers `/state`,
 * `/close` and `/reopen` use (so a block still needs its reason, `done` still mirrors onto the linked
 * GitHub issue, and an illegal move is refused exactly as there) and then answers the fresh detail, so
 * the native item sheet redraws from one call.
 */
export async function transition(store: Store, id: string, req: TransitionRequest): Promise<ItemDetailResponse> {
  const move = { note: req.note, actor: req.actor };
  let tracker: TrackerMoveResponse | undefined;
  if (req.action === "close") tracker = await close(store, id, { github: req.github, ...move });
  else if (req.action === "reopen") tracker = await reopen(store, id, { github: req.github, ...move });
  else await state(store, id, { action: req.action, reason: req.reason, owner: req.owner, ...move });
  const row = await requireItem(store, id, { trusted: true });
  return { item: await itemDetail(store, row.id), ...(tracker ? { tracker } : {}) };
}

/** OB-1762: the dashboard's `setTodayRank`, over HTTP. The same `today` handler, then the fresh detail. */
export async function rank(store: Store, id: string, req: RankRequest): Promise<ItemDetailResponse> {
  await today(store, { id, rank: req.rank ?? undefined, clear: req.clear === true });
  const row = await requireItem(store, id, { trusted: true });
  return { item: await itemDetail(store, row.id) };
}

/** OB-2083: `ob order` over HTTP. The same `setQueueOrder` core, then the fresh detail and what the move did. */
export async function order(store: Store, id: string, req: OrderRequest): Promise<OrderResponse> {
  const given = [req.top === true, req.before !== undefined, req.after !== undefined].filter(Boolean).length;
  if (given !== 1) throw new ApiFault("invalid_request", 400, "order needs exactly one of top, before, after");
  if (req.priority !== undefined && req.top !== true) {
    throw new ApiFault("invalid_request", 400, "'priority' goes with 'top'; before / after take the band from their target");
  }
  // The typed refs are guarded before the write (a bare number that names two items is refused, nothing changed);
  // the core is handed the resolved ids.
  const subject = await requireItem(store, id);
  let move: QueueMove;
  if (req.top === true) {
    // parsePriority("") is 0, so an empty string is refused rather than written as "none".
    const p = req.priority === undefined ? undefined : req.priority.trim() === "" ? null : parsePriority(req.priority);
    if (p === null) throw new ApiFault("invalid_request", 400, `'priority' must be one of ${PRIORITY_OPTIONS}`);
    move = { top: true, priority: p };
  } else if (req.before !== undefined) {
    move = { before: (await requireItem(store, req.before)).id };
  } else {
    move = { after: (await requireItem(store, req.after!)).id };
  }
  const res = await setQueueOrder(store, subject.id, move, { note: req.note, actor: req.actor });
  const row = await requireItem(store, res.id, { trusted: true });
  return {
    item: await itemDetail(store, row.id),
    order: { priority: priorityName(res.priority), priority_changed: res.priorityChanged, rank: res.rank },
  };
}

/** OB-1762: the dashboard's `getSnapshot` -- the same `snapshotFrom` the SSR loader and the WebSocket push use. */
export async function snapshot(store: Store): Promise<SnapshotResponse> {
  return { snapshot: await snapshotFrom(store) };
}

export async function note(store: Store, id: string, req: NoteRequest): Promise<NoteResponse> {
  id = (await requireItem(store, id)).id;
  await appendNote(store, id, req.text);
  const after = await requireItem(store, id, { trusted: true });
  return { id, ref: after.ref ?? null, body: after.body };
}

export async function tags(store: Store, id: string, req: TagsRequest): Promise<TagsResponse> {
  id = (await requireItem(store, id)).id;
  if (req.add && req.add.length > 0) await addTags(store, id, req.add);
  if (req.remove && req.remove.length > 0) await removeTags(store, id, req.remove);
  return { id, ref: await refOf(store, id), tags: await getTags(store, id) };
}

export async function search(store: Store, q: string, scope?: ProjectScope): Promise<SearchResponse> {
  let ids: string[];
  try {
    ids = await searchItemIds(store, q, { allowedProjects: scope?.ids });
  } catch {
    // The query text is echoed because the CLIENT wrote it; nothing about the store leaks through here.
    throw new ApiFault("invalid_request", 400, `invalid search query: ${q}`);
  }
  const focusProject = await getFocusProject(store);
  const views = [];
  for (const id of ids) {
    const row = await getItem(store, id);
    if (row) views.push(itemView(row, focusProject));
  }
  return { query: q, items: views, focus_project: focusInScope(scope, focusProject) };
}

export async function status(store: Store): Promise<StatusResponse> {
  return { status: await buildStatus(store) };
}

export async function agents(store: Store, includeExpired: boolean): Promise<AgentsResponse> {
  const rows = await listAgents(store, { includeExpired });
  // "Where does this agent live?" is what you ask when something dies (#125), so the row carries its own
  // launcher, else its launching spinoff's -- the same composition `ob agents` renders.
  const fromSpinoff = await agentLauncherMap(store);
  return { agents: rows.map((r) => ({ ...r, launcher: effectiveLauncher(r, fromSpinoff.get(r.id)) })) };
}

export async function agent(store: Store, req: AgentRequest): Promise<AgentResponse> {
  if (req.action === "heartbeat") {
    const found = await heartbeatAgent(store, req.id);
    // A long build must not expire its own ticket/worktree lease (#97), so the heartbeat refreshes both
    // the row and every lease this holder has -- exactly what `ob agent heartbeat` does.
    if (!found) throw new ApiFault("not_found", 404, `no agent '${req.id}'`);
    // an expired lease is never revived: it is acquired afresh, and the caller is told (OB-1922)
    const { reacquired } = await heartbeatLeasesByHolder(store, req.id);
    const row = await getAgent(store, req.id);
    return {
      agent: row,
      found: true,
      ticket_lease: null,
      released: [],
      kept: [],
      reacquired_leases: reacquired,
      // OS-110: the row's ticket:/worktree: keys another session now holds live
      lost_leases: (await lostLeasesOf(store, row!)).map(({ resource, holder, since }) => ({ resource, holder, since })),
    };
  }
  if (req.action === "set-run") {
    // OB-1923: the mirror's write. Update-only: a missing row is `found: false`, never a new row.
    const found = await setAgentRun(store, req.id, req.run!);
    return { agent: found ? await getAgent(store, req.id) : null, found, ticket_lease: null, released: [], kept: [] };
  }
  if (req.action === "done") {
    const { done: removed, released, kept } = await finishAgent(store, req.id, { noLease: req.no_lease === true });
    return { agent: null, found: removed, ticket_lease: null, released, kept };
  }
  const ttlS = req.ttl_s ?? DEFAULT_AGENT_TTL_S;
  const existingAgent = await getAgent(store, req.id);
  // The RECORDED ticket beats nothing being passed: the heartbeat form of register must refresh the same
  // ticket lease it already holds, not drop it.
  // OB-1991: a trial's leg b builder names the plain ticket; it registers on `<ref>-b`.
  const ticket = await legTicketFor(store, req.id, req.ticket ?? existingAgent?.ticket ?? null);
  let ticketLease: string | null;
  try {
    ticketLease = await claimTicketLease(store, {
      id: req.id,
      ticket,
      ttlS,
      holder: req.holder ?? null,
      noLease: req.no_lease === true,
    });
  } catch (e) {
    // A live foreign holder is a REFUSAL, not a server error: another session is on that ticket, and the
    // client must show the holder rather than retry.
    throw new ApiFault("refused", 409, e instanceof AppError ? e.message : String(e));
  }
  const row = await registerAgent(store, {
    id: req.id,
    ticket,
    worktree: req.worktree ?? null,
    branch: req.branch ?? null,
    // 1189: no status means the agent's own default on a NEW row and "leave it alone" on an existing one —
    // the same rule as `ob agent register`, which is what this endpoint IS over the wire. A register that
    // carries a `run` claims no workflow word, so a NEW row reads '-' beside its run. (The mirror itself
    // writes through `set-run` since OB-1923, which never creates a row.)
    status: req.status ?? (existingAgent || req.run != null ? null : DEFAULT_AGENT_STATUS),
    run: req.run ?? null,
    note: req.note ?? null,
    launcher: req.launcher ?? null,
    sessionId: req.session_id ?? null,
    ttlS,
  });
  return { agent: row, found: true, ticket_lease: ticketLease, released: [], kept: [] };
}

/**
 * "Should this Mac stay awake?" (098). The one agent read whose caller is a timer rather than a person,
 * so a client that could not answer it would let the machine sleep on a live build.
 *
 * `active` is derived from the count HERE rather than left to the client, because that comparison is
 * exactly where Postgres's string-valued count() bites: `"0" > 0` is false and `Boolean("0")` is true, so
 * the same data decides the opposite way depending on who does the arithmetic. One place, one answer.
 */
/** Wipe agents + every lease (437). Same core `ob agents reset` calls. `dryRun` writes nothing. */
export async function agentsReset(store: Store, dryRun: boolean): Promise<AgentsResetResponse> {
  const report = await resetAgentsAndLeases(store, { dryRun });
  return { dry_run: dryRun, agents: report.agents, leases: report.leases };
}

export async function agentActive(store: Store, withinMin: number): Promise<AgentActiveResponse> {
  const count = await agentsActiveWithin(store, withinMin * 60 * 1000);
  return { active: count > 0, count, within_min: withinMin };
}

export async function leases(store: Store): Promise<LeasesResponse> {
  return { leases: await leaseStatus(store) };
}

/** OB-1922: what `ob lease status` runs first. A POST, so the GET above stays a pure read. */
export async function sweepLeases(store: Store): Promise<SweepLeasesResponse> {
  return { swept: await sweepExpiredLeases(store) };
}

export async function acquire(store: Store, req: AcquireLeaseRequest): Promise<AcquireLeaseResponse> {
  if (req.heartbeat) {
    // OB-1922: a heartbeat on the caller's own EXPIRED lease is refused (LeaseExpiredError), not revived.
    // `recorded` then names the caller with `expired: true`, which is how the client tells it apart.
    let beat = false;
    let expired = false;
    try {
      beat = await heartbeatLease(store, req.resource, req.holder);
    } catch (err) {
      if (!(err instanceof LeaseExpiredError)) throw err;
      expired = true;
    }
    // A heartbeat REFUSES to create a hold: `ob lease heartbeat` on a lease you do not hold must say so,
    // not silently take it. That distinction is why this is a flag on acquire rather than a second verb.
    return {
      resource: req.resource,
      ok: beat,
      holder: req.holder,
      recorded: await recordedHold(store, req.resource),
      ...(expired ? { error: "LeaseExpiredError" as const } : {}),
    };
  }
  const got = await acquireLease(store, req.resource, req.holder, req.ttl_s);
  return { resource: req.resource, ok: got.ok, holder: got.holder, recorded: await recordedHold(store, req.resource) };
}

export async function release(
  store: Store,
  resource: string,
  holder: string,
  force: boolean,
): Promise<ReleaseLeaseResponse> {
  // Read the row BEFORE the release, because a successful release deletes it and there would be nothing
  // left to name. `recorded` (353) is what lets a refusal say WHY: "held by <holder>, not you ... re-run
  // as it with --holder <holder>", which is the sentence that stops someone reaching for --force. From
  // `released: false` alone the client can only say it did nothing, and that reads like a bug.
  const before = await recordedHold(store, resource);
  const released = await releaseLease(store, resource, holder, force);
  // After a real release the row is gone, and reporting a hold that no longer exists would be a lie in
  // the one direction that matters: it would look like the lease is still someone's.
  return { resource, released, recorded: released ? null : before };
}

// --- secrets (357) ------------------------------------------------------------------------------------
//
// Decryption happens HERE, against the master key on this host, and the master key is the one thing that
// does not move. These handlers are the only ones in this file that ever hold a plaintext value, and each
// of them holds it for exactly as long as it takes to put it in a response or in the store.
//
// `secretDeps` exists so a test can drive the whole path with an in-memory master key: the real provider
// shells out to the macOS Keychain, which a test run refuses outright (`realKeychainBlocked`), and a
// handler that could only be exercised with a real key would not be exercised at all.

export interface SecretDeps {
  masterKey?: MasterKey;
}

function keyOf(deps: SecretDeps | undefined): MasterKey {
  return deps?.masterKey ?? defaultMasterKey();
}

/** The key a WRITE uses: the injected one, else a default that may mint only into an empty store (OB-1911). */
async function writeKeyOf(deps: SecretDeps | undefined, store: Store): Promise<MasterKey> {
  return deps?.masterKey ?? masterKeyForWrite(store);
}

/**
 * Anything thrown while a plaintext value is in hand, with that value scrubbed out of the message.
 *
 * The plaintext never reaches the database driver -- `setSecret` encrypts first, so what is bound to the
 * insert is base64 ciphertext -- which means no driver error can carry it. This is the belt to that
 * braces: a future caller, a future column, a future `JSON.stringify(input)` in someone's error path, and
 * the value would otherwise walk out through `fail("internal", 500, e.message)` and into a client's
 * stderr. Scrubbing here costs nothing and closes the whole class.
 */
function rethrowRedacted(err: unknown, value: string): never {
  if (err instanceof ApiFault) {
    throw new ApiFault(err.code, err.status, redactDetail(err.message, [value]));
  }
  const message = err instanceof Error ? err.message : String(err);
  throw new AppError(redactDetail(message, [value]));
}

/** NAMES and ages. `listSecrets` selects no ciphertext column at all, so there is nothing here to leak. */
export async function secrets(store: Store): Promise<SecretsResponse> {
  return { secrets: await listSecrets(store) };
}

export async function readSecret(
  store: Store,
  req: ReadSecretRequest,
  deps?: SecretDeps,
): Promise<ReadSecretResponse> {
  let value: string | null;
  try {
    value = await getSecret(store, req.name, keyOf(deps).get());
  } catch (e) {
    // A decrypt failure is GCM authentication or a missing master key; neither carries plaintext, and the
    // message names the store's own problem so the caller knows it is not their token that is wrong.
    throw new ApiFault("internal", 500, `could not decrypt secret '${req.name}': ${(e as Error).message}`);
  }
  // The same refusal `ob secret get` makes locally, so the sentence a human reads is the same one whether
  // ob reached the store directly or over HTTP.
  if (value === null) throw new ApiFault("not_found", 404, `no secret \`${req.name}\` in the store`);
  return { name: req.name, value };
}

export async function setSecretValue(
  store: Store,
  req: SetSecretRequest,
  deps?: SecretDeps,
): Promise<SetSecretResponse> {
  try {
    await setSecret(store, req.name, req.value, (await writeKeyOf(deps, store)).get());
  } catch (e) {
    rethrowRedacted(e, req.value);
  }
  await clearCredentialCheck(store, req.name);
  // Read the age back rather than reporting `nowIso()`: the caller gets the row that is actually stored,
  // which is what makes `ob secret list` afterwards agree with what this said.
  const row = (await listSecrets(store)).find((r) => r.name === req.name);
  if (!row) throw new ApiFault("internal", 500, `secret '${req.name}' was written but did not read back`);
  return { name: req.name, set: true, updated_at: row.updated_at };
}

export async function removeSecretByName(
  store: Store,
  req: RemoveSecretRequest,
): Promise<RemoveSecretResponse> {
  const removed = await removeSecret(store, req.name);
  if (!removed) throw new ApiFault("not_found", 404, `no secret \`${req.name}\` in the store`);
  await clearCredentialCheck(store, req.name);
  return { name: req.name, removed };
}

// --- the spinoff queue (360) --------------------------------------------------------------------------
//
// The DATA half of `ob spinoff`, and nothing else. No handler here writes a file, probes a process table,
// creates a worktree or opens a tab: those are the client's, on the machine that has them.
//
// Every one of these calls the same function the local command calls -- `enqueueSpinoff`,
// `claimSpinoffRow`, `stampSpinoff`, `landSpinoff`, `reclaimSpinoffs` -- so the queue has one set of
// semantics whether `ob` reached the store directly or over HTTP. That is what keeps ob 308's atomic claim
// intact: the conditional `UPDATE ... WHERE status='pending' RETURNING *` is still one statement in one
// place, and it is the database, not the client, that decides which of two drains gets the row.

export async function spinoffConfig(store: Store): Promise<SpinoffConfigResponse> {
  const cfg = await readSpinoffLaunchConfig(store);
  return {
    config: {
      repo_checkouts: cfg.repoCheckouts,
      launcher: cfg.launcher,
      launcher_by_repo: cfg.launcherByRepo,
      engine: cfg.engine,
      tier_models: cfg.tierModels ?? "",
    },
  };
}

export async function spinoffs(store: Store, query: SpinoffsQuery): Promise<SpinoffsResponse> {
  // 1513: either spelling filters (a newer client may send `building`); an unknown value passes through
  // unchanged and so matches no row, exactly as before.
  const status = query.status === undefined ? undefined : (toStoredSpinoffStatus(query.status) ?? query.status);
  return { spinoffs: await listSpinoffs(store, status) };
}

/**
 * The rows that SERVE one item (1226), resolved HERE because this is where the store is: the caller is a
 * client that holds T3 and no database, and the decision turns on evidence only the tracker has (whether
 * some item's record names a row's ref as a ticket path). The item is read once; a missing one is named
 * rather than answered with an empty list, which would read exactly like a ticket whose rows are all
 * retired. A ref the resolution cannot settle comes back NAMED in `unresolved`, never dropped.
 */
export async function spinoffServing(store: Store, req: SpinoffServingRequest): Promise<SpinoffsResponse> {
  const rows = await listSpinoffs(store);
  const id = req.item_id.trim();
  await refuseAmbiguousBareNumber(store, id);
  const item = await getItem(store, id);
  if (!item) throw new ApiFault("not_found", 404, `no item '${id}'`);
  const { rows: serving, unresolved } = await spinoffRowsServingItem(store, rows, item);
  return { spinoffs: serving, unresolved: unresolved.map((row) => ({ id: row.id, ticket_ref: row.ticket_ref })) };
}

/** OB-1825: `ob spinoff check` over the API: the same verdict, computed and recorded here. */
export async function spinoffCheck(store: Store, req: SpinoffCheckRequest): Promise<SpinoffCheckResponse> {
  return recordSpinoffCheck(store, req.ticket_ref, { architect: req.architect, checker: req.checker, resolutions: req.resolutions }, { actor: req.actor });
}

/** OB-2131: each row's planned files from its ticket's newest go check, read here where the trail is. */
export async function spinoffPlannedFiles(store: Store, req: SpinoffPlannedFilesRequest): Promise<SpinoffPlannedFilesResponse> {
  const planned: SpinoffPlannedFilesResponse["planned"] = [];
  for (const row of req.rows) {
    if (typeof row?.id !== "number" || typeof row.ticket_ref !== "string") continue;
    planned.push({ id: row.id, files: await plannedFilesFor(store, row.ticket_ref, typeof row.item_id === "string" ? row.item_id : null) });
  }
  return { planned };
}

/** OS-47: the overlap warning's store half: declared files read, or the `overlap` decision written, here where the trail is. */
export async function spinoffOverlap(store: Store, req: SpinoffOverlapRequest): Promise<SpinoffOverlapResponse> {
  if (req.op === "record") {
    return { op: "record", recorded: await recordOverlap(store, req.ticket_ref, req.rows, { note: req.note, actor: req.actor }) };
  }
  const declared: Array<{ ticket_ref: string; files: string[] | null }> = [];
  for (const ref of req.refs) declared.push({ ticket_ref: ref.ticket_ref, files: await declaredFilesFor(store, ref.ticket_ref, ref.item_id) });
  return { op: "declared", declared };
}

export async function enqueue(store: Store, req: EnqueueSpinoffRequest): Promise<EnqueueSpinoffResponse> {
  // OB-2230: one flake fix on the whole machine. The slot lives here, so a held one refuses here, before the row.
  const flake = await refuseHeldFlakeSlot(store, req.ticket_ref, [req.branch, refKey(req.ticket_ref), req.actor ?? ""], req.no_flake_slot);
  // OB-1825: the gate runs here, on the host with the store, so an old client cannot skip it.
  const warning = await refuseUncheckedDispatch(store, req.ticket_ref, { noCheck: req.no_check, actor: req.actor });
  const { row, deduped, collision, urgent, raisedFrom } = await enqueueSpinoff(store, {
    ticketRef: req.ticket_ref,
    // Recorded VERBATIM. The client resolved it to a slug against its own checkouts (217); re-resolving it
    // here would go looking for the owner's checkouts on a host that has none of them.
    repo: req.repo,
    branch: req.branch,
    worktree: req.worktree ?? undefined,
    mode: req.mode,
    // OB-2230: a flake ticket's builder is told to test inside flake-box; the client said whether it has one.
    brief: flake ? withFlakeBoxBrief(req.brief, req.flake_box ?? true) : req.brief,
    // server.ts validated it against LAUNCHER_NAMES before this was called, the same way the CLI rejects
    // an unknown `--launcher` up front rather than falling back to a launcher nobody asked for (#135).
    launcher: (req.launcher ?? null) as LauncherName | null,
    // server.ts validated it against SPINOFF_TIERS (1480).
    tier: (req.tier ?? null) as SpinoffTier | null,
    // OS-177: server.ts validated it as 1-10. It wins over `tier`; a tier-only client still routes by the tier's alias.
    complexity: req.complexity ?? undefined,
    // server.ts validated it against SPINOFF_EFFORTS (OB-1815).
    effort: (req.effort ?? null) as SpinoffEffort | null,
    decision: { note: req.note, actor: req.actor },
    trialLeg: (req.trial_leg ?? null) as "a" | "b" | null,
    trialModel: req.trial_model ?? null,
  });
  if (flake && req.no_flake_slot) await recordNoFlakeSlot(store, row, req.no_flake_slot, req.actor);
  // OS-108: the client checked the critical-only line (the usage cache is on its machine); the override goes on the trail here.
  if (req.over_usage?.trim()) await recordOverUsage(store, row.ticket_ref, req.over_usage, { actor: req.actor, spinoffRow: row.id, itemId: row.item_id });
  return { row, deduped, collision, warning, urgent, raised_from: raisedFrom, flake };
}

/**
 * What a drain could launch right now. Agent count is not a reason to leave a row pending (ob 767):
 * this reports every pending row and the live BUILD-agent count (informational); the client launches
 * each row that is not lease-blocked (#97) or launcher-not-ready (#118/#161).
 *
 * `caller` is the CLIENT's lease-holder id. It has to travel, because a hold taken by the caller is not
 * foreign and this host's own pid is not the caller: judging "is this hold someone else's" against the
 * server's identity would report the caller's own holds as contention.
 */
export async function spinoffLaunchable(store: Store, req: LaunchableRequest): Promise<LaunchableResponse> {
  const { total } = await liveBuildAgentsByRepo(store);
  const self = [req.caller ?? "", req.holder ?? ""].filter((s) => s.length > 0);
  const rows: LaunchableSpinoff[] = [];
  const pendings = await pendingSpinoffs(store);
  for (const pending of pendings) {
    // OB-2075: an urgent item launches on complex even when its row says otherwise; the client drain has no
    // store, so the raise is made here, where the item lives. It is recorded at the stamp, never by this read.
    const raised = await urgentLaunchRow(store, pending);
    const row = raised.row;
    const hold = await foreignHold(store, await rowLeaseKeys(store, row), [...self, row.branch, builderIdOf(row)]);
    rows.push({
      row,
      tags: await spinoffTicketTagsFor(store, row.ticket_ref, row.item_id),
      hold: hold ? { resource: hold.resource, holder: hold.holder } : null,
      // The thread's name (1143): read HERE, where the item lives, because the launch (and so the title)
      // happens on the client. Same one-lookup-per-row shape as the tags beside it, and the same identity
      // (1163): the row's recorded item, so a hand-charted ticket is named by its mirror and not the
      // wayfinder number its branch is named after.
      ticket_title: await ticketTitleFor(store, row.ticket_ref, row.item_id),
      raised_from: raised.raisedFrom,
      urgent: raised.urgent,
    });
  }
  return {
    active: total,
    rows,
    remaining_pending: pendings.length,
  };
}

/** The exclusion (308/191). One conditional update, on the authoritative database, exactly as before. */
export async function spinoffClaim(store: Store, req: ClaimSpinoffRequest): Promise<ClaimSpinoffResponse> {
  const outcome = await claimSpinoffRow(store, req.id, req.holder ?? "");
  return { claimed: outcome.claimed, error: outcome.error };
}

export async function spinoffStamp(store: Store, req: StampSpinoffRequest): Promise<StampSpinoffResponse> {
  await stampSpinoff(store, {
    id: req.id,
    outcome: req.outcome,
    worktree: req.worktree ?? null,
    base_sha: req.base_sha ?? null,
    launcher: req.launcher ?? null,
    session_id: req.session_id ?? null,
    engine: req.engine ?? null,
    t3_thread_id: req.t3_thread_id ?? null,
    t3_run_id: req.t3_run_id ?? null,
    model: req.model ?? null,
    effort: req.effort ?? null,
    raised: req.raised ?? false,
    error: req.error ?? null,
  });
  return { id: req.id, outcome: req.outcome };
}

/**
 * Retire a merged row. The #97 guard is applied HERE rather than on the client, because the leases are rows
 * too: a landing is a finalisation and must not happen under a THIRD party's hold. The row's own agent is
 * not foreign (this IS its completion) and neither is `holder`, the hold the caller already has.
 */
export async function spinoffLand(store: Store, req: LandSpinoffRequest): Promise<LandSpinoffResponse> {
  const rows = await listSpinoffs(store);
  const row = rows.find((r) => r.id === req.id);
  if (!row) throw new ApiFault("not_found", 404, `no spinoff #${req.id}`);
  const self = [req.caller ?? "", req.holder ?? "", builderIdOf(row)].filter((s) => s.length > 0);
  const hold = await foreignHold(store, spinoffLeaseKeys(row), self);
  if (hold) return { id: req.id, landed: false, blocked: { resource: hold.resource, holder: hold.holder } };
  await landSpinoff(store, req.id, req.tokens, {}, req.pr_url ?? null);
  return { id: req.id, landed: true, blocked: null };
}

/** OB-1993: record the tokens a client read for a landed row with no count. Refused (409) for any other row. */
export async function spinoffTokens(store: Store, req: RecordSpinoffTokensRequest): Promise<RecordSpinoffTokensResponse> {
  const row = await recordSpinoffTokens(store, req.id, req.tokens);
  return { id: row.id, total_tokens: row.total_tokens ?? 0 };
}

export async function spinoffReclaim(store: Store): Promise<ReclaimSpinoffsResponse> {
  return { reclaimed: await reclaimSpinoffs(store) };
}

/**
 * Human-declared handoff (391/426; stored `ready-for-gate`, printed `handed-off`, 1513). Same core as
 * `ob spinoff handoff` (alias `ready`): stamps the row, bumps
 * the agent to `readying`, releases the builder's ticket:/worktree: holds, never an architect-* hold.
 * The State: line is read on the client (it has the worktree).
 */
export async function spinoffReady(store: Store, req: ReadySpinoffRequest): Promise<ReadySpinoffResponse> {
  const ref = req.id != null ? String(req.id) : req.ticket_ref?.trim();
  if (!ref) throw new ApiFault("invalid_request", 400, "give 'id' or 'ticket_ref'");
  // 1552: the builder's tier-fit rating is validated BEFORE anything is looked up or stamped, and OUTSIDE the
  // try so its UsageError reaches the route's own UsageError → 400 mapping instead of becoming a 409.
  const tierFit = tierFitOf(req.tier_fit, req.tier_fit_why);
  try {
    const found = await findSpinoffForReady(store, { ref });
    // OB-1920: the same worktree checks the CLI handoff runs (dirty worktree, or a spike's commits), from the
    // one shared function. A worktree this host does not have is not a refusal: the client checked it.
    assertHandoffWorktree(found, isSpikeTagged(await spinoffTicketTagsFor(store, found.ticket_ref, found.item_id)));
    // 1133: read the builder's own readying note BEFORE the stamp, which rewrites that row's note to
    // "handed-off: the sentinel gates it". Done HERE rather than on the client so the read and
    // the overwrite cannot drift apart across two processes — the readying note is composed from this.
    const builderNote = (await getAgent(store, builderIdOf(found)))?.note ?? null;
    const result = await markSpinoffReady(store, found, { note: req.note ?? null }, tierFit);
    return { ...result, builder_note: builderNote };
  } catch (e) {
    if (e instanceof ApiFault) throw e;
    throw new ApiFault("refused", 409, e instanceof AppError ? e.message : String(e));
  }
}

/** OB-1991: one model-trial operation over the wire. A bad field is a 400; a refusal (a trial already active) is a 409. */
export async function spinoffTrial(store: Store, req: SpinoffTrialRequest): Promise<SpinoffTrialResponse> {
  try {
    return await runTrialOp(store, req, trialStoreDeps(store));
  } catch (e) {
    if (e instanceof ApiFault) throw e;
    if (e instanceof UsageError) throw new ApiFault("invalid_request", 400, e.message);
    throw new ApiFault("refused", 409, e instanceof AppError ? e.message : String(e));
  }
}

/** OB-2172: a client's readying-note outcome, kept on the row (`note_error`) where `gateable` and `show` read it. */
export async function spinoffNoteError(store: Store, req: SpinoffNoteErrorRequest): Promise<SpinoffNoteErrorResponse> {
  const row = (await listSpinoffs(store)).find((r) => r.id === req.id);
  if (!row) throw new ApiFault("not_found", 404, `no spinoff #${req.id}`);
  const out = await recordReadyNoteOutcome(store, row.id, {
    ticket: row.ticket_ref,
    threadId: null,
    outcome: req.outcome,
    reason: req.reason ?? null,
  });
  if (out.recordError) throw new ApiFault("refused", 409, `could not write note_error on #${row.id}: ${out.recordError}`);
  return { recorded: true };
}

/** OB-1992: `ob spinoff state` over the wire. A bad verdict word is a 400; OmniSlash or a landed row is a 409. */
export async function spinoffVerdict(store: Store, req: SpinoffVerdictRequest): Promise<SpinoffVerdictResponse> {
  const row = (await listSpinoffs(store)).find((r) => r.id === req.id);
  if (!row) throw new ApiFault("not_found", 404, `no spinoff #${req.id}`);
  try {
    return { row: await recordSpinoffVerdict(store, row, { verdict: req.verdict, reason: req.reason, gate: req.gate }) };
  } catch (e) {
    if (e instanceof UsageError) throw new ApiFault("invalid_request", 400, e.message);
    throw new ApiFault("refused", 409, e instanceof AppError ? e.message : String(e));
  }
}

/**
 * Architect send-back (OB-1805): a handed-off row goes back to building. The T3 note to the builder is the
 * CLIENT's to send (T3 is on its machine); `restore` is the undo when that send fails.
 */
export async function spinoffSendBack(store: Store, req: SendBackSpinoffRequest): Promise<SendBackSpinoffResponse> {
  try {
    const row = (await listSpinoffs(store)).find((r) => r.id === req.id);
    if (!row) throw new ApiFault("not_found", 404, `no spinoff #${req.id}`);
    if (req.restore) {
      const restored = await restoreSentBackRow(store, row.id, { note: "send-back undone: the builder thread could not be told" });
      if (req.over_usage?.trim()) await recordOverUsageUndone(store, row.ticket_ref, { spinoffRow: row.id, itemId: row.item_id }); // OS-108
      return { row: restored.row };
    }
    const sent = await markSpinoffSentBack(store, row, { note: req.note });
    if (req.over_usage?.trim()) await recordOverUsage(store, row.ticket_ref, req.over_usage, { spinoffRow: row.id, itemId: row.item_id }); // OS-108
    return { row: sent };
  } catch (e) {
    if (e instanceof ApiFault) throw e;
    throw new ApiFault("refused", 409, e instanceof AppError ? e.message : String(e));
  }
}

/**
 * OB-2180: a landed row back to building. The client checked main for a landing commit before it asked (that
 * is git, and the checkout is on its machine); this is the store half, refused for anything not landed.
 */
export async function spinoffReopen(store: Store, req: ReopenSpinoffRequest): Promise<ReopenSpinoffResponse> {
  try {
    const row = (await listSpinoffs(store)).find((r) => r.id === req.id);
    if (!row) throw new ApiFault("not_found", 404, `no spinoff #${req.id}`);
    if (!req.note.trim()) throw new ApiFault("invalid_request", 400, "reopen needs a note: why the land is undone");
    return { row: await markSpinoffReopened(store, row, { note: req.note }) };
  } catch (e) {
    if (e instanceof ApiFault) throw e;
    throw new ApiFault("refused", 409, e instanceof AppError ? e.message : String(e));
  }
}

/**
 * The two database questions a local cleanup sweep asks about ONE candidate it found in git (360): is a
 * live foreign session holding it, and is there a registry row a removal would clear. The git itself --
 * which worktrees exist, what is dirty, what is merged -- is the client's, and could never be anything
 * else: on this host those are a different set of branches with the same names.
 */
export async function spinoffCleanupGuard(
  store: Store,
  req: CleanupGuardRequest,
): Promise<CleanupGuardResponse> {
  const branch = req.branch ?? null;
  const path = req.path ?? "";
  const self = [req.caller ?? ""].filter((s) => s.length > 0);
  const hold = await foreignHold(store, await cleanupLeaseKeys(store, branch, path), self);
  return {
    hold: hold ? { resource: hold.resource, holder: hold.holder } : null,
    agent: branch ? (await getAgent(store, branch)) != null : false,
  };
}

// --- creds (357) --------------------------------------------------------------------------------------

export interface CredsDeps {
  probes?: Probes;
  check?: CheckDeps;
}

/**
 * Presence, age and the last recorded verdict, read on THIS host. That is the right machine and not an
 * approximation of one: the store, the master key and the legacy token files are all here, so a client
 * asking its own filesystem would confidently describe a different computer.
 */
export async function creds(store: Store, deps?: CredsDeps): Promise<CredsResponse> {
  return { credentials: await credentialInventory(store, deps?.probes) };
}

/**
 * Run the live check(s) and record the verdicts. The one endpoint here that deliberately leaves the host,
 * and only ever because a person typed `ob creds check`. It returns a boolean and a sentence per
 * credential; `runCredentialCheck` already puts every detail through `redactDetail`, so a provider that
 * echoed the credential back in an error does not get to put it in a response.
 */
export async function credsCheck(
  store: Store,
  req: CredsCheckRequest,
  deps?: CredsDeps,
): Promise<CredsCheckResponse> {
  const targets = req.all
    ? (await credentialInventory(store, deps?.probes)).filter((c) => c.checkable).map((c) => c.name)
    : [req.name!];
  const checks = [];
  for (const target of targets) {
    if (!CREDENTIAL_NAMES.includes(target)) {
      throw new ApiFault("invalid_request", 400, `'${target}' is not a known credential (${CREDENTIAL_NAMES.join("|")})`);
    }
    checks.push(await runCredentialCheck(store, target, deps?.check ?? {}));
  }
  return { checks };
}

// --- 416: already-servable commands -------------------------------------------------------------------

import {
  addConflict,
  listProjects,
  openItemsRefusal,
  registerProject,
  removeProject,
  renameProject,
  renameRefusal,
  slugify,
  updateProject,
} from "../project.ts";
import { parseProjectLabel, parseProjectPatch } from "../commands/admin.ts";
import { VALID_PROJECT_KINDS } from "../commands/admin.ts";
import type { Kind } from "../status.ts";
import {
  buildInFlightBrief,
  buildItemBrief,
  resolveItem,
} from "../commands/brief.ts";
import {
  isJournalType,
  listJournal,
  logEntry,
  orderJournal,
  JOURNAL_TYPES,
} from "../commands/log.ts";
import { getCursorFor, setCursorFor } from "../settings.ts";
import { jobHealth } from "../jobs.ts";
import { canonicalDeployAt, DEPLOY_RESULTS, listDeploys, recordDeploy } from "../commands/deploy.ts";
import { computeAlerts, filterSnoozed, snoozeAlert } from "../commands/alerts.ts";
import {
  chainFrom,
  collectSupersedeEdges,
  supersede,
} from "../commands/decision.ts";
import { docCreate, docList, docRead, docSet, requireDoc } from "../commands/doc.ts";
import { getDecisionDetail, getLearningDetail, getLinks, getRoadmapDetail, queryItems } from "../items.ts";
import { computeProgress, getRoadmapMembers, onTrack } from "../commands/roadmap.ts";
import {
  latestStandup,
  markPosted,
  saveGenerated,
  setEdited,
  today as standupToday,
} from "../commands/standup.ts";
import { recentSlackMessages } from "../commands/slack.ts";
import { and, count, eq } from "drizzle-orm";

export async function projects(store: Store, scope?: ProjectScope): Promise<ProjectsResponse> {
  const all = await listProjects(store);
  return { projects: scope ? all.filter((p) => scope.ids.has(p.id)) : all };
}

export async function projectCreate(store: Store, req: ProjectCreateRequest): Promise<ProjectCreateResponse> {
  if (!(VALID_PROJECT_KINDS as readonly string[]).includes(req.kind)) {
    throw new ApiFault("invalid_request", 400, `'kind' must be one of ${VALID_PROJECT_KINDS.join(", ")}`);
  }
  let icon: string | null = null;
  let displayName: string | null = null;
  try {
    if (req.icon != null) icon = parseProjectLabel("icon", req.icon);
    if (req.display_name != null) displayName = parseProjectLabel("display-name", req.display_name);
  } catch (e) {
    throw new ApiFault("invalid_request", 400, (e as Error).message);
  }
  const existing = await getProject(store, slugify(req.name));
  if (existing) {
    const conflict = addConflict(existing, { kind: req.kind, remote: req.remote, icon, displayName });
    if (conflict) throw new ApiFault("refused", 409, conflict);
    return { project: existing };
  }
  if (req.key) {
    const problem = keyProblem(req.key.trim().toUpperCase());
    if (problem) throw new ApiFault("invalid_request", 400, problem);
  }
  return {
    project: await projectKeyFault(() =>
      registerProject(store, { name: req.name, kind: req.kind as Kind, remote: req.remote ?? null, key: req.key ?? null, icon, displayName }),
    ),
  };
}

/** A key another project holds is a 409, not a 500 (1949). */
async function projectKeyFault<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ProjectKeyError) throw new ApiFault("refused", 409, e.message);
    throw e;
  }
}

export async function projectEdit(store: Store, name: string, req: ProjectEditRequest): Promise<ProjectEditResponse> {
  let patch;
  try {
    patch = parseProjectPatch({ remote: req.remote, kind: req.kind, key: req.key, icon: req.icon, displayName: req.display_name, stage: req.stage });
  } catch (e) {
    throw new ApiFault("invalid_request", 400, (e as Error).message);
  }
  const project = await projectKeyFault(() => updateProject(store, name, patch));
  if (!project) throw new ApiFault("not_found", 404, `no project '${name}'`);
  return { project };
}

export async function projectRename(store: Store, name: string, newName: string): Promise<ProjectRenameResponse> {
  const res = await renameProject(store, name, newName);
  if (!res.renamed && res.reason === "unknown") throw new ApiFault("not_found", 404, renameRefusal(name, newName, res));
  if (!res.renamed) throw new ApiFault("refused", 409, renameRefusal(name, newName, res));
  return { project: res.project };
}

export async function projectRemove(store: Store, name: string, force: boolean): Promise<ProjectRemoveResponse> {
  const res = await removeProject(store, name, { force });
  if (!res.removed && res.reason === "unknown") throw new ApiFault("not_found", 404, `no project '${name}'`);
  if (!res.removed) throw new ApiFault("refused", 409, openItemsRefusal(res.project, res.open));
  return { project: res.project };
}

// --- OB-2255: teams ------------------------------------------------------------------------------------

export async function teams(store: Store): Promise<TeamsResponse> {
  return { teams: await listTeamViews(store) };
}

export async function teamRead(store: Store, name: string): Promise<TeamResponse> {
  const t = await getTeam(store, name);
  if (!t) throw new ApiFault("not_found", 404, `no team '${name}'`);
  return { team: await teamView(store, t) };
}

/** A usage problem is a 400, an unknown team a 404 and a clash a 409, as `projectCreate` answers them. */
async function teamFault<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof UsageError) throw new ApiFault("invalid_request", 400, e.message);
    if (e instanceof UnknownTeamError) throw new ApiFault("not_found", 404, e.message);
    if (e instanceof AppError) throw new ApiFault("refused", 409, e.message);
    throw e;
  }
}

export async function teamCreate(store: Store, req: TeamCreateRequest): Promise<TeamResponse> {
  const t = await teamFault(() =>
    addTeam(store, {
      name: req.name,
      ...(req.icon != null ? { icon: parseTeamLabel("icon", req.icon) } : {}),
      ...(req.display_name != null ? { display_name: parseTeamLabel("display-name", req.display_name) } : {}),
      ...(req.projects?.length ? { projects: req.projects } : {}),
    }),
  );
  return { team: await teamView(store, t) };
}

export async function teamEdit(store: Store, name: string, req: TeamEditRequest): Promise<TeamResponse> {
  const t = await teamFault(() =>
    editTeam(store, name, {
      ...(req.icon !== undefined ? { icon: parseTeamLabel("icon", req.icon) } : {}),
      ...(req.display_name !== undefined ? { display_name: parseTeamLabel("display-name", req.display_name) } : {}),
    }),
  );
  if (!t) throw new ApiFault("not_found", 404, `no team '${name}'`);
  return { team: await teamView(store, t) };
}

export async function teamJoin(store: Store, name: string, req: TeamJoinRequest): Promise<TeamJoinResponse> {
  const res = await teamFault(() => joinTeam(store, name, req.projects));
  return { team: await teamView(store, res.team), joined: res.joined };
}

export async function teamLeave(store: Store, req: TeamLeaveRequest): Promise<TeamLeaveResponse> {
  return { left: await teamFault(() => leaveTeam(store, req.projects)) };
}

export async function teamRemove(store: Store, name: string, force: boolean): Promise<TeamRemoveResponse> {
  const res = await removeTeam(store, name, { force });
  if (!res.removed && res.reason === "unknown") throw new ApiFault("not_found", 404, `no team '${name}'`);
  if (!res.removed) throw new ApiFault("refused", 409, teamInUseRefusal(name, res.members, res.threads));
  return { team: res.team, members: res.members, threads: res.threads };
}

// --- OB-2257: team handoffs ----------------------------------------------------------------------------

export async function teamHandoffCreate(store: Store, name: string, req: TeamHandoffRequest): Promise<TeamHandoffResponse> {
  return { handoff: await teamFault(() => recordTeamHandoff(store, { team: name, role: parseTeamRole(req.role, "'role'"), body: req.body, fromThreadId: req.from_thread_id ?? null })) };
}

export async function teamHandoffLatest(store: Store, name: string, role: string | null, filter: HandoffFilter = {}): Promise<TeamHandoffResponse> {
  const r = await teamFault(async () => parseTeamRole(role, "'role'"));
  if (!(await getTeam(store, name))) throw new ApiFault("not_found", 404, `no team '${name}'`);
  return { handoff: await latestTeamHandoff(store, name, r, filter) };
}

export async function teamHandoffConsume(store: Store, name: string, id: number, req: TeamHandoffConsumeRequest): Promise<TeamHandoffResponse> {
  const h = await consumeTeamHandoff(store, name, id, req.new_thread_id);
  if (!h) throw new ApiFault("not_found", 404, `no handoff ${id} for team '${name}'`);
  return { handoff: h };
}

// --- role runs (`ob role`) -----------------------------------------------------------------------------

export async function roleRunsOpen(store: Store, name: string, role: string | null): Promise<RoleRunsResponse> {
  return { runs: await teamFault(async () => openRoleRuns(store, name, role === null ? undefined : parseTeamRole(role, "'role'"))) };
}

export async function roleRunMark(store: Store, name: string, req: RoleRunMarkRequest): Promise<RoleRunResponse> {
  return teamFault(() => markRoleRun(store, { team: name, role: parseTeamRole(req.role, "'role'"), t3Host: req.t3_host }));
}

export async function roleRunUpdate(store: Store, name: string, id: number, req: RoleRunUpdateRequest): Promise<RoleRunResponse> {
  return {
    run: await teamFault(() =>
      updateRoleRun(store, name, id, {
        ...(req.thread_id === undefined ? {} : { thread_id: req.thread_id }),
        ...(req.item_count === undefined ? {} : { item_count: req.item_count }),
        ...(req.context_tokens === undefined ? {} : { context_tokens: req.context_tokens }),
        ...(req.last_activity_at === undefined ? {} : { last_activity_at: req.last_activity_at }),
        ...(req.end_reason === undefined ? {} : { end_reason: parseEndReason(req.end_reason, "'end_reason'") }),
      }),
    ),
  };
}

// --- a role's start brief and successor note (`ob role brief`, `ob role note`, OS-55) ----------------------

export async function roleTickFindings(store: Store, name: string): Promise<RoleTickResponse> {
  return { findings: await teamFault(() => tickFindings(store, name)) };
}

export async function roleBriefFacts(store: Store, name: string, role: string | null): Promise<RoleBriefResponse> {
  return { facts: await teamFault(() => roleBriefStoreFacts(store, name, parseTeamRole(role, "'role'"))) };
}

export async function roleNoteWrite(store: Store, name: string, req: RoleNoteRequest): Promise<RoleRunResponse> {
  return { run: await teamFault(() => writeRoleNote(store, name, parseTeamRole(req.role, "'role'"), req.body)) };
}

export async function roleNoteShown(store: Store, name: string, runId: number): Promise<{ ok: true }> {
  await teamFault(() => markRoleNoteShown(store, name, runId));
  return { ok: true };
}

// --- a team role's inbox (`ob send`, `ob inbox`) ---------------------------------------------------------

export async function roleMessageSend(store: Store, name: string, req: RoleMessageRequest): Promise<RoleMessageResponse> {
  const kind = req.kind ?? "message";
  if (!(ROLE_MESSAGE_KINDS as readonly string[]).includes(kind)) throw new ApiFault("invalid_request", 400, `'kind' must be one of ${ROLE_MESSAGE_KINDS.join("|")}`);
  return teamFault(() =>
    sendRoleMessage(store, {
      team: name,
      role: parseTeamRole(req.role, "'role'"),
      from: req.from,
      kind: kind as RoleMessageKind,
      ref: req.ref ?? null,
      body: req.body,
      clientKey: req.client_key ?? null,
    }),
  );
}

export async function roleMessagesList(store: Store, name: string, role: string | null, unread: boolean): Promise<RoleMessagesResponse> {
  return { messages: await teamFault(() => listRoleMessages(store, name, parseTeamRole(role, "'role'"), { all: !unread })) };
}

export async function roleMessagesRead(store: Store, name: string, req: RoleMessagesReadRequest): Promise<RoleMessagesResponse> {
  return { messages: await teamFault(() => markRoleMessagesRead(store, name, parseTeamRole(req.role, "'role'"), req.ids, req.by)) };
}

export async function briefRead(store: Store, q: string | null, inFlight: boolean): Promise<BriefResponse> {
  if (inFlight) return { brief: await buildInFlightBrief(store) };
  if (!q) throw new ApiFault("invalid_request", 400, "'q' is required (or set in_flight=true)");
  const row = await resolveItem(store, q);
  if (!row) throw new ApiFault("not_found", 404, `no item or linear ref '${q}'`);
  return { brief: await buildItemBrief(store, row) };
}

export async function logList(store: Store, query: LogQuery): Promise<LogListResponse> {
  if (query.type && !isJournalType(query.type)) {
    throw new ApiFault("invalid_request", 400, `'type' must be one of ${JOURNAL_TYPES.join("|")}`);
  }
  const since = query.since ?? (await getCursorFor(store, "standup_last")) ?? undefined;
  return { entries: orderJournal(await listJournal(store, { since, type: query.type })) };
}

export async function logCreate(store: Store, req: LogCreateRequest): Promise<LogCreateResponse> {
  if (!isJournalType(req.type)) {
    throw new ApiFault("invalid_request", 400, `'type' must be one of ${JOURNAL_TYPES.join("|")}`);
  }
  if (!req.text.trim()) throw new ApiFault("invalid_request", 400, "'text' must be a non-empty string");
  return { entry: await logEntry(store, { type: req.type, text: req.text, about: req.about, itemId: req.item }) };
}

export async function jobsRead(store: Store): Promise<JobsResponse> {
  return { jobs: await jobHealth(store) };
}

export async function deploysRead(store: Store): Promise<DeploysResponse> {
  return { deploys: await listDeploys(store) };
}

export async function deployRecord(store: Store, req: DeployRecordRequest): Promise<DeployRecordResponse> {
  if (!(DEPLOY_RESULTS as readonly string[]).includes(req.result)) {
    throw new ApiFault("invalid_request", 400, `'result' must be one of ${DEPLOY_RESULTS.join("|")}`);
  }
  if (req.at !== undefined && canonicalDeployAt(req.at) === null) {
    throw new ApiFault("invalid_request", 400, `'at' must be an ISO date, not '${req.at}'`);
  }
  await recordDeploy(store, req);
  const rows = await listDeploys(store);
  const row = rows.find((r) => r.target === req.target);
  if (!row) throw new ApiFault("invalid_request", 400, `deploy record for '${req.target}' did not persist`);
  return { deploy: row };
}

export async function alertsRead(store: Store): Promise<AlertsResponse> {
  const focusProject = await getFocusProject(store);
  return { alerts: await filterSnoozed(store, await computeAlerts(store, { focusProject })) };
}

export async function alertsSnooze(store: Store, req: AlertSnoozeRequest): Promise<AlertSnoozeResponse> {
  const focusProject = await getFocusProject(store);
  try {
    await snoozeAlert(store, req.key, focusProject);
  } catch (err) {
    if (err instanceof UsageError) throw new ApiFault("not_found", 404, err.message);
    throw err;
  }
  return { snoozed: req.key, alerts: (await alertsRead(store)).alerts };
}

/** OB-1762: the dashboard's `ackAlert`. The same write as a snooze (suppress until the alert's state moves). */
export async function alertsAck(store: Store, req: AlertAckRequest): Promise<AlertAckResponse> {
  const { alerts } = await alertsSnooze(store, req);
  return { acked: req.key, alerts: alerts ?? [] };
}

// A UsageError from these (a bad project, an empty title, a non-reference id) is answered 400 by the server.
export async function docsList(store: Store, project?: string): Promise<DocsResponse> {
  return { docs: await docList(store, project) };
}

export async function docShow(store: Store, id: string): Promise<DocResponse> {
  return docRead(store, requireDoc(await requireItem(store, id), id));
}

export async function docCreateHandler(store: Store, req: DocCreateRequest): Promise<DocResponse> {
  return docCreate(store, req);
}

export async function docSetHandler(store: Store, id: string, req: DocSetRequest): Promise<DocResponse> {
  return docSet(store, requireDoc(await requireItem(store, id), id), req);
}

export async function decisionsList(store: Store, status?: string): Promise<DecisionsResponse> {
  const items = await queryItems(store, { type: "decision", status });
  items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { decisions: items.map((i) => ({ id: i.id, status: i.status, title: i.title })) };
}

export async function decisionShow(store: Store, id: string): Promise<DecisionShowResponse> {
  await refuseAmbiguousBareNumber(store, id);
  const item = await getItem(store, id);
  if (!item) throw new ApiFault("not_found", 404, `decision '${id}' does not exist`);
  id = item.id;
  if (item.type !== "decision") throw new ApiFault("invalid_request", 400, `'${id}' is not a decision`);
  const detail = await getDecisionDetail(store, id);
  const links = await getLinks(store, id);
  const references = links.filter((l) => l.rel_type === "references").map((r) => ({ direction: r.direction, id: r.other }));
  const chain = chainFrom(await collectSupersedeEdges(store, id), id);
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    detail,
    references,
    supersedes: chain.supersedes,
    superseded_by: chain.supersededBy,
  };
}

export async function decisionSupersede(store: Store, req: DecisionSupersedeRequest): Promise<DecisionSupersedeResponse> {
  try {
    return await supersede(store, req.new_id, req.old_id);
  } catch (err) {
    if (err instanceof UsageError) throw new ApiFault("invalid_request", 400, err.message);
    throw err;
  }
}

export async function learningsList(store: Store, status?: string): Promise<LearningsResponse> {
  const items = await queryItems(store, { type: "learning", status });
  items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const learnings = await Promise.all(
    items.map(async (i) => {
      const d = await getLearningDetail(store, i.id);
      return {
        id: i.id,
        status: i.status,
        kind: (d?.kind as string | null) ?? null,
        progress: (d?.progress as string | null) ?? null,
        title: i.title,
      };
    }),
  );
  return { learnings };
}

export async function learningShow(store: Store, id: string): Promise<LearningShowResponse> {
  await refuseAmbiguousBareNumber(store, id);
  const item = await getItem(store, id);
  if (!item) throw new ApiFault("not_found", 404, `learning '${id}' does not exist`);
  id = item.id;
  if (item.type !== "learning") throw new ApiFault("invalid_request", 400, `'${id}' is not a learning item`);
  const detail = await getLearningDetail(store, id);
  const links = await getLinks(store, id);
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    detail,
    references: links.filter((l) => l.rel_type === "references").map((r) => ({ direction: r.direction, id: r.other })),
  };
}

export async function roadmapsList(store: Store): Promise<RoadmapsResponse> {
  const roadmaps = await queryItems(store, { type: "roadmap" });
  return {
    roadmaps: await Promise.all(
      roadmaps.map(async (r) => ({
        id: r.id,
        status: r.status,
        title: r.title,
        progress: computeProgress(await getRoadmapMembers(store, r.id)),
      })),
    ),
  };
}

export async function roadmapShow(store: Store, id: string): Promise<RoadmapShowResponse> {
  await refuseAmbiguousBareNumber(store, id);
  const item = await getItem(store, id);
  if (!item) throw new ApiFault("not_found", 404, `item '${id}' does not exist`);
  id = item.id;
  if (item.type !== "roadmap") throw new ApiFault("invalid_request", 400, `item '${id}' is not a roadmap`);
  const detail = await getRoadmapDetail(store, id);
  const targetDate = (detail?.target_date as string | null | undefined) ?? null;
  const members = await getRoadmapMembers(store, id);
  const progress = computeProgress(members);
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    created_at: item.created_at,
    target_date: targetDate,
    source_ref: (detail?.source_ref as string | null | undefined) ?? null,
    owner: (detail?.owner as string | null | undefined) ?? null,
    body: item.body,
    members,
    progress,
    on_track: onTrack(progress.fraction, item.created_at, targetDate, new Date()),
  };
}

export async function roadmapAddMember(
  store: Store,
  roadmapId: string,
  req: RoadmapAddMemberRequest,
): Promise<RoadmapAddMemberResponse> {
  await refuseAmbiguousBareNumber(store, roadmapId);
  const roadmap = await getItem(store, roadmapId);
  if (!roadmap) throw new ApiFault("not_found", 404, `item '${roadmapId}' does not exist`);
  if (roadmap.type !== "roadmap") throw new ApiFault("invalid_request", 400, `item '${roadmapId}' is not a roadmap`);
  const itemId = (await requireItem(store, req.item_id)).id;
  roadmapId = roadmap.id;
  await addLink(store, itemId, "roadmap_member", roadmapId);
  if (req.position !== undefined) {
    await store.q
      .update(store.t.itemLink)
      .set({ position: req.position })
      .where(
        and(
          eq(store.t.itemLink.fromItem, itemId),
          eq(store.t.itemLink.toItem, roadmapId),
          eq(store.t.itemLink.relType, "roadmap_member"),
        ),
      );
  }
  return { id: itemId, ref: await refOf(store, itemId) };
}

export async function standupLatest(store: Store): Promise<StandupLatestResponse> {
  return { standup: await latestStandup(store) };
}

export async function standupSave(store: Store, req: StandupWriteRequest): Promise<StandupWriteResponse> {
  const date = req.date ?? standupToday();
  await saveGenerated(store, date, req.md);
  return { date };
}

export async function standupSet(store: Store, req: StandupWriteRequest): Promise<StandupWriteResponse> {
  const date = req.date ?? standupToday();
  await setEdited(store, date, req.md);
  return { date };
}

export async function standupPosted(store: Store, date?: string): Promise<StandupPostedResponse> {
  const d = date ?? standupToday();
  return { date: d, posted: await markPosted(store, d) };
}

export async function slackUnread(store: Store, query: SlackUnreadQuery): Promise<SlackUnreadResponse> {
  const limit = query.limit ?? 20;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new ApiFault("invalid_request", 400, "'limit' must be a positive integer");
  }
  return { messages: await recentSlackMessages(store, limit) };
}

// --- 456: remaining DATA commands ---------------------------------------------------------------------

import {
  addPersonFor,
  getPersonFor,
  listPersonsFor,
  personDisplay,
  redactPerson,
  resolvePersonArgFor,
  resolvePersonFor,
  rmPersonFor,
  setPersonFor,
} from "../commands/person.ts";
// OB-2271: the tournament store's core. The API calls it, never a second implementation.
import { addTournament, listTournaments, pickTournament, recordMatch, setCandidate, showTournament } from "../tournament.ts";
// OB-2097: the overnight log's core. The API calls it, never a second implementation.
import { addSummaryLine, decide, listRuns, showNight, startRun } from "../overnight.ts";
import { syncGithub } from "../ingest/github.ts";
import { rankClasses, scopeFromPr } from "../commands/reviewmiss.ts";
import { machineAudit } from "../machine-audit.ts";
import { getSkillCursorFor, setSkillCursorFor } from "../commands/admin.ts";
import {
  addTestUserFor,
  defaultSecretRef,
  getTestUserFor,
  listTestUsersFor,
  recordSecretSeenFor,
  secretStaleness,
  setTestUserSecret,
  testUserSecretPresent,
} from "../commands/testuser.ts";
import { statusHistoryPage, statusTray } from "../../../../platform/cli-whatsapp/src/whatsapp/status.ts";
import { BridgeOutcomeUnknown, SendMaybeAlreadyGone, describeAttachment, sendWhatsapp, type WhatsappAttachment } from "../../../../platform/cli-whatsapp/src/whatsapp/send.ts";
import {
  applyChatPref,
  getChatPref,
  listFavoriteChats,
  listHiddenChats,
} from "../../../../platform/cli-whatsapp/src/whatsapp/prefs.ts";
import type { ClaudeRunner } from "../../../../platform/cli-whatsapp/src/whatsapp/suggest.ts";
import { recordEventFor, eventsBetweenFor } from "../events.ts";
import { nowIso } from "../db.ts";
import { readNumber } from "../db/store.ts";
import {
  WHATSAPP_CHATS_CAP,
  WHATSAPP_CHATS_DEFAULT,
  type WhatsappChatsQuery,
  type WhatsappChatsResponse,
  type WhatsappStatusQuery,
  type WhatsappStatusResponse,
} from "./contract.ts";
import type {
  CursorGetResponse,
  CursorSetRequest,
  CursorSetResponse,
  TournamentListResponse,
  TournamentResponse,
  TournamentViewResponse,
  TournamentAddRequest,
  TournamentCandidateRequest,
  TournamentCandidateResponse,
  TournamentRecordRequest,
  TournamentMatchResponse,
  TournamentPickRequest,
  OvernightDecideRequest,
  OvernightDecisionResponse,
  OvernightNightResponse,
  OvernightRunResponse,
  OvernightRunsResponse,
  OvernightShowRequest,
  OvernightStartRequest,
  OvernightStartResponse,
  OvernightSummaryRequest,
  PeopleResponse,
  PersonCreateRequest,
  PersonCreateResponse,
  PersonRmRequest,
  PersonRmResponse,
  PersonSetRequest,
  PersonSetResponse,
  PersonShowResponse,
  ReviewMissAddRequest,
  ReviewMissAddResponse,
  ReviewMissTopResponse,
  MachineAuditResponse,
  SyncRequest,
  SyncResponse,
  TestUserCheckRequest,
  TestUserCheckResponse,
  TestUserCreateRequest,
  TestUserCreateResponse,
  TestUserShowResponse,
  TestUsersResponse,
  WhoisResponse,
} from "./contract.ts";

async function requirePersonArg(store: Store, key: string): Promise<NonNullable<Awaited<ReturnType<typeof resolvePersonArgFor>>>> {
  const p = await resolvePersonArgFor(store, key);
  if (!p) throw new ApiFault("not_found", 404, `no person matches '${key}'`);
  return p;
}

export async function peopleList(store: Store): Promise<PeopleResponse> {
  return { people: (await listPersonsFor(store)).map((p) => redactPerson(p)) };
}

export async function peopleCreate(store: Store, req: PersonCreateRequest): Promise<PersonCreateResponse> {
  if (!req.real_name.trim()) throw new ApiFault("invalid_request", 400, "'real_name' is required");
  try {
    return { person: redactPerson(await addPersonFor(store, req.real_name, req.fields ?? {})) };
  } catch (err) {
    if (err instanceof AppError) throw new ApiFault("refused", 409, err.message);
    throw err;
  }
}

export async function peopleShow(store: Store, q: string, reveal: boolean): Promise<PersonShowResponse> {
  const p = await requirePersonArg(store, q);
  return { person: redactPerson(p, reveal) };
}

export async function peopleSet(store: Store, req: PersonSetRequest): Promise<PersonSetResponse> {
  try {
    return { person: redactPerson(await setPersonFor(store, req.id, req.fields)) };
  } catch (err) {
    if (err instanceof AppError) throw new ApiFault("not_found", 404, err.message);
    throw err;
  }
}

export async function peopleRm(store: Store, req: PersonRmRequest): Promise<PersonRmResponse> {
  if (!(await rmPersonFor(store, req.id))) throw new ApiFault("not_found", 404, `no person with id ${req.id}`);
  return { id: req.id };
}

export async function whoisLookup(store: Store, handle: string): Promise<WhoisResponse> {
  const p = await resolvePersonFor(store, handle);
  if (!p) throw new ApiFault("not_found", 404, `no person matches '${handle}'`);
  return { person: redactPerson(p) };
}

// --- OB-2271: persona tournaments ----------------------------------------------------------------------
// Thin: every rule (the match file contract, the refusals, the finalists) lives in tournament.ts, so a refusal
// reads the same over HTTP as it does locally.

export async function tournamentList(store: Store, query: { repo?: string }): Promise<TournamentListResponse> {
  return { tournaments: await listTournaments(store, query) };
}

export async function tournamentAdd(store: Store, req: TournamentAddRequest): Promise<TournamentResponse> {
  return { tournament: await addTournament(store, req) };
}

export async function tournamentShow(store: Store, id: number): Promise<TournamentViewResponse> {
  return { tournament: await showTournament(store, id) };
}

export async function tournamentCandidate(store: Store, id: number, req: TournamentCandidateRequest): Promise<TournamentCandidateResponse> {
  return { candidate: await setCandidate(store, id, req) };
}

export async function tournamentRecord(store: Store, id: number, req: TournamentRecordRequest): Promise<TournamentMatchResponse> {
  return { match: await recordMatch(store, id, req.match, { replace: req.replace === true }) };
}

export async function tournamentPick(store: Store, id: number, req: TournamentPickRequest): Promise<TournamentResponse> {
  return { tournament: await pickTournament(store, id, req.candidate, req.note ?? null) };
}

// --- OB-2097: the overnight decision log ---------------------------------------------------------------
// Thin: every rule (the template, the sections, a night needs its run doc) lives in overnight.ts.

export async function overnightStart(store: Store, req: OvernightStartRequest): Promise<OvernightStartResponse> {
  return startRun(store, req);
}

export async function overnightDecide(store: Store, req: OvernightDecideRequest): Promise<OvernightDecisionResponse> {
  return { decision: await decide(store, req) };
}

export async function overnightSummary(store: Store, req: OvernightSummaryRequest): Promise<OvernightRunResponse> {
  return { run: await addSummaryLine(store, req) };
}

export async function overnightShow(store: Store, req: OvernightShowRequest): Promise<OvernightNightResponse> {
  return { night: await showNight(store, req) };
}

export async function overnightRuns(store: Store, query: { project?: string; since?: string }): Promise<OvernightRunsResponse> {
  return { runs: await listRuns(store, query) };
}

export async function reviewMissAdd(store: Store, req: ReviewMissAddRequest): Promise<ReviewMissAddResponse> {
  const scope = req.scope ?? scopeFromPr(req.pr);
  await recordEventFor(store, {
    ts: nowIso(),
    source: "skill:code-review",
    type: "review_miss",
    payload: { pr: req.pr, class: req.class, finding: req.finding, scope },
  });
  return { class: req.class, scope, pr: req.pr };
}

export async function reviewMissTop(store: Store, query: { scope?: string; limit?: number }): Promise<ReviewMissTopResponse> {
  const limit = query.limit ?? 10;
  const rows = await eventsBetweenFor(store, { type: "review_miss" });
  const events = rows
    .map((r) => {
      let payload: { class?: string; scope?: string } = {};
      try {
        payload = r.payload ? (JSON.parse(r.payload) as { class?: string; scope?: string }) : {};
      } catch {
        payload = {};
      }
      return { class: payload.class ?? "", ts: r.ts, scope: payload.scope ?? "global" };
    })
    .filter((e) => e.class.length > 0);
  return { ranked: rankClasses(events, new Date(), { scope: query.scope, limit }) };
}

/** OS-170: the read-only machine audit. */
export async function machineAuditRead(store: Store, query: { since?: string; staleDays?: number }): Promise<MachineAuditResponse> {
  return machineAudit(store, query);
}

export async function cursorGet(store: Store, skill: string, key: string): Promise<CursorGetResponse> {
  return { value: (await getSkillCursorFor(store, skill, key)) ?? "" };
}

export async function cursorSet(store: Store, req: CursorSetRequest): Promise<CursorSetResponse> {
  await setSkillCursorFor(store, req.skill, req.key, req.value);
  return { value: req.value };
}

export async function testUsersList(store: Store, filter: { role?: string; env?: string }): Promise<TestUsersResponse> {
  const rows = await listTestUsersFor(store, filter);
  const users = await Promise.all(
    rows.map(async (r) => ({ ...r, secret_present: await testUserSecretPresent(store, store, r.label) })),
  );
  return { users };
}

export async function testUserCreate(
  store: Store,
  req: TestUserCreateRequest,
  deps?: SecretDeps,
): Promise<TestUserCreateResponse> {
  if (!req.label.trim()) throw new ApiFault("invalid_request", 400, "'label' is required");
  if (!req.value.trim()) throw new ApiFault("invalid_request", 400, "'value' is required");
  try {
    // Resolve the key before the row exists, so a refused key leaves no orphan row (OB-1911).
    const key = (await writeKeyOf(deps, store)).get();
    const user = await addTestUserFor(store, {
      label: req.label,
      role: req.role,
      email: req.email,
      workspace: req.workspace,
      env: req.env,
      secretRef: req.secret_ref,
      notes: req.notes,
    });
    try {
      await setTestUserSecret(store, store, req.label, req.value, key);
    } catch (e) {
      rethrowRedacted(e, req.value);
    }
    return { user };
  } catch (err) {
    if (err instanceof AppError) throw new ApiFault("refused", 409, err.message);
    throw err;
  }
}

export async function testUserShow(store: Store, label: string): Promise<TestUserShowResponse> {
  const user = await getTestUserFor(store, label);
  if (!user) throw new ApiFault("not_found", 404, `no test-user with label '${label}'`);
  const secret_present = await testUserSecretPresent(store, store, label);
  return { user, secret_present, staleness: secretStaleness(user.secret_set_at) };
}

export async function testUserCheck(store: Store, req: TestUserCheckRequest): Promise<TestUserCheckResponse> {
  const user = await getTestUserFor(store, req.label);
  if (!user) throw new ApiFault("not_found", 404, `no test-user with label '${req.label}'`);
  const ref = user.secret_ref ?? defaultSecretRef(user.label);
  const secret_present = await testUserSecretPresent(store, store, req.label);
  if (secret_present && user.secret_set_at === null) await recordSecretSeenFor(store, user.label);
  return { label: user.label, secret_ref: ref, secret_present };
}

// --- the rest of `ob whatsapp` (OB-1809) ----------------------------------------------------------------

/** The seam a WhatsApp send reaches outside the process through; tests inject it. */
export interface WhatsappSendDeps {
  /** The WhatsApp bridge transport. Production leaves it unset: global fetch. */
  fetch?: typeof fetch;
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * The human gate is on the caller's terminal, because that is where the human is. This route is the second half
 * of the same rule: no literal confirm:true, no send. `sendWhatsapp` checks it again. The text goes to the bridge
 * byte for byte, since what was confirmed is what must arrive.
 */
export async function whatsappSend(store: Store, req: WhatsappSendRequest, deps: WhatsappSendDeps = {}): Promise<WhatsappSendResponse> {
  if (req.confirm !== true) {
    throw new ApiFault("invalid_request", 400, "refusing to send: the body must carry confirm:true, set only after a human confirmed the send");
  }
  if (!req.body && !req.file) throw new ApiFault("invalid_request", 400, "'body' is required when there is no file");
  let dir: string | undefined;
  try {
    let file: WhatsappAttachment | undefined;
    if (req.file) {
      const { name, data_base64 } = req.file;
      if (name === "." || name === ".." || /[/\\\0]/.test(name)) {
        throw new ApiFault("invalid_request", 400, "'file.name' must be a plain file name");
      }
      if (!BASE64_RE.test(data_base64)) throw new ApiFault("invalid_request", 400, "'file.data_base64' is not base64");
      // Under a private directory, for the bridge to read during the send: it runs as this same user, and it
      // takes a path rather than bytes. Described again here, so the allow-list holds for any caller.
      dir = mkdtempSync(join(tmpdir(), "ob-whatsapp-send-"));
      const path = join(dir, name);
      writeFileSync(path, Buffer.from(data_base64, "base64"), { mode: 0o600 });
      file = describeAttachment(path);
    }
    return await sendWhatsapp(store, { to: req.to, body: req.body, file, confirm: true, resend: req.resend === true, fetch: deps.fetch });
  } catch (e) {
    if (e instanceof SendMaybeAlreadyGone) throw new ApiFault("refused", 409, e.message); // OB-1909: check the chat, or --resend
    if (e instanceof BridgeOutcomeUnknown) throw new ApiFault("internal", 502, e.message); // the client says it may have gone
    throw e;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export async function whatsappPref(store: Store, req: WhatsappPrefRequest): Promise<WhatsappPrefResponse> {
  await applyChatPref(store, req.chat_jid, req.action);
  return { chat_jid: req.chat_jid, ...(await getChatPref(store, req.chat_jid)) };
}

export async function whatsappPrefChats(store: Store, list: "hidden" | "favorites"): Promise<WhatsappPrefChatsResponse> {
  return { chats: list === "hidden" ? await listHiddenChats(store) : await listFavoriteChats(store) };
}

export async function syncRun(store: Store, req: SyncRequest = {}): Promise<SyncResponse> {
  const source = req.source;
  if (source && source !== "github") {
    throw new ApiFault("invalid_request", 400, "'source' must be github");
  }
  const opts = { since: req.since, backfill: req.backfill };
  return { github: await syncGithub(store, opts) };
}

// --- OB-2276: GitHub webhooks, `ob ci main`, `ob github hooks` ------------------------------------------------
// Thin: every rule (the signature, told once, the recovery, the hook plan) lives in ci-main.ts. The REST client is
// built from the `github` secret on this host only when a call needs it; the T3 seam is `t3Seam()` unless injected.
import {
  ciMainList,
  ciMainNotify,
  githubRestFor,
  hooksApply,
  hooksPlan,
  httpGithubRest,
  readWebhookSecret,
  requireWebhookSecret,
  type CiDeps,
  type GithubRest,
} from "../ci-main.ts";
import { readGithubToken } from "../net.ts";
import { storeAgentRegistry } from "../t3/dispatch.ts";
import type { CiMainNotifyResponse, CiMainResponse, GithubHooksResponse } from "./contract.ts";

/** The seams the webhook needs beyond the module seams (`__setGithubRest`, `__setT3Seam`). Tests inject both. */
export interface CiApiDeps {
  sleep?: (ms: number) => Promise<void>;
  /** Runs the work a webhook leaves after its answer. Default: started and not awaited, a failure reported. */
  defer?: (work: () => Promise<void>) => void;
}

/** A REST client that reads the `github` token on its first call, so a request that needs no REST reads none. */
export function lazyGithubRest(store: Store, secrets: SecretDeps | undefined): GithubRest {
  let made: Promise<GithubRest> | null = null;
  const get = () => (made ??= githubRestFor(async () => httpGithubRest(await readGithubToken(store, keyOf(secrets)))));
  return { request: async (method, path, body) => (await get()).request(method, path, body) };
}

export function ciDeps(store: Store, secrets: SecretDeps | undefined, ci: CiApiDeps | undefined): CiDeps {
  return { rest: lazyGithubRest(store, secrets), registry: storeAgentRegistry(store), ...(ci?.sleep ? { sleep: ci.sleep } : {}) };
}

/** The webhook secret, or null when none is stored on this host. */
export async function webhookSecret(store: Store, secrets: SecretDeps | undefined): Promise<string | null> {
  return readWebhookSecret(store, keyOf(secrets));
}

export async function ciMainRead(store: Store, project: string | undefined, secrets: SecretDeps | undefined): Promise<CiMainResponse> {
  return { reports: await ciMainList(store, lazyGithubRest(store, secrets), project ? { project } : {}) };
}

export async function ciMainNotifyRun(store: Store, project: string | undefined, secrets: SecretDeps | undefined, ci: CiApiDeps | undefined): Promise<CiMainNotifyResponse> {
  return ciMainNotify(store, ciDeps(store, secrets, ci), project ? { project } : {});
}

export async function githubHooksRead(store: Store, secrets: SecretDeps | undefined): Promise<GithubHooksResponse> {
  return { rows: await hooksPlan(store, lazyGithubRest(store, secrets)), dry_run: true };
}

export async function githubHooksApply(store: Store, secrets: SecretDeps | undefined): Promise<GithubHooksResponse> {
  const secret = await requireWebhookSecret(store, keyOf(secrets));
  return { rows: await hooksApply(store, lazyGithubRest(store, secrets), secret), dry_run: false };
}

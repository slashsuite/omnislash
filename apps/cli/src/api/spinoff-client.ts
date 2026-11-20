// ob 360: `ob spinoff` from anywhere the laptop is.
//
// THE CLASSIFICATION WAS THE BUG. ob 353 marked the whole command local-only because it touches the
// database, and its refusal told the reader to "run it on the machine that has both the checkouts and the
// database: the API host". The API host has none of the client's checkouts. That sentence
// sent the owner, at the office, to the one machine that cannot do the job.
//
// The two halves live in different places and NEITHER of them is the API host:
//
//   the queue, the ticket, the leases   -> Postgres, over the API. ob 337c already ported every one of
//                                          these writes to the store, so they were ready to be served.
//   the worktree, the agent spawn,      -> the machine in front of the human, which is the laptop he is
//   the agent spawn, cleanup's git         typing on.
//
// So a spinoff from the office needs HIS MACHINE PLUS THE API, which is exactly what he has. This is the
// same hybrid split ob 352/353 made for `secret` (the data half is served; anything about this machine is
// not), applied one command over rather than invented a second time.
//
// WHAT MUST SURVIVE THE SPLIT, and does:
//
//   ob 308's race fix. The claim is still ONE conditional `UPDATE ... WHERE status='pending' RETURNING *`,
//   executed on the authoritative database inside `POST /spinoffs/claim`. This module never reads a row and
//   then writes it: it asks, and the database decides. Two drains that both ask get one row between them.
//
//   ob 191's split. Claim FIRST (it is the exclusion), launch here in between, stamp after. When the stamp
//   cannot be recorded, the launch that DID happen is reported with the command that finishes the job, and
//   the claim lease lapses so `ob spinoff reclaim` re-queues the row. Nothing half-runs silently.
//
// The launch decisions themselves are not re-implemented here. They come from the config-driven cores in
// commands/spinoff.ts (`launchNotReadyIn`, `prepareLaunchIn`, `launchRowIn`), which are the same functions
// the store-backed drain reaches through `settingFor` -- one decision procedure, two ways in.
import { stageIn } from "../stage.ts";
import { teamMembersIn, teamOfIn, teamHandoffTarget, type HandoffRoute } from "../team.ts";
import { builderIdOf, isObRepo, legRef } from "../../../../platform/cli-coord/src/clean-repo.ts";
import { dispatchTrialPair, legBranch } from "../../../../platform/cli-coord/src/spinoff-trial.ts";
import { gitLegDiff, liveFileIO, liveMeasureDeps, runTrialCli } from "../../../../platform/cli-coord/src/spinoff-trial-cli.ts";
import { AppError, UsageError } from "../errors.ts";
import { existsSync } from "node:fs";
import { print, warn } from "../output.ts";
import { WORK_TAGS } from "../work-tags.ts";
import { formatSpikeReport, isSpikeTagged } from "../../../../platform/cli-coord/src/spinoff-spike.ts";
import { parseSince, reportMix } from "../../../../platform/cli-coord/src/spinoff-mix.ts";
import { abandonSpinoff, renderAbandon, type AbandonDeps } from "../../../../platform/cli-coord/src/spinoff-abandon.ts";
import { formatHold, leaseHolderId, ticketLeaseKey, worktreeLeaseKey, type LeaseHold } from "../../../../platform/cli-coord/src/lease.ts";
import {
  cleanupWorktrees,
  formatReadyReport,
  rejectAgentFlag,
  reportSpinoffCheck,
  spinoffAskFor,
  spinoffCheckArgs,
  gitMergedChecker,
  gitUniqueCommitCount,
  isLauncherName,
  launchNotReadyIn,
  launchRowIn,
  launcherRejection,
  launchedUrgentNote,
  renderAlreadyLine,
  renderLaunchedLine,
  renderQueuedLine,
  type UrgentTierNote,
  tierFlag,
  tierModelsOrRefuse,
  effortFlag,
  prepareLaunchIn,
  renderCleanupLines,
  renderDrainLines,
  landedTicketRefsVia,
  renderSpinoffList,
  renderSpinoffShow,
  pickSpinoffForShow,
  pickSpinoffForState,
  repoDispatchSlugIn,
  projectReadFailed,
  ticketProjectRepoWith,
  type TicketProjectRepo,
  drainRepoLabel,
  drainScopeLabel,
  resolveDrainScope,
  rowInDrainScope,
  tallyDrain,
  type DrainScope,
  rowRepoPathIn,
  stampArgv,
  TIER_FIT_HINT,
  CLAIM_TTL_S,
  spinoffClaimKey,
  withClaimHeartbeat,
  landArgv,
  pickSpinoffForReady,
  assertHandoffWorktree,
  spikeDocFactsFor,
  assertHandoffCiForRow,
  noteWithCi,
  gateNoteWithCi,
  landCommitFor,
  rowRelandReason,
  missingWorktreeRefusal,
  worktreeGoneNoteOutcome,
  noNoteOutcome,
  rowVerdictState,
  cleanRepoLeakLines,
  cleanRepoLeakRefusal,
  handoffNoteWithReport,
  SPINOFF_STATE_USAGE,
  renderRecordedVerdict,
  branchTakenIn,
  cleanBranchFor,
  worktreeKeyOf,
  showStateFor,
  showFilesFor,
  refuseSubcommandRef,
  readyResultJson,
  commitsAheadFor,
  headShaFor,
  rowsInTeam,
  gateableFactsFor,
  READY_FOR_GATE,
  spinoffStatusFilter,
  findLiveRow,
  type CleanupData,
  type DbHalfFailure,
  type DrainResult,
  type LandedRow,
  type LaunchPrep,
  type LeaseBlocked,
  backfillSpinoffTokens,
  renderBackfill,
  type ReconcileResult,
  type SpinoffLaunchConfig,
  type SpinoffMode,
  type SpinoffRow,
  type SpinoffSteps,
  type StampInput,
} from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { spinoffStatusWord } from "../../../../platform/cli-coord/src/spinoff-vocab.ts";
import { refuseOverUsage } from "../usage-gate.ts";
import { readRowTokens, type TokenUsage } from "../../../../platform/cli-coord/src/spinoff-tokens.ts";
import { parseIssueRef } from "../github-issues.ts";
import { renderSendBack, sendBackSpinoff, type SendBackDeps } from "../../../../platform/cli-coord/src/spinoff-sendback.ts";
import { renderReopen, reopenSpinoff, type ReopenDeps } from "../../../../platform/cli-coord/src/spinoff-reopen.ts";
import { reportGateable, type PlannedFiles } from "../../../../platform/cli-coord/src/spinoff-gateable.ts";
import { collidingRefWarning } from "../../../../platform/cli-coord/src/spinoff-item.ts";
import type { HandoffCiResult } from "../../../../platform/cli-coord/src/commands/handoff-ci.ts";
import { shellWords, splitPartialFailure } from "../remote.ts";
import { ApiError, usageOn400, type ApiClient } from "./client.ts";
import { flakeBoxPresent, noFlakeBoxWarning } from "../../../../platform/cli-coord/src/spinoff-flake.ts";
import type { ApiCtx } from "./client-handlers.ts";
import type { EnqueueSpinoffRequest, SpinoffConfig } from "./contract.ts";
import { DEFAULT_SPINOFF_TIER, refuseUnregisteredT3Project, refuseUnusableEffort, refuseOpusHigh, refuseOpusHighTrial, withOpusHighNote, T3_LAUNCHER, t3Seam, announceReadyNote, canonicalPath, clearTeamNeedsHuman, mirrorT3Runs, stopThreadOverT3, renderReadyNoteOutcome, t3ThreadHold, tierFitOf, worktreeRepoOf, type AgentRegistry, type SpinoffTier, type ReadyNoteOutcome } from "../t3/dispatch.ts";

// --- the refusals: they name THIS machine, never the API host ----------------
//
// A message that sends someone to a machine that cannot do the job is worse than no message: they act on
// it. So every refusal below says what DOES work here and what to type instead.

/**
 * `watch` is the one spinoff subcommand an API client genuinely cannot run, and the reason is mechanical:
 * its trigger is `fs.watch` on the database FILE, and a client has no database, of any kind, to watch. It
 * is refused for exactly the reason 337 refused it under Postgres -- it would block forever and report
 * nothing, which is the silent failure this whole port is ordered against.
 */
export const SPINOFF_WATCH_REFUSAL = [
  `'ob spinoff watch' cannot run on this machine: it blocks on fs.watch of the database FILE, and ob here reaches`,
  `  the tracker over the API only (map decision D2), so there is no file to watch. It would block forever and`,
  `  report nothing, which is worse than refusing.`,
  `  EVERYTHING ELSE ABOUT 'ob spinoff' WORKS HERE, on this machine: the queue goes over the API and the agent`,
  `  spawns on this laptop, which is where the checkouts are. Use 'ob spinoff reconcile' for the git-state`,
  `  pass watch would have made on each change, 'ob spinoff list' for the queue, and 'ob agents' for what is live.`,
].join("\n");

/** `#<n>` needs the tracker's GitHub credential path, which is not behind an endpoint. */
const ISSUE_REF_REFUSAL = [
  `a '#<issue>' spinoff ref needs the tracker's GitHub credential to fetch that issue's title and body, and that`,
  `  fetch is not behind an endpoint yet -- the same documented edge 'ob add --issue' has.`,
  `  refusing rather than queueing a row with a guessed branch and an empty brief.`,
  `  queue it by its ob ref instead ('ob spinoff <id>'), or say the ask directly: --branch <b> --brief -`,
].join("\n");

// --- small helpers -----------------------------------------------------------

function flag(ctx: ApiCtx, key: string): string | undefined {
  const v = (ctx.flags as unknown as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function numberFlag(ctx: ApiCtx, key: string, fallback?: number): number {
  const raw = flag(ctx, key);
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new UsageError(`--${key} is required`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${key} must be a number, got '${raw}'`);
  return n;
}

async function readStdin(): Promise<string> {
  return (await new Response(Bun.stdin.stream()).text()).trim();
}

/**
 * The ob item behind a spinoff ref, read through the API (1190). An item-only ref (738) used to open on
 * the pointer here, because a client has no store — and that is the user-visible half of 1162 lost on
 * exactly the machine that dispatches. The enqueue already talks to this API to write the row, so
 * `GET /items/:id` is the same single call `ob show <ref>` makes, not a new class of cost.
 *
 * A 404 is a MISS: the ref resolves to no item, so the pointer is the right answer. Anything else is a
 * broken read and is thrown for `spinoffAskFor` to report and fall through — a brief never fails a dispatch.
 */
async function apiItemBriefSource(
  client: ApiClient,
  ticketRef: string,
): Promise<{ title: string | null; body: string | null } | null> {
  try {
    const { item } = await client.item(ticketRef);
    return { title: item.title, body: item.body };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/**
 * OB-2255: where a row's note goes over the API (`teamHandoffTarget`): the ticket's project's team's sentinel,
 * else its architect. A ticket naming no item (a 404) is no project, a named skip.
 */
export async function apiHandoffTarget(client: ApiClient, row: { ticket_ref: string; item_id?: string | null }): Promise<HandoffRoute> {
  return teamHandoffTarget({
    ticket: row.ticket_ref,
    projectOf: async () => {
      try {
        return (await client.item(row.item_id ?? row.ticket_ref)).item.project ?? null;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    teamOf: async (p) => teamOfIn((await client.projects()).projects)(p),
    registry: apiAgentRegistry(client),
  });
}

/** OB-2255: `--team` on `spinoff list|gateable` over the API (`GET /teams`, `GET /projects`); no team is every row. */
async function apiTeamRows(ctx: ApiCtx, cfg: SpinoffLaunchConfig, team: string | undefined, rows: SpinoffRow[]): Promise<SpinoffRow[]> {
  if (team === undefined) return rows;
  const teams = (await ctx.client.teams()).teams.map((t) => t.name);
  const members = teamMembersIn(team, teams, (await ctx.client.projects()).projects);
  return rowsInTeam(rows, members, cfg.repoCheckouts);
}

/** OB-2103: a project's stored stage over the API (null = not set, or no such project); one `GET /projects`. */
async function apiProjectStage(client: ApiClient, slug: string): Promise<string | null> {
  return stageIn((await client.projects()).projects, slug);
}

/** OB-2180: an item over the API, or null when the ref names no item here (a 404 is a miss, anything else throws). */
async function apiItemOrNull(client: ApiClient, idOrRef: string): Promise<{ id: string; status: string } | null> {
  try {
    const { item } = await client.item(idOrRef);
    return { id: item.id, status: item.status };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** An item's tags over the API; none when the ticket is not an item here (OB-1826). */
async function apiItemTags(client: ApiClient, idOrRef: string): Promise<string[]> {
  try {
    return (await client.item(idOrRef)).item.tags ?? [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}

/** OB-2230: an item's priority name over the API, or null when the ref names no item here. */
async function apiItemPriority(client: ApiClient, idOrRef: string): Promise<string | null> {
  try {
    return (await client.item(idOrRef)).item.priority ?? null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** OB-2075: is the ticket an urgent item (or a critical one, OS-108, which ranks above it)? The item lives on the host, so ask it; a miss or a failed read is "not urgent" (the launch validates the real tier model either way). */
async function apiItemUrgent(client: ApiClient, idOrRef: string): Promise<boolean> {
  try {
    const p = (await client.item(idOrRef)).item.priority;
    return p === "urgent" || p === "critical";
  } catch {
    return false;
  }
}

/** The wire config as the launch cores want it. One conversion, so the field names cannot drift silently.
 *  Exported because `ob t3 architect` (OB-2255) needs the checkout map off the same endpoint. */
export function launchConfig(wire: SpinoffConfig): SpinoffLaunchConfig {
  return {
    repoCheckouts: wire.repo_checkouts ?? {},
    launcher: wire.launcher ?? "",
    launcherByRepo: wire.launcher_by_repo ?? {},
    engine: wire.engine === "opencode" ? "opencode" : "claude", // missing/wrong engine on the wire predates 0023: those launches all were claude
    tierModels: wire.tier_models ?? "", // a host older than 1480 sends none: the defaults
  };
}

async function config(ctx: ApiCtx): Promise<SpinoffLaunchConfig> {
  return launchConfig((await ctx.client.spinoffConfig()).config);
}

/** A local half that happened whose database half did not (189). stderr, non-zero, never swallowed. */
function reportDbFailures(ctx: ApiCtx, failures: DbHalfFailure[]): void {
  if (failures.length === 0) return;
  for (const f of failures) warn(`NOT RECORDED: ${f.detail}`);
  ctx.exit = 1;
}

/**
 * OB-2130: the ticket's project as a checkout on this machine, read off the item the host serves (`ob show`'s
 * route). Null when there is no such item, it has no project, the project has no checkout here, or that
 * checkout is the cwd's own repo. A read that fails for another reason is null too, said on stderr.
 */
async function apiTicketProjectRepo(ctx: ApiCtx, cfg: SpinoffLaunchConfig, ticketRef: string): Promise<TicketProjectRepo | null> {
  let project: string | null;
  try {
    project = (await ctx.client.item(ticketRef)).item.project;
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) warn(projectReadFailed(ticketRef, e)); // no item: the cwd, quietly
    return null;
  }
  return ticketProjectRepoWith(cfg.repoCheckouts, ticketRef, project, ctx.cwd);
}

/**
 * `ob spinoff`'s repo, resolved HERE: only this machine can turn a directory into a slug (217). With no
 * `--repo`, the ticket's own project names it before the cwd does (OB-2130); `fromProject` says which won.
 */
async function repoSlug(
  ctx: ApiCtx,
  cfg: SpinoffLaunchConfig,
  command: string,
  ticketRef: string,
): Promise<{ slug: string; fromProject: TicketProjectRepo | null }> {
  const raw = flag(ctx, "repo");
  if (raw === undefined) {
    const fromProject = await apiTicketProjectRepo(ctx, cfg, ticketRef);
    if (fromProject) {
      const slug = repoDispatchSlugIn(cfg, fromProject.repo, ctx.cwd);
      if (slug.error || !slug.slug) throw new UsageError(slug.error ?? `${command} could not resolve a repo from ${fromProject.repo}`);
      warn(fromProject.notice);
      return { slug: slug.slug, fromProject };
    }
    const fromCwd = repoDispatchSlugIn(cfg, ctx.cwd, ctx.cwd);
    if (fromCwd.error || !fromCwd.slug) throw new UsageError(fromCwd.error ?? `${command} could not resolve a repo from ${ctx.cwd}`);
    return { slug: fromCwd.slug, fromProject: null };
  }
  const resolved = repoDispatchSlugIn(cfg, raw, ctx.cwd);
  if (resolved.error || !resolved.slug) throw new UsageError(resolved.error ?? `--repo '${raw}' could not be resolved`);
  return { slug: resolved.slug, fromProject: null };
}

// --- the steps, over HTTP ----------------------------------------------------

/**
 * ob 191's steps with the API as the transport rather than ssh. `cleanup` is the only sweep that uses the
 * whole interface here; the drain and reconcile call the endpoints directly, because they also need the
 * claim's ROW back and the launchable read that precedes it.
 */
export function apiSpinoffSteps(client: ApiClient): SpinoffSteps {
  return {
    reclaim: async () => {
      try {
        return { entries: (await client.reclaimSpinoffs()).reclaimed, remoteError: null };
      } catch (e) {
        return { entries: [], remoteError: (e as Error).message };
      }
    },
    claim: async (row) => {
      try {
        const res = await client.claimSpinoff({ id: row.id });
        return { claimed: res.claimed, error: res.error, remoteError: null };
      } catch (e) {
        return { claimed: null, error: null, remoteError: (e as Error).message };
      }
    },
    stamp: async (input) => {
      try {
        await client.stampSpinoff(stampBody(input));
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },
    land: async (input) => {
      try {
        const res = await client.landSpinoff({ id: input.id, tokens: input.tokens });
        return res.landed ? null : `not landed: ${res.blocked?.resource ?? "unknown"} held by ${res.blocked?.holder ?? "unknown"}`;
      } catch (e) {
        return (e as Error).message;
      }
    },
    heartbeatClaim: async (row) => {
      try {
        const claim = { resource: spinoffClaimKey(row.id), holder: row.branch, ttl_s: CLAIM_TTL_S };
        const beat = await client.acquireLease({ ...claim, heartbeat: true });
        // OB-1922: a lapsed claim is not revived by a beat; take it again with a fresh acquire
        if (!beat.ok && beat.error === "LeaseExpiredError") await client.acquireLease(claim);
      } catch {
        // a missed beat is retried by the next one; a claim that lapses is what reclaim is for (OB-1921)
      }
    },
    agentDone: async (id) => {
      try {
        const res = await client.agent({ action: "done", id });
        return { done: res.found, error: null };
      } catch (e) {
        return { done: false, error: (e as Error).message };
      }
    },
  };
}

function stampBody(input: StampInput) {
  return {
    id: input.id,
    outcome: input.outcome,
    worktree: input.worktree ?? null,
    base_sha: input.base_sha ?? null,
    launcher: input.launcher ?? null,
    session_id: input.session_id ?? null,
    engine: input.engine ?? null,
    t3_thread_id: input.t3_thread_id ?? null,
    t3_run_id: input.t3_run_id ?? null,
    model: input.model ?? null,
    effort: input.effort ?? null,
    raised: input.raised ?? false,
    error: input.error ?? null,
  };
}

/**
 * Ids and refs whose ticket is `done`, in one read. A row's `ticket_ref` is the
 * ref (`OB-2187`) since 1949 and a bare number before, so the set carries both the
 * item's internal id and its CURRENT ref (OB-2182). A ref the item held before a
 * project move is not in this read; the local path resolves it through `item_ref`. `workHasLanded` treats every other
 * status like unknown, so a per-ticket GET is wasted — and the host calls
 * `list --json` on the UI thread (937). A failed read is an empty set, not a
 * failed command: origin/main can still set `landed`.
 */
async function doneTicketIds(ctx: ApiCtx): Promise<Set<string>> {
  try {
    const res = await ctx.client.items({ status: "done" });
    return new Set((res.items ?? []).flatMap((item) => (item.ref ? [item.id, item.ref] : [item.id])));
  } catch {
    return new Set();
  }
}

/** `landedTicketRefs` for an API client: done-ids over HTTP, origin/main on this machine. Row ids out (1201). */
async function apiLandedRefs(
  ctx: ApiCtx,
  cfg: SpinoffLaunchConfig,
  rows: LandedRow[],
  doneIds?: Set<string>,
): Promise<Set<number>> {
  const done = doneIds ?? (await doneTicketIds(ctx));
  return landedTicketRefsVia(rows, {
    status: async (ref) => (done.has(ref) ? "done" : null),
    repoPath: (repo) => rowRepoPathIn(cfg, repo),
  });
}

// --- reconcile: this machine's git decides, the API records ------------------

async function apiReconcile(
  ctx: ApiCtx,
  cfg: SpinoffLaunchConfig,
  holder: string,
  caller: string,
): Promise<{ result: ReconcileResult; remoteError: string | null }> {
  const merged: string[] = [];
  const blocked: LeaseBlocked[] = [];
  const dbFailures: DbHalfFailure[] = [];
  const isMerged = gitMergedChecker();
  const countUnique = gitUniqueCommitCount();
  // The launched rows are the INPUT to every decision below, so a read that failed means the pass never
  // ran -- reported as a stopped sweep rather than as an empty one, which would read as "nothing merged".
  let rows: SpinoffRow[];
  try {
    // Building AND handed-off rows (1596): a handed-off row whose ticket closed is a landed row too.
    const building = (await ctx.client.spinoffs({ status: "launched" })).spinoffs;
    const handedOff = (await ctx.client.spinoffs({ status: READY_FOR_GATE })).spinoffs;
    rows = [...building, ...handedOff];
  } catch (e) {
    return { result: { merged, blocked, db_failures: dbFailures }, remoteError: (e as Error).message };
  }
  // Same signal as the local reconcile (932/1201): a done ticket, or a LANDING commit on origin/main
  // naming the ticket (a merge subject or a conventional scope, never a `docs(`/`chart(` note, and never
  // one older than the row's base_sha), counts even when this machine's main has not moved. A handed-off
  // (ready-for-gate) row lands on the branch being merged or on its ticket being done, never on a bare
  // commit (1596).
  // A status read that fails is not "not done" for the commit side: null, and
  // origin/main can still land the row. It must not fail the sweep.
  // 1120: mirror the live (launched and handed-off) `t3` rows' run state onto their agent rows BEFORE deciding anything from git,
  // exactly as the store-backed reconcile does. It has to run HERE: the rows come over the API, but the
  // threads live on this machine's T3, and the API host has none. Reported per row, never fatal.
  const mirror = await mirrorT3Runs(
    rows
      // OB-1923: handed-off rows too. The write only updates an existing agent row, so it cannot resurrect one.
      .filter((r) => r.launcher === T3_LAUNCHER && r.t3_thread_id)
      .map((r) => ({ ticket: r.ticket_ref, agentId: builderIdOf(r), threadId: r.t3_thread_id! })),
    apiAgentRegistry(ctx.client),
  );
  for (const skip of mirror.skipped) warn(`  ⚠ ${skip.ticket}: ${skip.reason}`);
  // OB-1710: the team half of the same mirror (OB-2255). A team thread's `needs-human` comes off when the owner's
  // next message starts a run; the registry is read over the API, the thread over this machine's T3.
  try {
    const cleared = await clearTeamNeedsHuman((await ctx.client.agents(true)).agents, apiAgentRegistry(ctx.client));
    for (const skip of cleared.skipped) warn(`  ⚠ ${skip.id}: ${skip.reason}`);
  } catch (e) {
    warn(`  ⚠ team needs-human clear skipped: ${(e as Error).message}`);
  }

  const doneIds = await doneTicketIds(ctx);
  const originDone = await apiLandedRefs(ctx, cfg, rows, doneIds);
  for (const row of rows) {
    const repo = rowRepoPathIn(cfg, row.repo); // a slug row (217) names its checkout on THIS machine
    const branchDone = isMerged(repo, row.branch) && countUnique(repo, row.base_sha, row.branch) > 0;
    const signalled = row.status === READY_FOR_GATE ? doneIds.has(row.ticket_ref) : originDone.has(row.id);
    if (!branchDone && !signalled) continue;
    // This machine's transcript, and only this machine's; OB-1991: the reader the row's model names.
    const usage = readRowTokens(row);
    // The #97 guard is applied by the endpoint, which is where the leases are: a landing must not happen
    // under a THIRD party's hold, and `blocked` comes back rather than a failure, exactly as locally.
    let landed: { landed: boolean; blocked: { resource: string; holder: string } | null };
    try {
      landed = await ctx.client.landSpinoff({ id: row.id, tokens: usage, holder, caller });
    } catch (e) {
      dbFailures.push({
        ticket: row.ticket_ref,
        detail: splitPartialFailure({
          didLocally: branchDone
            ? `${row.ticket_ref} has merged into main here`
            : `${row.ticket_ref} has landed (ticket done, or a landing commit on origin/main)`,
          missing: "retiring the row",
          detail: (e as Error).message,
          recover: `ob ${landArgv(row.id, usage).join(" ")}`,
        }),
      });
      continue;
    }
    if (!landed.landed) {
      if (landed.blocked) blocked.push({ ticket: row.ticket_ref, resource: landed.blocked.resource, holder: landed.blocked.holder });
      continue;
    }
    merged.push(row.ticket_ref);
  }
  return { result: { merged, blocked, db_failures: dbFailures, mirrored: mirror.mirrored, mirror_skipped: mirror.skipped }, remoteError: null };
}

/**
 * The agent-registry seam over HTTP (1120): the row the run-state mirror and `ob t3 architect|sentinel|muse` read and
 * write, reached through `GET /agents?all=1` and `POST /agents`.
 *
 * `all` on the READ matters for the architect (an idle architect's row expires after its TTL, and the thread
 * id it carries is the whole reason the command is idempotent); the mirror only ever writes, so it does
 * not care — one implementation serves both. The mirror writes through `setRun` (the `set-run` action),
 * which updates an existing row and never creates one (OB-1923).
 */
export function apiAgentRegistry(client: ApiClient): AgentRegistry {
  return {
    read: async (id) => {
      const row = (await client.agents(true)).agents.find((a) => a.id === id);
      return row ? { session_id: row.session_id, launcher: row.launcher, status: row.status, run: row.run } : null;
    },
    register: async (input) => {
      await client.agent({
        action: "register",
        id: input.id,
        ticket: input.ticket ?? null,
        worktree: input.worktree,
        branch: input.branch ?? null,
        status: input.status ?? null,
        run: input.run ?? null,
        launcher: input.launcher,
        session_id: input.sessionId ?? null, // explicit: the marker write has no id yet
        ttl_s: input.ttlS,
        no_lease: true, // a registry write for a T3 thread is not a fresh claim on its ticket
      });
    },
    setRun: async (id, run) => (await client.agent({ action: "set-run", id, run })).found,
  };
}

// --- drain: the claim goes over the wire, the launch stays here --------------

/**
 * Compose and send the readying note from an API client (1133). The rows, the registry and the ticket's team
 * come over the wire (tracker data); the SEND runs here, where T3 is, exactly as the settle and the launch half do.
 */
/**
 * OB-2172: the readying note over the API, with its outcome kept on the host's row (`note_error`), so the
 * architect sees a failed note on gateable and show whichever step failed. A skip writes nothing.
 */
async function announceReadyOverApi(
  ctx: ApiCtx,
  row: SpinoffRow,
  state: string | null,
  builderNote: string | null,
  tierFit: string | null,
  repeat = false,
  spike = false,
  spikeDoc: { committed: boolean; prUrl: string | null } | null = null,
): Promise<ReadyNoteOutcome> {
  const outcome = await composeReadyOverApi(ctx, row, state, builderNote, tierFit, repeat, spike, spikeDoc);
  if (outcome.outcome === "skipped") return outcome;
  try {
    await ctx.client.recordSpinoffNoteError({ id: row.id, outcome: outcome.outcome, reason: outcome.reason });
    return outcome.outcome === "failed" ? { ...outcome, recordedOn: row.id } : outcome;
  } catch (err) {
    return { ...outcome, recordError: (err as Error).message };
  }
}

async function composeReadyOverApi(
  ctx: ApiCtx,
  row: SpinoffRow,
  state: string | null,
  builderNote: string | null,
  tierFit: string | null,
  repeat = false,
  spike = false,
  spikeDoc: { committed: boolean; prUrl: string | null } | null = null,
): Promise<ReadyNoteOutcome> {
  // OB-2255: the note goes to the ticket's team's sentinel, else its architect; a project in no team gets none.
  return announceReadyNote(apiAgentRegistry(ctx.client), {
    row,
    route: await apiHandoffTarget(ctx.client, row),
    launcher: row.launcher,
    state,
    builderNote,
    commitsAhead: commitsAheadFor(row.worktree, row.branch, row.base_sha),
    tierFit,
    headSha: headShaFor(row.worktree, row.branch),
    repeat,
    spike,
    spikeCommitted: spikeDoc?.committed ?? false,
    prUrl: spikeDoc?.prUrl ?? null,
    inbox: (msg) =>
      ctx.client.roleMessageSend(msg.team, { role: msg.role, from: builderIdOf(row), kind: "handoff", ref: msg.ref, body: msg.body, client_key: msg.clientKey }),
    // OS-56: the runs and the inbox cross the wire; the delivery into T3 runs here, where T3 is.
    deliver: async (team, role, seam) => {
      const [{ deliverToRole }, { apiRoleBackend, apiInboxBackend }] = await Promise.all([import("../role-deliver.ts"), import("./client-handlers.ts")]);
      return deliverToRole(apiRoleBackend(ctx), apiInboxBackend(ctx), seam, team, role);
    },
  });
}

async function apiDrain(ctx: ApiCtx): Promise<void> {
  const holder = flag(ctx, "holder") ?? "";
  const caller = leaseHolderId();
  const cfg = await config(ctx);
  // OB-1796: the scope is decided first, here, where the checkouts are, so a drain run from nowhere
  // resolvable refuses before it reconciles, claims or launches anything.
  const scope = resolveDrainScope(cfg, { all: ctx.flags.all === true, repo: flag(ctx, "repo"), cwd: ctx.cwd });

  // Retire merged spinoffs first, so their freed slots feed this drain -- the same order as locally.
  // Reconcile judges merges, not launches, so it stays global; only the LAUNCH is scoped.
  const reconciled = await apiReconcile(ctx, cfg, holder, caller);
  const rec = reconciled.result;
  const r = await drainOverApi(ctx, cfg, { holder, caller, scope });
  // A reconcile that could not be asked is the same class of stop as a claim that could not: the API is
  // unreachable, and reporting the pass as if it had merely found nothing is the silent failure D2 forbids.
  if (reconciled.remoteError && !r.remote_error) r.remote_error = reconciled.remoteError;

  const dbFailures = [...rec.db_failures, ...r.db_failures];
  if (ctx.mode === "json") {
    print(JSON.stringify({ ...r, merged: rec.merged, reconcile_blocked: rec.blocked, db_failures: dbFailures }, null, 2));
  } else {
    for (const line of renderDrainLines(r, rec)) print(line);
  }
  reportDbFailures(ctx, dbFailures);
  if (r.remote_error) {
    warn(`the drain stopped: ${r.remote_error}`);
    ctx.exit = 1;
  }
}

async function drainOverApi(
  ctx: ApiCtx,
  cfg: SpinoffLaunchConfig,
  opts: { holder: string; caller: string; scope: DrainScope },
): Promise<DrainResult> {
  const scope = opts.scope;
  const skipped: DrainResult["skipped_other_repo"] = [];
  const byRepo: DrainResult["by_repo"] = {};
  const launched: string[] = [];
  const failed: Array<{ ticket: string; error: string }> = [];
  const blocked: LeaseBlocked[] = [];
  const notReady: Array<{ ticket: string; reason: string }> = [];
  const dbFailures: DbHalfFailure[] = [];
  let remoteError: string | null = null;

  // Before anything is claimed: take back the rows a previous drain claimed and never stamped (191).
  let reclaimed: DrainResult["reclaimed"] = [];
  let plan: Awaited<ReturnType<ApiClient["spinoffLaunchable"]>>;
  try {
    reclaimed = (await ctx.client.reclaimSpinoffs()).reclaimed;
    plan = await ctx.client.spinoffLaunchable({ holder: opts.holder, caller: opts.caller });
  } catch (e) {
    // The API could not be asked, so NOTHING was claimed and the sweep stops before it touches this disk.
    return {
      launched, failed, blocked, not_ready: notReady, reclaimed, db_failures: dbFailures,
      remote_error: (e as Error).message,
      remaining_pending: 0,
      active: 0,
      scope: drainScopeLabel(scope),
      skipped_other_repo: skipped,
      by_repo: byRepo,
    };
  }

  for (const entry of plan.rows) {
    const pending = entry.row;
    // OB-1796: another repo's row is neither claimed nor failed; it stays queued for its own architect.
    if (!rowInDrainScope(scope, pending.repo)) {
      skipped.push({ ticket: pending.ticket_ref, repo: drainRepoLabel(pending.repo) });
      continue;
    }
    // Another live session holds this ticket/worktree (#97): leave the row PENDING (not failed) and report
    // it, so it launches by itself on a later drain once the holder releases or its TTL expires.
    if (entry.hold) {
      blocked.push({ ticket: pending.ticket_ref, resource: entry.hold.resource, holder: entry.hold.holder });
      continue;
    }
    // Launcher-not-ready (#118/#161) went with the interactive app (ob 1109): this is the seam's
    // always-null form, kept in case `t3` ever needs to defer a row.
    const reason = launchNotReadyIn(cfg, pending, entry.tags);
    if (reason) {
      notReady.push({ ticket: pending.ticket_ref, reason });
      continue;
    }
    // THE CLAIM: atomic, on the server. Nothing local has happened yet, so losing the race costs nothing.
    const r = await launchEntryOverApi(ctx, cfg, entry, opts.holder, dbFailures);
    if (r.status === "unreachable") {
      remoteError = r.error;
      break; // the API is unreachable: every remaining row would fail the same way
    }
    if (r.status === "launched") {
      launched.push(r.row.ticket_ref);
      tallyDrain(byRepo, pending.repo, "launched");
    } else if (r.status === "failed") {
      failed.push({ ticket: r.row.ticket_ref, error: r.error ?? "" });
      tallyDrain(byRepo, pending.repo, "failed");
    }
  }

  // The counts AFTER the pass, read the same way the local drain re-reads them, so the closing line is
  // about the state this drain left behind rather than the one it started from.
  let remainingPending = plan.remaining_pending;
  let active = plan.active;
  try {
    const after = await ctx.client.spinoffLaunchable({ holder: opts.holder, caller: opts.caller });
    remainingPending = after.remaining_pending;
    active = after.active;
  } catch {
    // The pass is already done and reported; a failed closing read must not turn it into an error.
  }

  return {
    launched,
    failed,
    blocked,
    not_ready: notReady,
    reclaimed,
    db_failures: dbFailures,
    remote_error: remoteError,
    remaining_pending: Number(remainingPending),
    active: Number(active),
    scope: drainScopeLabel(scope),
    skipped_other_repo: skipped,
    by_repo: byRepo,
  };
}

/**
 * One launchable row, claimed on the server, launched here, stamped on the server: the per-row body
 * `spinoff drain` and `spinoff <ref>` share. `unreachable` means the claim could not be asked, so
 * nothing was claimed. A stamp that could not be written goes on `dbFailures`.
 */
async function launchEntryOverApi(
  ctx: ApiCtx,
  cfg: SpinoffLaunchConfig,
  entry: Awaited<ReturnType<ApiClient["spinoffLaunchable"]>>["rows"][number],
  holder: string,
  dbFailures: DbHalfFailure[],
): Promise<{ status: "launched" | "failed" | "raced" | "unreachable"; row: SpinoffRow; threadId: string | null; model: string | null; effort?: string | null; adopted?: boolean; error: string | null }> {
  const pending = entry.row;
  let claim: Awaited<ReturnType<ApiClient["claimSpinoff"]>>;
  try {
    claim = await ctx.client.claimSpinoff({ id: pending.id, holder: holder || null });
  } catch (e) {
    return { status: "unreachable", row: pending, threadId: null, model: null, error: (e as Error).message };
  }
  const row = claim.claimed;
  // OB-1921: a claim lease that could not be taken leaves the row pending; its error says why.
  if (!row) return { status: "raced", row: pending, threadId: null, model: null, error: claim.error ?? null };
  if (claim.error) {
    const stampError = await stampOverApi(ctx, { id: row.id, outcome: "failed", error: claim.error });
    if (stampError) dbFailures.push({ ticket: row.ticket_ref, detail: claimNotStamped(row, claim.error, stampError) });
    return { status: "failed", row, threadId: null, model: null, error: claim.error };
  }
  let prep: LaunchPrep | null = null;
  try {
    prep = prepareLaunchIn(cfg, row);
    const launcher = prep.launcher;
    const beat = apiSpinoffSteps(ctx.client).heartbeatClaim;
    // OB-2075: the claim hands back the stored row; an urgent one launches on the tier the host listed.
    const launchRow = entry.urgent ? { ...row, tier: entry.row.tier } : row;
    const urgentNote = entry.urgent ? { raisedFrom: entry.raised_from ?? null } : null;
    const effect = await withClaimHeartbeat(() => beat(row), () => launchRowIn(cfg, launcher, launchRow, entry.ticket_title, urgentNote));
    const stamp: StampInput = {
      id: row.id,
      outcome: "launched",
      ...prep,
      session_id: effect.sessionId ?? null,
      t3_thread_id: effect.t3ThreadId ?? null,
      t3_run_id: effect.t3RunId ?? null,
      model: effect.model ?? null,
      effort: effect.effort ?? null,
      raised: effect.raised,
    };
    const stampError = await stampOverApi(ctx, stamp);
    if (stampError) dbFailures.push({ ticket: row.ticket_ref, detail: launchNotStamped(row, stamp, stampError) });
    return { status: "launched", row: effect.adopted ? row : launchRow, threadId: effect.t3ThreadId ?? null, model: effect.model ?? null, effort: effect.effort ?? null, adopted: effect.adopted, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stampError = await stampOverApi(ctx, { id: row.id, outcome: "failed", error: msg, ...(prep ?? {}) });
    if (stampError) dbFailures.push({ ticket: row.ticket_ref, detail: claimNotStamped(row, msg, stampError) });
    return { status: "failed", row, threadId: null, model: null, error: msg };
  }
}

/** Returns null when the stamp was recorded, else the message the partial-failure sentence carries. */
async function stampOverApi(ctx: ApiCtx, input: StampInput): Promise<string | null> {
  try {
    await ctx.client.stampSpinoff(stampBody(input));
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** A tab is open here and the API still calls the row `launching`. Names the command that settles it. */
function launchNotStamped(row: SpinoffRow, stamp: StampInput, detail: string): string {
  return splitPartialFailure({
    didLocally: `${row.ticket_ref} LAUNCHED here (${row.launcher ?? "launcher"} in ${row.worktree})`,
    missing: `recording the launch`,
    detail,
    recover: `ob ${shellWords(stampArgv(stamp))} (or leave it: the claim lapses after ${CLAIM_TTL_S}s and 'ob spinoff reclaim' re-queues the row)`,
  });
}

/** Nothing opened, and the row is still claimed. Same recovery, opposite local half. */
function claimNotStamped(row: SpinoffRow, why: string, detail: string): string {
  return splitPartialFailure({
    didLocally: `${row.ticket_ref} did NOT launch here (${why})`,
    missing: `recording the failure`,
    detail,
    recover: `ob spinoff reclaim (the claim lapses after ${CLAIM_TTL_S}s and the row is re-queued)`,
  });
}

// --- cleanup: git on this disk, guarded by the API's leases ------------------

/** The `CleanupData` seam over HTTP: the database questions, the row listing read once per sweep (OB-2159). */
export function apiCleanupData(client: ApiClient, caller: string): CleanupData {
  // OB-2159: the rows are read ONCE per sweep and shared by the t3 and live-row guards, rather than one
  // full listing per candidate. A failed read stays failed for the sweep, so every candidate is skipped.
  let rowsOnce: ReturnType<ApiClient["spinoffs"]> | null = null;
  const allRows = async () => (await (rowsOnce ??= client.spinoffs({}))).spinoffs;
  return {
    hold: async (branch, path) => {
      const res = await client.spinoffCleanupGuard({ branch, path, caller });
      // A CleanupData hold is a LeaseHold; the endpoint carries the two fields a report needs and does not
      // invent the other two, which nothing on this path reads.
      return res.hold ? { resource: res.hold.resource, holder: res.hold.holder, since: null, ttl_s: null } : null;
    },
    agentExists: async (branch) => (await client.spinoffCleanupGuard({ branch, path: "", caller })).agent,
    // 1120: the same guard the store-backed sweep runs, with the rows read over the API and the THREAD read
    // here — this is the machine with T3, which is why the guard belongs on this side of the split at all.
    // (The reviewer's objection to leaving it out was right: without this, `ob spinoff cleanup --force` on
    // the client would remove a worktree under a live builder.)
    liveRow: async (branch, path) => findLiveRow(await allRows(), branch, path),
    t3Hold: async (path) => {
      const rows = await allRows();
      const want = canonicalPath(path);
      const mine = rows.filter((r) => r.t3_thread_id && canonicalPath(r.worktree) === want).map((r) => r.t3_thread_id!);
      return t3ThreadHold(mine);
    },
  };
}

async function apiCleanup(ctx: ApiCtx): Promise<void> {
  const repo = flag(ctx, "repo") ?? ctx.cwd;
  const res = await cleanupWorktrees(null, {
    repo,
    dryRun: ctx.flags["dry-run"] === true,
    force: ctx.flags.force === true,
    steps: apiSpinoffSteps(ctx.client),
    data: apiCleanupData(ctx.client, leaseHolderId()),
  });
  if (ctx.mode === "json") {
    print(JSON.stringify(res, null, 2));
    reportDbFailures(ctx, res.db_failures);
    return;
  }
  for (const line of renderCleanupLines(res)) print(line);
  reportDbFailures(ctx, res.db_failures);
}

// --- enqueue ----------------------------------------------------------------

async function apiEnqueue(ctx: ApiCtx, sub: string, queueOnly: boolean): Promise<void> {
  refuseSubcommandRef(sub); // 1697
  if (parseIssueRef(sub) !== null) throw new AppError(ISSUE_REF_REFUSAL);
  const cfg = await config(ctx);
  const ticketRef = sub;
  const launcherFlag = flag(ctx, "launcher");
  if (launcherFlag !== undefined && !isLauncherName(launcherFlag)) {
    throw new UsageError(launcherRejection("spinoff --launcher", launcherFlag));
  }
  const { slug: repo, fromProject } = await repoSlug(ctx, cfg, "spinoff", ticketRef);
  // OB-2130: a checkout T3 has no project for would fail at launch, after the row and the worktree exist.
  if (!queueOnly) await refuseUnregisteredT3Project(await t3Seam(), fromProject?.repo ?? rowRepoPathIn(cfg, repo));
  const branch = flag(ctx, "branch") ?? (await apiDefaultBranch(ctx, cfg, repo, ticketRef));
  const tier = tierFlag(flag(ctx, "tier")); // 1480
  const effort = effortFlag(flag(ctx, "effort")); // OB-1815
  const under = flag(ctx, "holder") ?? "";
  // 1589: a foreign hold is refused BEFORE the enqueue, so a refused dispatch leaves no pending row behind.
  if (!queueOnly) {
    const worktree = flag(ctx, "worktree") ?? `${rowRepoPathIn(cfg, repo)}.${worktreeKeyOf({ repo, branch, ticket_ref: ticketRef })}`;
    await refuseForeignHoldOverApi(ctx.client, ticketRef, branch, worktree, under);
  }
  // OS-108: the usage cache is on THIS machine, so the critical-only line is checked here, before the request;
  // the server records --over-usage on the trail and does not check (it has no cache).
  await refuseOverUsage({ ref: ticketRef, critical: async () => (await apiItemPriority(ctx.client, ticketRef)) === "critical", overUsage: flag(ctx, "over-usage"), verb: "dispatched" });
  // OB-1815: and an effort the tier's model cannot take, for the same reason. T3 is on this machine.
  if (effort !== undefined) {
    // OB-2075: an urgent ticket runs on complex, so the level is checked against that tier's model.
    const effortTier = (await apiItemUrgent(ctx.client, ticketRef)) ? "complex" : (tier ?? DEFAULT_SPINOFF_TIER);
    // OB-2107: `queue` skips the T3 half (the launch checks it) but not the Opus-high check, which needs no T3.
    if (queueOnly) refuseOpusHigh(tierModelsOrRefuse(cfg.tierModels), effortTier, effort, flag(ctx, "opus-high"));
    else await refuseUnusableEffort(await t3Seam(), rowRepoPathIn(cfg, repo), effortTier, tierModelsOrRefuse(cfg.tierModels), effort, flag(ctx, "opus-high"));
  }
  const mode: SpinoffMode = "interactive";
  let custom = flag(ctx, "brief");
  if (custom === "-") custom = await readStdin();
  // 1162: the thread's first message is the ticket's own brief, composed HERE, on the machine that has
  // the checkout the ticket file lives in (the API host has none of them). 1190: with no store, an
  // item-only ref costs ONE item read over the same API this enqueue already writes to — the file still
  // wins, and a failed read still falls through to the pointer.
  const brief = await spinoffAskFor(null, rowRepoPathIn(cfg, repo), ticketRef, {
    brief: custom,
    readItem: () => apiItemBriefSource(ctx.client, ticketRef),
    readStage: (slug) => apiProjectStage(ctx.client, slug),
    project: repo,
  });
  const body: EnqueueSpinoffRequest = {
    ticket_ref: ticketRef,
    repo,
    branch,
    worktree: flag(ctx, "worktree") ?? null,
    mode,
    brief,
    launcher: launcherFlag ?? null,
    tier: tier ?? null,
    effort: effort ?? null,
    note: withOpusHighNote(flag(ctx, "note"), flag(ctx, "opus-high")) ?? null, // OB-2107
    no_check: flag(ctx, "no-check") ?? null,
    no_flake_slot: flag(ctx, "no-flake-slot") ?? null,
    over_usage: flag(ctx, "over-usage") ?? null,
    // OB-2230: the box is on the machine that launches the builder, which is this one. The server reads the
    // priority, refuses a held flake:slot and adds the flake-box paragraph, saying so with `flake: true`.
    flake_box: flakeBoxPresent(),
    actor: flag(ctx, "holder") ?? null,
  };
  // OB-1991: while a model trial is active, a dispatch at its tier runs twice, same brief, one row per leg.
  // The pair's store work is the server's (POST /spinoffs/trial); each leg launches HERE, like any dispatch.
  if (!queueOnly && ctx.flags["no-trial"] !== true) {
    const paired = await dispatchTrialPair({
      plan: async () => {
        // an older server without the trial route has no trial: a single build
        const res = await ctx.client.spinoffTrial({ op: "plan", tier: tier ?? DEFAULT_SPINOFF_TIER }).catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        });
        // OB-2230: a flake ticket runs no trial: two legs would be two flake fixes on one machine. Read only while a
        // trial is active, so an ordinary dispatch keeps its one item read (1190).
        if (res?.op === "plan" && res.plan && (await apiItemPriority(ctx.client, ticketRef)) === "flake") return null;
        return refuseOpusHighTrial(res?.op === "plan" ? res.plan : null, tier ?? DEFAULT_SPINOFF_TIER, flag(ctx, "opus-high")); // OB-2107
      },
      open: async (plan) => {
        const res = await ctx.client.spinoffTrial({ op: "open", trial_id: plan.trial.id, ticket_ref: ticketRef, repo });
        if (res.op !== "open") throw new AppError("the trial pair was not opened");
        return res.pair;
      },
      leg: async (leg, spec) => {
        const legBranchName = legBranch(branch, leg);
        const legWorktree = flag(ctx, "worktree") === undefined ? null : legBranch(flag(ctx, "worktree")!, leg);
        if (leg === "b") {
          const derived = legWorktree ?? `${rowRepoPathIn(cfg, repo)}.${worktreeKeyOf({ repo, branch: legBranchName, ticket_ref: ticketRef, trial_leg: "b" })}`;
          await refuseForeignHoldOverApi(ctx.client, legRef(ticketRef, "b"), legBranchName, derived, under);
        }
        const queued = await usageOn400(
          ctx.client.enqueueSpinoff({ ...body, branch: legBranchName, worktree: legWorktree, effort: spec.effort ?? null, trial_leg: leg, trial_model: spec.model }),
        );
        if (queued.warning && leg === "a") warn(`  ⚠ ${queued.warning}`); // OB-1825, said once
        if (queued.deduped) {
          // The ticket already had a queued row: that row is launched as the single build it was queued as.
          await launchOverApi(ctx, cfg, queued.row, true, tier !== undefined, under);
          return { row: null, launched: false, error: `${ticketRef} already had queued row #${queued.row.id}, launched as a single build`, settled: true };
        }
        return { row: queued.row, launched: await launchOverApi(ctx, cfg, queued.row, false, tier !== undefined, under) };
      },
      void: async (id, reason) => {
        await ctx.client.spinoffTrial({ op: "void", pair_id: id, reason });
      },
      attach: async (id, rows) => {
        await ctx.client.spinoffTrial({ op: "attach", pair_id: id, ...rows });
      },
      say: (line) => {
        if (ctx.mode !== "json" && ctx.mode !== "quiet") print(line);
      },
      warn,
    });
    if (paired.kind !== "single") return;
  }

  const { row, deduped, collision, warning, urgent, raised_from, flake } = await usageOn400(ctx.client.enqueueSpinoff(body));
  const urgentNote = urgent ? { from: (raised_from ?? null) as SpinoffTier | null } : null;
  if (warning) warn(`  ⚠ ${warning}`); // OB-1825
  if (flake && !queueOnly && !body.flake_box) warn(noFlakeBoxWarning(row.ticket_ref)); // OB-2230
  // 1226: a ref two sequences both claim was bound to the PATH, and the enqueue — resolved where the store
  // is — already says which item its id also names, so this needs no read of its own.
  const collides = collidingRefWarning(row.ticket_ref, row.item_id, collision ?? null);
  if (collides) warn(collides);
  if (queueOnly) {
    if (ctx.mode === "json")
      print(JSON.stringify({ id: row.id, ticket: row.ticket_ref, status: spinoffStatusWord(row.status), deduped, launcher: row.launcher, tier: row.tier, effort: row.effort, urgent: urgent ?? false, raised_from: raised_from ?? null, row }));
    else if (ctx.mode === "quiet") print(String(row.id));
    else print(renderQueuedLine(row, deduped, tier !== undefined, urgentNote));
    return;
  }
  await launchOverApi(ctx, cfg, row, deduped, tier !== undefined, under, urgentNote);
}

/**
 * OB-2131: the planned files of each row's ticket, from the server that holds the trail. An older server
 * without the route reads as `unread`, printed as such, never as "no go check".
 */
async function apiPlannedFiles(ctx: ApiCtx, rows: SpinoffRow[]): Promise<(row: { id: number }) => PlannedFiles> {
  if (rows.length === 0) return () => null;
  const res = await ctx.client
    .spinoffPlannedFiles({ rows: rows.map((r) => ({ id: r.id, ticket_ref: r.ticket_ref, item_id: r.item_id ?? null })) })
    .catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    });
  if (!res) return () => "unread";
  const byId = new Map(res.planned.map((p) => [p.id, p.files]));
  return (row) => byId.get(row.id) ?? null;
}

/**
 * The API form of `defaultBranchFor` (OB-1992): OmniSlash keeps the lowercase ref; a clean repo reuses its prior
 * row's branch or takes the ticket title's slug, checked against the checkout on THIS machine.
 */
async function apiDefaultBranch(ctx: ApiCtx, cfg: Parameters<typeof rowRepoPathIn>[0], repo: string, ticketRef: string): Promise<string> {
  if (isObRepo(repo)) return ticketRef.toLowerCase();
  const rows = (await ctx.client.spinoffs({})).spinoffs;
  const repoPath = rowRepoPathIn(cfg, repo);
  return cleanBranchFor(rows, repo, ticketRef, async () => (await apiItemBriefSource(ctx.client, ticketRef))?.title ?? "", (name) =>
    branchTakenIn(repoPath, name),
  );
}

/** The API form of the local refusal: the live `ticket:`/`worktree:` holds, read over GET /leases. */
async function refuseForeignHoldOverApi(client: ApiClient, ticketRef: string, branch: string, worktree: string, under: string): Promise<void> {
  const keys = new Set([ticketLeaseKey(ticketRef), worktreeLeaseKey(worktree)].filter((k): k is string => k !== null));
  const self = new Set([leaseHolderId(), branch, under]);
  const row = (await client.leases()).leases.find((l) => keys.has(l.resource) && l.holder && !l.expired && !self.has(l.holder));
  if (!row) return;
  const hold: LeaseHold = { resource: row.resource, holder: row.holder!, since: row.acquired_at, ttl_s: row.ttl_s };
  throw new AppError(
    `not dispatched: ${formatHold(hold)}. Nothing was queued. If that holder is you, dispatch under it with ` +
      `--holder ${hold.holder}; otherwise wait for it, and 'ob lease release ${hold.resource} --force' ONLY if that holder is gone`,
  );
}

/**
 * `ob spinoff <ref>` in API mode (1589): the row just queued is claimed on the server, launched HERE and
 * stamped on the server, in this one invocation -- the drain's per-row step, for one row. A claim whose
 * stamp never lands lapses through the claim lease like any drain's.
 */
async function launchOverApi(ctx: ApiCtx, cfg: SpinoffLaunchConfig, queued: SpinoffRow, deduped: boolean, tierNamed: boolean, under: string, urgent: UrgentTierNote | null = null): Promise<boolean> {
  const caller = leaseHolderId();
  let outcome: { status: string; row: SpinoffRow; threadId: string | null; model: string | null; effort?: string | null; adopted?: boolean; error: string | null };
  const dbFailures: DbHalfFailure[] = [];
  if (queued.status !== "pending") {
    outcome = { status: spinoffStatusWord(queued.status), row: queued, threadId: queued.t3_thread_id ?? null, model: null, error: null };
  } else {
    outcome = await (async () => {
      const notLaunched = (error: string) => ({ status: "pending", row: queued, threadId: null, model: null, error });
      let entry: Awaited<ReturnType<ApiClient["spinoffLaunchable"]>>["rows"][number] | undefined;
      try {
        entry = (await ctx.client.spinoffLaunchable({ holder: under, caller })).rows.find((e) => e.row.id === queued.id);
      } catch (e) {
        return notLaunched((e as Error).message);
      }
      if (!entry) return notLaunched("the queued row is no longer launchable");
      if (entry.hold) return notLaunched(`${entry.hold.resource} held by ${entry.hold.holder}`);
      const reason = launchNotReadyIn(cfg, queued, entry.tags);
      if (reason) return notLaunched(reason);
      const r = await launchEntryOverApi(ctx, cfg, entry, under, dbFailures);
      if (r.status === "unreachable") return notLaunched(r.error ?? "");
      return { ...r, row: r.status === "raced" ? queued : r.row };
    })();
  }
  reportDbFailures(ctx, dbFailures);
  const { row, threadId, model, error } = outcome;
  const effort = outcome.effort ?? row.effort ?? null;
  if (ctx.mode === "json") {
    print(JSON.stringify({ id: row.id, ticket: row.ticket_ref, status: outcome.status, deduped, launcher: row.launcher, tier: row.tier, effort, t3_thread_id: threadId, model, error }));
  } else if (ctx.mode === "quiet") {
    print(threadId ?? String(row.id));
  } else if (outcome.status === "launched") {
    print(renderLaunchedLine(row, threadId, model, deduped, tierNamed, effort, launchedUrgentNote(urgent, outcome.adopted)));
  } else if (error === null) {
    print(renderAlreadyLine(row, outcome.status));
  } else {
    warn(`${row.ticket_ref} (#${row.id}) was not launched: ${error}`);
  }
  if (error !== null) ctx.exit = 1;
  return outcome.status === "launched";
}

// --- the command ------------------------------------------------------------

export async function apiSpinoff(ctx: ApiCtx): Promise<void> {
  rejectAgentFlag(ctx.flags.agent);
  const sub = ctx.args[0];

  if (sub === "watch") throw new AppError(SPINOFF_WATCH_REFUSAL);

  if (sub === "drain") return apiDrain(ctx);

  if (sub === "reconcile") {
    const holder = flag(ctx, "holder") ?? "";
    const reconciled = await apiReconcile(ctx, await config(ctx), holder, leaseHolderId());
    const rec = reconciled.result;
    if (ctx.mode === "json") print(JSON.stringify(rec));
    else {
      print(rec.merged.length ? `marked landed: ${rec.merged.join(", ")}` : "no building spinoffs landed yet");
      // 1120: the T3 mirror is a write, so it is reported here the same way the drain reports it.
      for (const m of rec.mirrored ?? []) print(`  ⟳ ${m.ticket}: T3 run ${m.status} (thread ${m.threadId})`);
      for (const b of rec.blocked) print(`  ⏸ ${b.ticket}: not landed, ${b.resource} held by ${b.holder}`);
    }
    reportDbFailures(ctx, rec.db_failures);
    if (reconciled.remoteError) {
      warn(`the reconcile stopped: ${reconciled.remoteError}`);
      ctx.exit = 1;
    }
    return;
  }

  // The database half of the sweeps, as commands (191): ordinary writes, and the recovery commands the
  // partial-failure messages name, so a human can retype one straight off the error.
  if (sub === "claim") {
    const id = numberFlag(ctx, "id");
    const res = await ctx.client.claimSpinoff({ id, holder: flag(ctx, "holder") ?? null });
    if (ctx.mode === "json") print(JSON.stringify({ claimed: res.claimed, error: res.error }, null, 2));
    else if (!res.claimed) print(`#${id} was not queued: nothing claimed`);
    else if (res.error) print(`#${id} claimed, but not launchable: ${res.error}`);
    else print(`claimed #${id} (${res.claimed.ticket_ref}) for ${CLAIM_TTL_S}s`);
    return;
  }

  if (sub === "stamp") {
    const id = numberFlag(ctx, "id");
    const outcome = flag(ctx, "outcome");
    if (outcome !== "launched" && outcome !== "failed") {
      throw new UsageError("spinoff stamp requires --outcome launched|failed");
    }
    await ctx.client.stampSpinoff(
      stampBody({
        id,
        outcome,
        worktree: flag(ctx, "worktree") ?? null,
        base_sha: flag(ctx, "base-sha") ?? null,
        launcher: flag(ctx, "launcher") ?? null,
        session_id: flag(ctx, "session") ?? null,
        engine: flag(ctx, "engine") ?? null,
        t3_thread_id: flag(ctx, "t3-thread") ?? null,
        t3_run_id: flag(ctx, "t3-run") ?? null,
        model: flag(ctx, "model") ?? null,
        effort: flag(ctx, "effort") ?? null,
        raised: ctx.flags.raised === true,
        error: flag(ctx, "error") ?? null,
      }),
    );
    if (ctx.mode === "json") print(JSON.stringify({ id, outcome }, null, 2));
    else print(`stamped #${id} ${outcome}`);
    return;
  }

  if (sub === "handoff" || sub === "ready") {
    // 1513: `handoff` is the word, `ready` the alias. The wire route stays `/spinoffs/:id/ready`.
    const ref = ctx.args[1];
    const rows = (await ctx.client.spinoffs({})).spinoffs;
    // 1188: the same two guards the local path uses, reached from the rows this machine read over the API
    // — a landed row is refused by name with its sha, and a row whose checkout is gone has nothing to gate
    // unless it is a REPEAT on an already-stamped row (whose 426 cleanup still belongs to the host).
    const found = pickSpinoffForReady(rows, {
      ref,
      cwd: process.cwd(),
      landedShaFor: (row) => landCommitFor(worktreeRepoOf(row.worktree) ?? row.worktree, row.ticket_ref),
    });
    const repeat = found.status === READY_FOR_GATE;
    const gone = !existsSync(found.worktree);
    if (gone && !repeat) throw new AppError(missingWorktreeRefusal(found.worktree));
    // OB-1826: a spike's worktree is dirty by design, so the dirty rule does not apply; the rule that does is
    // that it commits documentation only (OB-2227). The client has no store, so it reads the item's own tags over the API, by the
    // item id or else the ticket ref (the host's fallback); the host decides again when it stamps (`markSpinoffReady`).
    const spikeTagged = isSpikeTagged(await apiItemTags(ctx.client, found.item_id ?? found.ticket_ref));
    assertHandoffWorktree(found, spikeTagged);
    // OB-1992: a clean repo's branch, commits and PR carry nothing of ob; checked here, where the checkout is.
    let report = handoffNoteWithReport(flag(ctx, "note"), flag(ctx, "report"));
    // 1552: the rating is parsed first, before the slower CI read, so a bad value is a usage error that does
    // not hide behind a CI refusal. It travels with the stamp so the HOST writes the trail row and composes the
    // line (the trail is host data). The note uses that returned line, so the trail and the note cannot drift;
    // an older host sends none and the note then says unreported, which is exactly what its trail says too.
    const tierFit = tierFitOf(flag(ctx, "tier-fit"), flag(ctx, "tier-fit-why"));
    // OB-2044: the same CI guard the local path runs; a pending or failing PR is refused before the stamp.
    let ci: HandoffCiResult = { kind: "no-pr", line: null };
    // OB-2227: a spike may now push a doc commit and open a PR, so its branch, commits and PR are checked too.
    if (!gone) {
      const keys = await ctx.client.projects().then((r) => r.projects.map((p) => p.key).filter((k): k is string => !!k), () => []);
      const leaks = cleanRepoLeakLines(found, keys);
      if (leaks.length > 0) throw new AppError(cleanRepoLeakRefusal(found.ticket_ref, leaks));
    }
    if (!spikeTagged && !gone) {
      // A repeat that is `--no-note` announces nothing and stamps no new handoff, so there is no readying to gate.
      if (!(repeat && ctx.flags["no-note"] === true)) {
        ci = assertHandoffCiForRow(found, flag(ctx, "ci-unchecked"));
        report = noteWithCi(report, ci);
      }
    }
    const res = await ctx.client.readySpinoff({
      id: found.id,
      tier_fit: tierFit?.fit ?? null,
      tier_fit_why: tierFit?.why ?? null,
      note: report,
    });
    const tierFitRecorded = res.tierFit ?? null;
    // OB-2227: a spike may carry a documentation commit and its PR; read here, where the checkout is.
    const spikeDoc = res.spike ? spikeDocFactsFor(res.row) : null;
    const state = rowVerdictState(res.row);
    // 1133: the builder's readying note comes back WITH the stamp (the host read it before overwriting it),
    // so the client never has to read the registry before the stamp and cannot get that order wrong.
    // 1205: `--no-note` is the caller saying "stamp only", the architect stamping on the human's behalf is
    // not the event the note exists to announce, and a note it sends goes to its own thread.
    const note = ctx.flags["no-note"] === true
      ? noNoteOutcome(res.row.ticket_ref)
      : gone
        ? worktreeGoneNoteOutcome(res.row.ticket_ref, res.row.worktree)
        : await announceReadyOverApi(ctx, res.row, state, gateNoteWithCi(res.builder_note ?? null, ci), tierFitRecorded, res.already, res.spike === true, spikeDoc);
    const rendered = renderReadyNoteOutcome(note);
    if (ctx.mode === "json") {
      print(JSON.stringify({ ...readyResultJson(res, state), spike: res.spike === true, ...(spikeDoc ? { pr_url: spikeDoc.prUrl } : {}), architect_note: note }, null, 2));
    } else {
      print(res.spike ? formatSpikeReport(res.row, spikeDoc ?? {}) : formatReadyReport(res.row, state, res.already));
      if (!tierFit) print(TIER_FIT_HINT);
      if (rendered.warning) warn(rendered.line);
      else print(rendered.line);
    }
    if (rendered.warning) ctx.exit = 1;
    return;
  }

  if (sub === "reopen") {
    // OB-2180: the landing-commit check runs HERE, on this machine's checkout; the API host only moves the row.
    const ref = ctx.args[1];
    if (!ref) throw new UsageError("spinoff reopen requires a <row|ticket>");
    const all = (await ctx.client.spinoffs({})).spinoffs;
    // the item the ref names, as the local path resolves it, so a bare legacy id reaches its row
    const row = pickSpinoffForShow(all, ref, /^\d+$/.test(ref.trim()) ? null : (await apiItemOrNull(ctx.client, ref))?.id);
    const repo = rowRepoPathIn(await config(ctx), row.repo);
    const deps: ReopenDeps = {
      flip: async (note) => (await ctx.client.reopenSpinoff({ id: row.id, note })).row,
      ticketDone: async (r) => (await apiItemOrNull(ctx.client, r.item_id ?? r.ticket_ref))?.status === "done",
      relandReason: (r) => rowRelandReason(repo, r),
    };
    print(renderReopen(await reopenSpinoff(row, deps, flag(ctx, "note") ?? ""), ctx.mode === "json"));
    return;
  }

  if (sub === "sendback") {
    // OB-1805: the same sequence the local command runs. The row moves on the server; the note goes to the
    // builder's thread from HERE (T3 is on this machine); a failed note puts the row back.
    const ref = ctx.args[1];
    if (!ref) throw new UsageError("spinoff sendback requires a <ticket|id>");
    const row = pickSpinoffForShow((await ctx.client.spinoffs({})).spinoffs, ref);
    // OS-108: past the critical-only usage line only a critical ticket goes back; checked here, where the cache is.
    const overUsage = await refuseOverUsage({ ref: row.ticket_ref, critical: async () => (await apiItemPriority(ctx.client, row.item_id ?? row.ticket_ref)) === "critical", overUsage: flag(ctx, "over-usage"), verb: "sent back" });
    const deps: SendBackDeps = {
      flip: async () => {
        await ctx.client.sendBackSpinoff({ id: row.id, note: flag(ctx, "note") ?? "", over_usage: overUsage });
      },
      restore: async () => {
        await ctx.client.sendBackSpinoff({ id: row.id, note: "", restore: true, over_usage: overUsage });
      },
      send: async (threadId, message, clientRequestId) => {
        await (await t3Seam()).send({ threadId, message, mode: "queue", clientRequestId });
      },
      headSha: (r) => headShaFor(r.worktree, r.branch),
    };
    const res = await sendBackSpinoff(row, deps, flag(ctx, "note") ?? "");
    print(renderSendBack(res, ctx.mode === "json"));
    return;
  }

  if (sub === "land") {
    const id = numberFlag(ctx, "id");
    const tokens: TokenUsage = {
      inputTokens: numberFlag(ctx, "input-tokens", 0),
      outputTokens: numberFlag(ctx, "output-tokens", 0),
      cacheCreationTokens: numberFlag(ctx, "cache-creation-tokens", 0),
      cacheReadTokens: numberFlag(ctx, "cache-read-tokens", 0),
      totalTokens: numberFlag(ctx, "total-tokens", 0),
    };
    const res = await ctx.client.landSpinoff({ id, tokens, holder: flag(ctx, "holder") ?? null, caller: leaseHolderId() });
    if (ctx.mode === "json") print(JSON.stringify({ id, status: res.landed ? spinoffStatusWord("merged") : "unchanged", blocked: res.blocked }, null, 2));
    else if (res.landed) print(`landed #${id}`);
    else {
      print(`#${id} not landed: ${res.blocked?.resource ?? "a lease"} held by ${res.blocked?.holder ?? "another session"}`);
      ctx.exit = 1;
    }
    return;
  }

  if (sub === "reclaim") {
    const { reclaimed } = await ctx.client.reclaimSpinoffs();
    if (ctx.mode === "json") print(JSON.stringify({ reclaimed }, null, 2));
    else if (reclaimed.length === 0) print("no abandoned claims");
    else for (const e of reclaimed) print(`↺ ${e.ticket} (#${e.id}) → ${spinoffStatusWord(e.status)} (attempt ${e.attempts})`);
    return;
  }

  if (sub === "cleanup") return apiCleanup(ctx);

  if (sub === "brief") {
    const rawRef = ctx.args[1];
    if (!rawRef) throw new UsageError("spinoff brief requires a <ticket-ref>");
    if (parseIssueRef(rawRef) !== null) throw new AppError(ISSUE_REF_REFUSAL);
    const cfg = await config(ctx);
    // A shared cwd does not name the repo, so --repo is required there the same way enqueue is.
    // The slug it resolves to also names the checkout the ticket file is read from (1162).
    const { slug: repo } = await repoSlug(ctx, cfg, "spinoff brief", rawRef); // OB-2130: as the dispatch resolves it
    const branch = flag(ctx, "branch") ?? (await apiDefaultBranch(ctx, cfg, repo, rawRef));
    let custom = flag(ctx, "brief");
    if (custom === "-") custom = await readStdin();
    const brief = await spinoffAskFor(null, rowRepoPathIn(cfg, repo), rawRef, {
      brief: custom,
      readItem: () => apiItemBriefSource(ctx.client, rawRef),
      readStage: (slug) => apiProjectStage(ctx.client, slug),
      project: repo,
    });
    if (ctx.mode === "json") print(JSON.stringify({ ticket: rawRef, branch, brief }, null, 2));
    else print(brief);
    return;
  }

  if (sub === "check") {
    // OB-1825: read the two JSONs here, where the architect wrote them; the server computes and records.
    const { ref, architect, checker, resolutions } = spinoffCheckArgs(ctx);
    const res = await usageOn400(ctx.client.spinoffCheck({ ticket_ref: ref, actor: flag(ctx, "holder") ?? null, architect, checker, resolutions }));
    reportSpinoffCheck(ctx, res);
    return;
  }

  if (sub === "state") {
    // OB-1992: a clean repo's verdict, recorded on the host's row.
    const ref = ctx.args[1];
    const word = ctx.args[2];
    if (!ref || !word) throw new UsageError(SPINOFF_STATE_USAGE);
    const row = pickSpinoffForState((await ctx.client.spinoffs({})).spinoffs, ref);
    const { row: recorded } = await usageOn400(
      ctx.client.recordSpinoffVerdict({ id: row.id, verdict: word, reason: flag(ctx, "reason") ?? null, gate: flag(ctx, "gate") ?? null }),
    );
    if (ctx.mode === "json") print(JSON.stringify({ id: recorded.id, ticket: recorded.ticket_ref, verdict: recorded.verdict, reason: recorded.verdict_reason, gate: recorded.gate_line }, null, 2));
    else if (ctx.mode === "quiet") print(recorded.verdict ?? "");
    else for (const line of renderRecordedVerdict(recorded)) print(line);
    return;
  }

  if (sub === "show") {
    const ref = ctx.args[1];
    if (!ref) throw new UsageError("spinoff show requires a <ticket|id>");
    const rows = (await ctx.client.spinoffs({})).spinoffs;
    const row = pickSpinoffForShow(rows, ref);
    if (ctx.mode === "quiet") print(String(row.id));
    else {
      const planned = await apiPlannedFiles(ctx, [row]); // OB-2131: the files: line
      print(renderSpinoffShow(row, ctx.mode === "json", ctx.mode === "json" ? undefined : showStateFor(row), showFilesFor(row, planned(row))));
    }
    return;
  }

  if (sub === "list") {
    const cfg = await config(ctx);
    const rows = await apiTeamRows(ctx, cfg, flag(ctx, "team"), (await ctx.client.spinoffs({ status: spinoffStatusFilter(flag(ctx, "status")) })).spinoffs);
    // The host closes a launched tab only when this flag is true (932). The
    // local command computes it; an API client that omits it leaves landed
    // tabs open forever (937). Human listings do not carry the flag.
    const landed = ctx.mode === "json" ? await apiLandedRefs(ctx, cfg, rows) : undefined;
    print(renderSpinoffList(rows, ctx.mode === "json", landed));
    return;
  }

  if (sub === "gateable") {
    const team = flag(ctx, "team");
    const all = (await ctx.client.spinoffs({ status: READY_FOR_GATE })).spinoffs;
    const rows = team === undefined ? all : await apiTeamRows(ctx, await config(ctx), team, all);
    // OB-1991: a trial pair is one entry; an older server without the trial route lists the rows singly.
    const open = await ctx.client.spinoffTrial({ op: "open-pairs" }).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    });
    print(reportGateable(rows, gateableFactsFor, ctx.mode, open?.op === "open-pairs" ? open.pairs : [], await apiPlannedFiles(ctx, rows)));
    return;
  }

  if (sub === "abandon") {
    // 1697: the same sequence the local command runs. The thread is stopped HERE (T3 is on this machine),
    // the row is retired and the agent's leases released on the server.
    const ref = ctx.args[1];
    if (!ref) throw new UsageError("spinoff abandon requires a <row-id|ticket>");
    const row = pickSpinoffForShow((await ctx.client.spinoffs({})).spinoffs, ref);
    const deps: AbandonDeps = {
      commitsAhead: (r) => commitsAheadFor(r.worktree, r.branch, r.base_sha),
      stopThread: (threadId) => stopThreadOverT3(threadId),
      stamp: apiSpinoffSteps(ctx.client).stamp,
      finishAgent: async (agentId) => {
        try {
          const res = await ctx.client.agent({ action: "done", id: agentId });
          return { done: res.found, released: res.released, error: null };
        } catch (e) {
          return { done: false, released: [], error: (e as Error).message };
        }
      },
    };
    const res = await abandonSpinoff(row, deps, { note: flag(ctx, "note"), force: ctx.flags.force === true });
    print(renderAbandon(res, ctx.mode === "json"));
    if (res.warnings.length > 0) ctx.exit = 1;
    return;
  }

  if (sub === "trial") {
    // OB-1991: the store work is the server's; the notes file, the diffs, the transcripts and T3 are here.
    const t3 = await t3Seam().catch(() => null);
    await runTrialCli(ctx as unknown as Parameters<typeof runTrialCli>[0], {
      op: (req) => usageOn400(ctx.client.spinoffTrial(req)),
      print,
      measures: liveMeasureDeps(t3 ? (id) => t3.read(id, { limit: 500 }) : null),
      diffOf: gitLegDiff,
      ...liveFileIO,
    });
    return;
  }

  if (sub === "tokens") {
    // OB-1993: the transcripts are here, the store is the server's: read here, record through the tokens route.
    if (ctx.args[1] !== "backfill") throw new UsageError("spinoff tokens requires 'backfill' (ob spinoff tokens backfill [--since <date>] [--dry-run])");
    const entries = await backfillSpinoffTokens(
      (await ctx.client.spinoffs({ status: "merged" })).spinoffs,
      { read: readRowTokens, record: (id, tokens) => ctx.client.recordSpinoffTokens({ id, tokens }) },
      { since: parseSince(flag(ctx, "since")), dryRun: ctx.flags["dry-run"] === true },
    );
    print(renderBackfill(entries, ctx.mode === "json"));
    if (entries.some((e) => e.outcome === "failed")) ctx.exit = 1;
    return;
  }

  if (sub === "mix") {
    const since = parseSince(flag(ctx, "since"));
    const rows = (await ctx.client.spinoffs({})).spinoffs;
    // ItemView carries no tags, so the item -> tags map is built one work tag at a time.
    const tags = new Map<string, string[]>();
    for (const tag of WORK_TAGS) {
      for (const item of (await ctx.client.items({ tag })).items) tags.set(item.id, [...(tags.get(item.id) ?? []), tag]);
    }
    print(reportMix(rows, tags, since, ctx.mode));
    return;
  }

  if (!sub) {
    throw new UsageError(
      "spinoff requires a <ticket-ref> (or 'drain'/'list'/'show'/'mix'/'gateable'/'abandon'/'sendback'/'reopen'/'reconcile'/'watch'/'handoff'/'brief'/'cleanup'/'reclaim'/'claim'/'stamp'/'land'; 'ready' is an alias of 'handoff')",
    );
  }
  if (sub === "queue") {
    const ref = ctx.args[1];
    if (!ref) throw new UsageError("spinoff queue requires a <ticket-ref>");
    return apiEnqueue(ctx, ref, true);
  }
  return apiEnqueue(ctx, sub, false);
}

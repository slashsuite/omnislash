/**
 * ob ← T3 READ surface — `ob t3 status | projects | tree | open` and the `Threads` block in `ob status`
 * (ticket 1124).
 *
 * The TRANSPORT is `client.ts` (1102) and the dispatch half is `dispatch.ts` (1120); this module is the
 * read half, and it is READ-ONLY: it launches nothing, settles nothing, renames nothing and writes no T3
 * state. Every command here reads the live surface and exits — there is no cache, no mirror table and no
 * polling daemon, on purpose (a mirrored copy of T3's threads is a second truth that goes stale the first
 * time a thread is renamed or settled in T3's own sidebar).
 *
 * ── The two rules this file exists to keep ───────────────────────────────────────────────────────────
 *
 *   1. IDS, NEVER TITLES. A thread is joined to ob by `spinoff.t3_thread_id` (a builder) or by the
 *      architect's agent row (`launcher t3`, thread id in `session_id`): never by parsing the title ob
 *      itself wrote. A T3 thread ob has no row for is REPORTED as unattributed, not guessed at.
 *   2. NO T3, NO SILENT SUCCESS. An unreachable server or a rejected credential is a named failure with
 *      the one-line remedy (`ob t3 doctor` / `ob t3 login`) — never an empty list that reads as "nothing
 *      is running". `ob status` is the one caller that degrades instead of failing (it has a whole report
 *      to print), and it says in words that the block could not be read.
 *
 * ── What "needs you" means, and why it is interim ────────────────────────────────────────────────────
 *
 * A pending measurement settles which T3
 * fields mean "a human is required"; it has NOT landed, so the verdict here is the
 * INTERIM one: `pendingRequestCount > 0` (a question or approval is parked on the human) or a `waiting`
 * run. It is labelled interim wherever it is printed, and it must be replaced — not quietly extended —
 * when 1103 reports.
 */

import { defineSeam } from "../test-seams.ts";
import type { Database } from "bun:sqlite";
import { listAgents, type AgentRow } from "../../../../platform/cli-coord/src/agent.ts";
import { listSpinoffs, type SpinoffRow } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { teamRoleOf, type TeamRole } from "../team.ts";
import type { Store } from "../db/store.ts";
import { T3_LAUNCHER, readThreadHeader, t3Seam, type T3Seam } from "./dispatch.ts";
import { T3Error, type T3Project, type T3Thread } from "./client.ts";

// ---------------------------------------------------------------------------
// The ob half — which thread belongs to which ticket
// ---------------------------------------------------------------------------

/** The spinoff row fields the join reads. Structural, so a `SpinoffRow` satisfies it as it is. */
export interface T3SpinoffRow {
  id: number;
  ticket_ref: string;
  branch: string;
  worktree: string;
  agent_id: string | null;
  t3_thread_id: string | null;
  status: string;
  /** The ob ITEM this row serves (1163), when it was queued with one — the identity every join wants.
   *  `ticket_ref` is only the ref the row was DISPATCHED with, which for a hand-charted ticket is its
   *  wayfinder number rather than the mirror item's id. Optional: a row from an older API host lacks it. */
  item_id?: string | null;
}

/** The agent row fields the join reads. Structural, so an `AgentRow` satisfies it as it is. */
export interface T3AgentRow {
  id: string;
  ticket: string | null;
  branch: string | null;
  worktree: string | null;
  launcher: string | null;
  session_id: string | null;
}

/**
 * Where the join's ob rows come from. A seam because the two ways in are genuinely different machines:
 * the store (this machine has the database) and the API (this machine is a client and the rows live
 * behind an endpoint), while the QUESTION above it — which ticket does this thread belong to? — is one
 * implementation, reached both ways. Same shape as `AgentRegistry` in `dispatch.ts`.
 */
export interface T3RowSource {
  spinoffs(): Promise<T3SpinoffRow[]>;
  agents(): Promise<T3AgentRow[]>;
}

/** The store-backed source: this machine's own spinoff and agent rows. */
export function storeT3RowSource(db: Database | Store): T3RowSource {
  return {
    spinoffs: async () => (await listSpinoffs(db)) as T3SpinoffRow[],
    agents: async () => {
      // `includeExpired` matters: an idle architect's row ages out of the live list after its TTL, and a
      // live-only read would report a live architect thread as unattributed.
      const rows = (await listAgents(db, { includeExpired: true })) as AgentRow[];
      return rows.map((r) => ({
        id: r.id,
        ticket: r.ticket,
        branch: r.branch,
        worktree: r.worktree,
        launcher: r.launcher,
        session_id: r.session_id,
      }));
    },
  };
}

/** The API client surface the read half needs. Structural, so `ApiClient` satisfies it as it is. */
export interface T3RowClient {
  spinoffs(query: Record<string, never>): Promise<{ spinoffs: T3SpinoffRow[] }>;
  agents(all: boolean): Promise<{ agents: T3AgentRow[] }>;
}

/** The client-backed source: the same rows, over the API (1120's split). */
export function apiT3RowSource(client: T3RowClient): T3RowSource {
  return {
    spinoffs: async () => (await client.spinoffs({})).spinoffs,
    agents: async () => (await client.agents(true)).agents,
  };
}

const rowSourceSeam = defineSeam<T3RowSource | null>("t3/read.rowSource", null);

/** Test/API-client seam: answer the join from rows that did not come from a local database. */
export function __setT3RowSource(next: T3RowSource | null): () => void {
  return rowSourceSeam.set(next);
}

/** The row source to use: the caller's override, else this machine's own store. */
export function t3RowSource(db: Database | Store): T3RowSource {
  return rowSourceSeam.get() ?? storeT3RowSource(db);
}

/** How a thread belongs to ob: a builder ob launched, or a team role thread (OB-2256: labelled by its role). */
export type T3ObKind = "builder" | TeamRole;

/** One ob row a T3 thread is joined to. `rowId`/`agentId` are the ids a human can act on. */
export interface T3ObRow {
  threadId: string;
  kind: T3ObKind;
  /** The ticket a builder row was queued for; null for an architect (it works tickets, it is not one). */
  ticket: string | null;
  /** The ob ITEM the row serves (1163), when it recorded one. `ticket` is the DISPATCHED ref, so for a
   *  hand-charted ticket the two differ (ref "1124" served item 1134) — this is the id a reader shows. */
  itemId: string | null;
  branch: string | null;
  worktree: string | null;
  /** The spinoff row id, for a builder. */
  rowId: number | null;
  /** The agent registry id: the branch for a builder, `architect-<team>` for the architect. */
  agentId: string | null;
}

/**
 * Join T3 thread ids to ob's rows: `spinoff.t3_thread_id` for a builder, and the architect's agent row
 * (`launcher t3`, thread id in `session_id`) for the pinned architect. A builder's OWN agent row is
 * skipped — it carries the same thread id, but the spinoff row is the richer account of it. Pure.
 */
export function indexT3Rows(input: { spinoffs: T3SpinoffRow[]; agents: T3AgentRow[] }): Map<string, T3ObRow> {
  const out = new Map<string, T3ObRow>();
  for (const row of input.spinoffs) {
    const threadId = row.t3_thread_id;
    if (!threadId) continue;
    out.set(threadId, {
      threadId,
      kind: "builder",
      ticket: row.ticket_ref,
      itemId: row.item_id ?? null,
      branch: row.branch,
      worktree: row.worktree,
      rowId: row.id,
      agentId: row.agent_id,
    });
  }
  for (const agent of input.agents) {
    const threadId = agent.session_id;
    if (!threadId) continue;
    if (agent.launcher !== T3_LAUNCHER) continue;
    const role = teamRoleOf(agent.id);
    if (!role) continue;
    if (out.has(threadId)) continue;
    out.set(threadId, {
      threadId,
      kind: role,
      ticket: null,
      itemId: null,
      branch: agent.branch,
      worktree: agent.worktree,
      rowId: null,
      agentId: agent.id,
    });
  }
  return out;
}

/**
 * The raw rows for the join. Split from `indexT3Rows` on purpose: the SOURCE call (an API request, a
 * store read) is the thing whose failure is a failure of another machine and is worth tolerating, while
 * the join itself is pure code whose error would be a bug in ob.
 */
export async function readT3RowInput(source: T3RowSource): Promise<{ spinoffs: T3SpinoffRow[]; agents: T3AgentRow[] }> {
  const [spinoffs, agents] = await Promise.all([source.spinoffs(), source.agents()]);
  return { spinoffs, agents };
}

/**
 * The seam a READ command uses. Identical to `t3Seam()` except that a transport failure carries the
 * remedy the ticket requires IN THE MESSAGE — `ob t3 doctor` (and `ob t3 login` when the credential is the
 * problem) — because a thrown error prints its message alone, and "the credential is missing" with no next
 * step is the half-answer this rule exists to stop. A caller's own injected seam is returned untouched.
 */
export async function readT3Seam(seam?: T3Seam): Promise<T3Seam> {
  if (seam) return seam;
  try {
    return await t3Seam();
  } catch (err) {
    throw decorateT3Error(err);
  }
}

/**
 * Append the read surface's next step to a T3 failure, and leave every other error alone.
 *
 * A TRANSPORT failure (unreachable, a missing/expired/rejected credential, a broken protocol) means "the
 * seam is not working, go look at it": `ob t3 doctor`, then `ob t3 login`. A REFUSAL means something else
 * and already carries its own precise next step ("the thread was deleted or the id is stale; re-read the
 * tree"), which is appended instead — the transport pointer would send that reader to the wrong place.
 *
 * The append matters because a thrown error prints its MESSAGE alone (`cli.ts` writes `error: <message>`),
 * so a remedy left in the field is a remedy the human never sees. Idempotent: a message that already
 * carries the pointer is returned as it is, so an error can pass through several read layers. Pure.
 */
export function decorateT3Error(err: unknown): unknown {
  if (!(err instanceof T3Error)) return err;
  const transport = err.kind === "unreachable" || err.kind === "protocol" || err.kind.startsWith("credential_");
  const next = transport
    ? "run `ob t3 doctor` to see which stage failed, or `ob t3 login` to re-mint the credential"
    : err.remedy;
  if (!next || err.message.includes(next)) return err;
  return new T3Error(err.kind, `${err.message} — ${next}`, err.remedy, err.code);
}

/** Run one read against T3, decorating a transport failure with the remedy. See `decorateT3Error`. */
export async function withT3Read<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw decorateT3Error(err);
  }
}

// ---------------------------------------------------------------------------
// The T3 half — the threads, as T3 reports them
// ---------------------------------------------------------------------------

/** T3's own documented shape for handing a human a thread. The id is NOT URL-encoded. Pure. */
export function threadLink(threadId: string): string {
  return `t3-thread://v1/${threadId}`;
}

/**
 * How many threads per project the read surface walks. One page: a project with more is REPORTED as
 * truncated rather than silently cut, and the page is newest-first, so what is shown is what is recent.
 */
export const T3_READ_THREAD_LIMIT = 50;

/** One thread as the read surface shows it: T3's fields, plus the ob row it is joined to. */
export interface T3ThreadView {
  threadId: string;
  projectId: string;
  /** The project's title, for grouping. */
  project: string;
  title: string;
  status: string;
  settled: boolean;
  pendingRequestCount: number;
  worktreePath: string | null;
  branch: string | null;
  parentThreadId: string | null;
  relationshipToParent: string | null;
  updatedAt: string | null;
  /** The ob ticket/row this thread belongs to, or null when T3 has a thread ob knows nothing about. */
  ob: T3ObRow | null;
  link: string;
}

/** A thread whose detail could not be read, named rather than dropped. */
export interface T3UnreadableThread {
  threadId: string;
  reason: string;
}

export interface T3ThreadReadResult {
  projects: T3Project[];
  threads: T3ThreadView[];
  /** Thread ids T3 listed but could not detail — reported, never silently missing. */
  unreadable: T3UnreadableThread[];
  /** Projects whose thread list was longer than one page. */
  truncated: number;
}

/** Newest first, by T3's own `updatedAt`; threads without one keep the list's order. Pure. */
function byNewest(a: T3ThreadView, b: T3ThreadView): number {
  const at = a.updatedAt ? Date.parse(a.updatedAt) : Number.NaN;
  const bt = b.updatedAt ? Date.parse(b.updatedAt) : Number.NaN;
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
  return 0;
}

/**
 * Read every project's threads, newest first, each detailed with `t3_thread_read` (the worktree, the
 * branch and the pending count are on the READ, not on the list row).
 *
 * ONE upstream condition is tolerated: T3 refusing a thread because it is GONE (`thread_not_found` —
 * deleted, or archived away between the list and the read), which is reported in `unreadable` and shown
 * from its summary. Everything else is RETHROWN: an unreachable server, a rejected credential, a refusal
 * of any other kind. Tolerating those would turn "T3 fell over halfway through" into a short, successful
 * list — the false partial success this whole module is written to avoid.
 */
export async function readT3Threads(
  seam: T3Seam,
  opts: { includeSubagents?: boolean; limitPerProject?: number } = {},
): Promise<T3ThreadReadResult> {
  return withT3Read(() => readT3ThreadsInner(seam, opts));
}

async function readT3ThreadsInner(
  seam: T3Seam,
  opts: { includeSubagents?: boolean; limitPerProject?: number } = {},
): Promise<T3ThreadReadResult> {
  const projects = (await seam.projects()).filter((p) => !p.deletedAt);
  const includeSubagents = opts.includeSubagents ?? false;
  const limit = opts.limitPerProject ?? T3_READ_THREAD_LIMIT;
  const threads: T3ThreadView[] = [];
  const unreadable: T3UnreadableThread[] = [];
  let truncated = 0;

  for (const project of projects) {
    const listed = await seam.list({ projectId: project.id, includeSubagents, limit });
    if (listed.nextCursor !== null && listed.nextCursor !== undefined) truncated += 1;
    const detailed = await Promise.all(
      listed.threads.map(async (summary): Promise<T3ThreadView> => {
        let thread: T3Thread | null = null;
        try {
          thread = await readThreadHeader(seam, summary.threadId);
        } catch (err) {
          if (!(err instanceof T3Error) || err.code !== "thread_not_found") throw err;
          unreadable.push({ threadId: summary.threadId, reason: err.message });
        }
        return {
          threadId: summary.threadId,
          projectId: thread?.projectId ?? project.id,
          project: project.title,
          title: thread?.title ?? summary.title,
          status: thread?.status ?? summary.status,
          settled: thread?.settled ?? summary.settled,
          pendingRequestCount: thread?.pendingRequestCount ?? 0,
          worktreePath: thread?.worktreePath ?? null,
          branch: thread?.branch ?? null,
          parentThreadId: thread?.parentThreadId ?? summary.parentThreadId ?? null,
          relationshipToParent: thread?.relationshipToParent ?? summary.relationshipToParent ?? null,
          updatedAt: thread?.updatedAt ?? summary.updatedAt ?? null,
          ob: null,
          link: threadLink(summary.threadId),
        };
      }),
    );
    threads.push(...detailed);
  }

  const sorted = threads.sort(byNewest);
  return { projects, threads: sorted, unreadable, truncated };
}

/** Attach the ob row each thread is joined to. Pure. */
export function joinThreadsToRows(threads: T3ThreadView[], index: Map<string, T3ObRow>): T3ThreadView[] {
  return threads.map((t) => ({ ...t, ob: index.get(t.threadId) ?? null }));
}

/**
 * The ob label a thread shows: the ITEM it serves (1163 — the row's recorded identity, falling back to the
 * ref it was dispatched with), else the architect's agent id, else none. Pure.
 */
export function threadObLabel(thread: Pick<T3ThreadView, "ob">): string | null {
  const ob = thread.ob;
  if (!ob) return null;
  if (ob.kind !== "builder") return ob.agentId;
  return ob.itemId ?? ob.ticket;
}

/**
 * The INTERIM "needs you" verdict (1103 item 7 has not landed): a pending question or approval, or a run
 * parked on the human (`waiting`). Pure.
 */
export function threadNeedsYou(thread: Pick<T3ThreadView, "pendingRequestCount" | "status">): boolean {
  return thread.pendingRequestCount > 0 || thread.status === "waiting";
}

/** Why a thread needs the human, in words, or null when it does not. Pure. */
export function needsYouReason(thread: Pick<T3ThreadView, "pendingRequestCount" | "status">): string | null {
  if (thread.pendingRequestCount > 0) return `${thread.pendingRequestCount} pending question${thread.pendingRequestCount === 1 ? "" : "s"}`;
  if (thread.status === "waiting") return "waiting on the human";
  return null;
}

// ---------------------------------------------------------------------------
// The read view — what every read caller sees (the `Threads` block in `ob status`,
// `t3 status` and `t3 tree`)
// ---------------------------------------------------------------------------

/**
 * The read surface's whole answer: T3's threads, the ones needing the human, and — when a side could not
 * be read — WHICH side and why.
 *
 * The two failure fields are deliberately separate. T3 being down is one thing (nothing can be shown);
 * the ob ROWS being unreadable is another (the threads were read fine and are shown UNATTRIBUTED). Folding
 * them into one error would hide a healthy T3 behind an API outage, which is the misattribution this shape
 * exists to prevent.
 */
export interface T3ReadView {
  projects: T3Project[];
  threads: T3ThreadView[];
  needsYou: T3ThreadView[];
  unreadable: T3UnreadableThread[];
  /** Projects holding more threads than one page (newest first, so what is shown is what is recent). */
  truncated: number;
  /** The one-line reason T3 could not be read at all, or null when it answered. */
  error: string | null;
  /** The one-line reason the ob join failed, or null. The threads are shown unattributed. */
  rowsError: string | null;
}

/** A view where nothing could be read, for a caller that already knows why (a failed health stage). */
export function unreadT3View(error: string): T3ReadView {
  return { projects: [], threads: [], needsYou: [], unreadable: [], truncated: 0, error, rowsError: null };
}

/**
 * Read the whole view for a caller that must not fail: `ob status` (which has a report to print anyway)
 * and the `t3 status`/`t3 tree` commands (which print what they could read and exit non-zero — the CALLER
 * decides that, from `error`/`rowsError`, so one place reads and each caller sets its own exit code).
 *
 * Never throws for a T3 or row-source failure: both are returned, as SEPARATE fields. A bug in ob — a
 * non-T3 error from the seam, or anything the pure join throws — still propagates.
 */
export async function readT3View(
  source: T3RowSource,
  opts: { includeSubagents?: boolean } = {},
  seam?: T3Seam,
): Promise<T3ReadView> {
  let read: T3ThreadReadResult;
  try {
    read = await readT3Threads(await readT3Seam(seam), opts);
  } catch (err) {
    // Only the SEAM's own failures are tolerated here. Anything else is a bug in ob, and reporting a bug
    // as "could not read T3" would send the reader to `ob t3 doctor` for a problem T3 cannot see.
    if (!(err instanceof T3Error)) throw err;
    return unreadT3View(err.message);
  }
  let rows: { spinoffs: T3SpinoffRow[]; agents: T3AgentRow[] } | null = null;
  let rowsError: string | null = null;
  try {
    rows = await readT3RowInput(source);
  } catch (err) {
    // A source failure IS the other machine's (the API, the store), so it is tolerated — and the threads
    // stay visible, unattributed. The pure join below is deliberately outside this catch.
    rowsError = (err as Error).message;
  }
  const threads = joinThreadsToRows(read.threads, rows ? indexT3Rows(rows) : new Map());
  return {
    projects: read.projects,
    threads,
    needsYou: threads.filter(threadNeedsYou),
    unreadable: read.unreadable,
    truncated: read.truncated,
    error: null,
    rowsError,
  };
}

/** The view's lines for `ob status`. `indent` is the caller's section depth. Pure. */
export function renderT3ThreadsBlock(view: T3ReadView, indent = "  "): string[] {
  const out: string[] = [];
  if (view.error) {
    out.push(`${indent}could not read T3 — ${view.error}`);
    return out;
  }
  if (view.rowsError) {
    out.push(`${indent}the ob rows could not be read — ${view.rowsError} (threads shown unattributed)`);
  }
  for (const u of view.unreadable) out.push(`${indent}could not read thread ${u.threadId} — ${u.reason}`);
  if (view.truncated > 0) {
    out.push(`${indent}${view.truncated} project(s) hold more threads than one page of ${T3_READ_THREAD_LIMIT} (newest first)`);
  }
  if (view.threads.length === 0) {
    out.push(`${indent}(none)`);
    return out;
  }
  for (const project of [...new Set(view.threads.map((t) => t.project))]) {
    out.push(`${indent}${project}`);
    for (const t of view.threads.filter((x) => x.project === project)) out.push(renderT3ThreadLine(t, `${indent}  `));
  }
  if (view.needsYou.length > 0) {
    out.push(`${indent}needs you`);
    for (const t of view.needsYou) {
      out.push(`${indent}  ${t.threadId}  ${threadObLabel(t) ?? t.title}  ${needsYouReason(t) ?? ""}`.trimEnd());
    }
  }
  return out;
}

/** One thread as a line: id, status (+settled), the ob label, branch and worktree. Pure. */
export function renderT3ThreadLine(t: T3ThreadView, indent = "  "): string {
  const bits = [
    t.threadId,
    `${t.status}${t.settled ? " (settled)" : ""}`,
    threadObLabel(t) ?? "-",
    t.branch ? `branch ${t.branch}` : "branch -",
    t.worktreePath ?? "-",
  ];
  const pending = t.pendingRequestCount > 0 ? `  pending ${t.pendingRequestCount}` : "";
  return `${indent}${bits.join("  ")}${pending}`;
}

// ---------------------------------------------------------------------------
// `ob t3 projects`
// ---------------------------------------------------------------------------

/** One registered T3 project, as ob reports it. Read live; never mirrored into a table (1124). */
export interface T3ProjectView {
  id: string;
  title: string;
  workspaceRoot: string;
  /** `owner/name` (or the canonical key) from T3's own repository identity; null when it has none. */
  repo: string | null;
  defaultModel: { instanceId: string; model: string } | null;
  scripts: number;
}

/** Pure: shape T3's projects for the read surface. Deleted projects are dropped, as `doctor` drops them. */
export function projectViews(projects: T3Project[]): T3ProjectView[] {
  return projects
    .filter((p) => !p.deletedAt)
    .map((p) => ({
      id: p.id,
      title: p.title,
      workspaceRoot: p.workspaceRoot,
      repo: p.repositoryIdentity?.displayName ?? p.repositoryIdentity?.canonicalKey ?? null,
      defaultModel: p.defaultModelSelection ?? null,
      scripts: (p.scripts ?? []).length,
    }));
}

/** `ob t3 projects`: T3's registered projects, read live (never mirrored into a table). */
export async function readT3Projects(seam: T3Seam): Promise<T3ProjectView[]> {
  return withT3Read(async () => projectViews(await seam.projects()));
}

/** One thread, by id — the read `ob t3 open` confirms its link with. Decorated like every other read. */
export async function readT3Thread(seam: T3Seam, threadId: string): Promise<T3Thread> {
  return withT3Read(async () => readThreadHeader(seam, threadId));
}

/** `ob t3 projects` in the human mode. Pure. */
export function renderT3Projects(rows: T3ProjectView[]): string {  const out: string[] = [`T3 Code projects (${rows.length})`];
  if (rows.length === 0) {
    out.push("  (none registered — `t3 project add <path>`)");
    return out.join("\n");
  }
  for (const p of rows) {
    out.push(`  ${p.title}  ${p.id}`);
    out.push(`    workspace  ${p.workspaceRoot}`);
    out.push(`    repo       ${p.repo ?? "-"}`);
    out.push(`    model      ${p.defaultModel ? `${p.defaultModel.instanceId} · ${p.defaultModel.model}` : "- (a launch would refuse: no default model)"}`);
    out.push(`    scripts    ${p.scripts}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// `ob t3 tree`
// ---------------------------------------------------------------------------

export interface T3TreeNode {
  threadId: string;
  title: string;
  status: string;
  settled: boolean;
  relationshipToParent: string | null;
  ob: T3ObRow | null;
  children: T3TreeNode[];
}

export interface T3TreeProject {
  projectId: string;
  title: string;
  roots: T3TreeNode[];
}

/**
 * The architect → builder graph, per project: T3's own parent links (`parentThreadId` /
 * `relationshipToParent`) over the threads the read returned, joined to ob's rows so each node names its
 * ticket. A node whose parent is not in the set is a ROOT — which is the normal case, because ob's
 * builders are top-level threads in their project (the map's decision): the project group is the tree,
 * and a delegated subagent is the only thing that nests.
 *
 * Subagents are excluded upstream (`readT3Threads({includeSubagents:false})`) unless `--subagents` asked
 * for them, so this function sees exactly what the caller asked to see. Pure.
 */
export function buildT3Tree(projects: T3Project[], threads: T3ThreadView[]): T3TreeProject[] {
  const known = new Set(threads.map((t) => t.threadId));
  const nodes = new Map<string, T3TreeNode>(
    threads.map((t) => [
      t.threadId,
      {
        threadId: t.threadId,
        title: t.title,
        status: t.status,
        settled: t.settled,
        relationshipToParent: t.relationshipToParent ?? null,
        ob: t.ob,
        children: [],
      },
    ]),
  );
  const rootsByProject = new Map<string, T3TreeNode[]>();
  for (const t of threads) {
    const node = nodes.get(t.threadId)!;
    const parent = t.parentThreadId && known.has(t.parentThreadId) ? nodes.get(t.parentThreadId)! : null;
    if (parent) {
      parent.children.push(node);
      continue;
    }
    const roots = rootsByProject.get(t.projectId) ?? [];
    roots.push(node);
    rootsByProject.set(t.projectId, roots);
  }
  return projects.map((p) => ({ projectId: p.id, title: p.title, roots: rootsByProject.get(p.id) ?? [] }));
}

/** `ob t3 tree` in the human mode. The diagnostics are the SAME ones `--json` carries — an incomplete tree
 *  must not look complete just because it is being read by a human. Pure. */
export function renderT3Tree(
  projects: T3TreeProject[],
  notes: { unreadable?: T3UnreadableThread[]; truncated?: number; rowsError?: string | null } = {},
): string {
  const total = projects.reduce((n, p) => n + countNodes(p.roots), 0);
  const out: string[] = [`T3 Code tree (${total} thread${total === 1 ? "" : "s"})`];
  if (notes.rowsError) out.push(`  the ob rows could not be read — ${notes.rowsError} (nodes shown unattributed)`);
  for (const u of notes.unreadable ?? []) out.push(`  could not read thread ${u.threadId} — ${u.reason}`);
  if ((notes.truncated ?? 0) > 0) {
    out.push(`  ${notes.truncated} project(s) hold more threads than one page of ${T3_READ_THREAD_LIMIT}`);
  }
  if (total === 0) {
    out.push("  (no threads)");
    return out.join("\n");
  }
  for (const p of projects) {
    out.push(`  ${p.title}`);
    if (p.roots.length === 0) {
      out.push("    (no threads)");
      continue;
    }
    for (const node of p.roots) out.push(...renderT3TreeNode(node, "    "));
  }
  return out.join("\n");
}

function countNodes(nodes: T3TreeNode[]): number {
  return nodes.reduce((n, node) => n + 1 + countNodes(node.children), 0);
}

function renderT3TreeNode(node: T3TreeNode, indent: string): string[] {
  const label = threadObLabel({ ob: node.ob }) ?? node.title;
  const kind = node.ob?.kind ?? "unattributed";
  const rel = node.relationshipToParent ? ` (${node.relationshipToParent})` : "";
  const out = [`${indent}${label}${rel}  ${node.threadId}  ${node.status}${node.settled ? " (settled)" : ""}  [${kind}]`];
  for (const child of node.children) out.push(...renderT3TreeNode(child, `${indent}  `));
  return out;
}

// ---------------------------------------------------------------------------
// `ob t3 open`
// ---------------------------------------------------------------------------

/**
 * The thread a ticket's spinoff row is stamped with, newest row first. `ticketRef` matches the ob ITEM the
 * row records (1163), else the ref it was dispatched with, else its branch — a human types any of the
 * three, and the item id is the one that means the same thing at every reader. Pure.
 */
export function threadIdForTicket(rows: T3SpinoffRow[], ticketRef: string): { threadId: string; row: T3SpinoffRow } | null {
  const want = ticketRef.trim().replace(/^#/, "").toLowerCase();
  if (!want) return null;
  const matches = rows
    .filter(
      (r) =>
        r.t3_thread_id &&
        (r.item_id?.toLowerCase() === want || r.ticket_ref.toLowerCase() === want || r.branch.toLowerCase() === want),
    )
    .sort((a, b) => b.id - a.id);
  const row = matches[0];
  return row ? { threadId: row.t3_thread_id!, row } : null;
}

/**
 * True when the argument is a T3 thread id rather than a ticket ref. T3's ids carry a scheme
 * (`mcp:<uuid>`, `thread:<…>`) or are a bare uuid (a thread a human opened in the app), while an ob
 * ticket ref never contains a colon. Pure.
 */
export function looksLikeThreadId(arg: string): boolean {
  const a = arg.trim();
  return a.includes(":") || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(a);
}

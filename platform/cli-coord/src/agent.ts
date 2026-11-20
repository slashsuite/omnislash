// ob 337: the agent registry through ob 324's store seam.
//
// Same two conventions as items.ts: every function takes `Database | Store` and normalises with asStore
// (the signature WIDENS, so unported callers and existing tests keep passing a raw handle and keep
// byte-identical sqlite behaviour), and every function is async with every builder AWAITED (.all()/.get()/
// .run() are the sqlite dialect's synchronous terminators and do not exist on pg-core).
//
// Where the documented Postgres differences bite in here:
//   - count() comes back as a STRING, so agentsActiveWithin goes through readNumber. Un-coerced its
//     result would compare and add as text, and the capacity check in `ob agents` reads that number.
//   - no boolean and no json column on `agent`, so store.bool / store.json are not needed.
//   - ordering is `asc(started_at)`, and started_at is NOT NULL, so the NULLS FIRST/LAST split between the
//     engines cannot reach it. `heartbeat_at` and `ttl_s` are NOT NULL too, and are only ever compared.
import type { Database } from "bun:sqlite";
import { asc, count, eq, gte, inArray } from "drizzle-orm";
import { nowIso } from "../../../apps/cli/src/db.ts";
import { asStore, readNumber, type Store } from "../../../apps/cli/src/db/store.ts";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import { expiredLeaseHolders, listAllLeaseResources, releaseAllLeases } from "./lease.ts";

/** How many agents heartbeated within the last `withinMs` — i.e. are "actively working" (098). */
export async function agentsActiveWithin(db: Database | Store, withinMs: number): Promise<number> {
  const s = asStore(db);
  const cutoff = new Date(Date.now() - withinMs).toISOString();
  const rows = (await s.q
    .select({ n: count() })
    .from(s.t.agent)
    .where(gte(s.t.agent.heartbeat_at, cutoff))
    .limit(1)) as Array<{ n: number }>;
  return readNumber(rows[0]?.n);
}

// Agent activity registry (043): who's working on what right now. One row per agent
// (coexisting — not a lease/mutex). Reuses the lease TTL/heartbeat liveness rule.

/**
 * ob's OWN workflow words for `agent.status` — this column, and this column only (1189).
 *
 * These are meanings T3 cannot express: `readying`/`ready-for-gate` is the land gate, `needs-human` is
 * parked on the owner, `blocked` cannot proceed, and T3 has **no word for landability at all** (the map's
 * settled answer: a run's terminal state says the agent stopped, never that the work can land). So the
 * one thing that was NOT done here is adopting T3's enum wholesale.
 *
 * The OTHER vocabulary — T3's own thread enum — lives in `agent.run` (see `AgentRow.run`), written only
 * by the run-state mirror. `ob agents` and `ob status` print `status · run`, and `--json` carries the two
 * as separate fields. A MISMATCH between them is information, not an error: `run = failed` with
 * `status = working` is exactly "the run died and the agent never reported back".
 */
export const AGENT_STATUSES = [
  "planning",
  "working",
  "readying",
  "needs-human", // parked on the owner: a question, a visual judge, any input (ob 396)
  "blocked",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * The word a NEW agent row gets from `ob agent register` when the caller passes no `--status` — the
 * agent's own default, applied by the REGISTER SURFACES (the CLI, local and over the API), never by the
 * store. 1189: a launcher creating the row for a tree/lease claims no workflow word at all, so the row
 * reads `-` until the agent speaks, and the spinoff row is what says a launch is in flight (#146).
 */
export const DEFAULT_AGENT_STATUS: AgentStatus = "working";

/**
 * Words `agent.status` no longer TAKES, but rows on disk still HOLD (1189). They are READ (the column is
 * free text and every reader shows what it finds) and **never written**: every register surface refuses
 * them, because a value here can only be written by hand or by an old binary.
 *
 *   - `resolving-comments`, `manual-review`: words from a review loop this repo does not run (decision #29; since #80 lands go through a PR the architect merges (#82) without one).
 *     `needs-human` already covers what `manual-review` meant, and the `ob status` "needs review" section
 *     and the dashboard keep classifying old rows by it.
 *   - `launching`, `failed` — launcher words. The `spinoff` row already carries both
 *     (`SPINOFF_STATUSES`), so the agent row does not need a second copy.
 *
 * T3's thread words (`idle · preparing · … · rolled_back`) are in the same position on old rows: 1120
 * wrote them here verbatim, and 1189 moved them to `run` without touching a single stored row.
 */
export const LEGACY_AGENT_STATUSES = ["launching", "resolving-comments", "manual-review", "failed"] as const;

export const DEFAULT_AGENT_TTL_S = 900; // 15m — agents run long; heartbeat keeps them alive

export function isAgentStatus(s: string): s is AgentStatus {
  return (AGENT_STATUSES as readonly string[]).includes(s);
}

/**
 * The status a caller's raw string means, or null when the registry does not know it. This is the WRITE
 * gate: the five ob words pass, and everything else (a retired word, T3's enum, a typo) is refused, which
 * is what keeps the removed words unwritable while stored rows still read back.
 *
 * It used to accept `waiting` as a write-alias for `needs-human`; 1120 removed that, because `waiting` is
 * T3's OWN status (a run parked on the human) and one string cannot mean two things in one column.
 */
export function parseAgentStatus(s: string): AgentStatus | null {
  return isAgentStatus(s) ? s : null;
}

/**
 * The one-line label `ob agents` / `ob status` print for a row: `status · run`, joined for the human and
 * only for the human — `--json` keeps the fields apart (1189). Either half may be absent: a headless
 * builder has no run, and a row whose agent has not spoken yet has no workflow status. Absent both, "-".
 */
export function agentStateLabel(status: string | null, run: string | null): string {
  const parts = [status, run].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : "-";
}

/**
 * OSC escape that sets the terminal tab title to `<status> · <ticket>` (062), so a spun-off agent's
 * own tab reflects its live state (esp. manual-review). Control chars stripped. Pure — the caller
 * decides when to write it (only to a TTY). Returns "" if there's nothing meaningful to show.
 */
export function tabTitleEscape(status: string | null, ticket: string | null): string {
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point of this regex
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const parts = [status, ticket].filter((p): p is string => !!p).map(clean).filter(Boolean);
  if (parts.length === 0) return "";
  return `\u001b]0;${parts.join(" · ")}\u0007`; // OSC 0 — set window/tab title, BEL-terminated
}

export interface AgentRow {
  id: string;
  ticket: string | null;
  worktree: string | null;
  branch: string | null;
  status: string | null;
  /** T3's own run enum, for a `launcher t3` row; written only by the run-state mirror, null when there is
   *  no run to report (a headless builder, or a t3 row the mirror has not reached yet). NEVER self-set. */
  run: string | null;
  note: string | null;
  launcher: string | null; // where this agent lives: t3, or a legacy value on an old row (#125/#79); null = unknown
  session_id: string | null; // the Claude Code session this agent was launched with (#126); null = not resumable
  started_at: string;
  heartbeat_at: string;
  ttl_s: number;
}
export interface AgentStatusRow extends AgentRow {
  expired: boolean;
}

/**
 * Where an agent lives (#125): its OWN recorded launcher wins; a row without one falls back to the
 * launcher of the spinoff that launched it (spinoff.ts's `agentLauncherMap`); null when neither knows: a registry row predating migration 0020, or a hand-registered agent that never said. Pure.
 */
export function effectiveLauncher(row: { launcher: string | null }, fromSpinoff?: string | null): string | null {
  return row.launcher ?? fromSpinoff ?? null;
}

/** Stale when the heartbeat is older than the TTL — the lease liveness rule. Pure. */
export function isAgentExpired(row: AgentRow, nowMs: number): boolean {
  const base = row.heartbeat_at ?? row.started_at;
  if (!base) return true;
  const baseMs = new Date(base).getTime();
  if (Number.isNaN(baseMs)) return true;
  return nowMs > baseMs + row.ttl_s * 1000;
}

export async function getAgent(db: Database | Store, id: string): Promise<AgentRow | null> {
  const s = asStore(db);
  const rows = (await s.q.select().from(s.t.agent).where(eq(s.t.agent.id, id)).limit(1)) as AgentRow[];
  return rows[0] ?? null;
}

/**
 * A status word the STORE refuses (OB-1923): anything that is not a current `AGENT_STATUSES` word, the
 * `LEGACY_AGENT_STATUSES` included. The CLI and the API refuse a bad word at the edge already; this is the
 * second gate for the internal callers that reach `registerAgent` directly. A `UsageError`, so the API
 * maps it to a 400 `invalid_request` and the CLI to exit 2, the same as the edge refusal.
 */
export class InvalidAgentStatusError extends UsageError {
  constructor(readonly status: string) {
    super(`agent status '${status}' is not one of ${AGENT_STATUSES.join("|")}`);
    this.name = "InvalidAgentStatusError";
  }
}

/**
 * T3 run words that mean the run is over (OB-1923). Every other T3 word (`idle`, `running`, `waiting`,
 * `failed` ...) is treated as an active run, so the mirror keeps the row's heartbeat fresh; a finished run
 * leaves `heartbeat_at` alone and the row ages out on its TTL. This is the ticket's list, not
 * `T3_LIVE_STATUSES`: a `failed` run stays visible beside the agent's own `status` ("the run died and the
 * agent never reported back") until its spinoff row is retired, which is what stops the mirror reading it.
 */
const T3_FINISHED_RUNS = ["completed", "interrupted", "cancelled", "rolled_back"] as const;

function isT3RunActive(run: string): boolean {
  return !(T3_FINISHED_RUNS as readonly string[]).includes(run);
}

/**
 * Write T3's run word onto an EXISTING agent row, never insert one (OB-1923). Returns false when there is
 * no row, so a retired builder is never resurrected by the mirror. `heartbeat_at` moves only while the run
 * is active (`isT3RunActive`): that refresh is what keeps a T3 builder row live, and a finished run must
 * let it expire. Nothing else on the row is touched.
 */
export async function setAgentRun(db: Database | Store, id: string, run: string): Promise<boolean> {
  const s = asStore(db);
  return s.txn("set the agent run", async (tx) => {
    const existing = await getAgent(tx, id);
    if (!existing) return false;
    await tx.q
      .update(tx.t.agent)
      .set(isT3RunActive(run) ? { run, heartbeat_at: nowIso() } : { run })
      .where(eq(tx.t.agent.id, id));
    return true;
  });
}

export interface RegisterAgentInput {
  id: string;
  ticket?: string | null;
  worktree?: string | null;
  branch?: string | null;
  /** ob's workflow word. Omitted/null preserves the stored one (a bare re-register is a heartbeat). */
  status?: string | null;
  /** T3's run word (1189). Omitted/null preserves the stored one. The mirror writes through `setAgentRun` (OB-1923). */
  run?: string | null;
  note?: string | null;
  launcher?: string | null;
  sessionId?: string | null; // the Claude Code session id this agent was launched with (#126)
  ttlS: number;
}

/**
 * Register or refresh (heartbeat) an agent — upsert on id. On a refresh, omitted
 * fields are preserved (so a bare re-register acts as a heartbeat) and `started_at`
 * is kept; `heartbeat_at` and `ttl_s` always update.
 *
 * `status` must be a current `AGENT_STATUSES` word or null; anything else throws `InvalidAgentStatusError`
 * (OB-1923), legacy words included, so they are never written again. Rows already holding one read as they
 * are. Null is written as given: this is the STORE, and 1189 moved the choice of a
 * default word to the surfaces where an agent registers itself (`ob agent register`, local and over the
 * API). A launcher creating the row for a tree/lease claims no workflow word — the row says `-` until the
 * agent speaks, and the SPINOFF row is what says a launch is in flight — which is what keeps
 * `DEFAULT_AGENT_STATUS` from being asserted by the launcher (#146).
 */
export async function registerAgent(db: Database | Store, input: RegisterAgentInput): Promise<AgentRow> {
  const s = asStore(db);
  const now = nowIso();
  let status: AgentStatus | null = null;
  if (input.status != null) {
    status = parseAgentStatus(input.status);
    if (status === null) throw new InvalidAgentStatusError(input.status);
  }
  // `run` is written by the run-state mirror and by nothing else (1189). It is NOT parsed: T3's enum is
  // the transport's to validate (an unreadable/unknown thread status is reported and skipped there), and
  // ob's own register surface does not offer the field at all.
  const run = input.run ?? null;
  const row = await s.txn("register the agent", async (tx) => {
    const existing = await getAgent(tx, input.id);
    if (!existing) {
      await tx.q
        .insert(tx.t.agent)
        .values({
          id: input.id,
          ticket: input.ticket ?? null,
          worktree: input.worktree ?? null,
          branch: input.branch ?? null,
          status,
          run,
          note: input.note ?? null,
          launcher: input.launcher ?? null,
          session_id: input.sessionId ?? null,
          started_at: now,
          heartbeat_at: now,
          ttl_s: input.ttlS,
        });
    } else {
      await tx.q
        .update(tx.t.agent)
        .set({
          ticket: input.ticket ?? existing.ticket,
          worktree: input.worktree ?? existing.worktree,
          branch: input.branch ?? existing.branch,
          status: status ?? existing.status,
          run: input.run ?? existing.run,
          note: input.note ?? existing.note,
          launcher: input.launcher ?? existing.launcher,
          session_id: input.sessionId ?? existing.session_id,
          heartbeat_at: now,
          ttl_s: input.ttlS,
        })
        .where(eq(tx.t.agent.id, input.id));
    }
    return (await getAgent(tx, input.id))!;
  });
  return row;
}

/** Refresh only the heartbeat. Returns whether the agent existed. */
export async function heartbeatAgent(db: Database | Store, id: string): Promise<boolean> {
  const s = asStore(db);
  const exists = (await s.q.select({ id: s.t.agent.id }).from(s.t.agent).where(eq(s.t.agent.id, id)).limit(1)) as Array<{
    id: string;
  }>;
  if (exists.length === 0) return false;
  await s.q.update(s.t.agent).set({ heartbeat_at: nowIso() }).where(eq(s.t.agent.id, id));
  return true;
}

/** Deregister on clean exit. Returns whether a row was deleted. */
export async function doneAgent(db: Database | Store, id: string): Promise<boolean> {
  const s = asStore(db);
  const exists = (await s.q.select({ id: s.t.agent.id }).from(s.t.agent).where(eq(s.t.agent.id, id)).limit(1)) as Array<{
    id: string;
  }>;
  if (exists.length === 0) return false;
  await s.q.delete(s.t.agent).where(eq(s.t.agent.id, id));
  return true;
}

/** All agents with a computed `expired` flag; live-only unless `includeExpired`. */
export async function listAgents(
  db: Database | Store,
  opts: { includeExpired?: boolean } = {},
): Promise<AgentStatusRow[]> {
  const s = asStore(db);
  const nowMs = Date.now();
  // started_at is NOT NULL, so ASC is stable on both engines (the NULLS FIRST/LAST split only shows up on
  // a nullable ordering column).
  const rows = (await s.q.select().from(s.t.agent).orderBy(asc(s.t.agent.started_at))) as AgentRow[];
  const leaseExpiredHolders = await expiredLeaseHolders(s, nowMs);
  return rows
    .map((row) => ({
      ...row,
      expired: isAgentExpired(row, nowMs) || leaseExpiredHolders.has(row.id),
    }))
    .filter((row) => opts.includeExpired || !row.expired);
}

/** Every agent id, including expired. Ordered. Does not delete. */
export async function listAllAgentIds(db: Database | Store): Promise<string[]> {
  const s = asStore(db);
  const rows = (await s.q
    .select({ id: s.t.agent.id })
    .from(s.t.agent)
    .orderBy(asc(s.t.agent.id))) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Empty the agent table (ob 437). Returns the ids that went. */
export async function resetAgents(db: Database | Store): Promise<string[]> {
  const s = asStore(db);
  const ids = await listAllAgentIds(s);
  if (ids.length === 0) return [];
  await s.q.delete(s.t.agent).where(inArray(s.t.agent.id, ids));
  return ids;
}

export interface AgentsResetReport {
  agents: string[];
  leases: string[];
}

/** Human report for `ob agents reset` (437). Same renderer the API client uses. */
export function formatAgentsReset(report: AgentsResetReport, dryRun: boolean): string {
  const verb = dryRun ? "would reset" : "reset";
  const lines = [`${verb} ${report.agents.length} agents, ${report.leases.length} leases`];
  if (report.agents.length) lines.push(`  agents: ${report.agents.join(", ")}`);
  if (report.leases.length) lines.push(`  leases: ${report.leases.join(", ")}`);
  if (!dryRun) {
    lines.push("  live processes stay up; do not kill or relaunch anything — the next register/heartbeat recreates a row and its holds");
  }
  return lines.join("\n");
}

/**
 * Wipe the agent registry AND release every lease (ob 437). One transaction so a half-wipe cannot
 * land. `--dry-run` lists what would go and writes nothing.
 */
export async function resetAgentsAndLeases(
  db: Database | Store,
  opts: { dryRun?: boolean } = {},
): Promise<AgentsResetReport> {
  const s = asStore(db);
  const report = await s.txn("reset agents and leases", async (tx) => {
    if (opts.dryRun) {
      return { agents: await listAllAgentIds(tx), leases: await listAllLeaseResources(tx) };
    }
    return { agents: await resetAgents(tx), leases: await releaseAllLeases(tx) };
  });
  return report;
}

// `ob role tick [--team <t>[,<t>...]]` (OS-67): one pass of the 15 minute client job. For each team whose checkout is on
// this machine it writes the store's findings into the architect's inbox (see ../role-tick.ts), then delivers the
// architect's unread messages with `deliverToRole`. No unread messages after the writes is one line and no T3 call.
// Then (OS-57) it ends the team's role runs that are idle or over the context cap, each leaving its note (../role-end.ts).
// OS-213: a building builder whose thread is past the same cap is one architect message asking for its relaunch.
// OS-48: before delivering, it test-merges the team's running branches here; each conflicting pair goes to the sentinel.
// OS-259: the pair's loser is paused, and told to go on once its winner has landed.
//
// One procedure serves the store and the API client: each passes a `TickBackend` for the data. T3 is the caller's.
import { homedir } from "node:os";
import type { Flags } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print, warn, type Mode } from "../output.ts";
import { deliverToRole, nightLockedUntil, renderDelivery, type DeliverOutcome } from "../role-deliver.ts";
import { contextTokens, endPass, renderEndResult, ROLE_CONTEXT_END_TOKENS, type EndPassDeps, type EndPassResult } from "../role-end.ts";
import { builderContextFindings, TICK_FROM, tickClientKey, type TickFinding } from "../role-tick.ts";
import { resolveRepoWith } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import {
  conflictKey,
  conflictMessage,
  conflictNote,
  findBranchConflicts,
  lastYieldId,
  openYields,
  pairHandled,
  pairHeads,
  pickLoser,
  renderConflict,
  resumeKey,
  resumeMessage,
  resumeNotice,
  rowThread,
  yieldMessage,
  type ConflictSource,
  type PauseOutcome,
} from "../../../../platform/cli-coord/src/spinoff-conflicts.ts";
import { IN_FLIGHT } from "../../../../platform/cli-coord/src/spinoff-vocab.ts";
import type { OverlapRow } from "../../../../platform/cli-coord/src/spinoff-overlap.ts";
import { worktreeRepoOf, type T3Seam } from "../t3/dispatch.ts";
import type { TeamView } from "../team.ts";
import type { InboxBackend } from "./inbox.ts";
import type { RoleBackend } from "./role.ts";

/** The role a tick acts for. */
const TICK_ROLE = "architect" as const;
/** OS-48: who a branch conflict goes to. */
const CONFLICT_ROLE = "sentinel" as const;

/** Where a tick's data lives: the store on this machine, or the API. */
export interface TickBackend {
  role: RoleBackend;
  inbox: InboxBackend;
  teams(): Promise<TeamView[]>;
  /** The `repo_checkouts` setting, parsed. */
  checkouts(): Promise<Record<string, string>>;
  findings(team: string): Promise<TickFinding[]>;
  /** OS-48: the branch conflict check's rows, checkouts and notes; absent, the tick checks no branches. */
  conflicts: () => Promise<ConflictSource>;
}

interface TickCtx {
  mode: Mode;
  flags: Flags;
  exit?: number | undefined;
}

/** What one team's pass did. */
interface TickTeamResult {
  team: string;
  skipped: string | null;
  written: Array<{ id: number; kind: string; ref: string }>;
  /** OS-48: the conflicting pairs whose sentinel message this pass wrote, and the git failures it only warned about. */
  conflicts: Array<{ id: number; line: string }>;
  /** OS-259: the paused rows this pass told to go on, each with its resume notice. */
  resumed: Array<{ id: number; line: string }>;
  conflict_warnings: string[];
  unread: number;
  night_lock_until: string | null;
  delivery: DeliverOutcome | null;
  /** OS-48: the sentinel's unread messages after the writes, and what delivering them did. */
  sentinel_unread: number;
  sentinel_delivery: DeliverOutcome | null;
  /** OS-57: what the end pass did with each of the team's open role runs. */
  ended: EndPassResult[];
  error: string | null;
}

/**
 * A team's checkout on this machine: the first member project that resolves (an existing path, its `repo_checkouts`
 * entry, else `~/dev/<id>`), a worktree read as its repo. Null when none does. Pure aside from the directory tests.
 */
export function teamCheckout(team: Pick<TeamView, "members">, checkouts: Record<string, string>, home: string = homedir()): string | null {
  for (const id of team.members) {
    try {
      const resolved = resolveRepoWith(checkouts, id, home);
      return worktreeRepoOf(resolved) ?? resolved;
    } catch {
      // not on this machine: try the next member
    }
  }
  return null;
}

/** The `--team` flag as names: a comma-separated list, each trimmed; none means every team. */
function teamNames(raw: string | boolean | undefined): string[] | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || !raw.trim()) throw new UsageError("--team needs a team name (or a comma-separated list)");
  return raw.split(",").map((t) => t.trim()).filter(Boolean);
}

function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();
}

/**
 * OS-48: test-merge the team's running branches in this machine's checkouts and write one sentinel message per
 * conflicting pair, reported once while it is handled however its heads move, and again (OS-263) only when it conflicts on
 * new heads after its loser was resumed. A new message also notes
 * both tickets. Git failures are warnings on the result, never a failed tick.
 *
 * OS-259: first, every paused row whose winners have all landed or stopped is told to rebase and go on (one resume
 * notice each). Then for each new pair the loser (pickLoser) is stopped and told to wait, unless an earlier pair
 * already paused it, and the message says who won and who pauses.
 */
async function tickConflicts(backend: TickBackend, result: TickTeamResult, source: ConflictSource, rows: OverlapRow[], seam: () => Promise<T3Seam>): Promise<void> {
  const team = result.team;
  const check = await findBranchConflicts(rows, source);
  result.conflict_warnings.push(...check.warnings);
  const sentinel = await backend.inbox.list(team, CONFLICT_ROLE, true);
  const open = openYields(sentinel);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const warnOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  // A winner is gone once its row stopped running, or its branch landed on origin/main or left origin (deleted on merge).
  const stillRunning = (id: number): boolean => {
    const r = byId.get(id);
    return !!r && IN_FLIGHT.has(r.status) && !check.landed.some((l) => l.row === id) && !check.unpushed.some((u) => u.row === id);
  };
  for (const [loser, winners] of open) {
    const row = byId.get(loser);
    if (!row || !IN_FLIGHT.has(row.status) || winners.some(stillRunning)) continue;
    const refs = winners.map((w) => byId.get(w)?.ticket_ref ?? `row ${w}`);
    const pause = lastYieldId(sentinel, loser);
    const key = resumeKey(loser, winners, pause);
    const thread = rowThread(row);
    let told = false;
    if (thread) {
      try {
        // The request id names the thread: T3 dedups ids across every thread, and row ids restart in each store (OS-212).
        await (await seam()).send({ threadId: thread, message: resumeMessage(row.ticket_ref, refs), mode: "queue", clientRequestId: `ob-resume-${thread}-${loser}-${[...winners].sort((x, y) => x - y).join("-")}-${pause}` });
        told = true;
      } catch (e) {
        // The notice says to resume it by hand, so a thread that never takes the message is not retried forever.
        result.conflict_warnings.push(`conflicts: resume of ${row.ticket_ref} failed: ${warnOf(e)}`);
      }
    }
    const { message, created } = await backend.inbox.send({ team, role: CONFLICT_ROLE, from: TICK_FROM, kind: "message", ref: row.ticket_ref, body: resumeNotice(row.ticket_ref, loser, refs, told), clientKey: key });
    open.delete(loser);
    if (created) result.resumed.push({ id: message.id, line: `resume: ${row.ticket_ref} after ${refs.join(", ")}` });
  }
  for (const c of check.conflicts) {
    // OS-263: a pair still being handled, or unchanged since it was posted, is not posted again.
    if (pairHandled(c, sentinel, open)) continue;
    // A priority that cannot be read decides nothing: the pair waits for the next tick rather than rank it as none.
    let pa: number | null, pb: number | null;
    try {
      [pa, pb] = await Promise.all([source.priority(c.a), source.priority(c.b)]);
    } catch (e) {
      result.conflict_warnings.push(`conflicts: priority of ${c.a.ref} or ${c.b.ref} failed: ${warnOf(e)}; the pair waits`);
      continue;
    }
    const { winner, loser } = pickLoser(c, pa, pb);
    const [pw, pl] = winner === c.a ? [pa, pb] : [pb, pa];
    let pause: PauseOutcome = "by-hand";
    if (open.has(loser.row)) pause = "already";
    else if (loser.thread) {
      try {
        const s = await seam();
        // Stop the turn it is in, best effort: an idle thread has nothing to stop. The message is what pauses it.
        await s.interrupt(loser.thread).catch(() => {});
        await s.send({ threadId: loser.thread, message: yieldMessage(c, winner, loser, pw, pl), mode: "queue", clientRequestId: `ob-yield-${loser.thread}-${loser.row}-${winner.row}-${pairHeads(c).replace(":", "-")}` });
        pause = "paused";
      } catch (e) {
        // The pair is still posted, saying the pause did not reach the thread, so someone is told to pause it by hand.
        result.conflict_warnings.push(`conflicts: pause of ${loser.ref} failed: ${warnOf(e)}`);
        pause = "unreached";
      }
    }
    const { message, created } = await backend.inbox.send({
      team,
      role: CONFLICT_ROLE,
      from: TICK_FROM,
      kind: "message",
      ref: c.a.ref,
      body: conflictMessage(c, winner, loser, pw, pl, pause),
      clientKey: conflictKey(c, loser.row),
    });
    if (!created) continue;
    open.set(loser.row, [...(open.get(loser.row) ?? []), winner.row]);
    result.conflicts.push({ id: message.id, line: `${renderConflict(c)}; ${loser.ref} gives way to ${winner.ref}` });
    // The message is the record; a note that cannot be written (no such item) is a warning, never a lost second note.
    for (const side of ["a", "b"] as const) {
      try {
        await source.note(c[side], conflictNote(c, side, loser));
      } catch (e) {
        result.conflict_warnings.push(`conflicts: note on ${c[side].ref} failed: ${warnOf(e)}`);
      }
    }
  }
}

/** One team's pass, recorded on `result` as it goes, so a failure part way keeps what was written. Throws on a failure. */
async function tickTeam(
  backend: TickBackend,
  result: TickTeamResult,
  checkout: string,
  seam: () => Promise<T3Seam>,
  readContext: (threadId: string) => number | null,
): Promise<void> {
  const team = result.team;
  // The team's spinoff rows, read once for the context check and the conflict check. Both are best-effort: a
  // failure warns and never keeps the architect's other findings from being delivered.
  let source: ConflictSource | null = null;
  let rows: OverlapRow[] = [];
  try {
    source = await backend.conflicts();
    rows = await source.rows(team);
  } catch (e) {
    source = null;
    result.conflict_warnings.push(`conflicts: ${e instanceof Error ? e.message : String(e)}`);
  }
  // OS-213: builder threads past the context cap, read from this machine's T3.
  let contextFindings: TickFinding[] = [];
  try {
    contextFindings = builderContextFindings(rows, readContext, ROLE_CONTEXT_END_TOKENS);
  } catch (e) {
    result.conflict_warnings.push(`builder context: ${e instanceof Error ? e.message : String(e)}`);
  }
  // OS-259: a builder paused for a conflict is quiet by design, so it is not reported stale while it waits.
  let paused = new Set<string>();
  try {
    if (source) {
      const open = openYields(await backend.inbox.list(team, CONFLICT_ROLE, true));
      paused = new Set(rows.filter((r) => open.has(r.id)).map((r) => r.ticket_ref));
    }
  } catch (e) {
    result.conflict_warnings.push(`conflicts: ${e instanceof Error ? e.message : String(e)}`);
  }
  const findings = (await backend.findings(team)).filter((f) => !(f.kind === "stale-builder" && paused.has(f.ref)));
  for (const f of [...findings, ...contextFindings]) {
    const { message, created } = await backend.inbox.send({
      team,
      role: TICK_ROLE,
      from: TICK_FROM,
      kind: "message",
      ref: f.ref,
      body: f.body,
      clientKey: tickClientKey(team, f),
    });
    if (created) result.written.push({ id: message.id, kind: f.kind, ref: f.ref });
  }
  // The conflict check is best-effort: whatever fails in it (git, the rows, the inbox) warns and never keeps the
  // architect's findings from being delivered. Under the night lock it writes, pauses and resumes nothing (OS-259).
  try {
    if (source && !nightLockedUntil()) await tickConflicts(backend, result, source, rows, seam);
  } catch (e) {
    result.conflict_warnings.push(`conflicts: ${e instanceof Error ? e.message : String(e)}`);
  }
  result.unread = (await backend.inbox.list(team, TICK_ROLE, false)).length;
  result.sentinel_unread = (await backend.inbox.list(team, CONFLICT_ROLE, false)).length;
  result.night_lock_until = nightLockedUntil();
  if (result.unread + result.sentinel_unread === 0 || result.night_lock_until) return;
  // A run opens in the team's checkout, not the job's cwd (a timer runs from $HOME).
  const role: RoleBackend = { ...backend.role, team: { ...backend.role.team, cwdRepo: async () => checkout } };
  if (result.unread > 0) result.delivery = await deliverToRole(role, backend.inbox, seam, team, TICK_ROLE);
  // OS-48: the sentinel's unread messages (a conflict, a held handoff) are delivered as the architect's are; this
  // starts a sentinel when the team has none (OS-181).
  if (result.sentinel_unread > 0) result.sentinel_delivery = await deliverToRole(role, backend.inbox, seam, team, CONFLICT_ROLE);
}

function renderTeam(r: TickTeamResult): string[] {
  if (r.skipped) return [`skip ${r.team}: ${r.skipped}`];
  const lines = r.written.map((w) => `role tick ${r.team}: wrote #${w.id} ${w.kind} ${w.ref}`);
  for (const c of [...r.conflicts, ...r.resumed]) lines.push(`role tick ${r.team}: wrote #${c.id} ${c.line}`);
  if (r.error) return [...lines, ...r.ended.flatMap((e) => renderEndResult(r.team, e))];
  const unread = r.unread + r.sentinel_unread;
  if (unread === 0) lines.push(`role tick ${r.team}: nothing new`);
  else if (r.night_lock_until) lines.push(`role tick ${r.team}: good night until ${r.night_lock_until}; ${unread} unread kept, nothing started or sent`);
  if (r.delivery) lines.push(`role tick ${r.team} ${TICK_ROLE}: ${renderDelivery(r.delivery)}`);
  if (r.sentinel_delivery) lines.push(`role tick ${r.team} ${CONFLICT_ROLE}: ${renderDelivery(r.sentinel_delivery)}`);
  for (const e of r.ended) lines.push(...renderEndResult(r.team, e));
  return lines;
}

/** `ob role tick`: one pass over the named teams, else every team with a checkout here. A failed team exits 1. */
export async function runRoleTick(
  ctx: TickCtx,
  backend: TickBackend,
  seam: () => Promise<T3Seam>,
  endDeps: Omit<EndPassDeps, "nightLocked"> = {},
): Promise<void> {
  const named = teamNames(ctx.flags.team);
  const views = await backend.teams();
  const checkouts = await backend.checkouts();
  const results: TickTeamResult[] = [];
  for (const name of named ?? views.map((v) => v.name)) {
    const view = views.find((v) => v.name === name);
    const r: TickTeamResult = {
      team: name,
      skipped: null,
      written: [],
      conflicts: [],
      resumed: [],
      conflict_warnings: [],
      unread: 0,
      night_lock_until: null,
      delivery: null,
      sentinel_unread: 0,
      sentinel_delivery: null,
      ended: [],
      error: null,
    };
    const checkout = view ? teamCheckout(view, checkouts) : null;
    if (!view) r.error = `no team '${name}' (see \`ob t3 team list\`)`;
    else if (!checkout) r.skipped = "no checkout here";
    else {
      try {
        await tickTeam(backend, r, checkout, seam, endDeps.contextTokens ?? ((id) => contextTokens(id)));
      } catch (err) {
        r.error = oneLine(err);
      }
      // The end pass runs on every tick, whatever delivery did; the night lock is when ending runs matters most.
      try {
        const d = r.delivery;
        const justDelivered = new Set([d, r.sentinel_delivery].flatMap((x) => (x && (x.kind === "queued" || x.kind === "started") ? [x.run.id] : [])));
        r.ended = await endPass(backend.role, backend.inbox, seam, name, { ...endDeps, nightLocked: nightLockedUntil() !== null, justDelivered });
      } catch (err) {
        r.error = [r.error, `end pass: ${oneLine(err)}`].filter(Boolean).join("; ");
      }
    }
    results.push(r);
    if (ctx.mode === "human" || ctx.mode === "table") for (const line of renderTeam(r)) print(line);
    for (const w of r.conflict_warnings) warn(`role tick ${name}: ${w}`); // a git failure warns; it never fails the tick
    if (r.error) {
      warn(`role tick ${name}: ${r.error}`);
      ctx.exit = 1;
    }
    if (r.ended.some((e) => e.result === "error")) ctx.exit = 1;
    for (const d of [r.delivery, r.sentinel_delivery]) {
      if (d?.kind === "started" && d.auto_settle_warning) {
        warn(d.auto_settle_warning);
        ctx.exit = 1;
      }
    }
  }
  if (ctx.mode === "json") print(JSON.stringify(results, null, 2));
}

// `ob role tick [--team <t>[,<t>...]]` (OS-67): one pass of the 15 minute client job. For each team whose checkout is on
// this machine it writes the store's findings into the architect's inbox (see ../role-tick.ts), then delivers the
// architect's unread messages with `deliverToRole`. No unread messages after the writes is one line and no T3 call.
// Then (OS-57) it ends the team's role runs that are idle or over the context cap, each leaving its note (../role-end.ts).
//
// One procedure serves the store and the API client: each passes a `TickBackend` for the data. T3 is the caller's.
import { homedir } from "node:os";
import type { Flags } from "../ctx.ts";
import { UsageError } from "../errors.ts";
import { print, warn, type Mode } from "../output.ts";
import { deliverToRole, nightLockedUntil, renderDelivery, type DeliverOutcome } from "../role-deliver.ts";
import { endPass, renderEndResult, type EndPassDeps, type EndPassResult } from "../role-end.ts";
import { TICK_FROM, tickClientKey, type TickFinding } from "../role-tick.ts";
import { resolveRepoWith } from "../../../../platform/cli-coord/src/commands/spinoff.ts";
import { worktreeRepoOf, type T3Seam } from "../t3/dispatch.ts";
import type { TeamView } from "../team.ts";
import type { InboxBackend } from "./inbox.ts";
import type { RoleBackend } from "./role.ts";

/** The role a tick acts for. */
const TICK_ROLE = "architect" as const;

/** Where a tick's data lives: the store on this machine, or the API. */
export interface TickBackend {
  role: RoleBackend;
  inbox: InboxBackend;
  teams(): Promise<TeamView[]>;
  /** The `repo_checkouts` setting, parsed. */
  checkouts(): Promise<Record<string, string>>;
  findings(team: string): Promise<TickFinding[]>;
}

interface TickCtx {
  mode: Mode;
  flags: Flags;
  exit?: number;
}

/** What one team's pass did. */
interface TickTeamResult {
  team: string;
  skipped: string | null;
  written: Array<{ id: number; kind: string; ref: string }>;
  unread: number;
  night_lock_until: string | null;
  delivery: DeliverOutcome | null;
  /** OS-57: what the end pass did with each of the team's open role runs. */
  ended: EndPassResult[];
  error: string | null;
}

/**
 * A team's checkout on this machine: the first member project that resolves (an existing path, its `repo_checkouts`
 * entry, else `~/dev/<id>`), a worktree read as its repo. Null when none does. Pure aside from the directory tests.
 */
function teamCheckout(team: Pick<TeamView, "members">, checkouts: Record<string, string>, home: string = homedir()): string | null {
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

/** One team's pass, recorded on `result` as it goes, so a failure part way keeps what was written. Throws on a failure. */
async function tickTeam(backend: TickBackend, result: TickTeamResult, checkout: string, seam: () => Promise<T3Seam>): Promise<void> {
  const team = result.team;
  for (const f of await backend.findings(team)) {
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
  result.unread = (await backend.inbox.list(team, TICK_ROLE, false)).length;
  result.night_lock_until = nightLockedUntil();
  if (result.unread === 0 || result.night_lock_until) return;
  // A run opens in the team's checkout, not the job's cwd (a timer runs from $HOME).
  const role: RoleBackend = { ...backend.role, team: { ...backend.role.team, cwdRepo: async () => checkout } };
  result.delivery = await deliverToRole(role, backend.inbox, seam, team, TICK_ROLE);
}

function renderTeam(r: TickTeamResult): string[] {
  if (r.skipped) return [`skip ${r.team}: ${r.skipped}`];
  const lines = r.written.map((w) => `role tick ${r.team}: wrote #${w.id} ${w.kind} ${w.ref}`);
  if (r.error) return [...lines, ...r.ended.flatMap((e) => renderEndResult(r.team, e))];
  if (r.unread === 0) lines.push(`role tick ${r.team}: nothing new`);
  else if (r.night_lock_until) lines.push(`role tick ${r.team}: good night until ${r.night_lock_until}; ${r.unread} unread kept, nothing started or sent`);
  else if (r.delivery) lines.push(`role tick ${r.team} ${TICK_ROLE}: ${renderDelivery(r.delivery)}`);
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
    const r: TickTeamResult = { team: name, skipped: null, written: [], unread: 0, night_lock_until: null, delivery: null, ended: [], error: null };
    const checkout = view ? teamCheckout(view, checkouts) : null;
    if (!view) r.error = `no team '${name}' (see \`ob t3 team list\`)`;
    else if (!checkout) r.skipped = "no checkout here";
    else {
      try {
        await tickTeam(backend, r, checkout, seam);
      } catch (err) {
        r.error = oneLine(err);
      }
      // The end pass runs on every tick, whatever delivery did; the night lock is when ending runs matters most.
      try {
        const d = r.delivery;
        const justDelivered = new Set(d && (d.kind === "queued" || d.kind === "started") ? [d.run.id] : []);
        r.ended = await endPass(backend.role, backend.inbox, seam, name, { ...endDeps, nightLocked: nightLockedUntil() !== null, justDelivered });
      } catch (err) {
        r.error = [r.error, `end pass: ${oneLine(err)}`].filter(Boolean).join("; ");
      }
    }
    results.push(r);
    if (ctx.mode === "human" || ctx.mode === "table") for (const line of renderTeam(r)) print(line);
    if (r.error) {
      warn(`role tick ${name}: ${r.error}`);
      ctx.exit = 1;
    }
    if (r.ended.some((e) => e.result === "error")) ctx.exit = 1;
    if (r.delivery?.kind === "started" && r.delivery.auto_settle_warning) {
      warn(r.delivery.auto_settle_warning);
      ctx.exit = 1;
    }
  }
  if (ctx.mode === "json") print(JSON.stringify(results, null, 2));
}

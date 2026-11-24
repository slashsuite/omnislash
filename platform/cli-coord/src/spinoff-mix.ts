import type { Mode } from "../../../apps/cli/src/output.ts";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import { DEFAULT_SPINOFF_TIER, type SpinoffTier } from "../../../apps/cli/src/t3/dispatch.ts";
import { complexityOf, tierOfComplexity } from "../../../apps/cli/src/models-file.ts";
import { WORK_TAGS } from "../../../apps/cli/src/work-tags.ts";
import type { SpinoffRow } from "./commands/spinoff.ts";
import { isAbandoned } from "./spinoff-abandon.ts";
import { isSpikeEnd } from "./spinoff-spike.ts";
import { IN_FLIGHT } from "./spinoff-vocab.ts";

// `ob spinoff mix` (ob 1550): is the dispatch mix what the 50/30/20 target says, and which model's
// dispatches actually land? Read-only over the spinoff table plus the ticket's work tags. Nothing here
// is stored: a stamp the table does not carry (provider, a re-dispatch marker) is reported missing or
// derived, never invented.

export const TIER_TARGET: Readonly<Record<SpinoffTier, number>> = { simple: 50, medium: 30, complex: 20 };
const TIER_ORDER: readonly SpinoffTier[] = ["simple", "medium", "complex"];

/** The columns this report reads. A projection of `SpinoffRow`, so a renamed column fails typecheck here. */
export type MixSource = Pick<SpinoffRow, "id" | "ticket_ref" | "repo" | "status" | "error" | "request_at" | "item_id" | "tier" | "complexity" | "model">;

/** item id -> the work tags on it. */
export type MixTags = Map<string, string[]>;

export interface Outcome {
  count: number;
  landed: number;
  /**
   * DERIVED, not stamped: a later dispatch of the same repo+ticket ran at a higher tier and this one
   * did not land. A row whose own tier is unstamped is never counted here (it cannot be compared).
   */
  redispatched_higher: number;
  blocked: number;
  in_flight: number;
}

export interface TierShare extends Outcome {
  tier: SpinoffTier;
  pct: number;
  target_pct: number;
  delta_pct: number;
}

export interface ModelOutcome extends Outcome {
  /** null = no model stamped (not launched, headless, or pre-0034). */
  model: string | null;
  /** Not stamped on the row yet (awaiting the per-tier provider ticket). */
  provider: null;
}

export interface TagOutcome extends Outcome {
  /** a work tag, or null for tickets carrying none. */
  tag: string | null;
}

export interface MixReport {
  since: string | null;
  total: number;
  /** Rows `spinoff abandon` retired (1697): not a launch, not a landing, so in no count below. */
  abandoned: number;
  /** Rows that carry a tier stamp — the denominator the tier share is computed over. */
  rated: number;
  tiers: TierShare[];
  /** pre-0034 rows with no tier stamp; they launch as medium but are not counted as medium here. */
  unstamped_tier: number;
  models: ModelOutcome[];
  tags: TagOutcome[];
  notes: string[];
}

function blank(): Outcome {
  return { count: 0, landed: 0, redispatched_higher: 0, blocked: 0, in_flight: 0 };
}

/** The row's score (OS-177): its complexity, or its tier stamp's alias for a row from before the column. Null = unrated. */
function scoreOf(row: MixSource): number | null {
  if (row.complexity == null && !row.tier) return null; // pre-0034: never folded into the default
  return complexityOf(row.complexity, row.tier);
}

/** The band the row's score falls in (1-3 simple, 4-6 medium, 7-10 complex), or null for an unrated row. */
function tierOf(row: MixSource): SpinoffTier | null {
  const c = scoreOf(row);
  return c === null ? null : tierOfComplexity(c);
}

function tally(o: Outcome, status: string, redispatched: boolean): void {
  o.count++;
  if (status === "merged") o.landed++;
  else if (status === "failed") o.blocked++;
  else if (IN_FLIGHT.has(status)) o.in_flight++;
  if (redispatched) o.redispatched_higher++;
}

/** `--since` takes an ISO date or timestamp; returns the ISO string rows are compared with. */
export function parseSince(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  if (!raw.trim() || Number.isNaN(ms)) {
    throw new UsageError(`spinoff mix: --since '${raw}' is not a date (try 2026-10-01 or 2026-10-01T09:00:00Z)`);
  }
  return new Date(ms).toISOString();
}

/** Ids of the rows re-dispatched at a higher tier than they ran at, without having landed. */
export function redispatchedHigher(rows: MixSource[]): Set<number> {
  // The ticket ref is the stable dispatch identity across the row's whole life (an item link can be
  // absent on a pre-0032 row and present on its retry, so keying on it would split one ticket in two).
  // The repo is part of the key because a bare `42` is a different ticket in every repo.
  const byTicket = new Map<string, MixSource[]>();
  for (const r of rows) {
    const key = `${r.repo}\u0000${r.ticket_ref}`;
    const list = byTicket.get(key);
    if (list) list.push(r);
    else byTicket.set(key, [r]);
  }
  const out = new Set<number>();
  for (const list of byTicket.values()) {
    list.sort((a, b) => a.id - b.id);
    for (let i = 0; i < list.length; i++) {
      const row = list[i]!;
      if (row.status === "merged") continue;
      // An unstamped tier cannot be compared with anything, so it is never claimed as an escalation
      // (and a later unstamped row proves no escalation of its own) — the same reason it is not
      // folded into `medium` in the tier share.
      // OS-177: compared by score, so 4 re-dispatched at 6 is an escalation inside the medium band.
      const c = scoreOf(row);
      if (c === null) continue;
      const escalated = list.slice(i + 1).some((later) => {
        const laterC = scoreOf(later);
        return laterC !== null && laterC > c;
      });
      if (escalated) out.add(row.id);
    }
  }
  return out;
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
}

export function buildMix(everyRow: MixSource[], tags: MixTags, since: string | null): MixReport {
  // An abandoned row (1697) was never a real dispatch: the architect started it by mistake and retired it.
  // Dropped before anything else, so it cannot count as a launch, a failure, or the "earlier" half of a
  // re-dispatch (a ticket re-dispatched after an abandon was not escalated by it).
  // A closed spike (OB-1826) is the same: it committed nothing and merged nothing, so it is neither a launch nor
  // a failure of the tier that ran it.
  const excluded = (r: MixSource) => isAbandoned(r) || isSpikeEnd(r);
  const allRows = everyRow.filter((r) => !excluded(r));
  const abandoned = everyRow.filter((r) => isAbandoned(r) && (!since || r.request_at >= since)).length;
  const spikes = everyRow.filter((r) => isSpikeEnd(r) && (!since || r.request_at >= since)).length;
  // Re-dispatch is judged over the whole table: the retry that proves a row was re-dispatched can
  // sit outside the --since window while the row it replaced is inside it.
  const redispatched = redispatchedHigher(allRows);
  const rows = since ? allRows.filter((r) => r.request_at >= since) : allRows;

  const tierOutcomes = new Map<SpinoffTier, Outcome>(TIER_ORDER.map((t) => [t, blank()]));
  const modelOutcomes = new Map<string | null, Outcome>();
  const tagOutcomes = new Map<string | null, TagOutcome>();
  let unstampedTier = 0;

  for (const row of rows) {
    const tier = tierOf(row);
    const re = redispatched.has(row.id);
    if (tier) tally(tierOutcomes.get(tier)!, row.status, re);
    else unstampedTier++;

    const model = row.model ?? null;
    let m = modelOutcomes.get(model);
    if (!m) modelOutcomes.set(model, (m = blank()));
    tally(m, row.status, re);

    const own = (row.item_id ? tags.get(row.item_id) : undefined) ?? [];
    const classes = WORK_TAGS.filter((t) => own.includes(t));
    for (const cls of classes.length > 0 ? classes : [null]) {
      let t = tagOutcomes.get(cls);
      if (!t) tagOutcomes.set(cls, (t = { ...blank(), tag: cls }));
      tally(t, row.status, re);
    }
  }

  const total = rows.length;
  // The share is over the RATED rows, not every row: a pre-0034 row has no tier, and dividing by it
  // would read as "1.1% simple vs a 50% target" — a measurement of the missing stamp, not the mix.
  const rated = total - unstampedTier;
  const notes: string[] = [];
  if (unstampedTier > 0) {
    notes.push(
      `${unstampedTier} dispatch(es) carry no tier stamp (pre-0034 rows), so the tier share is over the ${rated} rated row(s). They launch as ${DEFAULT_SPINOFF_TIER} but are not counted as ${DEFAULT_SPINOFF_TIER} here.`,
    );
  }
  const unlaunched = modelOutcomes.get(null)?.count ?? 0;
  if (unlaunched > 0) {
    notes.push(`${unlaunched} dispatch(es) carry no model stamp (not launched, headless, or pre-0034 rows).`);
  }
  if (spikes > 0) {
    notes.push(`${spikes} closed spike(s) are excluded: a spike answers a question and commits nothing, so it is neither a launch nor a landing.`);
  }
  if (abandoned > 0) {
    notes.push(`${abandoned} abandoned dispatch(es) are excluded: \`spinoff abandon\` retired them, so they are neither a launch nor a landing.`);
  }
  notes.push("provider is not stamped on the spinoff row yet; the per-provider split waits on the per-tier provider ticket.");
  notes.push(
    "redispatched_higher is DERIVED, not stamped: a later dispatch of the same repo+ticket ran at a higher tier and this one did not land. A row with no tier stamp is never claimed re-dispatched, because its tier cannot be compared.",
  );

  return {
    since,
    total,
    abandoned,
    rated,
    tiers: TIER_ORDER.map((tier) => {
      const o = tierOutcomes.get(tier)!;
      const share = pct(o.count, rated);
      return { tier, ...o, pct: share, target_pct: TIER_TARGET[tier], delta_pct: Math.round((share - TIER_TARGET[tier]) * 10) / 10 };
    }),
    unstamped_tier: unstampedTier,
    models: [...modelOutcomes.entries()]
      .map(([model, o]) => ({ model, provider: null, ...o }))
      .sort((a, b) => b.count - a.count || (a.model ?? "~").localeCompare(b.model ?? "~")),
    tags: [...tagOutcomes.values()].sort((a, b) => b.count - a.count || (a.tag ?? "~").localeCompare(b.tag ?? "~")),
    notes,
  };
}

function outcomeCells(o: Outcome): string {
  return `landed ${o.landed} · re-dispatched higher ${o.redispatched_higher} · blocked ${o.blocked} · in flight ${o.in_flight}`;
}

export function renderMix(report: MixReport, mode: Mode): string {
  if (mode === "json") return JSON.stringify(report, null, 2);
  if (mode === "quiet") {
    return report.tiers.map((t) => `${t.tier} ${t.count} ${t.pct}%`).join("\n");
  }
  const lines: string[] = [];
  lines.push(`spinoff mix${report.since ? ` since ${report.since}` : ""} — ${report.total} dispatch(es)`);
  lines.push("");
  lines.push(
    `tier share of ${report.rated} rated dispatch(es) (target simple 50 / medium 30 / complex 20):`,
  );
  for (const t of report.tiers) {
    const delta = `${t.delta_pct >= 0 ? "+" : ""}${t.delta_pct}`;
    lines.push(
      `  ${t.tier.padEnd(8)} ${String(t.count).padStart(4)}  ${`${t.pct}%`.padStart(6)}  (target ${t.target_pct}%, ${delta})  ${outcomeCells(t)}`,
    );
  }
  if (report.unstamped_tier > 0) lines.push(`  ${"(no tier)".padEnd(8)} ${String(report.unstamped_tier).padStart(4)}`);
  lines.push("");
  lines.push("per model (provider: not stamped yet):");
  if (report.models.length === 0) lines.push("  (no dispatches)");
  for (const m of report.models) {
    lines.push(`  ${(m.model ?? "(no model stamp)").padEnd(28)} ${String(m.count).padStart(4)}  ${outcomeCells(m)}`);
  }
  lines.push("");
  lines.push("per work tag:");
  if (report.tags.length === 0) lines.push("  (no dispatches)");
  for (const t of report.tags) {
    lines.push(`  ${(t.tag ?? "(untagged)").padEnd(18)} ${String(t.count).padStart(4)}  ${outcomeCells(t)}`);
  }
  lines.push("");
  for (const n of report.notes) lines.push(`note: ${n}`);
  return lines.join("\n");
}

export function reportMix(allRows: MixSource[], tags: MixTags, since: string | null, mode: Mode): string {
  return renderMix(buildMix(allRows, tags, since), mode);
}

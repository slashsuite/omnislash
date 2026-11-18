// OB-1991: the model trial. While a trial is active, a dispatch at its tier runs twice: leg a on one model and
// leg b on another, the same brief word for word, neither builder told. The architect reviews the two diffs blind
// (labels X and Y, drawn at random per pair), records a score for each, and only the winner is gated and landed.
// After `target` recorded pairs the trial ends by itself, and `trial report` is the one place the labels are
// unblinded.
//
// The store half lives here: the trial and pair rows, the capacity check, the verdict, the report. The dispatch
// itself (two enqueues and two launches) stays in commands/spinoff.ts and the API client, which call these
// through `runTrialOp`, so the local CLI and `POST /spinoffs/trial` take one decision path.

import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray } from "drizzle-orm";
import { asStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { AppError, UsageError } from "../../../apps/cli/src/errors.ts";
import { nowIso } from "../../../apps/cli/src/db.ts";
import { SPINOFF_TIERS } from "../../../apps/cli/src/models-file.ts";
import { isSpinoffEffort, SPINOFF_EFFORTS } from "../../../apps/cli/src/t3/dispatch.ts";
import { normalizeRef } from "../../../apps/cli/src/refs.ts";
import { getItem } from "../../../apps/cli/src/items.ts";
import type { SpinoffRow } from "./commands/spinoff.ts";
import { doneWhenItems } from "./spinoff-check.ts";
import { ticketItemIdFor } from "./spinoff-item.ts";
import type { TokenUsage } from "./spinoff-tokens.ts";

export type TrialLeg = "a" | "b";
export type TrialLabel = "X" | "Y";

/** What leg b's branch, worktree, builder id and `ticket:` lease carry after leg a's name. */
export const LEG_B_SUFFIX = "-b";
/** One leg handed off and the other not, this long after: the pair is stale (forfeit the late leg). */
export const STALE_ONE_LEG_MS = 24 * 60 * 60 * 1000;
/** Neither leg handed off, this long after the launch: the pair is stale (void it). */
export const STALE_NO_LEG_MS = 48 * 60 * 60 * 1000;


export interface LegSpec {
  model: string;
  effort: string | null;
}

/** `provider:model[#effort]`, or a UsageError naming the shape. Pure. */
export function parseLegSpec(raw: string | undefined, flagName: string): LegSpec {
  const v = (raw ?? "").trim();
  const parts = v.split("#");
  const model = parts[0] ?? "";
  if (parts.length > 2 || !/^[^:\s#]+:[^\s#]+$/.test(model)) {
    throw new UsageError(
      `${flagName} takes <provider:model>[#effort], e.g. claudeAgent:claude-sonnet-5-5 or opencode:opencode-go/deepseek-v4.1-flash#high; got '${raw ?? ""}'`,
    );
  }
  const effort = parts[1];
  if (effort !== undefined && !isSpinoffEffort(effort)) {
    throw new UsageError(`${flagName}: effort '${effort}' is not one of ${SPINOFF_EFFORTS.join(", ")}`);
  }
  return { model, effort: effort ?? null };
}

/** List prices in USD per million tokens: input, output, cache write, cache read. */
export type LegPrice = [number, number, number, number];

/** `in,out,cw,cr` (USD per million tokens), or a UsageError naming the shape. Pure. */
export function parsePrice(raw: string | null | undefined, flagName: string): LegPrice {
  const parts = (raw ?? "").split(",").map((p) => p.trim());
  const nums = parts.map(Number);
  if (parts.length !== 4 || parts.some((p) => p === "") || nums.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new UsageError(`${flagName} takes four prices in USD per million tokens, input,output,cache-write,cache-read (e.g. 3,15,3.75,0.3); got '${raw ?? ""}'`);
  }
  return nums as LegPrice;
}

/** The stored price, or null when the trial has none. Pure. */
export function storedPrice(raw: string | null | undefined): LegPrice | null {
  if (!raw) return null;
  try {
    return parsePrice(raw, "price");
  } catch {
    return null;
  }
}

/** List-price dollars for one leg's tokens; null when either side is missing. Pure. */
export function listDollars(usage: TokenUsage | null | undefined, price: LegPrice | null): number | null {
  if (!usage || !price) return null;
  const [pin, pout, pcw, pcr] = price;
  return (usage.inputTokens * pin + usage.outputTokens * pout + usage.cacheCreationTokens * pcw + usage.cacheReadTokens * pcr) / 1_000_000;
}

/** `model#effort`, or the model alone. Pure. */
export function formatLegSpec(model: string, effort: string | null | undefined): string {
  return effort ? `${model}#${effort}` : model;
}

export interface TrialRow {
  id: number;
  name: string;
  tier: string;
  target: number;
  a_model: string;
  a_effort: string | null;
  b_model: string;
  b_effort: string | null;
  a_price: string | null;
  b_price: string | null;
  active: number | boolean;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

export interface PairRow {
  id: number;
  trial_id: number;
  ticket_ref: string;
  repo: string;
  row_a: number | null;
  row_b: number | null;
  label_a: string;
  status: string; // open | recorded | void
  seq: number | null;
  score_a: number | null;
  score_b: number | null;
  winner: string | null;
  notes: string | null;
  void_reason: string | null;
  a_handoff_at: string | null;
  b_handoff_at: string | null;
  a_sendbacks: number | null;
  b_sendbacks: number | null;
  legs: string | null;
  feedback: string | null;
  fixes: string | null;
  opened_at: string;
  recorded_at: string | null;
}

function isActive(t: TrialRow): boolean {
  return Number(t.active) === 1;
}

/** Leg b's label is whichever leg a did not draw. Pure. */
export function labelOf(pair: Pick<PairRow, "label_a">, leg: TrialLeg): TrialLabel {
  const a = pair.label_a === "Y" ? "Y" : "X";
  return leg === "a" ? a : a === "X" ? "Y" : "X";
}

/** The leg a label names in this pair. Pure. */
export function legOf(pair: Pick<PairRow, "label_a">, label: string): TrialLeg {
  const l = label.trim().toUpperCase();
  if (l !== "X" && l !== "Y") throw new UsageError(`a label is X or Y, not '${label}'`);
  return labelOf(pair, "a") === l ? "a" : "b";
}

// --- the trial row ------------------------------------------------------------

export async function activeTrial(db: Database | Store): Promise<TrialRow | null> {
  const s = asStore(db);
  const rows = (await s.q.select().from(s.t.spinoff_trial).where(eq(s.t.spinoff_trial.active, 1)).orderBy(desc(s.t.spinoff_trial.id)).limit(1)) as TrialRow[];
  return rows[0] ?? null;
}

async function latestTrial(db: Database | Store): Promise<TrialRow | null> {
  const s = asStore(db);
  const rows = (await s.q.select().from(s.t.spinoff_trial).orderBy(desc(s.t.spinoff_trial.id)).limit(1)) as TrialRow[];
  return rows[0] ?? null;
}

async function trialById(db: Database | Store, id: number): Promise<TrialRow | null> {
  const s = asStore(db);
  const rows = (await s.q.select().from(s.t.spinoff_trial).where(eq(s.t.spinoff_trial.id, id)).limit(1)) as TrialRow[];
  return rows[0] ?? null;
}

export interface StartTrialInput {
  target: number;
  a: LegSpec;
  b: LegSpec;
  tier?: string;
  name?: string;
  /** `in,out,cw,cr`, USD per million tokens. */
  aPrice?: string | null;
  bPrice?: string | null;
}

/** Start a trial. Refused while one is active. */
export async function startTrial(db: Database | Store, input: StartTrialInput): Promise<TrialRow> {
  const s = asStore(db);
  if (!Number.isInteger(input.target) || input.target < 1) throw new UsageError(`trial start --target takes a whole number of pairs, 1 or more; got ${input.target}`);
  const tier = input.tier ?? "medium";
  const aPrice = input.aPrice ? parsePrice(input.aPrice, "--a-price").join(",") : null;
  const bPrice = input.bPrice ? parsePrice(input.bPrice, "--b-price").join(",") : null;
  if (!(SPINOFF_TIERS as readonly string[]).includes(tier)) throw new UsageError(`trial start --tier is one of ${SPINOFF_TIERS.join(", ")}; got '${tier}'`);
  return s.txn("start a model trial", async (tx) => {
    const live = await activeTrial(tx);
    if (live) throw new AppError(`trial #${live.id} (${live.name}) is still active: stop it first (ob spinoff trial stop)`);
    const now = nowIso();
    const rows = (await tx.q
      .insert(tx.t.spinoff_trial)
      .values({
        name: input.name?.trim() || `trial ${now.slice(0, 10)}`,
        tier,
        target: input.target,
        a_model: input.a.model,
        a_effort: input.a.effort,
        b_model: input.b.model,
        b_effort: input.b.effort,
        a_price: aPrice,
        b_price: bPrice,
        active: 1,
        started_at: now,
      })
      .returning()) as TrialRow[];
    return rows[0]!;
  });
}

async function endTrial(db: Database | Store, id: number, reason: string): Promise<void> {
  const s = asStore(db);
  await s.q.update(s.t.spinoff_trial).set({ active: 0, ended_at: nowIso(), end_reason: reason }).where(eq(s.t.spinoff_trial.id, id));
}

/** Stop the active trial; its open pairs are voided and returned. */
export async function stopTrial(db: Database | Store): Promise<{ trial: TrialRow; voided: PairRow[] }> {
  const s = asStore(db);
  const live = await activeTrial(s);
  if (!live) throw new AppError("no model trial is active");
  const open = await pairsOf(s, live.id, ["open"]);
  for (const p of open) await voidPair(s, p.id, "trial stopped");
  await endTrial(s, live.id, "stopped");
  return { trial: (await trialById(s, live.id))!, voided: open };
}

// --- pairs --------------------------------------------------------------------

async function pairsOf(db: Database | Store, trialId: number, statuses?: string[]): Promise<PairRow[]> {
  const s = asStore(db);
  const where = statuses
    ? and(eq(s.t.spinoff_trial_pair.trial_id, trialId), inArray(s.t.spinoff_trial_pair.status, statuses))
    : eq(s.t.spinoff_trial_pair.trial_id, trialId);
  return (await s.q.select().from(s.t.spinoff_trial_pair).where(where).orderBy(s.t.spinoff_trial_pair.id)) as PairRow[];
}

export async function getPair(db: Database | Store, id: number): Promise<PairRow | null> {
  const s = asStore(db);
  const rows = (await s.q.select().from(s.t.spinoff_trial_pair).where(eq(s.t.spinoff_trial_pair.id, id)).limit(1)) as PairRow[];
  return rows[0] ?? null;
}

/** Every open pair, of any trial (a stopped trial's are voided, so in practice the active one's). */
export async function openPairs(db: Database | Store): Promise<PairRow[]> {
  const s = asStore(db);
  return (await s.q.select().from(s.t.spinoff_trial_pair).where(eq(s.t.spinoff_trial_pair.status, "open")).orderBy(s.t.spinoff_trial_pair.id)) as PairRow[];
}

/** The open pair a spinoff row is a leg of, or null. */
export async function openPairForRow(db: Database | Store, rowId: number): Promise<{ pair: PairRow; leg: TrialLeg } | null> {
  for (const p of await openPairs(db)) {
    if (p.row_a === rowId) return { pair: p, leg: "a" };
    if (p.row_b === rowId) return { pair: p, leg: "b" };
  }
  return null;
}

/** Open plus recorded: the count capacity is measured against. Void pairs do not count. Pure. */
export function pairsCounted(pairs: readonly Pick<PairRow, "status">[]): number {
  return pairs.filter((p) => p.status === "open" || p.status === "recorded").length;
}

export interface TrialPlan {
  trial: TrialRow;
  /** The model and effort each leg launches on. */
  a: LegSpec;
  b: LegSpec;
}

/**
 * Should a dispatch at `tier` be paired? Only while a trial is active, at the trial's tier, and while open
 * plus recorded pairs are below the target. Read from the store, so every architect and repo counts toward one total.
 */
export async function trialPlanFor(db: Database | Store, tier: string): Promise<TrialPlan | null> {
  const trial = await activeTrial(db);
  if (!trial || trial.tier !== tier) return null;
  if (pairsCounted(await pairsOf(db, trial.id)) >= trial.target) return null;
  return { trial, a: { model: trial.a_model, effort: trial.a_effort }, b: { model: trial.b_model, effort: trial.b_effort } };
}

/** Open a pair for a dispatch, with leg a's blind label drawn at random. Re-checks capacity. */
export async function openPair(
  db: Database | Store,
  input: { trial_id: number; ticket_ref: string; repo: string },
  rng: () => number = Math.random,
): Promise<PairRow> {
  const s = asStore(db);
  return s.txn("open a trial pair", async (tx) => {
    const trial = await trialById(tx, input.trial_id);
    if (!trial || !isActive(trial)) throw new AppError(`trial #${input.trial_id} is not active`);
    if (pairsCounted(await pairsOf(tx, trial.id)) >= trial.target) {
      throw new AppError(`trial #${trial.id} is at its target of ${trial.target} pairs: no new pair opens (dispatch with --no-trial for a single build)`);
    }
    const rows = (await tx.q
      .insert(tx.t.spinoff_trial_pair)
      .values({
        trial_id: trial.id,
        ticket_ref: input.ticket_ref,
        repo: input.repo,
        label_a: rng() < 0.5 ? "X" : "Y",
        status: "open",
        a_sendbacks: 0,
        b_sendbacks: 0,
        opened_at: nowIso(),
      })
      .returning()) as PairRow[];
    return rows[0]!;
  });
}

/** Record which spinoff rows are the pair's legs. */
export async function attachLegs(db: Database | Store, pairId: number, rows: { row_a?: number | null; row_b?: number | null }): Promise<PairRow> {
  const s = asStore(db);
  const set: Partial<PairRow> = {};
  if (rows.row_a != null) set.row_a = rows.row_a;
  if (rows.row_b != null) set.row_b = rows.row_b;
  if (Object.keys(set).length > 0) await s.q.update(s.t.spinoff_trial_pair).set(set).where(eq(s.t.spinoff_trial_pair.id, pairId));
  return (await getPair(s, pairId))!;
}

/** Void a pair: it stops counting, and nothing about its rows changes. */
export async function voidPair(db: Database | Store, pairId: number, reason: string): Promise<PairRow> {
  const s = asStore(db);
  const pair = await getPair(s, pairId);
  if (!pair) throw new AppError(`no trial pair #${pairId}`);
  if (pair.status === "recorded") throw new AppError(`trial pair #${pairId} (${pair.ticket_ref}) already has its verdict; it cannot be voided`);
  await s.q.update(s.t.spinoff_trial_pair).set({ status: "void", void_reason: reason.slice(0, 300) }).where(eq(s.t.spinoff_trial_pair.id, pairId));
  return (await getPair(s, pairId))!;
}

/** A leg handed off: its newest handoff time goes on the pair. Called by the handoff on the store's side. */
export async function noteLegHandoff(db: Database | Store, row: Pick<SpinoffRow, "id">): Promise<void> {
  const found = await openPairForRow(db, row.id);
  if (!found) return;
  const s = asStore(db);
  const set = found.leg === "a" ? { a_handoff_at: nowIso() } : { b_handoff_at: nowIso() };
  await s.q.update(s.t.spinoff_trial_pair).set(set).where(eq(s.t.spinoff_trial_pair.id, found.pair.id));
}

/** A leg was sent back: the gate did not pass first time. */
export async function noteLegSendback(db: Database | Store, row: Pick<SpinoffRow, "id">): Promise<void> {
  const found = await openPairForRow(db, row.id);
  if (!found) return;
  const s = asStore(db);
  const set =
    found.leg === "a"
      ? { a_sendbacks: Number(found.pair.a_sendbacks ?? 0) + 1, a_handoff_at: null }
      : { b_sendbacks: Number(found.pair.b_sendbacks ?? 0) + 1, b_handoff_at: null };
  await s.q.update(s.t.spinoff_trial_pair).set(set).where(eq(s.t.spinoff_trial_pair.id, found.pair.id));
}

/** The pair a ticket ref names: its open pair, else its newest. */
export async function pairForRef(db: Database | Store, ref: string): Promise<PairRow> {
  const s = asStore(db);
  const key = ref.trim();
  if (/^#\d+$/.test(key)) {
    const byId = await getPair(s, Number(key.slice(1)));
    if (byId) return byId;
  }
  const want = normalizeRef(key) ?? key.toLowerCase();
  const all = (await s.q.select().from(s.t.spinoff_trial_pair).orderBy(desc(s.t.spinoff_trial_pair.id))) as PairRow[];
  const same = all.filter((p) => (normalizeRef(p.ticket_ref) ?? p.ticket_ref.toLowerCase()) === want);
  const pick = same.find((p) => p.status === "open") ?? same[0];
  if (!pick) throw new AppError(`no trial pair for '${ref}'`);
  return pick;
}

async function spinoffRow(db: Database | Store, id: number | null): Promise<SpinoffRow | null> {
  if (id == null) return null;
  const s = asStore(db);
  const rows = (await s.q.select().from(s.t.spinoff).where(eq(s.t.spinoff.id, id)).limit(1)) as SpinoffRow[];
  return rows[0] ?? null;
}

// --- the blind view -----------------------------------------------------------

export interface BlindLeg {
  label: TrialLabel;
  row_id: number | null;
  /** For the local git diff only; `renderBlindPair` never prints it. */
  branch: string | null;
  base_sha: string | null;
  worktree: string | null;
  status: string | null;
  handed_off: boolean;
  /** For the caller's measures only (the token reader, the thread); `renderBlindPair` never prints them. */
  engine: string | null;
  model: string | null;
  thread_id: string | null;
  handoff_at: string | null;
}

export interface BlindPair {
  pair_id: number;
  ticket: string;
  status: string;
  legs: [BlindLeg, BlindLeg];
}

/** The pair as the reviewer may see it: labels, row ids and states, ordered X then Y. */
export async function blindPair(db: Database | Store, ref: string): Promise<BlindPair> {
  const pair = await pairForRef(db, ref);
  const legs: BlindLeg[] = [];
  for (const leg of ["a", "b"] as const) {
    const row = await spinoffRow(db, leg === "a" ? pair.row_a : pair.row_b);
    legs.push({
      label: labelOf(pair, leg),
      row_id: row?.id ?? null,
      branch: row?.branch ?? null,
      base_sha: row?.base_sha ?? null,
      worktree: row?.worktree ?? null,
      status: row?.status ?? null,
      handed_off: row?.status === "ready-for-gate",
      engine: row?.engine ?? null,
      model: row?.model ?? null,
      thread_id: row?.t3_thread_id ?? null,
      handoff_at: (leg === "a" ? pair.a_handoff_at : pair.b_handoff_at) ?? null,
    });
  }
  legs.sort((l, r) => l.label.localeCompare(r.label));
  return { pair_id: pair.id, ticket: pair.ticket_ref, status: pair.status, legs: [legs[0]!, legs[1]!] };
}

/** What `trial pair` prints: labels, row ids and states. Never a model, a branch or a leg letter. Pure. */
export function renderBlindPair(p: BlindPair, json: boolean, written?: string[]): string {
  const legs = p.legs.map((l) => ({ label: l.label, row: l.row_id, handed_off: l.handed_off }));
  if (json) return JSON.stringify({ pair: p.pair_id, ticket: p.ticket, status: p.status, legs, diffs: written ?? [] }, null, 2);
  const lines = [`trial pair #${p.pair_id} (${p.ticket}), ${p.status}`];
  for (const l of legs) lines.push(`  ${l.label}: spinoff #${l.row ?? "-"} ${l.handed_off ? "handed off" : "not handed off"}`);
  for (const w of written ?? []) lines.push(`  wrote ${w}`);
  return lines.join("\n");
}

// --- the verdict --------------------------------------------------------------

/** A score: 0 to 10, or `blocked` / `partial`, which score 0. Pure. */
export function parseScore(raw: string | number | undefined | null, label: string): { score: number; word: string | null } {
  if (raw === undefined || raw === null || String(raw).trim() === "") throw new UsageError(`trial record needs a score for ${label} (0 to 10, or blocked / partial)`);
  const v = String(raw).trim().toLowerCase();
  if (v === "blocked" || v === "partial") return { score: 0, word: v };
  if (!/^\d+$/.test(v) || Number(v) > 10) throw new UsageError(`trial record: ${label}'s score is 0 to 10, or blocked / partial; got '${raw}'`);
  return { score: Number(v), word: null };
}

/** The winner: the higher score, leg a on a tie. Pure. */
export function pickWinner(scoreA: number, scoreB: number): TrialLeg {
  return scoreB > scoreA ? "b" : "a";
}

/** One leg's review, from the notes file. */
export interface LegNotes {
  done: boolean[];
  defects: string[];
  notes: string;
}

/**
 * The notes file: `{X:{done:[true,false,...],defects:["..."],notes:"..."},Y:{...}}`. Each `done` list must have
 * one mark per `## Done when` item when that count is known; a file that disagrees is refused. Pure.
 */
export function parseNotesFile(raw: string, doneCount: number | null): Record<TrialLabel, LegNotes> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`trial record --notes: not JSON (${(e as Error).message})`);
  }
  const shape = 'the notes file is {"X":{"done":[true,false],"defects":["..."],"notes":"..."},"Y":{...}}';
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new UsageError(`trial record --notes: ${shape}`);
  const out = {} as Record<TrialLabel, LegNotes>;
  for (const label of ["X", "Y"] as const) {
    const v = (parsed as Record<string, unknown>)[label] as Record<string, unknown> | undefined;
    if (!v || typeof v !== "object") throw new UsageError(`trial record --notes: no entry for ${label}; ${shape}`);
    const done = v.done;
    if (!Array.isArray(done) || done.some((d) => typeof d !== "boolean")) throw new UsageError(`trial record --notes: ${label}.done is a list of true/false, one per Done when item`);
    if (doneCount !== null && done.length !== doneCount) {
      throw new UsageError(`trial record --notes: ${label}.done has ${done.length} mark(s), but the ticket's ## Done when has ${doneCount} item(s); nothing was recorded`);
    }
    const defects = v.defects ?? [];
    if (!Array.isArray(defects) || defects.some((d) => typeof d !== "string")) throw new UsageError(`trial record --notes: ${label}.defects is a list of one-line reasons`);
    const notes = v.notes ?? "";
    if (typeof notes !== "string") throw new UsageError(`trial record --notes: ${label}.notes is text`);
    out[label] = { done: done as boolean[], defects: defects as string[], notes };
  }
  return out;
}

/** What the caller measured for one leg's row before the verdict: read off the row's own sources. */
export interface LegMeasures {
  tokens: TokenUsage | null;
  /** opencode's own reported cost for the leg's sessions (an opencode leg only). */
  opencode_cost: number | null;
  /** User messages on the leg's thread after the launch message and before the handoff. */
  steers: number | null;
  /** Sum of the thread's turn durations. */
  active_ms: number | null;
  /** The PR's `gate` check passed on the first pushed head. */
  gate_first_time: boolean | null;
}

export interface RecordInput {
  ref: string;
  x?: string | number | null;
  y?: string | number | null;
  /** The notes file's CONTENTS (the CLI reads the file), so the API takes the same input. */
  notes?: string | null;
  forfeit?: string | null;
  void?: boolean;
  reason?: string | null;
  /** Measures per spinoff row id, gathered by the caller (`collectLegMeasures`). */
  measures?: Record<string, Partial<LegMeasures>> | null;
}

export interface TrialDeps {
  /** Retire a losing (or forfeited) leg's row: `failed` with this error, its builder's leases released. */
  retire(row: SpinoffRow, error: string): Promise<void>;
  /** Now, for the 24 hour lateness rule. */
  now?(): number;
}

export interface LegSnapshot {
  leg: TrialLeg;
  label: TrialLabel;
  row_id: number | null;
  model: string;
  effort: string | null;
  launched_at: string | null;
  handoff_at: string | null;
  wall_ms: number | null;
  active_ms: number | null;
  steers: number | null;
  /** Set on the winner when it lands. */
  landed_at?: string | null;
  status: string | null;
  score: number | null;
  score_word: string | null;
  sendbacks: number;
  gate_first_time: boolean | null;
  done: boolean[] | null;
  defects: string[] | null;
  review_notes: string | null;
  usage: TokenUsage | null;
  tokens: number | null;
  dollars: number | null;
  opencode_cost: number | null;
  review: string | null;
}

export interface RecordResult {
  pair: PairRow;
  trial: TrialRow;
  winner: TrialLeg | null;
  winner_label: TrialLabel | null;
  loser_row: number | null;
  /** The trial reached its target with this verdict and is now inactive. */
  ended: boolean;
  /** Legs scored 0 for being more than 24 hours late, by label. */
  late: TrialLabel[];
}

function wallMs(from: string | null | undefined, to: string | null | undefined): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The `## Done when` count of the ob item behind a ticket ref; null when there is no single item. */
export async function storeDoneWhenCount(db: Database | Store, ticket: string): Promise<number | null> {
  const id = await ticketItemIdFor(db, ticket);
  if (!id) return null;
  const item = await getItem(db, id);
  if (!item) return null;
  const n = doneWhenItems(item.body).length;
  return n > 0 ? n : null;
}

/**
 * Which legs are more than 24 hours late at record time: handed off over a day after the other, or still not
 * handed off a day after the other did. Pure.
 */
export function lateLegs(pair: Pick<PairRow, "a_handoff_at" | "b_handoff_at">, now: number): TrialLeg[] {
  const a = pair.a_handoff_at ? Date.parse(pair.a_handoff_at) : null;
  const b = pair.b_handoff_at ? Date.parse(pair.b_handoff_at) : null;
  if (a !== null && (b === null ? now - a : b - a) > STALE_ONE_LEG_MS) return ["b"];
  if (b !== null && (a === null ? now - b : a - b) > STALE_ONE_LEG_MS) return ["a"];
  return [];
}

async function snapshotLegs(
  db: Database | Store,
  pair: PairRow,
  trial: TrialRow,
  scores: { a: { score: number; word: string | null } | null; b: { score: number; word: string | null } | null },
  notes: Record<TrialLabel, LegNotes> | null,
  measures: Record<string, Partial<LegMeasures>>,
): Promise<LegSnapshot[]> {
  const out: LegSnapshot[] = [];
  for (const leg of ["a", "b"] as const) {
    const row = await spinoffRow(db, leg === "a" ? pair.row_a : pair.row_b);
    const handoff = leg === "a" ? pair.a_handoff_at : pair.b_handoff_at;
    const label = labelOf(pair, leg);
    const m = (row ? measures[String(row.id)] : undefined) ?? {};
    const sendbacks = Number((leg === "a" ? pair.a_sendbacks : pair.b_sendbacks) ?? 0);
    const sc = scores[leg];
    const n = notes?.[label] ?? null;
    const usage = m.tokens ?? null;
    out.push({
      leg,
      label,
      row_id: row?.id ?? null,
      model: leg === "a" ? trial.a_model : trial.b_model,
      effort: leg === "a" ? trial.a_effort : trial.b_effort,
      launched_at: row?.launched_at ?? null,
      handoff_at: handoff,
      wall_ms: wallMs(row?.launched_at, handoff),
      active_ms: m.active_ms ?? null,
      steers: m.steers ?? null,
      landed_at: null,
      status: row?.status ?? null,
      score: sc?.score ?? null,
      score_word: sc?.word ?? null,
      sendbacks,
      // a sendback is a failed first gate whatever the PR says; otherwise only the PR's own check answers
      gate_first_time: sendbacks > 0 ? false : (m.gate_first_time ?? null),
      done: n?.done ?? null,
      defects: n?.defects ?? null,
      review_notes: n?.notes ?? null,
      usage,
      tokens: usage && usage.totalTokens > 0 ? usage.totalTokens : null,
      dollars: usage && usage.totalTokens > 0 ? listDollars(usage, storedPrice(leg === "a" ? trial.a_price : trial.b_price)) : null,
      opencode_cost: m.opencode_cost ?? null,
      review: row?.gate_line ?? null,
    });
  }
  return out;
}

/**
 * Record a pair's verdict (or `--forfeit <label>`, or `--void`). The higher score wins and a tie goes to leg a;
 * the loser's row is retired `failed` with `abandoned: lost trial pair <n>`. A leg more than 24 hours late scores
 * 0, and so does a forfeited one (the other leg's score is optional then). The target-th verdict ends the trial.
 */
export async function recordPairVerdict(db: Database | Store, input: RecordInput, deps: TrialDeps): Promise<RecordResult> {
  const s = asStore(db);
  const pair = await pairForRef(s, input.ref);
  const trial = await trialById(s, pair.trial_id);
  if (!trial) throw new AppError(`trial pair #${pair.id} names no trial`);
  if (pair.status !== "open") throw new AppError(`trial pair #${pair.id} (${pair.ticket_ref}) is ${pair.status}, not open`);

  if (input.void) {
    const voided = await voidPair(s, pair.id, input.reason?.trim() || "voided by the architect");
    return { pair: voided, trial, winner: null, winner_label: null, loser_row: null, ended: false, late: [] };
  }

  const notes = input.notes ? parseNotesFile(input.notes, await storeDoneWhenCount(s, pair.ticket_ref)) : null;

  let scoreA: { score: number; word: string | null } | null;
  let scoreB: { score: number; word: string | null } | null;
  const forfeit = input.forfeit ? legOf(pair, input.forfeit) : null;
  const rawFor = (leg: TrialLeg) => (labelOf(pair, leg) === "X" ? input.x : input.y);
  const late = forfeit ? [] : lateLegs(pair, deps.now ? deps.now() : Date.now());
  // Scores are given on both finished diffs; a leg still building is not judged unless it is over a day late.
  if (!forfeit && late.length === 0) {
    const building = (["a", "b"] as const).filter((l) => !(l === "a" ? pair.a_handoff_at : pair.b_handoff_at)).map((l) => labelOf(pair, l));
    if (building.length > 0) {
      throw new AppError(`trial pair #${pair.id} (${pair.ticket_ref}): ${building.join(" and ")} not handed off yet. Record once both legs hand off, --forfeit a leg, or --void the pair.`);
    }
  }
  const zero = (word: string) => ({ score: 0, word });
  const scoreOf = (leg: TrialLeg) => (late.includes(leg) ? zero("late") : parseScore(rawFor(leg), labelOf(pair, leg)));
  if (forfeit) {
    const other: TrialLeg = forfeit === "a" ? "b" : "a";
    const raw = rawFor(other);
    const otherScore = raw === undefined || raw === null || String(raw).trim() === "" ? null : parseScore(raw, labelOf(pair, other));
    scoreA = forfeit === "a" ? zero("forfeit") : otherScore;
    scoreB = forfeit === "b" ? zero("forfeit") : otherScore;
  } else {
    scoreA = scoreOf("a");
    scoreB = scoreOf("b");
  }
  const winner: TrialLeg = forfeit ? (forfeit === "a" ? "b" : "a") : pickWinner(scoreA!.score, scoreB!.score);
  const loser: TrialLeg = winner === "a" ? "b" : "a";

  const recordedBefore = (await pairsOf(s, trial.id, ["recorded"])).length;
  const seq = recordedBefore + 1;
  const legs = await snapshotLegs(s, pair, trial, { a: scoreA, b: scoreB }, notes, input.measures ?? {});

  await s.q
    .update(s.t.spinoff_trial_pair)
    .set({
      status: "recorded",
      seq,
      score_a: scoreA?.score ?? null,
      score_b: scoreB?.score ?? null,
      winner,
      notes: input.notes ?? null,
      legs: JSON.stringify(legs),
      recorded_at: nowIso(),
    })
    .where(and(eq(s.t.spinoff_trial_pair.id, pair.id), eq(s.t.spinoff_trial_pair.status, "open")));

  // The loser (or the forfeited leg) is retired; a row that is already settled is left as it is.
  const loserRow = await spinoffRow(s, loser === "a" ? pair.row_a : pair.row_b);
  if (loserRow && (loserRow.status === "launched" || loserRow.status === "ready-for-gate" || loserRow.status === "pending")) {
    await deps.retire(loserRow, forfeit ? `forfeited trial pair ${seq}` : `lost trial pair ${seq}`);
  }

  const ended = seq >= trial.target;
  if (ended) await endTrial(s, trial.id, "target reached");
  return {
    pair: (await getPair(s, pair.id))!,
    trial: (await trialById(s, trial.id))!,
    winner,
    winner_label: labelOf(pair, winner),
    loser_row: loserRow?.id ?? null,
    ended,
    late: late.map((l) => labelOf(pair, l)),
  };
}

/** What `trial record` prints: the winner by LABEL and row, never by model. Pure. */
export function renderRecord(r: RecordResult, json: boolean): string {
  if (json) {
    return JSON.stringify(
      {
        pair: r.pair.id,
        ticket: r.pair.ticket_ref,
        status: r.pair.status,
        seq: r.pair.seq,
        winner: r.winner_label,
        winner_row: r.winner === "a" ? r.pair.row_a : r.winner === "b" ? r.pair.row_b : null,
        loser_row: r.loser_row,
        late: r.late,
        trial_ended: r.ended,
      },
      null,
      2,
    );
  }
  if (r.pair.status === "void") return `trial pair #${r.pair.id} (${r.pair.ticket_ref}) voided: ${r.pair.void_reason ?? ""}; it does not count`;
  const winRow = r.winner === "a" ? r.pair.row_a : r.pair.row_b;
  const lines = [`trial pair ${r.pair.seq}/${r.trial.target} (${r.pair.ticket_ref}): ${r.winner_label} wins (spinoff #${winRow ?? "-"})`];
  for (const l of r.late) lines.push(`  ${l} scored 0: more than 24 hours late`);
  lines.push(
    r.loser_row ? `  spinoff #${r.loser_row} retired: close its PR with gh pr close --delete-branch and a comment` : "  the other leg has no live row to retire",
    `  gate and land spinoff #${winRow ?? "-"} only`,
  );
  if (r.ended) lines.push(`  trial #${r.trial.id} reached its target and is no longer active: ob spinoff trial report`);
  return lines.join("\n");
}

// --- after the verdict: feedback, fixes, the winner's landing ------------------

export interface FeedbackEntry {
  leg: TrialLeg;
  label: TrialLabel;
  note: string;
  rating: number | null;
  at: string;
}

export interface FixEntry {
  note: string;
  at: string;
}

function jsonList<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** `trial feedback <ref> --label X|Y --note <text> [--rating 1-5]`: a note on one leg, kept on the pair. */
export async function recordFeedback(db: Database | Store, input: { ref: string; label: string; note: string; rating?: string | number | null }): Promise<PairRow> {
  const s = asStore(db);
  const pair = await pairForRef(s, input.ref);
  if (pair.status === "void") throw new AppError(`trial pair #${pair.id} (${pair.ticket_ref}) is void; feedback on it would count for nothing`);
  const leg = legOf(pair, input.label);
  const note = (input.note ?? "").trim();
  if (!note) throw new UsageError("trial feedback needs --note <text>");
  let rating: number | null = null;
  if (input.rating !== undefined && input.rating !== null && String(input.rating).trim() !== "") {
    rating = Number(input.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new UsageError(`trial feedback --rating is 1 to 5; got '${input.rating}'`);
  }
  const list = jsonList<FeedbackEntry>(pair.feedback);
  list.push({ leg, label: labelOf(pair, leg), note, rating, at: nowIso() });
  await s.q.update(s.t.spinoff_trial_pair).set({ feedback: JSON.stringify(list) }).where(eq(s.t.spinoff_trial_pair.id, pair.id));
  return (await getPair(s, pair.id))!;
}

/** How long after the verdict (or the winner's landing) a fix still counts against the winner. */
export const FIX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** `trial fix <ref> --note <text>`: a fix the winner needed within 7 days of landing. */
export async function recordFix(db: Database | Store, input: { ref: string; note: string }, now: number = Date.now()): Promise<PairRow> {
  const s = asStore(db);
  const pair = await pairForRef(s, input.ref);
  if (pair.status !== "recorded") throw new AppError(`trial pair #${pair.id} (${pair.ticket_ref}) is ${pair.status}: a fix counts against a recorded winner only`);
  const note = (input.note ?? "").trim();
  if (!note) throw new UsageError("trial fix needs --note <what was fixed>");
  const legs = jsonList<LegSnapshot>(pair.legs);
  const since = legs.find((l) => l.leg === pair.winner)?.landed_at ?? pair.recorded_at;
  if (since && now - Date.parse(since) > FIX_WINDOW_MS) {
    throw new AppError(`trial pair #${pair.id} (${pair.ticket_ref}): the winner landed more than 7 days ago (${since}); a fix now does not count`);
  }
  const list = jsonList<FixEntry>(pair.fixes);
  list.push({ note, at: nowIso() });
  await s.q.update(s.t.spinoff_trial_pair).set({ fixes: JSON.stringify(list) }).where(eq(s.t.spinoff_trial_pair.id, pair.id));
  return (await getPair(s, pair.id))!;
}

/** A spinoff row landed: when it is a recorded pair's winner, its landing time goes on that leg (launch to landed). */
export async function noteTrialLanded(db: Database | Store, rowId: number): Promise<void> {
  const s = asStore(db);
  const t = s.t.spinoff_trial_pair;
  const pairs = (await s.q.select().from(t).where(eq(t.status, "recorded"))) as PairRow[];
  for (const p of pairs) {
    if ((p.winner === "b" ? p.row_b : p.row_a) !== rowId) continue;
    const legs = jsonList<LegSnapshot>(p.legs).map((l) => (l.row_id === rowId ? { ...l, landed_at: nowIso() } : l));
    await s.q.update(t).set({ legs: JSON.stringify(legs) }).where(eq(t.id, p.id));
  }
}

// --- status -------------------------------------------------------------------

export interface PairStatus {
  pair: PairRow;
  stale: "forfeit" | "void" | null;
  /** The label to forfeit when one leg is late. */
  late_label: TrialLabel | null;
  handed_off: { X: boolean; Y: boolean };
}

export interface TrialStatus {
  trial: TrialRow | null;
  recorded: number;
  open: number;
  void: number;
  pairs: PairStatus[];
}

/**
 * Is an open pair stale? One leg handed off more than 24 hours before now and the other not: forfeit the late
 * leg. Neither handed off 48 hours after the launch: void it. Pure.
 */
export function pairStaleness(
  pair: Pick<PairRow, "label_a" | "a_handoff_at" | "b_handoff_at">,
  launchedAt: string | null,
  now: number,
): { stale: "forfeit" | "void" | null; late: TrialLeg | null } {
  const a = pair.a_handoff_at ? Date.parse(pair.a_handoff_at) : null;
  const b = pair.b_handoff_at ? Date.parse(pair.b_handoff_at) : null;
  if (a !== null && b === null && now - a > STALE_ONE_LEG_MS) return { stale: "forfeit", late: "b" };
  if (b !== null && a === null && now - b > STALE_ONE_LEG_MS) return { stale: "forfeit", late: "a" };
  if (a === null && b === null && launchedAt && now - Date.parse(launchedAt) > STALE_NO_LEG_MS) return { stale: "void", late: null };
  return { stale: null, late: null };
}

export async function trialStatus(db: Database | Store, now: number = Date.now()): Promise<TrialStatus> {
  const trial = (await activeTrial(db)) ?? (await latestTrial(db));
  if (!trial) return { trial: null, recorded: 0, open: 0, void: 0, pairs: [] };
  const all = await pairsOf(db, trial.id);
  const pairs: PairStatus[] = [];
  for (const p of all.filter((x) => x.status === "open")) {
    const a = await spinoffRow(db, p.row_a);
    const b = await spinoffRow(db, p.row_b);
    const launched = [a?.launched_at, b?.launched_at].filter((x): x is string => !!x).sort()[0] ?? p.opened_at;
    const st = pairStaleness(p, launched, now);
    const handedA = !!p.a_handoff_at;
    const handedB = !!p.b_handoff_at;
    pairs.push({
      pair: p,
      stale: st.stale,
      late_label: st.late ? labelOf(p, st.late) : null,
      handed_off: { [labelOf(p, "a")]: handedA, [labelOf(p, "b")]: handedB } as { X: boolean; Y: boolean },
    });
  }
  return {
    trial,
    recorded: all.filter((p) => p.status === "recorded").length,
    open: all.filter((p) => p.status === "open").length,
    void: all.filter((p) => p.status === "void").length,
    pairs,
  };
}

/** `trial status`: the counter, and each open pair by label (stale ones with the command that settles them). Pure. */
export function renderTrialStatus(st: TrialStatus, json: boolean): string {
  if (json) {
    return JSON.stringify(
      {
        trial: st.trial ? { id: st.trial.id, name: st.trial.name, tier: st.trial.tier, target: st.trial.target, active: st.trial ? isActive(st.trial) : false, started_at: st.trial.started_at, ended_at: st.trial.ended_at, end_reason: st.trial.end_reason } : null,
        recorded: st.recorded,
        open: st.open,
        void: st.void,
        pairs: st.pairs.map((p) => ({ pair: p.pair.id, ticket: p.pair.ticket_ref, repo: p.pair.repo, handed_off: p.handed_off, stale: p.stale, late: p.late_label })),
      },
      null,
      2,
    );
  }
  if (!st.trial) return "no model trial has been started";
  const t = st.trial;
  const lines = [
    `trial #${t.id} (${t.name}): ${isActive(t) ? "active" : `ended ${t.ended_at ?? ""} (${t.end_reason ?? "stopped"})`}, tier ${t.tier}`,
    `  ${st.recorded}/${t.target} recorded · ${st.open} open · ${st.void} void`,
  ];
  for (const p of st.pairs) {
    const h = `X ${p.handed_off.X ? "handed off" : "building"}, Y ${p.handed_off.Y ? "handed off" : "building"}`;
    lines.push(`  ${p.pair.ticket_ref} (pair #${p.pair.id}, ${p.pair.repo}): ${h}`);
    if (p.stale === "forfeit") lines.push(`    ⚠ stale: ${p.late_label} has not handed off 24h after the other: ob spinoff trial record ${p.pair.ticket_ref} --forfeit ${p.late_label}`);
    if (p.stale === "void") lines.push(`    ⚠ stale: neither leg handed off 48h after launch: ob spinoff trial record ${p.pair.ticket_ref} --void`);
  }
  return lines.join("\n");
}

// --- the report (the one place the labels are unblinded) ------------------------

export interface ReportLeg extends LegSnapshot {
  /** Launch to landed, the winner only, once it has landed. */
  launch_to_landed_ms: number | null;
  feedback: FeedbackEntry[];
}

export interface ReportPair {
  seq: number;
  ticket: string;
  repo: string;
  x_model: string;
  y_model: string;
  score_x: number | null;
  score_y: number | null;
  winner: TrialLabel;
  winner_model: string;
  legs: ReportLeg[];
  fixes: FixEntry[];
}

export interface ModelTotal {
  model: string;
  pairs: number;
  wins: number;
  mean_score: number | null;
  /** Done-when items met over items marked, 0 to 100; null when no notes file marked any. */
  done_pct: number | null;
  first_time_gate: number | null;
  /** Legs whose first-time gate is known; `first_time_gate` passes out of these. */
  first_time_gated: number;
  mean_defects: number | null;
  mean_wall_ms: number | null;
  mean_active_ms: number | null;
  mean_steers: number | null;
  sendbacks: number;
  fixes_7d: number;
  mean_tokens: number | null;
  mean_dollars: number | null;
  dollars_per_win: number | null;
  dollars_per_done_item: number | null;
  mean_opencode_cost: number | null;
  blocked_or_partial: number;
  feedback: string[];
}

export interface TrialReport {
  trial: TrialRow | null;
  pairs: ReportPair[];
  totals: ModelTotal[];
  void: number;
  open: number;
  /** Printed with every report: these dollars are list price times tokens, not what was billed. */
  cost_basis: string;
}

export const COST_BASIS = "dollars are list price times tokens read from each leg's transcripts: a comparison between the models, not the bill";

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function nums<T>(xs: readonly T[], pick: (x: T) => number | null | undefined): number[] {
  return xs.map(pick).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
}

/** The report over a trial's pairs. Pure. */
export function buildTrialReport(trial: TrialRow | null, pairs: readonly PairRow[]): TrialReport {
  if (!trial) return { trial: null, pairs: [], totals: [], void: 0, open: 0, cost_basis: COST_BASIS };
  const recorded = pairs.filter((p) => p.status === "recorded").sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  const out: ReportPair[] = recorded.map((p) => {
    const feedback = jsonList<FeedbackEntry>(p.feedback);
    const winnerLeg = (p.winner === "b" ? "b" : "a") as TrialLeg;
    const legs: ReportLeg[] = jsonList<LegSnapshot>(p.legs)
      .map((l) => ({
        ...l,
        launch_to_landed_ms: l.leg === winnerLeg ? wallMs(l.launched_at, l.landed_at) : null,
        feedback: feedback.filter((f) => f.leg === l.leg),
      }))
      .sort((l, r) => l.label.localeCompare(r.label));
    const modelOf = (leg: TrialLeg) => legs.find((l) => l.leg === leg)?.model ?? (leg === "a" ? trial.a_model : trial.b_model);
    const xLeg = legOf(p, "X");
    const yLeg = xLeg === "a" ? "b" : "a";
    return {
      seq: Number(p.seq),
      ticket: p.ticket_ref,
      repo: p.repo,
      x_model: modelOf(xLeg),
      y_model: modelOf(yLeg),
      score_x: xLeg === "a" ? p.score_a : p.score_b,
      score_y: yLeg === "a" ? p.score_a : p.score_b,
      winner: labelOf(p, winnerLeg),
      winner_model: modelOf(winnerLeg),
      legs,
      fixes: jsonList<FixEntry>(p.fixes),
    };
  });
  const models = [...new Set([trial.a_model, trial.b_model])];
  const totals: ModelTotal[] = models.map((model) => {
    const mine = out.flatMap((p) => p.legs.filter((l) => l.model === model));
    const won = out.filter((p) => p.winner_model === model);
    const marked = mine.filter((l) => Array.isArray(l.done));
    const items = marked.reduce((n, l) => n + l.done!.length, 0);
    const met = marked.reduce((n, l) => n + l.done!.filter(Boolean).length, 0);
    const gated = mine.filter((l) => l.gate_first_time !== null && l.gate_first_time !== undefined);
    const dollars = nums(mine, (l) => l.dollars);
    const spent = dollars.reduce((a, b) => a + b, 0);
    const spentOnMarked = nums(marked, (l) => l.dollars).reduce((a, b) => a + b, 0);
    const markedWithDollars = marked.filter((l) => typeof l.dollars === "number");
    const metWithDollars = markedWithDollars.reduce((n, l) => n + l.done!.filter(Boolean).length, 0);
    return {
      model,
      pairs: mine.length,
      wins: won.length,
      mean_score: mean(nums(mine, (l) => l.score)),
      done_pct: items > 0 ? (met / items) * 100 : null,
      first_time_gate: gated.length > 0 ? gated.filter((l) => l.gate_first_time === true).length : null,
      first_time_gated: gated.length,
      mean_defects: mean(nums(mine, (l) => (Array.isArray(l.defects) ? l.defects.length : null))),
      mean_wall_ms: mean(nums(mine, (l) => l.wall_ms)),
      mean_active_ms: mean(nums(mine, (l) => l.active_ms)),
      mean_steers: mean(nums(mine, (l) => l.steers)),
      sendbacks: mine.reduce((n, l) => n + Number(l.sendbacks ?? 0), 0),
      fixes_7d: won.reduce((n, p) => n + p.fixes.length, 0),
      mean_tokens: mean(nums(mine, (l) => l.tokens)),
      mean_dollars: mean(dollars),
      dollars_per_win: dollars.length > 0 && won.length > 0 ? spent / won.length : null,
      dollars_per_done_item: markedWithDollars.length > 0 && metWithDollars > 0 ? spentOnMarked / metWithDollars : null,
      mean_opencode_cost: mean(nums(mine, (l) => l.opencode_cost)),
      blocked_or_partial: mine.filter((l) => l.score_word === "blocked" || l.score_word === "partial").length,
      feedback: mine.flatMap((l) => l.feedback.map((f) => `${f.note}${f.rating ? ` (${f.rating}/5)` : ""}`)),
    };
  });
  return {
    trial,
    pairs: out,
    totals,
    void: pairs.filter((p) => p.status === "void").length,
    open: pairs.filter((p) => p.status === "open").length,
    cost_basis: COST_BASIS,
  };
}

export async function trialReport(db: Database | Store): Promise<TrialReport> {
  const trial = (await activeTrial(db)) ?? (await latestTrial(db));
  return buildTrialReport(trial, trial ? await pairsOf(db, trial.id) : []);
}

const NR = "not recorded";

function hours(ms: number | null | undefined): string {
  return typeof ms === "number" ? `${(ms / 3_600_000).toFixed(1)}h` : NR;
}

function fmt(n: number | null | undefined, digits = 1, unit = ""): string {
  return typeof n === "number" ? `${unit}${n.toFixed(digits)}` : NR;
}

function usd(n: number | null | undefined): string {
  return typeof n === "number" ? `$${n.toFixed(2)}` : NR;
}

function scoreText(l: Pick<LegSnapshot, "score" | "score_word">): string {
  if (l.score === null || l.score === undefined) return NR;
  return l.score_word ? `${l.score} (${l.score_word})` : String(l.score);
}

/** `trial report`: per pair, then per model. A measure that was not taken reads "not recorded", never 0. Pure. */
export function renderTrialReport(r: TrialReport, json: boolean): string {
  if (json) return JSON.stringify(r, null, 2);
  if (!r.trial) return "no model trial has been started";
  const t = r.trial;
  const lines = [
    `trial #${t.id} (${t.name}), tier ${t.tier}: ${r.pairs.length}/${t.target} recorded · ${r.open} open · ${r.void} void`,
    `  a: ${formatLegSpec(t.a_model, t.a_effort)}${t.a_price ? ` (list $/M in,out,cw,cr ${t.a_price})` : ""}`,
    `  b: ${formatLegSpec(t.b_model, t.b_effort)}${t.b_price ? ` (list $/M in,out,cw,cr ${t.b_price})` : ""}`,
    `  ${r.cost_basis}`,
    "",
    "pairs:",
  ];
  for (const p of r.pairs) {
    lines.push(`  ${p.seq}. ${p.ticket} (${p.repo}): X was ${p.x_model}, Y was ${p.y_model}; X ${p.score_x ?? NR}, Y ${p.score_y ?? NR}; winner ${p.winner} (${p.winner_model})`);
    for (const l of p.legs) {
      const done = Array.isArray(l.done) ? `${l.done.filter(Boolean).length}/${l.done.length}` : NR;
      const gate = l.gate_first_time === true ? "yes" : l.gate_first_time === false ? `no (${l.sendbacks} sendback${l.sendbacks === 1 ? "" : "s"})` : NR;
      const tok = typeof l.tokens === "number" ? `${l.tokens} tokens` : NR;
      lines.push(`     ${l.label} ${l.model}: score ${scoreText(l)}`);
      lines.push(`        time: wall ${hours(l.wall_ms)}, active ${hours(l.active_ms)}, steers ${l.steers ?? NR}${l.launch_to_landed_ms !== null ? `, launch to landed ${hours(l.launch_to_landed_ms)}` : ""}`);
      lines.push(`        accuracy: done when ${done}, gate first time ${gate}, defects ${Array.isArray(l.defects) ? l.defects.length : NR}`);
      for (const d of l.defects ?? []) lines.push(`          - ${d}`);
      lines.push(`        cost: ${tok}, ${usd(l.dollars)} list${l.opencode_cost !== null && l.opencode_cost !== undefined ? `, opencode reported $${l.opencode_cost.toFixed(2)}` : ""}`);
      if (l.review_notes) lines.push(`        notes: ${l.review_notes}`);
      for (const f of l.feedback) lines.push(`        feedback${f.rating ? ` ${f.rating}/5` : ""}: ${f.note}`);
    }
    for (const f of p.fixes) lines.push(`     fix to the winner: ${f.note}`);
  }
  if (r.pairs.length === 0) lines.push("  none recorded yet");
  lines.push("", "per model:");
  for (const m of r.totals) {
    lines.push(`  ${m.model}: ${m.wins} win${m.wins === 1 ? "" : "s"} of ${m.pairs}; mean score ${fmt(m.mean_score)}`);
    lines.push(
      `     accuracy: done when met ${m.done_pct === null ? NR : `${m.done_pct.toFixed(0)}%`}; gate first time ${m.first_time_gate === null ? NR : `${m.first_time_gate} of ${m.first_time_gated}`}; mean defects ${fmt(m.mean_defects)}; sendbacks ${m.sendbacks}; 7-day fixes ${m.fixes_7d}; blocked or partial ${m.blocked_or_partial}`,
    );
    lines.push(`     time: mean wall ${hours(m.mean_wall_ms)}; mean active ${hours(m.mean_active_ms)}; mean steers ${fmt(m.mean_steers)}`);
    lines.push(
      `     cost: mean tokens ${fmt(m.mean_tokens, 0)}; mean ${usd(m.mean_dollars)} list; ${usd(m.dollars_per_win)} per win; ${usd(m.dollars_per_done_item)} per done-when item met${m.mean_opencode_cost !== null ? `; opencode reported mean $${m.mean_opencode_cost.toFixed(2)}` : ""}`,
    );
    for (const f of m.feedback) lines.push(`     feedback: ${f}`);
  }
  return lines.join("\n");
}

// --- measures, gathered by the caller for both legs at record time ----------------

/** How the caller reads one leg's measures; each returns null when it cannot tell. */
export interface MeasureDeps {
  tokens(leg: BlindLeg): { usage: TokenUsage; cost: number | null } | null;
  thread?(leg: BlindLeg): Promise<{ steers: number | null; active_ms: number | null } | null>;
  gateFirstTime?(leg: BlindLeg): boolean | null;
}

/** A measure reader that failed: the measure reads "not recorded", and stderr says why. */
function warnMeasure(label: string, what: string, e: unknown): void {
  process.stderr.write(`ob: trial ${label}: ${what} not recorded (${e instanceof Error ? e.message : String(e)})\n`);
}

/** Both legs' measures, keyed by row id, for `RecordInput.measures`. A reader that throws records nothing for that measure. */
export async function collectLegMeasures(blind: BlindPair, deps: MeasureDeps): Promise<Record<string, Partial<LegMeasures>>> {
  const out: Record<string, Partial<LegMeasures>> = {};
  for (const leg of blind.legs) {
    if (leg.row_id === null) continue;
    const m: Partial<LegMeasures> = {};
    try {
      const t = deps.tokens(leg);
      if (t) {
        m.tokens = t.usage;
        m.opencode_cost = t.cost;
      }
    } catch (e) {
      warnMeasure(leg.label, "tokens", e);
    }
    try {
      const th = deps.thread ? await deps.thread(leg) : null;
      if (th) {
        m.steers = th.steers;
        m.active_ms = th.active_ms;
      }
    } catch (e) {
      warnMeasure(leg.label, "thread", e);
    }
    try {
      m.gate_first_time = deps.gateFirstTime ? deps.gateFirstTime(leg) : null;
    } catch (e) {
      warnMeasure(leg.label, "first-time gate", e);
    }
    out[String(leg.row_id)] = m;
  }
  return out;
}

/**
 * A thread's human messages after the launch message (its first item) and before the handoff, and its summed
 * turn time. A read with more items still to page gives no steer count, since it would undercount. Pure.
 */
export function threadMeasures(
  read: {
    items: ReadonlyArray<{ position?: number; type: string; createdBy?: string | null; updatedAt?: string | null }>;
    recentRuns: ReadonlyArray<{ startedAt?: string; completedAt?: string }>;
    hasMore?: boolean;
  },
  handoffAt: string | null,
): { steers: number | null; active_ms: number | null } {
  const cutoff = handoffAt ? Date.parse(handoffAt) : Number.POSITIVE_INFINITY;
  const after = [...read.items].sort((x, y) => (x.position ?? 0) - (y.position ?? 0)).slice(1);
  const steers = read.hasMore
    ? null
    : after.filter((i) => i.type === "user_message" && i.createdBy === "user" && (!i.updatedAt || Date.parse(i.updatedAt) <= cutoff)).length;
  const runs = read.recentRuns.map((r) => wallMs(r.startedAt, r.completedAt)).filter((x): x is number => x !== null);
  return { steers, active_ms: runs.length > 0 ? runs.reduce((a, b) => a + b, 0) : null };
}

/** `trial pair --diffs <dir>`: X.diff and Y.diff, nothing else. `diffOf` is `git diff <base>..<branch>`. */
export function writePairDiffs(blind: BlindPair, dir: string, diffOf: (leg: BlindLeg) => string, write: (path: string, text: string) => void): string[] {
  const written: string[] = [];
  for (const leg of blind.legs) {
    const path = `${dir.replace(/\/+$/, "")}/${leg.label}.diff`;
    write(path, diffOf(leg));
    written.push(path);
  }
  return written;
}

// --- one op dispatcher, for the local CLI and `POST /spinoffs/trial` --------------

export type TrialOpRequest =
  | { op: "start"; target: number; a: string; b: string; tier?: string | null; name?: string | null; a_price?: string | null; b_price?: string | null }
  | { op: "status" }
  | { op: "stop" }
  | { op: "plan"; tier: string }
  | { op: "open"; trial_id: number; ticket_ref: string; repo: string }
  | { op: "attach"; pair_id: number; row_a?: number | null; row_b?: number | null }
  | { op: "void"; pair_id: number; reason: string }
  | { op: "pair"; ref: string }
  | { op: "open-pairs" }
  | ({ op: "record" } & RecordInput)
  | { op: "feedback"; ref: string; label: string; note: string; rating?: string | number | null }
  | { op: "fix"; ref: string; note: string }
  | { op: "report" };

export type TrialOpResponse =
  | { op: "start"; trial: TrialRow }
  | { op: "status"; status: TrialStatus }
  | { op: "stop"; trial: TrialRow; voided: PairRow[] }
  | { op: "plan"; plan: TrialPlan | null }
  | { op: "open"; pair: PairRow }
  | { op: "attach"; pair: PairRow }
  | { op: "void"; pair: PairRow }
  | { op: "pair"; pair: BlindPair }
  | { op: "open-pairs"; pairs: PairRow[] }
  | { op: "record"; result: RecordResult }
  | { op: "feedback"; pair: PairRow }
  | { op: "fix"; pair: PairRow }
  | { op: "report"; report: TrialReport };

export async function runTrialOp(db: Database | Store, req: TrialOpRequest, deps: TrialDeps): Promise<TrialOpResponse> {
  switch (req.op) {
    case "start":
      return {
        op: "start",
        trial: await startTrial(db, {
          target: Number(req.target),
          a: parseLegSpec(req.a, "--a"),
          b: parseLegSpec(req.b, "--b"),
          tier: req.tier ?? undefined,
          name: req.name ?? undefined,
          aPrice: req.a_price ?? null,
          bPrice: req.b_price ?? null,
        }),
      };
    case "status":
      return { op: "status", status: await trialStatus(db) };
    case "stop":
      return { op: "stop", ...(await stopTrial(db)) };
    case "plan":
      return { op: "plan", plan: await trialPlanFor(db, req.tier) };
    case "open":
      return { op: "open", pair: await openPair(db, req) };
    case "attach":
      return { op: "attach", pair: await attachLegs(db, req.pair_id, req) };
    case "void":
      return { op: "void", pair: await voidPair(db, req.pair_id, req.reason) };
    case "pair":
      return { op: "pair", pair: await blindPair(db, req.ref) };
    case "open-pairs":
      return { op: "open-pairs", pairs: await openPairs(db) };
    case "record":
      return { op: "record", result: await recordPairVerdict(db, req, deps) };
    case "feedback":
      return { op: "feedback", pair: await recordFeedback(db, req) };
    case "fix":
      return { op: "fix", pair: await recordFix(db, req, deps.now ? deps.now() : Date.now()) };
    case "report":
      return { op: "report", report: await trialReport(db) };
    default:
      throw new UsageError(`unknown trial op '${(req as { op?: string }).op ?? ""}'`);
  }
}

/** The usage line for `ob spinoff trial`. */
export const TRIAL_USAGE =
  "spinoff trial start --target <n> --a <provider:model>[#effort] --b <provider:model>[#effort] [--tier medium] [--a-price in,out,cw,cr] [--b-price in,out,cw,cr] [--name <n>] | status | stop | " +
  "pair <ticket> [--diffs <dir>] | record <ticket> --x <0-10|blocked|partial> --y <...> [--notes <file>] | record <ticket> --forfeit <X|Y> | record <ticket> --void [--reason <why>] | " +
  "feedback <ticket> --label <X|Y> --note <text> [--rating 1-5] | fix <ticket> --note <text> | report";

/** `trial stop`'s text. Pure. */
export function renderStop(r: { trial: TrialRow; voided: PairRow[] }, json: boolean): string {
  if (json) return JSON.stringify({ trial: r.trial.id, voided: r.voided.map((p) => ({ pair: p.id, ticket: p.ticket_ref })) }, null, 2);
  const lines = [`stopped trial #${r.trial.id} (${r.trial.name})`];
  if (r.voided.length === 0) lines.push("  no open pairs");
  for (const p of r.voided) lines.push(`  voided pair #${p.id} (${p.ticket_ref}): both legs keep building as ordinary rows; land one, abandon the other`);
  return lines.join("\n");
}

/** `trial start`'s text. Pure. */
export function renderStart(t: TrialRow, json: boolean): string {
  if (json) return JSON.stringify(t, null, 2);
  return [
    `started trial #${t.id} (${t.name}): ${t.target} pairs at tier ${t.tier}`,
    `  a: ${formatLegSpec(t.a_model, t.a_effort)}`,
    `  b: ${formatLegSpec(t.b_model, t.b_effort)}`,
    `  every 'ob spinoff <ref> --tier ${t.tier}' now dispatches a pair until ${t.target} verdicts are recorded (--no-trial for one build)`,
  ].join("\n");
}

/** The legs of a pair dispatch, as the dispatch line reports them (no labels: the architect sees those at review). */
export function pairDispatchLine(pair: Pick<PairRow, "id" | "ticket_ref">, trial: Pick<TrialRow, "id" | "target">): string {
  return `trial pair #${pair.id} for ${pair.ticket_ref} (trial #${trial.id}, target ${trial.target}): two legs, same brief`;
}

// --- the paired dispatch, shared by the local enqueue and the API client ---------------

/** One leg's enqueue-and-launch, as the caller ran it. `row` is null when nothing was queued for this leg. */
export interface PairLegOutcome {
  row: { id: number } | null;
  launched: boolean;
  error?: string | null;
  /** The leg launched an earlier queued row as a single build instead: the pair is void and nothing else launches. */
  settled?: boolean;
}

/** The IO a paired dispatch performs, so the local path and the API client share one sequence. */
export interface PairDispatchDeps {
  /** The trial plan for this dispatch's tier, or null for a single build. */
  plan(): Promise<TrialPlan | null>;
  open(plan: TrialPlan): Promise<PairRow>;
  /** Enqueue and launch one leg with the same brief; the leg's own report is printed by the caller. */
  leg(leg: TrialLeg, spec: LegSpec): Promise<PairLegOutcome>;
  void(pairId: number, reason: string): Promise<void>;
  attach(pairId: number, rows: { row_a?: number | null; row_b?: number | null }): Promise<void>;
  say(line: string): void;
  warn(line: string): void;
}

export type PairDispatchOutcome =
  | { kind: "single" }
  | { kind: "paired"; pair: PairRow }
  | { kind: "void"; pair: PairRow; reason: string; single: TrialLeg | null };

/**
 * `ob spinoff <ref>` while a trial is active (OB-1991). Null plan: the caller dispatches one build. Otherwise
 * leg a launches, then leg b. A leg that does not launch voids the pair and the other leg goes on as a single
 * build (leg b still launches after a failed leg a). Every outcome is said.
 */
export async function dispatchTrialPair(deps: PairDispatchDeps): Promise<PairDispatchOutcome> {
  const plan = await deps.plan();
  if (!plan) return { kind: "single" };
  let pair: PairRow;
  try {
    pair = await deps.open(plan);
  } catch (e) {
    deps.warn(`trial #${plan.trial.id}: no pair opened (${(e as Error).message}); this is a single build`);
    return { kind: "single" };
  }
  const run = async (leg: TrialLeg, spec: LegSpec): Promise<PairLegOutcome> => {
    try {
      return await deps.leg(leg, spec);
    } catch (e) {
      return { row: null, launched: false, error: (e as Error).message };
    }
  };
  const a = await run("a", plan.a);
  if (a.row) await deps.attach(pair.id, { row_a: a.row.id });
  if (!a.launched) {
    const reason = `leg a did not launch${a.error ? `: ${a.error}` : ""}`;
    await deps.void(pair.id, reason);
    if (a.settled) {
      deps.warn(`trial pair #${pair.id} void: ${reason}. No second leg was launched`);
      return { kind: "void", pair, reason, single: null };
    }
    // the pair is void, so the other leg is no longer a trial leg: it goes on as the single build
    const b = await run("b", plan.b);
    if (b.row) await deps.attach(pair.id, { row_b: b.row.id });
    if (!b.launched) {
      deps.warn(`trial pair #${pair.id} void: ${reason}. Leg b did not launch either${b.error ? ` (${b.error})` : ""}; nothing is building`);
      return { kind: "void", pair, reason, single: null };
    }
    deps.warn(`trial pair #${pair.id} void: ${reason}. Leg b goes on as a single build`);
    return { kind: "void", pair, reason, single: "b" };
  }
  const b = await run("b", plan.b);
  if (b.row) await deps.attach(pair.id, { row_b: b.row.id });
  if (!b.launched) {
    const reason = `leg b did not launch${b.error ? `: ${b.error}` : ""}`;
    await deps.void(pair.id, reason);
    deps.warn(`trial pair #${pair.id} void: ${reason}. Leg a goes on as a single build`);
    return { kind: "void", pair, reason, single: "a" };
  }
  deps.say(pairDispatchLine(pair, plan.trial));
  return { kind: "paired", pair };
}

/** Leg b's branch and explicit worktree: the leg's own, so the two legs never share a checkout. */
export function legBranch(branch: string, leg: TrialLeg): string {
  return leg === "b" ? `${branch}${LEG_B_SUFFIX}` : branch;
}

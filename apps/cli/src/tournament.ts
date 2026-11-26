// OB-2271: `ob tournament`, the record of persona tournaments (rules from OB-2038).
//
// A tournament compares candidates (a theme, a ground, a design) for one subject in one repo. A runner (OB-2273, or
// a repo's own script) holds each match: every reader call is a persona on a model, shown the two sides in one
// order, scoring each side 1 to 5 per criterion with a reason, and favouring one side. The runner writes the match
// as a JSON file and `ob tournament record` stores it. ob validates the shape and stores it; it never decides a
// winner. The file's `winner` is the runner's call, and the choice between the finalists is the owner's `pick`.
//
// The match file contract (what `validateMatchFile` accepts):
//   {
//     "name": "SF-1",                         unique in the tournament; --replace overwrites it in place
//     "round": "SF",                          free text (R1, SF, Rev2, Final, Rematch): the runner names its own
//     "x": "t8", "y": "t5",                   the two candidates
//     "winner": "t8",                         x or y
//     "tally": { "t8": 4.5, "t5": 0.5 },      optional, stored as given
//     "calls": [{
//       "persona": "thandi", "model": "sonnet", "fallback": false,
//       "order": 1,                            1 = a was shown first, 2 = b was shown first
//       "a": "t8", "b": "t5",                  x and y, in either order
//       "winner": "A",                         optional; A or B, and it must agree with winnerId
//       "winnerId": "t8",                      a or b
//       "why": "...", "changes": { "t5": "the change asked" },
//       "scores": { "<criterion>": { "a": 1..5, "b": 1..5, "why": "<reason>" } }
//     }]
//   }
// Every criterion the tournament declares is scored on every call, and no other. A top-level `scores` (the old
// per-candidate tally) is refused with a line saying to rename it `tally`, so it is never read as criterion scores.
import { and, asc, eq, inArray } from "drizzle-orm";
import { nowIso } from "./db.ts";
import type { Store } from "./db/store.ts";
import { AppError, UsageError } from "./errors.ts";

export interface Tournament {
  id: number;
  subject: string;
  repo: string;
  ref: string | null;
  criteria: string[];
  status: "open" | "picked";
  picked: string | null;
  picked_note: string | null;
  picked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TournamentCandidate {
  key: string;
  label: string | null;
  /** Paths relative to the repo. */
  images: string[];
  revises: string | null;
}

export interface CriterionScore {
  a: number;
  b: number;
  why: string;
}

export interface TournamentCall {
  persona: string;
  model: string | null;
  fallback: boolean | null;
  order: 1 | 2;
  a: string;
  b: string;
  winner_key: string;
  why: string | null;
  changes: Record<string, string> | null;
  scores: Record<string, CriterionScore>;
}

export interface TournamentMatch {
  name: string;
  round: string;
  x: string;
  y: string;
  winner: string;
  tally: Record<string, number> | null;
  recorded_at: string;
  calls: TournamentCall[];
}

export interface TournamentFinalists {
  /** The round they came from: the last Rematch, else the last Final. */
  round: string;
  match: string;
  x: string;
  y: string;
}

export interface TournamentView extends Tournament {
  candidates: TournamentCandidate[];
  /** In the order recorded; a `--replace` keeps the replaced match's place. */
  matches: TournamentMatch[];
  finalists: TournamentFinalists | null;
}

export interface TournamentListRow extends Tournament {
  candidates: number;
  matches: number;
}

/** A match file as validated, ready to store. */
interface MatchInput {
  name: string;
  round: string;
  x: string;
  y: string;
  winner: string;
  tally: Record<string, number> | null;
  calls: TournamentCall[];
}

// --- parsing (pure) -------------------------------------------------------------------------------------------

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

export function parseTournamentId(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) throw new UsageError(`a tournament id is a positive integer${raw ? ` (got '${raw}')` : ""}`);
  return n;
}

function parseRepoSlug(raw: string | undefined): string {
  const v = raw?.trim();
  if (!v) throw new UsageError("--repo <slug> is required");
  if (!SLUG.test(v)) throw new UsageError(`--repo must be a lowercase slug (got '${raw}')`);
  return v;
}

function parseCriteria(raw: string | readonly string[] | undefined): string[] {
  const parts = (typeof raw === "string" ? raw.split(",") : (raw ?? [])).map((c) => c.trim()).filter((c) => c.length > 0);
  if (parts.length === 0) throw new UsageError("--criteria <a,b,...> needs at least one criterion");
  const seen = new Set<string>();
  for (const c of parts) {
    if (seen.has(c)) throw new UsageError(`criterion '${c}' is named twice`);
    seen.add(c);
  }
  return parts;
}

function parseCandidateKey(raw: string | undefined, what = "a candidate key"): string {
  const v = raw?.trim();
  if (!v) throw new UsageError(`${what} is required`);
  if (/\s/.test(v)) throw new UsageError(`${what} has no spaces (got '${raw}')`);
  return v;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") throw new UsageError(`${where}: '${key}' must be a non-empty string`);
  return v.trim();
}

function optStr(o: Record<string, unknown>, key: string, where: string): string | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new UsageError(`${where}: '${key}' must be a string`);
  return v;
}

/**
 * Validate a match file against the tournament's criteria. Pure: every refusal is a UsageError naming the match,
 * the call (by its 1-based position and persona) and the field, so a runner can fix its file from the line alone.
 */
export function validateMatchFile(raw: unknown, criteria: readonly string[]): MatchInput {
  if (!isObject(raw)) throw new UsageError("the match file must hold a JSON object");
  if ("scores" in raw) {
    throw new UsageError("the match file has a top-level 'scores': rename it 'tally' (per-candidate totals); criterion scores go on each call");
  }
  const name = str(raw, "name", "match");
  const at = `match '${name}'`;
  const round = str(raw, "round", at);
  const x = parseCandidateKey(str(raw, "x", at), `${at}: 'x'`);
  const y = parseCandidateKey(str(raw, "y", at), `${at}: 'y'`);
  if (x === y) throw new UsageError(`${at}: x and y are both '${x}'`);
  const winner = str(raw, "winner", at);
  if (winner !== x && winner !== y) throw new UsageError(`${at}: winner '${winner}' is neither x ('${x}') nor y ('${y}')`);

  let tally: Record<string, number> | null = null;
  if (raw.tally !== undefined && raw.tally !== null) {
    if (!isObject(raw.tally)) throw new UsageError(`${at}: 'tally' must be an object of candidate to number`);
    tally = {};
    for (const [k, v] of Object.entries(raw.tally)) {
      if (typeof v !== "number" || !Number.isFinite(v)) throw new UsageError(`${at}: tally for '${k}' must be a number`);
      tally[k] = v;
    }
  }

  if (!Array.isArray(raw.calls) || raw.calls.length === 0) throw new UsageError(`${at}: 'calls' must be a non-empty array`);
  const calls = raw.calls.map((c, i): TournamentCall => {
    if (!isObject(c)) throw new UsageError(`${at} call ${i + 1}: must be an object`);
    const persona = str(c, "persona", `${at} call ${i + 1}`);
    const where = `${at} call ${i + 1} (${persona})`;
    const model = optStr(c, "model", where);
    let fallback: boolean | null = null;
    if (c.fallback !== undefined && c.fallback !== null) {
      if (typeof c.fallback !== "boolean") throw new UsageError(`${where}: 'fallback' must be true or false`);
      fallback = c.fallback;
    }
    if (c.order !== 1 && c.order !== 2) throw new UsageError(`${where}: 'order' must be 1 or 2 (got ${JSON.stringify(c.order)})`);
    const a = str(c, "a", where);
    const b = str(c, "b", where);
    if (!((a === x && b === y) || (a === y && b === x))) {
      throw new UsageError(`${where}: a and b ('${a}', '${b}') must be the match's x and y ('${x}', '${y}')`);
    }
    const winnerId = str(c, "winnerId", where);
    if (winnerId !== a && winnerId !== b) throw new UsageError(`${where}: winnerId '${winnerId}' is neither a ('${a}') nor b ('${b}')`);
    if (c.winner !== undefined && c.winner !== null) {
      if (c.winner !== "A" && c.winner !== "B") throw new UsageError(`${where}: 'winner' must be "A" or "B"`);
      if ((c.winner === "A" ? a : b) !== winnerId) throw new UsageError(`${where}: winner '${c.winner}' disagrees with winnerId '${winnerId}'`);
    }
    const why = optStr(c, "why", where);
    let changes: Record<string, string> | null = null;
    if (c.changes !== undefined && c.changes !== null) {
      if (!isObject(c.changes)) throw new UsageError(`${where}: 'changes' must be an object of candidate to text`);
      changes = {};
      for (const [k, v] of Object.entries(c.changes)) {
        if (typeof v !== "string") throw new UsageError(`${where}: the change asked of '${k}' must be text`);
        changes[k] = v;
      }
    }
    if (!isObject(c.scores)) throw new UsageError(`${where}: 'scores' is missing; every call scores ${criteria.join(", ")}`);
    const scores: Record<string, CriterionScore> = {};
    for (const k of Object.keys(c.scores)) {
      if (!criteria.includes(k)) throw new UsageError(`${where}: '${k}' is not a criterion of this tournament (${criteria.join(", ")})`);
    }
    for (const crit of criteria) {
      const s = c.scores[crit];
      if (!isObject(s)) throw new UsageError(`${where}: criterion '${crit}' is not scored`);
      for (const side of ["a", "b"] as const) {
        const v = s[side];
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) {
          throw new UsageError(`${where}: '${crit}' score for ${side} must be an integer 1 to 5 (got ${JSON.stringify(v)})`);
        }
      }
      if (typeof s.why !== "string" || s.why.trim() === "") throw new UsageError(`${where}: '${crit}' has no reason ('why')`);
      scores[crit] = { a: s.a as number, b: s.b as number, why: s.why.trim() };
    }
    return { persona, model, fallback, order: c.order, a, b, winner_key: winnerId, why, changes, scores };
  });
  return { name, round, x, y, winner, tally, calls };
}

/** The finalists: the last recorded match whose round is Rematch, else Final (case-insensitive). Pure. */
export function finalistsOf(matches: readonly TournamentMatch[]): TournamentFinalists | null {
  for (const round of ["rematch", "final"]) {
    const m = [...matches].reverse().find((mm) => mm.round.trim().toLowerCase() === round);
    if (m) return { round: m.round, match: m.name, x: m.x, y: m.y };
  }
  return null;
}

// --- the store --------------------------------------------------------------------------------------------------

type TournamentRow = Omit<Tournament, "criteria" | "status"> & { criteria: string; status: string };

function toTournament(r: TournamentRow): Tournament {
  return { ...r, criteria: JSON.parse(r.criteria) as string[], status: r.status === "picked" ? "picked" : "open" };
}

async function loadTournament(s: Store, id: number): Promise<Tournament> {
  const t = s.t.tournament;
  const rows = (await s.q.select().from(t).where(eq(t.id, id)).limit(1)) as TournamentRow[];
  if (!rows[0]) throw new AppError(`no tournament ${id}`);
  return toTournament(rows[0]);
}

async function candidateKeys(s: Store, id: number): Promise<Set<string>> {
  const c = s.t.tournamentCandidate;
  const rows = (await s.q.select({ key: c.key }).from(c).where(eq(c.tournament_id, id))) as Array<{ key: string }>;
  return new Set(rows.map((r) => r.key));
}

export async function addTournament(
  s: Store,
  input: { subject: string; repo: string; criteria: string | readonly string[]; ref?: string | null | undefined },
): Promise<Tournament> {
  const subject = input.subject?.trim();
  if (!subject) throw new UsageError("--subject <text> is required");
  const repo = parseRepoSlug(input.repo);
  const criteria = parseCriteria(input.criteria);
  const now = nowIso();
  const rows = (await s.q
    .insert(s.t.tournament)
    .values({ subject, repo, ref: input.ref?.trim() || null, criteria: JSON.stringify(criteria), status: "open", created_at: now, updated_at: now })
    .returning()) as TournamentRow[];
  return toTournament(rows[0]!);
}

export interface CandidateInput {
  key: string;
  label?: string | null | undefined;
  images?: readonly string[] | null | undefined;
  revises?: string | null | undefined;
}

/** Register a candidate, or update the fields given on one already registered. */
export async function setCandidate(s: Store, id: number, input: CandidateInput): Promise<TournamentCandidate> {
  const key = parseCandidateKey(input.key);
  await loadTournament(s, id);
  const revises = input.revises == null ? null : parseCandidateKey(input.revises, "--revises");
  if (revises !== null) {
    if (revises === key) throw new UsageError(`candidate '${key}' cannot revise itself`);
    if (!(await candidateKeys(s, id)).has(revises)) throw new AppError(`tournament ${id} has no candidate '${revises}' to revise`);
  }
  const c = s.t.tournamentCandidate;
  return s.txn("set the tournament candidate", async (tx) => {
    const existing = (await tx.q.select().from(c).where(and(eq(c.tournament_id, id), eq(c.key, key))).limit(1)) as Array<{ id: number; label: string | null; images: string; revises: string | null }>;
    const label = input.label === undefined || input.label === null ? (existing[0]?.label ?? null) : input.label.trim() || null;
    const images = input.images && input.images.length > 0 ? [...input.images] : existing[0] ? (JSON.parse(existing[0].images) as string[]) : [];
    const rev = revises ?? existing[0]?.revises ?? null;
    if (existing[0]) {
      await tx.q.update(c).set({ label, images: JSON.stringify(images), revises: rev }).where(eq(c.id, existing[0].id));
    } else {
      await tx.q.insert(c).values({ tournament_id: id, key, label, images: JSON.stringify(images), revises: rev, created_at: nowIso() });
    }
    await tx.q.update(tx.t.tournament).set({ updated_at: nowIso() }).where(eq(tx.t.tournament.id, id));
    return { key, label, images, revises: rev };
  });
}

/**
 * Store a match file. A match name already recorded is refused unless `replace`, which overwrites it and keeps
 * its place in the recorded order. Candidates the file names and the tournament has not registered are created
 * with no label.
 */
export async function recordMatch(s: Store, id: number, raw: unknown, opts: { replace?: boolean } = {}): Promise<TournamentMatch> {
  const tour = await loadTournament(s, id);
  const m = validateMatchFile(raw, tour.criteria);
  const tm = s.t.tournamentMatch;
  const tc = s.t.tournamentCall;
  const cand = s.t.tournamentCandidate;
  return s.txn("record the tournament match", async (tx) => {
    const existing = (await tx.q.select().from(tm).where(and(eq(tm.tournament_id, id), eq(tm.name, m.name))).limit(1)) as Array<{ id: number; position: number }>;
    if (existing[0] && !opts.replace) {
      throw new AppError(`tournament ${id} already has match '${m.name}'; pass --replace to overwrite it`);
    }
    const known = await candidateKeys(tx, id);
    const now = nowIso();
    for (const key of [m.x, m.y]) {
      if (!known.has(key)) await tx.q.insert(cand).values({ tournament_id: id, key, label: null, images: "[]", revises: null, created_at: now });
    }
    let matchId: number;
    const values = { name: m.name, round: m.round, x: m.x, y: m.y, winner: m.winner, tally: m.tally ? JSON.stringify(m.tally) : null, recorded_at: now };
    if (existing[0]) {
      matchId = existing[0].id;
      await tx.q.delete(tc).where(eq(tc.match_id, matchId));
      await tx.q.update(tm).set(values).where(eq(tm.id, matchId));
    } else {
      const positions = (await tx.q.select({ p: tm.position }).from(tm).where(eq(tm.tournament_id, id))) as Array<{ p: number }>;
      const position = positions.reduce((mx, r) => Math.max(mx, r.p), 0) + 1;
      const rows = (await tx.q.insert(tm).values({ tournament_id: id, position, ...values }).returning({ id: tm.id })) as Array<{ id: number }>;
      matchId = rows[0]!.id;
    }
    for (const c of m.calls) {
      await tx.q.insert(tc).values({
        match_id: matchId,
        persona: c.persona,
        model: c.model,
        fallback: c.fallback === null ? null : c.fallback ? 1 : 0,
        order_n: c.order,
        a: c.a,
        b: c.b,
        winner_key: c.winner_key,
        why: c.why,
        changes: c.changes ? JSON.stringify(c.changes) : null,
        scores: JSON.stringify(c.scores),
      });
    }
    await tx.q.update(tx.t.tournament).set({ updated_at: now }).where(eq(tx.t.tournament.id, id));
    return { ...m, recorded_at: now };
  });
}

/** The owner's pick: a registered candidate; the tournament reads `picked` from then on. */
export async function pickTournament(s: Store, id: number, candidate: string, note?: string | null): Promise<Tournament> {
  const key = parseCandidateKey(candidate, "the picked candidate");
  await loadTournament(s, id);
  if (!(await candidateKeys(s, id)).has(key)) throw new AppError(`tournament ${id} has no candidate '${key}'`);
  const now = nowIso();
  const t = s.t.tournament;
  const rows = (await s.q
    .update(t)
    .set({ status: "picked", picked: key, picked_note: note?.trim() || null, picked_at: now, updated_at: now })
    .where(eq(t.id, id))
    .returning()) as TournamentRow[];
  return toTournament(rows[0]!);
}

export async function listTournaments(s: Store, opts: { repo?: string | undefined } = {}): Promise<TournamentListRow[]> {
  const t = s.t.tournament;
  const repo = opts.repo === undefined ? undefined : parseRepoSlug(opts.repo);
  const rows = (await (repo ? s.q.select().from(t).where(eq(t.repo, repo)) : s.q.select().from(t)).orderBy(asc(t.id))) as TournamentRow[];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const cands = (await s.q.select({ id: s.t.tournamentCandidate.tournament_id }).from(s.t.tournamentCandidate).where(inArray(s.t.tournamentCandidate.tournament_id, ids))) as Array<{ id: number }>;
  const matches = (await s.q.select({ id: s.t.tournamentMatch.tournament_id }).from(s.t.tournamentMatch).where(inArray(s.t.tournamentMatch.tournament_id, ids))) as Array<{ id: number }>;
  const count = (list: Array<{ id: number }>, id: number) => list.filter((r) => r.id === id).length;
  return rows.map((r) => ({ ...toTournament(r), candidates: count(cands, r.id), matches: count(matches, r.id) }));
}

export async function showTournament(s: Store, id: number): Promise<TournamentView> {
  const tour = await loadTournament(s, id);
  const cand = s.t.tournamentCandidate;
  const tm = s.t.tournamentMatch;
  const tc = s.t.tournamentCall;
  const cRows = (await s.q.select().from(cand).where(eq(cand.tournament_id, id)).orderBy(asc(cand.id))) as Array<{ key: string; label: string | null; images: string; revises: string | null }>;
  const mRows = (await s.q.select().from(tm).where(eq(tm.tournament_id, id)).orderBy(asc(tm.position), asc(tm.id))) as Array<{
    id: number;
    name: string;
    round: string;
    x: string;
    y: string;
    winner: string;
    tally: string | null;
    recorded_at: string;
  }>;
  const callRows = mRows.length
    ? ((await s.q.select().from(tc).where(inArray(tc.match_id, mRows.map((m) => m.id))).orderBy(asc(tc.id))) as Array<{
        match_id: number;
        persona: string;
        model: string | null;
        fallback: number | null;
        order_n: number;
        a: string;
        b: string;
        winner_key: string;
        why: string | null;
        changes: string | null;
        scores: string;
      }>)
    : [];
  const matches: TournamentMatch[] = mRows.map((m) => ({
    name: m.name,
    round: m.round,
    x: m.x,
    y: m.y,
    winner: m.winner,
    tally: m.tally ? (JSON.parse(m.tally) as Record<string, number>) : null,
    recorded_at: m.recorded_at,
    calls: callRows
      .filter((c) => c.match_id === m.id)
      .map((c) => ({
        persona: c.persona,
        model: c.model,
        fallback: c.fallback === null ? null : c.fallback === 1,
        order: c.order_n === 2 ? 2 : 1,
        a: c.a,
        b: c.b,
        winner_key: c.winner_key,
        why: c.why,
        changes: c.changes ? (JSON.parse(c.changes) as Record<string, string>) : null,
        scores: JSON.parse(c.scores) as Record<string, CriterionScore>,
      })),
  }));
  return {
    ...tour,
    candidates: cRows.map((c) => ({ key: c.key, label: c.label, images: JSON.parse(c.images) as string[], revises: c.revises })),
    matches,
    finalists: finalistsOf(matches),
  };
}

// --- rendering (pure) -------------------------------------------------------------------------------------------

function renderTournamentRow(t: Tournament): string {
  const pick = t.status === "picked" ? `picked ${t.picked}` : "open";
  return `${t.id}\t${t.repo}\t${pick}\t${t.subject}${t.ref ? ` (${t.ref})` : ""}`;
}

export function renderTournamentList(rows: readonly TournamentListRow[]): string {
  return rows.map((r) => `${renderTournamentRow(r)}\t${r.candidates} candidates, ${r.matches} matches`).join("\n");
}

export function renderTournamentShow(v: TournamentView): string {
  const lines = [
    `tournament ${v.id}: ${v.subject}`,
    `repo: ${v.repo}${v.ref ? `   ref: ${v.ref}` : ""}   status: ${v.status}`,
    `criteria: ${v.criteria.join(", ")}`,
    "",
    `candidates (${v.candidates.length}):`,
    ...v.candidates.map(
      (c) => `  ${c.key}${c.label ? `  ${c.label}` : ""}${c.revises ? `  (revises ${c.revises})` : ""}${c.images.length ? `  ${c.images.join(", ")}` : ""}`,
    ),
    "",
    `matches (${v.matches.length}, in recorded order):`,
    ...v.matches.map((m) => `  ${m.round}\t${m.name}\t${m.x} v ${m.y}\twinner ${m.winner}\t${m.calls.length} calls`),
    "",
    `finalists: ${v.finalists ? `${v.finalists.x} v ${v.finalists.y} (from ${v.finalists.round} '${v.finalists.match}')` : "none yet (no Final or Rematch recorded)"}`,
    `pick: ${v.picked ? `${v.picked}${v.picked_at ? ` on ${v.picked_at.slice(0, 10)}` : ""}${v.picked_note ? ` (${v.picked_note})` : ""}` : "not yet"}`,
  ];
  return lines.join("\n");
}

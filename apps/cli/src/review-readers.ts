// OB-2173: which skeptical-review readers run, on which model, per complexity range (OS-175; per tier before).
//
// One setting, `review_readers`, in the SERVER's config table (since OS-145 also a models profile's `review`), so
// the dashboard, every machine's `ob review readers` and every builder's review read the same value. Its shape:
//
//   {"readers": {"<leg>": {"model": "<id>"}}, "tiers": [{"from": 1, "to": 3, "legs": ["<leg>"]}, ...]}
//
// `tiers` is a list of complexity ranges covering 1 to 10 with no gap and no overlap (the same check as the
// builder ranges of OS-177). The old `{"simple": [...], "medium": [...], "complex": [...]}` form still loads, as
// the ranges 1-3, 4-6 and 7-10, and is written back as the list.
//
// Unset means opus alone on every score, with neon a reader on no range that stands in only when Opus is
// unavailable (OS-238; neon and opus both read every score before). A reader may sit in no range (kept but off).
// This module is PURE (no store, no ob imports beyond models-file's table) so review-leg.ts, a standalone bun
// script, and the dashboard can both import it cheaply. Reads and writes go through a `ConfigIO` the caller
// supplies: the store locally and on the dashboard, the API client in API mode.

import {
  COMPLEXITY_MAX,
  COMPLEXITY_MIN,
  DEFAULT_REVIEW_LEGS,
  DEFAULT_REVIEW_MODELS,
  TIER_BANDS,
  TIER_COMPLEXITY,
  isComplexity,
  isSpinoffTier,
  rangeCoverError,
  rangeText,
  retiredReviewMessage,
  warnRetiredReview,
  type ComplexityRange,
  type SpinoffTier,
} from "./models-file.ts";

export const REVIEW_READERS_KEY = "review_readers";

/** The old tier names, cheapest first: still read in the old object form and by the `tier` alias verbs. */
export const REVIEW_TIERS = ["simple", "medium", "complex"] as const satisfies readonly SpinoffTier[];

/** One complexity range and the readers a row scored inside it runs, in order. */
export interface ReviewRange extends ComplexityRange {
  legs: string[];
}

export interface ReviewReaders {
  /** Each reader's model, and the reader that stands in for it when it is unavailable (none when absent). */
  readers: Record<string, { model: string; fallback?: string }>;
  /** The ranges, sorted, covering 1-10 exactly once. */
  tiers: ReviewRange[];
}

/** A leg name: lowercase letters, digits and dashes. */
export const LEG_NAME = /^[a-z0-9-]+$/;

/** The fallback an unset setting gives opus: neon stands in when Opus is unavailable (OS-206). Configurable per reader. */
export const DEFAULT_REVIEW_FALLBACKS: Record<string, string> = { opus: "neon" };

/**
 * The value an unset setting stands for: opus alone on every score (as the three old tier bands), and neon kept as
 * a reader on no range, so it runs only as opus's fallback (OS-238).
 */
export function defaultReviewReaders(): ReviewReaders {
  const legs = [...DEFAULT_REVIEW_LEGS];
  const readerLegs = Object.keys(DEFAULT_REVIEW_MODELS) as (keyof typeof DEFAULT_REVIEW_MODELS)[];
  return {
    readers: Object.fromEntries(
      readerLegs.map((leg) => [leg, { model: DEFAULT_REVIEW_MODELS[leg], ...(DEFAULT_REVIEW_FALLBACKS[leg] ? { fallback: DEFAULT_REVIEW_FALLBACKS[leg] } : {}) }]),
    ),
    tiers: REVIEW_TIERS.map((t) => ({ ...TIER_BANDS[t], legs: [...legs] })),
  };
}

/** The setting is malformed or would leave a range without a reader. The message names what is wrong. */
export class ReviewReadersError extends Error {}

/** `4-6` or `5` as a range inside 1-10, or null. Pure. */
export function parseReviewRange(text: string): ComplexityRange | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : Number(m[2]);
  return isComplexity(from) && isComplexity(to) && from <= to ? { from, to } : null;
}

function checkModel(leg: string, model: unknown): string {
  if (typeof model !== "string" || !model.trim()) throw new ReviewReadersError(`reader '${leg}' needs a model id`);
  const m = model.trim();
  if (/\s/.test(m)) throw new ReviewReadersError(`reader '${leg}': model '${m}' has a space in it`);
  return m;
}

/** A fallback names another reader (not the reader itself); whether that reader exists is checked with the set. */
function checkFallback(leg: string, fallback: unknown): string {
  if (typeof fallback !== "string" || !LEG_NAME.test(fallback)) throw new ReviewReadersError(`reader '${leg}': fallback must be a reader name`);
  if (fallback === leg) throw new ReviewReadersError(`reader '${leg}' cannot fall back to itself`);
  return fallback;
}

/** The old `{simple, medium, complex}` object as the ranges 1-3, 4-6 and 7-10 (a missing tier is an empty range). */
function rangesOfTierObject(tiersIn: Record<string, unknown>): unknown[] {
  for (const t of Object.keys(tiersIn)) if (!isSpinoffTier(t)) throw new ReviewReadersError(`unknown tier '${t}' (use ${REVIEW_TIERS.join(", ")}, or a list of {from, to, legs} ranges)`);
  return REVIEW_TIERS.map((t) => {
    const list = tiersIn[t];
    if (list !== undefined && !Array.isArray(list)) throw new ReviewReadersError(`tier '${t}' must be a list of reader names`);
    return { ...TIER_BANDS[t], legs: list ?? [] };
  });
}

/**
 * Check a parsed value and return it normalised (ranges sorted). The ranges cover 1-10 with no gap and no overlap,
 * every range lists at least one reader, and every reader a range lists exists. Throws ReviewReadersError naming the
 * fault and the range.
 */
export function validateReviewReaders(v: unknown): ReviewReaders {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ReviewReadersError("review_readers must be a JSON object with readers and tiers");
  const raw = v as { readers?: unknown; tiers?: unknown };
  if (!raw.readers || typeof raw.readers !== "object" || Array.isArray(raw.readers)) throw new ReviewReadersError("review_readers.readers must be an object of leg to {model}");
  if (!raw.tiers || typeof raw.tiers !== "object") throw new ReviewReadersError("review_readers.tiers must be a list of {from, to, legs} ranges covering 1-10");
  const readers: ReviewReaders["readers"] = {};
  const dropped = new Set<string>();
  for (const [leg, spec] of Object.entries(raw.readers as Record<string, unknown>)) {
    if (!LEG_NAME.test(leg)) throw new ReviewReadersError(`reader name '${leg}' must be lowercase letters, digits and dashes`);
    const model = spec && typeof spec === "object" ? (spec as { model?: unknown }).model : undefined;
    const refused = retiredReviewMessage(leg, typeof model === "string" ? model : undefined);
    if (refused) {
      // OS-206: a retired reader is dropped with a warning, never refused; its legs come out of every range below.
      warnRetiredReview("review_readers", refused);
      dropped.add(leg);
      continue;
    }
    const fallback = spec && typeof spec === "object" ? (spec as { fallback?: unknown }).fallback : undefined;
    readers[leg] = { model: checkModel(leg, model), ...(fallback === undefined || fallback === null ? {} : { fallback: checkFallback(leg, fallback) }) };
  }
  for (const [leg, spec] of Object.entries(readers)) {
    if (spec.fallback !== undefined && readers[spec.fallback] === undefined) {
      throw new ReviewReadersError(`reader '${leg}' falls back to '${spec.fallback}', which is not a reader`);
    }
  }
  const entries = Array.isArray(raw.tiers) ? raw.tiers : rangesOfTierObject(raw.tiers as Record<string, unknown>);
  const tiers: ReviewRange[] = entries.map((e) => {
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new ReviewReadersError("each review range must be {from, to, legs}");
    const { from, to, legs: list } = e as { from?: unknown; to?: unknown; legs?: unknown };
    if (!isComplexity(from) || !isComplexity(to) || from > to) {
      throw new ReviewReadersError(`review range ${String(from)}-${String(to)} must be whole numbers ${COMPLEXITY_MIN} to ${COMPLEXITY_MAX}, from no higher than to`);
    }
    const name = rangeText({ from, to });
    if (!Array.isArray(list)) throw new ReviewReadersError(`review range ${name} must list its readers in legs`);
    const legs = [...new Set(list as unknown[])].map(String).filter((l) => !dropped.has(l));
    if (legs.length === 0) throw new ReviewReadersError(`review range ${name} has no readers: every range needs at least one`);
    const missing = legs.filter((l) => readers[l] === undefined);
    if (missing.length) throw new ReviewReadersError(`review range ${name} names ${missing.map((m) => `'${m}'`).join(", ")}, which ${missing.length === 1 ? "is not a reader" : "are not readers"}`);
    return { from, to, legs };
  });
  const cover = rangeCoverError(tiers, "review ranges");
  if (cover) throw new ReviewReadersError(cover);
  return { readers, tiers: tiers.sort((a, b) => a.from - b.from) };
}

/** The stored text, parsed and checked. Empty or null is the default set. Throws ReviewReadersError. */
export function parseReviewReaders(raw: string | null | undefined): ReviewReaders {
  if (raw === null || raw === undefined || raw.trim() === "") return defaultReviewReaders();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReviewReadersError("review_readers is not valid JSON");
  }
  return validateReviewReaders(parsed);
}

/**
 * The form a value is stored in. Ranges that are exactly the old bands (1-3, 4-6, 7-10) are written as the old
 * `{simple, medium, complex}` object, so an `ob`, API server or dashboard that predates OS-175 still reads the
 * setting during the alias release; any other split is written as the list, which only OS-175 and later read.
 */
export function storedReviewReaders(v: ReviewReaders): { readers: ReviewReaders["readers"]; tiers: ReviewRange[] | Record<SpinoffTier, string[]> } {
  const bands = REVIEW_TIERS.map((t) => v.tiers.find((r) => r.from === TIER_BANDS[t].from && r.to === TIER_BANDS[t].to));
  if (v.tiers.length !== REVIEW_TIERS.length || bands.some((r) => r === undefined)) return { readers: v.readers, tiers: v.tiers };
  return { readers: v.readers, tiers: Object.fromEntries(REVIEW_TIERS.map((t, i) => [t, bands[i]!.legs])) as Record<SpinoffTier, string[]> };
}

export function serializeReviewReaders(v: ReviewReaders): string {
  return JSON.stringify(storedReviewReaders(validateReviewReaders(v)));
}

/** The range covering score `c`. Throws when none does (a validated value always has one). */
export function reviewRangeAt(v: ReviewReaders, c: number): ReviewRange {
  const range = v.tiers.find((r) => r.from <= c && c <= r.to);
  if (!range) throw new ReviewReadersError(`no review range covers complexity ${c}`);
  return range;
}

/** The readers a row scored `c` runs, with their models, in the range's order. The run-time lookup (OS-175). */
export function readersForComplexity(v: ReviewReaders, c: number): Array<{ leg: string; model: string; fallback: string | null }> {
  return reviewRangeAt(v, c).legs.map((leg) => ({ leg, model: v.readers[leg]!.model, fallback: fallbackOf(v, leg) }));
}

/** Add a reader or change its model (its fallback stays). A new reader joins no range. */
export function withReader(v: ReviewReaders, leg: string, model: string): ReviewReaders {
  if (!LEG_NAME.test(leg)) throw new ReviewReadersError(`reader name '${leg}' must be lowercase letters, digits and dashes`);
  const fallback = v.readers[leg]?.fallback;
  return validateReviewReaders({ ...v, readers: { ...v.readers, [leg]: { model: checkModel(leg, model), ...(fallback ? { fallback } : {}) } } });
}

/** Set or clear (null) the reader that stands in for `leg` when it is unavailable. Throws ReviewReadersError. */
export function withFallback(v: ReviewReaders, leg: string, fallback: string | null): ReviewReaders {
  if (v.readers[leg] === undefined) throw new ReviewReadersError(`no reader named '${leg}'`);
  const { fallback: _old, ...rest } = v.readers[leg]!;
  const next = fallback === null ? rest : { ...rest, fallback: checkFallback(leg, fallback) };
  return validateReviewReaders({ ...v, readers: { ...v.readers, [leg]: next } });
}

/** The reader that stands in for `leg`, or null when none is set. Pure. */
export function fallbackOf(v: ReviewReaders, leg: string): string | null {
  return v.readers[leg]?.fallback ?? null;
}

/** Remove a reader and take it off every range; refused, naming the range, when a range would be left with none. */
export function withoutReader(v: ReviewReaders, leg: string): ReviewReaders {
  if (v.readers[leg] === undefined) throw new ReviewReadersError(`no reader named '${leg}'`);
  const readers = Object.fromEntries(
    Object.entries(v.readers)
      .filter(([l]) => l !== leg)
      .map(([l, r]) => [l, r.fallback === leg ? { model: r.model } : r]),
  );
  const tiers = v.tiers.map((r) => ({ ...r, legs: r.legs.filter((l) => l !== leg) }));
  const emptied = tiers.filter((r) => r.legs.length === 0).map(rangeText);
  if (emptied.length) throw new ReviewReadersError(`'${leg}' is the only reader on range ${emptied.join(", ")}: add another reader to that range first`);
  return validateReviewReaders({ readers, tiers });
}

/**
 * `legs` on `range`: the range is carved out of the ranges it overlaps (what is left of each keeps its legs), so
 * `4-6` on a 1-10 setting gives 1-3, 4-6 and 7-10. Throws ReviewReadersError.
 */
export function withRange(v: ReviewReaders, range: ComplexityRange, legs: string[]): ReviewReaders {
  const tiers: ReviewRange[] = [];
  for (const r of v.tiers) {
    if (r.to < range.from || r.from > range.to) tiers.push(r);
    else {
      if (r.from < range.from) tiers.push({ ...r, to: range.from - 1 });
      if (r.to > range.to) tiers.push({ ...r, from: range.to + 1 });
    }
  }
  tiers.push({ ...range, legs });
  return validateReviewReaders({ ...v, tiers });
}

/** How the setting is read and written: the store locally, the API client in API mode. */
export interface ConfigIO {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** The setting, and whether it is stored (false = the defaults stand in for an unset row). */
export async function loadReviewReaders(io: ConfigIO): Promise<{ stored: boolean; value: ReviewReaders }> {
  const raw = await io.get(REVIEW_READERS_KEY);
  const stored = raw !== null && raw.trim() !== "";
  return { stored, value: parseReviewReaders(raw) };
}

export async function saveReviewReaders(io: ConfigIO, v: ReviewReaders): Promise<ReviewReaders> {
  const clean = validateReviewReaders(v);
  await io.set(REVIEW_READERS_KEY, serializeReviewReaders(clean));
  return clean;
}

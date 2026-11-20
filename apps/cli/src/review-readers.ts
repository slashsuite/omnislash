// OB-2173: which skeptical-review readers run, on which model, per task tier.
//
// One setting, `review_readers`, in the SERVER's config table, so the dashboard's Reviewers page, every
// machine's `ob review readers` and every builder's review read the same value. Its shape:
//
//   {"readers": {"<leg>": {"model": "<id>"}}, "tiers": {"simple": ["<leg>"], "medium": [...], "complex": [...]}}
//
// Unset means the default two legs: neon and opus on every tier. A reader may sit in no tier (kept
// but off). This module is PURE (no store, no ob imports beyond models-file's table) so review-leg.ts, a
// standalone bun script, and the dashboard can both import it cheaply. Reads and writes go through a
// `ConfigIO` the caller supplies: the store locally and on the dashboard, the API client in API mode.

import { DEFAULT_REVIEW_LEGS, DEFAULT_REVIEW_MODELS, type SpinoffTier } from "./models-file.ts";

export const REVIEW_READERS_KEY = "review_readers";

/** The tiers a reader set is chosen for: the builder tiers (1480), cheapest first. */
export const REVIEW_TIERS = ["simple", "medium", "complex"] as const satisfies readonly SpinoffTier[];
export type ReviewTier = (typeof REVIEW_TIERS)[number];

/** The tier a row with no tier is reviewed as. */
export const DEFAULT_REVIEW_TIER: ReviewTier = "medium";

export interface ReviewReaders {
  readers: Record<string, { model: string }>;
  tiers: Record<ReviewTier, string[]>;
}

/** A leg name: lowercase letters, digits and dashes. */
export const LEG_NAME = /^[a-z0-9-]+$/;

/** The value an unset setting stands for: neon and opus, on every tier. */
export function defaultReviewReaders(): ReviewReaders {
  const legs = [...DEFAULT_REVIEW_LEGS];
  return {
    readers: Object.fromEntries(legs.map((leg) => [leg, { model: DEFAULT_REVIEW_MODELS[leg] }])),
    tiers: { simple: [...legs], medium: [...legs], complex: [...legs] },
  };
}

/** The setting is malformed or would leave a tier without a reader. The message names what is wrong. */
export class ReviewReadersError extends Error {}

export function isReviewTier(v: string): v is ReviewTier {
  return (REVIEW_TIERS as readonly string[]).includes(v);
}

function checkModel(leg: string, model: unknown): string {
  if (typeof model !== "string" || !model.trim()) throw new ReviewReadersError(`reader '${leg}' needs a model id`);
  const m = model.trim();
  if (/\s/.test(m)) throw new ReviewReadersError(`reader '${leg}': model '${m}' has a space in it`);
  return m;
}

/**
 * Check a parsed value and return it normalised. Every tier must list at least one reader, and every reader
 * a tier lists must exist. Throws ReviewReadersError naming the fault.
 */
export function validateReviewReaders(v: unknown): ReviewReaders {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ReviewReadersError("review_readers must be a JSON object with readers and tiers");
  const raw = v as { readers?: unknown; tiers?: unknown };
  if (!raw.readers || typeof raw.readers !== "object" || Array.isArray(raw.readers)) throw new ReviewReadersError("review_readers.readers must be an object of leg to {model}");
  if (!raw.tiers || typeof raw.tiers !== "object" || Array.isArray(raw.tiers)) throw new ReviewReadersError("review_readers.tiers must be an object of tier to a list of legs");
  const readers: ReviewReaders["readers"] = {};
  for (const [leg, spec] of Object.entries(raw.readers as Record<string, unknown>)) {
    if (!LEG_NAME.test(leg)) throw new ReviewReadersError(`reader name '${leg}' must be lowercase letters, digits and dashes`);
    const model = spec && typeof spec === "object" ? (spec as { model?: unknown }).model : undefined;
    readers[leg] = { model: checkModel(leg, model) };
  }
  const tiersIn = raw.tiers as Record<string, unknown>;
  for (const t of Object.keys(tiersIn)) if (!isReviewTier(t)) throw new ReviewReadersError(`unknown tier '${t}' (use ${REVIEW_TIERS.join(", ")})`);
  const tiers = {} as ReviewReaders["tiers"];
  for (const t of REVIEW_TIERS) {
    const list = tiersIn[t];
    if (list !== undefined && !Array.isArray(list)) throw new ReviewReadersError(`tier '${t}' must be a list of reader names`);
    const legs = [...new Set((list ?? []) as unknown[])].map(String);
    if (legs.length === 0) throw new ReviewReadersError(`tier '${t}' has no readers: every tier needs at least one`);
    const missing = legs.filter((l) => readers[l] === undefined);
    if (missing.length) throw new ReviewReadersError(`tier '${t}' names ${missing.map((m) => `'${m}'`).join(", ")}, which ${missing.length === 1 ? "is not a reader" : "are not readers"}`);
    tiers[t] = legs;
  }
  return { readers, tiers };
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

export function serializeReviewReaders(v: ReviewReaders): string {
  return JSON.stringify(validateReviewReaders(v));
}

/** The readers a tier runs, with their models, in the tier's order. */
export function readersForTier(v: ReviewReaders, tier: ReviewTier): Array<{ leg: string; model: string }> {
  return v.tiers[tier].map((leg) => ({ leg, model: v.readers[leg]!.model }));
}

/** Add a reader or change its model. A new reader joins no tier. */
export function withReader(v: ReviewReaders, leg: string, model: string): ReviewReaders {
  if (!LEG_NAME.test(leg)) throw new ReviewReadersError(`reader name '${leg}' must be lowercase letters, digits and dashes`);
  return validateReviewReaders({ ...v, readers: { ...v.readers, [leg]: { model: checkModel(leg, model) } } });
}

/** Remove a reader and take it off every tier; refused when a tier would be left with none. */
export function withoutReader(v: ReviewReaders, leg: string): ReviewReaders {
  if (v.readers[leg] === undefined) throw new ReviewReadersError(`no reader named '${leg}'`);
  const readers = Object.fromEntries(Object.entries(v.readers).filter(([l]) => l !== leg));
  const tiers = Object.fromEntries(REVIEW_TIERS.map((t) => [t, v.tiers[t].filter((l) => l !== leg)])) as ReviewReaders["tiers"];
  const emptied = REVIEW_TIERS.filter((t) => tiers[t].length === 0);
  if (emptied.length) throw new ReviewReadersError(`'${leg}' is the only reader on ${emptied.join(", ")}: add another reader to that tier first`);
  return validateReviewReaders({ readers, tiers });
}

/** Replace one tier's reader list. */
export function withTier(v: ReviewReaders, tier: ReviewTier, legs: string[]): ReviewReaders {
  return validateReviewReaders({ ...v, tiers: { ...v.tiers, [tier]: legs } });
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
  await io.set(REVIEW_READERS_KEY, JSON.stringify(clean));
  return clean;
}

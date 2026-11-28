import type { Ctx } from "../ctx.ts";
import type { Flags } from "../ctx.ts";
import { editModelRoutes, loadRouteInputs, storeConfigIo } from "../model-routes-io.ts";
import { ModelRoutesError, resolveReview, serverReview, setReaderFallback, withProfileReview, writeProfile } from "../model-routes.ts";
import { AppError, UsageError } from "../errors.ts";
import { print, type Mode } from "../output.ts";
import { cmdReviewRun } from "../review-run.ts";
import { TIER_BANDS, TIER_COMPLEXITY, isSpinoffTier, parseComplexity, rangeText, type SpinoffTier } from "../models-file.ts";
import {
  REVIEW_TIERS,
  ReviewReadersError,
  parseReviewRange,
  readersForComplexity,
  reviewRangeAt,
  withRange,
  withReader,
  withoutReader,
  type ConfigIO,
  type ReviewReaders,
} from "../review-readers.ts";

// -----------------------------------------------------------------------------
// `ob review readers` (OB-2173): which skeptical-review readers run, on which model, per complexity range (OS-175;
// per tier before). Since OS-145 the value is the active models profile's `review` in `model_routes` (the old
// `review_readers` setting is read only as its default; `ob models reader` writes the same value). The same
// code runs locally (the store) and in API mode (the API client), through a ConfigIO.
//
// The run-time lookup (OS-175): a builder's skeptical review runs the legs `ob review readers --complexity <n> -q`
// prints for its row's score (ob-spinoff, ob-skeptical-review); `--tier <t>` is the old spelling, read as the
// tier's score (simple 2, medium 5, complex 8). Nothing else picks legs per row: review-leg.ts only takes each
// leg's model from the same setting.
// -----------------------------------------------------------------------------

const USAGE =
  "review run <ticket> [--complexity <1-10>] [--answers <file>] [--json] | review readers [--complexity <1-10>] [--json|-q] | review readers set <leg> --model <id> | review readers rm <leg> | review readers range <from-to> <leg>... | review readers fallback <leg> <other-leg|none> (`--tier` and `tier <tier>` are the old spellings)";

function table(v: ReviewReaders, stored: boolean): string {
  const legs = Object.keys(v.readers);
  const ranges = v.tiers.map(rangeText);
  const w = Math.max(6, ...legs.map((l) => l.length));
  const mw = Math.max(5, ...legs.map((l) => v.readers[l]!.model.length));
  // A column is at least as wide as "on", so a one-score range ("4") keeps the columns after it in line.
  const cw = ranges.map((r) => Math.max(2, r.length));
  const fw = Math.max(8, ...legs.map((l) => (v.readers[l]!.fallback ?? "-").length));
  const head = `${"reader".padEnd(w)}  ${"model".padEnd(mw)}  ${"fallback".padEnd(fw)}  ${ranges.map((r, i) => r.padEnd(cw[i]!)).join("  ")}`.trimEnd();
  const rows = legs.map(
    (l) =>
      `${l.padEnd(w)}  ${v.readers[l]!.model.padEnd(mw)}  ${(v.readers[l]!.fallback ?? "-").padEnd(fw)}  ${v.tiers.map((r, i) => (r.legs.includes(l) ? "on" : "-").padEnd(cw[i]!)).join("  ")}`.trimEnd(),
  );
  const note = stored ? [] : ["(no profile sets review readers: these are the defaults)"];
  return [head, ...rows, ...note].join("\n");
}

function tierOf(raw: string | undefined, what: string): SpinoffTier {
  if (!raw || !isSpinoffTier(raw)) throw new UsageError(`${what} must be one of ${REVIEW_TIERS.join(", ")}${raw ? `, not '${raw}'` : ""}`);
  return raw;
}

/** The score a read asks for: `--complexity`, else the old `--tier`'s score, else null (the whole table). */
function scoreOf(flags: Flags): number | null {
  if (flags.complexity !== undefined && flags.tier !== undefined) throw new UsageError("give --complexity or --tier, not both (--tier is the old spelling of a score)");
  if (flags.complexity !== undefined) {
    const c = parseComplexity(String(flags.complexity));
    if (c === null) throw new UsageError(`--complexity must be a whole number 1 to 10, not '${String(flags.complexity)}'`);
    return c;
  }
  if (flags.tier !== undefined) return TIER_COMPLEXITY[tierOf(flags.tier, "--tier")];
  return null;
}

/** The whole `ob review` command over any ConfigIO. Exported for the API-mode handler and tests. */
export async function runReview(args: string[], flags: Flags, mode: Mode, io: ConfigIO): Promise<void> {
  // OS-210: `review run <ticket>` drives the review itself (gate, round 1, escalation); see review-run.ts.
  if (args[0] === "run") return cmdReviewRun(args, flags, mode, io);
  if (args[0] !== "readers") throw new UsageError(`usage: ob ${USAGE}`);
  const sub = args[1];
  try {
    if (sub === undefined) {
      // OS-145: the active models profile's readers (`model_routes`), the local file's legs laid over them.
      const { stored, value, profile } = resolveReview(await loadRouteInputs(io));
      const c = scoreOf(flags);
      if (c !== null) {
        const range = rangeText(reviewRangeAt(value, c));
        const list = readersForComplexity(value, c);
        if (mode === "json") print(JSON.stringify({ complexity: c, range, stored, profile, readers: list }, null, 2));
        else if (mode === "quiet") print(list.map((r) => r.leg).join("\n"));
        else print(list.map((r) => `${r.leg} ${r.model}`).join("\n"));
        return;
      }
      // `profile` is the active models profile: review-leg.ts records a reader's credit hit against it (OS-299).
      if (mode === "json") print(JSON.stringify({ stored, profile, ...value }, null, 2));
      else if (mode === "quiet") print(Object.keys(value.readers).join("\n"));
      else print(table(value, stored));
      return;
    }
    // Writes land on the active profile's `review` in `model_routes` (OS-145), never on `review_readers`.
    const write = async (change: (v: ReviewReaders) => ReviewReaders): Promise<ReviewReaders> => {
      const { next, inputs } = await editModelRoutes(io, (inputs) => {
        const profile = writeProfile(inputs);
        return withProfileReview(inputs.server, profile, change(serverReview(inputs, profile).value));
      });
      return next.profiles[writeProfile(inputs)]!.review!;
    };
    if (sub === "set") {
      const leg = args[2];
      if (!leg || !flags.model) throw new UsageError("review readers set requires <leg> --model <id>");
      const model = flags.model;
      const next = await write((v) => withReader(v, leg, model));
      print(mode === "json" ? JSON.stringify(next, null, 2) : `${leg} ${next.readers[leg]!.model}`);
      return;
    }
    if (sub === "fallback") {
      // The reader that stands in for <leg> when it is unavailable (OS-206); `none` clears it.
      const leg = args[2];
      const other = args[3];
      if (!leg || !other) throw new UsageError("review readers fallback requires <leg> <other-leg|none>");
      const fallback = other === "none" ? null : other;
      const next = await write((v) => setReaderFallback(v, leg, fallback));
      print(mode === "json" ? JSON.stringify(next, null, 2) : `${leg} falls back to ${next.readers[leg]!.fallback ?? "nothing"}`);
      return;
    }
    if (sub === "rm") {
      const leg = args[2];
      if (!leg) throw new UsageError("review readers rm requires <leg>");
      const next = await write((v) => withoutReader(v, leg));
      print(mode === "json" ? JSON.stringify(next, null, 2) : `removed ${leg}`);
      return;
    }
    if (sub === "range" || sub === "tier") {
      // `tier <tier>` is the old spelling of its band's range (simple 1-3, medium 4-6, complex 7-10), kept for one release.
      const range = sub === "tier" ? TIER_BANDS[tierOf(args[2], "review readers tier <tier>")] : parseReviewRange(args[2] ?? "");
      if (!range) throw new UsageError(`review readers range <from-to> must be a range inside 1-10 such as 4-6${args[2] ? `, not '${args[2]}'` : ""}`);
      const legs = args.slice(3);
      if (legs.length === 0) throw new UsageError(`review readers ${sub} requires <${sub === "tier" ? "tier" : "from-to"}> <leg>... (at least one reader)`);
      const next = await write((v) => withRange(v, range, legs));
      const now = next.tiers.find((r) => r.from === range.from && r.to === range.to)!;
      print(mode === "json" ? JSON.stringify(next, null, 2) : `${rangeText(now)}: ${now.legs.join(" ")}`);
      return;
    }
  } catch (e) {
    if (e instanceof ReviewReadersError || e instanceof ModelRoutesError) throw new AppError(e.message);
    throw e;
  }
  throw new UsageError(`unknown review readers subcommand '${sub}' (set|rm|range|fallback)`);
}

export async function cmdReview(ctx: Ctx): Promise<void> {
  const store = ctx.store ?? ctx.db;
  await runReview(ctx.args, ctx.flags, ctx.mode, storeConfigIo(store));
}

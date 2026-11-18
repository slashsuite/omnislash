import type { Ctx } from "../ctx.ts";
import type { Flags } from "../ctx.ts";
import { getConfig, setConfig } from "../config.ts";
import { AppError, UsageError } from "../errors.ts";
import { print, type Mode } from "../output.ts";
import {
  REVIEW_TIERS,
  ReviewReadersError,
  isReviewTier,
  loadReviewReaders,
  readersForTier,
  saveReviewReaders,
  withReader,
  withTier,
  withoutReader,
  type ConfigIO,
  type ReviewReaders,
} from "../review-readers.ts";

// -----------------------------------------------------------------------------
// `ob review readers` (OB-2173): which skeptical-review readers run, on which model, per task tier. The
// value is the server's `review_readers` setting, the one the dashboard's Reviewers page edits. The same
// code runs locally (the store) and in API mode (the API client), through a ConfigIO.
// -----------------------------------------------------------------------------

const USAGE =
  "review readers [--tier simple|medium|complex] [--json|-q] | review readers set <leg> --model <id> | review readers rm <leg> | review readers tier <tier> <leg>...";

function table(v: ReviewReaders, stored: boolean): string {
  const legs = Object.keys(v.readers);
  const w = Math.max(6, ...legs.map((l) => l.length));
  const mw = Math.max(5, ...legs.map((l) => v.readers[l]!.model.length));
  const head = `${"reader".padEnd(w)}  ${"model".padEnd(mw)}  ${REVIEW_TIERS.join("  ")}`;
  const rows = legs.map(
    (l) =>
      `${l.padEnd(w)}  ${v.readers[l]!.model.padEnd(mw)}  ${REVIEW_TIERS.map((t) => (v.tiers[t].includes(l) ? "on" : "-").padEnd(t.length)).join("  ")}`.trimEnd(),
  );
  const note = stored ? [] : ["(review_readers is unset: these are the defaults)"];
  return [head, ...rows, ...note].join("\n");
}

function tierOf(raw: string | undefined, what: string): (typeof REVIEW_TIERS)[number] {
  if (!raw || !isReviewTier(raw)) throw new UsageError(`${what} must be one of ${REVIEW_TIERS.join(", ")}${raw ? `, not '${raw}'` : ""}`);
  return raw;
}

/** The whole `ob review` command over any ConfigIO. Exported for the API-mode handler and tests. */
export async function runReview(args: string[], flags: Flags, mode: Mode, io: ConfigIO): Promise<void> {
  if (args[0] !== "readers") throw new UsageError(`usage: ob ${USAGE}`);
  const sub = args[1];
  try {
    if (sub === undefined) {
      const { stored, value } = await loadReviewReaders(io);
      if (flags.tier !== undefined) {
        const tier = tierOf(flags.tier, "--tier");
        const list = readersForTier(value, tier);
        if (mode === "json") print(JSON.stringify({ tier, stored, readers: list }, null, 2));
        else if (mode === "quiet") print(list.map((r) => r.leg).join("\n"));
        else print(list.map((r) => `${r.leg} ${r.model}`).join("\n"));
        return;
      }
      if (mode === "json") print(JSON.stringify({ stored, ...value }, null, 2));
      else if (mode === "quiet") print(Object.keys(value.readers).join("\n"));
      else print(table(value, stored));
      return;
    }
    if (sub === "set") {
      const leg = args[2];
      if (!leg || !flags.model) throw new UsageError("review readers set requires <leg> --model <id>");
      const { value } = await loadReviewReaders(io);
      const next = await saveReviewReaders(io, withReader(value, leg, flags.model));
      print(mode === "json" ? JSON.stringify(next, null, 2) : `${leg} ${next.readers[leg]!.model}`);
      return;
    }
    if (sub === "rm") {
      const leg = args[2];
      if (!leg) throw new UsageError("review readers rm requires <leg>");
      const { value } = await loadReviewReaders(io);
      const next = await saveReviewReaders(io, withoutReader(value, leg));
      print(mode === "json" ? JSON.stringify(next, null, 2) : `removed ${leg}`);
      return;
    }
    if (sub === "tier") {
      const tier = tierOf(args[2], "review readers tier <tier>");
      const legs = args.slice(3);
      if (legs.length === 0) throw new UsageError("review readers tier requires <tier> <leg>... (at least one reader)");
      const { value } = await loadReviewReaders(io);
      const next = await saveReviewReaders(io, withTier(value, tier, legs));
      print(mode === "json" ? JSON.stringify(next, null, 2) : `${tier}: ${next.tiers[tier].join(" ")}`);
      return;
    }
  } catch (e) {
    if (e instanceof ReviewReadersError) throw new AppError(e.message);
    throw e;
  }
  throw new UsageError(`unknown review readers subcommand '${sub}' (set|rm|tier)`);
}

export async function cmdReview(ctx: Ctx): Promise<void> {
  const store = ctx.store ?? ctx.db;
  await runReview(ctx.args, ctx.flags, ctx.mode, {
    get: (k) => getConfig(store, k),
    set: (k, v) => setConfig(store, k, v),
  });
}

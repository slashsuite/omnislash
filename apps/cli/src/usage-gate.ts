import { readFileSync } from "node:fs";
import { AppError, UsageError } from "./errors.ts";
import { cacheCheckedAt, pacingSource, readWeeklyFromDoc, t3Cache, type PacingProvider, type PacingSource } from "./commands/usage.ts";
import { print, type Mode } from "./output.ts";

/**
 * The critical-only line (OS-108, OS-129). At this share of the active models profile's weekly usage or above,
 * until the window resets, only critical tickets are worked: `ob next` lists only them and a dispatch or
 * send-back of anything else is refused. Jacobus, 2026-11-20: "when we reach 95% of the weekly usage, we will
 * only do critical tickets." Raised to 98% by Jacobus, 2026-11-23: "5% is still a lot of usage."
 */
const CRITICAL_ONLY_PERCENT = 98;

/** The cache is T3's; older than this, its numbers are not trusted to say the line is not crossed. */
const USAGE_CACHE_MAX_AGE_MIN = 60;

type UsageGate =
  | { unknown: false; active: boolean; usedPercent: number; resetsAt: string; provider: PacingProvider }
  | { unknown: true; why: string };

/**
 * Read the active profile's weekly window from T3's cache (`OB_USAGE_T3_CACHE` overrides the path) and say
 * whether the critical-only line holds now. A missing or unreadable file, no weekly window, or a `checkedAt`
 * older than an hour is `unknown`: it never blocks, and the caller says so.
 */
export function criticalOnlyGate(now: Date = new Date(), file?: string, source: PacingSource = pacingSource()): UsageGate {
  const path = file ?? t3Cache(process.env, source);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { unknown: true, why: `no readable usage cache at ${path}` };
  }
  const weekly = readWeeklyFromDoc(doc, now, source.windowId);
  if (!weekly) return { unknown: true, why: `no ${source.windowId} window in ${path}` };
  const checkedAt = cacheCheckedAt(doc);
  const checked = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  if (Number.isNaN(checked)) return { unknown: true, why: `no checkedAt in ${path}` };
  const ageMin = (now.getTime() - checked) / 60000;
  if (ageMin > USAGE_CACHE_MAX_AGE_MIN) return { unknown: true, why: `the usage cache was last checked ${Math.round(ageMin)} minutes ago` };
  const resets = Date.parse(weekly.resetsAt);
  if (Number.isNaN(resets)) return { unknown: true, why: `no readable resetsAt in ${path}` };
  const active = weekly.usedPercent >= CRITICAL_ONLY_PERCENT && now.getTime() < resets;
  return { unknown: false, active, usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt, provider: source.provider };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `Tue 03:00`, in local time. Pure. */
export function resetWhen(resetsAt: string): string {
  const d = new Date(resetsAt);
  return `${DAYS[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The one line: `Weekly Claude usage is 96% (resets Tue 03:00): critical only.` (or Gemini for Antigravity). Pure. */
export function criticalOnlyLine(g: { usedPercent: number; resetsAt: string; provider?: PacingProvider }): string {
  const who = g.provider === "antigravity" ? "Gemini" : "Claude";
  return `Weekly ${who} usage is ${g.usedPercent}% (resets ${resetWhen(g.resetsAt)}): critical only.`;
}

/** What an unknown usage reads as. Never silent, never a block. Pure. */
function usageUnknownLine(why: string): string {
  return `usage unknown (${why}): the ${CRITICAL_ONLY_PERCENT}% critical-only line is not applied`;
}

let warnedUnknown = false;

/** Print the unknown line on stderr, once per command run, so `--json` output stays valid. */
function warnUsageUnknownOnce(why: string): void {
  if (warnedUnknown) return;
  warnedUnknown = true;
  process.stderr.write(`${usageUnknownLine(why)}\n`);
}

/** Tests only: let the next unknown read print again. */
export function resetUsageUnknownWarning(): void {
  warnedUnknown = false;
}

/**
 * The dispatch half of the line (OS-108): `ob spinoff <ref>`, `ob spinoff queue <ref>`, a re-dispatch and a
 * send-back. Throws, naming the usage and the reset, when the line holds and the ticket is not critical and no
 * override was given. An unknown usage warns once and passes. Returns the `--over-usage` reason, which the
 * caller puts on the Decisions trail once nothing else refuses (like `--no-check`, it is recorded whenever
 * given), else null. `critical` is asked only when the line holds and no override was given, so a dispatch
 * below the line costs no item read.
 */
export async function refuseOverUsage(
  opts: { ref: string; critical: () => Promise<boolean>; overUsage?: string | null; verb: "dispatched" | "sent back"; now?: Date },
): Promise<string | null> {
  const why = opts.overUsage ?? null;
  // A bad override is refused first: an empty reason, or a run from an agent thread. It is Jacobus's, from his own terminal.
  if (why !== null && why.trim() === "") throw new UsageError("--over-usage needs a reason: --over-usage '<why>'");
  if (why !== null && process.env.T3CODE_THREAD_ID?.trim()) {
    throw new AppError("--over-usage is refused from a T3 thread: the override is Jacobus's, run from his own terminal");
  }
  const gate = criticalOnlyGate(opts.now ?? new Date());
  if (gate.unknown) {
    warnUsageUnknownOnce(gate.why);
    return why;
  }
  if (!gate.active || why || (await opts.critical())) return why;
  throw new AppError(
    `not ${opts.verb}: ${criticalOnlyLine(gate)} ${opts.ref} is not critical. Nothing was ${opts.verb === "dispatched" ? "queued" : "changed"}. ` +
      `Wait for the reset, raise it to critical if it is a production bug hurting users now, ` +
      `or (Jacobus, from his own terminal) override with --over-usage '<why>'`,
  );
}

/** The trail words for an override, like `check → no-check`. */
export const OVER_USAGE_FROM = "usage";
export const OVER_USAGE_TO = "over-usage";

/**
 * `ob next` under the line (OS-108): while it holds, only critical items, and the one line saying why goes
 * first (stdout for a human, stderr for `--json` and `-q`, so machine output stays clean). An unknown usage
 * warns once on stderr and leaves the list whole.
 */
export function criticalOnlyNext<T extends { priority: string | null }>(items: T[], mode: Mode, now: Date = new Date()): T[] {
  const gate = criticalOnlyGate(now);
  if (gate.unknown) {
    warnUsageUnknownOnce(gate.why);
    return items;
  }
  if (!gate.active) return items;
  const line = criticalOnlyLine(gate);
  if (mode === "human" || mode === "table") print(line);
  else process.stderr.write(`${line}\n`);
  return items.filter((i) => i.priority === "critical");
}

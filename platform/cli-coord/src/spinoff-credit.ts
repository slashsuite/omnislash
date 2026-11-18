// OB-1970: a spinoff launch that hits an out-of-credits account moves to the next models profile.
//
// Two places see the error:
//   1. the launch itself (T3 refuses `t3_thread_launch` with a credit or quota error), handled by
//      `launchAcrossProfiles` inside the launch call, and
//   2. the first turn's run, which T3 starts and then ends `failed` with a provider error item. The run
//      mirror sees that afterwards; `relaunchOnCreditFailure` settles the dead thread and launches the same
//      row again on the next profile.
//
// Each row is launched at most ONCE per profile: the profiles it ran on live in the local models state file
// (`models-state.json`), so a relaunch skips them. Only a credit or quota error moves a launch; every other
// failure is thrown exactly as before. When every profile is spent the row fails with a refusal naming each
// profile tried.

import { warn } from "../../../apps/cli/src/output.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";
import { ModelsFileError, SPINOFF_TIERS, loadModelsFile, type ModelsFile, type ModelsProfile, type SpinoffTier } from "../../../apps/cli/src/models-file.ts";
import { creditErrorOf, profileOrder, recordCreditHit, recordRowProfile, rowProfiles, type CreditMatch } from "../../../apps/cli/src/models-credit.ts";
import type { T3LaunchOutcome, T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";

/** The models file, or a refusal naming it (never a silent launch on the defaults). */
export function modelsFileOrRefuse(): ModelsFile | null {
  try {
    return loadModelsFile();
  } catch (e) {
    if (e instanceof ModelsFileError) throw new AppError(`${e.message}: fix it (\`ob models show\`) or move it aside, then re-run the drain`);
    throw e;
  }
}

/** `base` with the profile's builder tiers laid over it, tier by tier (OB-1969). Pure. */
export function withProfileTiers(base: Readonly<Record<SpinoffTier, string>>, profile: ModelsProfile | null): Record<SpinoffTier, string> {
  const models = { ...base };
  for (const tier of SPINOFF_TIERS) if (profile?.builder[tier]) models[tier] = profile.builder[tier]!;
  return models;
}

/** The `(profile X)` the row's model stamp carries when it ran on a fallback profile. Pure. */
function stampWithProfile(model: string, profile: string, file: ModelsFile): string {
  return profile === file.active ? model : `${model} (profile ${profile})`;
}

interface ProfileTry {
  profile: string;
  reason: string;
}

/** The refusal when every profile is spent: blocked on credits, each profile and its error named. Pure. */
function exhaustedMessage(ticket: string, tried: readonly ProfileTry[]): string {
  const list = tried.map((t) => `${t.profile} (${t.reason})`).join("; ");
  return `blocked: every models profile is out of credits for ${ticket}: tried ${list}. Top up an account or add a profile to "fallback" (\`ob models show\`), then re-dispatch`;
}

/** What the refusal says about one profile: the code, or the phrase the last-resort match found. Short, so a
 *  refusal naming every profile still fits the row's error column. */
function reasonOf(match: CreditMatch): string {
  return match.by === "code" ? match.match : `message: "${match.match}"`;
}

/**
 * Launch `row` on the first profile that has credit (OB-1970). `launch` is the real launch for one tier map.
 * No models file: one launch on `base`, as before. With one: the active profile, then `fallback`, skipping
 * `prior` (profiles this row already ran on and spent). Each attempt is recorded against the row first.
 */
export async function launchAcrossProfiles(
  row: { id: number; ticket_ref: string },
  base: Readonly<Record<SpinoffTier, string>>,
  launch: (models: Record<SpinoffTier, string>) => Promise<T3LaunchOutcome>,
  prior: readonly ProfileTry[] = [],
  file: ModelsFile | null = modelsFileOrRefuse(),
): Promise<T3LaunchOutcome & { profile: string | null }> {
  if (!file) return { ...(await launch({ ...base })), profile: null };
  const tried: ProfileTry[] = [...prior];
  for (const profile of profileOrder(file)) {
    if (tried.some((t) => t.profile === profile)) continue;
    recordRowProfile(row.id, profile);
    try {
      const outcome = await launch(withProfileTiers(base, file.profiles[profile]!));
      if (tried.length > 0) warn(`  ↳ ${row.ticket_ref}: ${tried[tried.length - 1]!.profile} out of credits, relaunched on ${profile}`);
      return { ...outcome, model: stampWithProfile(outcome.model, profile, file), profile };
    } catch (err) {
      const match = creditErrorOf(err as { code?: string; message?: string });
      if (!match) throw err;
      recordCreditHit(profile);
      tried.push({ profile, reason: reasonOf(match) });
    }
  }
  throw new AppError(exhaustedMessage(row.ticket_ref, tried));
}

/** The credit error in a thread's error items, or null. T3's error items carry text only, so this is the text match. */
function creditErrorInItems(items: ReadonlyArray<{ type: string; title?: string | null; text?: string | null }>): CreditMatch | null {
  for (const item of items) {
    if (item.type !== "error") continue;
    const match = creditErrorOf({ message: `${item.title ?? ""} ${item.text ?? ""}` });
    if (match) return match;
  }
  return null;
}

/** How many timeline items the relaunch check reads from the start of a failed thread. */
const FIRST_TURN_ITEMS = 50;

export interface CreditRelaunchDeps {
  seam: T3Seam;
  /** Launch the row on one tier map (the same launch the drain makes). */
  launch: (models: Record<SpinoffTier, string>) => Promise<T3LaunchOutcome>;
  /** `spinoff_tier_models` over the defaults, without any profile. */
  base: Readonly<Record<SpinoffTier, string>>;
  /** Record the new thread on the row (still `launched`). */
  relaunched: (outcome: T3LaunchOutcome) => Promise<void>;
  /** Fail the row with this reason. */
  fail: (reason: string) => Promise<void>;
  file?: ModelsFile | null;
}

export type CreditRelaunch = { kind: "none" } | { kind: "relaunched"; profile: string; threadId: string } | { kind: "failed"; reason: string } | { kind: "skipped"; reason: string };

/**
 * A row whose FIRST turn ended `failed` on a credit error is relaunched on the next profile (OB-1970). A
 * later turn, a non-credit failure or a machine with no models file is left alone (`none`): the mirror has
 * already recorded the failed run, which is the old behaviour.
 */
export async function relaunchOnCreditFailure(
  row: { id: number; ticket_ref: string },
  threadId: string,
  deps: CreditRelaunchDeps,
): Promise<CreditRelaunch> {
  const file = deps.file === undefined ? modelsFileOrRefuse() : deps.file;
  if (!file) return { kind: "none" };
  const read = await deps.seam.read(threadId, { afterPosition: 0, limit: FIRST_TURN_ITEMS });
  if (read.recentRuns.length > 1) return { kind: "none" }; // not the first turn: a relaunch would lose its work
  const match = creditErrorInItems(read.items);
  if (!match) return { kind: "none" };
  const ran = rowProfiles(row.id);
  const spent = ran[ran.length - 1] ?? file.active;
  recordCreditHit(spent);
  const prior: ProfileTry[] = [...new Set([...ran, spent])].map((profile) => ({
    profile,
    reason: profile === spent ? `first turn: ${reasonOf(match)}` : "out of credits earlier",
  }));
  try {
    await deps.seam.settle(threadId); // the dead thread would otherwise hold the worktree
  } catch (err) {
    return { kind: "skipped", reason: `credit error on thread ${threadId}, but it could not be settled for the relaunch: ${(err as Error).message}` };
  }
  let outcome: Awaited<ReturnType<typeof launchAcrossProfiles>>;
  try {
    outcome = await launchAcrossProfiles(row, deps.base, deps.launch, prior, file);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await deps.fail(reason);
    return { kind: "failed", reason };
  }
  // A live thread exists now: an error recording it is the caller's to report, never a reason to fail the row.
  await deps.relaunched(outcome); // launchAcrossProfiles printed the named "out of credits, relaunched on" line
  return { kind: "relaunched", profile: outcome.profile ?? file.active, threadId: outcome.threadId };
}

// OB-1970, OS-145: a spinoff launch that hits an out-of-credits account moves along its route's chain.
//
// A row launches on the builder band covering its complexity (OS-145, OS-177): the active profile's chain for that
// band, entry by entry, then the band covering the same score in each `fallback` profile, each model tried once
// (`builderAttempts`). Two places see the error:
//   1. the launch itself (T3 refuses `t3_thread_launch` with a credit or quota error), handled by
//      `launchAcrossProfiles` inside the launch call, and
//   2. the first turn's run, which T3 starts and then ends `failed` with a provider error item. The run
//      mirror sees that afterwards; `relaunchOnCreditFailure` settles the dead thread and launches the same
//      row again on the next attempt.
//
// Each row is launched at most ONCE per attempt: the attempts it ran on live in the local models state file
// (`models-state.json`, as `<profile>|<model>`), so a relaunch skips them. Only a credit or quota error moves a
// launch; every other failure is thrown exactly as before. Each move records `route <name>: <from> -> <to> (quota)`
// on the ticket's Decisions trail when the caller can write it. When every attempt is spent the row fails with a
// refusal naming each one tried.

import { warn } from "../../../apps/cli/src/output.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";
import { ModelsFileError, withModelAt, type BuilderModels, type RangeModel } from "../../../apps/cli/src/models-file.ts";
import { creditErrorOf, recordCreditHit, recordRowProfile, rowProfiles, type CreditMatch } from "../../../apps/cli/src/models-credit.ts";
import { ModelRoutesError, activeProfileOf, builderAttempts, builderModelsOf, routeMoveNote, type RouteAttempt, type RouteInputs } from "../../../apps/cli/src/model-routes.ts";
import { loadRouteInputs, machineConfigIo } from "../../../apps/cli/src/model-routes-io.ts";
import type { Database } from "bun:sqlite";
import type { Store } from "../../../apps/cli/src/db/store.ts";
import { rowComplexity, type T3LaunchOutcome, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";

/**
 * The route inputs on this machine (the local models file, the server's `model_routes` and `spinoff_tier_models`),
 * or a refusal naming what does not parse (never a silent launch on the defaults). An unreachable server leaves
 * the file and the defaults, with one stderr line.
 */
export async function routeInputsOrRefuse(db?: Database | Store): Promise<RouteInputs> {
  try {
    return await loadRouteInputs(await machineConfigIo(db));
  } catch (e) {
    if (e instanceof ModelsFileError) throw new AppError(`${e.message}: fix it (\`ob models show\`) or move it aside, then re-run the drain`);
    if (e instanceof ModelRoutesError) throw new AppError(`${e.message}: fix it (\`ob models show\`), then re-run the drain`);
    throw e;
  }
}

/** Every builder band's first model in the active profile: the bands a launch carries (OS-177). Pure. */
export function routeTierModels(inputs: RouteInputs): RangeModel[] {
  return builderModelsOf(inputs);
}

/**
 * `row` carrying the route's effort (OS-145). The launch applies it only when the row names no effort of its own and
 * the model lists that level, so a fallback model without it still launches, at its default. Pure.
 */
export function withRouteEffort<T extends object>(row: T, routeEffort: string | undefined): T & { route_effort?: string } {
  return routeEffort ? { ...row, route_effort: routeEffort } : row;
}

/** The key one attempt is recorded under in the state file. Pure. */
export function attemptKey(a: RouteAttempt): string {
  return `${a.profile ?? ""}|${a.model}`;
}

/** The `(profile X)` the row's model stamp carries when it ran on a fallback profile. Pure. */
function stampWithProfile(model: string, profile: string | null, active: string | null): string {
  return profile === null || profile === active ? model : `${model} (profile ${profile})`;
}

interface AttemptTry {
  /** `attemptKey` of the attempt. */
  key: string;
  label: string;
  reason: string;
}

function labelOf(a: RouteAttempt): string {
  return a.profile ? `${a.model} (profile ${a.profile})` : a.model;
}

/** The refusal when every attempt is spent: blocked on credits, each attempt and its error named. Pure. */
function exhaustedMessage(ticket: string, route: string, tried: readonly AttemptTry[]): string {
  const list = tried.map((t) => `${t.label} (${t.reason})`).join("; ");
  return `blocked: every model on route ${route} is out of credits for ${ticket}: tried ${list}. Top up an account, or add a model to the chain or a profile to "fallback" (\`ob models set ${route} <model>,<model>\`), then re-dispatch`;
}

/** What the refusal says about one attempt: the code, or the phrase the last-resort match found. Short, so a
 *  refusal naming every attempt still fits the row's error column. */
function reasonOf(match: CreditMatch): string {
  return match.by === "code" ? match.match : `message: "${match.match}"`;
}

/** Records one move along a route on the ticket's Decisions trail (the caller knows the store, or has none). */
export type RouteMoveRecorder = (from: string, to: string, note: string) => Promise<void>;

/** A row's launch: the builder bands (its own score's band on this attempt's model) and the band's effort, for a row with none. */
export type RouteLaunch = (models: BuilderModels, routeEffort: string | undefined) => Promise<T3LaunchOutcome>;

/**
 * Launch `row` on the first attempt of the builder band covering its complexity that has credit (OB-1970, OS-145,
 * OS-177). Attempts already
 * spent (`prior`) are skipped, and each attempt is recorded against the row before it runs. With no profile
 * anywhere there is one attempt and its error is thrown as it came, as before.
 */
export async function launchAcrossProfiles(
  row: { id: number; ticket_ref: string; tier?: string | null; complexity?: number | null; model_ask?: string | null },
  inputs: RouteInputs,
  launch: RouteLaunch,
  prior: readonly AttemptTry[] = [],
  recordMove?: RouteMoveRecorder,
): Promise<T3LaunchOutcome & { profile: string | null }> {
  const c = rowComplexity(row);
  const base = builderModelsOf(inputs);
  // OS-132: a row that named --model runs on that model once, outside the route: no chain to walk, no move to
  // record and no route effort (that was set for the band's model). A credit error on it fails the row by name.
  if (row.model_ask) return { ...(await launch(base, undefined)), profile: null }; // launchT3Spinoff applies the ask
  const active = activeProfileOf(inputs).name;
  const attempts = builderAttempts(inputs, c);
  const route = attempts[0]!.route;
  if (attempts.length === 1 && attempts[0]!.profile === null) {
    return { ...(await launch(withModelAt(base, c, attempts[0]!.model), undefined)), profile: null };
  }
  const tried: AttemptTry[] = [...prior];
  let last: RouteAttempt | null = null;
  for (const attempt of attempts) {
    const key = attemptKey(attempt);
    if (tried.some((t) => t.key === key)) continue;
    // The row's own range names the move (OS-177): a fallback profile may split the builder differently.
    if (last) await noteMove(recordMove, route, last.model, attempt.model);
    else if (tried.length > 0) await noteMove(recordMove, route, modelOfKey(tried[tried.length - 1]!.key), attempt.model);
    recordRowProfile(row.id, key);
    try {
      const outcome = await launch(withModelAt(base, c, attempt.model), attempt.effort);
      if (tried.length > 0) warn(`  ↳ ${row.ticket_ref}: ${tried[tried.length - 1]!.label} out of credits, relaunched on ${labelOf(attempt)}`);
      return { ...outcome, model: stampWithProfile(outcome.model, attempt.profile, active), profile: attempt.profile };
    } catch (err) {
      const match = creditErrorOf(err as { code?: string; message?: string });
      if (!match) throw err;
      if (attempt.profile) recordCreditHit(attempt.profile);
      tried.push({ key, label: labelOf(attempt), reason: reasonOf(match) });
      last = attempt;
    }
  }
  throw new AppError(exhaustedMessage(row.ticket_ref, route, tried));
}

function modelOfKey(key: string): string {
  return key.slice(key.indexOf("|") + 1);
}

/** One move's Decisions line, and the same line on stderr. A trail that cannot be written never stops the launch. */
async function noteMove(record: RouteMoveRecorder | undefined, route: string, from: string, to: string): Promise<void> {
  const note = routeMoveNote(route, from, to);
  warn(`  ↳ ${note}`);
  if (!record) return;
  try {
    await record(from, to, note);
  } catch (err) {
    warn(`  ⚠ ${note}: not written to the Decisions trail: ${(err as Error).message}`);
  }
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
  /** Launch the row on one set of builder bands (the same launch the drain makes). */
  launch: RouteLaunch;
  /** The route inputs (`routeInputsOrRefuse`). */
  inputs: RouteInputs;
  /** Record the new thread on the row (still `launched`). */
  relaunched: (outcome: T3LaunchOutcome) => Promise<void>;
  /** Fail the row with this reason. */
  fail: (reason: string) => Promise<void>;
  recordMove?: RouteMoveRecorder;
}

export type CreditRelaunch = { kind: "none" } | { kind: "relaunched"; profile: string | null; threadId: string } | { kind: "failed"; reason: string } | { kind: "skipped"; reason: string };

/**
 * A row whose FIRST turn ended `failed` on a credit error is relaunched on the route's next attempt (OB-1970). A
 * later turn, a non-credit failure or a route with a single attempt is left alone (`none`): the mirror has already
 * recorded the failed run, which is the old behaviour.
 */
export async function relaunchOnCreditFailure(
  row: { id: number; ticket_ref: string; tier?: string | null; complexity?: number | null; model_ask?: string | null },
  threadId: string,
  deps: CreditRelaunchDeps,
): Promise<CreditRelaunch> {
  if (row.model_ask) return { kind: "none" }; // OS-132: a --model row has no route to move along
  const attempts = builderAttempts(deps.inputs, rowComplexity(row));
  if (attempts.length === 1 && attempts[0]!.profile === null) return { kind: "none" }; // no route set anywhere: as before OB-1970
  const read = await deps.seam.read(threadId, { afterPosition: 0, limit: FIRST_TURN_ITEMS });
  if (read.recentRuns.length > 1) return { kind: "none" }; // not the first turn: a relaunch would lose its work
  const match = creditErrorInItems(read.items);
  if (!match) return { kind: "none" };
  const ran = rowProfiles(row.id);
  const spentKey = ran[ran.length - 1] ?? attemptKey(attempts[0]!);
  const spent = attempts.find((a) => attemptKey(a) === spentKey);
  if (spent?.profile) recordCreditHit(spent.profile);
  const prior: AttemptTry[] = [...new Set([...ran, spentKey])].map((key) => {
    const a = attempts.find((x) => attemptKey(x) === key);
    return {
      key,
      label: a ? labelOf(a) : key,
      reason: key === spentKey ? `first turn: ${reasonOf(match)}` : "out of credits earlier",
    };
  });
  try {
    await deps.seam.settle(threadId); // the dead thread would otherwise hold the worktree
  } catch (err) {
    return { kind: "skipped", reason: `credit error on thread ${threadId}, but it could not be settled for the relaunch: ${(err as Error).message}` };
  }
  let outcome: Awaited<ReturnType<typeof launchAcrossProfiles>>;
  try {
    outcome = await launchAcrossProfiles(row, deps.inputs, deps.launch, prior, deps.recordMove);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await deps.fail(reason);
    return { kind: "failed", reason };
  }
  // A live thread exists now: an error recording it is the caller's to report, never a reason to fail the row.
  await deps.relaunched(outcome); // launchAcrossProfiles printed the named "out of credits, relaunched on" line
  return { kind: "relaunched", profile: outcome.profile, threadId: outcome.threadId };
}

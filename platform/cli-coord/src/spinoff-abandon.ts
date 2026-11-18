import { builderIdOf } from "./clean-repo.ts";
import { AppError } from "../../../apps/cli/src/errors.ts";
import type { SpinoffRow, StampInput } from "./commands/spinoff.ts";
import { spinoffStatusWord } from "./spinoff-vocab.ts";

// `ob spinoff abandon` (ob 1697): retire a launched-but-unbuilt spinoff the architect started by mistake.
// Before it, the only way to settle such a row was `ob close`, which stamps it LANDED and poisons the
// tier data `spinoff mix` reads. An abandoned row is an ordinary `failed` row whose error carries a marker
// prefix: the status column is free text and a new status would be a migration for one word, but a
// prefix on the error the stamp already writes needs nothing new anywhere. `spinoff mix` reads the marker.

export const ABANDONED_PREFIX = "abandoned:";

/** What the stamp records as the row's error: the marker, then the caller's `--note`. */
export function abandonedError(note: string | null | undefined): string {
  const text = (note ?? "").trim();
  return `${ABANDONED_PREFIX} ${text || "no note given"}`;
}

/** Was this row retired by `abandon` (as opposed to a launch that genuinely failed)? */
export function isAbandoned(row: Pick<SpinoffRow, "status" | "error">): boolean {
  return row.status === "failed" && (row.error ?? "").startsWith(ABANDONED_PREFIX);
}

/** What the abandon touched, for the report. */
export interface AbandonResult {
  id: number;
  ticket: string;
  branch: string;
  worktree: string;
  /** Commits on the branch past base_sha; null = not asked (an unlaunched row) or git could not say. */
  commits: number | null;
  thread: { id: string; interrupted: boolean; settled: boolean; error: string | null } | null;
  error: string;
  released: string[];
  agent_done: boolean;
  /** Problems that did not stop the abandon (a forced past a thread that would not settle, an agent step). */
  warnings: string[];
}

/** The IO an abandon performs, so the local path and the API client share one decision sequence. */
export interface AbandonDeps {
  /** Commits on the row's branch past its base_sha (null = cannot tell). */
  commitsAhead(row: SpinoffRow): number | null;
  /** Interrupt then settle the row's T3 thread. */
  stopThread(threadId: string): Promise<{ interrupted: boolean; settled: boolean; error: string | null }>;
  /** Record the failed outcome; null when applied, else the failure ready to print. */
  stamp(input: StampInput): Promise<string | null>;
  /** Deregister the row's agent and release the leases it holds. */
  finishAgent(agentId: string): Promise<{ done: boolean; released: string[]; error: string | null }>;
}

/**
 * Refuse a row `abandon` must not touch. Pure. A landed row is a landed row, and a failed one is already
 * retired. Work on the branch is a land or a needs-human, not an abandon, and so is "git cannot say":
 * both stand until `--force` says the caller has looked.
 */
export function abandonRefusal(row: SpinoffRow, commits: number | null, force: boolean): string | null {
  if (row.status === "merged") return `spinoff #${row.id} (${row.ticket_ref}) is already landed; there is nothing to abandon`;
  if (row.status === "failed") {
    return isAbandoned(row)
      ? `spinoff #${row.id} (${row.ticket_ref}) is already abandoned`
      : `spinoff #${row.id} (${row.ticket_ref}) is already failed (${row.error ?? "no error recorded"}); it is not building`;
  }
  if (force) return null;
  if (commits !== null && commits > 0) {
    return `spinoff #${row.id} (${row.ticket_ref}) has ${commits} commit(s) on ${row.branch} past its base: that is work to land or hand to a human, not to abandon (--force abandons it anyway; the worktree is kept)`;
  }
  if (commits === null && row.status !== "pending") {
    return `spinoff #${row.id} (${row.ticket_ref}): cannot tell whether ${row.branch} carries work (no base_sha, or git could not read ${row.worktree}); --force abandons it anyway`;
  }
  return null;
}

/**
 * Abandon one row: refuse it if it should not be touched, STOP its thread, retire the row, release the
 * builder's leases. The thread goes first and a thread that will not settle refuses (unless `--force`),
 * because retiring the row under a builder that is still running leaves the very mess this command
 * exists to clear. The worktree is never touched: it is the architect's to remove with `wt`.
 */
export async function abandonSpinoff(
  row: SpinoffRow,
  deps: AbandonDeps,
  opts: { note?: string | null; force?: boolean } = {},
): Promise<AbandonResult> {
  const force = opts.force === true;
  const commits = row.status === "pending" ? null : deps.commitsAhead(row);
  const refusal = abandonRefusal(row, commits, force);
  if (refusal) throw new AppError(refusal);

  const warnings: string[] = [];
  let thread: AbandonResult["thread"] = null;
  if (row.t3_thread_id) {
    const out = await deps.stopThread(row.t3_thread_id);
    thread = { id: row.t3_thread_id, ...out };
    if (!out.settled) {
      const why = `T3 thread ${row.t3_thread_id} could not be stopped: ${out.error ?? "unknown error"}`;
      if (!force) throw new AppError(`${why}. Nothing was changed; run again, or --force to retire the row regardless`);
      warnings.push(`${why} (forced: the thread may still be running)`);
    }
  }

  const error = abandonedError(opts.note);
  const failed = await deps.stamp({ id: row.id, outcome: "failed", error });
  if (failed) throw new AppError(`spinoff #${row.id}: the row was not retired: ${failed}`);

  const agentId = builderIdOf(row);
  const fin = await deps.finishAgent(agentId);
  if (fin.error) warnings.push(`agent ${agentId} was not marked done: ${fin.error} (retry: ob agent done ${agentId})`);

  return {
    id: row.id,
    ticket: row.ticket_ref,
    branch: row.branch,
    worktree: row.worktree,
    commits,
    thread,
    error,
    released: fin.released,
    agent_done: fin.done,
    warnings,
  };
}

export function renderAbandon(r: AbandonResult, json: boolean): string {
  if (json) return JSON.stringify({ ...r, status: spinoffStatusWord("failed") }, null, 2);
  const lines = [`abandoned #${r.id} (${r.ticket}): ${r.error}`];
  if (r.thread) {
    lines.push(
      r.thread.settled
        ? `  t3 thread ${r.thread.id} ${r.thread.interrupted ? "interrupted and " : ""}settled`
        : `  t3 thread ${r.thread.id} NOT settled`,
    );
  }
  lines.push(r.released.length > 0 ? `  released: ${r.released.join(", ")}` : "  no leases to release");
  lines.push(`  agent ${r.agent_done ? "marked done" : "was not registered"}`);
  lines.push(`  worktree kept: ${r.worktree} (remove it with wt when you are done with it)`);
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  return lines.join("\n");
}

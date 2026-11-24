// OB-1991: `ob spinoff trial ...`, the command layer shared by the local CLI and the API client. The store work
// is one `runTrialOp` call (locally, or `POST /spinoffs/trial`); what only this machine can do (read the notes
// file, write the two diffs, read each leg's transcripts and thread) happens here, before or after that call.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import type { Mode } from "../../../apps/cli/src/output.ts";
import type { T3ThreadRead } from "../../../apps/cli/src/t3/client.ts";
import {
  collectLegMeasures,
  renderBlindPair,
  renderRecord,
  renderStart,
  renderStop,
  renderTrialReport,
  renderTrialStatus,
  threadMeasures,
  TRIAL_USAGE,
  writePairDiffs,
  type BlindLeg,
  type MeasureDeps,
  type TrialOpRequest,
  type TrialOpResponse,
} from "./spinoff-trial.ts";
import { readOpencodeSpinoffUsage, readSpinoffTokens, tokenSourceFor } from "./spinoff-tokens.ts";

export interface TrialCliCtx {
  args: string[];
  flags: Record<string, unknown>;
  mode: Mode;
}

export interface TrialCliIO {
  op(req: TrialOpRequest): Promise<TrialOpResponse>;
  print(text: string): void;
  /** The leg's measures readers; tests pass fakes. */
  measures: MeasureDeps;
  /** The leg's diff from the merge base with main. */
  diffOf(leg: BlindLeg): string;
  readFile(path: string): string;
  writeFile(path: string, text: string): void;
}

function str(ctx: TrialCliCtx, name: string): string | undefined {
  const v = ctx.flags[name];
  return typeof v === "string" ? v : undefined;
}

function needRef(ctx: TrialCliCtx, sub: string): string {
  const ref = ctx.args[2];
  if (!ref) throw new UsageError(`spinoff trial ${sub} requires a <ticket|#pair>. Usage: ${TRIAL_USAGE}`);
  return ref;
}

/** `ob spinoff trial <sub> ...`. `ctx.args[0]` is `trial`. */
export async function runTrialCli(ctx: TrialCliCtx, io: TrialCliIO): Promise<void> {
  const sub = ctx.args[1];
  const json = ctx.mode === "json";
  switch (sub) {
    case "start": {
      const target = str(ctx, "target");
      if (!target) throw new UsageError(`spinoff trial start requires --target <n>. Usage: ${TRIAL_USAGE}`);
      const a = str(ctx, "a");
      const b = str(ctx, "b");
      if (!a || !b) throw new UsageError(`spinoff trial start requires --a and --b. Usage: ${TRIAL_USAGE}`);
      const n = Number(target);
      if (!Number.isInteger(n) || n < 1) throw new UsageError(`--target must be a whole number of pairs, 1 or more (got '${target}')`);
      const res = await io.op({ op: "start", target: n, a, b, tier: str(ctx, "tier") ?? null, range: str(ctx, "range") ?? null, name: str(ctx, "name") ?? null, a_price: str(ctx, "a-price") ?? null, b_price: str(ctx, "b-price") ?? null });
      if (res.op === "start") io.print(renderStart(res.trial, json));
      return;
    }
    case "status": {
      const res = await io.op({ op: "status" });
      if (res.op === "status") io.print(renderTrialStatus(res.status, json));
      return;
    }
    case "stop": {
      const res = await io.op({ op: "stop" });
      if (res.op === "stop") io.print(renderStop(res, json));
      return;
    }
    case "pair": {
      const ref = needRef(ctx, "pair");
      const res = await io.op({ op: "pair", ref });
      if (res.op !== "pair") return;
      const dir = str(ctx, "diffs");
      let written: string[] | undefined;
      if (dir) {
        mkdirSync(dir, { recursive: true });
        written = writePairDiffs(res.pair, dir, io.diffOf, io.writeFile);
      }
      io.print(renderBlindPair(res.pair, json, written));
      return;
    }
    case "record": {
      const ref = needRef(ctx, "record");
      const isVoid = ctx.flags.void === true;
      const forfeit = str(ctx, "forfeit") ?? null;
      const notesPath = str(ctx, "notes");
      const notes = notesPath ? io.readFile(notesPath) : null;
      // The measures are read here, where the transcripts and T3 are; a void records none.
      let measures: Awaited<ReturnType<typeof collectLegMeasures>> | null = null;
      if (!isVoid) {
        const blind = await io.op({ op: "pair", ref });
        if (blind.op === "pair") measures = await collectLegMeasures(blind.pair, io.measures);
      }
      const res = await io.op({ op: "record", ref, x: str(ctx, "x") ?? null, y: str(ctx, "y") ?? null, notes, forfeit, void: isVoid, reason: str(ctx, "reason") ?? null, measures });
      if (res.op === "record") io.print(renderRecord(res.result, json));
      return;
    }
    case "feedback": {
      const ref = needRef(ctx, "feedback");
      const label = str(ctx, "label");
      const note = str(ctx, "note");
      if (!label || !note) throw new UsageError(`spinoff trial feedback requires --label X|Y and --note <text>. Usage: ${TRIAL_USAGE}`);
      const res = await io.op({ op: "feedback", ref, label, note, rating: str(ctx, "rating") ?? null });
      if (res.op === "feedback") io.print(json ? JSON.stringify({ pair: res.pair.id, ticket: res.pair.ticket_ref, label }, null, 2) : `feedback on ${label} recorded for trial pair #${res.pair.id} (${res.pair.ticket_ref})`);
      return;
    }
    case "fix": {
      const ref = needRef(ctx, "fix");
      const note = str(ctx, "note");
      if (!note) throw new UsageError(`spinoff trial fix requires --note <text>. Usage: ${TRIAL_USAGE}`);
      const res = await io.op({ op: "fix", ref, note });
      if (res.op === "fix") io.print(json ? JSON.stringify({ pair: res.pair.id, ticket: res.pair.ticket_ref }, null, 2) : `fix recorded against the winner of trial pair #${res.pair.id} (${res.pair.ticket_ref})`);
      return;
    }
    case "report": {
      const res = await io.op({ op: "report" });
      if (res.op === "report") io.print(renderTrialReport(res.report, json));
      return;
    }
    default:
      throw new UsageError(`Usage: ${TRIAL_USAGE}`);
  }
}

/** The live measures readers: the token source the leg's model names, its T3 thread, and the first-time gate. */
export function liveMeasureDeps(
  read: ((threadId: string) => Promise<T3ThreadRead>) | null,
  at: { home?: string; opencodeDb?: string } = {},
): MeasureDeps {
  return {
    tokens: (leg) => {
      if (!leg.worktree) return null;
      if (tokenSourceFor(leg) === "opencode") return readOpencodeSpinoffUsage(leg.worktree, at.opencodeDb);
      return { usage: readSpinoffTokens(leg.worktree, at.home), cost: null };
    },
    thread: read
      ? async (leg) => {
          if (!leg.thread_id) return null;
          return threadMeasures(await read(leg.thread_id), leg.handoff_at);
        }
      : undefined,
    // No first-time gate reader: the PR's `gate` check on its first pushed head is not kept anywhere ob reads,
    // so a leg reads "not recorded" unless it was sent back (a sendback is a failed first gate).
  };
}

/**
 * The leg's own change: `git diff origin/main...<branch>` (from the merge base) in its worktree, so a leg that
 * rebased onto a newer main is not charged with what main gained. Without origin/main, its recorded base.
 */
export function gitLegDiff(leg: BlindLeg): string {
  if (!leg.worktree || !leg.branch) return "";
  const hasMain = spawnSync("git", ["-C", leg.worktree, "rev-parse", "--verify", "--quiet", "origin/main"], { encoding: "utf8" }).status === 0;
  const range = hasMain ? `origin/main...${leg.branch}` : `${leg.base_sha ?? "HEAD"}..${leg.branch}`;
  const out = spawnSync("git", ["-C", leg.worktree, "diff", range], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new UsageError(`git diff for ${leg.label} failed: ${(out.stderr || "").trim() || `exit ${out.status}`}`);
  return out.stdout;
}

/** The file IO a live run uses. */
export const liveFileIO = {
  readFile: (path: string) => readFileSync(path, "utf8"),
  writeFile: (path: string, text: string) => writeFileSync(path, text),
};

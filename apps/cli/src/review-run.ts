// OS-210: `ob review run <ticket>`, the skeptical review as one command instead of a loop an agent types.
//
// The steps are fixed here, so no agent decides them:
//   1. mark the row `reviewing` (best effort, as the skill always said);
//   2. run the repo's gate (`ob gate run`, cached by sha); a red gate stops the review before any leg runs;
//   3. round 1: ONE reader, the first leg `ob review readers --complexity <n>` lists for the row's score;
//   4. escalate to ONE more reader only when round 1 calls for it: the leg failed, gave no score, raised a
//      `wrong` or `unproven`, or scored under 8. The extra reader is an Opus reader, never neon or any other
//      model (OS-247, per OS-238: review readers are Opus only): the range's other Opus reader, then any other
//      configured Opus reader, else a second seat of the round-1 Opus reader (`opus-2`). This command never runs a
//      reader's `fallback`: an unavailable Opus fails its seats, and neon does not stand in.
// `--answers <file>` makes the run the next round, the rebuttal pass: the previous round's legs run again, each
// with its own previous findings and its own `## <leg>` section of the builder's answers, and nothing else's.
//
// Every leg runs through skills/ob-skeptical-review/review-leg.ts (the read-only profile lives there), with
// OB_REVIEW_RUN_ID set, so each attempt's leg record in review-legs.jsonl carries the run id and its tokens are
// read back from there. One record per round goes to review-runs.jsonl beside it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AppError, UsageError } from "./errors.ts";
import { runGate, type GateOutcome } from "./commands/gate.ts";
import { loadRouteInputs } from "./model-routes-io.ts";
import { resolveReview } from "./model-routes.ts";
import { parseComplexity } from "./models-file.ts";
import { print, type Mode } from "./output.ts";
import { readersForComplexity, type ConfigIO, type ReviewReaders } from "./review-readers.ts";
import { readLegRecords, reviewLegsPath, type LegTokens } from "./review-legs.ts";
import type { Flags } from "./ctx.ts";

type Env = Record<string, string | undefined>;

/** Round 1 escalates when its score is under this. */
const ESCALATE_BELOW = 8;
/** An Opus model id, bare or behind a provider prefix (`claudeAgent:claude-opus-5-5`). */
const OPUS = /claude-opus/i;
const DEFAULT_COMPLEXITY = 5;

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const SKILL_DIR = join(REPO_ROOT, "skills/ob-skeptical-review");

const SCOPE_LINE = "Scope: read the diff above first, then only the files it touches and their direct callers, inside this checkout.";

export interface Verdict {
  score: number | null;
  wrong: number;
  stupid: number;
  overboard: number;
  unproven: number;
  ok: boolean;
  accepted: number;
  rejected: number;
}

export type LegPhase = "round1" | "escalation" | "rebuttal";

export interface LegOutcome {
  /** The seat: the reader's name, or `<reader>-2` for a second seat of the same reader (OS-247). */
  leg: string;
  /** The reader the seat runs, when it is not `leg` itself (a second seat). */
  reader?: string;
  model: string | null;
  phase: LegPhase;
  exit: number;
  verdict: Verdict;
  tokens: LegTokens | null;
  /** The leg's stdout (its findings), scratch under the git dir. */
  out: string;
  /** The leg's last stderr line when it failed. */
  error: string | null;
}

export interface ReviewRunRecord {
  v: 1;
  run: string;
  ticket: string;
  round: number;
  start: string;
  end: string;
  gate: { ok: boolean; cached: boolean; sha: string };
  complexity: number;
  escalated: boolean;
  /** Why round 1 escalated (or did not); null on a rebuttal round. */
  reason: string | null;
  legs: LegOutcome[];
}

/** Count a leg's findings and read its score from its stdout. Lines may carry a list bullet or backticks. */
export function parseVerdict(text: string): Verdict {
  const v: Verdict = { score: null, wrong: 0, stupid: 0, overboard: 0, unproven: 0, ok: false, accepted: 0, rejected: 0 };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])?\s*/, "").replace(/^[`*_]+/, "").trim();
    const word = /^(wrong|stupid|overboard|unproven|score|accepted|rejected|ok)\b[`*_]*\s*(:)?/i.exec(line);
    if (!word) continue;
    const k = word[1]!.toLowerCase();
    if (k === "score") {
      const m = /score[`*_]*\s*:\s*(\d+(?:\.\d+)?)\s*\/\s*10/i.exec(line);
      if (m) v.score = Number(m[1]);
      else if (/score[`*_]*\s*:\s*none/i.test(line)) v.score = null;
    } else if (k === "ok") {
      v.ok = true;
    } else if (k === "accepted" || k === "rejected") v[k]++;
    else if (word[2]) v[k as "wrong" | "stupid" | "overboard" | "unproven"]++;
  }
  return v;
}

/** Whether round 1 calls for more readers, and why. Pure. */
export function escalation(l: Pick<LegOutcome, "exit" | "verdict">): { escalate: boolean; reason: string } {
  const v = l.verdict;
  if (l.exit !== 0) return { escalate: true, reason: `the round-1 leg failed (exit ${l.exit})` };
  if (v.score === null) return { escalate: true, reason: "the round-1 leg gave no score" };
  if (v.wrong > 0) return { escalate: true, reason: `round 1 raised ${v.wrong} wrong` };
  if (v.unproven > 0) return { escalate: true, reason: `round 1 left ${v.unproven} unproven` };
  if (v.score < ESCALATE_BELOW) return { escalate: true, reason: `round 1 scored ${v.score}/10, under ${ESCALATE_BELOW}` };
  return { escalate: false, reason: `round 1 scored ${v.score}/10 with no wrong or unproven` };
}

/** A planned leg: its seat name, the reader it runs when that differs, and the model. */
export interface PlannedLeg {
  leg: string;
  reader?: string;
  model: string;
}

/**
 * The leg round 1 runs and the reader escalation may add (OS-247): one Opus reader, never neon or any other model.
 * The range's other Opus reader, then any other configured Opus reader, else a second seat of the round-1 reader
 * when it is itself Opus; none when no Opus reader is configured. Pure.
 */
export function planLegs(value: ReviewReaders, complexity: number): { first: PlannedLeg; extra: PlannedLeg[] } {
  const tier = readersForComplexity(value, complexity);
  const first = tier[0];
  if (!first) throw new AppError(`no review reader covers complexity ${complexity}: set one with \`ob review readers range\``);
  const other = [...tier.slice(1).map((r) => r.leg), ...Object.keys(value.readers)].find(
    (leg) => leg !== first.leg && OPUS.test(value.readers[leg]?.model ?? ""),
  );
  const extra: PlannedLeg[] = other
    ? [{ leg: other, model: value.readers[other]!.model }]
    : OPUS.test(first.model)
      ? [{ leg: `${first.leg}-2`, reader: first.leg, model: first.model }]
      : [];
  return { first: { leg: first.leg, model: first.model }, extra };
}

/** The `## <leg>` sections of an answers file. */
export function parseAnswers(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let leg: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (leg !== null) out.set(leg, body.join("\n").trim());
  };
  for (const line of text.split("\n")) {
    const h = /^##\s+(\S+)\s*$/.exec(line);
    if (h) {
      flush();
      leg = h[1]!;
      body = [];
    } else if (leg !== null) body.push(line);
  }
  flush();
  return out;
}

/** The stance and the output format from the skill, the parts every leg's brief shares. */
export function skillBrief(skill: string): string {
  const cut = (from: string, to: string) => {
    const a = skill.indexOf(from);
    const b = a < 0 ? -1 : skill.indexOf(to, a);
    if (a < 0 || b < 0) throw new AppError(`the skeptical-review skill has no '${from}' ... '${to}' section to brief from`);
    return skill.slice(a, b).trim();
  };
  return [cut("## The stance", "## Which models"), "## What you return", cut("Each subagent returns a short list", "## Claims review")].join("\n\n");
}

function reviewRunsPath(env: Env = process.env): string {
  return join(dirname(reviewLegsPath(env)), "review-runs.jsonl");
}

export function readRunRecords(env: Env = process.env): ReviewRunRecord[] {
  const path = reviewRunsPath(env);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l) as ReviewRunRecord] : [];
      } catch {
        return [];
      }
    });
}

/** Sum the tokens of a run's attempts of one seat; null when no attempt left any. */
function runTokens(run: string, leg: string, env: Env = process.env): LegTokens | null {
  let sum: LegTokens | null = null;
  for (const r of readLegRecords(env)) {
    if (r.run !== run || (r.seat ?? r.leg) !== leg || !r.tokens) continue;
    sum ??= { input: 0, output: 0, reasoning: 0 };
    sum.input += r.tokens.input;
    sum.output += r.tokens.output;
    sum.reasoning += r.tokens.reasoning;
  }
  return sum;
}

export interface Exec {
  code: number;
  out: string;
  err: string;
}

/** The seams: `ob`, one leg, the gate. Tests replace them. */
export interface ReviewRunDeps {
  cwd: string;
  env: Env;
  now: () => Date;
  log: (line: string) => void;
  ob: (args: string[]) => Exec;
  git: (args: string[]) => Exec;
  gate: (cwd: string) => Promise<GateOutcome>;
  /** Run one leg with `brief` on stdin, its stdout to `outPath`; resolves to its exit and stderr. */
  leg: (leg: string, brief: string, outPath: string, env: Env) => Promise<{ code: number; err: string }>;
  skill: () => string;
  /** The review readers in force (the active profile's, as `ob review readers` prints them). */
  readers: () => Promise<ReviewReaders>;
}

function exec(cmd: string[], cwd: string, env: Env): Exec {
  const p = Bun.spawnSync(cmd, { cwd, env: env as Record<string, string>, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
}

function liveDeps(cwd: string, io: ConfigIO, env: Env = process.env): ReviewRunDeps {
  return {
    cwd,
    env,
    now: () => new Date(),
    log: (l) => process.stderr.write(`${l}\n`),
    ob: (args) => exec(["ob", ...args], cwd, env),
    git: (args) => exec(["git", ...args], cwd, env),
    gate: (dir) => runGate(dir),
    leg: async (leg, brief, outPath, legEnv) => {
      const proc = Bun.spawn(["bun", join(SKILL_DIR, "review-leg.ts"), leg], {
        cwd,
        env: legEnv as Record<string, string>,
        stdin: new Blob([brief]),
        stdout: Bun.file(outPath),
        stderr: "pipe",
      });
      const err = await new Response(proc.stderr).text();
      return { code: await proc.exited, err };
    },
    skill: () => readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8"),
    readers: async () => resolveReview(await loadRouteInputs(io)).value,
  };
}

function gitOk(d: ReviewRunDeps, args: string[]): string {
  const r = d.git(args);
  if (r.code !== 0) throw new AppError(`git ${args.join(" ")} failed: ${r.err.trim()}`);
  return r.out;
}

function lastLine(text: string): string | null {
  return text.trim().split("\n").at(-1)?.trim() || null;
}

async function runLegs(
  d: ReviewRunDeps,
  ctx: { run: string; dir: string },
  legs: Array<{ leg: string; reader?: string; model: string | null; phase: LegPhase; brief: string }>,
): Promise<LegOutcome[]> {
  mkdirSync(ctx.dir, { recursive: true });
  return Promise.all(
    legs.map(async (l) => {
      const out = join(ctx.dir, `${l.leg}.txt`);
      writeFileSync(join(ctx.dir, `${l.leg}.brief.md`), l.brief);
      d.log(`review: ${l.leg} (${l.phase}) running; findings to ${out}`);
      // OB_REVIEW_SEAT names the seat on the leg record, so a second seat's tokens are not summed with the first's.
      const r = await d.leg(l.reader ?? l.leg, l.brief, out, { ...d.env, OB_REVIEW_RUN_ID: ctx.run, OB_REVIEW_SEAT: l.leg });
      const text = existsSync(out) ? readFileSync(out, "utf8") : "";
      return {
        leg: l.leg,
        ...(l.reader ? { reader: l.reader } : {}),
        model: l.model,
        phase: l.phase,
        exit: r.code,
        verdict: parseVerdict(text),
        tokens: runTokens(ctx.run, l.leg, d.env),
        out,
        error: r.code === 0 ? null : lastLine(r.err),
      };
    }),
  );
}

/** One line per leg, the shape the review line in a commit copies from. */
function legLine(l: LegOutcome): string {
  const v = l.verdict;
  const t = l.tokens ? `tokens in ${l.tokens.input} out ${l.tokens.output}` : "tokens -";
  if (l.exit !== 0) return `${l.leg} (${l.phase}): failed (${l.error ?? `exit ${l.exit}`}); ${t}`;
  const score = v.score === null ? "no score" : `${v.score}/10`;
  const answers = l.phase === "rebuttal" ? `, ${v.accepted} accepted, ${v.rejected} rejected` : "";
  return `${l.leg} (${l.phase}): ${score}, wrong ${v.wrong}, stupid ${v.stupid}, overboard ${v.overboard}, unproven ${v.unproven}${answers}; ${t}`;
}

/** `ob review run <ticket> [--complexity n] [--answers file]`: the driver. Returns the run record. */
export async function reviewRun(ticket: string, flags: Flags, d: ReviewRunDeps): Promise<ReviewRunRecord> {
  const start = d.now();
  const phase = d.ob(["spinoff", "phase", ticket, "reviewing"]);
  if (phase.code !== 0) d.log(`review: could not mark ${ticket} reviewing (${lastLine(phase.err) ?? `exit ${phase.code}`}); reviewing anyway`);

  const gate = await d.gate(d.cwd);
  const gateRec = { ok: gate.result.ok, cached: gate.cached, sha: gate.result.sha };
  if (!gate.result.ok) throw new AppError(`the gate is red at ${gate.result.sha.slice(0, 7)} (step '${gate.result.failed}'): fix it before the review; no leg ran`);
  d.log(`review: gate green at ${gate.result.sha.slice(0, 7)}${gate.cached ? " (cached)" : ""}`);

  let complexity: number | null = null;
  if (flags.complexity !== undefined) {
    complexity = parseComplexity(String(flags.complexity));
    if (complexity === null) throw new UsageError(`--complexity must be a whole number 1 to 10, not '${String(flags.complexity)}'`);
  } else {
    const show = d.ob(["spinoff", "show", ticket]);
    const m = /complexity (\d+)\/10/.exec(show.out);
    complexity = m ? parseComplexity(m[1]!) : null;
    if (complexity === null) d.log(`review: ${ticket} has no complexity score; reading it as ${DEFAULT_COMPLEXITY}`);
  }
  const c = complexity ?? DEFAULT_COMPLEXITY;

  // The shared part of every brief: the stance, the scope line, the ticket and the diff.
  const base = gitOk(d, ["merge-base", "origin/main", "HEAD"]).trim();
  const diff = gitOk(d, ["diff", base]);
  if (diff.trim() === "") throw new AppError(`no diff against origin/main to review`);
  const untracked = gitOk(d, ["ls-files", "--others", "--exclude-standard"]).trim();
  if (untracked) d.log(`review: untracked files are not in the diff the readers get: ${untracked.split("\n").join(", ")}`);
  const ticketText = d.ob(["show", ticket]);
  const shared = [skillBrief(d.skill()), SCOPE_LINE, `## The ticket\n\n${ticketText.out.trim() || `(ob show ${ticket} printed nothing)`}`, `## The diff\n\n\`\`\`diff\n${diff}\`\`\``].join("\n\n");

  const prior = readRunRecords(d.env).filter((r) => r.ticket === ticket);
  const answersPath = flags.answers === undefined ? null : String(flags.answers);
  // The round answered is the ticket's most recent one, whatever its number: a fresh round 1 after a rebuttal restarts the count.
  const last = prior.at(-1);
  const round = answersPath === null ? 1 : (last?.round ?? 0) + 1;
  const run = `${ticket.toLowerCase()}-r${round}-${start.getTime().toString(36)}`;
  const gitDir = gitOk(d, ["rev-parse", "--git-dir"]).trim();
  const dir = join(isAbsolute(gitDir) ? gitDir : join(d.cwd, gitDir), "ob-review", ticket, run);

  let legs: LegOutcome[];
  let escalated = false;
  let reason: string | null = null;
  if (answersPath !== null) {
    if (!last) throw new AppError(`--answers needs a previous round: ${ticket} has no recorded review round; run \`ob review run ${ticket}\` first`);
    if (!existsSync(answersPath)) throw new AppError(`no answers file at ${answersPath}`);
    const answers = parseAnswers(readFileSync(answersPath, "utf8"));
    const ran = last.legs.filter((l) => l.exit === 0 && l.verdict.wrong + l.verdict.stupid + l.verdict.overboard + l.verdict.unproven > 0);
    if (ran.length === 0) throw new AppError(`round ${last.round} of ${ticket} has no leg that returned findings to answer; run a fresh round 1`);
    const missing = ran.filter((l) => !answers.has(l.leg)).map((l) => l.leg);
    if (missing.length) throw new AppError(`the answers file has no '## <leg>' section for: ${missing.join(", ")}`);
    legs = await runLegs(
      d,
      { run, dir },
      ran.map((l) => ({
        leg: l.leg,
        ...(l.reader ? { reader: l.reader } : {}),
        model: l.model,
        phase: "rebuttal" as const,
        brief: [
          shared,
          `## Your previous findings (round ${last.round})\n\n${existsSync(l.out) ? readFileSync(l.out, "utf8").trim() : "(the previous findings file is gone)"}`,
          `## The builder's answers\n\n${answers.get(l.leg)}`,
          "Answer each previous finding `accepted` or `rejected: ...` first, in order, then any new finding, then the score.",
        ].join("\n\n"),
      })),
    );
  } else {
    const plan = planLegs(await d.readers(), c);
    legs = await runLegs(d, { run, dir }, [{ ...plan.first, phase: "round1", brief: shared }]);
    const e = escalation(legs[0]!);
    reason = e.reason;
    d.log(`review: ${e.escalate ? "escalating" : "not escalating"}: ${e.reason}`);
    if (e.escalate && plan.extra.length > 0) {
      escalated = true;
      legs.push(...(await runLegs(d, { run, dir }, plan.extra.map((x) => ({ ...x, phase: "escalation" as const, brief: shared })))));
    } else if (e.escalate) d.log("review: no Opus reader is configured to escalate to (escalation never adds a non-Opus reader)");
  }

  const record: ReviewRunRecord = { v: 1, run, ticket, round, start: start.toISOString(), end: d.now().toISOString(), gate: gateRec, complexity: c, escalated, reason, legs };
  const path = reviewRunsPath(d.env);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
  return record;
}

/** The `run` subcommand of `ob review`. */
export async function cmdReviewRun(args: string[], flags: Flags, mode: Mode, io: ConfigIO, deps: ReviewRunDeps = liveDeps(process.cwd(), io)): Promise<void> {
  const ticket = args[1];
  if (!ticket) throw new UsageError("usage: ob review run <ticket> [--complexity <1-10>] [--answers <file>] [--json]");
  const r = await reviewRun(ticket, flags, deps);
  if (mode === "json") print(JSON.stringify(r, null, 2));
  else {
    print(`review ${r.ticket} round ${r.round} (run ${r.run}), gate green at ${r.gate.sha.slice(0, 7)}, complexity ${r.complexity}`);
    if (r.reason) print(`${r.escalated ? "escalated" : "not escalated"}: ${r.reason}`);
    for (const l of r.legs) print(`  ${legLine(l)}\n    findings: ${l.out}`);
  }
  if (r.legs.every((l) => l.exit !== 0)) throw new AppError("every leg failed: no reader reviewed the diff (the run is recorded)");
}

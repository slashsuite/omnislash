// OS-210: `ob review run <ticket>` runs the gate, one round-1 reader, escalates only when round 1 calls for it, and
// records each leg's verdict and tokens (read back from review-legs.jsonl by the run id).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GateOutcome } from "../src/commands/gate.ts";
import { appendLegRecord, readLegRecords, type LegRecord } from "../src/review-legs.ts";
import { defaultReviewReaders, withRange, withReader, type ReviewReaders } from "../src/review-readers.ts";
import {
  escalation,
  parseAnswers,
  parseVerdict,
  planLegs,
  readRunRecords,
  reviewRun,
  skillBrief,
  type ReviewRunDeps,
} from "../src/review-run.ts";
import { runAcrossFallbacks } from "../../../skills/ob-skeptical-review/review-leg.ts";

const REPO = join(import.meta.dir, "../../..");
const SKILL = readFileSync(join(REPO, "skills/ob-skeptical-review/SKILL.md"), "utf8");

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ob-review-run-"));
  env = { OB_MODELS_FILE: join(dir, "models.jsonc") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const green = (ok = true): GateOutcome => ({
  result: { v: 1, sha: "abcdef1234567", file_hash: "f".repeat(64), ok, failed: ok ? null : "moon", steps: [], start: "", end: "" },
  cached: true,
  uncached: null,
});

const record = (leg: string, run: string, tokens: LegRecord["tokens"]): LegRecord => ({
  v: 1,
  leg,
  kind: "claude",
  model: "m",
  variant: null,
  profile: null,
  cwd: dir,
  start: new Date().toISOString(),
  end: new Date().toISOString(),
  wall_s: 1,
  exit_code: 0,
  signal: null,
  diff: null,
  brief_bytes: 1,
  out_bytes: 1,
  err_bytes: 0,
  tokens,
  credit: false,
  run,
});

/** Fake seams: each leg prints `outputs[leg]` and leaves a leg record under the run id with 100/10 tokens. */
function deps(outputs: Record<string, string>, over: Partial<ReviewRunDeps> = {}) {
  const ran: Array<{ leg: string; reader: string; brief: string }> = [];
  const ob: string[][] = [];
  const d: ReviewRunDeps = {
    cwd: dir,
    env,
    now: () => new Date("2026-11-26T10:00:00Z"),
    log: () => {},
    ob: (args) => (ob.push(args), { code: 0, out: args[0] === "show" ? "OS-1 the ticket text" : "complexity 5/10", err: "" }),
    git: (args) => {
      if (args[0] === "merge-base") return { code: 0, out: "base\n", err: "" };
      if (args[0] === "diff") return { code: 0, out: "+a line\n", err: "" };
      if (args[0] === "rev-parse") return { code: 0, out: `${dir}/.git\n`, err: "" };
      return { code: 0, out: "", err: "" };
    },
    gate: async () => green(),
    leg: async (reader, brief, outPath, legEnv) => {
      // the seat (`opus-2` for a second Opus seat) keys the canned output; the reader is what review-leg.ts runs
      const leg = legEnv.OB_REVIEW_SEAT ?? reader;
      ran.push({ leg, reader, brief });
      writeFileSync(outPath, outputs[leg] ?? "");
      appendLegRecord({ ...record(reader, legEnv.OB_REVIEW_RUN_ID!, { input: 100, output: 10, reasoning: 0 }), ...(leg !== reader ? { seat: leg } : {}) }, legEnv);
      return outputs[leg] === undefined ? { code: 1, err: `review-leg: ${leg} failed: exit 1: boom\n` } : { code: 0, err: "" };
    },
    skill: () => SKILL,
    readers: async () => readers,
    ...over,
  };
  return { d, ran, ob };
}

let readers: ReviewReaders = defaultReviewReaders();
beforeEach(() => {
  readers = withReader(defaultReviewReaders(), "flash", "opencode-go/qwen3.8-flash#high");
});

describe("verdicts", () => {
  test("counts findings with bullets and backticks, reads the score, and `score: none` is no score", () => {
    const v = parseVerdict("- `wrong:` a.ts:1 x\n* stupid: b\n1. overboard: c\nunproven: d\nunproven: e\naccepted\nrejected: no\nscore: 6/10");
    expect(v).toEqual({ score: 6, wrong: 1, stupid: 1, overboard: 1, unproven: 2, ok: false, accepted: 1, rejected: 1 });
    expect(parseVerdict("ok (4 hunks read)\nscore: 10/10")).toMatchObject({ ok: true, score: 10 });
    expect(parseVerdict("ok: 7 hunks read\nscore: 10/10").ok).toBe(true);
    expect(parseVerdict("score: none").score).toBeNull();
    expect(parseVerdict("the wrongness of it").wrong).toBe(0);
  });

  test("round 1 escalates on a failed leg, no score, a wrong, an unproven or a score under 8, and only then", () => {
    const v = parseVerdict;
    expect(escalation({ exit: 1, verdict: v("score: 10/10") }).escalate).toBe(true);
    expect(escalation({ exit: 0, verdict: v("ok") }).escalate).toBe(true);
    expect(escalation({ exit: 0, verdict: v("wrong: x\nscore: 9/10") }).escalate).toBe(true);
    expect(escalation({ exit: 0, verdict: v("unproven: x\nscore: 9/10") }).escalate).toBe(true);
    expect(escalation({ exit: 0, verdict: v("stupid: x\nscore: 7/10") }).escalate).toBe(true);
    expect(escalation({ exit: 0, verdict: v("stupid: x\nscore: 8/10") }).escalate).toBe(false);
  });

  test("OS-247: escalation adds one Opus reader, never neon or any non-Opus reader", () => {
    // the default: opus alone, no fallback; escalation is a second Opus seat
    expect(planLegs(readers, 5)).toEqual({
      first: { leg: "opus", model: "claude-opus-5-5" },
      extra: [{ leg: "opus-2", reader: "opus", model: "claude-opus-5-5" }],
    });
    // a non-Opus reader in the range is skipped; another configured Opus reader is preferred to a second seat
    const two = withRange(readers, { from: 4, to: 6 }, ["opus", "flash"]);
    expect(planLegs(two, 5).extra.map((e) => e.leg)).toEqual(["opus-2"]);
    const big = withReader(readers, "opus-big", "claudeAgent:claude-opus-5-5");
    expect(planLegs(big, 5).extra).toEqual([{ leg: "opus-big", model: "claudeAgent:claude-opus-5-5" }]);
    // a non-Opus round-1 reader escalates to an Opus reader, and to nobody when none is configured
    const flashFirst = withRange(readers, { from: 4, to: 6 }, ["flash"]);
    expect(planLegs(flashFirst, 5).extra).toEqual([{ leg: "opus", model: "claude-opus-5-5" }]);
    const noOpus = withRange(withReader(withReader(readers, "opus", "opencode-go/x"), "neon", "antigravity:gemini-4-neon"), { from: 4, to: 6 }, ["flash"]);
    expect(planLegs(noOpus, 5).extra).toEqual([]);
  });

  test("the brief carries the skill's stance and output format", () => {
    const b = skillBrief(SKILL);
    expect(b).toContain("## The stance");
    expect(b).toContain("score: N/10");
    expect(b).not.toContain("## Which models");
  });

  test("an answers file splits by `## <leg>`", () => {
    expect([...parseAnswers("## opus\nfixed: a.ts:1\n\n## neon\nrebutted: x\n")]).toEqual([
      ["opus", "fixed: a.ts:1"],
      ["neon", "rebutted: x"],
    ]);
  });
});

describe("reviewRun", () => {
  test("a clean round 1 runs one reader, escalates nobody, and records the leg with its tokens", async () => {
    const { d, ran, ob } = deps({ opus: "stupid: a.ts:1 x\nscore: 9/10" });
    const r = await reviewRun("OS-1", {}, d);
    expect(ran.map((x) => x.leg)).toEqual(["opus"]);
    expect(ob[0]).toEqual(["spinoff", "phase", "OS-1", "reviewing"]);
    expect(ran[0]!.brief).toContain("OS-1 the ticket text");
    expect(ran[0]!.brief).toContain("+a line");
    expect(r).toMatchObject({ round: 1, complexity: 5, escalated: false, gate: { ok: true, cached: true } });
    expect(r.legs[0]).toMatchObject({ leg: "opus", phase: "round1", exit: 0, verdict: { score: 9, stupid: 1 }, tokens: { input: 100, output: 10 } });
    expect(readRunRecords(env)).toHaveLength(1);
  });

  test("OS-295: every leg it runs gets OB_REVIEW_NO_FALLBACK=1, so review-leg.ts never runs a reader's fallback (OS-247)", async () => {
    const envs: Array<Record<string, string | undefined>> = [];
    const { d } = deps({ opus: "wrong: a.ts:1 x\nscore: 5/10", "opus-2": "score: 9/10" });
    const leg = d.leg;
    d.leg = async (reader, brief, outPath, legEnv) => (envs.push(legEnv), leg(reader, brief, outPath, legEnv));
    await reviewRun("OS-1", {}, d);
    expect(envs.length).toBe(2);
    for (const e of envs) expect(e.OB_REVIEW_NO_FALLBACK).toBe("1");
  });

  test("a round 1 that calls for it escalates to a second Opus seat, never neon, with the same brief and its own tokens", async () => {
    const { d, ran } = deps({ opus: "wrong: a.ts:1 x\nscore: 5/10", "opus-2": "ok\nscore: 9/10", neon: "score: 8/10" });
    const r = await reviewRun("OS-1", { complexity: "5" }, d);
    expect(ran.map((x) => [x.leg, x.reader])).toEqual([
      ["opus", "opus"],
      ["opus-2", "opus"],
    ]);
    expect(new Set(ran.map((x) => x.brief)).size).toBe(1);
    expect(r.escalated).toBe(true);
    expect(r.reason).toContain("1 wrong");
    // each seat reads back only its own attempt's tokens, though both ran the reader `opus` in the same run
    expect(r.legs.map((l) => [l.leg, l.phase, l.tokens?.input])).toEqual([
      ["opus", "round1", 100],
      ["opus-2", "escalation", 100],
    ]);
    // the tokens are this run's only: another run's record for the same leg is not summed in
    expect(readLegRecords(env).every((x) => x.run === r.run)).toBe(true);
  });

  test("a red gate stops the review before any leg runs", async () => {
    const { d, ran } = deps({ opus: "score: 10/10" }, { gate: async () => green(false) });
    await expect(reviewRun("OS-1", {}, d)).rejects.toThrow("gate is red");
    expect(ran).toEqual([]);
    expect(readRunRecords(env)).toEqual([]);
  });

  test("--answers runs the rebuttal round on only the legs that returned findings", async () => {
    // two Opus readers on the range: round 1 is opus, escalation is opus-big (clean), so opus-2 never runs
    readers = withRange(withReader(readers, "opus-big", "claude-opus-5-5"), { from: 4, to: 6 }, ["opus", "opus-big"]);
    const first = deps({ opus: "wrong: OPUS-FINDING\nscore: 5/10", "opus-big": "score: 9/10" });
    await reviewRun("OS-1", {}, first.d);
    // a rebuttal round of that answers opus alone: opus-big returned no finding, so it is not rerun
    writeFileSync(join(dir, "answers1.md"), "## opus\nfixed: x\n");
    const solo = deps({ opus: "accepted\nscore: 9/10" });
    expect((await reviewRun("OS-1", { answers: join(dir, "answers1.md") }, solo.d)).legs.map((l) => l.leg)).toEqual(["opus"]);
  });

  test("--answers reruns a second Opus seat as its own seat, with only its own findings and answers", async () => {
    const first = deps({ opus: "wrong: OPUS-FINDING\nscore: 5/10", "opus-2": "stupid: SEAT2-FINDING\nscore: 7/10" });
    await reviewRun("OS-1", {}, first.d);
    const answers = join(dir, "answers.md");
    writeFileSync(answers, "## opus\nfixed: OPUS-ANSWER\n## opus-2\nrebutted: SEAT2-ANSWER\n");
    const second = deps({ opus: "accepted\nscore: 9/10", "opus-2": "rejected: still\nscore: 7/10" });
    const r = await reviewRun("OS-1", { answers }, second.d);
    expect(r.round).toBe(2);
    const opus = second.ran.find((x) => x.leg === "opus")!.brief;
    expect(opus).toContain("OPUS-FINDING");
    expect(opus).toContain("OPUS-ANSWER");
    expect(opus).not.toContain("SEAT2-FINDING");
    expect(opus).not.toContain("SEAT2-ANSWER");
    expect(r.legs.map((l) => [l.leg, l.phase, l.verdict.accepted, l.verdict.rejected])).toEqual([
      ["opus", "rebuttal", 1, 0],
      ["opus-2", "rebuttal", 0, 1],
    ]);
    expect(second.ran.map((x) => x.leg)).toEqual(["opus", "opus-2"]);
    // the second seat's rebuttal runs the reader opus again, under its own seat
    expect(second.ran.find((x) => x.leg === "opus-2")!.reader).toBe("opus");
  });

  test("--answers answers the most recent round, even after a fresh round 1 restarted the count", async () => {
    await reviewRun("OS-1", {}, deps({ opus: "wrong: OLD-FINDING\nscore: 5/10", "opus-2": "score: 9/10" }).d);
    const answers = join(dir, "answers.md");
    writeFileSync(answers, "## opus\nfixed: x\n");
    await reviewRun("OS-1", { answers }, deps({ opus: "accepted\nscore: 9/10" }).d);
    const fresh = await reviewRun("OS-1", {}, deps({ opus: "wrong: NEW-FINDING\nscore: 5/10", "opus-2": "score: 9/10" }).d);
    expect(fresh.round).toBe(1);
    const again = deps({ opus: "accepted\nscore: 9/10" });
    const r = await reviewRun("OS-1", { answers }, again.d);
    expect(r.round).toBe(2);
    expect(again.ran[0]!.brief).toContain("NEW-FINDING");
    expect(again.ran[0]!.brief).not.toContain("OLD-FINDING");
  });

  test("--answers with no previous round, or missing a leg's section, is refused", async () => {
    const answers = join(dir, "answers.md");
    writeFileSync(answers, "## opus\nfixed: x\n");
    await expect(reviewRun("OS-1", { answers }, deps({}).d)).rejects.toThrow("no recorded review round");
    await reviewRun("OS-1", {}, deps({ opus: "wrong: x\nscore: 5/10", "opus-2": "stupid: y\nscore: 9/10" }).d);
    await expect(reviewRun("OS-1", { answers }, deps({}).d)).rejects.toThrow("no '## <leg>' section for: opus-2");
  });

  test("a failed round-1 leg escalates and names its error", async () => {
    const { d } = deps({ "opus-2": "score: 8/10" });
    const r = await reviewRun("OS-1", {}, d);
    expect(r.legs[0]).toMatchObject({ leg: "opus", exit: 1, error: "review-leg: opus failed: exit 1: boom" });
    expect(r.escalated).toBe(true);
  });
});

test("review-leg.ts stamps each attempt with OB_REVIEW_RUN_ID, so the driver can read its tokens back", async () => {
  const recs: LegRecord[] = [];
  await runAcrossFallbacks("opus", ["opus"], async () => ({ code: 0, out: "score: 9/10", err: "", tokens: { input: 5, output: 1, reasoning: 0 } }), () => {}, { ...env, OB_REVIEW_RUN_ID: "os-1-r1-x" }, {
    record: (r) => recs.push(r),
    diff: null,
    readers: defaultReviewReaders(),
  });
  expect(recs[0]).toMatchObject({ run: "os-1-r1-x", tokens: { input: 5 } });
  const bare: LegRecord[] = [];
  await runAcrossFallbacks("opus", ["opus"], async () => ({ code: 0, out: "", err: "" }), () => {}, env, { record: (r) => bare.push(r), diff: null, readers: defaultReviewReaders() });
  expect(bare[0]!.run).toBeUndefined();
  expect(bare[0]!.seat).toBeUndefined();
  // OS-247: a second seat stamps its seat, so its tokens are read back apart from the first seat's
  const seat: LegRecord[] = [];
  await runAcrossFallbacks("opus", ["opus"], async () => ({ code: 0, out: "", err: "" }), () => {}, { ...env, OB_REVIEW_RUN_ID: "r", OB_REVIEW_SEAT: "  opus-2 " }, {
    record: (r) => seat.push(r),
    diff: null,
    readers: defaultReviewReaders(),
  });
  expect(seat[0]).toMatchObject({ leg: "opus", seat: "opus-2", run: "r" });
  // OS-248: a seat equal to the leg, or blank, stamps nothing
  for (const s of ["opus", "   "]) {
    const same: LegRecord[] = [];
    await runAcrossFallbacks("opus", ["opus"], async () => ({ code: 0, out: "", err: "" }), () => {}, { ...env, OB_REVIEW_SEAT: s }, {
      record: (r) => same.push(r),
      diff: null,
      readers: defaultReviewReaders(),
    });
    expect(same).toHaveLength(1);
    expect(same[0]!.seat).toBeUndefined();
  }
});

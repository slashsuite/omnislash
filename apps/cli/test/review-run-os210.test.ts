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
import { runAcrossProfiles } from "../../../skills/ob-skeptical-review/review-leg.ts";

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
  const ran: Array<{ leg: string; brief: string }> = [];
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
    leg: async (leg, brief, outPath, legEnv) => {
      ran.push({ leg, brief });
      writeFileSync(outPath, outputs[leg] ?? "");
      appendLegRecord(record(leg, legEnv.OB_REVIEW_RUN_ID!, { input: 100, output: 10, reasoning: 0 }), legEnv);
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

  test("round 1 is the range's first leg; escalation is its fallback, then the range's others, then the rest, at most two", () => {
    expect(planLegs(readers, 5)).toEqual({
      first: { leg: "opus", model: "claude-opus-5-5" },
      extra: [
        { leg: "neon", model: "antigravity:gemini-4-neon" },
        { leg: "flash", model: "opencode-go/qwen3.8-flash#high" },
      ],
    });
    const two = withRange(readers, { from: 4, to: 6 }, ["flash", "opus"]);
    expect(planLegs(two, 5).first.leg).toBe("flash");
    expect(planLegs(two, 5).extra.map((e) => e.leg)).toEqual(["opus", "neon"]);
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

  test("a round 1 that calls for it escalates to two more readers, each with the same brief and its own tokens", async () => {
    const { d, ran } = deps({ opus: "wrong: a.ts:1 x\nscore: 5/10", neon: "ok\nscore: 9/10", flash: "score: 8/10" });
    const r = await reviewRun("OS-1", { complexity: "5" }, d);
    expect(ran.map((x) => x.leg)).toEqual(["opus", "neon", "flash"]);
    expect(new Set(ran.map((x) => x.brief)).size).toBe(1);
    expect(r.escalated).toBe(true);
    expect(r.reason).toContain("1 wrong");
    expect(r.legs.map((l) => [l.leg, l.phase, l.tokens?.input])).toEqual([
      ["opus", "round1", 100],
      ["neon", "escalation", 100],
      ["flash", "escalation", 100],
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

  test("--answers runs the rebuttal round: the previous legs again, each with only its own findings and answers", async () => {
    const first = deps({ opus: "wrong: OPUS-FINDING\nscore: 5/10", neon: "stupid: NEON-FINDING\nscore: 7/10", flash: "score: 9/10" });
    await reviewRun("OS-1", {}, first.d);
    const answers = join(dir, "answers.md");
    writeFileSync(answers, "## opus\nfixed: OPUS-ANSWER\n## neon\nrebutted: NEON-ANSWER\n");
    const second = deps({ opus: "accepted\nscore: 9/10", neon: "rejected: still\nscore: 7/10", flash: "score: 9/10" });
    const r = await reviewRun("OS-1", { answers }, second.d);
    expect(r.round).toBe(2);
    const opus = second.ran.find((x) => x.leg === "opus")!.brief;
    expect(opus).toContain("OPUS-FINDING");
    expect(opus).toContain("OPUS-ANSWER");
    expect(opus).not.toContain("NEON-FINDING");
    expect(opus).not.toContain("NEON-ANSWER");
    expect(r.legs.map((l) => [l.leg, l.phase, l.verdict.accepted, l.verdict.rejected])).toEqual([
      ["opus", "rebuttal", 1, 0],
      ["neon", "rebuttal", 0, 1],
    ]);
    // flash returned no finding, so it is not rerun and needs no section
    expect(second.ran.map((x) => x.leg)).toEqual(["opus", "neon"]);
  });

  test("--answers answers the most recent round, even after a fresh round 1 restarted the count", async () => {
    await reviewRun("OS-1", {}, deps({ opus: "wrong: OLD-FINDING\nscore: 5/10", neon: "score: 9/10", flash: "score: 9/10" }).d);
    const answers = join(dir, "answers.md");
    writeFileSync(answers, "## opus\nfixed: x\n");
    await reviewRun("OS-1", { answers }, deps({ opus: "accepted\nscore: 9/10" }).d);
    const fresh = await reviewRun("OS-1", {}, deps({ opus: "wrong: NEW-FINDING\nscore: 5/10", neon: "score: 9/10", flash: "score: 9/10" }).d);
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
    await reviewRun("OS-1", {}, deps({ opus: "wrong: x\nscore: 5/10", neon: "stupid: y\nscore: 9/10", flash: "score: 9/10" }).d);
    await expect(reviewRun("OS-1", { answers }, deps({}).d)).rejects.toThrow("no '## <leg>' section for: neon");
  });

  test("a failed round-1 leg escalates and names its error", async () => {
    const { d } = deps({ neon: "score: 8/10", flash: "score: 8/10" });
    const r = await reviewRun("OS-1", {}, d);
    expect(r.legs[0]).toMatchObject({ leg: "opus", exit: 1, error: "review-leg: opus failed: exit 1: boom" });
    expect(r.escalated).toBe(true);
  });
});

test("review-leg.ts stamps each attempt with OB_REVIEW_RUN_ID, so the driver can read its tokens back", async () => {
  const recs: LegRecord[] = [];
  await runAcrossProfiles("opus", [undefined], async () => ({ code: 0, out: "score: 9/10", err: "", tokens: { input: 5, output: 1, reasoning: 0 } }), () => {}, { ...env, OB_REVIEW_RUN_ID: "os-1-r1-x" }, {
    record: (r) => recs.push(r),
    diff: null,
    readers: defaultReviewReaders(),
  });
  expect(recs[0]).toMatchObject({ run: "os-1-r1-x", tokens: { input: 5 } });
  const bare: LegRecord[] = [];
  await runAcrossProfiles("opus", [undefined], async () => ({ code: 0, out: "", err: "" }), () => {}, env, { record: (r) => bare.push(r), diff: null, readers: defaultReviewReaders() });
  expect(bare[0]!.run).toBeUndefined();
});

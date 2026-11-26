import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { UsageError, AppError } from "../../../apps/cli/src/errors.ts";
import {
  COMPARE_RULES,
  compareMlxArgv,
  comparePrompt,
  expandVisionPairFlags,
  parseCompareOutput,
  parseCompareRequest,
  runVisionCompare,
  type ComparePairSpec,
} from "../../../apps/cli/src/vision/compare.ts";
import {
  stripGenerateBanner,
  VISION_MAX_TOKENS,
  VISION_MODEL_DEFAULT,
  VISION_TIMEOUT_DEFAULT_MS,
  type ProcLike,
  type SpawnProc,
} from "../../cli-whatsapp/src/whatsapp/describe.ts";
import { planExecution } from "../../../apps/cli/src/remote.ts";
import { LOCAL_ONLY_COMMANDS } from "../../../apps/cli/src/api/routing.ts";
import { OB_API_LOCAL_ONLY } from "../../../apps/cli/src/api/contract.ts";
import { HANDLERS } from "../../../apps/cli/src/cli.ts";

const FIX = join(import.meta.dir, "../../../apps/cli/test/fixtures", "vision");
const LEFT = join(FIX, "left.png");
const RIGHT = join(FIX, "right.png");
const DESIGN = join(FIX, "design.png");

function recordSpawn(...procs: ProcLike[]): {
  spawn: SpawnProc;
  calls: Array<{ cmd: string[]; opts?: Record<string, unknown> }>;
} {
  const calls: Array<{ cmd: string[]; opts?: Record<string, unknown> }> = [];
  const spawn: SpawnProc = (cmd, opts) => {
    calls.push({ cmd, ...(opts !== undefined ? { opts } : {}) });
    return procs[calls.length - 1] ?? fakeProc("NONE");
  };
  return { spawn, calls };
}

const enc = new TextEncoder();

function fakeProc(stdoutText: string, stderrText = "", exitCode: number | null = 0, signalCode: string | null = null): ProcLike {
  const stream = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(c) {
        if (text) c.enqueue(enc.encode(text));
        c.close();
      },
    });
  return {
    stdout: stream(stdoutText),
    stderr: stream(stderrText),
    exited: Promise.resolve(exitCode),
    exitCode,
    signalCode,
    stdin: { write: () => {}, end: () => {} },
  };
}

function pair(over: Partial<ComparePairSpec> = {}): ComparePairSpec {
  return { flag: null, left: LEFT, right: RIGHT, expect: null, ...over };
}

describe("expandVisionPairFlags (468)", () => {
  test("--on a b --off c d becomes two values each", () => {
    expect(expandVisionPairFlags(["vision", "compare", "--on", "a.png", "b.png", "--off", "c.png", "d.png"])).toEqual([
      "vision",
      "compare",
      "--on",
      "a.png",
      "--on",
      "b.png",
      "--off",
      "c.png",
      "--off",
      "d.png",
    ]);
  });
});

describe("parseCompareRequest (468)", () => {
  test("single pair --as design expects match", () => {
    const plan = parseCompareRequest({ args: ["compare", LEFT, RIGHT], as: "design" });
    expect(plan.as).toBe("design");
    expect(plan.pairs).toEqual([{ flag: null, left: LEFT, right: RIGHT, expect: "match" }]);
  });

  test("single pair --as old has no expect", () => {
    const plan = parseCompareRequest({ args: ["compare", LEFT, RIGHT], as: "old" });
    expect(plan.pairs[0]!.expect).toBeNull();
  });

  test("single pair --as flag expects change", () => {
    const plan = parseCompareRequest({ args: ["compare", LEFT, RIGHT], as: "flag" });
    expect(plan.pairs[0]!.expect).toBe("change");
  });

  test("--design adds a match pair against the positional right", () => {
    const plan = parseCompareRequest({ args: ["compare", LEFT, RIGHT], as: "old", design: DESIGN });
    expect(plan.pairs).toHaveLength(2);
    expect(plan.pairs[1]).toEqual({ flag: null, left: DESIGN, right: RIGHT, expect: "match" });
  });

  test("flagged pair: --off match, --on change, --design match vs after-on", () => {
    const plan = parseCompareRequest({
      args: ["compare"],
      as: "old",
      on: [LEFT, RIGHT],
      off: [LEFT, DESIGN],
      design: DESIGN,
    });
    expect(plan.pairs).toEqual([
      { flag: "off", left: LEFT, right: DESIGN, expect: "match" },
      { flag: "on", left: LEFT, right: RIGHT, expect: "change" },
      { flag: null, left: DESIGN, right: RIGHT, expect: "match" },
    ]);
  });

  test("--as flag + --on exits as usage", () => {
    expect(() => parseCompareRequest({ args: ["compare"], as: "flag", on: [LEFT, RIGHT], off: [LEFT, DESIGN] })).toThrow(
      UsageError,
    );
    try {
      parseCompareRequest({ args: ["compare"], as: "flag", on: [LEFT, RIGHT], off: [LEFT, DESIGN] });
    } catch (e) {
      expect((e as Error).message).toMatch(/--as flag cannot combine with --on\/--off/);
    }
  });

  test("--on without --off is usage", () => {
    expect(() => parseCompareRequest({ args: ["compare"], on: [LEFT, RIGHT] })).toThrow(UsageError);
  });

  test("missing file is usage", () => {
    expect(() => parseCompareRequest({ args: ["compare", LEFT, join(FIX, "gone.png")] })).toThrow(UsageError);
    try {
      parseCompareRequest({ args: ["compare", LEFT, join(FIX, "gone.png")] });
    } catch (e) {
      expect((e as Error).message).toMatch(/^missing file:/);
    }
  });
});

describe("prompt bar (468)", () => {
  test("layout / ignore-data wording is in the default prompt", () => {
    expect(COMPARE_RULES).toMatch(/LAYOUT AND CHROME TONE/);
    expect(COMPARE_RULES).toMatch(/Ignore copy, names, numbers, dates, avatars, mocked fixture text/);
    expect(COMPARE_RULES).not.toMatch(/list row contents/);
    expect(COMPARE_RULES).toMatch(/mocked fixture text/);
    expect(COMPARE_RULES).toMatch(/empty-state versus a thread is DATA/);
    expect(COMPARE_RULES).toMatch(/icon-vs-text/);
    expect(COMPARE_RULES).toMatch(/regions, spacing, alignment, clipping, overflow/);
    expect(COMPARE_RULES).toMatch(/chrome tone/);
    expect(COMPARE_RULES).toMatch(/idle versus active/);
    expect(COMPARE_RULES).toMatch(/Do not report hex/);
    expect(COMPARE_RULES).toMatch(/List-row chrome/);
    expect(COMPARE_RULES).toMatch(/List-row chrome is NOT data/);
    expect(COMPARE_RULES).toMatch(/label baseline/);
    expect(COMPARE_RULES).toMatch(/tall empty well versus shrink-wrapped/);
    expect(COMPARE_RULES).toMatch(/A page title or search field that is only lighter or darker grey \(same hue family\) is NOT a diff/);
  });

  test("prompt-bar bans are baked in", () => {
    expect(COMPARE_RULES).toContain("more compact");
    expect(COMPARE_RULES).toContain("more streamlined");
    expect(COMPARE_RULES).toContain("everything moved up");
    expect(COMPARE_RULES).toContain("Teams +");
    expect(COMPARE_RULES).toContain("Calls appearing");
    expect(COMPARE_RULES).toContain("moved higher");
    expect(COMPARE_RULES).toMatch(/title \+ search field versus Chats\/Calls tabs/);
  });

  test("flag-off / flag-on pairs are labelled", () => {
    expect(comparePrompt(pair({ flag: "off" }))).toMatch(/flag OFF/);
    expect(comparePrompt(pair({ flag: "on" }))).toMatch(/flag ON/);
  });
});

describe("mlx argv (468)", () => {
  test("one compare is --image LEFT RIGHT", () => {
    expect(
      compareMlxArgv({
        bin: process.execPath,
        model: VISION_MODEL_DEFAULT,
        prompt: COMPARE_RULES,
        left: LEFT,
        right: RIGHT,
      }),
    ).toEqual([
      process.execPath,
      "--model",
      VISION_MODEL_DEFAULT,
      "--prompt",
      COMPARE_RULES,
      "--image",
      LEFT,
      RIGHT,
      "--max-tokens",
      String(VISION_MAX_TOKENS),
    ]);
  });
});

describe("parseCompareOutput + chrome strip (468)", () => {
  test("NONE after banner strip is empty diffs", () => {
    const raw =
      "==========\nPrompt: x\n==========\nNONE\nPrompt: 12 tokens\nGeneration: 1 tokens\nPeak memory: 1 GB";
    expect(stripGenerateBanner(raw)).toBe("NONE");
    expect(parseCompareOutput(raw)).toEqual([]);
  });

  test("WHERE/WHAT lines become diffs", () => {
    expect(parseCompareOutput("WHERE listing header\nWHAT title+search became Chats/Calls tabs")).toEqual([
      { where: "listing header", what: "title+search became Chats/Calls tabs" },
    ]);
  });
});

describe("runVisionCompare enforce (468)", () => {
  const engine = (spawn: SpawnProc) => ({ bin: process.execPath, spawn });

  test("--off + empty diffs → exit 0", async () => {
    const { spawn, calls } = recordSpawn(fakeProc("NONE"));
    const plan = parseCompareRequest({ args: ["compare"], as: "old", on: [LEFT, RIGHT], off: [LEFT, DESIGN] });
    const offOnly = { ...plan, pairs: plan.pairs.filter((p) => p.flag === "off") };
    const res = await runVisionCompare(offOnly, engine(spawn));
    expect(res.exit).toBe(0);
    expect(res.json.ok).toBe(true);
    expect(res.json.pairs[0]).toMatchObject({ flag: "off", expect: "match", ok: true, diffs: [] });
    expect(calls[0]!.cmd).toContain("--image");
    expect(calls[0]!.cmd).toContain(LEFT);
    expect(calls[0]!.cmd).toContain(DESIGN);
    expect(calls[0]!.opts!.timeout).toBe(VISION_TIMEOUT_DEFAULT_MS);
  });

  test("--off + a diff → exit 1", async () => {
    const { spawn } = recordSpawn(fakeProc("WHERE listing header\nWHAT new tabs leaked"));
    const plan = parseCompareRequest({ args: ["compare"], as: "old", on: [LEFT, RIGHT], off: [LEFT, DESIGN] });
    const offOnly = { ...plan, pairs: plan.pairs.filter((p) => p.flag === "off") };
    const res = await runVisionCompare(offOnly, engine(spawn));
    expect(res.exit).toBe(1);
    expect(res.json.ok).toBe(false);
    expect(res.json.pairs[0]!.expect).toBe("match");
    expect(res.json.pairs[0]!.ok).toBe(false);
    expect(res.json.pairs[0]!.diffs).toEqual([{ where: "listing header", what: "new tabs leaked" }]);
  });

  test("--on + empty diffs → exit 1", async () => {
    const { spawn } = recordSpawn(fakeProc("NONE"));
    const plan = parseCompareRequest({ args: ["compare"], as: "old", on: [LEFT, RIGHT], off: [LEFT, DESIGN] });
    const onOnly = { ...plan, pairs: plan.pairs.filter((p) => p.flag === "on") };
    const res = await runVisionCompare(onOnly, engine(spawn));
    expect(res.exit).toBe(1);
    expect(res.json.pairs[0]).toMatchObject({ flag: "on", expect: "change", ok: false, diffs: [] });
  });

  test("--on + a diff → exit 0", async () => {
    const { spawn } = recordSpawn(fakeProc("WHERE listing header\nWHAT title+search became tabs+icon bar"));
    const plan = parseCompareRequest({ args: ["compare"], as: "old", on: [LEFT, RIGHT], off: [LEFT, DESIGN] });
    const onOnly = { ...plan, pairs: plan.pairs.filter((p) => p.flag === "on") };
    const res = await runVisionCompare(onOnly, engine(spawn));
    expect(res.exit).toBe(0);
    expect(res.json.pairs[0]!.ok).toBe(true);
    expect(res.json.pairs[0]!.diffs.length).toBe(1);
  });

  test("--design + a diff → exit 1", async () => {
    const { spawn } = recordSpawn(fakeProc("WHERE header\nWHAT missing tabs"));
    const plan = parseCompareRequest({ args: ["compare", LEFT, RIGHT], design: DESIGN });
    const designOnly = { ...plan, pairs: plan.pairs.filter((p) => p.expect === "match") };
    const res = await runVisionCompare(designOnly, engine(spawn));
    expect(res.exit).toBe(1);
    expect(res.json.pairs[0]!.expect).toBe("match");
    expect(res.json.pairs[0]!.ok).toBe(false);
  });

  test("--no-enforce exits 0 with diffs", async () => {
    const { spawn } = recordSpawn(fakeProc("WHERE header\nWHAT leak"));
    const plan = parseCompareRequest({
      args: ["compare"],
      as: "old",
      on: [LEFT, RIGHT],
      off: [LEFT, DESIGN],
      noEnforce: true,
    });
    const offOnly = { ...plan, pairs: plan.pairs.filter((p) => p.flag === "off") };
    const res = await runVisionCompare(offOnly, engine(spawn));
    expect(res.exit).toBe(0);
    expect(res.json.ok).toBe(false);
    expect(res.json.pairs[0]!.diffs.length).toBe(1);
  });

  test("mlx failure exits 1 and never invents diffs", async () => {
    const { spawn } = recordSpawn(fakeProc("", "Cannot find model", 1));
    const plan = parseCompareRequest({ args: ["compare", LEFT, RIGHT], as: "design" });
    await expect(runVisionCompare(plan, engine(spawn))).rejects.toBeInstanceOf(AppError);
  });

  test("--json expect/ok shape", async () => {
    const { spawn } = recordSpawn(
      fakeProc("NONE"),
      fakeProc("NONE"),
      fakeProc("NONE"),
      fakeProc("WHERE listing header\nWHAT tabs"),
      fakeProc("NONE"),
      fakeProc("NONE"),
    );
    const plan = parseCompareRequest({ args: ["compare"], as: "old", on: [LEFT, RIGHT], off: [LEFT, DESIGN] });
    const res = await runVisionCompare(plan, engine(spawn));
    expect(res.json).toEqual({
      as: "old",
      ok: true,
      pairs: [
        { flag: "off", left: LEFT, right: DESIGN, expect: "match", ok: true, diffs: [] },
        {
          flag: "on",
          left: LEFT,
          right: RIGHT,
          expect: "change",
          ok: true,
          diffs: [{ where: "listing header", what: "tabs" }],
        },
      ],
    });
  });
});

describe("classification (468)", () => {
  test("vision is a HANDLER, local-only run, nodb", () => {
    expect(HANDLERS.vision).toBeDefined();
    expect(LOCAL_ONLY_COMMANDS.get("vision")?.disposition).toBe("run");
    expect(OB_API_LOCAL_ONLY.vision).toMatch(/mlx-vlm/);
    expect(planExecution({ command: "vision", args: ["compare"], flags: {}, host: "ob@server" }).mode).toBe("nodb");
    expect(planExecution({ command: "vision", args: ["compare"], flags: {}, host: null }).mode).toBe("nodb");
  });
});

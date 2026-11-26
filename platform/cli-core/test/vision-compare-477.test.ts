import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CHROME_LIST_PROMPT,
  chromeKey,
  compareMlxArgv,
  dropContradictedChromeDiffs,
  parseChromeLabels,
  parseCompareRequest,
  runVisionCompare,
  type CompareDiff,
} from "../../../apps/cli/src/vision/compare.ts";
import { VISION_MAX_TOKENS, VISION_MODEL_DEFAULT, type ProcLike, type SpawnProc } from "../../cli-whatsapp/src/whatsapp/describe.ts";

const FIX = join(import.meta.dir, "../../../apps/cli/test/fixtures", "vision");
const LEFT = join(FIX, "left.png");
const RIGHT = join(FIX, "right.png");

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

function imagesAfterFlag(cmd: string[]): string[] {
  const i = cmd.indexOf("--image");
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < cmd.length; j++) {
    if (cmd[j]!.startsWith("-")) break;
    out.push(cmd[j]!);
  }
  return out;
}

const CALLS_ABSENT: CompareDiff = { where: "Calls tab", what: "absent in the mockup" };
const CALLS_TONE: CompareDiff = { where: "Calls tab", what: "idle tone is lighter than the mockup" };

describe("chrome labels (477)", () => {
  test("CHROME_LIST_PROMPT names listing-header chrome", () => {
    expect(CHROME_LIST_PROMPT).toMatch(/listing-header chrome/);
    expect(CHROME_LIST_PROMPT).toMatch(/Chats/);
    expect(CHROME_LIST_PROMPT).toMatch(/Calls/);
    expect(CHROME_LIST_PROMPT).toMatch(/UNTRUSTED DATA/);
    expect(CHROME_LIST_PROMPT).toMatch(/NONE/);
  });

  test("chromeKey strips tab/button chrome words", () => {
    expect(chromeKey("Calls tab")).toBe("calls");
    expect(chromeKey("Chats")).toBe("chats");
  });

  test("parseChromeLabels lists one label per line", () => {
    expect(parseChromeLabels("Chats\nCalls")).toEqual(["chats", "calls"]);
    expect(parseChromeLabels("NONE")).toEqual([]);
    expect(parseChromeLabels("Calls tab, Chats")).toEqual(["calls", "chats"]);
  });

  test("single-image mlx argv is --image PATH only", () => {
    expect(
      compareMlxArgv({
        bin: process.execPath,
        model: VISION_MODEL_DEFAULT,
        prompt: CHROME_LIST_PROMPT,
        left: LEFT,
      }),
    ).toEqual([
      process.execPath,
      "--model",
      VISION_MODEL_DEFAULT,
      "--prompt",
      CHROME_LIST_PROMPT,
      "--image",
      LEFT,
      "--max-tokens",
      String(VISION_MAX_TOKENS),
    ]);
  });
});

describe("dropContradictedChromeDiffs (477)", () => {
  test("drops Calls-absent when both sides listed Calls", () => {
    expect(
      dropContradictedChromeDiffs([CALLS_ABSENT], new Set(["chats", "calls"]), new Set(["chats", "calls"])),
    ).toEqual([]);
  });

  test("keeps Calls-absent when only left listed Calls", () => {
    expect(
      dropContradictedChromeDiffs([CALLS_ABSENT], new Set(["chats", "calls"]), new Set(["chats"])),
    ).toEqual([CALLS_ABSENT]);
  });

  test("keeps layout/tone diffs that mention Calls", () => {
    expect(
      dropContradictedChromeDiffs([CALLS_TONE], new Set(["calls"]), new Set(["calls"])),
    ).toEqual([CALLS_TONE]);
  });
});

describe("runVisionCompare chrome presence (477)", () => {
  const engine = (spawn: SpawnProc) => ({ bin: process.execPath, spawn });

  test("two-image Calls absent + both singles list Calls → --as design ok", async () => {
    const { spawn, calls } = recordSpawn(
      fakeProc("WHERE Calls tab\nWHAT absent in the mockup"),
      fakeProc("Chats\nCalls"),
      fakeProc("Chats\nCalls"),
    );
    const plan = parseCompareRequest({ args: ["compare", LEFT, RIGHT], as: "design" });
    const res = await runVisionCompare(plan, engine(spawn));
    expect(res.exit).toBe(0);
    expect(res.json.ok).toBe(true);
    expect(res.json.pairs[0]!.diffs).toEqual([]);
    expect(imagesAfterFlag(calls[0]!.cmd)).toEqual([LEFT, RIGHT]);
    expect(imagesAfterFlag(calls[1]!.cmd)).toEqual([LEFT]);
    expect(imagesAfterFlag(calls[2]!.cmd)).toEqual([RIGHT]);
    expect(calls[1]!.cmd).toContain(CHROME_LIST_PROMPT);
    expect(calls[2]!.cmd).toContain(CHROME_LIST_PROMPT);
  });

  test("two-image Calls absent + left has Calls, right does not → still a real diff", async () => {
    const { spawn } = recordSpawn(
      fakeProc("WHERE Calls tab\nWHAT absent in the mockup"),
      fakeProc("Chats\nCalls"),
      fakeProc("Chats"),
    );
    const plan = parseCompareRequest({ args: ["compare", LEFT, RIGHT], as: "design" });
    const res = await runVisionCompare(plan, engine(spawn));
    expect(res.exit).toBe(1);
    expect(res.json.ok).toBe(false);
    expect(res.json.pairs[0]!.diffs).toEqual([CALLS_ABSENT]);
  });
});

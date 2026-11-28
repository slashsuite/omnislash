import { describe, expect, test } from "bun:test";
import { parseModelsFile, retiredReviewMessage } from "../../../apps/cli/src/models-file.ts";
import { parseReviewReaders } from "../../../apps/cli/src/review-readers.ts";

// OS-206: DeepSeek and Luna are no longer part of the review setup. A models profile or a review_readers
// setting that names either one (or a model id that does) is refused with a clear message, never run.
describe("retired review readers (OS-206)", () => {
  test("the retirement check names deepseek, luna and model ids that name them, and nothing else", () => {
    expect(retiredReviewMessage("deepseek")).toContain("retired (OS-206)");
    expect(retiredReviewMessage("luna")).toContain("use opus, or a reader `ob review readers` lists");
    expect(retiredReviewMessage("neon", "opencode-go/gpt-6-luna#high")).toContain("'luna'");
    expect(retiredReviewMessage("opus", "claude-opus-5-5")).toBeNull();
    expect(retiredReviewMessage("neon", "antigravity:gemini-4-neon")).toBeNull();
  });

  test("a models profile whose review map names deepseek loads without it, with a warning", () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warned.push(String(m));
    try {
      const text = JSON.stringify({
        active: "p",
        profiles: { p: { review: { neon: "antigravity:gemini-4-neon", deepseek: "opencode-go/deepseek-v4.1-flash#high" } } },
      });
      const file = parseModelsFile(text, "/x/models.jsonc");
      expect(file.profiles.p!.review).toEqual({ neon: "antigravity:gemini-4-neon" });
    } finally {
      console.warn = orig;
    }
    expect(warned.join("\n")).toMatch(/dropped review reader 'deepseek' is retired \(OS-206\)/);
  });

  test("a models profile whose review model id names luna drops that entry, keeps the rest, and warns", () => {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warned.push(String(m));
    try {
      const text = JSON.stringify({ active: "p", profiles: { p: { review: { opus: "claude-opus-5-5", neon: "opencode-go/gpt-6-luna#high" } } } });
      const file = parseModelsFile(text, "/x/models.jsonc");
      expect(file.profiles.p!.review).toEqual({ opus: "claude-opus-5-5" });
    } finally {
      console.warn = orig;
    }
    expect(warned.join("\n")).toMatch(/retired/);
  });

  test("a review_readers setting that names luna drops it with a warning, and the rest still parses", () => {
    const luna = JSON.stringify({
      readers: { neon: { model: "antigravity:gemini-4-neon" }, luna: { model: "opencode-go/gpt-6-luna#high" } },
      tiers: [{ from: 1, to: 10, legs: ["neon"] }],
    });
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (m: string) => warned.push(String(m));
    try {
      const v = parseReviewReaders(luna);
      expect(Object.keys(v.readers)).toEqual(["neon"]);
      expect(v.tiers[0]!.legs).toEqual(["neon"]);
    } finally {
      console.warn = orig;
    }
    expect(warned.join("\n")).toMatch(/review reader 'luna' is retired \(OS-206\)/);

    const ok = JSON.stringify({
      readers: { neon: { model: "antigravity:gemini-4-neon" }, opus: { model: "claude-opus-5-5" } },
      tiers: [{ from: 1, to: 10, legs: ["neon", "opus"] }],
    });
    expect(parseReviewReaders(ok).tiers[0]!.legs).toEqual(["neon", "opus"]);
  });
});

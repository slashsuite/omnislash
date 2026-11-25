import { describe, expect, test } from "bun:test";
import { parseModelsFile, retiredReviewMessage } from "../../../apps/cli/src/models-file.ts";
import { parseReviewReaders } from "../../../apps/cli/src/review-readers.ts";

// OS-206: DeepSeek and Luna are no longer part of the review setup. A models profile or a review_readers
// setting that names either one (or a model id that does) is refused with a clear message, never run.
describe("retired review readers (OS-206)", () => {
  test("the retirement check names deepseek, luna and model ids that name them, and nothing else", () => {
    expect(retiredReviewMessage("deepseek")).toContain("retired (OS-206)");
    expect(retiredReviewMessage("luna")).toContain("use neon or opus");
    expect(retiredReviewMessage("neon", "opencode-go/gpt-6-luna#high")).toContain("'luna'");
    expect(retiredReviewMessage("opus", "claude-opus-5-5")).toBeNull();
    expect(retiredReviewMessage("neon", "antigravity:gemini-4-neon")).toBeNull();
  });

  test("a models profile whose review map names deepseek is refused by name", () => {
    const text = JSON.stringify({
      active: "p",
      profiles: { p: { review: { neon: "antigravity:gemini-4-neon", deepseek: "opencode-go/deepseek-v4.1-flash#high" } } },
    });
    expect(() => parseModelsFile(text, "/x/models.jsonc")).toThrow(/review: review reader 'deepseek' is retired \(OS-206\)/);
  });

  test("a models profile whose review model id names luna is refused", () => {
    const text = JSON.stringify({ active: "p", profiles: { p: { review: { opus: "opencode-go/gpt-6-luna#high" } } } });
    expect(() => parseModelsFile(text, "/x/models.jsonc")).toThrow(/retired/);
  });

  test("a review_readers setting that names luna is refused, and neon and opus still parse", () => {
    const luna = JSON.stringify({
      readers: { neon: { model: "antigravity:gemini-4-neon" }, luna: { model: "opencode-go/gpt-6-luna#high" } },
      tiers: [{ from: 1, to: 10, legs: ["neon"] }],
    });
    expect(() => parseReviewReaders(luna)).toThrow(/review reader 'luna' is retired \(OS-206\)/);

    const ok = JSON.stringify({
      readers: { neon: { model: "antigravity:gemini-4-neon" }, opus: { model: "claude-opus-5-5" } },
      tiers: [{ from: 1, to: 10, legs: ["neon", "opus"] }],
    });
    expect(parseReviewReaders(ok).tiers[0]!.legs).toEqual(["neon", "opus"]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  headlessRunArgv,
  OPENCODE_HEADLESS_MODEL,
  OPENCODE_HEADLESS_VISION_MODEL,
} from "../../../apps/cli/src/headless-run.ts";
import { DEFAULTS } from "../../../apps/cli/src/settings.ts";

describe("headlessRunArgv (536) — shared opencode run fixture", () => {
  test("argv includes run and -m opencode-go/deepseek-v4-flash", () => {
    const argv = headlessRunArgv({ prompt: "ping" });
    expect(argv).toContain("run");
    expect(argv[argv.indexOf("-m") + 1]).toBe("opencode-go/deepseek-v4-flash");
    expect(argv[0]).toBe("opencode");
    expect(argv).toContain("--auto");
    expect(argv.at(-1)).toBe("ping");
  });

  test("setting default matches the pinned flash id", () => {
    expect(DEFAULTS.opencode_headless_model).toBe(OPENCODE_HEADLESS_MODEL);
    expect(OPENCODE_HEADLESS_MODEL).toBe("opencode-go/deepseek-v4-flash");
  });

  test("describe (images) pins the vision-exp model and attaches --file", () => {
    const argv = headlessRunArgv({
      model: OPENCODE_HEADLESS_VISION_MODEL,
      prompt: "describe this",
      files: ["/tmp/pic.jpg"],
    });
    expect(argv).toContain("run");
    expect(argv[argv.indexOf("-m") + 1]).toBe("opencode-go/deepseek-v4-flash-vision-exp");
    expect(argv[argv.indexOf("--file") + 1]).toBe("/tmp/pic.jpg");
  });

  test("an empty model falls back to the flash pin", () => {
    const argv = headlessRunArgv({ model: "  ", prompt: "x" });
    expect(argv[argv.indexOf("-m") + 1]).toBe(OPENCODE_HEADLESS_MODEL);
  });
});

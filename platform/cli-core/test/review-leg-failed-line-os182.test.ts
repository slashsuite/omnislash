// OS-182: a failed review leg ends on one stderr line saying why, for the review line to copy:
// `review-leg: <leg> failed: exit <n>: <first line of the child stderr>`.
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failedLegLine } from "../../../skills/ob-skeptical-review/review-leg.ts";
import { spawnBudget } from "../../../apps/cli/test/helpers.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");
const REVIEW_LEG_SCRIPT = join(REPO_ROOT, "skills/ob-skeptical-review/review-leg.ts");

describe("OS-182: failedLegLine", () => {
  test("names the leg, the exit code and the child's first non-blank stderr line", () => {
    expect(failedLegLine("neon", 1, "\n  model gemini-4-neon unavailable  \nsecond line\n")).toBe(
      "review-leg: neon failed: exit 1: model gemini-4-neon unavailable",
    );
  });

  test("says so when the child printed nothing on stderr", () => {
    expect(failedLegLine("opus", 2, "")).toBe("review-leg: opus failed: exit 2: no stderr");
    expect(failedLegLine("opus", 124, "", true)).toBe("review-leg: opus failed: exit 124: timed out");
  });

  test("a leg killed for time says timed out, not the progress line it printed before", () => {
    expect(failedLegLine("neon", 124, "starting up\n", true)).toBe("review-leg: neon failed: exit 124: timed out");
  });
});

describe("OS-182: review-leg.ts ends a failed leg on that line", () => {
  test("a leg whose tool exits 1 prints the failed line last on stderr and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-os182-leg-"));
    try {
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      const agy = join(binDir, "agy");
      writeFileSync(agy, "#!/usr/bin/env bash\necho 'model gemini-4-neon unavailable' >&2\necho 'detail' >&2\nexit 1\n");
      chmodSync(agy, 0o755);
      const proc = Bun.spawnSync(["bun", REVIEW_LEG_SCRIPT, "neon"], {
        cwd: REPO_ROOT,
        stdin: new Blob(["review this small diff"]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          TMPDIR: dir,
          OB_MODELS_FILE: join(dir, "models.jsonc"),
          OB_REVIEW_READERS_SKIP: "1",
        },
      });
      expect(proc.exitCode).toBe(1);
      const lines = proc.stderr.toString().trim().split("\n");
      expect(lines.at(-1)).toBe("review-leg: neon failed: exit 1: model gemini-4-neon unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, spawnBudget(3));

  test("an agy that reports its error in JSON with nothing on stderr: the reason reaches the failed line", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-os182-leg-"));
    try {
      const binDir = join(dir, "bin");
      mkdirSync(binDir);
      const agy = join(binDir, "agy");
      writeFileSync(agy, `#!/usr/bin/env bash\necho '{"status":"ERROR","error":"model gemini-4-neon unavailable"}'\nexit 0\n`);
      chmodSync(agy, 0o755);
      const proc = Bun.spawnSync(["bun", REVIEW_LEG_SCRIPT, "neon"], {
        cwd: REPO_ROOT,
        stdin: new Blob(["review this small diff"]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          TMPDIR: dir,
          OB_MODELS_FILE: join(dir, "models.jsonc"),
          OB_REVIEW_READERS_SKIP: "1",
        },
      });
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString().trim().split("\n").at(-1)).toBe(
        "review-leg: neon failed: exit 1: agy status ERROR: model gemini-4-neon unavailable",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, spawnBudget(3));

  test("a tool that is not installed is a failed leg that says why", () => {
    const dir = mkdtempSync(join(tmpdir(), "ob-os182-leg-"));
    try {
      const proc = Bun.spawnSync(["bun", REVIEW_LEG_SCRIPT, "neon"], {
        cwd: REPO_ROOT,
        stdin: new Blob(["review this small diff"]),
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          // An empty bin dir and bun's own dir only: no agy.
          PATH: `${join(dir, "empty")}:${join(process.execPath, "..")}`,
          TMPDIR: dir,
          OB_MODELS_FILE: join(dir, "models.jsonc"),
          OB_REVIEW_READERS_SKIP: "1",
        },
      });
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString().trim().split("\n").at(-1)).toMatch(/^review-leg: neon failed: exit 1: .*agy/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, spawnBudget(2));
});

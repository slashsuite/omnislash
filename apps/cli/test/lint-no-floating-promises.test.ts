import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Typecheck cannot see a discarded promise. This lints the fixture, a bare `addTags(db, id, tags)` whose
// promise is dropped (the shape that once silently broke tagging), with the repo's own .oxlintrc.json, and
// asserts typescript/no-floating-promises fires. The repo lint ignores test/fixtures/**, so the fixture
// never fails the gate; this test is what proves the rule would catch it.
//
// It lints a copy in a scratch directory: the root config without its ignore list, and the fixture with its
// own tsconfig as tsconfig.json beside it, so the type-aware pass builds a program of one file instead of
// the whole CLI.
const fixtures = join(import.meta.dir, "fixtures");
const root = join(import.meta.dir, "../../..");
const rootConfig = join(root, ".oxlintrc.json");
// The workspace's own pinned binaries: outside the repo, bunx would fetch a fresh oxlint without tsgolint.
const bin = join(root, "node_modules/.bin");

describe("no-floating-promises", () => {
  test(
    "a bare addTags(db, id, tags) fails typescript/no-floating-promises",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "lint-floating-"));
      try {
        const config = JSON.parse(readFileSync(rootConfig, "utf8")) as Record<string, unknown>;
        delete config.ignorePatterns;
        writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify(config));
        copyFileSync(join(fixtures, "tsconfig.lint.json"), join(dir, "tsconfig.json"));
        copyFileSync(join(fixtures, "no-floating-promises.ts"), join(dir, "no-floating-promises.ts"));
        const run = Bun.spawnSync(
          [join(bin, "oxlint"), "--type-aware", "-c", ".oxlintrc.json", "no-floating-promises.ts"],
          { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, OXLINT_TSGOLINT_PATH: join(bin, "tsgolint") } },
        );
        const out = `${run.stdout.toString()}${run.stderr.toString()}`;
        expect(out, `expected no-floating-promises on the fixture, got:\n${out}`).toContain("(no-floating-promises)");
        expect(run.exitCode).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

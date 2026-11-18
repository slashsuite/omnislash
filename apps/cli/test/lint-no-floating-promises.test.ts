import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ESLint } from "eslint";
// OB-2217: loaded at module scope so bun's 5s per-test clock times the lint, not the load. ESLint's
// own loader imports eslint.config.js inside lintFiles, and that file pulls in typescript-eslint and
// with it the TypeScript compiler; measured inside the test, that load was half the test's time and
// grew to most of it on a loaded box. With the package already in the module cache, the config file
// is a 10 ms import and the rest is the lint itself.
import "typescript-eslint";

// ob 338 — typecheck cannot see a discarded promise. This unit lints the fixture that is
// the exact `addTags(db, id, tags)` shape that silently broke `ob tag` in 337, and asserts
// the rule fires. `moon run cli:lint` excludes test/fixtures/** so the fixture does not fail the
// gate; this test is what proves the rule would have caught the 337 bug.
//
// OB-2058 — it used to inherit apps/cli's eslint.config.js, whose projectService built the CLI's whole
// TypeScript program just to type this 10-line fixture, which ran past bun's 5s test timeout on a
// loaded box. The fixture now has its own tsconfig (test/fixtures/tsconfig.lint.json), so the program
// is the fixture and the TS libs (since OB-2217 only lib.es5, which declares Promise, rather than all 89
// lib files ESNext pulls in). That the rule still fires inside the real program is
// `moon run cli:lint`'s job, on the untouched real config.
describe("no-floating-promises (ob 338)", () => {
  test("bare addTags(db, id, tags) fails @typescript-eslint/no-floating-promises", async () => {
    const cwd = join(import.meta.dir, "..");
    const eslint = new ESLint({
      cwd,
      // `project` rather than the project service, so typescript-eslint builds the fixture's small
      // program instead of discovering apps/cli/tsconfig.json by walking up from the fixture.
      overrideConfig: {
        files: ["test/fixtures/**/*.ts"],
        languageOptions: {
          parserOptions: {
            projectService: false,
            project: "./test/fixtures/tsconfig.lint.json",
            tsconfigRootDir: cwd,
          },
        },
      },
    });
    const results = await eslint.lintFiles([
      join(import.meta.dir, "fixtures/no-floating-promises.ts"),
    ]);
    const messages = results.flatMap((r) => r.messages);
    expect(
      messages.some((m) => m.ruleId === "@typescript-eslint/no-floating-promises"),
      `expected no-floating-promises on the fixture, got: ${JSON.stringify(messages)}`,
    ).toBe(true);
  });
});

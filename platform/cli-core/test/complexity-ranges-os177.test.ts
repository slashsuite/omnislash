// OS-177: the builder routes are ranges of a 1-10 complexity score. These are the Done-when checks that are not
// about a launch (the launch, urgent and credit checks live in platform/cli-coord/test/t3-dispatch.test.ts and
// spinoff-urgent-tier.test.ts, beside the fake T3 they need).

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelForComplexity, parseModelsFile } from "../../../apps/cli/src/models-file.ts";
import { ModelRoutesError, builderModelsOf, emptyRouteInputs, parseModelRoutes, resolveRoute, withRoute } from "../../../apps/cli/src/model-routes.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "apps/cli/src/index.ts");
const FIXTURES = join(import.meta.dir, "fixtures/os177-models");

function fileWith(routes: Record<string, string>, builder?: Record<string, string>): string {
  const r = Object.fromEntries(Object.entries(routes).map(([k, m]) => [k, { chain: [m] }]));
  return JSON.stringify({ active: "p", profiles: { p: { routes: r, ...(builder ? { builder } : {}) } } });
}

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("OS-177: a builder range set must cover 1-10 exactly once", () => {
  test("a gap is refused, naming the scores left out", () => {
    const msg = refusal(() => parseModelsFile(fileWith({ "builder.1-3": "a", "builder.5-10": "b" }), "m.jsonc"));
    expect(msg).toContain("m.jsonc: profile 'p': builder ranges leave a gap at 4:");
  });

  test("an overlap is refused, naming both ranges and the shared scores", () => {
    const msg = refusal(() => parseModelsFile(fileWith({ "builder.1-4": "a", "builder.4-10": "b" }), "m.jsonc"));
    expect(msg).toContain("builder ranges 1-4 and 4-10 overlap at 4:");
  });

  test("a layer mixing the range form and the old tier form is refused, naming both", () => {
    const routes = refusal(() => parseModelsFile(fileWith({ "builder.simple": "a", "builder.1-3": "b", "builder.4-10": "c" }), "m.jsonc"));
    expect(routes).toContain("mixes builder ranges (builder.1-3, builder.4-10) with the old tier form (builder.simple)");
    const builderKeys = refusal(() => parseModelsFile(fileWith({ "builder.1-10": "b" }, { simple: "a" }), "m.jsonc"));
    expect(builderKeys).toContain("mixes builder ranges (builder.1-10) with the old tier form (builder.simple)");
  });

  test("the server's model_routes is held to the same rule", () => {
    const value = JSON.stringify({ active: "p", profiles: { p: { routes: { "builder.1-3": { chain: ["a"] }, "builder.5-10": { chain: ["b"] } } } } });
    expect(() => parseModelRoutes(value)).toThrow(ModelRoutesError);
    expect(refusal(() => parseModelRoutes(value))).toContain("model_routes profile 'p': builder ranges leave a gap at 4");
  });

  test("a file in either single form parses", () => {
    expect(() => parseModelsFile(fileWith({ "builder.1-2": "a", "builder.3-10": "b" }), "m")).not.toThrow();
    expect(() => parseModelsFile(fileWith({ "builder.simple": "a" }), "m")).not.toThrow();
    expect(() => parseModelsFile("{}", "m")).not.toThrow();
  });
});

describe("OS-177: the score picks the range covering it", () => {
  test("role.* runs on the range covering 8 of a custom split", () => {
    const file = parseModelsFile(fileWith({ "builder.1-3": "haiku", "builder.4-4": "sonnet", "builder.5-10": "opus" }), "m.jsonc");
    expect(resolveRoute({ ...emptyRouteInputs(), file }, "role.architect").chain).toEqual(["claudeAgent:opus"]); // a role thread names its provider
  });

  test("the old tier form reads as the ranges 1-3, 4-6 and 7-10", () => {
    const file = parseModelsFile(fileWith({ "builder.simple": "s", "builder.medium": "m", "builder.complex": "c" }), "m.jsonc");
    const bands = builderModelsOf({ ...emptyRouteInputs(), file });
    expect([1, 3, 4, 6, 7, 10].map((c) => modelForComplexity(bands, c))).toEqual(["s", "s", "m", "m", "c", "c"]);
  });
});

describe("OS-177: `ob models set builder.<from>-<to>` on the server", () => {
  const tm = { simple: "h", medium: "s", complex: "opencode:opencode-go/x" };
  const empty = emptyRouteInputs({ tierModels: tm }).server;

  test("a partial range on a profile with no builder set of its own is refused, so no default band lands on the server", () => {
    expect(refusal(() => withRoute(empty, "default", "builder.4-4", ["s"], undefined, tm))).toContain("profile 'default' has no full builder set on the server");
  });

  test("builder.1-10 first, then a carve, keeps every band the user's and role.* on the user's 8", () => {
    const whole = withRoute(empty, "default", "builder.1-10", ["claudeAgent:o"], undefined, tm);
    const carved = withRoute(whole, "default", "builder.4-4", ["s"], undefined, tm);
    expect(Object.keys(carved.profiles.default!.routes).sort()).toEqual(["builder.1-3", "builder.4-4", "builder.5-10"]);
    expect(resolveRoute({ ...emptyRouteInputs({ tierModels: tm }), server: carved }, "role.architect").chain).toEqual(["claudeAgent:o"]);
  });
});

describe("OS-177: `ob models show` is unchanged for the files in use today", () => {
  for (const profile of ["claude", "antigravity"]) {
    test(`the ${profile} profile prints what it printed before OS-177`, () => {
      const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-os177-"));
      try {
        mkdirSync(join(dir, "cfg"));
        const modelsFile = join(dir, "cfg", "models.jsonc");
        copyFileSync(join(FIXTURES, `${profile}.jsonc`), modelsFile);
        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          OMNISLASH_STORE: "sqlite",
          OMNISLASH_DB_CREATE: "1",
          OMNISLASH_DB: join(dir, "ob.sqlite"),
          OB_REMOTE: "0",
          OMNISLASH_API: "",
          OMNISLASH_API_URL_FILE: join(dir, "no-api-url"),
          OB_MODELS_FILE: modelsFile,
        };
        const r = Bun.spawnSync(["bun", CLI_ENTRY, "models", "show"], { env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
        expect(r.exitCode).toBe(0);
        const shown = r.stdout.toString().replace(/^models file: .*$/m, "models file: <file>");
        expect(shown).toBe(readFileSync(join(FIXTURES, `show-${profile}.txt`), "utf8"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

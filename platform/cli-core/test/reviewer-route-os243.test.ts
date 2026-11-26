// OS-243: the `checker` model route is now `reviewer` (OS-236 merged the checker into the reviewer role). The old
// name is read as the new one for one release: on the command line, in a machine's models file and on the server,
// and the server stores the route under the old name until then so an older ob still parses the setting.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REVIEWER, FIXED_ROUTES, parseModelsFile } from "../../../apps/cli/src/models-file.ts";
import { MODEL_ROUTES_KEY, emptyRouteInputs, parseModelRoutes, resolveRoute, saveModelRoutes, withRoute, withoutRoute } from "../../../apps/cli/src/model-routes.ts";
import type { ConfigIO } from "../../../apps/cli/src/review-readers.ts";

const CLI_ENTRY = join(import.meta.dir, "../../../apps/cli/src/index.ts");

function memIo(): ConfigIO & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, get: async (k) => data[k] ?? null, set: async (k, v) => void (data[k] = v) };
}

describe("OS-243: the reviewer route", () => {
  test("reviewer is the fixed route; checker is not listed but resolves to it", () => {
    expect(FIXED_ROUTES).toContain("reviewer");
    expect(FIXED_ROUTES as readonly string[]).not.toContain("checker");
    const r = resolveRoute(emptyRouteInputs(), "checker");
    expect(r).toMatchObject({ route: "reviewer", chain: [DEFAULT_REVIEWER], source: "default" });
  });

  test("a server setting stored under checker reads as reviewer; reviewer wins when both are stored", () => {
    const old = parseModelRoutes(JSON.stringify({ active: "p", profiles: { p: { routes: { checker: { chain: ["a"] } } } } }));
    expect(old.profiles.p!.routes).toEqual({ reviewer: { chain: ["a"] } });
    const both = parseModelRoutes(JSON.stringify({ active: "p", profiles: { p: { routes: { checker: { chain: ["a"] }, reviewer: { chain: ["b"] } } } } }));
    expect(both.profiles.p!.routes).toEqual({ reviewer: { chain: ["b"] } });
  });

  test("set and unset take either name, and the server stores it under checker for older ob", async () => {
    const io = memIo();
    const set = withRoute({ ...parseModelRoutes(null), active: "p" }, "p", "reviewer", ["claude-opus-5-5"]);
    expect(set.profiles.p!.routes).toEqual({ reviewer: { chain: ["claude-opus-5-5"] } });
    await saveModelRoutes(io, set);
    const stored = JSON.parse(io.data[MODEL_ROUTES_KEY]!);
    expect(stored.profiles.p.routes).toEqual({ checker: { chain: ["claude-opus-5-5"] } });
    const back = parseModelRoutes(io.data[MODEL_ROUTES_KEY]);
    expect(resolveRoute(emptyRouteInputs({ server: back }), "reviewer")).toMatchObject({ chain: ["claude-opus-5-5"], source: "server" });
    expect(withoutRoute(back, "p", "checker").profiles.p!.routes).toEqual({});
    expect(withRoute(parseModelRoutes(null), "p", "checker", ["x"]).profiles.p!.routes).toEqual({ reviewer: { chain: ["x"] } });
  });

  test("a models file's checker key and checker route read as reviewer; the reviewer key wins", () => {
    const file = parseModelsFile(JSON.stringify({ active: "p", profiles: { p: { checker: "a", routes: { checker: { chain: ["b"] } } } } }), "m.jsonc");
    expect(file.profiles.p).toMatchObject({ reviewer: "a", routes: { reviewer: { chain: ["b"] } } });
    expect(resolveRoute(emptyRouteInputs({ file }), "reviewer")).toMatchObject({ chain: ["b"], source: "local" });
    const keyOnly = parseModelsFile(JSON.stringify({ active: "p", profiles: { p: { checker: "a", reviewer: "c" } } }), "m.jsonc");
    expect(resolveRoute(emptyRouteInputs({ file: keyOnly }), "checker")).toMatchObject({ route: "reviewer", chain: ["c"], source: "local" });
  });

  test("ob models get checker prints the reviewer model and a note naming the new route", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-os243-"));
    try {
      const modelsFile = join(dir, "models.jsonc");
      writeFileSync(modelsFile, JSON.stringify({ active: "p", profiles: { p: { reviewer: "claude-sonnet-5-5" } } }));
      const env = {
        ...(process.env as Record<string, string>),
        OMNISLASH_STORE: "sqlite",
        OMNISLASH_DB_CREATE: "1",
        OMNISLASH_DB: join(dir, "ob.db"),
        OB_REMOTE: "0",
        OMNISLASH_API: "",
        OMNISLASH_API_URL_FILE: join(dir, "no-api-url"),
        OB_MODELS_FILE: modelsFile,
      };
      const run = (args: string[]) => {
        const r = Bun.spawnSync(["bun", CLI_ENTRY, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
        return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
      };
      const old = run(["models", "get", "checker"]);
      expect(old.code).toBe(0);
      expect(old.out.trim()).toBe("claude-sonnet-5-5");
      expect(old.err).toContain("note: route 'checker' is now 'reviewer'");
      const now = run(["models", "get", "reviewer"]);
      expect(now.out.trim()).toBe("claude-sonnet-5-5");
      expect(now.err).not.toContain("is now");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

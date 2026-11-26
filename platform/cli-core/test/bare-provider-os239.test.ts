// OS-239: a builder or role route without a provider prefix runs on each T3 project's own default model, so
// `ob models set` and the dashboard's writes refuse one, and `ob models show` flags one already stored.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRoutesError, bareModelRefusal, emptyModelRoutes, withRoute } from "../../../apps/cli/src/model-routes.ts";

const CLI_ENTRY = join(import.meta.dir, "../../..", "apps/cli/src/index.ts");

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ModelRoutesError) return e.message;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("OS-239: builder and role routes name their provider", () => {
  test("withRoute refuses a bare id on builder.* and role.*, naming the <provider>:<model> form", () => {
    const empty = emptyModelRoutes();
    const msg = refusal(() => withRoute(empty, "default", "builder.1-10", ["claude-opus-5-5"]));
    expect(msg).toContain("builder.1-10: model 'claude-opus-5-5' has no provider");
    expect(msg).toContain("<provider>:<model>");
    expect(msg).toContain("claudeAgent:claude-opus-5-5");
    expect(refusal(() => withRoute(empty, "default", "builder.medium", ["claudeAgent:claude-opus-5-5", "claude-sonnet-5-5"]))).toContain("'claude-sonnet-5-5'");
    expect(refusal(() => withRoute(empty, "default", "role.architect", ["claude-opus-5-5"]))).toContain("role.architect: model 'claude-opus-5-5' has no provider");
  });

  test("a qualified id is taken, and routes other than builder and role still take a bare one", () => {
    const empty = emptyModelRoutes();
    expect(withRoute(empty, "default", "builder.1-10", ["claudeAgent:claude-opus-5-5"]).profiles.default!.routes["builder.1-10"]!.chain).toEqual(["claudeAgent:claude-opus-5-5"]);
    expect(withRoute(empty, "default", "role.sentinel", ["antigravity:gemini-4-neon"]).profiles.default!.routes["role.sentinel"]).toBeDefined();
    for (const route of ["checker", "sweep.first", "subagent.explore", "job.nightly"]) {
      expect(bareModelRefusal(route, ["claude-haiku-5-5"])).toBeNull();
      expect(withRoute(empty, "default", route, ["claude-haiku-5-5"]).profiles.default!.routes[route]).toBeDefined();
    }
  });

  test("CLI: `ob models set` refuses a bare builder id and stores nothing; `show` flags a bare one already stored", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-os239-"));
    try {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        OMNISLASH_STORE: "sqlite",
        OMNISLASH_DB_CREATE: "1",
        OMNISLASH_DB: join(dir, "server.sqlite"),
        OB_REMOTE: "0",
        OMNISLASH_API: "",
        OMNISLASH_API_URL_FILE: join(dir, "no-api-url"),
        OB_MODELS_FILE: join(dir, "models.jsonc"),
      };
      const ob = (args: string[]) => {
        const r = Bun.spawnSync(["bun", CLI_ENTRY, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
        return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
      };

      const refused = ob(["models", "set", "builder.1-10", "claude-opus-5-5"]);
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("builder.1-10: model 'claude-opus-5-5' has no provider");
      expect(refused.err).toContain("<provider>:<model>");
      expect(ob(["models", "set", "role.architect", "claude-opus-5-5"]).code).not.toBe(0);
      expect(ob(["models", "show", "--json"]).out).not.toContain('"server"');

      // What 2026-11-26 had stored: bare builder and role ids, written before this check (raw, as an older ob did).
      const stored = { active: "default", fallback: [], profiles: { default: { routes: { "builder.1-10": { chain: ["claude-opus-5-5"] }, "role.architect": { chain: ["claude-opus-5-5"] }, checker: { chain: ["claude-haiku-5-5"] } } } } };
      expect(ob(["config", "set", "model_routes", JSON.stringify(stored)]).code).toBe(0);
      const shown = ob(["models", "show"]);
      expect(shown.code).toBe(0);
      expect(shown.out).toContain("warning: these builder or role routes name no provider");
      expect(shown.out).toMatch(/builder\.1-10\s+claude-opus-5-5\s+\[server\]\s+fix: ob models set builder\.1-10 claudeAgent:claude-opus-5-5/);
      expect(shown.out).toMatch(/role\.architect\s+claude-opus-5-5\s+\[server\]/);
      const json = JSON.parse(ob(["models", "show", "--json"]).out) as { bare_routes: Array<{ route: string; models: string[]; source: string }> };
      expect(json.bare_routes.map((b) => b.route).sort()).toEqual(["builder.1-10", "role.architect"]);

      // fixed by hand, as on the day: the flag goes away; the defaults (bare, never stored) are never flagged
      expect(ob(["models", "set", "builder.1-10", "claudeAgent:claude-opus-5-5"]).code).toBe(0);
      expect(ob(["models", "set", "role.architect", "claudeAgent:claude-opus-5-5"]).code).toBe(0);
      expect(ob(["models", "show"]).out).not.toContain("warning: these builder or role routes");
      expect(ob(["models", "unset", "builder"]).code).toBe(0);
      expect(JSON.parse(ob(["models", "show", "--json"]).out).bare_routes).toEqual([]);

      // The old tier form stores builder.complex: the fix names that key, keeps the whole chain, and only claude-* ids get claudeAgent:.
      const tiers = { active: "default", fallback: [], profiles: { default: { routes: { "builder.complex": { chain: ["claude-opus-5-5", "antigravity:gemini-4-neon", "gemini-4-neon"] } } } } };
      expect(ob(["config", "set", "model_routes", JSON.stringify(tiers)]).code).toBe(0);
      expect(ob(["models", "show"]).out).toContain("fix: ob models set builder.complex claudeAgent:claude-opus-5-5,antigravity:gemini-4-neon,<provider>:gemini-4-neon");

      // A bare id in this machine's file is fixed in the file, not on the server.
      expect(ob(["config", "set", "model_routes", ""]).code).toBe(0);
      writeFileSync(env.OB_MODELS_FILE!, JSON.stringify({ active: "local", profiles: { local: { routes: { "builder.1-10": { chain: ["claude-opus-5-5"] } } } } }));
      const local = ob(["models", "show"]);
      expect(local.out).toMatch(/builder\.1-10\s+claude-opus-5-5\s+\[local\]\s+fix: edit .*models\.jsonc: give builder\.1-10 a provider/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

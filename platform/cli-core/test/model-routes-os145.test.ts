// OS-145: one setting (`model_routes`) and `ob models` for which model runs every use. These are the ticket's
// Done-when checks that are not about a launch (the launch, fallback and role-thread checks live in
// platform/cli-coord/test/t3-dispatch.test.ts, beside the fake T3 they need).

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_REVIEWER, DEFAULT_TIER_MODELS, FIXED_ROUTES } from "../../../apps/cli/src/models-file.ts";
import { emptyRouteInputs, resolveReview, resolveRoute, sourceLabel, type ModelRoutes } from "../../../apps/cli/src/model-routes.ts";
import { loadRouteInputs, teamRoleModelFrom } from "../../../apps/cli/src/model-routes-io.ts";
import { pickUnderLimit } from "../../../apps/cli/src/commands/models.ts";
import type { ConfigIO } from "../../../apps/cli/src/review-readers.ts";

const REPO_ROOT = join(import.meta.dir, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "apps/cli/src/index.ts");

function memIo(seed: Record<string, string> = {}): ConfigIO & { data: Record<string, string> } {
  const data = { ...seed };
  return { data, get: async (k) => data[k] ?? null, set: async (k, v) => void (data[k] = v) };
}

async function withScratch<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-os145-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One `ob` process on one "machine": its own models file and state, the shared store standing in for the server. */
function machine(dir: string, name: string, dbPath: string) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    OMNISLASH_STORE: "sqlite",
    OMNISLASH_DB_CREATE: "1",
    OMNISLASH_DB: dbPath,
    OB_REMOTE: "0",
    OMNISLASH_API: "",
    OMNISLASH_API_URL_FILE: join(dir, `${name}-no-api-url`),
    OB_MODELS_FILE: join(dir, name, "models.jsonc"),
  };
  return (args: string[]) => {
    const r = Bun.spawnSync(["bun", CLI_ENTRY, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
}

describe("OS-145: model routes", () => {
  test("defaults equal today's behaviour: nothing set anywhere", async () => {
    const inputs = emptyRouteInputs();
    expect(resolveRoute(inputs, "builder.simple").chain).toEqual([DEFAULT_TIER_MODELS.simple]);
    expect(resolveRoute(inputs, "builder.medium").chain).toEqual([DEFAULT_TIER_MODELS.medium]);
    expect(resolveRoute(inputs, "builder.complex").chain).toEqual([DEFAULT_TIER_MODELS.complex]);
    expect(DEFAULT_TIER_MODELS).toEqual({ simple: "claude-haiku-5-5", medium: "claude-sonnet-5-5", complex: "claude-opus-5-5" });
    expect(resolveRoute(inputs, "reviewer").chain).toEqual([DEFAULT_REVIEWER]);
    for (const role of ["architect", "sentinel", "muse"]) expect(resolveRoute(inputs, `role.${role}`).chain).toEqual(["claudeAgent:claude-opus-5-5"]);
    expect(resolveRoute(inputs, "sweep.first").chain).toEqual(["claude-haiku-5-5"]);
    expect(resolveRoute(inputs, "sweep.escalate").chain).toEqual(["claude-opus-5-5"]);
    for (const r of FIXED_ROUTES) expect(resolveRoute(inputs, r).source).toBe("default");
    // Sonnet runs only where it ran before OS-145: the medium builder tier
    expect(FIXED_ROUTES.filter((r) => resolveRoute(inputs, r).chain.join(",").includes("sonnet"))).toEqual(["builder.medium"]);
    // job.* follows builder.complex and says so
    expect(sourceLabel(resolveRoute(inputs, "job.nightly-sweep"))).toBe("default (builder.complex)");
    // a role thread with nothing set opens on the T3 project's default, as before
    expect(await teamRoleModelFrom(memIo(), "architect")).toBeUndefined();
    // the review readers are the one built-in leg: opus reads every score, on the default builder.complex model (OS-256, OS-299)
    expect(resolveReview(inputs).value.readers).toEqual({ opus: { model: DEFAULT_TIER_MODELS.complex } });
    expect(resolveReview(inputs).value.tiers.map((r) => r.legs)).toEqual([["opus"], ["opus"], ["opus"]]);
    // spinoff_tier_models still sets the builder default layer
    const tiered = await loadRouteInputs(memIo({ spinoff_tier_models: '{"medium":"claude-opus-5-5"}' }));
    expect(resolveRoute(tiered, "builder.medium")).toMatchObject({ chain: ["claude-opus-5-5"], source: "default" });
  });

  test("precedence: local file over server over default, each labelled", async () => {
    await withScratch(async (dir) => {
      const server: ModelRoutes = {
        active: "work",
        fallback: [],
        profiles: {
          work: {
            routes: {
              "builder.medium": { chain: ["claudeAgent:claude-opus-5-5"] },
              "builder.simple": { chain: ["antigravity:gemini-4-neon"], effort: "low" },
            },
          },
        },
      };
      const file = join(dir, "models.jsonc");
      writeFileSync(file, JSON.stringify({ profiles: { work: { routes: { "builder.medium": { chain: ["claudeAgent:claude-haiku-5-5"] } } } } }));
      const saved = process.env.OB_MODELS_FILE;
      process.env.OB_MODELS_FILE = file;
      try {
        const inputs = await loadRouteInputs(memIo({ model_routes: JSON.stringify(server) }));
        const medium = resolveRoute(inputs, "builder.medium");
        expect([medium.chain, sourceLabel(medium)]).toEqual([["claudeAgent:claude-haiku-5-5"], "local"]);
        const simple = resolveRoute(inputs, "builder.simple");
        expect([simple.chain, simple.effort, sourceLabel(simple)]).toEqual([["antigravity:gemini-4-neon"], "low", "server"]);
        const complex = resolveRoute(inputs, "builder.complex");
        expect([complex.chain, sourceLabel(complex)]).toEqual([["claude-opus-5-5"], "default"]);
        const role = resolveRoute(inputs, "role.architect");
        expect(sourceLabel(role)).toBe("default");

        // An unreachable server leaves the file and the defaults, with one stderr line
        const down: ConfigIO = { get: async () => Promise.reject(new Error("ECONNREFUSED")), set: async () => {} };
        const lines: string[] = [];
        const write = process.stderr.write.bind(process.stderr);
        process.stderr.write = ((c: string) => (lines.push(String(c)), true)) as typeof process.stderr.write;
        let offline;
        try {
          offline = await loadRouteInputs(down);
        } finally {
          process.stderr.write = write;
        }
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain("model_routes could not be read from the server (ECONNREFUSED)");
        expect(resolveRoute(offline, "builder.simple").source).toBe("default");
      } finally {
        if (saved === undefined) delete process.env.OB_MODELS_FILE;
        else process.env.OB_MODELS_FILE = saved;
      }
    });
  });

  test("two processes: `ob models set builder.medium <a>,<b>` on one machine is what the other reads", async () => {
    await withScratch((dir) => {
      const db = join(dir, "server.sqlite");
      const a = machine(dir, "a", db);
      const b = machine(dir, "b", db);
      const set = a(["models", "set", "builder.medium", "claudeAgent:claude-opus-5-5,antigravity:gemini-4-neon"]);
      if (process.env.OS145_PRINT) console.log(`$ ob models set builder.medium claudeAgent:claude-opus-5-5,antigravity:gemini-4-neon\n${set.out}${set.err}`);
      expect(set.code).toBe(0);
      expect(set.out).toContain("builder.medium = claudeAgent:claude-opus-5-5, antigravity:gemini-4-neon [server, profile default]");

      const shown = b(["models", "show"]);
      if (process.env.OS145_PRINT) console.log(`$ ob models show   (the other process)\n${shown.out}${shown.err}`);
      expect(shown.code).toBe(0);
      expect(shown.out).toMatch(/builder\.medium\s+claudeAgent:claude-opus-5-5, antigravity:gemini-4-neon\s+\[server\]/);
      expect(shown.out).toMatch(/builder\.simple\s+claude-haiku-5-5\s+\[default\]/);
      const json = JSON.parse(b(["models", "show", "--json"]).out) as { routes: Array<{ route: string; chain: string[]; label: string }> };
      expect(json.routes.find((r) => r.route === "builder.medium")).toMatchObject({ chain: ["claudeAgent:claude-opus-5-5", "antigravity:gemini-4-neon"], label: "server" });

      // every write validates: a bad effort, an unknown route and an empty chain are refused, nothing stored
      expect(a(["models", "set", "builder.medium", "claude-opus-5-5", "--effort", "huge"]).code).not.toBe(0);
      expect(a(["models", "set", "builder.huge", "claude-opus-5-5"]).code).not.toBe(0);
      expect(a(["models", "set", "job.Bad_Name", "claude-opus-5-5"]).code).not.toBe(0);
      expect(a(["models", "set", "builder.medium", ","]).code).not.toBe(0);
      expect(b(["models", "get", "builder.medium"]).out.trim()).toBe("claudeAgent:claude-opus-5-5");
      const unset = a(["models", "unset", "builder.medium"]);
      expect(unset.code).toBe(0);
      expect(b(["models", "get", "builder.medium"]).out.trim()).toBe("claude-sonnet-5-5");
    });
  });

  test("`get sweep.first` prints Haiku and `get sweep.escalate` prints Opus", async () => {
    await withScratch((dir) => {
      const run = machine(dir, "a", join(dir, "server.sqlite"));
      expect(run(["models", "get", "sweep.first"]).out.trim()).toBe("claude-haiku-5-5");
      expect(run(["models", "get", "sweep.escalate"]).out.trim()).toBe("claude-opus-5-5");
      const unknown = run(["models", "get", "sweep.third"]);
      expect(unknown.code).not.toBe(0);
    });
  });

  test("get: the first chain entry whose provider is under its weekly limit; the first when the reading fails", () => {
    const chain = ["claudeAgent:claude-opus-5-5", "antigravity:gemini-4-neon"];
    expect(pickUnderLimit(chain, (m) => m.startsWith("claudeAgent"))).toBe("antigravity:gemini-4-neon");
    expect(pickUnderLimit(chain, () => false)).toBe("claudeAgent:claude-opus-5-5");
    expect(pickUnderLimit(chain, () => null)).toBe("claudeAgent:claude-opus-5-5");
    expect(
      pickUnderLimit(chain, () => {
        throw new Error("no usage data");
      }),
    ).toBe("claudeAgent:claude-opus-5-5");
    expect(pickUnderLimit(chain, () => true)).toBe("claudeAgent:claude-opus-5-5");
  });

  test("reader add glm, then reader tier simple glm, changes the review-leg legs; remove refuses a leg still in a tier", async () => {
    await withScratch((dir) => {
      const run = machine(dir, "a", join(dir, "server.sqlite"));
      expect(run(["review", "readers", "--tier", "simple", "-q"]).out.trim().split("\n")).toEqual(["opus"]);
      const add = run(["models", "reader", "add", "glm", "glm-5.3-flash"]);
      expect(add.code).toBe(0);
      const tier = run(["models", "reader", "tier", "simple", "glm"]);
      expect(tier.code).toBe(0);
      // what the review leg reads (`ob review readers`, skills/ob-skeptical-review/review-leg.ts)
      expect(run(["review", "readers", "--tier", "simple", "-q"]).out.trim().split("\n")).toEqual(["glm"]);
      const all = JSON.parse(run(["review", "readers", "--json"]).out) as { stored: boolean; readers: Record<string, { model: string }> };
      expect(all.stored).toBe(true);
      expect(all.readers.glm!.model).toBe("glm-5.3-flash");

      const refused = run(["models", "reader", "remove", "glm"]);
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("range 1-3");
      expect(run(["models", "reader", "tier", "simple", "opus"]).code).toBe(0);
      expect(run(["models", "reader", "remove", "glm"]).code).toBe(0);
      expect(Object.keys((JSON.parse(run(["review", "readers", "--json"]).out) as { readers: object }).readers)).not.toContain("glm");
    });
  });

  test("`ob models use` writes the server's active; a local active wins on its machine and both commands say so", async () => {
    await withScratch((dir) => {
      const db = join(dir, "server.sqlite");
      const a = machine(dir, "a", db);
      expect(a(["models", "set", "role.architect", "antigravity:gemini-4-neon", "--profile", "neon"]).code).toBe(0);
      expect(a(["models", "use", "nowhere"]).code).not.toBe(0);
      const used = a(["models", "use", "neon"]);
      expect(used.code).toBe(0);
      expect(used.out).toContain("active profile: neon on the server");
      expect(a(["models", "show"]).out).toContain("active profile: neon [server]");

      const b = machine(dir, "b", db);
      const bFile = join(dir, "b", "models.jsonc");
      mkdirSync(join(dir, "b"), { recursive: true });
      writeFileSync(bFile, JSON.stringify({ active: "mine", profiles: { mine: { routes: {} } } }));
      expect(b(["models", "show"]).out).toContain("active profile: mine [this machine's models file, hiding the server's 'neon']");
      const bUse = b(["models", "use", "neon"]);
      expect(bUse.code).toBe(0);
      expect(bUse.err).toContain("this machine's models file sets active 'mine', which still wins here");
    });
  });

  test("a named --profile is made ready, not live; `use` takes only server profiles; a mistyped local active is refused by name", async () => {
    await withScratch((dir) => {
      const db = join(dir, "server.sqlite");
      const a = machine(dir, "a", db);
      expect(a(["models", "set", "builder.medium", "antigravity:gemini-4-neon", "--profile", "neon"]).code).toBe(0);
      expect(a(["models", "get", "builder.medium"]).out.trim()).toBe("claude-sonnet-5-5");
      expect(a(["models", "show"]).out).not.toContain("active profile: neon");

      const b = machine(dir, "b", db);
      mkdirSync(join(dir, "b"), { recursive: true });
      const bFile = join(dir, "b", "models.jsonc");
      writeFileSync(bFile, JSON.stringify({ profiles: { mine: { routes: {} } } }));
      const localOnly = b(["models", "use", "mine"]);
      expect(localOnly.code).not.toBe(0);
      expect(localOnly.err).toContain("only in this machine's models file");

      writeFileSync(bFile, JSON.stringify({ active: "claud", profiles: { claude: { routes: { "builder.medium": { chain: ["claudeAgent:claude-opus-5-5"] } } } } }));
      const typo = b(["models", "get", "builder.medium"]);
      expect(typo.code).not.toBe(0);
      expect(typo.err).toContain("'claud'");
      expect(b(["models", "show"]).code).toBe(0); // show still reports it, so the typo can be found
    });
  });
});

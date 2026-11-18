// OB-2278: `ob usage day`. Fixture transcripts are invented and small (fixtures/usage-2278); the row lookup
// and the agent registry are faked through the seam, so nothing reads the live tracker or the real home.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { migratedDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import {
  CLASS_WEIGHT,
  PRICE_PER_MTOK,
  __setUsageNameSources,
  NOT_OB_PROJECT,
  buildNamer,
  buildProjectOf,
  callCost,
  cwdSlug,
  scanUsage,
} from "../../../apps/cli/src/commands/usage.ts";

const FIX = join(import.meta.dir, "fixtures/usage-2278");
const ROOT = join(FIX, "projects");
const DAY = { since: new Date("2026-11-17T00:00:00Z"), until: new Date("2026-11-18T00:00:00Z") };
const PREV = { since: new Date("2026-11-16T00:00:00Z"), until: new Date("2026-11-17T00:00:00Z") };

// By hand, dollars per million input-equivalent tokens times the class weights:
const A = 3.36e-6 * (10 + 5 * 100 + 0.1 * 1000 + 2 * 200); // opus, split over two records, 1h write
const B = 3.36e-6 * (5 * 10 + 0.1 * 100000); // opus, sidechain
const D = 7.0e-6 * (1000 + 1.25 * 500); // fable, old-style cache_creation_input_tokens (5 minute)
const E = 0.34e-6 * (5 * 2000); // haiku, in a subagents/ file
const F = 1.77e-6 * 100; // sonnet
const P = 0.34e-6 * (5 * 1000); // haiku, the day before

const ROWS = [
  { ticket_ref: "OB-2276", repo: "acme", worktree: "/home/u/dev/acme.ob-2276", brief: "OB-2276 · GitHub webhooks into ob\n\n## Problem" },
];
const PROJECTS = ["acme", "hackcove", "StayAwake"];
const projectOf = buildProjectOf(PROJECTS, ROWS, "/home/u");
const SOURCES = { rows: async () => ROWS, agents: async () => AGENTS, projects: async () => PROJECTS, home: "/home/u" };
const AGENTS = [{ id: "architect-acme", worktree: "/home/u/dev/acme" }, { id: "ob-2276", worktree: "/home/u/dev/acme.ob-2276" }];

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { t: process.env.OB_USAGE_TRANSCRIPTS, c: process.env.OB_USAGE_T3_CACHE };
  process.env.OB_USAGE_TRANSCRIPTS = ROOT;
  process.env.OB_USAGE_T3_CACHE = join(FIX, "claudeAgent.json");
});
afterEach(() => {
  __setUsageNameSources(null);
  if (saved.t === undefined) delete process.env.OB_USAGE_TRANSCRIPTS;
  else process.env.OB_USAGE_TRANSCRIPTS = saved.t;
  if (saved.c === undefined) delete process.env.OB_USAGE_T3_CACHE;
  else process.env.OB_USAGE_T3_CACHE = saved.c;
});

describe("the price table and formula (4b)", () => {
  test("one record's estimated cost equals the table and formula by hand", () => {
    expect(PRICE_PER_MTOK).toEqual({ opus: 3.36, sonnet: 1.77, haiku: 0.34, fable: 7.0 });
    expect(CLASS_WEIGHT).toEqual({ input: 1, output: 5, cacheRead: 0.1, write5m: 1.25, write1h: 2 });
    const c = callCost("claude-opus-5-5", {
      input_tokens: 10,
      output_tokens: 100,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 200,
      cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 },
    });
    expect(c.total).toBeCloseTo(0.0033936, 10);
    expect(c.total).toBeCloseTo(A, 12);
    expect(c.context).toBe(1210);
  });
});

describe("the scan (1, 2)", () => {
  test("totals, by model, by class, main vs subagent", () => {
    const [r] = scanUsage(ROOT, [DAY]);
    expect(r!.total.calls).toBe(5);
    expect(r!.total.cost).toBeCloseTo(A + B + D + E + F, 12);
    expect(r!.byModel.map((m) => [m.model, m.calls])).toEqual([
      ["claude-opus-5-5", 2],
      ["claude-fable-5-2", 1],
      ["claude-haiku-5-5", 1],
      ["claude-sonnet-5-5", 1],
    ]);
    const cls = r!.byClass;
    expect(cls.input + cls.output + cls.cacheRead + cls.cacheWrite).toBeCloseTo(r!.total.cost, 12);
    expect(cls.cacheWrite).toBeCloseTo(3.36e-6 * 400 + 7e-6 * 625, 12);
    expect(cls.cacheRead).toBeCloseTo(3.36e-6 * (100 + 10000), 12);
    expect(r!.main.calls).toBe(3);
    expect(r!.subagent.calls).toBe(2);
    expect(r!.subagent.cost).toBeCloseTo(B + E, 12);
  });

  test("a split message counts once; outside the window and <synthetic> count zero", () => {
    const [r] = scanUsage(ROOT, [DAY]);
    const opus = r!.byModel.find((m) => m.model === "claude-opus-5-5")!;
    expect(opus.calls).toBe(2); // msg_a once, msg_b; msg_c is on the 15th
    expect(r!.byModel.some((m) => m.model === "<synthetic>")).toBe(false);
  });

  test("a subagents/ file folds into its parent session; peak context is the main conversation's", () => {
    const [r] = scanUsage(ROOT, [DAY]);
    const s2 = r!.sessions.find((s) => s.session === "s2")!;
    expect(s2.calls).toBe(2);
    expect(s2.cost).toBeCloseTo(D + E, 12);
    expect(s2.peakContext).toBe(1500);
    const s1 = r!.sessions.find((s) => s.session === "s1")!;
    expect(s1.peakContext).toBe(1210); // the sidechain's 100k read is not the main context
  });

  test("project lines are ob projects only; every other cwd is one 'not an ob project' line (#610)", () => {
    const [r] = scanUsage(ROOT, [DAY], { project: projectOf });
    expect(r!.projects.map((p) => [p.name, p.calls])).toEqual([
      ["acme", 4], // the ob-2276 worktree (from a subdirectory) and the main checkout with its subagent
      [NOT_OB_PROJECT, 1],
    ]);
    expect(r!.projects[1]!.cost).toBeCloseTo(F, 12);
    const [none] = scanUsage(ROOT, [DAY]);
    expect(none!.projects.map((p) => p.name)).toEqual([NOT_OB_PROJECT]);
  });

  test("no transcript directory names the path", () => {
    expect(() => scanUsage(join(FIX, "nope"), [DAY])).toThrow(join(FIX, "nope"));
  });
});

describe("ob projects (#610)", () => {
  test("a cwd inside a project's checkout, worktree or T3 worktree is that project; anything else is null", () => {
    expect(projectOf("/home/u/dev/acme")).toBe("acme");
    expect(projectOf("/home/u/dev/acme/apps/cli")).toBe("acme");
    expect(projectOf("/home/u/dev/hackcove.hc-262")).toBe("hackcove");
    expect(projectOf("/home/u/dev/stayawake")).toBe("StayAwake");
    expect(projectOf("/home/u/.t3/worktrees/hackcove/t3-a7c1eb93")).toBe("hackcove");
    expect(projectOf("/home/u/dev/hackcove-docs")).toBeNull(); // a sibling directory, not a checkout
    expect(projectOf("/home/u/dev/cue-backend")).toBeNull(); // not in ob project list
    expect(projectOf("/home/u/.t3/scratch/2026-11-16-x")).toBeNull();
    expect(projectOf("/home/u/dev")).toBeNull();
    expect(projectOf(null)).toBeNull();
  });

  test("a spinoff row's worktree outside ~/dev belongs to its repo's project", () => {
    const rows = [{ ticket_ref: "HC-9", repo: "owner/hackcove", worktree: "/srv/wt/hc-9", brief: null }];
    expect(buildProjectOf(PROJECTS, rows, "/home/u")("/srv/wt/hc-9/packages/ui")).toBe("hackcove");
  });
});

describe("names (4)", () => {
  test("cwdSlug matches Claude Code's directory names", () => {
    expect(cwdSlug("/home/owner/dev/acme.ob-2278")).toBe("-home-owner-dev-acme-ob-2278");
  });

  test("a builder worktree names its ticket, the main checkout its role thread, an unknown slug itself", () => {
    const name = buildNamer(ROWS, AGENTS);
    expect(name("-home-u-dev-acme-ob-2276")).toBe("OB-2276 · GitHub webhooks into ob");
    expect(name("-home-u-dev-acme")).toBe("architect-acme");
    expect(name("-home-u-other")).toBe("-home-u-other");
  });

  test("with no role row, the main checkout reads <repo> · architect", () => {
    expect(buildNamer(ROWS, [])("-home-u-dev-acme")).toBe("acme · architect");
  });
});

describe("ob usage day (1, 3, 5)", () => {
  const ARGS = ["usage", "day", "--since", "2026-11-17T00:00:00Z", "--until", "2026-11-18T00:00:00Z"];

  test("--json returns the same numbers the scan does, with thread names", async () => {
    __setUsageNameSources(SOURCES);
    const res = await runCli(migratedDbPath(), [...ARGS, "--json"]);
    expect(res.code).toBe(0);
    const j = JSON.parse(res.out);
    const [r] = scanUsage(ROOT, [DAY]);
    expect(j.total.calls).toBe(r!.total.calls);
    expect(j.total.cost).toBeCloseTo(r!.total.cost, 12);
    expect(j.projects.map((p: { name: string }) => p.name)).toEqual(["acme", NOT_OB_PROJECT]);
    expect(j.sessions[0].name).toBe("OB-2276 · GitHub webhooks into ob");
    expect(j.weekly.usedPercent).toBe(23);
    expect(j.previous).toBeNull();
  });

  test("the text report prints every section", async () => {
    __setUsageNameSources(SOURCES);
    const res = await runCli(migratedDbPath(), ARGS);
    expect(res.code).toBe(0);
    for (const s of ["total: $0.05 over 5 calls", "by model:", "by token class:", "main vs subagent:", "ob projects", "not an ob project", "top sessions", "weekly window: 23% used", "architect-acme"]) {
      expect(res.out).toContain(s);
    }
  });

  test("--compare prints each figure beside the previous window's and the change", async () => {
    __setUsageNameSources(SOURCES);
    const res = await runCli(migratedDbPath(), [...ARGS, "--compare"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`total: $0.05 over 5 calls  was $${P.toFixed(2)}, +$${(A + B + D + E + F - P).toFixed(2)}`);
    expect(res.out).toMatch(/claude-haiku-5-5 \(1 calls\)  was \$0\.00, \+\$0\.00 \(\+100%\)/);
    const j = JSON.parse((await runCli(migratedDbPath(), [...ARGS, "--compare", "--json"])).out);
    expect(j.previous.total.calls).toBe(1);
    expect(j.previous.total.cost).toBeCloseTo(P, 12);
  });

  test("a failing row lookup prints slugs and the same totals", async () => {
    __setUsageNameSources({ ...SOURCES, rows: async () => { throw new Error("api down"); } });
    const res = await runCli(migratedDbPath(), [...ARGS, "--json"]);
    expect(res.code).toBe(0);
    const j = JSON.parse(res.out);
    expect(j.total.calls).toBe(5);
    expect(j.total.cost).toBeCloseTo(A + B + D + E + F, 12);
    expect(j.sessions[0].name).toBe("-home-u-dev-acme-ob-2276");
    expect(j.projects.map((p: { name: string }) => p.name)).toEqual([NOT_OB_PROJECT]);
    expect(res.err).toContain("unavailable");
  });

  test("no transcript directory names the path and exits 2", async () => {
    __setUsageNameSources({ ...SOURCES, rows: async () => [] });
    process.env.OB_USAGE_TRANSCRIPTS = join(FIX, "nope");
    const res = await runCli(migratedDbPath(), ARGS);
    expect(res.code).toBe(2);
    expect(res.err).toContain(join(FIX, "nope"));
  });
});

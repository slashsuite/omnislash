// OS-108: `ob next` answers to the weekly Claude usage. At 98% or more, until the window resets, it lists only
// critical items after one line saying why; a missing, windowless or stale cache says "usage unknown" once and
// never blocks. In-process against fresh SQLite databases and usage-cache fixtures (`OB_USAGE_T3_CACHE`).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../../apps/cli/src/db.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { criticalOnlyGate, criticalOnlyLine, resetUsageUnknownWarning, resetWhen } from "../../../apps/cli/src/usage-gate.ts";

const cleanup: Array<() => void> = [];
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.OB_USAGE_T3_CACHE;
  resetUsageUnknownWarning();
});
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
  if (saved === undefined) delete process.env.OB_USAGE_T3_CACHE;
  else process.env.OB_USAGE_T3_CACHE = saved;
});

const HOUR = 3_600_000;

/** Write a cache fixture and point the gate at it. `windows: null` writes none; `checkedAgoMs` ages it. */
function cache(opts: { usedPercent?: number; resetsInMs?: number; checkedAgoMs?: number; windows?: null }): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-os108-next-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "claudeAgent.json");
  const now = Date.now();
  const windows =
    opts.windows === null
      ? [{ id: "five_hour", usedPercent: 99, resetsAt: new Date(now + HOUR).toISOString() }]
      : [{ id: "seven_day", usedPercent: opts.usedPercent ?? 10, resetsAt: new Date(now + (opts.resetsInMs ?? 24 * HOUR)).toISOString(), windowDurationMins: 10080 }];
  writeFileSync(file, JSON.stringify({ usageLimits: { checkedAt: new Date(now - (opts.checkedAgoMs ?? 60_000)).toISOString(), windows } }));
  process.env.OB_USAGE_T3_CACHE = file;
  return file;
}

async function seeded(): Promise<string> {
  const dbPath = freshDbPath();
  openDb(dbPath, { create: true }).close();
  for (const p of ["critical", "urgent", "medium"]) {
    expect((await runCli(dbPath, ["add", `item ${p}`, "--project", "acme", "--priority", p])).code).toBe(0);
  }
  return dbPath;
}

type Row = { title: string; effective_priority: string };

describe("ob next at the critical-only line (OS-108)", () => {
  test("99% with the reset tomorrow: the one line, then only critical items", async () => {
    cache({ usedPercent: 99 });
    const dbPath = await seeded();
    const human = await runCli(dbPath, ["next"]);
    expect(human.code).toBe(0);
    const first = human.out.split("\n")[0]!;
    expect(first).toMatch(/^Weekly Claude usage is 99% \(resets (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d\): critical only\.$/);
    expect(human.out).toContain("item critical");
    expect(human.out).not.toContain("item urgent");
    expect(human.out).not.toContain("item medium");

    const json = await runCli(dbPath, ["next", "--json"]);
    expect((JSON.parse(json.out) as Row[]).map((r) => r.title)).toEqual(["item critical"]);
    expect(json.err).toContain("critical only.");
  });

  test.each([
    ["97%", { usedPercent: 97 }],
    ["99% with the reset in the past", { usedPercent: 99, resetsInMs: -HOUR }],
  ] as const)("%s prints the normal list and no line", async (_label, opts) => {
    cache(opts);
    const dbPath = await seeded();
    const r = await runCli(dbPath, ["next", "--json"]);
    expect((JSON.parse(r.out) as Row[]).map((x) => x.effective_priority)).toEqual(["critical", "urgent", "medium"]);
    expect(r.err).not.toContain("critical only");
    expect(r.err).not.toContain("usage unknown");
  });

  test.each([
    ["a missing file", (): void => {
      process.env.OB_USAGE_T3_CACHE = join(tmpdir(), "ob-os108-missing", "claudeAgent.json");
    }],
    ["no seven_day window", (): void => void cache({ windows: null })],
    ["a checkedAt 2 hours old", (): void => void cache({ usedPercent: 99, checkedAgoMs: 2 * HOUR })],
    ["an unreadable resetsAt", (): void => {
      const file = cache({ usedPercent: 99 });
      const doc = JSON.parse(readFileSync(file, "utf8"));
      doc.usageLimits.windows[0].resetsAt = "soon";
      writeFileSync(file, JSON.stringify(doc));
    }],
  ] as const)("%s prints 'usage unknown' once on stderr and the normal list", async (_label, arrange) => {
    arrange();
    const dbPath = await seeded();
    const r = await runCli(dbPath, ["next", "--json"]);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as Row[]).map((x) => x.effective_priority)).toEqual(["critical", "urgent", "medium"]);
    expect(r.err.match(/usage unknown/g)).toHaveLength(1);
  });
});

describe("the gate's reading (OS-108)", () => {
  test("active at exactly 98, inactive at 97.9", () => {
    const now = new Date();
    expect(criticalOnlyGate(now, cache({ usedPercent: 98 }))).toMatchObject({ unknown: false, active: true, usedPercent: 98 });
    expect(criticalOnlyGate(now, cache({ usedPercent: 97.9 }))).toMatchObject({ unknown: false, active: false });
  });

  test("the line names the usage and the reset in local weekday and HH:MM", () => {
    const at = new Date(2026, 10, 24, 3, 0); // a Tuesday, 03:00 local
    expect(resetWhen(at.toISOString())).toBe("Tue 03:00");
    expect(criticalOnlyLine({ usedPercent: 99, resetsAt: at.toISOString() })).toBe("Weekly Claude usage is 99% (resets Tue 03:00): critical only.");
    expect(criticalOnlyLine({ usedPercent: 99, resetsAt: at.toISOString(), provider: "claude" })).toBe("Weekly Claude usage is 99% (resets Tue 03:00): critical only.");
    expect(criticalOnlyLine({ usedPercent: 99, resetsAt: at.toISOString(), provider: "antigravity" })).toBe("Weekly Gemini usage is 99% (resets Tue 03:00): critical only.");
  });
});

describe("OS-129: active models profile pacing (Antigravity vs Claude)", () => {
  test("pacingSource and t3Cache pick antigravity.json/gemini-weekly for Antigravity and claudeAgent.json/seven_day otherwise; OB_USAGE_T3_CACHE wins", async () => {
    const { pacingSource, t3Cache } = await import("../../../apps/cli/src/commands/usage.ts");
    const dir = mkdtempSync(join(tmpdir(), "ob-os129-src-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const write = (name: string, body: string) => {
      const p = join(dir, name);
      writeFileSync(p, body);
      return p;
    };

    const ag = write("ag.jsonc", JSON.stringify({ active: "antigravity", profiles: { antigravity: { builder: { complex: "antigravity:gemini-4-neon" } } } }));
    expect(pacingSource({ OB_MODELS_FILE: ag })).toEqual({ provider: "antigravity", cacheFile: "antigravity.json", windowId: "gemini-weekly" });
    expect(t3Cache({ OB_MODELS_FILE: ag, HOME: "/tmp/h" })).toBe("/tmp/h/.t3/caches/antigravity.json");
    expect(t3Cache({ OB_MODELS_FILE: ag, HOME: "/tmp/h", OB_USAGE_T3_CACHE: "/tmp/override.json" })).toBe("/tmp/override.json");

    for (const [name, body] of [
      ["claude.jsonc", JSON.stringify({ active: "c", profiles: { c: { builder: { complex: "claudeAgent:claude-opus-5-5" } } } })],
      ["claude2.jsonc", JSON.stringify({ active: "c2", profiles: { c2: { builder: { complex: "claudeAgent2:claude-opus-5-5" } } } })],
      ["opencode.jsonc", JSON.stringify({ active: "oc", profiles: { oc: { builder: { complex: "opencode:opencode-go/deepseek-v4.1-flash" } } } })],
      ["bad.jsonc", "{ not valid"],
    ] as const) {
      const f = write(name, body);
      expect(pacingSource({ OB_MODELS_FILE: f })).toEqual({ provider: "claude", cacheFile: "claudeAgent.json", windowId: "seven_day" });
      expect(t3Cache({ OB_MODELS_FILE: f, HOME: "/tmp/h" })).toBe("/tmp/h/.t3/caches/claudeAgent.json");
    }
  });

  test("with Antigravity active, ob next reads gemini-weekly from antigravity.json, says 'Weekly Gemini usage', and missing window reads unknown", async () => {
    const { mkdirSync } = await import("node:fs");
    const savedModels = process.env.OB_MODELS_FILE;
    const savedHome = process.env.HOME;
    const dir = mkdtempSync(join(tmpdir(), "ob-os129-ag-"));
    cleanup.push(() => {
      if (savedModels === undefined) delete process.env.OB_MODELS_FILE;
      else process.env.OB_MODELS_FILE = savedModels;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(dir, { recursive: true, force: true });
    });

    const modelsPath = join(dir, "models.jsonc");
    writeFileSync(
      modelsPath,
      JSON.stringify({ active: "antigravity", profiles: { antigravity: { builder: { complex: "antigravity:gemini-4-neon" } } } }),
    );
    process.env.OB_MODELS_FILE = modelsPath;
    delete process.env.OB_USAGE_T3_CACHE;
    process.env.HOME = dir;

    const caches = join(dir, ".t3", "caches");
    mkdirSync(caches, { recursive: true });
    const now = Date.now();
    // Put low usage in claudeAgent.json and high usage in antigravity.json to prove antigravity.json is read
    writeFileSync(
      join(caches, "claudeAgent.json"),
      JSON.stringify({
        usageLimits: {
          checkedAt: new Date(now - 60_000).toISOString(),
          windows: [{ id: "seven_day", usedPercent: 10, resetsAt: new Date(now + 24 * HOUR).toISOString(), windowDurationMins: 10080 }],
        },
      }),
    );
    writeFileSync(
      join(caches, "antigravity.json"),
      JSON.stringify({
        checkedAt: new Date(now - 30_000).toISOString(),
        usageLimits: {
          checkedAt: new Date(now - 60_000).toISOString(),
          windows: [
            { id: "gemini-5h", usedPercent: 12, resetsAt: new Date(now + HOUR).toISOString(), windowDurationMins: 300 },
            { id: "gemini-weekly", usedPercent: 99, resetsAt: new Date(now + 24 * HOUR).toISOString(), windowDurationMins: 10080 },
          ],
        },
      }),
    );

    const dbPath = await seeded();
    const human = await runCli(dbPath, ["next"]);
    expect(human.code).toBe(0);
    expect(human.out.split("\n")[0]).toMatch(/^Weekly Gemini usage is 99% \(resets (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d\): critical only\.$/);
    expect(human.out).toContain("item critical");
    expect(human.out).not.toContain("item urgent");

    // Top-level checkedAt fallback when usageLimits.checkedAt is absent
    writeFileSync(
      join(caches, "antigravity.json"),
      JSON.stringify({
        checkedAt: new Date(now - 60_000).toISOString(),
        usageLimits: {
          windows: [{ id: "gemini-weekly", usedPercent: 99, resetsAt: new Date(now + 24 * HOUR).toISOString(), windowDurationMins: 10080 }],
        },
      }),
    );
    expect(criticalOnlyGate(new Date(now))).toMatchObject({ unknown: false, active: true, usedPercent: 99, provider: "antigravity" });

    // Missing gemini-weekly window reads as unknown (never blocks)
    resetUsageUnknownWarning();
    writeFileSync(
      join(caches, "antigravity.json"),
      JSON.stringify({
        usageLimits: {
          checkedAt: new Date(now - 60_000).toISOString(),
          windows: [{ id: "gemini-5h", usedPercent: 99, resetsAt: new Date(now + HOUR).toISOString(), windowDurationMins: 300 }],
        },
      }),
    );
    const missingWin = await runCli(dbPath, ["next", "--json"]);
    expect(missingWin.code).toBe(0);
    expect((JSON.parse(missingWin.out) as Row[]).map((r) => r.effective_priority)).toEqual(["critical", "urgent", "medium"]);
    expect(missingWin.err).toContain("usage unknown");
    expect(missingWin.err).toContain("gemini-weekly");

    // Malformed models file never throws from `ob next` and falls back to Claude
    writeFileSync(modelsPath, "{ not json");
    resetUsageUnknownWarning();
    const malformed = await runCli(dbPath, ["next", "--json"]);
    expect(malformed.code).toBe(0);
    expect((JSON.parse(malformed.out) as Row[]).map((r) => r.effective_priority)).toEqual(["critical", "urgent", "medium"]);
    expect(malformed.err).not.toContain("usage unknown");
  });
});

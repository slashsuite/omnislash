// OS-108: `ob next` answers to the weekly Claude usage. At 95% or more, until the window resets, it lists only
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
  test("96% with the reset tomorrow: the one line, then only critical items", async () => {
    cache({ usedPercent: 96 });
    const dbPath = await seeded();
    const human = await runCli(dbPath, ["next"]);
    expect(human.code).toBe(0);
    const first = human.out.split("\n")[0]!;
    expect(first).toMatch(/^Weekly Claude usage is 96% \(resets (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d\): critical only\.$/);
    expect(human.out).toContain("item critical");
    expect(human.out).not.toContain("item urgent");
    expect(human.out).not.toContain("item medium");

    const json = await runCli(dbPath, ["next", "--json"]);
    expect((JSON.parse(json.out) as Row[]).map((r) => r.title)).toEqual(["item critical"]);
    expect(json.err).toContain("critical only.");
  });

  test.each([
    ["94%", { usedPercent: 94 }],
    ["96% with the reset in the past", { usedPercent: 96, resetsInMs: -HOUR }],
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
  test("active at exactly 95, inactive at 94.9", () => {
    const now = new Date();
    expect(criticalOnlyGate(now, cache({ usedPercent: 95 }))).toMatchObject({ unknown: false, active: true, usedPercent: 95 });
    expect(criticalOnlyGate(now, cache({ usedPercent: 94.9 }))).toMatchObject({ unknown: false, active: false });
  });

  test("the line names the usage and the reset in local weekday and HH:MM", () => {
    const at = new Date(2026, 10, 24, 3, 0); // a Tuesday, 03:00 local
    expect(resetWhen(at.toISOString())).toBe("Tue 03:00");
    expect(criticalOnlyLine({ usedPercent: 96, resetsAt: at.toISOString() })).toBe("Weekly Claude usage is 96% (resets Tue 03:00): critical only.");
  });
});

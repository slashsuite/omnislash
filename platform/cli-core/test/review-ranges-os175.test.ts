// OS-175: review-reader legs per complexity range instead of per tier. The run-time lookup is
// `ob review readers --complexity <n> -q` (what ob-spinoff and ob-skeptical-review tell a builder to run for its
// row's score), so the CLI checks below drive that command; the pure checks cover the value it reads.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ReviewReadersError,
  defaultReviewReaders,
  parseReviewReaders,
  serializeReviewReaders,
  readersForComplexity,
  validateReviewReaders,
  withRange,
  withoutReader,
} from "../../../apps/cli/src/review-readers.ts";

const CLI_ENTRY = join(import.meta.dir, "../../../apps/cli/src/index.ts");

const READERS = { neon: { model: "antigravity:gemini-4-neon" }, opus: { model: "claude-opus-5-5" }, glm: { model: "glm-5.3-flash" } };
const legsAt = (v: ReturnType<typeof validateReviewReaders>, c: number) => readersForComplexity(v, c).map((r) => r.leg);

describe("OS-175: review readers per complexity range", () => {
  test("the lookup picks legs by the row's score on a custom split", () => {
    const v = validateReviewReaders({
      readers: READERS,
      tiers: [
        { from: 9, to: 10, legs: ["neon", "opus", "glm"] },
        { from: 1, to: 2, legs: ["glm"] },
        { from: 3, to: 8, legs: ["opus"] },
      ],
    });
    expect(v.tiers.map((r) => [r.from, r.to])).toEqual([[1, 2], [3, 8], [9, 10]]);
    expect([1, 2, 3, 8, 9, 10].map((c) => legsAt(v, c))).toEqual([["glm"], ["glm"], ["opus"], ["opus"], ["neon", "opus", "glm"], ["neon", "opus", "glm"]]);
    expect(readersForComplexity(v, 9)[2]).toEqual({ leg: "glm", model: "glm-5.3-flash", fallback: null });
  });

  test("an old {simple, medium, complex} setting loads as 1-3, 4-6 and 7-10 with the same legs per band", () => {
    const old = { simple: ["glm"], medium: ["neon", "opus"], complex: ["opus", "neon", "glm"] };
    const v = parseReviewReaders(JSON.stringify({ readers: READERS, tiers: old }));
    expect(v.tiers).toEqual([
      { from: 1, to: 3, legs: ["glm"] },
      { from: 4, to: 6, legs: ["neon", "opus"] },
      { from: 7, to: 10, legs: ["opus", "neon", "glm"] },
    ]);
    for (const [tier, band] of [["simple", [1, 3]], ["medium", [4, 6]], ["complex", [7, 10]]] as const) {
      for (let c = band[0]; c <= band[1]; c++) expect(legsAt(v, c)).toEqual(old[tier]);
    }
    // and it is stored back in the old form, so an ob from before OS-175 still reads it, and parses to the same value
    expect(JSON.parse(serializeReviewReaders(v)).tiers).toEqual(old);
    expect(parseReviewReaders(serializeReviewReaders(v))).toEqual(v);
    // any other split is stored as the list
    const split = withRange(v, { from: 4, to: 7 }, ["opus"]);
    expect(Array.isArray(JSON.parse(serializeReviewReaders(split)).tiers)).toBe(true);
    expect(parseReviewReaders(serializeReviewReaders(split))).toEqual(split);
    expect(() => validateReviewReaders({ readers: READERS, tiers: { simple: ["glm"], medium: ["opus"] } })).toThrow("review range 7-10 has no readers");
  });

  test("a gap or an overlap is refused, naming the range", () => {
    const refuse = (tiers: unknown) => {
      try {
        validateReviewReaders({ readers: READERS, tiers });
      } catch (e) {
        expect(e).toBeInstanceOf(ReviewReadersError);
        return (e as Error).message;
      }
      throw new Error("not refused");
    };
    expect(refuse([{ from: 1, to: 3, legs: ["opus"] }, { from: 5, to: 10, legs: ["opus"] }])).toContain("review ranges leave a gap at 4");
    expect(refuse([{ from: 1, to: 8, legs: ["opus"] }])).toContain("review ranges leave a gap at 9-10");
    expect(refuse([{ from: 1, to: 5, legs: ["opus"] }, { from: 4, to: 10, legs: ["neon"] }])).toContain("review ranges 1-5 and 4-10 overlap at 4-5");
    expect(refuse([{ from: 0, to: 10, legs: ["opus"] }])).toContain("review range 0-10 must be whole numbers 1 to 10");
  });

  test("setting a range carves it out of the ranges it overlaps; removing a range's last reader is refused by range", () => {
    let v = withRange(defaultReviewReaders(), { from: 5, to: 8 }, ["opus"]);
    expect(v.tiers.map((r) => `${r.from}-${r.to}:${r.legs.join("+")}`)).toEqual(["1-3:neon+opus", "4-4:neon+opus", "5-8:opus", "9-10:neon+opus"]);
    expect(() => withoutReader(v, "opus")).toThrow("'opus' is the only reader on range 5-8");
    v = withRange(v, { from: 1, to: 10 }, ["neon"]);
    expect(v.tiers).toEqual([{ from: 1, to: 10, legs: ["neon"] }]);
  });

  test("`ob review readers range` and `--complexity` drive the CLI; `tier` and `--tier` still work as aliases", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-os175-"));
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
      const run = (...args: string[]) => {
        const r = Bun.spawnSync(["bun", CLI_ENTRY, ...args], { env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
        return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
      };
      expect(run("review", "readers", "range", "4-7", "opus")).toMatchObject({ code: 0, out: "4-7: opus" });
      expect(run("review", "readers", "--complexity", "7", "-q").out).toBe("opus");
      expect(run("review", "readers", "--complexity", "8", "-q").out.split("\n")).toEqual(["neon", "opus"]);
      expect(run("review", "readers", "--tier", "medium", "-q").out).toBe("opus"); // medium reads as score 5
      expect(JSON.parse(run("review", "readers", "--complexity", "3", "--json").out)).toMatchObject({ complexity: 3, range: "1-3" });
      expect(run("review", "readers", "tier", "simple", "neon")).toMatchObject({ code: 0, out: "1-3: neon" });
      expect(run("review", "readers", "--complexity", "2", "-q").out).toBe("neon");
      expect(run("review", "readers", "range", "0-3", "neon").code).not.toBe(0);
      const bad = run("review", "readers", "--complexity", "11", "-q");
      expect(bad.code).not.toBe(0);
      expect(bad.err).toContain("--complexity must be a whole number 1 to 10");
      expect(run("models", "reader", "range", "8-10", "neon")).toMatchObject({ code: 0 });
      expect(run("review", "readers", "--complexity", "9", "-q").out).toBe("neon");
      const table = run("review", "readers").out;
      expect(table.split("\n")[0]).toMatch(/reader\s+model\s+fallback\s+1-3\s+4-7\s+8-10$/);
      const both = run("review", "readers", "--complexity", "2", "--tier", "complex", "-q");
      expect(both.code).toBe(2);
      expect(both.err).toContain("not both");
      // a one-score range keeps the table's columns in line: every row's cells start where the header's do
      run("review", "readers", "range", "4", "neon");
      const lines = run("review", "readers").out.split("\n").filter((l) => !l.startsWith("("));
      const at = (l: string) => l.lastIndexOf("8-10");
      expect(lines[0]).toMatch(/1-3\s+4\s+5-7\s+8-10$/);
      for (const l of lines.slice(1)) expect(l.slice(at(lines[0]!), at(lines[0]!) + 2).trim()).toMatch(/^(on|-)$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

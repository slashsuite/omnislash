import { describe, expect, test } from "bun:test";
import { syncNeedsYouTitle, titleWithNeedsYou, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { NEEDS_YOU_MARKER } from "../src/spinoff-state-reason.ts";

function seamWithTitle(title: string, opts: { failRead?: boolean } = {}) {
  const renames: Array<[string, string]> = [];
  const seam = {
    read: async () => {
      if (opts.failRead) throw new Error("T3 unreachable");
      return { thread: { title } };
    },
    rename: async (id: string, t: string) => {
      renames.push([id, t]);
    },
  } as unknown as T3Seam;
  return { seam, renames };
}

describe("titleWithNeedsYou (1579)", () => {
  test("needs-human puts the marker in front of the title, once", () => {
    expect(titleWithNeedsYou("1579 · needs-human says why", "needs-human")).toBe(`${NEEDS_YOU_MARKER} 1579 · needs-human says why`);
    expect(titleWithNeedsYou(`${NEEDS_YOU_MARKER} 1579 · x`, "needs-human")).toBe(`${NEEDS_YOU_MARKER} 1579 · x`);
  });

  test("any other status takes the marker off, and an unmarked title is left alone", () => {
    for (const status of ["working", "readying", "blocked", null]) {
      expect(titleWithNeedsYou(`${NEEDS_YOU_MARKER} 1579 · x`, status)).toBe("1579 · x");
      expect(titleWithNeedsYou("1579 · x", status)).toBe("1579 · x");
    }
  });
});

describe("syncNeedsYouTitle (1579)", () => {
  test("needs-human renames the thread with the marker", async () => {
    const { seam, renames } = seamWithTitle("1579 · x");
    const out = await syncNeedsYouTitle("th-1", "needs-human", seam);
    expect(out).toEqual({ renamed: true, title: `${NEEDS_YOU_MARKER} 1579 · x`, error: null });
    expect(renames).toEqual([["th-1", `${NEEDS_YOU_MARKER} 1579 · x`]]);
  });

  test("a title already in the right state is not renamed", async () => {
    const { seam, renames } = seamWithTitle("1579 · x");
    expect((await syncNeedsYouTitle("th-1", "working", seam)).renamed).toBe(false);
    expect(renames).toEqual([]);
  });

  test("an unreachable T3 is reported, never thrown", async () => {
    const { seam, renames } = seamWithTitle("x", { failRead: true });
    const out = await syncNeedsYouTitle("th-1", "needs-human", seam);
    expect(out).toEqual({ renamed: false, title: null, error: "T3 unreachable" });
    expect(renames).toEqual([]);
  });
});

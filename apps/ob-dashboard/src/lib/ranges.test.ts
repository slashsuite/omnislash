import { describe, expect, it } from "bun:test";
import { draftsOf, mergeNext, rangesOf, splitAt, type DraftRange } from "./ranges.ts";

// OS-176: the range editor's split and merge, before anything is sent to the server.

const rows: DraftRange<string>[] = draftsOf(
  [
    { from: 1, to: 3, m: "haiku" },
    { from: 4, to: 6, m: "sonnet" },
    { from: 7, to: 10, m: "opus" },
  ],
  (r) => r.m,
);

describe("splitAt", () => {
  it("splits a-b at n into a-(n-1) and n-b, both with the row's value", () => {
    expect(splitAt(rows, 2, "9")).toEqual([...rows.slice(0, 2), { from: "7", to: "8", value: "opus" }, { from: "9", to: "10", value: "opus" }]);
  });

  it("splits at the row's to, leaving a one-score half", () => {
    expect(splitAt(rows, 0, "3")).toEqual([{ from: "1", to: "2", value: "haiku" }, { from: "3", to: "3", value: "haiku" }, ...rows.slice(1)]);
  });

  it("refuses a split at the row's from, outside the row, or not a number", () => {
    expect(splitAt(rows, 1, "4")).toBe("split at 4 must be from 5 to 6, so both halves hold a score");
    expect(splitAt(rows, 1, "7")).toBe("split at 7 must be from 5 to 6, so both halves hold a score");
    expect(splitAt(rows, 1, "x")).toBe("split at 'x' is not a whole number");
    expect(splitAt([{ from: "5", to: "5", value: "a" }], 0, "5")).toBe("row 1 holds one score, 5, so it cannot be split");
  });
});

describe("mergeNext", () => {
  it("merges a row with the next, keeping the first row's value", () => {
    expect(mergeNext(rows, 1)).toEqual([...rows.slice(0, 1), { from: "4", to: "10", value: "sonnet" }]);
  });

  it("undoes a split", () => {
    const split = splitAt(rows, 2, "9");
    expect(typeof split).not.toBe("string");
    expect(mergeNext(split as DraftRange<string>[], 2)).toEqual(rows);
  });

  it("refuses the last row", () => {
    expect(mergeNext(rows, 2)).toBe("row 3 has no row after it to merge with");
  });
});

describe("rangesOf", () => {
  it("reads every box as a whole number", () => {
    expect(rangesOf(rows)).toEqual([
      { from: 1, to: 3, value: "haiku" },
      { from: 4, to: 6, value: "sonnet" },
      { from: 7, to: 10, value: "opus" },
    ]);
  });

  it("names the first box that is not a whole number", () => {
    expect(rangesOf([rows[0]!, { ...rows[1]!, to: "6.5" }])).toBe("row 2: to '6.5' is not a whole number");
  });
});

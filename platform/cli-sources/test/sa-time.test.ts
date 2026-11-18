import { describe, expect, test } from "bun:test";
import { saClock, saDateBounds, saDayBounds } from "../src/sa-time.ts";

describe("saDayBounds (OB-1787)", () => {
  test("midday UTC: the day runs 22:00Z to 22:00Z", () => {
    expect(saDayBounds(new Date("2026-07-18T12:00:00Z"))).toEqual({
      from: "2026-07-17T22:00:00.000Z",
      to: "2026-07-18T22:00:00.000Z",
    });
  });
  test("00:30 SAST is still the previous day in UTC, and is the new SA day", () => {
    expect(saDayBounds(new Date("2026-11-05T22:30:00Z"))).toEqual({
      from: "2026-11-05T22:00:00.000Z",
      to: "2026-11-06T22:00:00.000Z",
    });
  });
  test("21:59Z is 23:59 SAST, still the same SA day; 22:00Z starts the next", () => {
    expect(saDayBounds(new Date("2026-11-05T21:59:59Z")).to).toBe("2026-11-05T22:00:00.000Z");
    expect(saDayBounds(new Date("2026-11-05T22:00:00Z")).from).toBe("2026-11-05T22:00:00.000Z");
  });
});

describe("saDateBounds", () => {
  test("a SA date runs from 22:00Z the evening before", () => {
    expect(saDateBounds("2026-11-06")).toEqual({ from: "2026-11-05T22:00:00.000Z", to: "2026-11-06T22:00:00.000Z" });
    expect(saDateBounds("2027-01-01")).toEqual({ from: "2026-12-31T22:00:00.000Z", to: "2027-01-01T22:00:00.000Z" });
  });
});

describe("saClock", () => {
  test("converts a UTC instant to SA time, rolling past midnight", () => {
    expect(saClock("2026-07-18T09:00:00.000Z")).toBe("11:00");
    expect(saClock("2026-11-05T22:30:00.000Z")).toBe("00:30");
  });
  test("a bare date or junk comes back unchanged", () => {
    expect(saClock("2026-11-05")).toBe("2026-11-05");
    expect(saClock("nonsense")).toBe("nonsense");
  });
});

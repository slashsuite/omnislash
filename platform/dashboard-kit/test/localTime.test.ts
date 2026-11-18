import { describe, expect, it } from "bun:test";
import { fmtClock, fmtDate, fmtDateTime, saToday } from "../src/lib/localTime.ts";

describe("fmtDateTime (Africa/Johannesburg, UTC+2)", () => {
  it("adds two hours", () => {
    expect(fmtDateTime("2026-11-05T10:15:00.000Z")).toBe("2026-11-05 12:15");
  });
  it("rolls the date over past midnight", () => {
    expect(fmtDateTime("2026-11-05T22:30:00Z")).toBe("2026-11-06 00:30");
  });
  it("rolls the year over", () => {
    expect(fmtDateTime("2026-12-31T22:00:00Z")).toBe("2027-01-01 00:00");
  });
  it("handles empty and unparseable input", () => {
    expect(fmtDateTime(null)).toBe("");
    expect(fmtDateTime("")).toBe("");
    expect(fmtDateTime("not a date")).toBe("not a date");
  });
});

describe("fmtClock", () => {
  it("shows HH:MM in SAST", () => {
    expect(fmtClock("2026-11-05T07:00:00Z")).toBe("09:00");
    expect(fmtClock("2026-11-05T22:30:00Z")).toBe("00:30");
  });
});

describe("date-only values (OB-1787)", () => {
  it("a bare date is not an instant: it comes back unchanged", () => {
    expect(fmtDateTime("2026-11-05")).toBe("2026-11-05");
    expect(fmtClock("2026-11-05")).toBe("2026-11-05");
    expect(fmtDate("2026-11-05")).toBe("2026-11-05");
  });
});

describe("fmtDate", () => {
  it("shows the SA date of an instant", () => {
    expect(fmtDate("2026-11-05T21:59:00Z")).toBe("2026-11-05");
    expect(fmtDate("2026-11-05T22:00:00Z")).toBe("2026-11-06");
    expect(fmtDate(null)).toBe("");
  });
});

describe("saToday", () => {
  it("is the SA date, a day ahead of UTC from 22:00Z to midnight", () => {
    expect(saToday(new Date("2026-11-05T21:59:59Z"))).toBe("2026-11-05");
    expect(saToday(new Date("2026-11-05T22:00:00Z"))).toBe("2026-11-06");
    expect(saToday(new Date("2026-11-05T23:59:59Z"))).toBe("2026-11-06");
    expect(saToday(new Date("2026-11-06T00:30:00Z"))).toBe("2026-11-06");
    expect(saToday(new Date("2026-12-31T22:30:00Z"))).toBe("2027-01-01");
  });
});

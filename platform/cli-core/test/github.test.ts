import { describe, expect, test } from "bun:test";
import {
  afterReady,
  branchAgeDays,
  isSelfOrBot,
  latestReadyAt,
  readyWindowStart,
} from "../../../apps/cli/src/ingest/github.ts";

describe("branchAgeDays", () => {
  test("merged: days between first commit and merge", () => {
    expect(branchAgeDays("2026-01-10T00:00:00Z", "2026-01-07T00:00:00Z")).toBe(3);
  });

  test("fractional days rounded to 2dp", () => {
    expect(branchAgeDays("2026-01-07T12:00:00Z", "2026-01-07T00:00:00Z")).toBe(0.5);
  });

  test("not merged -> null", () => {
    expect(branchAgeDays(null, "2026-01-07T00:00:00Z")).toBeNull();
  });

  test("no commit -> null", () => {
    expect(branchAgeDays("2026-01-10T00:00:00Z", null)).toBeNull();
  });
});

describe("latestReadyAt / readyWindowStart", () => {
  const ready = (ts: string) => ({ __typename: "ReadyForReviewEvent", createdAt: ts });

  test("picks the latest ready event", () => {
    const nodes = [ready("2026-01-01T00:00:00Z"), ready("2026-01-05T00:00:00Z")];
    expect(latestReadyAt(nodes)).toBe("2026-01-05T00:00:00Z");
  });

  test("no ready events -> null", () => {
    expect(latestReadyAt([])).toBeNull();
    expect(latestReadyAt(null)).toBeNull();
  });

  test("window falls back to createdAt when born ready (not draft)", () => {
    expect(readyWindowStart([], "2026-01-02T00:00:00Z", false)).toBe("2026-01-02T00:00:00Z");
  });

  test("draft with no ready event -> no window", () => {
    expect(readyWindowStart([], "2026-01-02T00:00:00Z", true)).toBeNull();
  });

  test("explicit ready event wins over createdAt", () => {
    expect(readyWindowStart([ready("2026-01-05T00:00:00Z")], "2026-01-01T00:00:00Z", true)).toBe(
      "2026-01-05T00:00:00Z",
    );
  });
});

describe("afterReady windowing", () => {
  const readyAt = "2026-01-05T00:00:00Z";

  test("comment after ready -> true", () => {
    expect(afterReady("2026-01-06T00:00:00Z", readyAt)).toBe(true);
  });

  test("comment before ready -> false", () => {
    expect(afterReady("2026-01-04T00:00:00Z", readyAt)).toBe(false);
  });

  test("no window (null readyAt) -> false", () => {
    expect(afterReady("2026-01-06T00:00:00Z", null)).toBe(false);
  });

  test("missing ts -> false", () => {
    expect(afterReady(null, readyAt)).toBe(false);
  });
});

describe("isSelfOrBot", () => {
  test("self is excluded", () => {
    expect(isSelfOrBot("owner", "owner")).toBe(true);
    expect(isSelfOrBot("Owner", "owner")).toBe(true);
  });

  test("bot accounts excluded", () => {
    expect(isSelfOrBot("dependabot[bot]", "me")).toBe(true);
    expect(isSelfOrBot("some-bot", "me")).toBe(true);
  });

  test("null login excluded", () => {
    expect(isSelfOrBot(null, "me")).toBe(true);
  });

  test("a real reviewer is kept", () => {
    expect(isSelfOrBot("colleague", "me")).toBe(false);
  });
});

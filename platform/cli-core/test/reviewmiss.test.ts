import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openDb } from "../../../apps/cli/src/db.ts";
import { recordEvent, eventsBetween, parsePayload } from "../../../apps/cli/src/events.ts";
import { rankClasses, scopeFromPr } from "../../../apps/cli/src/commands/reviewmiss.ts";

// Open the DB directly rather than via test/helpers.ts (which imports cli.ts and
// sibling command modules still being built in parallel). This test only needs
// the schema, the event store, and the pure rankClasses function.
function freshDb() {
  return openDb(join(tmpdir(), `ob-test-${randomUUID()}.sqlite`));
}

const NOW = new Date("2026-07-16T00:00:00.000Z");
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

interface Payload {
  pr: string;
  class: string;
  finding: string;
  scope: string;
}

function seed(db: ReturnType<typeof freshDb>, cls: string, scope: string, ageDays: number): void {
  recordEvent(db, {
    ts: daysAgo(ageDays),
    source: "skill:code-review",
    type: "review_miss",
    payload: { pr: "https://github.com/cue/frontend/pull/1", class: cls, finding: cls, scope },
  });
}

function loadEvents(db: ReturnType<typeof freshDb>) {
  return eventsBetween(db, { type: "review_miss" }).map((r) => {
    const p = parsePayload<Payload>(r);
    return { class: p.class, ts: r.ts, scope: p.scope };
  });
}

describe("rankClasses — recency-decayed weighting", () => {
  test("a class seen 3x recently outranks a class seen once long ago", () => {
    const db = freshDb();
    seed(db, "null-check", "global", 1);
    seed(db, "null-check", "global", 3);
    seed(db, "null-check", "global", 5);
    seed(db, "typo", "global", 200);

    const ranked = rankClasses(loadEvents(db), NOW);
    expect(ranked[0]!.class).toBe("null-check");
    expect(ranked[0]!.count).toBe(3);
    const typo = ranked.find((r) => r.class === "typo")!;
    expect(ranked[0]!.weight).toBeGreaterThan(typo.weight);
  });

  test("decay reduces the weight of old occurrences", () => {
    const db = freshDb();
    seed(db, "recent", "global", 0);
    seed(db, "stale", "global", 200);

    const ranked = rankClasses(loadEvents(db), NOW, { halfLifeDays: 90 });
    const recent = ranked.find((r) => r.class === "recent")!;
    const stale = ranked.find((r) => r.class === "stale")!;

    // A fresh occurrence contributes ~1.0; a 90-day-old one ~0.5.
    expect(recent.weight).toBeCloseTo(1, 5);
    // 0.5 ^ (200/90) ≈ 0.214
    expect(stale.weight).toBeCloseTo(Math.pow(0.5, 200 / 90), 5);
    expect(stale.weight).toBeLessThan(recent.weight);
  });

  test("an occurrence exactly one half-life old weighs ~0.5", () => {
    const db = freshDb();
    seed(db, "halflife", "global", 90);
    const ranked = rankClasses(loadEvents(db), NOW, { halfLifeDays: 90 });
    expect(ranked[0]!.weight).toBeCloseTo(0.5, 5);
  });

  test("scope filter includes matching scope + global, excludes others", () => {
    const db = freshDb();
    seed(db, "mantine-weight", "cue-frontend", 1);
    seed(db, "null-check", "global", 1);
    seed(db, "other-only", "other-repo", 1);

    const ranked = rankClasses(loadEvents(db), NOW, { scope: "cue-frontend" });
    const classes = ranked.map((r) => r.class);
    expect(classes).toContain("mantine-weight");
    expect(classes).toContain("null-check");
    expect(classes).not.toContain("other-only");
  });

  test("no scope filter returns every class", () => {
    const db = freshDb();
    seed(db, "a", "cue-frontend", 1);
    seed(db, "b", "other-repo", 1);
    const ranked = rankClasses(loadEvents(db), NOW);
    expect(ranked.map((r) => r.class).sort()).toEqual(["a", "b"]);
  });

  test("limit caps the number of returned classes", () => {
    const db = freshDb();
    for (let i = 0; i < 5; i++) seed(db, `class-${i}`, "global", i + 1);
    const ranked = rankClasses(loadEvents(db), NOW, { limit: 2 });
    expect(ranked).toHaveLength(2);
  });

  test("last_seen is the newest occurrence of a class", () => {
    const db = freshDb();
    seed(db, "c", "global", 10);
    seed(db, "c", "global", 2);
    const ranked = rankClasses(loadEvents(db), NOW);
    expect(ranked[0]!.last_seen).toBe(daysAgo(2));
  });
});

describe("scopeFromPr", () => {
  test("derives owner/repo from an https GitHub url", () => {
    expect(scopeFromPr("https://github.com/acmecorp/cue-frontend/pull/123")).toBe(
      "acmecorp/cue-frontend",
    );
  });

  test("falls back to global for a non-GitHub url", () => {
    expect(scopeFromPr("https://example.com/x/y")).toBe("global");
  });
});

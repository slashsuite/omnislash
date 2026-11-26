import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { renderSubcommandHelp } from "../../../apps/cli/src/cli.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import { enqueueSpinoff, type EnqueueInput } from "../src/commands/spinoff.ts";
import { buildMix, parseSince, redispatchedHigher, type MixSource } from "../src/spinoff-mix.ts";
import { cliDocs } from "../../../apps/cli/test/support/cli-docs.ts";

// 1550: `ob spinoff mix` reads the dispatch mix. Nothing is stored; a missing stamp is said, never invented.

const row = (id: number, over: Partial<MixSource> = {}): MixSource => ({
  id,
  ticket_ref: `t${id}`,
  repo: "acme",
  status: "merged",
  error: null,
  request_at: "2026-10-10T00:00:00.000Z",
  item_id: null,
  tier: "medium",
  model: "claude-sonnet-5-5",
  ...over,
});

describe("parseSince", () => {
  test("absent is null; a date becomes an ISO string; garbage is a UsageError", () => {
    expect(parseSince(undefined)).toBeNull();
    expect(parseSince("2026-10-01")).toBe("2026-10-01T00:00:00.000Z");
    expect(() => parseSince("last tuesday")).toThrow(UsageError);
    expect(() => parseSince("")).toThrow(UsageError);
  });
});

describe("redispatchedHigher", () => {
  test("an unlanded row followed by a higher-tier dispatch of the same ticket is re-dispatched", () => {
    const rows = [
      row(1, { ticket_ref: "a", status: "failed", tier: "simple" }),
      row(2, { ticket_ref: "a", status: "merged", tier: "medium" }),
      row(3, { ticket_ref: "b", status: "failed", tier: "complex" }),
      row(4, { ticket_ref: "b", status: "merged", tier: "simple" }),
      row(5, { ticket_ref: "c", status: "merged", tier: "simple" }),
    ];
    expect([...redispatchedHigher(rows)]).toEqual([1]);
  });

  test("the same ref in two repos is two tickets; an item link does not split one ticket in two", () => {
    const rows = [
      row(1, { ticket_ref: "9", repo: "acme", status: "failed", tier: "simple" }),
      row(2, { ticket_ref: "9", repo: "other", tier: "complex" }),
      row(3, { ticket_ref: "9", repo: "acme", item_id: "i3", tier: "medium" }),
      row(4, { ticket_ref: "u", repo: "acme", status: "failed", tier: null }),
      row(5, { ticket_ref: "u", repo: "acme", tier: "complex" }),
      row(6, { ticket_ref: "v", repo: "acme", status: "failed", tier: "simple" }),
      row(7, { ticket_ref: "v", repo: "acme", tier: null }),
    ];
    const re = redispatchedHigher(rows);
    expect(re.has(1)).toBe(true); // the acme retry escalated…
    expect(re.has(2)).toBe(false); // …the other repo's ticket did not
    expect(re.has(4)).toBe(false); // an unstamped tier cannot be compared…
    expect(re.has(6)).toBe(false); // …and an unstamped retry proves no escalation
  });
});

describe("buildMix", () => {
  test("tier share against the 50/30/20 target, with the delta", () => {
    const rows = [
      row(1, { tier: "simple" }),
      row(2, { tier: "simple", status: "failed" }),
      row(3, { tier: "medium", status: "launched" }),
      row(4, { tier: "complex" }),
    ];
    const r = buildMix(rows, new Map(), null);
    expect(r.total).toBe(4);
    expect(r.rated).toBe(4);
    const by = Object.fromEntries(r.tiers.map((t) => [t.tier, t]));
    expect(by.simple).toMatchObject({ count: 2, pct: 50, target_pct: 50, delta_pct: 0, landed: 1, blocked: 1 });
    expect(by.medium).toMatchObject({ count: 1, pct: 25, delta_pct: -5, in_flight: 1 });
    expect(by.complex).toMatchObject({ count: 1, pct: 25, delta_pct: 5, landed: 1 });
  });

  test("an unstamped tier or model is its own bucket and a note, not a guess", () => {
    const r = buildMix([row(1, { tier: null, model: null, status: "pending" }), row(2)], new Map(), null);
    expect(r.unstamped_tier).toBe(1);
    // The share is over the rated row, so the unstamped row cannot drag the percentage down.
    expect(r.rated).toBe(1);
    expect(r.tiers.find((t) => t.tier === "medium")!).toMatchObject({ count: 1, pct: 100 });
    expect(r.models.find((m) => m.model === null)!.count).toBe(1);
    expect(r.notes.join("\n")).toMatch(/no tier stamp/);
    expect(r.notes.join("\n")).toMatch(/the tier share is over the 1 rated row/);
    expect(r.notes.join("\n")).toMatch(/no model stamp/);
    expect(r.notes.join("\n")).toMatch(/provider is not stamped/);
  });

  test("per model: landed, blocked and re-dispatched-higher are counted apiece", () => {
    const rows = [
      row(1, { ticket_ref: "a", model: "haiku", tier: "simple", status: "failed" }),
      row(2, { ticket_ref: "a", model: "sonnet", tier: "medium" }),
      row(3, { ticket_ref: "b", model: "haiku", tier: "simple" }),
    ];
    const r = buildMix(rows, new Map(), null);
    const haiku = r.models.find((m) => m.model === "haiku")!;
    expect(haiku).toMatchObject({ count: 2, landed: 1, blocked: 1, redispatched_higher: 1, provider: null });
  });

  test("--since filters rows, but a retry outside the window still marks the row inside it", () => {
    const rows = [
      row(1, { ticket_ref: "a", tier: "simple", status: "failed", request_at: "2026-10-12T00:00:00.000Z" }),
      row(2, { ticket_ref: "a", tier: "complex", request_at: "2026-09-01T00:00:00.000Z" }),
      row(3, { ticket_ref: "z", request_at: "2026-09-02T00:00:00.000Z" }),
    ];
    const r = buildMix(rows, new Map(), "2026-10-01T00:00:00.000Z");
    expect(r.total).toBe(1);
    expect(r.tiers.find((t) => t.tier === "simple")!.redispatched_higher).toBe(1);
    expect(r.since).toBe("2026-10-01T00:00:00.000Z");
  });

  test("a ticket with several work tags counts under each; one with none is untagged", () => {
    const tags = new Map([["i1", ["frontend", "bug-fix", "not-a-work-tag"]]]);
    const r = buildMix([row(1, { item_id: "i1", tier: "simple" }), row(2, { item_id: "i2" }), row(3, { item_id: null })], tags, null);
    const by = Object.fromEntries(r.tags.map((t) => [t.tag ?? "(untagged)", t]));
    expect(by.frontend).toMatchObject({ count: 1 });
    expect(by["bug-fix"]).toMatchObject({ count: 1, landed: 1 });
    expect(by["(untagged)"]).toMatchObject({ count: 2 });
    expect(by["not-a-work-tag"]).toBeUndefined();
  });

});

describe("ob spinoff mix (CLI)", () => {
  const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
    ticketRef: "1",
    repo: "/r/acme",
    branch: "1",
    mode: "interactive",
    brief: "mix",
    ...over,
  });

  async function seeded(): Promise<string> {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    const itemId = await createItem(db, { type: "task", title: "tagged", tags: ["frontend"] });
    const a = await enqueueSpinoff(db, input({ ticketRef: "1", branch: "1", worktree: "/wt/1", tier: "simple" }));
    db.query("UPDATE spinoff SET status = 'merged', model = 'claude-haiku-5-5', item_id = ? WHERE id = ?").run(itemId, a.row.id);
    const b = await enqueueSpinoff(db, input({ ticketRef: "2", branch: "2", worktree: "/wt/2", tier: "complex" }));
    db.query("UPDATE spinoff SET status = 'failed' WHERE id = ?").run(b.row.id);
    db.close();
    return dbPath;
  }

  test("human output carries the tier share, the model, the tag and the notes", async () => {
    const r = await runCli(await seeded(), ["spinoff", "mix"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("tier share");
    expect(r.out).toContain("claude-haiku-5-5");
    expect(r.out).toContain("frontend");
    expect(r.out).toContain("(no model stamp)");
    expect(r.out).toContain("note: provider is not stamped");
  });

  test("--json is the report; -q is one line per tier", async () => {
    const dbPath = await seeded();
    const j = await runCli(dbPath, ["spinoff", "mix", "--json"]);
    const report = JSON.parse(j.out) as { total: number; tiers: Array<{ tier: string; count: number }> };
    expect(report.total).toBe(2);
    expect(report.tiers.map((t) => `${t.tier}:${t.count}`)).toEqual(["simple:1", "medium:0", "complex:1"]);
    const q = await runCli(dbPath, ["spinoff", "mix", "-q"]);
    expect(q.out.trimEnd().split("\n")).toEqual(["simple 1 50%", "medium 0 0%", "complex 1 50%"]);
  });

  test("an empty window reports 0 and the command writes nothing", async () => {
    const dbPath = await seeded();
    const future = await runCli(dbPath, ["spinoff", "mix", "--since", "2999-01-01", "--json"]);
    expect(future.code).toBe(0);
    expect((JSON.parse(future.out) as { total: number }).total).toBe(0);
    const after = openDb(dbPath);
    const n = (after.query("SELECT count(*) AS n FROM spinoff").get() as { n: number }).n;
    after.close();
    expect(n).toBe(2); // read-only is the ticket's AC; this is the one executable check of it
  });
});

describe("docs (1550)", () => {
  test("HELP and README name spinoff mix and the 50/30/20 target", () => {
    const README = cliDocs();
    const help = renderSubcommandHelp("spinoff", "mix");
    expect(help).toContain("spinoff mix");
    expect(README).toContain("spinoff mix");
    expect(help).toContain("50/30/20");
    expect(README).toContain("50/30/20");
  });
});

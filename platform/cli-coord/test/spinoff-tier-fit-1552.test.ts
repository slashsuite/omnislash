// ob 1552 — the builder rates its own tier when it hands off.
//
// The rating is the one signal only the builder has: it just did the work, so it knows whether a cheaper
// tier would have done it. It feeds the tier mix (1548) and the bake-off (1551), which is why it is
// recorded rather than merely printed, and why a REPEAT handoff records its own rating: each attempt is
// one observation.
//
// Pinned here, in the order the ticket asks for it:
//
//   * the trail row: `tier-fit: <rating> (ran <tier> on <model>) — <why>`, on the same decisions trail
//     `--note` writes, with NO migration and no new column;
//   * the readying note: the architect reads the same line (or an honest "unreported");
//   * omitted: the handoff still works, and prints a one-line hint that it was omitted;
//   * bad value: a usage error that stamps nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { decisionsForItem } from "../../../apps/cli/src/decisions.ts";
import { UsageError } from "../../../apps/cli/src/errors.ts";
import {
  TIER_FITS,
  TIER_FIT_UNREPORTED_LINE,
  readyingNote,
  tierFitLine,
  tierFitOf,
  type ReadyNoteFacts,
} from "../../../apps/cli/src/t3/dispatch.ts";
import {
  TIER_FIT_HINT,
  enqueueSpinoff,
  markSpinoffReady,
  type EnqueueInput,
  type SpinoffRow,
} from "../src/commands/spinoff.ts";
import { __setSh } from "./sh-no-pr.ts";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "1552",
  repo: "/r/omnislash",
  branch: "1552",
  mode: "interactive",
  brief: "rate the tier on handoff",
  tier: "simple",
  ...over,
});

/** A launched row that ran on a cheap tier, as 1552's own build did. */
async function seedLaunched(
  db: ReturnType<typeof freshDb>,
  over: { ticket?: string; branch?: string; worktree?: string; itemId?: string | null } = {},
): Promise<SpinoffRow> {
  const ticket = over.ticket ?? "1552";
  const branch = over.branch ?? "1552";
  const worktree = over.worktree ?? `/wt/${branch}`;
  const { row } = await enqueueSpinoff(db, input({ ticketRef: ticket, branch, worktree }));
  db.query(
    "UPDATE spinoff SET status = 'launched', agent_id = ?, worktree = ?, model = 'claude-haiku-5-5', item_id = ? WHERE id = ?",
  ).run(branch, worktree, over.itemId === undefined ? branch : over.itemId, row.id);
  return { ...row, status: "launched", agent_id: branch, worktree, model: "claude-haiku-5-5", item_id: over.itemId ?? branch };
}

describe("the rating itself (1552)", () => {
  test("accepts lower, right and higher, and trims the why", () => {
    for (const fit of TIER_FITS) {
      expect(tierFitOf(fit, "  wiring only  ")).toEqual({ fit, why: "wiring only" });
      expect(tierFitOf(fit, undefined)).toEqual({ fit, why: null });
    }
  });

  test("no rating and no why is simply no rating — the optional path", () => {
    expect(tierFitOf(undefined, undefined)).toBeNull();
    expect(tierFitOf("", "   ")).toBeNull();
  });

  test("a bad value is a refusal naming the three that work", () => {
    expect(() => tierFitOf("cheaper", null)).toThrow(UsageError);
    expect(() => tierFitOf("cheaper", null)).toThrow("'cheaper' is not a tier fit");
    expect(() => tierFitOf("cheaper", null)).toThrow("lower|right|higher");
  });

  test("a why with no rating is a refusal, not a silent drop — it explains nothing on its own", () => {
    expect(() => tierFitOf(undefined, "it felt easy")).toThrow(UsageError);
    expect(() => tierFitOf(undefined, "it felt easy")).toThrow("--tier-fit-why needs --tier-fit");
  });

  test("the line names the rating, the tier it ran and the model; an unknown model says so", () => {
    expect(tierFitLine("lower", "simple", "claude-haiku-5-5", "one file, one test")).toBe(
      "tier-fit: lower (ran simple on claude-haiku-5-5) — one file, one test",
    );
    expect(tierFitLine("higher", "medium", null, null)).toBe("tier-fit: higher (ran medium on (model unreported))");
  });
});

describe("the tier-fit goes on the ticket's decisions trail (1552)", () => {
  test("markSpinoffReady records it as a decision note, with the row's tier and model", async () => {
    const db = freshDb();
    const itemId = await createItem(db, { type: "task", title: "rate the tier" });
    const row = await seedLaunched(db, { itemId });

    const result = await markSpinoffReady(db, row, {}, { fit: "lower", why: "a flag and a trail row" });

    const line = "tier-fit: lower (ran simple on claude-haiku-5-5) — a flag and a trail row";
    expect(result.tierFit).toBe(line);
    const trail = await decisionsForItem(db, itemId);
    // Two rows, both the same move: the handoff itself (1515, no note here) and the rating beside it.
    expect(trail).toHaveLength(2);
    expect(trail[0].note).toBe(line);
    expect(trail[0].from).toBe("building");
    expect(trail[0].to).toBe("handed-off");
    expect(trail[0].spinoff_row).toBe(row.id);
    expect(trail[1].note).toBeNull();
  });

  test("no rating leaves no tier-fit row, and the result says so", async () => {
    const db = freshDb();
    const itemId = await createItem(db, { type: "task", title: "rate the tier" });
    const row = await seedLaunched(db, { itemId });

    const result = await markSpinoffReady(db, row, {});

    expect(result.tierFit).toBeNull();
    // The handoff is still a decision (1515); what it does not carry is a rating.
    const trail = await decisionsForItem(db, itemId);
    expect(trail.map((d) => d.note)).toEqual([null]);
  });

  test("a REPEAT handoff records its own rating, so each attempt is one observation", async () => {
    const db = freshDb();
    const itemId = await createItem(db, { type: "task", title: "rate the tier" });
    const row = await seedLaunched(db, { itemId });

    await markSpinoffReady(db, row, {}, { fit: "right", why: null });
    const repeat = await markSpinoffReady(db, { ...row, status: "ready-for-gate" }, {}, { fit: "higher", why: "the second pass hurt" });

    expect(repeat.already).toBe(true);
    const trail = await decisionsForItem(db, itemId);
    expect(trail.map((d) => d.note)).toEqual([
      "tier-fit: higher (ran simple on claude-haiku-5-5) — the second pass hurt",
      "tier-fit: right (ran simple on claude-haiku-5-5)",
      null,
    ]);
  });
});

describe("the readying note carries the rating (1552)", () => {
  const facts = (over: Partial<ReadyNoteFacts> = {}): ReadyNoteFacts => ({
    ticket: "1552",
    branch: "1552",
    worktree: "/wt/1552",
    commitsAhead: 1,
    state: "State: ready",
    builderNote: "gate: nx affected green",
    rowId: 42,
    status: "ready-for-gate",
    composedAt: "2026-10-20T21:00:00.000Z",
    ...over,
  });

  test("given, the note prints the same line the trail holds", () => {
    const line = tierFitLine("lower", "simple", "claude-haiku-5-5", "one flag");
    const note = readyingNote(facts({ tierFit: line }));
    expect(note).toContain(`  ${line}`);
  });

  test("omitted, the note says unreported rather than inventing a verdict", () => {
    const note = readyingNote(facts());
    expect(note).toContain(`  ${TIER_FIT_UNREPORTED_LINE}`);
  });
});

// --- the command path ------------------------------------------------------------------

function fakeGit(): void {
  restores.push(
    __setSh((cmd) => {
      const line = cmd.join(" ");
      if (line.includes("--porcelain")) return { ok: true, err: "", out: "" };
      if (line.includes("rev-list --count")) return { ok: true, err: "", out: "1\n" };
      return { ok: true, err: "", out: "State: ready\n" };
    }),
  );
}

const worktrees: string[] = [];
function worktree(): string {
  const wt = mkdtempSync(join(tmpdir(), "ob-wt-1552-"));
  worktrees.push(wt);
  restores.push(() => rmSync(wt, { recursive: true, force: true }));
  return wt;
}

/** A launched row on a tracker item, in a real (empty, clean) worktree. No launcher: no T3 credential read. */
async function seedCli(dbPath: string, wt: string): Promise<string> {
  const db = openDb(dbPath, { create: true });
  const itemId = await createItem(db, { type: "task", title: "rate the tier" });
  const { row } = await enqueueSpinoff(
    db,
    input({ worktree: wt, tier: "simple" }),
  );
  db.query(
    "UPDATE spinoff SET status = 'launched', agent_id = '1552', worktree = ?, model = 'claude-haiku-5-5', item_id = ? WHERE id = ?",
  ).run(wt, itemId, row.id);
  db.close();
  return itemId;
}

function trailFor(dbPath: string, itemId: string): Promise<Array<{ note: string | null }>> {
  const db = openDb(dbPath);
  return decisionsForItem(db, itemId).finally(() => db.close());
}

function statusOf(dbPath: string): string {
  const db = openDb(dbPath);
  const row = db.query("SELECT status FROM spinoff WHERE ticket_ref = '1552'").get() as { status: string };
  db.close();
  return row.status;
}

describe("ob spinoff handoff --tier-fit (1552)", () => {
  test("records the rating on the trail and prints no hint", async () => {
    const dbPath = freshDbPath();
    const itemId = await seedCli(dbPath, worktree());
    fakeGit();

    const res = await runCli(dbPath, [
      "spinoff",
      "handoff",
      "1552",
      "--tier-fit",
      "lower",
      "--tier-fit-why",
      "a flag and a trail row",
    ]);

    expect(res.code).toBe(0);
    expect(res.out).toContain("1552 handed off");
    expect(res.out).not.toContain(TIER_FIT_HINT);
    expect((await trailFor(dbPath, itemId)).map((d) => d.note)).toContain(
      "tier-fit: lower (ran simple on claude-haiku-5-5) — a flag and a trail row",
    );
  });

  test("omitting it still hands off — and prints the one-line hint", async () => {
    const dbPath = freshDbPath();
    const itemId = await seedCli(dbPath, worktree());
    fakeGit();

    const res = await runCli(dbPath, ["spinoff", "handoff", "1552"]);

    expect(res.code).toBe(0);
    expect(res.out).toContain(TIER_FIT_HINT);
    const trail = await trailFor(dbPath, itemId);
    expect(trail.filter((d) => d.note?.startsWith("tier-fit:"))).toHaveLength(0);
  });

  test("--json reports tier_fit, null when it was not rated", async () => {
    const ratedDb = freshDbPath();
    await seedCli(ratedDb, worktree());
    fakeGit();

    const rated = await runCli(ratedDb, ["spinoff", "handoff", "1552", "--tier-fit", "right", "--json"]);
    expect(JSON.parse(rated.out).tier_fit).toBe("tier-fit: right (ran simple on claude-haiku-5-5)");

    const unratedDb = freshDbPath();
    await seedCli(unratedDb, worktree());
    const unrated = await runCli(unratedDb, ["spinoff", "handoff", "1552", "--json"]);
    expect(JSON.parse(unrated.out).tier_fit).toBeNull();
  });

  test("a bad value is a usage error and stamps nothing", async () => {
    const dbPath = freshDbPath();
    const itemId = await seedCli(dbPath, worktree());
    fakeGit();

    const res = await runCli(dbPath, ["spinoff", "handoff", "1552", "--tier-fit", "cheaper"]);

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("'cheaper' is not a tier fit");
    expect(statusOf(dbPath)).toBe("launched");
    expect(await trailFor(dbPath, itemId)).toHaveLength(0);
  });
});

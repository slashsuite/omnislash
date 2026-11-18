import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { spinoffs as spinoffsHandler } from "../../../apps/cli/src/api/handlers.ts";
import { isReadyingNoteFor, readyNoteOpening } from "../../../apps/cli/src/t3/dispatch.ts";
import {
  enqueueSpinoff,
  spinoffStatusFilter,
  type EnqueueInput,
} from "../src/commands/spinoff.ts";
import { __setSh } from "./sh-no-pr.ts";
import { registerAgent } from "../src/agent.ts";
import {
  SPINOFF_STATUS_WORDS,
  isLandableToken,
  spinoffStatusWord,
  toStoredSpinoffStatus,
  withStatusWord,
} from "../src/spinoff-vocab.ts";

// 1513: one word per step. The stored values never change; every old spelling stays an accepted input.

const STORED = ["pending", "launching", "launched", "ready-for-gate", "merged", "failed"];
const OLD_WORDS = /\b(pending|launched|ready-for-gate|merged)\b/;

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "1513",
  repo: "/r/omnislash",
  branch: "1513",
  mode: "interactive",
  brief: "vocabulary",
  ...over,
});

async function seedLaunched(db: ReturnType<typeof freshDb>, ticket: string, worktree: string) {
  const { row } = await enqueueSpinoff(db, input({ ticketRef: ticket, branch: ticket, worktree }));
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, worktree = ? WHERE id = ?").run(ticket, worktree, row.id);
  await registerAgent(db, { id: ticket, ticket, branch: ticket, worktree, status: "working", ttlS: 900 });
  return row;
}

describe("spinoff vocabulary (1513)", () => {
  test("every stored value prints as the new word, and both spellings map back to the stored value", () => {
    expect(STORED.map(spinoffStatusWord)).toEqual([...SPINOFF_STATUS_WORDS]);
    for (const stored of STORED) {
      expect(toStoredSpinoffStatus(stored)).toBe(stored);
      expect(toStoredSpinoffStatus(spinoffStatusWord(stored))).toBe(stored);
    }
  });

  test("an unknown value prints as it is and maps to null", () => {
    expect(spinoffStatusWord("weird")).toBe("weird");
    expect(toStoredSpinoffStatus("weird")).toBeNull();
    expect(withStatusWord({ id: 1, status: "launched" })).toEqual({ id: 1, status: "building" });
  });

  test("State: landable is the word; State: ready (every pre-1513 commit) stays landable", () => {
    expect(isLandableToken("landable")).toBe(true);
    expect(isLandableToken("ready")).toBe(true);
    expect(isLandableToken(null)).toBe(false);
  });

  test("--status filter takes either spelling and refuses an unknown one", () => {
    expect(spinoffStatusFilter(undefined)).toBeUndefined();
    expect(spinoffStatusFilter("handed-off")).toBe("ready-for-gate");
    expect(spinoffStatusFilter("ready-for-gate")).toBe("ready-for-gate");
    expect(spinoffStatusFilter("queued")).toBe("pending");
    expect(spinoffStatusFilter("pending")).toBe("pending");
    expect(spinoffStatusFilter("building")).toBe("launched");
    expect(spinoffStatusFilter("landed")).toBe("merged");
    expect(() => spinoffStatusFilter("nope")).toThrow(/unknown spinoff status 'nope'/);
    expect(() => spinoffStatusFilter("constructor")).toThrow(/unknown spinoff status/);
    expect(toStoredSpinoffStatus("toString")).toBeNull();
  });

  test("the API's ?status= takes either spelling (an older or newer client both filter)", async () => {
    const db = freshDb();
    await seedLaunched(db, "1513", "/wt/1513");
    for (const status of ["launched", "building"]) {
      const r = await spinoffsHandler(db as never, { status });
      expect(r.spinoffs.map((s) => s.ticket_ref)).toEqual(["1513"]);
    }
    expect((await spinoffsHandler(db as never, { status: "queued" })).spinoffs).toEqual([]);
    db.close();
  });

  test("the readying note opens `handed off:`, and the pre-1513 opening is still recognised", () => {
    expect(readyNoteOpening("1513")).toBe("handed off: 1513");
    expect(isReadyingNoteFor("handed off: 1513\nrow: 7", "1513")).toBe(true);
    expect(isReadyingNoteFor("ready for the gate: 1513\nrow: 7", "1513")).toBe(true);
    expect(isReadyingNoteFor("handed off: 1514", "1513")).toBe(false);
  });
});

describe("spinoff CLI prints only the new words (1513)", () => {
  test("list (text + --json), --status in both spellings, and gateable", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath);
    await enqueueSpinoff(db, input({ ticketRef: "1513", branch: "1513", worktree: "/wt/1513" }));
    db.close();

    const text = await runCli(dbPath, ["spinoff", "list"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("queued");
    expect(text.out).not.toMatch(OLD_WORDS);

    const json = await runCli(dbPath, ["spinoff", "list", "--json"]);
    expect((JSON.parse(json.out) as Array<{ status: string }>).map((r) => r.status)).toEqual(["queued"]);

    for (const status of ["queued", "pending"]) {
      const r = await runCli(dbPath, ["spinoff", "list", "--status", status, "--json"]);
      expect(r.code).toBe(0);
      expect((JSON.parse(r.out) as unknown[]).length).toBe(1);
    }
    const bad = await runCli(dbPath, ["spinoff", "list", "--status", "nope"]);
    expect(bad.code).not.toBe(0);

    const gateable = await runCli(dbPath, ["spinoff", "gateable"]);
    expect(gateable.code).toBe(0);
    expect(gateable.out).not.toMatch(/ready-for-gate/);
  });

  for (const sub of ["handoff", "ready"]) {
    test(`\`ob spinoff ${sub}\` hands off and prints handed off / handed-off`, async () => {
      const dbPath = freshDbPath();
      const db = openDb(dbPath);
      const wt = mkdtempSync(join(tmpdir(), `ob-wt-1513-${sub}-`));
      await seedLaunched(db, "1513", wt);
      const restore = __setSh((cmd) =>
        cmd.includes("--porcelain") ? { ok: true, err: "", out: "" } : { ok: true, err: "", out: "State: ready — gated\n" },
      );
      try {
        const r = await runCli(dbPath, ["spinoff", sub, "1513"]);
        expect(r.code).toBe(0);
        expect(r.out).toContain("1513 handed off");
        expect(r.out).toContain("landable: yes");
        expect(r.out).not.toMatch(/ready-for-gate/);
        const again = await runCli(dbPath, ["spinoff", sub, "1513", "--json"]);
        expect(JSON.parse(again.out).status).toBe("handed-off");
        const listed = await runCli(dbPath, ["spinoff", "list", "--status", "ready-for-gate", "--json"]);
        expect((JSON.parse(listed.out) as Array<{ status: string }>).map((x) => x.status)).toEqual(["handed-off"]);
      } finally {
        restore();
        db.close();
        rmSync(wt, { recursive: true, force: true });
      }
    });
  }
});

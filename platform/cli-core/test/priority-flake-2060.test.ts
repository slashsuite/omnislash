// OB-2060 — `flake` is a priority of its own, between urgent and high.
//
// Two things a unit test of `parsePriority` cannot show, and this file does:
//   1. that the value survives the WHOLE command path, `add` → stored integer → `show`'s printed name, so
//      `--priority flake` and `--priority 5` are the same item field and neither is silently dropped; and
//   2. that `ob next` and `ob list --by priority` order it exactly urgent, flake, high, medium, low, none.
//      Ordering lives in TypeScript (worklist.ts → prioritySortRank), not in SQL, so reading it back through
//      the real commands is the only check that the store's integer 5 does not sort last.
import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { openDb } from "../../../apps/cli/src/db.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";

async function withDb<T>(body: (dbPath: string) => Promise<T>): Promise<T> {
  const dbPath = freshDbPath();
  const previousCreate = process.env.OMNISLASH_DB_CREATE;
  process.env.OMNISLASH_DB_CREATE = "1";
  try {
    openDb(dbPath, { create: true }).close();
    return await body(dbPath);
  } finally {
    if (previousCreate === undefined) delete process.env.OMNISLASH_DB_CREATE;
    else process.env.OMNISLASH_DB_CREATE = previousCreate;
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  }
}

type Row = { id: string; title: string; priority: string | null; effective_priority: string };

describe("OB-2060: the flake priority through the command path", () => {
  test("--priority flake and --priority 5 store the same priority, and show prints its name", async () => {
    await withDb(async (dbPath) => {
      for (const flag of ["flake", "5"]) {
        const added = await runCli(dbPath, ["add", `flake via ${flag}`, "--project", "acme", "--priority", flag, "--json"]);
        expect(added.code).toBe(0);
        const id = (JSON.parse(added.out) as { id: string }).id;

        const shown = await runCli(dbPath, ["show", id]);
        expect(shown.code).toBe(0);
        expect(shown.out).toContain("priority:  flake (explicit)");

        const asJson = await runCli(dbPath, ["show", id, "--json"]);
        const view = JSON.parse(asJson.out) as Row;
        expect(view.priority).toBe("flake");
        expect(view.effective_priority).toBe("flake");
      }
    });
  });

  test("a bogus priority is refused with a message naming flake, and creates nothing", async () => {
    await withDb(async (dbPath) => {
      const refused = await runCli(dbPath, ["add", "never made", "--project", "acme", "--priority", "bogus"]);
      expect(refused.code).not.toBe(0);
      expect(refused.err).toContain("flake");
      expect(refused.err).toContain("invalid --priority 'bogus'");

      const list = await runCli(dbPath, ["list", "--json"]);
      expect(JSON.parse(list.out) as Row[]).toEqual([]);
    });
  });

  test("next and list --by priority order urgent, flake, high, medium, low, none", async () => {
    await withDb(async (dbPath) => {
      const sequence = ["none", "low", "medium", "high", "flake", "urgent"];
      for (const priority of sequence) {
        const added = await runCli(dbPath, ["add", `item ${priority}`, "--project", "acme", "--priority", priority]);
        expect(added.code).toBe(0);
      }

      const expected = ["urgent", "flake", "high", "medium", "low", "none"];
      for (const args of [["next", "--json"], ["list", "--by", "priority", "--json"]]) {
        const ran = await runCli(dbPath, args);
        expect(ran.code).toBe(0);
        expect((JSON.parse(ran.out) as Row[]).map((r) => r.effective_priority)).toEqual(expected);
      }
    });
  });
});

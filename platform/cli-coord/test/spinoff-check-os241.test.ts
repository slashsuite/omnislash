// OS-241: the Machine page places an undispatched ticket by its newest check on its current body
// (currentCheckVerdicts), and re-reads when one is recorded (decisionsStamp). In-process against a fresh SQLite
// database: no network, no live store.
import { describe, expect, test } from "bun:test";
import { freshDbPath } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { decisionsStamp } from "../../../apps/cli/src/decisions.ts";
import { createItem, editItem, getItem } from "../../../apps/cli/src/items.ts";
import { currentCheckVerdicts, recordSpinoffCheck } from "../src/spinoff-check.ts";

const BODY = "Need stated.\n\n## Drilled\n- read\n\n## Done when\n- a test shows it";
const ALL_TWO = { problem: 2, scope: 2, done: 2, design: 2, proof: 2, unknowns: 2, size: 2 };
const side = (questions: string[] = []) => ({ does: "x", files: ["a.ts"], questions, scores: ALL_TWO });

describe("currentCheckVerdicts (OS-241)", () => {
  test("reads each item's newest check on its current body, and nothing for an unchecked or since-edited one", async () => {
    const db = openDb(freshDbPath());
    try {
      const go = await createItem(db, { type: "task", title: "go", body: BODY });
      const nogo = await createItem(db, { type: "task", title: "no-go", body: BODY });
      const edited = await createItem(db, { type: "task", title: "edited", body: BODY });
      const unchecked = await createItem(db, { type: "task", title: "unchecked", body: BODY });

      const before = await decisionsStamp(db);
      await recordSpinoffCheck(db, nogo, { architect: side(), checker: side() });
      // The recheck is newer and says no-go: it is the one that stands.
      await recordSpinoffCheck(db, nogo, { architect: side(), checker: side(["what about x?"]) });
      await recordSpinoffCheck(db, go, { architect: side(), checker: side() });
      await recordSpinoffCheck(db, edited, { architect: side(), checker: side() });
      await editItem(db, edited, { body: `${BODY}\n- one more` });
      expect(await decisionsStamp(db)).not.toBe(before);

      const items = await Promise.all([go, nogo, edited, unchecked].map(async (id) => ({ id, body: (await getItem(db, id))!.body })));
      const verdicts = await currentCheckVerdicts(db, items);
      expect(verdicts.get(go)).toBe("go");
      expect(verdicts.get(nogo)).toBe("no-go");
      expect(verdicts.has(edited)).toBe(false);
      expect(verdicts.has(unchecked)).toBe(false);
      expect((await currentCheckVerdicts(db, [])).size).toBe(0);
    } finally {
      db.close();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { runCli, freshDbPath } from "../../../apps/cli/test/helpers.ts";

// 154/G2: ob-native (side) tickets — a plain `ob add` task has no project → BASIC vocab — must be
// able to run the review-gate loop chart→start→ready→merged→close, which needed `ready`/`merged`
// added to the basic status set.
describe("review-gate statuses on ob-native tickets (154/G2)", () => {
  const status = async (dbPath: string, id: string): Promise<string> =>
    JSON.parse((await runCli(dbPath, ["show", id, "--json"])).out).status;

  test("chart→start→ready→merged→close works end-to-end", async () => {
    const dbPath = freshDbPath();
    const id = (await runCli(dbPath, ["add", "wire the launcher seam", "--project", "acme"])).out.trim();
    expect(await status(dbPath, id)).toBe("open");

    expect((await runCli(dbPath, ["start", id])).code).toBe(0);
    expect(await status(dbPath, id)).toBe("in_progress");

    const ready = await runCli(dbPath, ["ready", id]);
    expect(ready.code).toBe(0); // used to throw: BASIC_STATUSES lacked `ready`
    expect(await status(dbPath, id)).toBe("ready");

    expect((await runCli(dbPath, ["state", id, "merged"])).code).toBe(0);
    expect(await status(dbPath, id)).toBe("merged");

    expect((await runCli(dbPath, ["close", id])).code).toBe(0);
    expect(await status(dbPath, id)).toBe("done");
  });

  test("qa states remain invalid for a side ticket (basic vocab, no QA)", async () => {
    const dbPath = freshDbPath();
    const id = (await runCli(dbPath, ["add", "no qa here", "--project", "acme"])).out.trim();
    await runCli(dbPath, ["start", id]);
    await runCli(dbPath, ["ready", id]);
    const r = await runCli(dbPath, ["state", id, "qa_ready"]);
    expect(r.code).not.toBe(0);
  });
});

// OS-235: `ob spinoff resume` moves a handed-off row back to plain building when the work continues on the same
// row (PS-722: the owner's yes merged only the design doc and the builder carried on), so the row leaves the
// sentinel inbox. Unlike a sendback it clears the phase. Fresh SQLite file per test; no network.
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore } from "../../../apps/cli/src/db/store.ts";
import { ApiFault } from "../../../apps/cli/src/api/fault.ts";
import * as h from "../../../apps/cli/src/api/handlers.ts";
import { getAgent, registerAgent } from "../src/agent.ts";
import { enqueueSpinoff, getSpinoffRow, markSpinoffReady, recordSpinoffVerdict } from "../src/commands/spinoff.ts";

const paths: string[] = [];
afterEach(() => {
  for (const p of paths.splice(0)) for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
});

function dbAt(): { d: Database; path: string } {
  const path = freshDbPath();
  paths.push(path);
  return { d: openDb(path, { create: true }), path };
}

/** A handed-off row on the owner's merge call, as PS-722 was. */
async function ownerCallRow(d: Database): Promise<number> {
  const { row } = await enqueueSpinoff(d, { ticketRef: "PS-722", repo: "/r/ps", branch: "ps-722", mode: "interactive", brief: "b", launcher: "t3" });
  d.query("UPDATE spinoff SET status = 'launched', agent_id = 'ps-722', worktree = '/wt/ps-722' WHERE id = ?").run(row.id);
  await registerAgent(d, { id: "ps-722", ticket: "PS-722", branch: "ps-722", worktree: "/wt/ps-722", status: "working", ttlS: 900 });
  await recordSpinoffVerdict(d, (await getSpinoffRow(d, row.id))!, { verdict: "needs-human", reason: "merge the design doc?" });
  await markSpinoffReady(d, (await getSpinoffRow(d, row.id))!);
  const stored = (await getSpinoffRow(d, row.id))!;
  expect([stored.status, stored.phase]).toEqual(["ready-for-gate", "owner_merge_call"]);
  return row.id;
}

describe("OS-235 spinoff resume", () => {
  test("ob spinoff resume moves it, clears the answered verdict and puts the builder back to working", async () => {
    const { d, path } = dbAt();
    const id = await ownerCallRow(d);
    d.close();
    const missing = await runCli(path, ["spinoff", "resume", "PS-722"]);
    expect(missing.code).not.toBe(0);
    const ok = await runCli(path, ["spinoff", "resume", "PS-722", "--note", "the rest of the ticket", "--json"]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.out)).toEqual({ id, ticket: "PS-722", status: "building" });
    const list = await runCli(path, ["spinoff", "list", "--json"]);
    expect((JSON.parse(list.out) as Array<{ phase: string | null }>)[0]!.phase).toBeNull();
    const again = openDb(path);
    const row = (await getSpinoffRow(again, id))!;
    expect([row.verdict, row.verdict_reason, row.gate_line]).toEqual([null, null, null]);
    expect((await getAgent(again, "ps-722"))?.status).toBe("working");
    again.close();
  });

  test("the API resumes it (400 without a note, 404 for no row, 409 when not handed off)", async () => {
    const { d } = dbAt();
    const id = await ownerCallRow(d);
    const store = asStore(d);
    expect(((await h.spinoffResume(store, { id, note: "" }).catch((e: unknown) => e)) as ApiFault).status).toBe(400);
    expect(((await h.spinoffResume(store, { id: 999, note: "x" }).catch((e: unknown) => e)) as ApiFault).status).toBe(404);
    const res = await h.spinoffResume(store, { id, note: "the rest" });
    expect([res.row.status, res.row.phase]).toEqual(["launched", null]);
    expect(((await h.spinoffResume(store, { id, note: "again" }).catch((e: unknown) => e)) as ApiFault).status).toBe(409);
  });
});

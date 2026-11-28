// OS-203: a row stuck at `launching` (the launch timed out after T3 made the thread) and a row still
// `pending` on a ticket that closed before it launched are settled by reconcile, never relaunched.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { addTags, createItem } from "../../../apps/cli/src/items.ts";
import { __setSh, enqueueSpinoff, listSpinoffs, localSpinoffSteps, reconcileSpinoffs } from "../src/commands/spinoff.ts";

let restoreSh: (() => void) | null = null;
const dirs: string[] = [];
afterEach(() => {
  restoreSh?.();
  restoreSh = null;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type Db = ReturnType<typeof freshDb>;
type Commit = { sha: string; subject: string; body: string };

const reconcile = (db: Db, commits: Commit[] = []) =>
  reconcileSpinoffs(db, () => false, undefined, () => 0, "", localSpinoffSteps(db), () => commits);

/** A row as a timed-out launch leaves it: `launching`, no base sha, claimed long ago. */
async function seedLaunching(db: Db, ticket: string, ageS: number, baseSha: string | null = null): Promise<number> {
  const { row } = await enqueueSpinoff(db, { ticketRef: ticket, repo: "/r/omnislash", branch: ticket, mode: "interactive", brief: "a fix" });
  const at = new Date(Date.now() - ageS * 1000).toISOString();
  db.query("UPDATE spinoff SET status = 'launching', base_sha = ?, launched_at = ?, request_at = ? WHERE id = ?").run(baseSha, at, at, row.id);
  return row.id;
}

describe("stuck launching rows settle (OS-203)", () => {
  test("a launching row with a null base_sha on a closed ticket ends merged after one reconcile", async () => {
    const db = freshDb();
    const done = await createItem(db, { type: "task", title: "closed while launching", status: "done" });
    await seedLaunching(db, done, 900);
    await reconcile(db);
    expect((await listSpinoffs(db, "merged")).map((r) => r.ticket_ref)).toEqual(["OB-1"]);
    expect(await listSpinoffs(db, "launching")).toEqual([]);
    expect(await listSpinoffs(db, "pending")).toEqual([]);
    expect(await listSpinoffs(db, "failed")).toEqual([]);
  });

  test("a launching row younger than the claim TTL is left to its launcher", async () => {
    const db = freshDb();
    const done = await createItem(db, { type: "task", title: "still launching", status: "done" });
    await seedLaunching(db, done, 30);
    await reconcile(db);
    expect((await listSpinoffs(db, "launching")).map((r) => r.ticket_ref)).toEqual(["OB-1"]);
  });

  test("a stuck launching row on an open ticket with no landing commit is left alone", async () => {
    const db = freshDb();
    const open = await createItem(db, { type: "task", title: "open", status: "open" });
    await seedLaunching(db, open, 900);
    await reconcile(db);
    expect((await listSpinoffs(db, "launching")).map((r) => r.ticket_ref)).toEqual(["OB-1"]);
  });

  test("a stuck launching row whose branch carries a landing commit lands though the ticket is open", async () => {
    const db = freshDb();
    const open = await createItem(db, { type: "task", title: "squashed", status: "open" });
    await seedLaunching(db, open, 900, "base0");
    // Newest first, as `git log` reads them: the landing commit sits above the row's base.
    await reconcile(db, [
      { sha: "abc", subject: "fix(OB-1): the build", body: "State: landable" },
      { sha: "base0", subject: "chore: before the dispatch", body: "" },
    ]);
    expect((await listSpinoffs(db, "merged")).map((r) => r.ticket_ref)).toEqual(["OB-1"]);
  });

  test("a stuck row with a null base_sha whose builder committed State: on its branch is stamped launched, not relaunched", async () => {
    const db = freshDb();
    const open = await createItem(db, { type: "task", title: "built, not merged", status: "open" });
    const id = await seedLaunching(db, open, 900);
    const worktree = mkdtempSync(join(tmpdir(), "ob-stuck-203-"));
    dirs.push(worktree);
    db.query("UPDATE spinoff SET worktree = ? WHERE id = ?").run(worktree, id);
    // The branch's own log (`main..branch`) carries the builder's verdict, and the branch left main at fork1.
    restoreSh = __setSh((argv) => {
      if (argv.includes("log")) return { ok: true, err: "", out: "fix(OB-1): the build\n\nState: landable\n" };
      if (argv.includes("merge-base")) return { ok: true, err: "", out: "fork1\n" };
      return { ok: true, err: "", out: "" };
    });
    // origin/main carries an OLDER landing commit for the same ticket (an earlier dispatch, before fork1):
    // it must not land this row, whose own work has not reached main.
    await reconcile(db, [
      { sha: "fork1", subject: "chore: main when the branch left it", body: "" },
      { sha: "old1", subject: "fix(OB-1): part 1", body: "State: landable" },
    ]);
    const launched = await listSpinoffs(db, "launched");
    expect(launched.map((r) => r.id)).toEqual([id]);
    expect(launched[0]!.base_sha).toBe("fork1");
    expect(await listSpinoffs(db, "merged")).toEqual([]);
    expect(await listSpinoffs(db, "launching")).toEqual([]);
    expect(await listSpinoffs(db, "pending")).toEqual([]);
  });

  test("a stuck spike row on a closed ticket ends failed with a reason", async () => {
    const db = freshDb();
    const done = await createItem(db, { type: "task", title: "a spike", status: "done" });
    await addTags(db, done, ["spike"]);
    await seedLaunching(db, done, 900);
    await reconcile(db);
    const failed = await listSpinoffs(db, "failed");
    expect(failed.map((r) => r.ticket_ref)).toEqual(["OB-1"]);
    expect(failed[0]!.error ?? "").not.toBe("");
    expect(await listSpinoffs(db, "merged")).toEqual([]);
  });
});

describe("pending rows on done tickets settle (OS-203)", () => {
  test("the row ends failed as closed before launch, and a new enqueue for that ref succeeds", async () => {
    const db = freshDb();
    const done = await createItem(db, { type: "task", title: "closed before launch", status: "done" });
    await enqueueSpinoff(db, { ticketRef: done, repo: "/r/omnislash", branch: done, mode: "interactive", brief: "a fix" });
    const rec = await reconcile(db);
    const failed = await listSpinoffs(db, "failed");
    expect(failed.map((r) => r.ticket_ref)).toEqual(["OB-1"]);
    expect(failed[0]!.error).toContain("closed before launch");
    expect(rec.retired?.map((r) => r.ticket)).toEqual(["OB-1"]);
    const again = await enqueueSpinoff(db, { ticketRef: done, repo: "/r/omnislash", branch: done, mode: "interactive", brief: "again" });
    expect(again.row.status).toBe("pending");
  });

  test("a pending row on an open ticket stays queued", async () => {
    const db = freshDb();
    const open = await createItem(db, { type: "task", title: "open", status: "open" });
    await enqueueSpinoff(db, { ticketRef: open, repo: "/r/omnislash", branch: open, mode: "interactive", brief: "a fix" });
    await reconcile(db);
    expect((await listSpinoffs(db, "pending")).map((r) => r.ticket_ref)).toEqual(["OB-1"]);
  });
});

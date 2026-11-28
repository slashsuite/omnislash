// OS-226: a building t3 row whose builder thread has ended (gone from T3, archived, settled or cancelled, with no run in
// flight) and that was never handed off leaves 'building' on the next reconcile: it is abandoned with a note, and its
// agent row is finished. A row whose builder committed a State: verdict, a spike, a live thread and a thread T3 cannot
// read are all kept.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { addTags, createItem } from "../../../apps/cli/src/items.ts";
import { T3Error, type T3Thread } from "../../../apps/cli/src/t3/client.ts";
import { __setSh, enqueueSpinoff, listSpinoffs, localSpinoffSteps, reconcileSpinoffs } from "../src/commands/spinoff.ts";
import { getAgent, registerAgent } from "../src/agent.ts";
import { builderIdOf } from "../src/clean-repo.ts";
import { isAbandoned } from "../src/spinoff-abandon.ts";
import { installFakeT3, type FakeT3Install } from "../../../apps/cli/test/fake-t3.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

type Db = ReturnType<typeof freshDb>;

/** A worktree directory on this machine, removed after the test. */
function localWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-os226-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const reconcile = (db: Db) => reconcileSpinoffs(db, () => false, undefined, () => 0, "", localSpinoffSteps(db), () => []);

function fakeT3(): FakeT3Install {
  const t3 = installFakeT3(["/r/omnislash"]);
  cleanups.push(t3.restore);
  return t3;
}

function thread(over: Partial<T3Thread> = {}): T3Thread {
  return {
    threadId: "thread-1", projectId: "proj-0", title: "OB-1 a fix", status: "idle", worktreePath: "/r/omnislash.ob-1", branch: "ob-1",
    settled: false, archived: false, model: "claude-opus-5-5", providerInstanceId: "claudeAgent", activeRunId: null, latestRunId: "run-1",
    ...over,
  };
}

/** A building t3 row on an open ticket, its thread stamped, its builder registered. */
async function seedBuilding(db: Db, opts: { threadId?: string; status?: string; worktree?: string; tags?: string[] } = {}): Promise<number> {
  const ticket = await createItem(db, { type: "task", title: "a fix", status: "open" });
  if (opts.tags) await addTags(db, ticket, opts.tags);
  const branch = ticket.toLowerCase();
  const { row } = await enqueueSpinoff(db, { ticketRef: ticket, repo: "/r/omnislash", branch, mode: "interactive", brief: "a fix" });
  const worktree = opts.worktree ?? "/nonexistent/omnislash.os226";
  db.query("UPDATE spinoff SET status = ?, launcher = 't3', t3_thread_id = ?, worktree = ?, base_sha = 'base0' WHERE id = ?").run(
    opts.status ?? "launched",
    opts.threadId ?? "thread-1",
    worktree,
    row.id,
  );
  await registerAgent(db, { id: builderIdOf({ ...row, branch }), ticket, branch, worktree, status: "working", ttlS: 900 });
  return row.id;
}

async function rowById(db: Db, id: number) {
  for (const status of ["launched", "ready-for-gate", "failed", "merged"]) {
    const found = (await listSpinoffs(db, status)).find((r) => r.id === id);
    if (found) return found;
  }
  throw new Error(`row ${id} not found`);
}

describe("reconcile abandons a building row whose builder thread ended (OS-226)", () => {
  test("a settled thread with no handoff: the row leaves building as abandoned, with a note, and its agent is finished", async () => {
    const db = freshDb();
    const t3 = fakeT3();
    t3.threads.push(thread({ settled: true }));
    const id = await seedBuilding(db);
    const rec = await reconcile(db);
    const row = await rowById(db, id);
    expect(row.status).toBe("failed");
    expect(isAbandoned(row)).toBe(true);
    expect(row.error).toContain("thread-1 was settled with no handoff");
    expect(rec.retired?.map((r) => r.ticket)).toEqual(["OB-1"]);
    expect(await getAgent(db, builderIdOf(row))).toBeNull();
  });

  test("a thread T3 no longer has, an archived thread and a cancelled one with no run in flight are all abandoned", async () => {
    const db = freshDb();
    const t3 = fakeT3();
    t3.threads.push(thread({ threadId: "thread-a", archived: true }), thread({ threadId: "thread-c", status: "cancelled" }));
    const read = t3.seam.read;
    t3.seam.read = async (id, ...rest) => {
      if (id === "thread-g") throw new T3Error("refused", "t3_thread_read: thread thread-g not found", undefined, "thread_not_found");
      return read(id, ...rest);
    };
    const g = await seedBuilding(db, { threadId: "thread-g", worktree: localWorktree() });
    const a = await seedBuilding(db, { threadId: "thread-a" });
    const c = await seedBuilding(db, { threadId: "thread-c" });
    await reconcile(db);
    for (const id of [g, a, c]) expect(isAbandoned(await rowById(db, id))).toBe(true);
    expect((await rowById(db, g)).error).toContain("is gone from T3");
    expect((await rowById(db, a)).error).toContain("was archived");
    expect((await rowById(db, c)).error).toContain("was cancelled");
  });

  test("a thread this machine's T3 does not have, on a row whose worktree is not on this machine, keeps the row building: another machine's T3 holds it", async () => {
    const db = freshDb();
    const t3 = fakeT3();
    t3.seam.read = async () => {
      throw new T3Error("refused", "t3_thread_read: thread thread-1 not found", undefined, "thread_not_found");
    };
    const id = await seedBuilding(db);
    await reconcile(db);
    expect((await rowById(db, id)).status).toBe("launched");
  });

  test("a live thread, an idle unsettled one, and a settled thread with a run still in flight keep the row building", async () => {
    const db = freshDb();
    const t3 = fakeT3();
    t3.threads.push(
      thread({ threadId: "thread-live", status: "running", activeRunId: "run-1" }),
      thread({ threadId: "thread-idle" }),
      thread({ threadId: "thread-busy", settled: true, status: "running", activeRunId: "run-2" }),
    );
    const ids = [
      await seedBuilding(db, { threadId: "thread-live" }),
      await seedBuilding(db, { threadId: "thread-idle" }),
      await seedBuilding(db, { threadId: "thread-busy" }),
    ];
    const rec = await reconcile(db);
    for (const id of ids) expect((await rowById(db, id)).status).toBe("launched");
    expect(rec.retired).toEqual([]);
  });

  test("a settled thread whose builder committed a State: verdict keeps the row building: it waits on a gate (OS-300)", async () => {
    const db = freshDb();
    const t3 = fakeT3();
    t3.threads.push(thread({ settled: true }));
    const worktree = localWorktree();
    cleanups.push(__setSh((argv) => (argv.includes("log") ? { ok: true, err: "", out: "fix(OB-1): the build\n\nState: landable\n" } : { ok: true, err: "", out: "" })));
    const id = await seedBuilding(db, { worktree });
    await reconcile(db);
    expect((await rowById(db, id)).status).toBe("launched");
  });

  test("a handed-off row whose thread settled is not touched", async () => {
    const db = freshDb();
    const t3 = fakeT3();
    t3.threads.push(thread({ settled: true }));
    const id = await seedBuilding(db, { status: "ready-for-gate" });
    await reconcile(db);
    expect((await rowById(db, id)).status).toBe("ready-for-gate");
  });

  test("a spike's row stays building until ob close, even with its thread settled", async () => {
    const db = freshDb();
    const t3 = fakeT3();
    t3.threads.push(thread({ settled: true }));
    const id = await seedBuilding(db, { tags: ["spike"] });
    await reconcile(db);
    expect((await rowById(db, id)).status).toBe("launched");
  });

  test("a thread T3 cannot read (not a thread_not_found) keeps the row building", async () => {
    const db = freshDb();
    fakeT3(); // the fake refuses an unknown thread without T3's thread_not_found code
    const id = await seedBuilding(db, { threadId: "thread-unknown" });
    await reconcile(db);
    expect((await rowById(db, id)).status).toBe("launched");
  });
});

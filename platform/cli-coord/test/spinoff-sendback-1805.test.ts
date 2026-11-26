import { liveRead, openRunsOnSeats } from "../../../apps/cli/test/role-run-fixture.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli, omnislashTeamFor } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { T3Error, type T3SendInput } from "../../../apps/cli/src/t3/client.ts";
import { __setT3Seam, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { registerAgent } from "../src/agent.ts";
import { enqueueSpinoff, type EnqueueInput } from "../src/commands/spinoff.ts";
import { __setSh } from "./sh-no-pr.ts";

// OB-1805: a re-handoff after a send-back reaches the architect, and a sent-back row stops reading handed-off.
// No live T3 and no live DB: a fake seam, a fake git and a temp database.

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

const SENTINEL_THREAD = "sentinel-thread-1";
const BUILDER_THREAD = "builder-thread-1";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

interface Fake {
  seam: T3Seam;
  sends: T3SendInput[];
  failSend: boolean;
}

function fakeSeam(): Fake {
  const fake: Fake = { sends: [], failSend: false, seam: {} as T3Seam };
  const no = (name: string) => async () => {
    throw new Error(`${name} is not used here`);
  };
  fake.seam = {
    interrupt: async () => {},
    projects: no("projects") as T3Seam["projects"],
    capabilities: no("capabilities") as T3Seam["capabilities"],
    list: no("list") as T3Seam["list"],
    read: liveRead,
    launch: no("launch") as T3Seam["launch"],
    rename: no("rename") as T3Seam["rename"],
    settle: async () => {},
    send: async (input) => {
      if (fake.failSend) throw new T3Error("refused", "t3_thread_send: unavailable", "retry, then check `ob t3 doctor`");
      fake.sends.push(input);
    },
    wait: async () => ({ runId: null, status: "idle", timedOut: false }),
    queue: async () => ({ items: [], complete: true }),
    pin: async () => {},
    unpin: async () => {},
    disableAutoSettle: async () => {},
    queueCancel: async () => {},
  };
  return fake;
}

/** Fake git whose branch head is whatever `head.sha` holds when the command runs, so a test can move it. */
function fakeGit(head: { sha: string }): void {
  restores.push(
    __setSh((cmd) => {
      const line = cmd.join(" ");
      if (line.includes("status --porcelain")) return { ok: true, err: "", out: "" };
      if (line.includes("rev-list --count")) return { ok: true, err: "", out: "2\n" };
      if (line.includes("log --format=%B")) return { ok: true, err: "", out: "fix(OB-1805): x\n\nState: landable\n" };
      if (line.includes("rev-parse --verify --quiet")) return { ok: true, err: "", out: `${head.sha}\n` };
      return { ok: true, err: "", out: "" };
    }),
  );
}

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "1805",
  repo: "/r/omnislash",
  branch: "1805",
  mode: "interactive",
  brief: "send-back",
  ...over,
});

async function seed(db: ReturnType<typeof openDb>, status = "launched"): Promise<number> {
  const wt = mkdtempSync(join(tmpdir(), "ob-wt-1805-"));
  restores.push(() => rmSync(wt, { recursive: true, force: true }));
  const { row } = await enqueueSpinoff(db, input({ worktree: wt }));
  db.query("UPDATE spinoff SET status = ?, agent_id = ?, worktree = ?, launcher = 't3', t3_thread_id = ?, base_sha = 'base123' WHERE id = ?").run(
    status,
    "1805",
    wt,
    BUILDER_THREAD,
    row.id,
  );
  await registerAgent(db, { id: "1805", ticket: "1805", branch: "1805", worktree: wt, status: "readying", note: "gate green; skeptical-review: 0 cut, 0 open", ttlS: 900 });
  omnislashTeamFor(db, "1805");
  db.query("UPDATE spinoff SET item_id = '1805' WHERE id = ?").run(row.id);
  await registerAgent(db, { id: "sentinel-omnislash", worktree: "/r/omnislash", status: "planning", launcher: "t3", sessionId: SENTINEL_THREAD, ttlS: 900 });
  await openRunsOnSeats(db);
  return row.id;
}

const statusOf = (db: ReturnType<typeof openDb>): string => (db.query("SELECT status FROM spinoff WHERE ticket_ref = '1805'").get() as { status: string }).status;

describe("the readying note's key is the head SHA (OB-1805)", () => {
  test("two handoffs on different SHAs with the same State store and deliver two notes; two on one SHA deliver one", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    const head = { sha: SHA_A };
    fakeGit(head);
    await seed(db);
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    expect((await runCli(dbPath, ["spinoff", "handoff", "1805"])).code).toBe(0);
    expect((await runCli(dbPath, ["spinoff", "handoff", "1805"])).code).toBe(0); // same commit again
    head.sha = SHA_B; // the fix: a new commit, State: landable unchanged
    expect((await runCli(dbPath, ["spinoff", "handoff", "1805"])).code).toBe(0);

    // OS-56: the key is the stored handoff's: a repeat on one commit stores nothing new, so nothing is delivered.
    const stored = db.query("SELECT id, client_key FROM role_message ORDER BY id").all() as Array<{ id: number; client_key: string }>;
    expect(stored).toHaveLength(2);
    expect(stored[0]!.client_key).toContain(SHA_A);
    expect(stored[1]!.client_key).toContain(SHA_B);
    expect(fake.sends.map((s) => s.clientRequestId)).toEqual(stored.map((m, i) => `ob-role-msg-${fake.sends[i]!.threadId}-${m.id}`));
  });

});

describe("handoff output does not claim 'told' (OB-1805)", () => {
  test("a first handoff says the note was queued at the commit, and never 'told'", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit({ sha: SHA_A });
    await seed(db);
    restores.push(__setT3Seam(fakeSeam().seam));
    const res = await runCli(dbPath, ["spinoff", "handoff", "1805"]);
    expect(res.out).toContain(`note:      omnislash sentinel: 1 message queued into run 1, thread ${SENTINEL_THREAD}`);
    expect(res.out).not.toContain("told");
  });

  test("a repeat on an already handed-off row says the handoff was already given to its run", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit({ sha: SHA_A });
    await seed(db);
    restores.push(__setT3Seam(fakeSeam().seam));
    await runCli(dbPath, ["spinoff", "handoff", "1805"]);
    const again = await runCli(dbPath, ["spinoff", "handoff", "1805"]);
    expect(again.out).toContain("already handed off");
    expect(again.out).toContain("nothing unread to deliver; this handoff was already given to its run");
    expect(again.out).not.toContain("told");
  });
});

describe("ob spinoff sendback (OB-1805)", () => {
  test("moves the row to building, posts the note to the builder's thread, and tells it to hand off again", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit({ sha: SHA_A });
    await seed(db, "ready-for-gate");
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "sendback", "1805", "--note", "the gate check fails: fix the lint error in x.ts"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("now building");
    expect(statusOf(db)).toBe("launched");
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.threadId).toBe(BUILDER_THREAD);
    expect(fake.sends[0]!.message).toContain("fix the lint error in x.ts");
    expect(fake.sends[0]!.message).toContain("ob spinoff handoff");
    // the sidebar stops saying the builder is waiting on the architect
    expect(db.query("SELECT status FROM agent WHERE id = '1805'").get()).toMatchObject({ status: "working" });
  });

  test("gateable hides a sent-back row, and a handoff after the send-back returns it", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    const head = { sha: SHA_A };
    fakeGit(head);
    await seed(db, "ready-for-gate");
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    expect((await runCli(dbPath, ["spinoff", "gateable", "-q"])).out).toContain("1805");
    expect((await runCli(dbPath, ["spinoff", "sendback", "1805", "--note", "fix it"])).code).toBe(0);
    expect((await runCli(dbPath, ["spinoff", "gateable", "-q"])).out).not.toContain("1805");

    head.sha = SHA_B;
    const back = await runCli(dbPath, ["spinoff", "handoff", "1805"]);
    expect(back.code).toBe(0);
    expect(statusOf(db)).toBe("ready-for-gate");
    expect((await runCli(dbPath, ["spinoff", "gateable", "-q"])).out).toContain("1805");
    // the re-handoff note went out under the NEW commit's id (sentinel thread), the send-back under the builder's
    const toSentinel = fake.sends.filter((s) => s.threadId === SENTINEL_THREAD);
    expect(toSentinel).toHaveLength(1);
    expect(toSentinel[0]!.clientRequestId).toBe(`ob-role-msg-${SENTINEL_THREAD}-1`);
    expect((db.query("SELECT client_key FROM role_message").get() as { client_key: string }).client_key).toContain(SHA_B);
  });

  test("refuses by name a row that is not handed-off, and changes nothing", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit({ sha: SHA_A });
    await seed(db, "launched");
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "sendback", "1805", "--note", "fix it"]);
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("is building, not handed-off");
    expect(statusOf(db)).toBe("launched");
    expect(fake.sends).toHaveLength(0);
  });

  test("refuses by name a row with no builder thread", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit({ sha: SHA_A });
    await seed(db, "ready-for-gate");
    db.query("UPDATE spinoff SET t3_thread_id = NULL WHERE ticket_ref = '1805'").run();
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "sendback", "1805", "--note", "fix it"]);
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("has no builder thread to tell");
    expect(statusOf(db)).toBe("ready-for-gate");
    expect(fake.sends).toHaveLength(0);
  });

  test("needs a --note", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit({ sha: SHA_A });
    await seed(db, "ready-for-gate");
    restores.push(__setT3Seam(fakeSeam().seam));
    const res = await runCli(dbPath, ["spinoff", "sendback", "1805"]);
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("--note");
    expect(statusOf(db)).toBe("ready-for-gate");
  });

  test("a note T3 refuses puts the row back to handed-off and says so", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit({ sha: SHA_A });
    await seed(db, "ready-for-gate");
    const fake = fakeSeam();
    fake.failSend = true;
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "sendback", "1805", "--note", "fix it"]);
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("could not tell the builder thread");
    expect(res.err).toContain("still handed-off");
    expect(statusOf(db)).toBe("ready-for-gate");
  });
});

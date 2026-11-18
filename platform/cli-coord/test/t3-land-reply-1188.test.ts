// 1188 — the land reply must be an explicit STOP, and the settle must survive a builder that is still
// working when the reply lands.
//
// The live evidence: measured at the 1163 land, the sentence ob sent ("nothing further is needed from this
// thread") STARTED a fresh builder turn that re-read the ticket and re-loaded its tooling ("I'll start by
// loading the acme CLI surface…", "Now let me make the schema changes."), and that live turn is exactly
// what refuses the settle that follows. A message is the only vehicle this build offers — `t3_thread_send`
// has no note-only mode, every mode starts a run — so the NOTE'S WORDING is the whole of ob's lever on the
// wasted work turn, and the bounded settle RETRY is the fix for the refusal.
//
// No server and no network: the fake below models the two measured T3 behaviours (a delivered message
// starts a run; a settle while a run is live is refused). The fake does NOT model a model: how long a real
// builder's turn runs, and what it chooses to put in it, is not something a test can decide, so the
// item-count claim is asserted by the LIVE measurement recorded in docs/t3-integration.md (`ob close` on a
// real thread: 2 items -> 4 — the note, and "Turn ended.") rather than by a fake programmed to obey.
import { afterEach, describe, expect, test } from "bun:test";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { T3Error, type T3SendInput } from "../../../apps/cli/src/t3/client.ts";
import {
  SETTLE_ATTEMPTS,
  __setT3Seam,
  landedNote,
  renderSettleOutcome,
  replyLandedToBuilders,
  settleThreadWithRetry,
  type T3Seam,
} from "../../../apps/cli/src/t3/dispatch.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { __setSh, enqueueSpinoff, type EnqueueInput } from "../src/commands/spinoff.ts";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

// ---------------------------------------------------------------------------
// A fake builder thread: a turn comes alive on a send, and a settle is refused while it is alive
// ---------------------------------------------------------------------------

/** The instruction ob's note carries, which is the whole of ob's lever on a re-activated builder. */
const STOP = /end your turn now/;

interface FakeBuilder {
  seam: T3Seam;
  sends: T3SendInput[];
  /** Everything ob wrote into the thread's messages view, in order — the items OB is responsible for. */
  items: string[];
  settleAttempts: number;
  waits: number;
  settled: boolean;
  /** A live turn: it refuses a settle, and each bounded wait lets it get `ticksLeft` closer to ending. */
  running: boolean;
  ticksLeft: number;
  neverEnds: boolean;
  /** The wait itself cannot be performed (T3 unreachable, thread gone): asking again would be a guess. */
  waitRefused: boolean;
}

function fakeBuilder(opts: { ticksLeft?: number } = {}): FakeBuilder {
  const f: FakeBuilder = {
    sends: [],
    items: [],
    settleAttempts: 0,
    waits: 0,
    settled: false,
    running: false,
    ticksLeft: opts.ticksLeft ?? 2,
    neverEnds: false,
    waitRefused: false,
    seam: {} as T3Seam,
  };
  const unimplemented = (name: string) => async () => {
    throw new Error(`${name} is not used by the land-reply path`);
  };
  f.seam = {
    interrupt: async () => {},
    projects: unimplemented("projects") as T3Seam["projects"],
    capabilities: unimplemented("capabilities") as T3Seam["capabilities"],
    list: unimplemented("list") as T3Seam["list"],
    read: unimplemented("read") as T3Seam["read"],
    launch: unimplemented("launch") as T3Seam["launch"],
    rename: unimplemented("rename") as T3Seam["rename"],
    settle: async (threadId) => {
      f.settleAttempts++;
      if (f.running) {
        throw new T3Error("refused", `t3_thread_organize: Thread ${threadId} is still running. Stop it before settling.`, undefined, "orchestration_error");
      }
      f.settled = true;
    },
    send: async (input) => {
      // T3's own rule, measured: a delivered message starts a turn. What the turn then DOES is the
      // builder's business, and no fake can decide it — so the fake only starts the run.
      f.sends.push(input);
      f.items.push(input.message);
      f.running = true;
    },
    wait: async () => {
      f.waits++;
      if (f.waitRefused) throw new T3Error("unreachable", "T3 server not reachable at http://127.0.0.1:3773", "is T3 running?");
      if (!f.neverEnds) {
        f.ticksLeft--;
        if (f.ticksLeft <= 0) f.running = false;
      }
      return { runId: f.running ? "run-2" : null, status: f.running ? "running" : "completed", timedOut: f.running };
    },
    // 1205: this thread's own queue is not what a land withdraws from (the ARCHITECT's is), and the readying
    // notes this test seeds are held by a separate fake — an empty answer here is "nothing held".
    queue: async () => ({ items: [], complete: true }),
    pin: async () => {},
    unpin: async () => {},
    disableAutoSettle: async () => {},
    queueCancel: async () => {},
  };
  return f;
}

// ---------------------------------------------------------------------------
// The note itself
// ---------------------------------------------------------------------------

describe("the land reply is a stop, not a work order (1188)", () => {
  // The acceptance's observable difference is "told it landed" versus "told it landed and it went back to
  // work", and this wording is the ONLY thing ob controls about it: the note is the only write a finished
  // thread can be given (`t3_thread_send` has no note-only mode), and whether a builder obeys is the
  // builder's choice. The item count under the real thing is measured live, not here — `ob close` on a real
  // thread took it 2 items -> 4: the note, and "Turn ended." (docs/t3-integration.md, 2026-10-18).
  test("the note is a stop: the fact, and an instruction no builder can read as work", () => {
    const note = landedNote({ ticket: "1188", sha: "1a9ca3fc" });
    expect(note).toContain("landed: 1188 is on main (squash 1a9ca3fc).");
    expect(note).toContain("INFORMATIONAL");
    expect(note).toContain("nothing further is needed from this thread");
    expect(note).toContain("Do not start or continue any work");
    expect(note).toMatch(STOP);
    // The note still never claims the settle: ob cannot know that at send time.
    expect(note).not.toContain("settled");
  });

  test("an unreadable sha is still reported as unreported, never guessed at", () => {
    const note = landedNote({ ticket: "1188", sha: null });
    expect(note).toContain("the merge commit sha is unreported");
    expect(note).not.toContain("squash");
  });

  // The other half of ob's side of the item count: ONE note per land, however many settle attempts it
  // takes. A retry that re-sent the note would be a second turn, i.e. exactly the growth this ticket
  // exists to stop.
  test("a land writes one note per row, however many settle attempts it takes", async () => {
    const fake = fakeBuilder({ ticksLeft: 3 });
    const out = await replyLandedToBuilders([{ id: 700, ticket_ref: "1188", worktree: "/wt/1188", t3_thread_id: "builder-thread-1" }], "1188", {
      seam: fake.seam,
      landShaFor: () => "1a9ca3fc",
    });
    await settleThreadWithRetry(fake.seam, "builder-thread-1");
    expect(out[0]!.outcome).toBe("sent");
    expect(fake.settleAttempts).toBeGreaterThan(1); // the live turn refused the first ask
    expect(fake.sends).toHaveLength(1);
    expect(fake.items).toHaveLength(1);
    expect(fake.items[0]).toMatch(STOP);
  });
});

// ---------------------------------------------------------------------------
// The settle retry
// ---------------------------------------------------------------------------
describe("settleThreadWithRetry (1188)", () => {
  test("a turn that outlasts the reply's wait still ends settled: the retry is what settles it", async () => {
    const fake = fakeBuilder({ ticksLeft: 2 });
    await fake.seam.send({ threadId: "t3-1", message: "x", mode: "queue" });
    // The reply's own bounded wait: the turn outlasts it (the 1163 shape).
    await fake.seam.wait("t3-1", 1);

    const out = await settleThreadWithRetry(fake.seam, "t3-1");
    expect(out.settled).toBe(true);
    expect(out.error).toBeNull();
    expect(out.attempts).toBe(2); // refused once while running, accepted after the wait
    expect(fake.settled).toBe(true);
    expect(fake.waits).toBe(2);
  });

  test("the first ask can be enough, and then it says nothing extra", async () => {
    const fake = fakeBuilder();
    const out = await settleThreadWithRetry(fake.seam, "t3-1");
    expect(out).toEqual({ settled: true, attempts: 1, error: null });
    expect(fake.waits).toBe(0); // no wait is paid when there is nothing to wait for
  });

  test("a turn that never ends says so ONCE, and the loop is bounded", async () => {
    const fake = fakeBuilder();
    await fake.seam.send({ threadId: "t3-1", message: landedNote({ ticket: "1188", sha: null }), mode: "queue" });
    fake.neverEnds = true;

    const out = await settleThreadWithRetry(fake.seam, "t3-1");
    expect(out.settled).toBe(false);
    expect(out.attempts).toBe(SETTLE_ATTEMPTS);
    expect(out.error).toContain("is still running");
    const rendered = renderSettleOutcome({ ticket: "1188", threadId: "t3-1", ...out });
    expect(rendered.warning).toBe(true);
    expect(rendered.line).toContain(`after ${SETTLE_ATTEMPTS} attempts`);
    expect(rendered.line).toContain("auto-settles in 3 days");
    expect(rendered.line.match(/NOT settled/g)).toHaveLength(1);
  });

  test("a wait that cannot be performed stops the loop: asking again would be a guess", async () => {
    const fake = fakeBuilder();
    await fake.seam.send({ threadId: "t3-1", message: "x", mode: "queue" });
    fake.waitRefused = true;

    const out = await settleThreadWithRetry(fake.seam, "t3-1");
    expect(out.settled).toBe(false);
    expect(out.attempts).toBe(1);
    expect(out.error).toContain("is still running");
    expect(fake.settleAttempts).toBe(1);
  });

  test("a refusal on a thread with no run is reported without waiting on anything", async () => {
    const fake = fakeBuilder();
    fake.seam.settle = async () => {
      fake.settleAttempts++;
      throw new T3Error("refused", `t3_thread_organize: thread t3-1 not found`, "re-read the tree", "thread_not_found");
    };
    const out = await settleThreadWithRetry(fake.seam, "t3-1");
    // The wait returns immediately for a thread with no run, so a non-live refusal costs fast asks and
    // never a two-minute hold on a close.
    expect(out.attempts).toBe(SETTLE_ATTEMPTS);
    expect(out.error).toContain("not found");
  });

  test("renderSettleOutcome keeps the one-shot sentence byte for byte, and names the attempts after a retry", () => {
    const once = renderSettleOutcome({ ticket: "1188", threadId: "t3-1", settled: false, attempts: 1, error: "boom" });
    expect(once.line).toBe("t3: 1188 closed, but thread t3-1 was NOT settled: boom (it auto-settles in 3 days)");
    const retried = renderSettleOutcome({ ticket: "1188", threadId: "t3-1", settled: false, attempts: 6, error: "boom" });
    expect(retried.line).toContain("was NOT settled after 6 attempts: boom");
    expect(renderSettleOutcome({ ticket: "1188", threadId: "t3-1", settled: true, attempts: 3, error: null })).toEqual({
      line: "  t3 thread t3-1 settled",
      warning: false,
    });
  });
});

// ---------------------------------------------------------------------------
// The close path: the same invocation settles it
// ---------------------------------------------------------------------------

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "1188",
  repo: "/r/acme",
  branch: "1188",
  mode: "interactive",
  brief: "the land reply wakes the builder",
  ...over,
});

/** The git facts the close reads: main carries a squash naming the ticket. */
function fakeGit(): void {
  restores.push(
    __setSh((cmd) => {
      const line = cmd.join(" ");
      if (line.includes("--fixed-strings")) return { ok: true, err: "", out: "1a9ca3fc\n" };
      return { ok: true, err: "", out: "" };
    }),
  );
}

/** A launched `t3` row for `itemId` — an `ob add` ticket, so the ref IS the item (1163's plain case). */
async function seedLaunchedRow(db: ReturnType<typeof freshDb>, threadId: string, itemId: string): Promise<void> {
  const { row } = await enqueueSpinoff(db, input({ ticketRef: itemId, worktree: "/wt/1188" }));
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, worktree = ?, launcher = 't3', t3_thread_id = ? WHERE id = ?").run(
    itemId,
    "/wt/1188",
    threadId,
    row.id,
  );
}

describe("ob close settles the thread in the same invocation (1188)", () => {
  test("a first settle the builder's live turn refuses is retried, and the close reports it settled", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    const itemId = await createItem(db, { type: "task", title: "The land reply wakes the builder" });
    await seedLaunchedRow(db, "builder-thread-1", itemId);
    // The thread is mid-turn when the land reply is delivered — the 1163 shape, where the reply's own wait
    // times out and the FIRST settle is refused. (The fake starts a run on the send, as T3 really does;
    // whether that run is short is the builder's business, which is the case the retry exists for.)
    const fake = fakeBuilder({ ticksLeft: 2 });
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["close", itemId]);
    expect(res.out + res.err).toContain("t3 thread builder-thread-1 settled");
    expect(res.out + res.err).not.toContain("was NOT settled");
    expect(fake.settled).toBe(true);
    expect(fake.settleAttempts).toBeGreaterThan(1);
    // The reply still went first, and the note it sent is the stop.
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.message).toMatch(STOP);
    expect(fake.sends[0]!.message).toContain(`landed: ${itemId} is on main (squash 1a9ca3fc)`);
  });
});

// The land reply's own wait is still bounded, and a timeout is still not a failed reply: 1188 adds a
// retry BEHIND the settle, it does not turn the reply's wait into a hold.
describe("the reply is unchanged by the retry (1188)", () => {
  test("a reply whose turn outlasts its wait is still 'sent', and the note still went first", async () => {
    const fake = fakeBuilder();
    const out = await replyLandedToBuilders(
      [{ id: 700, ticket_ref: "1188", worktree: "/wt/1188", t3_thread_id: "builder-thread-1" }],
      "1188",
      { seam: fake.seam, landShaFor: () => "1a9ca3fc", waitMs: 1 },
    );
    expect(out[0]!.outcome).toBe("sent");
    expect(fake.sends[0]!.message).toMatch(STOP);
  });
});

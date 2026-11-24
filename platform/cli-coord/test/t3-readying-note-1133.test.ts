// The readying note and the land reply (wayfinder ticket 1133 — the ob mirror for this one is ob 1135,
// because the two number sequences collide; the branch/worktree/spinoff row are 1133).
//
// What is asserted here is the SHAPE and the CONTRACT, not T3's own delivery: a fake seam records every
// message ob sends, so "the architect is told" and "the builder is told it landed" are checkable without a
// server, and the two properties that matter most are pinned explicitly — a headless row sends nothing,
// and a failed send never rolls back the stamp.
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { checkoutOf } from "../../../apps/cli/src/commands/t3-team.ts";
import { worktreeRepoOf } from "../../../apps/cli/src/t3/dispatch.ts";
import { liveRead, openRunsOnSeats } from "../../../apps/cli/test/role-run-fixture.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb, freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { T3Error, type T3SendInput } from "../../../apps/cli/src/t3/client.ts";
import { teamThreadIdOf } from "../../../apps/cli/src/team.ts";
import {
  __setReadyNoteRetryMs,
  __setT3Seam,
  announceReadyNote,
  landedNote,
  landedNoteRequestId,
  readyNoteRequestId,
  readyingNote,
  renderLandReplyOutcome,
  renderReadyNoteOutcome,
  replyLandedToBuilders,
  reviewLineFrom,
  storeAgentRegistry,
  type AgentRegistry,
  type T3Seam,
} from "../../../apps/cli/src/t3/dispatch.ts";
import { registerAgent } from "../src/agent.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { enqueueSpinoff, type EnqueueInput } from "../src/commands/spinoff.ts";
import { __setSh } from "./sh-no-pr.ts";

const restores: Array<() => void> = [];
// OB-2172: a failed note is retried once after a wait; these tests do not wait for it.
let restoreRetry: () => void = () => {};
beforeAll(() => {
  restoreRetry = __setReadyNoteRetryMs(0);
});
afterAll(() => restoreRetry());
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

// ---------------------------------------------------------------------------
// A fake T3 that records what ob delivers, and can be made to fail on demand
// ---------------------------------------------------------------------------

interface FakeSeam {
  seam: T3Seam;
  sends: T3SendInput[];
  settled: string[];
  /** Every call in order, so "the reply goes BEFORE the settle" is an assertion, not a hope. */
  events: string[];
  waited: string[];
  failSend: boolean;
  waitTimesOut: boolean;
}

function fakeSeam(): FakeSeam {
  const fake: FakeSeam = { sends: [], settled: [], events: [], waited: [], failSend: false, waitTimesOut: false, seam: {} as T3Seam };
  const unimplemented = (name: string) => async () => {
    throw new Error(`${name} is not used by the note paths`);
  };
  fake.seam = {
    interrupt: async () => {},
    projects: unimplemented("projects") as T3Seam["projects"],
    capabilities: unimplemented("capabilities") as T3Seam["capabilities"],
    list: unimplemented("list") as T3Seam["list"],
    read: liveRead,
    launch: unimplemented("launch") as T3Seam["launch"],
    rename: unimplemented("rename") as T3Seam["rename"],
    settle: async (threadId) => {
      fake.settled.push(threadId);
      fake.events.push(`settle:${threadId}`);
    },
    send: async (input) => {
      if (fake.failSend) throw new T3Error("refused", "t3_thread_send: unavailable", "retry, then check `ob t3 doctor`");
      fake.sends.push(input);
      fake.events.push(`send:${input.threadId}`);
    },
    wait: async (threadId) => {
      fake.waited.push(threadId);
      return { runId: null, status: "idle", timedOut: fake.waitTimesOut };
    },
    // 1205: this fake holds nothing — a land's withdrawal is exercised in its own test file.
    queue: async () => ({ items: [], complete: true }),
    pin: async () => {},
    unpin: async () => {},
    disableAutoSettle: async () => {},
    queueCancel: async () => {},
  };
  return fake;
}

/** A registry seam with one architect row, or none. `run` defaults to null: none of these rows has a run. */
function registryWith(
  rows: Record<string, { session_id: string | null; launcher: string | null; status: string | null; run?: string | null }>,
): AgentRegistry {
  return {
    read: async (id) => {
      const row = rows[id];
      return row ? { session_id: row.session_id, launcher: row.launcher, status: row.status, run: row.run ?? null } : null;
    },
    register: async () => {},
    setRun: async () => true,
  };
}

// ---------------------------------------------------------------------------
// The note itself — every fact ob holds, and nothing invented
// ---------------------------------------------------------------------------

describe("readyingNote (1133)", () => {
  const facts = {
    ticket: "1133",
    branch: "1133",
    worktree: "/home/owner/dev/omnislash.1133",
    commitsAhead: 3,
    state: "State: ready — gate green (nx typecheck clean)",
    builderNote: "nx test cli-coord 214 pass x2\nskeptical-review: 3 cut, 0 open",
    rowId: 595,
    status: "ready-for-gate",
    composedAt: "2026-10-18T01:11:00.000Z",
  };

  test("carries ticket, branch, worktree, commits, the State: line, the gate and the review line", () => {
    const note = readyingNote(facts);
    expect(note).toContain("ticket:    1133");
    expect(note).toContain("branch:    1133");
    expect(note).toContain("worktree:  /home/owner/dev/omnislash.1133");
    expect(note).toContain("commits:   3 ahead of the base commit");
    expect(note).toContain("State: ready — gate green (nx typecheck clean)");
    expect(note).toContain("nx test cli-coord 214 pass x2");
    expect(note).toContain("review:    skeptical-review: 3 cut, 0 open");
  });

  // 1267: no hook exists at DELIVERY (T3 hands a queued note over when the architect's turn ends, and
  // nothing ob can run fires then), so the note has to date itself. These are the facts that let a
  // reader see a late note is stale without re-verifying item, row, branch, worktree and main.
  test("dates itself: the row, its status AT COMPOSE TIME, and when it was queued", () => {
    const note = readyingNote(facts);
    expect(note).toContain("row:       595 · handed-off (as composed)");
    expect(note).toContain("composed:  2026-10-18T01:11:00.000Z");
    // The status says "as composed" on purpose: it is the honest label for a fact that a queued delivery
    // can outlive.
    expect(note).toContain("(as composed)");
  });

  test("names the ONE live check, and says plainly what a merged row means", () => {
    const note = readyingNote(facts);
    // Each stale fact is attributed to the command that answers it: `show` reports the row's recorded
    // status, `gateable` (the list ob-land reads) is what shows a merged row gone or a checkout missing.
    expect(note).toContain("`ob spinoff show 595`");
    expect(note).toContain("`ob spinoff gateable`");
    expect(note).toContain("nothing left to gate");
    expect(note).toContain("SNAPSHOT taken when it was queued");
    // OB-1686 (#82): the builder never merges its own PR, so the note tells the architect to gate and merge it.
    expect(note).toContain("The builder never merges its own PR");
    expect(note).toContain("gh pr merge --squash");
    expect(note).not.toContain("Land it when you are ready");
    // It must NOT promise a check that the command cannot make: `show` never tests the worktree.
    expect(note).not.toContain("whose worktree is gone");
  });

  test("says unreported rather than inventing a gate, a review line or a commit count", () => {
    const note = readyingNote({ ...facts, commitsAhead: null, state: null, builderNote: null });
    expect(note).toContain("(unreported — the row captured no base commit)");
    expect(note).toContain("(none — no State: line on the branch yet)");
    expect(note).toContain("(unreported — the builder registered no readying note)");
    expect(note).toContain("(unreported — no review line in that note)");
    expect(note).not.toContain("0 cut");
  });

  test("indents a multi-line builder note under its label, so the block stays one block", () => {
    const note = readyingNote(facts);
    const lines = note.split("\n");
    const gate = lines.findIndex((l) => l.startsWith("  gate:"));
    expect(lines[gate + 1]!.startsWith("             skeptical-review:")).toBe(true);
  });

  test("reviewLineFrom reads the review out of the note, and only that", () => {
    expect(reviewLineFrom("a\nskeptical-review: 3 cut, 0 open\nb")).toBe("skeptical-review: 3 cut, 0 open");
    expect(reviewLineFrom("review: clean")).toBe("review: clean");
    // 1413 renamed the skill to ob-skeptical-review; a builder that labels the line that way still reads.
    expect(reviewLineFrom("x; ob-skeptical-review: 1 cut, 0 open")).toBe("ob-skeptical-review: 1 cut, 0 open");
    // OB-1844: Sonnet, DeepSeek and Luna are the required legs; a failed or skipped one reads back whole.
    expect(reviewLineFrom("nx test cli 9 pass; skeptical-review: 1 cut, 0 open (sonnet: 1 + deepseek: 0 + luna: failed)")).toBe(
      "skeptical-review: 1 cut, 0 open (sonnet: 1 + deepseek: 0 + luna: failed)",
    );
    expect(reviewLineFrom("skeptical-review: 0 cut, 0 open (glm(for sonnet): 0); 097 additive")).toBe(
      "skeptical-review: 0 cut, 0 open (glm(for sonnet): 0)",
    );
    // Legacy: a note written before 1547 (#67, Fable as the required leg) still reads back whole.
    expect(reviewLineFrom("nx test cli 9 pass; skeptical-review: 1 cut, 0 open (fable: 1 + glm: 0)")).toBe(
      "skeptical-review: 1 cut, 0 open (fable: 1 + glm: 0)",
    );
    expect(reviewLineFrom("no review here")).toBeNull();
    expect(reviewLineFrom(null)).toBeNull();
  });

  test("the retry key is the row plus the head SHA (OB-1805): same commit is one note, a new commit is a second", () => {
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    expect(readyNoteRequestId(7, a, "State: landable")).toBe(readyNoteRequestId(7, a, "State: landable"));
    // a send-back fix keeps `State: landable`: only the SHA moves, and the key must move with it
    expect(readyNoteRequestId(7, a, "State: landable")).not.toBe(readyNoteRequestId(7, b, "State: landable"));
    expect(readyNoteRequestId(7, a)).not.toBe(readyNoteRequestId(8, a));
  });

  test("with no SHA the key falls back to the State line, as it did before OB-1805", () => {
    expect(readyNoteRequestId(7, null, "State: ready — a")).toBe(readyNoteRequestId(7, null, "State: ready — a"));
    expect(readyNoteRequestId(7, null, "State: ready — a")).not.toBe(readyNoteRequestId(7, null, "State: ready — b"));
    expect(readyNoteRequestId(7, null, null)).not.toBe(readyNoteRequestId(8, null, null));
  });
});

describe("teamThreadIdOf (1133, OB-2255)", () => {
  test("only a t3 row's session_id is a thread id", () => {
    expect(teamThreadIdOf({ session_id: "thread-1", launcher: "t3" })).toBe("thread-1");
    expect(teamThreadIdOf({ session_id: "ses_abc", launcher: "opencode" })).toBeNull();
    expect(teamThreadIdOf({ session_id: null, launcher: "t3" })).toBeNull();
    expect(teamThreadIdOf(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sending the note
// ---------------------------------------------------------------------------

const row = { id: 595, ticket_ref: "1133", branch: "1133", worktree: "/home/owner/dev/omnislash.1133", status: "ready-for-gate" };
const baseInput = {
  row,
  route: { kind: "team" as const, target: { agentId: "sentinel-omnislash", label: "omnislash sentinel", team: "omnislash" } },
  launcher: "t3",
  state: "State: ready",
  builderNote: "nx typecheck clean; skeptical-review: 0 cut, 0 open",
  commitsAhead: 2,
};

describe("announceReadyNote (1133)", () => {
  test("sends one queued message into the pinned sentinel thread, with a stable retry key", async () => {
    const fake = fakeSeam();
    const out = await announceReadyNote(registryWith({ "sentinel-omnislash": { session_id: "sentinel-thread-1", launcher: "t3", status: "idle" } }), {
      ...baseInput,
      seam: fake.seam,
    });
    expect(out.outcome).toBe("sent");
    expect(out.threadId).toBe("sentinel-thread-1");
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.mode).toBe("queue");
    expect(fake.sends[0]!.clientRequestId).toBe(readyNoteRequestId(row.id, null, "State: ready"));
    expect(fake.sends[0]!.message).toContain("handed off: 1133");
    // 1267: composed at the moment of composition (not an earlier caller clock read), and dated by shape
    // because the timestamp is the real one.
    expect(fake.sends[0]!.message).toContain("row:       595 · handed-off (as composed)");
    expect(fake.sends[0]!.message).toMatch(/composed:\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  });

  test("no sentinel thread is a named skip that names the remedy, and sends nothing", async () => {
    const fake = fakeSeam();
    const out = await announceReadyNote(registryWith({}), { ...baseInput, seam: fake.seam });
    expect(out.outcome).toBe("skipped");
    expect(out.reason).toBe("no omnislash sentinel thread: run `ob role start omnislash sentinel`");
    expect(fake.sends).toHaveLength(0);
  });

  test("a project in no team is a named skip, read nothing, and send nothing (OB-2255)", async () => {
    const fake = fakeSeam();
    const registry: AgentRegistry = {
      read: async () => {
        throw new Error("the registry must not be read when there is no team");
      },
      register: async () => {},
      setRun: async () => true,
    };
    const out = await announceReadyNote(registry, { ...baseInput, route: { kind: "skip", reason: "loose is in no team" }, seam: fake.seam });
    expect(out).toMatchObject({ outcome: "skipped", reason: "loose is in no team" });
    expect(fake.sends).toHaveLength(0);
  });

  test("an architect row from the opencode era is not a thread id", async () => {
    const fake = fakeSeam();
    const out = await announceReadyNote(
      registryWith({ "sentinel-omnislash": { session_id: "ses_abc", launcher: "opencode", status: "planning" } }),
      { ...baseInput, seam: fake.seam },
    );
    expect(out.outcome).toBe("skipped");
    expect(fake.sends).toHaveLength(0);
  });

  test("a headless row pays nothing: no send, no registry read, no credential", async () => {
    const fake = fakeSeam();
    const registry: AgentRegistry = {
      read: async () => {
        throw new Error("the registry must not be read for a headless row");
      },
      register: async () => {},
      setRun: async () => true,
    };
    const out = await announceReadyNote(registry, { ...baseInput, launcher: "headless", seam: fake.seam });
    expect(out.outcome).toBe("skipped");
    expect(out.reason).toContain("headless");
    expect(fake.sends).toHaveLength(0);
  });

  test("T3 refusing the note is a named failure carrying the remedy, never a throw", async () => {
    const fake = fakeSeam();
    fake.failSend = true;
    const out = await announceReadyNote(registryWith({ "sentinel-omnislash": { session_id: "sentinel-thread-1", launcher: "t3", status: "idle" } }), {
      ...baseInput,
      seam: fake.seam,
    });
    expect(out.outcome).toBe("failed");
    expect(out.reason).toContain("ob t3 doctor");
    expect(renderReadyNoteOutcome(out).warning).toBe(true);
  });

  test("a registry read that fails is reported, not swallowed", async () => {
    const fake = fakeSeam();
    const registry: AgentRegistry = {
      read: async () => {
        throw new Error("store is gone");
      },
      register: async () => {},
      setRun: async () => true,
    };
    const out = await announceReadyNote(registry, { ...baseInput, seam: fake.seam });
    expect(out.outcome).toBe("failed");
    expect(out.reason).toContain("store is gone");
  });
});

// ---------------------------------------------------------------------------
// The land reply
// ---------------------------------------------------------------------------

describe("replyLandedToBuilders (1133)", () => {
  const landedRows = [{ id: 595, ticket_ref: "1133", worktree: "/wt/1133", t3_thread_id: "builder-thread-1" }];

  test("tells the builder's thread it landed, with the squash sha, and waits for its own turn", async () => {
    const fake = fakeSeam();
    const out = await replyLandedToBuilders(landedRows, "1133", {
      seam: fake.seam,
      landShaFor: () => "1a9ca3fc",
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.outcome).toBe("sent");
    expect(out[0]!.waited).toBe(true);
    expect(fake.sends[0]!.threadId).toBe("builder-thread-1");
    expect(fake.sends[0]!.mode).toBe("queue");
    expect(fake.sends[0]!.message).toContain("landed: 1133 is on main (squash 1a9ca3fc)");
    expect(fake.sends[0]!.message).toContain("nothing further is needed");
    expect(fake.sends[0]!.clientRequestId).toBe(landedNoteRequestId(595, "1a9ca3fc"));
    // The wait is what lets the close's settle stick: measured, a settle while the note's turn is still
    // running is refused, and a settle after the turn ends is accepted.
    expect(fake.waited).toEqual(["builder-thread-1"]);
  });

  test("the note never claims the thread was settled — ob cannot know that at send time", () => {
    const note = landedNote({ ticket: "1133", sha: "1a9ca3fc" });
    expect(note).not.toContain("settled");
    expect(note).toContain("nothing further is needed from this thread");
  });

  test("a wait that times out still counts as sent: the note landed, only the settle is owed", async () => {
    const fake = fakeSeam();
    fake.waitTimesOut = true;
    const out = await replyLandedToBuilders(landedRows, "1133", { seam: fake.seam, landShaFor: () => null });
    expect(out[0]!.outcome).toBe("sent");
    expect(out[0]!.waited).toBe(false);
    expect(renderLandReplyOutcome(out[0]!).warning).toBe(false);
  });

  test("an unreadable sha is reported as unreported, never guessed at", () => {
    const note = landedNote({ ticket: "1133", sha: null });
    expect(note).toContain("the merge commit sha is unreported");
    expect(note).not.toContain("squash");
  });

  test("a row with no recorded thread id is a named skip, and T3 is never asked", async () => {
    const fake = fakeSeam();
    const out = await replyLandedToBuilders([{ id: 590, ticket_ref: "1133", worktree: "/wt/1133", t3_thread_id: null }], "1133", {
      seam: fake.seam,
      landShaFor: () => "abc",
    });
    expect(out[0]!.outcome).toBe("skipped");
    expect(out[0]!.waited).toBe(false);
    expect(out[0]!.reason).toContain("recorded no T3 thread id");
    expect(fake.sends).toHaveLength(0);
    expect(renderLandReplyOutcome(out[0]!).warning).toBe(false);
  });

  test("no rows at all means no work and no send", async () => {
    const fake = fakeSeam();
    expect(await replyLandedToBuilders([], "1133", { seam: fake.seam })).toEqual([]);
    expect(fake.sends).toHaveLength(0);
  });

  test("a refused reply is a warning, and the other rows still get theirs", async () => {
    const fake = fakeSeam();
    fake.failSend = true;
    const out = await replyLandedToBuilders(
      [landedRows[0]!, { id: 596, ticket_ref: "1133", worktree: "/wt/1133b", t3_thread_id: "builder-thread-2" }],
      "1133",
      { seam: fake.seam, landShaFor: () => null },
    );
    expect(out.map((o) => o.outcome)).toEqual(["failed", "failed"]);
    expect(out[0]!.reason).toContain("ob t3 doctor");
    expect(out[0]!.reason).toContain("builder-thread-1");
  });
});

// ---------------------------------------------------------------------------
// The command path: the stamp stands whatever the note does
// ---------------------------------------------------------------------------

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "1133",
  repo: "/r/omnislash",
  branch: "1133",
  mode: "interactive",
  brief: "the readying note",
  ...over,
});

/** The git facts the ready path reads: clean worktree, a State: line, two commits past the base. */
function fakeGit(): void {
  restores.push(
    __setSh((cmd) => {
      const line = cmd.join(" ");
      if (line.includes("status --porcelain")) return { ok: true, err: "", out: "" };
      if (line.includes("rev-list --count")) return { ok: true, err: "", out: "2\n" };
      if (line.includes("log --format=%B")) return { ok: true, err: "", out: "feat(x): y\n\nState: ready — gate green\n" };
      if (line.includes("rev-parse --verify")) return { ok: true, err: "", out: "base123\n" };
      return { ok: true, err: "", out: "" };
    }),
  );
}

async function seedReadyable(db: ReturnType<typeof freshDb>, launcher: string, t3ThreadId: string | null, ticketRef = "1133"): Promise<void> {
  // A REAL directory since 1188: `spinoff ready` refuses when the checkout it is about does not exist
  // (the hole a deleted worktree used to pass through), so a fake path no longer models a readyable row.
  const wt = mkdtempSync(join(tmpdir(), "ob-wt-1133-"));
  restores.push(() => rmSync(wt, { recursive: true, force: true }));
  const { row } = await enqueueSpinoff(db, input({ ticketRef, worktree: wt }));
  db.query(
    "UPDATE spinoff SET status = 'launched', agent_id = ?, worktree = ?, launcher = ?, t3_thread_id = ?, base_sha = ? WHERE id = ?",
  ).run("1133", wt, launcher, t3ThreadId, "base123", row.id);
  // OB-2255: the note goes to the ticket's team, so the row serves an omnislash item and omnislash is a team.
  db.query("INSERT INTO project_group (name, created_at) VALUES ('omnislash', '2026-11-17T00:00:00Z') ON CONFLICT DO NOTHING").run();
  db.query("INSERT INTO project (id, name, kind, created_at, group_name) VALUES ('omnislash', 'omnislash', 'side', '2026-11-17T00:00:00Z', 'omnislash') ON CONFLICT DO NOTHING").run();
  if (ticketRef === "1133") {
    const itemId = await createItem(db, { type: "task", title: "the readying note", projectId: "omnislash" });
    db.query("UPDATE spinoff SET item_id = ? WHERE id = ?").run(itemId, row.id);
  } else {
    db.query("UPDATE item SET project_id = 'omnislash' WHERE id = ?").run(ticketRef);
  }
  await registerAgent(db, {
    id: "1133",
    ticket: ticketRef,
    branch: "1133",
    worktree: wt,
    status: "readying",
    note: "nx typecheck clean; skeptical-review: 3 cut, 0 open",
    ttlS: 900,
  });
}

/** OS-56: the checkout a started role run opens in, as `ob role start` resolves it. */
const CWD_REPO = worktreeRepoOf(checkoutOf(process.cwd())) ?? checkoutOf(process.cwd());

describe("ob spinoff ready tells the sentinel (1133)", () => {
  test("the note goes to the pinned sentinel thread and the stamp is unchanged", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    await seedReadyable(db, "t3", "builder-thread-1");
    await registerAgent(db, { id: "sentinel-omnislash", worktree: "/r/omnislash", status: "planning", launcher: "t3", sessionId: "sentinel-thread-1", ttlS: 900 });
    await openRunsOnSeats(db);
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1133"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("1133 handed off");
    expect(res.out).toContain("note:      omnislash sentinel: 1 message queued into run 1, thread sentinel-thread-1");
    expect(res.out).not.toContain("told");
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.message).toContain("gate:      nx typecheck clean; skeptical-review: 3 cut, 0 open");
    expect(fake.sends[0]!.message).toContain("review:    skeptical-review: 3 cut, 0 open");
    expect(fake.sends[0]!.message).toContain("commits:   2 ahead of the base commit");
    expect(fake.sends[0]!.message).toContain("State: ready — gate green");
    expect(db.query("SELECT status FROM spinoff WHERE ticket_ref = '1133'").get()).toMatchObject({ status: "ready-for-gate" });
  });

  test("ready twice is one note: the second stores no new handoff, so nothing new is delivered (OS-56)", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    await seedReadyable(db, "t3", "builder-thread-1");
    await registerAgent(db, { id: "sentinel-omnislash", worktree: "/r/omnislash", status: "planning", launcher: "t3", sessionId: "sentinel-thread-1", ttlS: 900 });
    await openRunsOnSeats(db);
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    expect((await runCli(dbPath, ["spinoff", "ready", "1133"])).code).toBe(0);
    expect((await runCli(dbPath, ["spinoff", "ready", "1133"])).code).toBe(0);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.clientRequestId).toBe("ob-role-msg-1");
  });

  test("no sentinel thread: the handoff starts the sentinel's run (OS-56), exit 0, and the stamp still applied", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    await seedReadyable(db, "t3", "builder-thread-1");
    const t3 = installFakeT3([CWD_REPO]);
    restores.push(t3.restore);

    const res = await runCli(dbPath, ["spinoff", "ready", "1133"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("note:      omnislash sentinel: run 1 opened, thread t3-1, with 1 message in its start brief");
    expect(t3.launches).toHaveLength(1);
    expect(t3.sends).toHaveLength(0);
    expect(db.query("SELECT status FROM spinoff WHERE ticket_ref = '1133'").get()).toMatchObject({ status: "ready-for-gate" });
  });

  test("T3 down: the warning names the remedy, exit 1, and the stamp stands", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    await seedReadyable(db, "t3", "builder-thread-1");
    await registerAgent(db, { id: "sentinel-omnislash", worktree: "/r/omnislash", status: "planning", launcher: "t3", sessionId: "sentinel-thread-1", ttlS: 900 });
    await openRunsOnSeats(db);
    const fake = fakeSeam();
    fake.failSend = true;
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1133"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("the readying note did not reach the sentinel and is held");
    expect(res.err).toContain("ob t3 doctor");
    expect(db.query("SELECT status FROM spinoff WHERE ticket_ref = '1133'").get()).toMatchObject({ status: "ready-for-gate" });
  });

  test("a headless row sends nothing and reads no credential", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    await seedReadyable(db, "headless", null);
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1133"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("headless launcher, so there is no sentinel thread to tell");
    expect(fake.sends).toHaveLength(0);
  });

  test("--json carries the outcome, so a caller does not have to parse the prose", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    await seedReadyable(db, "t3", "builder-thread-1");
    await registerAgent(db, { id: "sentinel-omnislash", worktree: "/r/omnislash", status: "planning", launcher: "t3", sessionId: "sentinel-thread-1", ttlS: 900 });
    await openRunsOnSeats(db);
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1133", "--json"]);
    expect(res.code).toBe(0);
    const body = JSON.parse(res.out) as { status: string; architect_note: { outcome: string; threadId: string } };
    expect(body.status).toBe("handed-off");
    expect(body.architect_note.outcome).toBe("sent");
    expect(body.architect_note.threadId).toBe("sentinel-thread-1");
  });
});

// ---------------------------------------------------------------------------
// The close path: the builder is told it landed
// ---------------------------------------------------------------------------

describe("ob close tells the builder (1133)", () => {
  test("a landed ticket's builder thread gets the land note, beside the settle", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    const itemId = await createItem(db, { type: "task", title: "The readying note" });
    await seedReadyable(db, "t3", "builder-thread-1", itemId);
    // The land: main carries a squash naming the ticket.
    restores.push(
      __setSh((cmd) => {
        const line = cmd.join(" ");
        if (line.includes("--fixed-strings")) return { ok: true, err: "", out: "1a9ca3fc\n" };
        return { ok: true, err: "", out: "" };
      }),
    );
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["close", itemId]);
    expect(res.out + res.err).toContain("t3 thread builder-thread-1 settled");
    expect(fake.settled).toEqual(["builder-thread-1"]);
    const landNote = fake.sends.find((s) => s.message.includes("is on main"));
    expect(landNote).toBeDefined();
    expect(landNote!.threadId).toBe("builder-thread-1");
    expect(landNote!.message).toContain("squash 1a9ca3fc");
    // MEASURED ORDER, and it is the whole point of the review finding: a delivered message re-activates a
    // thread, so a settle that ran first would be undone by the reply. The reply goes first, and the settle
    // follows it once the note's own turn has ended.
    expect(fake.events).toEqual(["send:builder-thread-1", "settle:builder-thread-1"]);
    expect(fake.waited).toEqual(["builder-thread-1"]);
  });

  test("a row with no recorded thread id is a named skip, and the land stands", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    const itemId = await createItem(db, { type: "task", title: "The readying note" });
    await seedReadyable(db, "t3", null, itemId);
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["close", itemId]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("recorded no T3 thread id");
    expect(fake.sends).toHaveLength(0);
  });
});

// A store-backed registry read is what the command path uses; assert it reads the same row shape the
// fake above pretends to, so the seam is not drifting from the real one.
describe("storeAgentRegistry (1133)", () => {
  test("reads an architect row's thread id off the real registry", async () => {
    const db = freshDb();
    await registerAgent(db, { id: "sentinel-omnislash", worktree: "/r/omnislash", status: "planning", launcher: "t3", sessionId: "sentinel-thread-1", ttlS: 900 });
    const row = await storeAgentRegistry(db).read("sentinel-omnislash");
    expect(teamThreadIdOf(row)).toBe("sentinel-thread-1");
  });
});

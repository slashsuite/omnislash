// The architect's own ready stamp, and the note a LAND makes moot (ob 1205).
//
// Found in the overnight run of 2026-10-18: a "ready for the gate: 738" note arrived at 23:08 for a ticket
// landed, closed and reaped twelve minutes earlier. Its own contents proved the cause — it was composed by
// the architect's OWN `ob spinoff ready 738` at 22:48, and T3 QUEUED it, delivering it when the architect's
// turn ended. Two halves, and this file pins both:
//
//   * `ob spinoff ready --no-note`: the caller says "stamp only", because `ob-land` has the architect stamp
//     on the human's behalf and the architect IS the thread the note goes to. The builder's stamp is
//     unchanged: one note, exactly one.
//   * `ob close` withdraws a readying note the architect is still HOLDING for the ticket it just landed,
//     which is the same 1188 guard (never announce landed work) applied to the queued vehicle.
import { liveRead, openRunsOnSeats } from "../../../apps/cli/test/role-run-fixture.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { T3Client, type FetchLike, type T3QueuedMessage, type T3SendInput } from "../../../apps/cli/src/t3/client.ts";
import {
  __setT3Seam,
  dropQueuedReadyNotes,
  isReadyingNoteFor,
  landedNote,
  readyingNote,
  readyNoteOpening,
  renderReadyNoteOutcome,
  renderStaleNoteOutcome,
  storeAgentRegistry,
  type AgentRegistry,
  type T3Seam,
} from "../../../apps/cli/src/t3/dispatch.ts";
import {
  enqueueSpinoff,
  noNoteOutcome,
  type EnqueueInput,
} from "../src/commands/spinoff.ts";
import { __setSh } from "./sh-no-pr.ts";
import { registerAgent } from "../src/agent.ts";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

// ---------------------------------------------------------------------------
// A fake T3 that records the queue, the sends, the withdrawals and the settles
//
// Its QUEUE half is the real `T3Client` over a fake MCP endpoint (1264): a seam that returns a
// `T3QueueRead` of its own invention cannot see the arguments `T3Client.queue` sends, and that blind spot
// is exactly how a first page of `cursor: null` reached the live T3 and stopped every withdrawal.
// ---------------------------------------------------------------------------

interface FakeArchitect {
  seam: T3Seam;
  sends: T3SendInput[];
  /** The architect thread's HELD messages, by thread id: what the queue serves and a cancel removes. */
  held: Record<string, T3QueuedMessage[]>;
  cancelled: Array<{ threadId: string; queuedRunId: string }>;
  queueReads: string[];
  settled: string[];
  /** Every call in order, so "the withdrawal happens at the land" is an assertion, not a hope. */
  events: string[];
  /** Every MCP tool call WITH the arguments it was sent, so a wire shape can be pinned (1264). */
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  failQueue: boolean;
  /**
   * True when the queue does NOT come back in ONE page — the only shape in which a read is not complete.
   * The fake serves it one message per page, each claiming another cursor, exactly as a live offset page
   * does when the queue is being drained underneath it.
   */
  queueBounded: boolean;
}

/** The base URL the fake MCP endpoint is reached at — never dialled, the fetch is injected. */
const FAKE_T3_BASE = "https://t3.fake.test";

function fakeCredential() {
  return {
    version: 1 as const,
    baseUrl: FAKE_T3_BASE,
    accessToken: "t",
    tokenType: "Bearer",
    access: "full-access",
    scopes: [] as string[],
    issuedAt: "2026-10-18T00:00:00.000Z",
    expiresAt: "2027-10-18T00:00:00.000Z",
  };
}

/**
 * The fake T3 MCP endpoint the seam's QUEUE half talks to (1264).
 *
 * The 1205 builder's fake stood ABOVE this boundary: it returned a `T3QueueRead` and never looked at what
 * `T3Client.queue` puts on the wire, so a first page sent as `cursor: null` passed every test while the
 * live T3 refused the call — which is why `ob close` could not withdraw a held readying note at all.
 *
 * So this fake sits UNDER the real client, and it validates the one argument that was wrong the way T3's
 * own schema does: `cursor?: number`. Absent is fine, a number is fine, `null` is an invalid argument that
 * refuses the whole call BEFORE a page is read. A regression here now fails the close path itself.
 *
 * A page is a live OFFSET page, as the tool documents: `queueBounded` expresses the only shape in which the
 * read is not complete — a queue that does not come back in ONE page.
 */
function fakeMcp(fake: FakeArchitect) {
  const json = (payload: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl: FetchLike = async (input, init) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as {
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const url = String(input);
    if (body.method === "initialize") {
      return json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "0.1.0" } } }, { "mcp-session-id": "s-fake" });
    }
    if (body.method === "notifications/initialized") return json({});
    if (body.method !== "tools/call") throw new Error(`unexpected MCP request to ${url}: ${body.method}`);
    const name = body.params?.name ?? "";
    const args = body.params?.arguments ?? {};
    if (name === "t3_queue" && args.action === "list" && fake.failQueue) throw new Error("connect ECONNREFUSED 127.0.0.1:3773");
    fake.calls.push({ name, args });
    const threadId = String(args.threadId ?? "");
    const held = fake.held[threadId] ?? [];
    if (name === "t3_queue" && args.action === "list") {
      fake.queueReads.push(threadId);
      if ("cursor" in args && typeof args.cursor !== "number") {
        // Shape of the live cursor refusal (`ob close 1205`, 2026-10-18, under the old `t3_queue_list` name).
        return json({
          jsonrpc: "2.0",
          id: 2,
          error: {
            code: -32602,
            message: `Invalid parameters for tool 't3_queue': Expected number | undefined at ["cursor"] — check the tool name/arguments`,
          },
        });
      }
      const from = typeof args.cursor === "number" ? args.cursor : 0;
      const page = held.slice(from, from + (fake.queueBounded ? 1 : Number.MAX_SAFE_INTEGER));
      const next = from + page.length;
      // `queueBounded` claims another cursor from the FIRST page onwards, so a bounded read is incomplete
      // even when the queue it was reading was empty: that is the honest shape (the tool is a live offset
      // page, so "nothing here" is not "nothing was there").
      const more = fake.queueBounded ? from === 0 || page.length > 0 : next < held.length;
      return json({ jsonrpc: "2.0", id: 2, result: { structuredContent: { items: page, nextCursor: more ? next : null } } });
    }
    if (name === "t3_queue" && args.action === "cancel") {
      const queuedRunId = String(args.queuedRunId ?? "");
      fake.cancelled.push({ threadId, queuedRunId });
      fake.events.push(`cancel:${queuedRunId}`);
      fake.held[threadId] = held.filter((m) => m.queuedRunId !== queuedRunId);
      return json({ jsonrpc: "2.0", id: 2, result: { structuredContent: {} } });
    }
    // A tool this seam does not drive has no business here: fail loudly rather than answer {}.
    throw new Error(`unexpected tool ${name} at ${url}`);
  };
  return fetchImpl;
}

function fakeSeam(held: Record<string, T3QueuedMessage[]> = {}): FakeArchitect {
  const fake: FakeArchitect = {
    sends: [],
    held,
    cancelled: [],
    queueReads: [],
    settled: [],
    events: [],
    calls: [],
    failQueue: false,
    queueBounded: false,
    seam: {} as T3Seam,
  };
  // The queue half is the REAL client, over the fake MCP above: that is what makes a bad cursor argument a
  // failing test rather than a fake that would have accepted anything.
  const client = new T3Client({ baseUrl: FAKE_T3_BASE, credential: fakeCredential(), fetchImpl: fakeMcp(fake) });
  const unimplemented = (name: string) => async () => {
    throw new Error(`${name} is not used by the ready/close paths`);
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
      fake.sends.push(input);
      fake.events.push(`send:${input.threadId}`);
    },
    queue: (threadId) => client.queue(threadId),
    pin: async () => {},
    unpin: async () => {},
    disableAutoSettle: async () => {},
    queueCancel: async (threadId, queuedRunId) => {
      await client.queueCancel(threadId, queuedRunId);
    },
    wait: async () => ({ runId: null, status: "idle", timedOut: false }),
  };
  return fake;
}

/** A registry seam with the rows given, or none. */
// 1189 added `run` (T3's run state) to the row this seam returns; a stub written before it must carry
// the field or the type is a narrower shape than the registry it stands in for.
function registryWith(
  rows: Record<string, { session_id: string | null; launcher: string | null; status: string | null; run?: string | null }>,
): AgentRegistry {
  return {
    read: async (id) => {
      const row = rows[id];
      return row ? { run: null, ...row } : null;
    },
    register: async () => {},
    setRun: async () => true,
  };
}

/** A readying note for a ticket, as T3 would hold it. */
function heldNote(ticket: string, runId: string): T3QueuedMessage {
  return {
    queuedRunId: runId,
    text: readyingNote({
      ticket,
      branch: ticket,
      worktree: `/home/owner/dev/omnislash.${ticket}`,
      commitsAhead: 1,
      state: "State: ready — gate green",
      builderNote: "nx typecheck clean; skeptical-review: 0 cut, 0 open",
      rowId: 604,
      status: "ready-for-gate",
      composedAt: "2026-10-18T01:11:00.000Z",
    }),
    truncated: false,
  };
}

const REPO = "/r/omnislash";
/** OB-2255: the note went to the ticket's team's architect, so that is where a close withdraws it. */
const ARCHITECT = { kind: "team" as const, target: { agentId: "architect-omnislash", label: "omnislash architect", team: "omnislash" } };
const ARCHITECT_THREAD = "architect-thread-1";
const architectRow = { "architect-omnislash": { session_id: ARCHITECT_THREAD, launcher: "t3", status: "idle" } };

/** OB-2255: omnislash is a project in team omnislash, so a ticket of it routes to `architect-omnislash`. */
function omnislashTeam(db: ReturnType<typeof openDb>): void {
  db.query("INSERT INTO project_group (name, created_at) VALUES ('omnislash', '2026-11-17T00:00:00Z') ON CONFLICT DO NOTHING").run();
  db.query("INSERT INTO project (id, name, kind, created_at, group_name) VALUES ('omnislash', 'omnislash', 'side', '2026-11-17T00:00:00Z', 'omnislash') ON CONFLICT DO NOTHING").run();
}

// ---------------------------------------------------------------------------
// The matcher: a queued note is identified by the ticket its own first line names
// ---------------------------------------------------------------------------

describe("isReadyingNoteFor (1205)", () => {
  test("matches the note for its own ticket, and only that ticket", () => {
    const note = heldNote("1205", "run:1").text;
    expect(note.split("\n")[0]).toBe(readyNoteOpening("1205"));
    expect(isReadyingNoteFor(note, "1205")).toBe(true);
    expect(isReadyingNoteFor(note, "1210")).toBe(false);
  });

  test("not fooled by a ticket named in the body, and not by a different kind of message", () => {
    expect(isReadyingNoteFor("ready for the gate: 1210\n  ticket:    1210\n", "1205")).toBe(false);
    expect(isReadyingNoteFor(landedNote({ ticket: "1205", sha: "abc" }), "1205")).toBe(false);
    expect(isReadyingNoteFor("", "1205")).toBe(false);
  });
});

describe("noNoteOutcome (1205)", () => {
  test("is a NAMED skip that names the flag, and never a warning", () => {
    const rendered = renderReadyNoteOutcome(noNoteOutcome("1205"));
    expect(rendered.warning).toBe(false);
    expect(rendered.line).toContain("--no-note");
    expect(rendered.line).toContain("1205");
  });
});

// ---------------------------------------------------------------------------
// Withdrawing a held note at the land
// ---------------------------------------------------------------------------

describe("dropQueuedReadyNotes (1205)", () => {
  test("withdraws the landed ticket's held note and leaves another ticket's alone", async () => {
    const fake = fakeSeam({ [ARCHITECT_THREAD]: [heldNote("1205", "run:1205"), heldNote("1210", "run:1210")] });
    const out = await dropQueuedReadyNotes({
      rows: [{ ticket_ref: "1205", worktree: `/home/owner/dev/omnislash.1205`, repo: REPO, launcher: "t3" }],
      registry: registryWith(architectRow),
      targetFor: async () => ARCHITECT,
      seam: fake.seam,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.outcome).toBe("cancelled");
    expect(out[0]!.cancelled).toBe(1);
    expect(fake.cancelled).toEqual([{ threadId: ARCHITECT_THREAD, queuedRunId: "run:1205" }]);
    // The other ticket's note is a LIVE declaration: it is not this land's to withdraw.
    expect(fake.held[ARCHITECT_THREAD]!.map((m) => m.queuedRunId)).toEqual(["run:1210"]);
  });

  test("a queue holding several notes for the ticket withdraws them all", async () => {
    // Live shape: the pinned architect's queue carried a readying note for 1189 AND one for 1190.
    const fake = fakeSeam({ [ARCHITECT_THREAD]: [heldNote("1205", "run:a"), heldNote("1205", "run:b"), heldNote("1210", "run:c")] });
    const out = await dropQueuedReadyNotes({
      rows: [{ ticket_ref: "1205", worktree: "/wt/1205", repo: REPO, launcher: "t3" }],
      registry: registryWith(architectRow),
      targetFor: async () => ARCHITECT,
      seam: fake.seam,
    });
    expect(out[0]!.outcome).toBe("cancelled");
    expect(out[0]!.cancelled).toBe(2);
    expect(fake.cancelled.map((c) => c.queuedRunId)).toEqual(["run:a", "run:b"]);
    expect(renderStaleNoteOutcome(out[0]!)!.line).toContain("2 queued readying notes");
  });

  test("an empty queue is `none`, and says nothing at all", async () => {
    const fake = fakeSeam({});
    const out = await dropQueuedReadyNotes({
      rows: [{ ticket_ref: "1205", worktree: "/wt/1205", repo: REPO, launcher: "t3" }],
      registry: registryWith(architectRow),
      targetFor: async () => ARCHITECT,
      seam: fake.seam,
    });
    expect(out[0]!.outcome).toBe("none");
    expect(fake.cancelled).toHaveLength(0);
    // The ordinary land has an empty queue: a line for it would be noise on an output a human reads.
    expect(renderStaleNoteOutcome(out[0]!)).toBeNull();
  });

  test("an architect row with no thread is a named skip, and T3 is never asked", async () => {
    const fake = fakeSeam({ [ARCHITECT_THREAD]: [heldNote("1205", "run:1205")] });
    const out = await dropQueuedReadyNotes({
      rows: [{ ticket_ref: "1205", worktree: "/wt/1205", repo: REPO, launcher: "t3" }],
      registry: registryWith({ "architect-omnislash": { session_id: null, launcher: "t3", status: "idle" } }),
      targetFor: async () => ARCHITECT,
      seam: fake.seam,
    });
    expect(out[0]!.outcome).toBe("skipped");
    expect(out[0]!.reason).toContain("ob t3 architect omnislash");
    expect(fake.queueReads).toHaveLength(0);
    expect(renderStaleNoteOutcome(out[0]!)).toBeNull();
  });

  test("a refused queue read is a named warning, never a throw — and never silence", async () => {
    const fake = fakeSeam({ [ARCHITECT_THREAD]: [heldNote("1205", "run:1205")] });
    fake.failQueue = true;
    const out = await dropQueuedReadyNotes({
      rows: [{ ticket_ref: "1205", worktree: "/wt/1205", repo: REPO, launcher: "t3" }],
      registry: registryWith(architectRow),
      targetFor: async () => ARCHITECT,
      seam: fake.seam,
    });
    expect(out[0]!.outcome).toBe("failed");
    const rendered = renderStaleNoteOutcome(out[0]!)!;
    expect(rendered.warning).toBe(true);
    expect(rendered.line).toContain("not withdrawn");
    expect(rendered.line).toContain("is T3 running?");
  });

  test("a registry read that fails is reported, not swallowed", async () => {
    const fake = fakeSeam({});
    const out = await dropQueuedReadyNotes({
      rows: [{ ticket_ref: "1205", worktree: "/wt/1205", repo: REPO, launcher: "t3" }],
      registry: {
        read: async () => {
          throw new Error("store is gone");
        },
        register: async () => {},
        setRun: async () => true,
      },
      targetFor: async () => ARCHITECT,
      seam: fake.seam,
    });
    expect(out[0]!.outcome).toBe("failed");
    expect(out[0]!.reason).toContain("store is gone");
  });

  test("no rows asks nothing at all — not even the registry", async () => {
    const out = await dropQueuedReadyNotes({
      rows: [],
      registry: {
        read: async () => {
          throw new Error("the registry must not be read when no row served the item");
        },
        register: async () => {},
        setRun: async () => true,
      },
      targetFor: async () => {
        throw new Error("no repo to resolve");
      },
    });
    expect(out).toEqual([]);
  });

  test("a read that ran out of pages is `partial` and WARNS — never `none`, which would read as proof", async () => {
    // A bounded scan is not evidence of absence: with a cursor still remaining, "no note in what I read"
    // must not become "nothing is held". The caller says the queue could not be enumerated.
    const fake = fakeSeam({ [ARCHITECT_THREAD]: [heldNote("1210", "run:other")] });
    fake.queueBounded = true;
    const out = await dropQueuedReadyNotes({
      rows: [{ ticket_ref: "1205", worktree: "/wt/1205", repo: REPO, launcher: "t3" }],
      registry: registryWith(architectRow),
      targetFor: async () => ARCHITECT,
      seam: fake.seam,
    });
    expect(out[0]!.outcome).toBe("partial");
    const rendered = renderStaleNoteOutcome(out[0]!)!;
    expect(rendered.warning).toBe(true);
    expect(rendered.line).toContain("may still arrive");
  });

  test("what it DID see is still withdrawn, and a bounded read still WARNS", async () => {
    // A cancellation from the pages that were read does not make the scan complete: the unseen pages may
    // hold another note, so the warning stands beside the withdrawal.
    const fake = fakeSeam({ [ARCHITECT_THREAD]: [heldNote("1205", "run:mine")] });
    fake.queueBounded = true;
    const out = await dropQueuedReadyNotes({
      rows: [{ ticket_ref: "1205", worktree: "/wt/1205", repo: REPO, launcher: "t3" }],
      registry: registryWith(architectRow),
      targetFor: async () => ARCHITECT,
      seam: fake.seam,
    });
    expect(out[0]!.outcome).toBe("partial");
    expect(out[0]!.cancelled).toBe(1);
    expect(fake.cancelled.map((c) => c.queuedRunId)).toEqual(["run:mine"]);
    const rendered = renderStaleNoteOutcome(out[0]!)!;
    expect(rendered.warning).toBe(true);
    expect(rendered.line).toContain("withdrew a queued readying note for 1205");
    expect(rendered.line).toContain("may still arrive");
  });

  test("a headless-only ticket asks NOTHING — it never announced, so no note can be held", async () => {
    const out = await dropQueuedReadyNotes({
      rows: [{ ticket_ref: "1205", worktree: "/wt/1205", repo: REPO, launcher: "headless" }],
      registry: {
        read: async () => {
          throw new Error("a headless row must not cost a registry read");
        },
        register: async () => {},
        setRun: async () => true,
      },
      targetFor: async () => {
        throw new Error("a headless row must not cost an architect resolution");
      },
    });
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The command path: `ob spinoff ready --no-note`
// ---------------------------------------------------------------------------

const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "1205",
  repo: REPO,
  branch: "1205",
  mode: "interactive",
  brief: "the architect's own ready stamp",
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

async function seedReadyable(db: ReturnType<typeof openDb>, ticketRef = "1205"): Promise<string> {
  const wt = mkdtempSync(join(tmpdir(), "ob-wt-1205-"));
  restores.push(() => rmSync(wt, { recursive: true, force: true }));
  const { row } = await enqueueSpinoff(db, input({ ticketRef, worktree: wt }));
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, worktree = ?, launcher = 't3', base_sha = ? WHERE id = ?").run(
    ticketRef,
    wt,
    "base123",
    row.id,
  );
  omnislashTeam(db);
  if (ticketRef === "1205") {
    const itemId = await createItem(db, { type: "task", title: "the architect's own ready stamp", projectId: "omnislash" });
    db.query("UPDATE spinoff SET item_id = ? WHERE id = ?").run(itemId, row.id);
  } else {
    db.query("UPDATE item SET project_id = 'omnislash' WHERE id = ?").run(ticketRef);
  }
  await registerAgent(db, {
    id: ticketRef,
    ticket: ticketRef,
    branch: ticketRef,
    worktree: wt,
    status: "readying",
    note: "nx typecheck clean; skeptical-review: 0 cut, 0 open",
    ttlS: 900,
  });
  return wt;
}

describe("ob spinoff ready --no-note (1205)", () => {
  test("the architect's own stamp produces the STAMP and no note", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    await seedReadyable(db);
    await registerAgent(db, { id: "architect-omnislash", worktree: REPO, status: "planning", launcher: "t3", sessionId: ARCHITECT_THREAD, ttlS: 900 });
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1205", "--no-note"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("1205 handed off");
    expect(res.out).toContain("--no-note: stamped only, nothing announced");
    expect(fake.sends).toHaveLength(0);
    // The stamp itself is unchanged: the same row state a note-carrying stamp writes.
    expect(db.query("SELECT status FROM spinoff WHERE ticket_ref = '1205'").get()).toMatchObject({ status: "ready-for-gate" });
  });

  test("--json carries the skip, so a caller never has to read the prose", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    await seedReadyable(db);
    await registerAgent(db, { id: "architect-omnislash", worktree: REPO, status: "planning", launcher: "t3", sessionId: ARCHITECT_THREAD, ttlS: 900 });
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1205", "--no-note", "--json"]);
    const body = JSON.parse(res.out) as { status: string; architect_note: { outcome: string; reason: string } };
    expect(body.status).toBe("handed-off");
    expect(body.architect_note.outcome).toBe("skipped");
    expect(body.architect_note.reason).toContain("--no-note");
    expect(fake.sends).toHaveLength(0);
  });

  test("a BUILDER's stamp still sends exactly one note (the flag is opt-in)", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    await seedReadyable(db);
    await registerAgent(db, { id: "architect-omnislash", worktree: REPO, status: "planning", launcher: "t3", sessionId: ARCHITECT_THREAD, ttlS: 900 });
    await openRunsOnSeats(db);
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "ready", "1205"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`note:      omnislash architect: 1 message queued into run 1, thread ${ARCHITECT_THREAD}`);
    expect(fake.sends).toHaveLength(1);
    expect(fake.sends[0]!.message).toContain(readyNoteOpening("1205"));
    // A repeat is STILL one note (OS-56: it stores no new handoff, so nothing new is delivered): the flag changes nothing about that.
    expect((await runCli(dbPath, ["spinoff", "ready", "1205"])).code).toBe(0);
    expect(fake.sends).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The close path: the note never arrives as a gate request after the land
// ---------------------------------------------------------------------------

async function seedLanded(db: ReturnType<typeof openDb>): Promise<string> {
  const itemId = await createItem(db, { type: "task", title: "The architect's own ready stamp" });
  const wt = await seedReadyable(db, itemId);
  const { row } = await enqueueSpinoff(db, input({ ticketRef: itemId, worktree: wt }));
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, worktree = ?, launcher = 't3', t3_thread_id = ?, repo = ?, base_sha = ? WHERE id = ?").run(
    itemId,
    wt,
    "builder-thread-1",
    REPO,
    "base123",
    row.id,
  );
  return itemId;
}

describe("ob close withdraws a readying note queued before the land (1205)", () => {
  test("the held note for the landed ticket is withdrawn, and the close is unchanged", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    const itemId = await seedLanded(db);
    await registerAgent(db, { id: "architect-omnislash", worktree: REPO, status: "planning", launcher: "t3", sessionId: ARCHITECT_THREAD, ttlS: 900 });
    const fake = fakeSeam({ [ARCHITECT_THREAD]: [heldNote("OB-1", "run:stale")] });
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["close", itemId]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(`withdrew a queued readying note for OB-1`);
    expect(fake.cancelled).toEqual([{ threadId: ARCHITECT_THREAD, queuedRunId: "run:stale" }]);
    expect(fake.held[ARCHITECT_THREAD]).toEqual([]);
    // THE WIRE SHAPE, at the close (1264): the first `t3_queue` page carries NO `cursor` KEY at all.
    // T3's schema is `cursor?: number`, so `cursor: null` is an invalid argument and the read is refused
    // before a page is read — which left the held note in the queue and the withdrawal a warning.
    expect(fake.calls[0]!.name).toBe("t3_queue");
    expect(fake.calls[0]!.args.action).toBe("list");
    expect("cursor" in fake.calls[0]!.args).toBe(false);
    // The land's own handoff is untouched: the builder is still told, and its thread is still settled. The
    // withdrawal goes FIRST: the land reply's own bounded wait (up to 30s) is a window the architect can end
    // its turn inside, so the note this close is withdrawing must not sit behind it.
    expect(fake.events).toEqual([`cancel:run:stale`, `send:builder-thread-1`, `settle:builder-thread-1`]);
    expect(fake.sends.map((s) => s.threadId)).toEqual(["builder-thread-1"]);
  });

  test("another ticket's held note survives the close", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    const itemId = await seedLanded(db);
    await registerAgent(db, { id: "architect-omnislash", worktree: REPO, status: "planning", launcher: "t3", sessionId: ARCHITECT_THREAD, ttlS: 900 });
    const fake = fakeSeam({ [ARCHITECT_THREAD]: [heldNote("OB-1", "run:mine"), heldNote("1210", "run:theirs")] });
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["close", itemId]);
    expect(res.code).toBe(0);
    expect(fake.cancelled.map((c) => c.queuedRunId)).toEqual(["run:mine"]);
    expect(fake.held[ARCHITECT_THREAD]!.map((m) => m.queuedRunId)).toEqual(["run:theirs"]);
  });

  test("a refused withdrawal is a warning on stderr, and the close still stands", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    const itemId = await seedLanded(db);
    await registerAgent(db, { id: "architect-omnislash", worktree: REPO, status: "planning", launcher: "t3", sessionId: ARCHITECT_THREAD, ttlS: 900 });
    const fake = fakeSeam({ [ARCHITECT_THREAD]: [heldNote("OB-1", "run:stale")] });
    fake.failQueue = true;
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["close", itemId]);
    // Exit 0: `ob close`'s exit 1 means the GitHub mirror drifted, and hygiene on another system is not
    // the close. The warning is the report.
    expect(res.code).toBe(0);
    expect(res.err).toContain("not withdrawn");
    expect(fake.settled).toEqual(["builder-thread-1"]);
  });
});

describe("the local close joins rows by IDENTITY, so the sweep sees every row the land is about (1163/1205)", () => {
  test("a hand-charted row (dispatch ref ≠ item id) has its held note withdrawn too", async () => {
    // The 1163 shape: row 591 was dispatched as "1124" while its ob mirror is item 1134, and the note the
    // builder queued names the DISPATCH ref. Matching `ticket_ref` to the closed item id alone — which is
    // what the local close used to do — would join nothing, so the sweep would leave the stale note in the
    // architect's queue. Both consumers read the same identity-joined set now.
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    fakeGit();
    omnislashTeam(db);
    const itemId = await createItem(db, {
      type: "task",
      projectId: "omnislash",
      title: "T3 integration P1",
      body: "wayfinder/tickets/1124-t3-read-surface.md — the read half",
    });
    const wt = mkdtempSync(join(tmpdir(), "ob-wt-1124-"));
    restores.push(() => rmSync(wt, { recursive: true, force: true }));
    const { row } = await enqueueSpinoff(db, input({ ticketRef: "1124", worktree: wt }));
    // item_id NULL: the row was queued before 0032 recorded it, so only the item's own record links them.
    // ticket_ref '1124': the row predates 1949, which would now queue it under the mirror's own ref.
    db.query("UPDATE spinoff SET status = 'launched', ticket_ref = '1124', agent_id = ?, worktree = ?, launcher = 't3', t3_thread_id = ?, repo = ?, base_sha = ?, item_id = NULL WHERE id = ?").run(
      "1124",
      wt,
      "builder-thread-1",
      REPO,
      "base123",
      row.id,
    );
    await registerAgent(db, { id: "architect-omnislash", worktree: REPO, status: "planning", launcher: "t3", sessionId: ARCHITECT_THREAD, ttlS: 900 });
    const fake = fakeSeam({ [ARCHITECT_THREAD]: [heldNote("1124", "run:hand")] });
    restores.push(__setT3Seam(fake.seam));
    // The sha is looked up for the row's DISPATCH ref: the squash subject names 1124, never the mirror's
    // item id. This fake git answers only that ref, so a lookup with the item id reads as unreported.
    restores.push(
      __setSh((cmd) => {
        const line = cmd.join(" ");
        if (line.includes("--fixed-strings")) {
          return { ok: true, err: "", out: line.includes("(ob 1124)") ? "1124bad\n" : "" };
        }
        if (line.includes("status --porcelain")) return { ok: true, err: "", out: "" };
        return { ok: true, err: "", out: "" };
      }),
    );

    const res = await runCli(dbPath, ["close", itemId]);
    expect(res.code).toBe(0);
    expect(fake.cancelled).toEqual([{ threadId: ARCHITECT_THREAD, queuedRunId: "run:hand" }]);
    expect(res.out).toContain(`withdrew a queued readying note for 1124`);
    // The land reply reads the same set, which is 1163's intent: the mismatched number is told it landed.
    expect(fake.sends.map((s) => s.threadId)).toEqual(["builder-thread-1"]);
    expect(fake.sends[0]!.message).toContain("squash 1124bad");
    expect(fake.settled).toEqual(["builder-thread-1"]);
  });
});

// ---------------------------------------------------------------------------
// The registry seam the close path uses on this machine
// ---------------------------------------------------------------------------
describe("the store-backed registry (1205)", () => {
  test("reads the architect row's thread id out of the real store", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    await registerAgent(db, { id: "architect-omnislash", worktree: REPO, status: "planning", launcher: "t3", sessionId: ARCHITECT_THREAD, ttlS: 900 });
    const registry = storeAgentRegistry(db);
    expect(await registry.read("architect-omnislash")).toMatchObject({ session_id: ARCHITECT_THREAD, launcher: "t3" });
  });
});

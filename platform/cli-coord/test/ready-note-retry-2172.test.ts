// OB-2172: a readying note that T3 refuses is retried once with the same request id, and a note that still
// fails is kept on the row (`spinoff.note_error`) where `ob spinoff gateable` and `ob spinoff show` print it.
// A later note that is sent clears it. A fake seam stands in for T3, which cannot be made slow here.
import { liveRead, openRunsOnSeats } from "../../../apps/cli/test/role-run-fixture.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { T3Error, type T3SendInput } from "../../../apps/cli/src/t3/client.ts";
import {
  __setReadyNoteRetryMs,
  __setT3Seam,
  announceReadyNote,
  READY_NOTE_RETRY_MS,
  readyNoteRequestId,
  renderReadyNoteOutcome,
  type AgentRegistry,
  type T3Seam,
} from "../../../apps/cli/src/t3/dispatch.ts";
import { registerAgent } from "../src/agent.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { enqueueSpinoff } from "../src/commands/spinoff.ts";
import { reportGateable } from "../src/spinoff-gateable.ts";
import { __setSh } from "./sh-no-pr.ts";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});
let restoreRetry: () => void = () => {};
beforeAll(() => {
  restoreRetry = __setReadyNoteRetryMs(0);
});
afterAll(() => restoreRetry());

const REFUSAL = "T3 server not reachable at http://127.0.0.1:3773: The operation was aborted.";

/** A seam whose `send` throws the next `failures` times, then takes the note. Every attempt is recorded. */
function flakySeam(failures: number, error: Error = new T3Error("unreachable", REFUSAL)): { seam: T3Seam; attempts: T3SendInput[] } {
  let left = failures;
  const attempts: T3SendInput[] = [];
  const unused = (name: string) => async () => {
    throw new Error(`${name} is not used by the note path`);
  };
  const seam = {
    interrupt: async () => {},
    projects: unused("projects"),
    capabilities: unused("capabilities"),
    list: unused("list"),
    read: liveRead,
    launch: unused("launch"),
    rename: unused("rename"),
    settle: async () => {},
    send: async (input: T3SendInput) => {
      attempts.push(input);
      if (left > 0) {
        left--;
        throw error;
      }
    },
    wait: async () => ({ runId: null, status: "idle", timedOut: false }),
    queue: async () => ({ items: [], complete: true }),
    pin: async () => {},
    unpin: async () => {},
    disableAutoSettle: async () => {},
    queueCancel: async () => {},
  } as unknown as T3Seam;
  return { seam, attempts };
}

const registry: AgentRegistry = {
  read: async () => ({ session_id: "architect-thread-1", launcher: "t3", status: "planning", run: null }),
  register: async () => {},
  setRun: async () => true,
};

const baseInput = {
  row: { id: 7, ticket_ref: "OB-2172", branch: "ob-2172", worktree: "/w/ob-2172", status: "ready-for-gate" },
  route: { kind: "team" as const, target: { agentId: "architect-omnislash", label: "omnislash architect", team: "omnislash" } },
  launcher: "t3",
  state: "State: landable",
  builderNote: null,
  commitsAhead: 1,
  headSha: "abc1234def",
};

describe("announceReadyNote retries once (OB-2172)", () => {
  test("a send that throws once and then succeeds is sent twice with the same request id, and reports sent", async () => {
    const fake = flakySeam(1);
    const waits: number[] = [];
    // The real wait, not the suite's zero: this is the one test that checks it.
    const restore = __setReadyNoteRetryMs(READY_NOTE_RETRY_MS);
    let out;
    try {
      out = await announceReadyNote(registry, { ...baseInput, seam: fake.seam, sleep: async (ms) => void waits.push(ms) });
    } finally {
      restore();
    }
    expect(out.outcome).toBe("sent");
    expect(fake.attempts).toHaveLength(2);
    expect(fake.attempts[0]!.clientRequestId).toBe(readyNoteRequestId(7, "abc1234def"));
    expect(fake.attempts[1]!.clientRequestId).toBe(fake.attempts[0]!.clientRequestId);
    expect(waits).toEqual([5000]);
  });

  test("a first send that works does not wait or retry", async () => {
    const fake = flakySeam(0);
    const waits: number[] = [];
    const out = await announceReadyNote(registry, { ...baseInput, seam: fake.seam, sleep: async (ms) => void waits.push(ms) });
    expect(out.outcome).toBe("sent");
    expect(fake.attempts).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test("a credential T3 rejects is not retried: no wait could fix it", async () => {
    for (const kind of ["credential_rejected", "credential_expired", "credential_missing"] as const) {
      const fake = flakySeam(1, new T3Error(kind, "the T3 credential was rejected"));
      const waits: number[] = [];
      const out = await announceReadyNote(registry, { ...baseInput, seam: fake.seam, sleep: async (ms) => void waits.push(ms) });
      expect(out.outcome).toBe("failed");
      expect(fake.attempts).toHaveLength(1);
      expect(waits).toEqual([]);
    }
  });

  test("a record that could not be written is its own warning", () => {
    const failed = renderReadyNoteOutcome({ ticket: "OB-2172", threadId: "t", outcome: "failed", reason: "x", recordError: "disk full" });
    expect(failed.warning).toBe(true);
    expect(failed.line).toContain("could not record the failure on the row (note_error): disk full");
    // A delivered note whose old record could not be cleared is named, not a warning: the architect was told.
    const sent = renderReadyNoteOutcome({ ticket: "OB-2172", threadId: "t", outcome: "sent", reason: null, recordError: "disk full" });
    expect(sent.warning).toBe(false);
    expect(sent.line).toContain("could not clear the row's earlier note failure (note_error): disk full");
  });

  test("a trial pair's leg prints its own architect note line on gateable", () => {
    const out = reportGateable(
      [
        { id: 1, ticket_ref: "OB-9", branch: "ob-9", worktree: "/w/a", repo: "/r/omnislash", note_error: "2026-11-15T10:38:34.000Z T3 refused it" },
        { id: 2, ticket_ref: "OB-9", branch: "ob-9-b", worktree: "/w/b", repo: "/r/omnislash" },
      ],
      () => ({ missing: false, state: "State: landable", paths: [] }),
      "human" as never,
      [{ id: 3, row_a: 1, row_b: 2, label_a: "X" }],
    );
    expect(out).toContain("    readying note: NOT delivered at 2026-11-15T10:38:34.000Z: T3 refused it");
    expect(out.match(/NOT delivered/g)).toHaveLength(1);
  });
});

/** The git facts the handoff reads: a clean worktree, a State: line, one commit past the base. */
function fakeGit(): void {
  restores.push(
    __setSh((cmd) => {
      const line = cmd.join(" ");
      if (line.includes("status --porcelain")) return { ok: true, err: "", out: "" };
      if (line.includes("rev-list --count")) return { ok: true, err: "", out: "1\n" };
      if (line.includes("log --format=%B")) return { ok: true, err: "", out: "fix(OB-2172): y\n\nState: landable\n" };
      if (line.includes("rev-parse")) return { ok: true, err: "", out: "abc1234def\n" };
      return { ok: true, err: "", out: "" };
    }),
  );
}

async function seed(dbPath: string): Promise<ReturnType<typeof openDb>> {
  const db = openDb(dbPath, { create: true });
  const wt = mkdtempSync(join(tmpdir(), "ob-wt-2172-"));
  restores.push(() => rmSync(wt, { recursive: true, force: true }));
  const { row } = await enqueueSpinoff(db, { ticketRef: "2172", repo: "/r/omnislash", branch: "ob-2172", mode: "interactive", brief: "retry the note", worktree: wt });
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, launcher = 't3', t3_thread_id = 'builder-thread', base_sha = 'base123' WHERE id = ?").run("ob-2172", row.id);
  await registerAgent(db, { id: "ob-2172", ticket: "2172", branch: "ob-2172", worktree: wt, status: "readying", note: "gate green", ttlS: 900 });
  // OB-2255: the note goes to the ticket's team, so the row serves an omnislash item and omnislash is a team.
  db.query("INSERT INTO project_group (name, created_at) VALUES ('omnislash', '2026-11-17T00:00:00Z')").run();
  db.query("INSERT INTO project (id, name, kind, created_at, group_name) VALUES ('omnislash', 'omnislash', 'side', '2026-11-17T00:00:00Z', 'omnislash')").run();
  const itemId = await createItem(db, { type: "task", title: "retry the note", projectId: "omnislash" });
  db.query("UPDATE spinoff SET item_id = ? WHERE id = ?").run(itemId, row.id);
  await registerAgent(db, { id: "architect-omnislash", worktree: "/r/omnislash", status: "planning", launcher: "t3", sessionId: "architect-thread-1", ttlS: 900 });
  await openRunsOnSeats(db);
  return db;
}

const noteErrorOf = (db: ReturnType<typeof openDb>) =>
  (db.query("SELECT note_error FROM spinoff WHERE ticket_ref = '2172'").get() as { note_error: string | null }).note_error;

describe("ob spinoff handoff keeps a failed note on the row (OB-2172)", () => {
  test("throws once then succeeds: sent, and note_error stays null", async () => {
    const dbPath = freshDbPath();
    const db = await seed(dbPath);
    fakeGit();
    const fake = flakySeam(1);
    restores.push(__setT3Seam(fake.seam));
    const res = await runCli(dbPath, ["spinoff", "handoff", "2172", "--ci-unchecked", "test"]);
    expect(res.code).toBe(0);
    expect(res.out).toContain("note:      omnislash architect: 1 message queued into run 1, thread architect-thread-1");
    expect(fake.attempts).toHaveLength(2);
    expect(noteErrorOf(db)).toBeNull();
  });

  test("throws twice: recorded on the row, shown by gateable and show, and cleared by the next sent note", async () => {
    const dbPath = freshDbPath();
    const db = await seed(dbPath);
    fakeGit();
    const fake = flakySeam(2);
    restores.push(__setT3Seam(fake.seam));

    const res = await runCli(dbPath, ["spinoff", "handoff", "2172", "--ci-unchecked", "test"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("recorded on row");
    const recorded = noteErrorOf(db);
    expect(recorded).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z /);
    expect(recorded).toContain("The operation was aborted");

    const gateable = await runCli(dbPath, ["spinoff", "gateable"]);
    expect(gateable.out).toContain("readying note: NOT delivered at ");
    expect(gateable.out).toContain("The operation was aborted");
    const show = await runCli(dbPath, ["spinoff", "show", "2172"]);
    expect(show.out).toContain("readying note: NOT delivered at ");
    expect(show.out).toContain("The operation was aborted");

    // The next handoff whose note is sent clears it, and the line goes.
    const again = await runCli(dbPath, ["spinoff", "handoff", "2172", "--ci-unchecked", "test"]);
    expect(again.code).toBe(0);
    expect(noteErrorOf(db)).toBeNull();
    expect((await runCli(dbPath, ["spinoff", "gateable"])).out).not.toContain("readying note: NOT delivered");
    expect((await runCli(dbPath, ["spinoff", "show", "2172"])).out).not.toContain("readying note: NOT delivered");
  });
  test("a failed note delivered later by an ob send is cleared by the next handoff of the same commit (OS-56)", async () => {
    const dbPath = freshDbPath();
    const db = await seed(dbPath);
    fakeGit();
    const fake = flakySeam(2);
    restores.push(__setT3Seam(fake.seam));
    expect((await runCli(dbPath, ["spinoff", "handoff", "2172", "--ci-unchecked", "test"])).code).toBe(1);
    expect(noteErrorOf(db)).not.toBeNull();
    // The send delivers the stored handoff too, so the repeat handoff finds nothing unread: that is a delivered note.
    const sent = await runCli(dbPath, ["send", "omnislash", "architect", "x"]);
    expect(sent.code).toBe(0);
    expect(sent.out).toContain("2 messages queued into run 1");
    const again = await runCli(dbPath, ["spinoff", "handoff", "2172", "--ci-unchecked", "test"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("nothing unread to deliver; this handoff was already given to its run");
    expect(noteErrorOf(db)).toBeNull();
  });
});

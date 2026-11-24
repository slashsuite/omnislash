// A builder's handoff stores its readying note in the target role's inbox (kind `handoff`), then delivers it into
// that role's run, starting one when none is open (OS-56). An inbox that cannot be written (an older server answering
// 404) never stops the note: it goes to the seat thread as it did before.
//
// The same fakes the team-handoff tests use: a fake T3 seam that records every send, a git stub, and a throwaway
// SQLite store. Over the API, the CLI's requests go through `createObApi` on that same store, in process.
import { liveRead, openRunsOnSeats } from "../../../apps/cli/test/role-run-fixture.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import type { T3SendInput } from "../../../apps/cli/src/t3/client.ts";
import { __setReadyNoteRetryMs, __setT3Seam, isReadyingNoteFor, worktreeRepoOf, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { checkoutOf } from "../../../apps/cli/src/commands/t3-team.ts";
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { sqliteStoreFor } from "../../../apps/cli/src/db/store.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";
import type { RoleMessage } from "../../../apps/cli/src/inbox.ts";
import { registerAgent } from "../src/agent.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { enqueueSpinoff, getSpinoffRow } from "../src/commands/spinoff.ts";
import { __setSh } from "./sh-no-pr.ts";

const restores: Array<() => void> = [];
let restoreRetry: () => void = () => {};
beforeAll(() => {
  restoreRetry = __setReadyNoteRetryMs(0);
});
afterAll(() => restoreRetry());
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

function fakeSeam(): { seam: T3Seam; sends: T3SendInput[] } {
  const sends: T3SendInput[] = [];
  const seam = {
    send: async (input: T3SendInput) => {
      sends.push(input);
    },
    read: liveRead,
    queue: async () => ({ items: [], complete: true }),
    settle: async () => {},
    wait: async () => ({ runId: null, status: "idle", timedOut: false }),
  } as unknown as T3Seam;
  return { seam, sends };
}

const HEAD = "abc1234def";

function fakeGit(): void {
  restores.push(
    __setSh((cmd) => {
      const line = cmd.join(" ");
      if (line.includes("status --porcelain")) return { ok: true, err: "", out: "" };
      if (line.includes("rev-list --count")) return { ok: true, err: "", out: "2\n" };
      if (line.includes("log --format=%B")) return { ok: true, err: "", out: "feat(x): y\n\nState: landable\n" };
      if (line.includes("rev-parse")) return { ok: true, err: "", out: `${HEAD}\n` };
      return { ok: true, err: "", out: "" };
    }),
  );
}

const REPO = "/r/omnislash";
/** The checkout a started run opens in: the cwd's repo, as `ob role start` resolves it. */
const CWD_REPO = worktreeRepoOf(checkoutOf(process.cwd())) ?? checkoutOf(process.cwd());

/** Project `pixelslash` in team `slash` (sentinel thread bound), one item in it, and a launched t3 row for it. */
async function seed(opts: { run?: boolean } = {}): Promise<{ dbPath: string; ref: string; rowId: number; db: ReturnType<typeof openDb> }> {
  const dbPath = freshDbPath();
  const db = openDb(dbPath, { create: true });
  expect((await runCli(dbPath, ["project", "add", "pixelslash", "--kind", "side"])).code).toBe(0);
  expect((await runCli(dbPath, ["t3", "team", "add", "slash", "--projects", "pixelslash"])).code).toBe(0);
  const itemId = await createItem(db, { type: "task", title: "a team ticket", projectId: "pixelslash" });
  const ref = (await getItem(db, itemId))!.ref ?? itemId;
  const wt = mkdtempSync(join(tmpdir(), "ob-wt-inbox-"));
  restores.push(() => rmSync(wt, { recursive: true, force: true }));
  const { row } = await enqueueSpinoff(db, { ticketRef: ref, repo: REPO, branch: "b", mode: "interactive", brief: "inbox", worktree: wt });
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, worktree = ?, launcher = 't3', t3_thread_id = ?, base_sha = ? WHERE id = ?").run(
    ref,
    wt,
    "builder-thread-1",
    "base123",
    row.id,
  );
  await registerAgent(db, { id: ref, ticket: ref, branch: "b", worktree: wt, status: "readying", note: "gate green", ttlS: 900 });
  await registerAgent(db, { id: "sentinel-slash", worktree: REPO, status: "planning", launcher: "t3", sessionId: "slash-sentinel-thread", ttlS: 900 });
  if (opts.run !== false) await openRunsOnSeats(db);
  return { dbPath, ref, rowId: row.id, db };
}

function messages(db: ReturnType<typeof openDb>): RoleMessage[] {
  return db.query("SELECT * FROM role_message ORDER BY id").all() as RoleMessage[];
}

describe("ob spinoff handoff stores its note in the role's inbox and delivers it", () => {
  test("a handoff run twice on one commit writes one handoff row and queues it into the open run once", async () => {
    fakeGit();
    const { dbPath, ref, db } = await seed();
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));
    const first = await runCli(dbPath, ["spinoff", "handoff", ref, "--ci-unchecked", "test"]);
    expect(first.code).toBe(0);
    const second = await runCli(dbPath, ["spinoff", "handoff", ref, "--ci-unchecked", "test"]);
    expect(second.code).toBe(0);
    expect(second.err).not.toContain("inbox:");
    expect(second.out).toContain("nothing unread to deliver; this handoff was already given to its run");
    expect(fake.sends.map((s) => [s.threadId, s.mode, s.clientRequestId])).toEqual([["slash-sentinel-thread", "queue", "ob-role-msg-1"]]);
    const rows = messages(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ team: "slash", role: "sentinel", kind: "handoff", ref, from_actor: ref, read_by: "role-run-1" });
    expect(rows[0]!.client_key).toStartWith("ob-ready-");
    expect(fake.sends[0]!.message).toContain(rows[0]!.body);
    // The note's own first line leads, so `ob close` still finds and withdraws it once the ticket lands (1205).
    expect(isReadyingNoteFor(fake.sends[0]!.message, ref)).toBe(true);
  });

  test("with no open run, a handoff starts the sentinel's run whose brief lists it; a second handoff sends nothing new", async () => {
    fakeGit();
    const { dbPath, ref, db } = await seed({ run: false });
    const t3 = installFakeT3([CWD_REPO]);
    restores.push(t3.restore);
    const first = await runCli(dbPath, ["spinoff", "handoff", ref, "--ci-unchecked", "test"]);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(first.out).toContain("slash sentinel: run 1 opened, thread t3-1, with 1 message in its start brief, marked read by role-run-1");
    expect(t3.launches).toHaveLength(1);
    expect(t3.launches[0]!.title).toContain("sentinel");
    expect(t3.launches[0]!.message!.split("\n")[0]).toBe("/ob-sentinel");
    expect(t3.launches[0]!.message).toContain(`#1 from ${ref} (handoff)`);
    expect(messages(db)[0]).toMatchObject({ role: "sentinel", read_by: "role-run-1" });
    const second = await runCli(dbPath, ["spinoff", "handoff", ref, "--ci-unchecked", "test"]);
    expect(second.code).toBe(0);
    expect(t3.launches).toHaveLength(1);
    expect(t3.sends).toHaveLength(0);
    expect(messages(db)).toHaveLength(1);
  });
});

describe("ob spinoff handoff over the API", () => {
  const BASE = "https://ob.example.test";
  const TOKEN = "test-token-do-not-log";

  /** The CLI's requests through the real server on the seeded store; `inbox404` answers 404 on the inbox route. */
  function api(db: ReturnType<typeof openDb>, inbox404: boolean) {
    const obApi = createObApi({
      store: async () => sqliteStoreFor(db),
      token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
    });
    const transport: ApiTransport = async (req) => {
      if (inbox404 && /\/teams\/[^/]+\/inbox/.test(req.url)) {
        return { status: 404, body: JSON.stringify({ error: { code: "not_found", message: "no such route" } }) };
      }
      const res = await obApi(
        new Request(req.url.replace(BASE, "http://api-host.local"), {
          method: req.method,
          headers: req.headers,
          ...(req.body === undefined ? {} : { body: req.body }),
        }),
      );
      return { status: res.status, body: await res.text() };
    };
    return { api: { base: BASE, token: TOKEN, transport } };
  }

  test("a server with the inbox route stores one handoff row and queues it into the open run", async () => {
    fakeGit();
    const { ref, db } = await seed();
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));
    const res = await runCli(freshDbPath(), ["spinoff", "handoff", ref, "--ci-unchecked", "test"], api(db, false));
    expect(res.err).not.toContain("inbox:");
    expect(res.code).toBe(0);
    expect(fake.sends.map((s) => [s.threadId, s.clientRequestId])).toEqual([["slash-sentinel-thread", "ob-role-msg-1"]]);
    expect(messages(db).map((m) => [m.kind, m.role, m.ref, m.read_by])).toEqual([["handoff", "sentinel", ref, "role-run-1"]]);
  });

  test("with no open run, a handoff over the API starts the sentinel's run; a second sends nothing new", async () => {
    fakeGit();
    const { ref, db } = await seed({ run: false });
    const t3 = installFakeT3([CWD_REPO]);
    restores.push(t3.restore);
    const deps = api(db, false);
    const first = await runCli(freshDbPath(), ["spinoff", "handoff", ref, "--ci-unchecked", "test"], deps);
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    expect(t3.launches).toHaveLength(1);
    expect(messages(db)[0]).toMatchObject({ read_by: "role-run-1" });
    expect((await runCli(freshDbPath(), ["spinoff", "handoff", ref, "--ci-unchecked", "test"], deps)).code).toBe(0);
    expect(t3.launches).toHaveLength(1);
    expect(t3.sends).toHaveLength(0);
  });

  test("a server that answers 404 on the inbox route still sends the T3 note to the seat thread and stamps the row", async () => {
    fakeGit();
    // No open run: the seat send needs none, and a delivery would have launched one.
    const { ref, rowId, db } = await seed({ run: false });
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));
    const res = await runCli(freshDbPath(), ["spinoff", "handoff", ref, "--ci-unchecked", "test"], api(db, true));
    expect(res.code).toBe(0);
    expect(res.err).toContain("inbox: handoff not stored (");
    expect(fake.sends.map((s) => s.threadId)).toEqual(["slash-sentinel-thread"]);
    expect(fake.sends[0]!.clientRequestId).toStartWith("ob-ready-");
    expect((await getSpinoffRow(db, rowId))!.status).toBe("ready-for-gate");
    expect(messages(db)).toHaveLength(0);
  });
});

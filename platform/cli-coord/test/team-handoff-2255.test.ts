// OB-2255, OS-181: a handoff goes to the ticket's team's sentinel, started when the team has none, and never to its
// architect; a start that fails holds the note. A project in no team sends no note and prints one line. `ob close` withdraws a held note from the same thread, and
// `spinoff list|gateable --team` keep only the team's rows.
//
// The same fakes the readying-note tests use (1133, 1205): a fake T3 seam that records every send and holds a
// queue, a git stub, and a throwaway SQLite store. Nothing reaches a live T3 or a live database.
import { installFakeT3 } from "../../../apps/cli/test/fake-t3.ts";
import { checkoutOf } from "../../../apps/cli/src/commands/t3-team.ts";
import { worktreeRepoOf } from "../../../apps/cli/src/t3/dispatch.ts";
import { liveRead, openRunsOnSeats } from "../../../apps/cli/test/role-run-fixture.ts";
import { markRoleRun } from "../../../apps/cli/src/role-run.ts";
import { t3BaseUrl } from "../../../apps/cli/src/t3/client.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import type { T3QueuedMessage, T3SendInput } from "../../../apps/cli/src/t3/client.ts";
import { __setReadyNoteRetryMs, __setT3Seam, readyingNote, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { registerAgent } from "../src/agent.ts";
import { createItem, getItem } from "../../../apps/cli/src/items.ts";
import { enqueueSpinoff, rowsInTeam, type EnqueueInput } from "../src/commands/spinoff.ts";
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

interface Fake {
  seam: T3Seam;
  sends: T3SendInput[];
  held: Record<string, T3QueuedMessage[]>;
  cancelled: Array<{ threadId: string; queuedRunId: string }>;
}

function fakeSeam(held: Record<string, T3QueuedMessage[]> = {}): Fake {
  const fake: Fake = { sends: [], held, cancelled: [], seam: {} as T3Seam };
  const unused = (name: string) => async () => {
    throw new Error(`${name} is not used by the handoff and close paths`);
  };
  fake.seam = {
    interrupt: async () => {},
    projects: unused("projects") as T3Seam["projects"],
    capabilities: unused("capabilities") as T3Seam["capabilities"],
    list: unused("list") as T3Seam["list"],
    read: liveRead,
    launch: unused("launch") as T3Seam["launch"],
    rename: unused("rename") as T3Seam["rename"],
    settle: async () => {},
    send: async (input) => {
      fake.sends.push(input);
    },
    queue: async (threadId) => ({ items: fake.held[threadId] ?? [], complete: true }),
    queueCancel: async (threadId, queuedRunId) => {
      fake.cancelled.push({ threadId, queuedRunId });
      fake.held[threadId] = (fake.held[threadId] ?? []).filter((m) => m.queuedRunId !== queuedRunId);
    },
    pin: async () => {},
    unpin: async () => {},
    disableAutoSettle: async () => {},
    wait: async () => ({ runId: null, status: "idle", timedOut: false }),
  };
  return fake;
}

function fakeGit(): void {
  restores.push(
    __setSh((cmd) => {
      const line = cmd.join(" ");
      if (line.includes("status --porcelain")) return { ok: true, err: "", out: "" };
      if (line.includes("rev-list --count")) return { ok: true, err: "", out: "2\n" };
      if (line.includes("log --format=%B")) return { ok: true, err: "", out: "feat(x): y\n\nState: landable\n" };
      if (line.includes("rev-parse --verify")) return { ok: true, err: "", out: "base123\n" };
      return { ok: true, err: "", out: "" };
    }),
  );
}

const REPO = "/r/omnislash";
const input = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  ticketRef: "1",
  repo: REPO,
  branch: "b",
  mode: "interactive",
  brief: "teams",
  ...over,
});

/**
 * A store with projects pixelslash (in team `slash`), omnislash (in team `omnislash`) and loose (in no team), one item
 * in `project`, and a launched t3 row for it whose builder registered its readying note. Each team has an
 * architect thread; `sentinel` binds slash's sentinel too.
 */
async function seed(project: string | null, opts: { sentinel?: boolean; architect?: boolean } = {}): Promise<{ dbPath: string; ref: string; db: ReturnType<typeof openDb> }> {
  const dbPath = freshDbPath();
  const db = openDb(dbPath, { create: true });
  for (const p of ["pixelslash", "omnislash", "loose"]) expect((await runCli(dbPath, ["project", "add", p, "--kind", "side"])).code).toBe(0);
  expect((await runCli(dbPath, ["t3", "team", "add", "slash", "--projects", "pixelslash"])).code).toBe(0);
  expect((await runCli(dbPath, ["t3", "team", "add", "omnislash", "--projects", "omnislash"])).code).toBe(0);
  const itemId = await createItem(db, { type: "task", title: "a team ticket", ...(project ? { projectId: project } : {}) });
  const ref = (await getItem(db, itemId))!.ref ?? itemId;
  const wt = mkdtempSync(join(tmpdir(), "ob-wt-2255-"));
  restores.push(() => rmSync(wt, { recursive: true, force: true }));
  const { row } = await enqueueSpinoff(db, input({ ticketRef: ref, worktree: wt }));
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, worktree = ?, launcher = 't3', t3_thread_id = ?, base_sha = ? WHERE id = ?").run(
    ref,
    wt,
    "builder-thread-1",
    "base123",
    row.id,
  );
  await registerAgent(db, { id: ref, ticket: ref, branch: "b", worktree: wt, status: "readying", note: "gate green", ttlS: 900 });
  if (opts.architect !== false) {
    await registerAgent(db, { id: "architect-omnislash", worktree: REPO, status: "planning", launcher: "t3", sessionId: "omnislash-architect-thread", ttlS: 900 });
    await registerAgent(db, { id: "architect-slash", worktree: REPO, status: "planning", launcher: "t3", sessionId: "slash-architect-thread", ttlS: 900 });
  }
  if (opts.sentinel) await registerAgent(db, { id: "sentinel-slash", worktree: REPO, status: "planning", launcher: "t3", sessionId: "sentinel-thread", ttlS: 900 });
  await openRunsOnSeats(db);
  return { dbPath, ref, db };
}

/** A second launched t3 row in the same store, for a ticket in `project`; returns its ref. */
async function addRow(db: ReturnType<typeof openDb>, project: string): Promise<string> {
  const itemId = await createItem(db, { type: "task", title: "another team ticket", projectId: project });
  const ref = (await getItem(db, itemId))!.ref ?? itemId;
  const wt = mkdtempSync(join(tmpdir(), "ob-wt-2255-"));
  restores.push(() => rmSync(wt, { recursive: true, force: true }));
  const { row } = await enqueueSpinoff(db, input({ ticketRef: ref, worktree: wt, branch: "b2" }));
  db.query("UPDATE spinoff SET status = 'launched', agent_id = ?, worktree = ?, launcher = 't3', t3_thread_id = ?, base_sha = ? WHERE id = ?").run(
    ref,
    wt,
    "builder-thread-2",
    "base123",
    row.id,
  );
  await registerAgent(db, { id: ref, ticket: ref, branch: "b2", worktree: wt, status: "readying", note: "gate green", ttlS: 900 });
  return ref;
}

/** OS-56: the checkout a started role run opens in, as `ob role start` resolves it. */
const CWD_REPO = worktreeRepoOf(checkoutOf(process.cwd())) ?? checkoutOf(process.cwd());

describe("a handoff goes to the team's sentinel, never its architect (OB-2255 Done when 5, OS-181)", () => {
  test("a pixelslash row with the slash sentinel bound sends to the sentinel thread", async () => {
    fakeGit();
    const { dbPath, ref } = await seed("pixelslash", { sentinel: true });
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));
    const res = await runCli(dbPath, ["spinoff", "handoff", ref, "--ci-unchecked", "test"]);
    expect(res.code).toBe(0);
    expect(fake.sends.map((s) => s.threadId)).toEqual(["sentinel-thread"]);
  });

  test("a team with no sentinel gets one started with the note in its brief; a second handoff reuses that run", async () => {
    fakeGit();
    const { dbPath, ref, db } = await seed("pixelslash");
    const t3 = installFakeT3([CWD_REPO]);
    restores.push(t3.restore);
    const res = await runCli(dbPath, ["spinoff", "handoff", ref, "--ci-unchecked", "test"]);
    expect(res.code).toBe(0);
    expect(t3.launches.map((l) => l.message!.split("\n")[0])).toEqual(["/ob-sentinel"]);
    expect(t3.launches[0]!.message).toContain(ref);
    expect(res.out).toContain("slash sentinel: run 3 opened, thread t3-1, with 1 message in its start brief");
    // The architect's seat thread (open run 1) gets nothing.
    expect(t3.sends.map((s) => s.threadId)).not.toContain("slash-architect-thread");

    const second = await addRow(db, "pixelslash");
    const res2 = await runCli(dbPath, ["spinoff", "handoff", second, "--ci-unchecked", "test"]);
    expect(res2.code).toBe(0);
    expect(t3.launches).toHaveLength(1);
    expect(t3.sends.map((s) => s.threadId)).toEqual(["t3-1"]);
    expect(t3.sends[0]!.message).toContain(second);
    expect(res2.out).toContain("queued into run 3, thread t3-1");
  });

  test("a team whose sentinel cannot start holds the note; the architect gets nothing", async () => {
    fakeGit();
    const { dbPath, ref } = await seed("pixelslash");
    // No T3 project for the checkout: the sentinel's start refuses.
    const t3 = installFakeT3([]);
    restores.push(t3.restore);
    const res = await runCli(dbPath, ["spinoff", "handoff", ref, "--ci-unchecked", "test"]);
    const all = res.out + res.err;
    expect(all).toContain("the readying note did not reach the sentinel and is held (never sent to the architect)");
    expect(all).toContain("slash sentinel could not start or take the note");
    expect(all).toContain("no T3 project is registered");
    expect(t3.launches).toEqual([]);
    expect(t3.sends).toEqual([]);
    const inbox = await runCli(dbPath, ["inbox", "slash", "sentinel", "--json"]);
    expect(inbox.code).toBe(0);
    expect((JSON.parse(inbox.out) as Array<{ ref: string | null }>).map((m) => m.ref)).toEqual([ref]);
    expect(JSON.parse((await runCli(dbPath, ["inbox", "slash", "architect", "--json"])).out)).toEqual([]);
  });

  test("a start that finds another start still launching the sentinel holds the note", async () => {
    fakeGit();
    const { dbPath, ref, db } = await seed("pixelslash");
    // A parallel start has marked the run and not yet recorded its thread.
    await markRoleRun(db, { team: "slash", role: "sentinel", t3Host: t3BaseUrl() });
    const t3 = installFakeT3([CWD_REPO]);
    restores.push(t3.restore);
    const res = await runCli(dbPath, ["spinoff", "handoff", ref, "--ci-unchecked", "test"]);
    const all = res.out + res.err;
    expect(all).toContain("did not reach the sentinel and is held");
    expect(all).toContain("another start is launching it");
    expect(t3.launches).toEqual([]);
    expect(t3.sends).toEqual([]);
    expect((JSON.parse((await runCli(dbPath, ["inbox", "slash", "sentinel", "--json"])).out) as unknown[]).length).toBe(1);
  });

  test("a project in no team sends no note and prints the one line", async () => {
    fakeGit();
    const { dbPath, ref } = await seed("loose", { sentinel: true });
    const fake = fakeSeam();
    restores.push(__setT3Seam(fake.seam));
    const res = await runCli(dbPath, ["spinoff", "handoff", ref, "--ci-unchecked", "test"]);
    expect(res.code).toBe(0);
    expect(fake.sends).toEqual([]);
    const all = res.out + res.err;
    expect(all.split("loose is in no team: ob t3 team join <team> loose, or ob t3 architect in its checkout").length - 1).toBe(1);
  });

  test("a team with neither thread bound starts the sentinel's run, not the architect's (OS-56, OS-181)", async () => {
    fakeGit();
    const { dbPath, ref } = await seed("pixelslash", { architect: false });
    const t3 = installFakeT3([CWD_REPO]);
    restores.push(t3.restore);
    const res = await runCli(dbPath, ["spinoff", "handoff", ref, "--ci-unchecked", "test"]);
    expect(res.code).toBe(0);
    expect(t3.launches.map((l) => l.message!.split("\n")[0])).toEqual(["/ob-sentinel"]);
    expect(t3.sends).toEqual([]);
    expect(res.out).toContain("slash sentinel: run 1 opened, thread t3-1, with 1 message in its start brief");
  });
});

function heldNote(ticket: string, runId: string): T3QueuedMessage {
  return {
    queuedRunId: runId,
    text: readyingNote({
      ticket,
      branch: "b",
      worktree: `/r/omnislash.${ticket}`,
      commitsAhead: 1,
      state: "State: landable",
      builderNote: "gate green",
      rowId: 1,
      status: "handed-off",
      composedAt: "2026-11-17T01:00:00.000Z",
    }),
    truncated: false,
  };
}

describe("ob close withdraws a held note from the same thread (OB-2255 Done when 5)", () => {
  test("the note for the landed ticket is withdrawn from the sentinel thread; the architect queue is not touched", async () => {
    fakeGit();
    const { dbPath, ref } = await seed("pixelslash", { sentinel: true });
    const fake = fakeSeam({ "sentinel-thread": [heldNote(ref, "run:stale"), heldNote("PS-99", "run:other")], "slash-architect-thread": [heldNote(ref, "run:architect")] });
    restores.push(__setT3Seam(fake.seam));
    const res = await runCli(dbPath, ["close", ref]);
    expect(res.code).toBe(0);
    expect(fake.cancelled).toEqual([{ threadId: "sentinel-thread", queuedRunId: "run:stale" }]);
    expect(fake.held["sentinel-thread"]!.map((m) => m.queuedRunId)).toEqual(["run:other"]);
  });

  test("with no sentinel thread nothing is withdrawn, and the architect queue is not touched (OS-181)", async () => {
    fakeGit();
    const { dbPath, ref } = await seed("pixelslash");
    const fake = fakeSeam({ "slash-architect-thread": [heldNote(ref, "run:held")] });
    restores.push(__setT3Seam(fake.seam));
    const res = await runCli(dbPath, ["close", ref]);
    expect(res.code).toBe(0);
    expect(fake.cancelled).toEqual([]);
    expect(fake.held["slash-architect-thread"]!.map((m) => m.queuedRunId)).toEqual(["run:held"]);
  });

  test("a project in no team: the close reads no queue and says nothing", async () => {
    fakeGit();
    const { dbPath, ref } = await seed("loose");
    const fake = fakeSeam({ "omnislash-architect-thread": [heldNote(ref, "run:held")] });
    restores.push(__setT3Seam(fake.seam));
    const res = await runCli(dbPath, ["close", ref]);
    expect(res.code).toBe(0);
    expect(fake.cancelled).toEqual([]);
    expect(res.err).not.toContain("in no team");
  });
});

describe("spinoff list|gateable --team (OB-2255 Done when 8)", () => {
  test("rowsInTeam matches a row by a member's mapped checkout or by the last path segment", () => {
    const checkout = mkdtempSync(join(tmpdir(), "ob-2255-checkout-"));
    restores.push(() => rmSync(checkout, { recursive: true, force: true }));
    Bun.spawnSync(["mkdir", "-p", join(checkout, ".git")]);
    // A mapped checkout matches by path, a path whose last segment names a member matches by slug, and the rest do not.
    const rows = [{ repo: checkout }, { repo: "/home/x/dev/flakeslash" }, { repo: "omnislash" }, { repo: "/nowhere/omnislash" }];
    const members = [
      { id: "pixel", name: "pixel" },
      { id: "flakeslash", name: "FlakeSlash" },
    ];
    expect(rowsInTeam(rows, members, { pixel: checkout }, "/nonexistent-home")).toEqual([{ repo: checkout }, { repo: "/home/x/dev/flakeslash" }]);
  });

  test("the commands keep only the team's rows, and refuse an unknown team", async () => {
    const dbPath = freshDbPath();
    const db = openDb(dbPath, { create: true });
    for (const p of ["pixelslash", "omnislash"]) await runCli(dbPath, ["project", "add", p, "--kind", "side"]);
    await runCli(dbPath, ["t3", "team", "add", "slash", "--projects", "pixelslash"]);
    for (const [ref, repo] of [
      ["PS-1", "pixelslash"],
      ["OB-1", "omnislash"],
    ] as const) {
      const { row } = await enqueueSpinoff(db, input({ ticketRef: ref, repo, branch: ref.toLowerCase(), worktree: `/nowhere/${ref}` }));
      db.query("UPDATE spinoff SET status = 'ready-for-gate' WHERE id = ?").run(row.id);
    }
    const listed = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--team", "slash", "--json"])).out) as Array<{ ticket_ref: string }>;
    expect(listed.map((r) => r.ticket_ref)).toEqual(["PS-1"]);
    const all = JSON.parse((await runCli(dbPath, ["spinoff", "list", "--json"])).out) as Array<{ ticket_ref: string }>;
    expect(all.map((r) => r.ticket_ref).sort()).toEqual(["OB-1", "PS-1"]);
    const gateable = await runCli(dbPath, ["spinoff", "gateable", "--team", "slash"]);
    expect(gateable.code).toBe(0);
    expect(gateable.out).toContain("PS-1");
    expect(gateable.out).not.toContain("OB-1");
    const bad = await runCli(dbPath, ["spinoff", "gateable", "--team", "nope"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("no team 'nope'");
  });
});

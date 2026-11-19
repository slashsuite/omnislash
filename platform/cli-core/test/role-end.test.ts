// OS-57: `ob role tick` ends a role run that is idle (15 minutes after its last turn) or over the context cap (200k),
// after asking it for its successor note. `endCheck` is tested as a table on a fixed clock; `contextTokens` against a
// temp sqlite file shaped like T3's state db; the end pass against a throwaway SQLite store and the fake T3 seam, with an
// injected clock and sleep (the sleep is where the run "writes" its note).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDbPath, runCli, type CliResult } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3, type FakeT3Install } from "../../../apps/cli/test/fake-t3.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { t3Seam, worktreeRepoOf, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { t3BaseUrl, type T3Thread } from "../../../apps/cli/src/t3/client.ts";
import { checkoutOf } from "../../../apps/cli/src/commands/t3-team.ts";
import { sendRoleMessage, type RoleMessage } from "../../../apps/cli/src/inbox.ts";
import { markRoleRun, openRoleRuns, updateRoleRun, writeRoleNote, type RoleRun } from "../../../apps/cli/src/role-run.ts";
import { sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseStatus } from "../../cli-coord/src/lease.ts";
import { setConfig } from "../../../apps/cli/src/config.ts";
import { storeRoleBackend, storeTickBackend } from "../../../apps/cli/src/commands/role.ts";
import { storeInboxBackend } from "../../../apps/cli/src/commands/inbox.ts";
import { runRoleTick } from "../../../apps/cli/src/commands/role-tick.ts";
import {
  contextTokens,
  endCheck,
  endPass,
  renderEndResult,
  roleNoteRequestMessage,
  type EndCheckInput,
  type EndPassDeps,
} from "../../../apps/cli/src/role-end.ts";
import type { TeamRole } from "../../../apps/cli/src/team.ts";

const REPO = worktreeRepoOf(checkoutOf(process.cwd())) ?? checkoutOf(process.cwd());
const MIN = 60_000;
const NOW = new Date("2026-11-19T12:00:00.000Z");
const ago = (mins: number): string => new Date(NOW.getTime() - mins * MIN).toISOString();

let fake: FakeT3Install | null = null;
let home: string;
let prevHome: string | undefined;

beforeEach(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "ob-end-home-"));
  process.env.HOME = home;
});

afterEach(() => {
  fake?.restore();
  fake = null;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

// --- endCheck ---------------------------------------------------------------------------------------------------

const QUIET: EndCheckInput = {
  thread: { status: "idle", activeRunId: null, pendingRequestCount: 0, settled: false, archived: false },
  queued: 0,
  lastCompletedAt: ago(5),
  startedAt: ago(60),
  unread: 0,
  contextTokens: 50_000,
  nightLocked: false,
};
const at = (patch: Partial<EndCheckInput>): EndCheckInput => ({ ...QUIET, ...patch });

describe("endCheck", () => {
  test.each([
    ["a run in flight", at({ thread: { ...QUIET.thread, status: "running", activeRunId: "r1" } }), { keep: "it has a run in flight (running)" }],
    ["a pending request", at({ thread: { ...QUIET.thread, pendingRequestCount: 1 } }), { keep: "it has 1 pending request(s) waiting on the owner" }],
    ["queued messages", at({ queued: 2 }), { keep: "it holds 2 queued message(s)" }],
    ["an unreadable queue", at({ queued: null }), { keep: "its queue could not be read, so it may be holding messages" }],
    ["unread inbox rows", at({ unread: 3, lastCompletedAt: ago(30) }), { keep: "3 unread messages" }],
    ["one unread inbox row", at({ unread: 1, lastCompletedAt: ago(30) }), { keep: "1 unread message" }],
    ["unread rows under the night lock", at({ unread: 1, lastCompletedAt: ago(30), nightLocked: true }), { end: "idle" }],
    ["15 minutes after the newest completed run", at({ lastCompletedAt: ago(15) }), { end: "idle" }],
    ["14 minutes after", at({ lastCompletedAt: ago(14) }), { keep: "active 14m ago" }],
    ["no runs: 15 minutes after started_at", at({ lastCompletedAt: null, startedAt: ago(15) }), { end: "idle" }],
    ["no runs: 14 minutes after started_at", at({ lastCompletedAt: null, startedAt: ago(14) }), { keep: "active 14m ago" }],
    ["200,000 tokens, active a minute ago", at({ contextTokens: 200_000, lastCompletedAt: ago(1) }), { end: "context" }],
    ["200,000 tokens with unread rows", at({ contextTokens: 200_000, unread: 2, lastCompletedAt: ago(1) }), { end: "context" }],
    ["199,999 tokens", at({ contextTokens: 199_999, lastCompletedAt: ago(1) }), { keep: "active 1m ago" }],
    ["null tokens never ends on context", at({ contextTokens: null, lastCompletedAt: ago(1) }), { keep: "active 1m ago" }],
    ["200,000 tokens mid-turn", at({ contextTokens: 250_000, thread: { ...QUIET.thread, status: "running", activeRunId: "r1" } }), { keep: "it has a run in flight (running)" }],
    ["a settled thread", at({ thread: { ...QUIET.thread, settled: true }, lastCompletedAt: ago(1) }), { end: "idle" }],
    ["an archived thread", at({ thread: { ...QUIET.thread, archived: true }, lastCompletedAt: ago(1) }), { end: "idle" }],
  ] as const)("%s", (_name, input, want) => {
    expect(endCheck(input as EndCheckInput, NOW)).toEqual(want as never);
  });
});

// --- contextTokens -----------------------------------------------------------------------------------------------

describe("contextTokens", () => {
  const T3_TABLE = "create table orchestration_v2_projection_provider_turns (thread_id text, payload_json text)";

  function stateDb(rows: Array<[string, string]>, table = true): string {
    const dir = mkdtempSync(join(home, "t3-"));
    const path = join(dir, "statev2.sqlite");
    const db = new Database(path, { create: true });
    if (table) {
      db.run(T3_TABLE);
      for (const [thread, payload] of rows) db.query("insert into orchestration_v2_projection_provider_turns values (?, ?)").run(thread, payload);
    }
    db.close();
    return path;
  }

  test("reads the newest row's usedTokens for the thread", () => {
    const path = stateDb([
      ["th-1", JSON.stringify({ tokenUsage: { usedTokens: 100_000 } })],
      ["th-2", JSON.stringify({ tokenUsage: { usedTokens: 5 } })],
      ["th-1", JSON.stringify({ tokenUsage: { usedTokens: 133_959 } })],
    ]);
    expect(contextTokens("th-1", path)).toBe(133_959);
    expect(contextTokens("th-2", path)).toBe(5);
  });

  test("null for a missing file, a missing table, a missing row and a non-number", () => {
    expect(contextTokens("th-1", join(home, "nope", "statev2.sqlite"))).toBeNull();
    expect(contextTokens("th-1", stateDb([], false))).toBeNull();
    expect(contextTokens("th-9", stateDb([["th-1", JSON.stringify({ tokenUsage: { usedTokens: 1 } })]]))).toBeNull();
    expect(contextTokens("th-1", stateDb([["th-1", JSON.stringify({ tokenUsage: { usedTokens: "lots" } })]]))).toBeNull();
    expect(contextTokens("th-1", stateDb([["th-1", "not json"]]))).toBeNull();
  });

  test("defaults to ~/.t3/userdata/statev2.sqlite under HOME", () => {
    mkdirSync(join(home, ".t3", "userdata"), { recursive: true });
    const db = new Database(join(home, ".t3", "userdata", "statev2.sqlite"), { create: true });
    db.run(T3_TABLE);
    db.query("insert into orchestration_v2_projection_provider_turns values (?, ?)").run("th-1", JSON.stringify({ tokenUsage: { usedTokens: 42 } }));
    db.close();
    expect(contextTokens("th-1")).toBe(42);
  });
});

test("roleNoteRequestMessage names the reason and the note command", () => {
  const idle = roleNoteRequestMessage("t", "architect", "idle");
  expect(idle).toContain("15 minutes");
  expect(idle).toContain("`ob role note t architect --body-file <file>`");
  expect(roleNoteRequestMessage("t", "sentinel", "context")).toContain("passed 200k tokens");
});

// --- the end pass ------------------------------------------------------------------------------------------------

interface Harness {
  run(args: string[]): Promise<CliResult>;
  store: Store;
}

async function local(): Promise<Harness> {
  const dbPath = freshDbPath();
  const db = openDb(dbPath, { create: true });
  const h: Harness = { run: (args) => runCli(dbPath, args), store: sqliteStoreFor(db) };
  expect((await h.run(["project", "add", "endp", "--kind", "side"])).code).toBe(0);
  expect((await h.run(["t3", "team", "add", "t", "--projects", "endp"])).code).toBe(0);
  await setConfig(h.store, "repo_checkouts", JSON.stringify({ endp: REPO }));
  return h;
}

/** An open run for `role` on `host`, bound to a quiet fake thread, started `startedMins` before NOW. */
async function openRun(h: Harness, role: TeamRole, opts: { host?: string; startedMins?: number } = {}): Promise<{ run: RoleRun; thread: T3Thread }> {
  const f = fake ?? (fake = installFakeT3([REPO]));
  const { run } = await markRoleRun(h.store, { team: "t", role, t3Host: opts.host ?? t3BaseUrl() });
  const threadId = `th-${role}`;
  const thread: T3Thread = {
    threadId,
    projectId: "proj-0",
    title: `t ${role}`,
    status: "idle",
    worktreePath: null,
    branch: null,
    settled: false,
    archived: false,
    model: "claude-opus-5-5",
    providerInstanceId: "claudeAgent",
    activeRunId: null,
    latestRunId: null,
  };
  f.threads.push(thread);
  await updateRoleRun(h.store, "t", run.id, { thread_id: threadId });
  const t = h.store.t.roleRun;
  const { eq } = await import("drizzle-orm");
  await h.store.q.update(t).set({ started_at: ago(opts.startedMins ?? 20) }).where(eq(t.id, run.id));
  return { run: (await openRoleRuns(h.store, "t", role))[0]!, thread };
}

/** A clock that starts at NOW and a sleep that advances it, calling `onSleep` with the elapsed ms first. */
function clock(onSleep: (elapsedMs: number) => Promise<void> | void = () => {}) {
  let t = NOW.getTime();
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      await onSleep(t - NOW.getTime());
      t += ms;
    },
    slept,
    elapsed: () => t - NOW.getTime(),
  };
}

function deps(c: ReturnType<typeof clock>, patch: Partial<EndPassDeps> = {}): EndPassDeps {
  return { now: c.now, sleep: c.sleep, contextTokens: () => 10_000, nightLocked: false, ...patch };
}

async function allRuns(store: Store): Promise<RoleRun[]> {
  const t = store.t.roleRun;
  return (await store.q.select().from(t).orderBy(t.id)) as RoleRun[];
}

async function messages(store: Store): Promise<RoleMessage[]> {
  const t = store.t.roleMessage;
  return (await store.q.select().from(t).orderBy(t.id)) as RoleMessage[];
}

describe("the end pass", () => {
  test("an idle run: one note request, the note stored, the thread settled, end_reason idle, the lease released", async () => {
    const h = await local();
    const { run, thread } = await openRun(h, "architect");
    expect((await leaseStatus(h.store)).map((l) => l.resource)).toContain("role:t:architect");
    const c = clock(async () => {
      await writeRoleNote(h.store, "t", "architect", "line one\nline two\n");
    });
    const res = await endPass(storeRoleBackend(h.store), storeInboxBackend(h.store), () => t3Seam(), "t", deps(c));
    expect(fake!.sends).toHaveLength(1);
    expect(fake!.sends[0]).toMatchObject({ threadId: thread.threadId, mode: "queue" });
    expect(fake!.sends[0]!.message).toContain("ob role note t architect");
    expect(res).toMatchObject([{ role: "architect", run_id: run.id, result: "ended", end_reason: "idle", note_lines: 2, context_tokens: 10_000 }]);
    expect(renderEndResult("t", res[0]!)).toEqual([`role tick t architect: run ${run.id} ended (idle), note 2 lines`]);
    expect(thread.settled).toBe(true);
    expect(fake!.unpinned).toEqual([thread.threadId]);
    const [ended] = await allRuns(h.store);
    expect(ended).toMatchObject({ end_reason: "idle", successor_note: "line one\nline two\n", context_tokens: 10_000 });
    expect(ended!.ended_at).not.toBeNull();
    expect((await leaseStatus(h.store)).map((l) => l.resource)).not.toContain("role:t:architect");
  });

  test("no note within 10 minutes: the run stays open, its thread is not settled, and the kept line prints", async () => {
    const h = await local();
    const { thread } = await openRun(h, "architect");
    const c = clock();
    const res = await endPass(storeRoleBackend(h.store), storeInboxBackend(h.store), () => t3Seam(), "t", deps(c));
    expect(res).toMatchObject([{ result: "no-note" }]);
    expect(renderEndResult("t", res[0]!)).toEqual(["role tick t architect: no note within 10m, run kept"]);
    expect(c.elapsed()).toBe(10 * MIN);
    expect(thread.settled).toBe(false);
    expect((await openRoleRuns(h.store, "t"))).toHaveLength(1);
    expect((await leaseStatus(h.store)).map((l) => l.resource)).toContain("role:t:architect");
  });

  test("a run on another host is skipped by name and its thread is never read", async () => {
    const h = await local();
    await openRun(h, "architect", { host: "http://other-machine.test:3773" });
    const calls: string[] = [];
    const seam = new Proxy({} as T3Seam, {
      get: (_t, prop) => async () => {
        calls.push(String(prop));
        throw new Error(`unexpected T3 call: ${String(prop)}`);
      },
    });
    const c = clock();
    const res = await endPass(storeRoleBackend(h.store), storeInboxBackend(h.store), async () => seam, "t", deps(c));
    expect(calls).toEqual([]);
    expect(renderEndResult("t", res[0]!)).toEqual(["skip t architect: run on http://other-machine.test:3773"]);
  });

  test("a busy run is kept, with its reason, and is not asked", async () => {
    const h = await local();
    const { thread } = await openRun(h, "architect");
    thread.status = "running";
    thread.activeRunId = "r1";
    const res = await endPass(storeRoleBackend(h.store), storeInboxBackend(h.store), () => t3Seam(), "t", deps(clock()));
    expect(renderEndResult("t", res[0]!)).toEqual(["role tick t architect: kept (it has a run in flight (running))"]);
    expect(fake!.sends).toEqual([]);
  });

  test("unknown context prints its line once and records null", async () => {
    const h = await local();
    await openRun(h, "architect", { startedMins: 2 });
    const res = await endPass(storeRoleBackend(h.store), storeInboxBackend(h.store), () => t3Seam(), "t", deps(clock(), { contextTokens: () => null }));
    expect(renderEndResult("t", res[0]!)).toEqual(["role tick t architect: context unknown for th-architect", "role tick t architect: kept (active 2m ago)"]);
  });

  test("with the night lock on and one unread row, an idle run is asked and ended, and the row stays unread", async () => {
    const h = await local();
    const { thread } = await openRun(h, "architect");
    await sendRoleMessage(h.store, { team: "t", role: "architect", from: "someone", kind: "message", body: "hello" });
    const c = clock(async () => {
      await writeRoleNote(h.store, "t", "architect", "note\n");
    });
    const res = await endPass(storeRoleBackend(h.store), storeInboxBackend(h.store), () => t3Seam(), "t", deps(c, { nightLocked: true }));
    expect(res).toMatchObject([{ result: "ended", end_reason: "idle" }]);
    expect(fake!.sends).toHaveLength(1);
    expect(thread.settled).toBe(true);
    expect(await messages(h.store)).toMatchObject([{ body: "hello", read_at: null }]);
  });

  test("two runs due in one pass are both asked first, and the pass waits at most 10 minutes in total", async () => {
    const h = await local();
    await openRun(h, "architect");
    await openRun(h, "sentinel");
    let sendsAtFirstSleep = null as number | null;
    const c = clock(async (elapsed) => {
      sendsAtFirstSleep ??= fake!.sends.length;
      // The sentinel writes its note five minutes in; the architect never does.
      if (elapsed === 5 * MIN) await writeRoleNote(h.store, "t", "sentinel", "s\n");
    });
    const res = await endPass(storeRoleBackend(h.store), storeInboxBackend(h.store), () => t3Seam(), "t", deps(c));
    expect(sendsAtFirstSleep).toBe(2);
    expect(c.elapsed()).toBe(10 * MIN);
    expect(res.map((r) => [r.role, r.result])).toEqual([
      ["architect", "no-note"],
      ["sentinel", "ended"],
    ]);
  });

  test("a run over the context cap ends with end_reason context while recently active", async () => {
    const h = await local();
    await openRun(h, "architect", { startedMins: 1 });
    const c = clock(async () => {
      await writeRoleNote(h.store, "t", "architect", "n\n");
    });
    const res = await endPass(storeRoleBackend(h.store), storeInboxBackend(h.store), () => t3Seam(), "t", deps(c, { contextTokens: () => 200_000 }));
    expect(res).toMatchObject([{ result: "ended", end_reason: "context" }]);
    expect(fake!.sends[0]!.message).toContain("passed 200k tokens");
  });
});

describe("ob role tick runs the end pass", () => {
  test("a team with zero unread rows (the early exit before delivery) still ends an idle run", async () => {
    const h = await local();
    const { thread } = await openRun(h, "architect");
    const c = clock(async () => {
      await writeRoleNote(h.store, "t", "architect", "n\n");
    });
    const ctx = { mode: "quiet" as const, flags: {}, exit: 0 };
    await runRoleTick(ctx, storeTickBackend(h.store), () => t3Seam(), { now: c.now, sleep: c.sleep, contextTokens: () => 1 });
    expect(ctx.exit).toBe(0);
    expect(thread.settled).toBe(true);
    expect(await allRuns(h.store)).toMatchObject([{ end_reason: "idle" }]);
  });

  test("under the night lock the tick still ends an idle run with an unread row, and the row stays unread", async () => {
    const h = await local();
    const { thread } = await openRun(h, "architect");
    await sendRoleMessage(h.store, { team: "t", role: "architect", from: "someone", kind: "message", body: "for the morning" });
    mkdirSync(join(home, ".cache"), { recursive: true });
    writeFileSync(join(home, ".cache", "ob-good-night"), new Date(Date.now() + 6 * 60 * MIN).toISOString());
    const c = clock(async () => {
      await writeRoleNote(h.store, "t", "architect", "n\n");
    });
    const ctx = { mode: "quiet" as const, flags: {}, exit: 0 };
    await runRoleTick(ctx, storeTickBackend(h.store), () => t3Seam(), { now: c.now, sleep: c.sleep, contextTokens: () => 1 });
    expect(fake!.sends).toHaveLength(1);
    expect(thread.settled).toBe(true);
    expect(await messages(h.store)).toMatchObject([{ body: "for the morning", read_at: null }]);
  });

  test("ob role status shows the context tokens the last tick read", async () => {
    const h = await local();
    await openRun(h, "architect", { startedMins: 1 });
    await endPass(storeRoleBackend(h.store), storeInboxBackend(h.store), () => t3Seam(), "t", deps(clock(), { contextTokens: () => 123_456 }));
    const status = await h.run(["role", "status", "t"]);
    expect(status.code).toBe(0);
    expect(status.out).toContain("123456 context tokens");
  });
});

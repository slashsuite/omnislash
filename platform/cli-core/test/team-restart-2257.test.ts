// OB-2257: `ob t3 team restart` relays each role thread's handoff to its replacement, and `ob t3 team handoff`
// records and shows it. The procedure runs on a fake T3 seam whose old thread "writes" its handoff when it is
// asked (the send records a row, as the real thread would by running `ob t3 team handoff`). The local half runs
// through `runCli` on a throwaway SQLite store; the API half sends the CLI's own requests through `createObApi`
// on a real Postgres store (the ob 325 harness), so the route, the handler and the client are one path.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { T3Error, type T3LaunchInput, type T3SendInput, type T3Thread } from "../../../apps/cli/src/t3/client.ts";
import { __setT3Seam, storeAgentRegistry, worktreeRepoOf, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { checkoutOf } from "../../../apps/cli/src/commands/t3-team.ts";
import { busyReason, restartTeamRole, restartTeams, type RestartBackend } from "../../../apps/cli/src/team-restart.ts";
import { consumeTeamHandoff, latestTeamHandoff, recordTeamHandoff } from "../../../apps/cli/src/team-handoff.ts";
import { getTeam, teamView, listTeamViews, type TeamRole } from "../../../apps/cli/src/team.ts";
import { openStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";

const REPO = worktreeRepoOf(checkoutOf(process.cwd())) ?? checkoutOf(process.cwd());

// A run inside a T3 thread carries that thread's id: it would make every handoff "from" the test runner's thread
// and every restart treat it as the caller. Each test sets it where it means to.
const T3_ENV = "T3CODE_THREAD_ID";
const prevThreadEnv = process.env[T3_ENV];
beforeAll(() => {
  delete process.env[T3_ENV];
});
afterAll(() => {
  if (prevThreadEnv === undefined) delete process.env[T3_ENV];
  else process.env[T3_ENV] = prevThreadEnv;
});

let restoreSeam: (() => void) | null = null;
afterEach(() => {
  restoreSeam?.();
  restoreSeam = null;
  delete process.env[T3_ENV];
});

interface FakeT3 {
  seam: T3Seam;
  threads: T3Thread[];
  /** Every seam call that changes something, in order: `send:<id>`, `interrupt:<id>`, `settle:<id>`, `unpin:<id>`, `launch`, `pin:<id>`. */
  calls: string[];
  launches: T3LaunchInput[];
  sends: T3SendInput[];
  /** Queued messages per thread. */
  queued: Record<string, number>;
}

function thread(id: string, over: Partial<T3Thread> = {}): T3Thread {
  return {
    threadId: id,
    projectId: "proj-0",
    title: "old",
    status: "idle",
    worktreePath: null,
    branch: null,
    settled: false,
    archived: false,
    model: "claude-opus-5-5",
    providerInstanceId: "claudeAgent",
    activeRunId: null,
    latestRunId: null,
    pendingRequestCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * A fake T3. `onHandoffAsk(threadId)` runs when a thread is sent the handoff request: the test records the
 * handoff there, standing in for the old thread's own `ob t3 team handoff`.
 */
function fakeT3(threads: T3Thread[], onHandoffAsk: (threadId: string) => Promise<void> = async () => {}): FakeT3 {
  const calls: string[] = [];
  const launches: T3LaunchInput[] = [];
  const sends: T3SendInput[] = [];
  const queued: Record<string, number> = {};
  const find = (id: string) => threads.find((t) => t.threadId === id);
  const seam: T3Seam = {
    projects: async () => [{ id: "proj-0", title: "repo", workspaceRoot: REPO, defaultModelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, deletedAt: null }],
    capabilities: async () => ({
      runtimeMode: "full-access",
      providers: [{ providerInstanceId: "claudeAgent", displayName: "Claude", models: [{ id: "claude-opus-5-5" }], constraints: [] }],
    }),
    list: async () => ({ projectId: "proj-0", threads: [], nextCursor: null }),
    read: async (id) => {
      const t = find(id);
      if (!t) throw new T3Error("refused", `t3_thread_read: thread ${id} not found`);
      return { thread: t, recentRuns: [], items: [], nextPosition: 0, hasMore: false };
    },
    launch: async (input) => {
      calls.push("launch");
      launches.push(input);
      const t = thread(`new-${launches.length}`, { title: input.title, status: "running", activeRunId: "r", createdAt: new Date().toISOString() });
      threads.push(t);
      return { threadId: t.threadId, projectId: "proj-0", modelSelection: input.modelSelection, runId: "r", status: "running" };
    },
    pin: async (id) => void calls.push(`pin:${id}`),
    unpin: async (id) => void calls.push(`unpin:${id}`),
    disableAutoSettle: async () => {},
    rename: async (id, title) => {
      const t = find(id);
      if (t) t.title = title;
    },
    settle: async (id) => {
      calls.push(`settle:${id}`);
      const t = find(id);
      if (t) t.settled = true;
    },
    interrupt: async (id) => {
      calls.push(`interrupt:${id}`);
      const t = find(id);
      if (t) Object.assign(t, { status: "interrupted", activeRunId: null, pendingRequestCount: 0 });
    },
    send: async (input) => {
      calls.push(`send:${input.threadId}`);
      sends.push(input);
      // Only the handoff ask makes the thread write one; a moved line or a forward is just delivered.
      if (input.message.includes("ob t3 team handoff")) await onHandoffAsk(input.threadId);
    },
    queue: async (id) => ({ items: Array.from({ length: queued[id] ?? 0 }, (_, i) => ({ queuedRunId: `q${i}`, text: "x", truncated: false })) as never, complete: true }),
    queueCancel: async () => {},
    wait: async () => ({ runId: null, status: "idle", timedOut: false }),
  };
  return { seam, threads, calls, launches, sends, queued };
}

/** A store-backed restart backend, the same calls `ob t3 team restart` makes locally. */
function backendOf(store: Store | ReturnType<typeof openDb>): RestartBackend {
  return {
    show: async (n) => {
      const t = await getTeam(store, n);
      return t ? teamView(store, t) : null;
    },
    list: () => listTeamViews(store),
    registry: storeAgentRegistry(store),
    handoffLatest: (t, r, filter) => latestTeamHandoff(store, t, r, filter),
    handoffConsume: async (t, id, thr) => void (await consumeTeamHandoff(store, t, id, thr)),
    buildingThreads: async () => [],
    cwdRepo: async () => REPO,
  };
}

/** A store with project `acme` in team `omni`, and the roles bound to the given threads. */
async function seededTeam(roles: Partial<Record<TeamRole, string>>): Promise<{ dbPath: string; fake: (f: FakeT3) => void }> {
  const dbPath = freshDbPath();
  openDb(dbPath, { create: true }).close();
  expect((await runCli(dbPath, ["project", "add", "acme", "--kind", "side"])).code).toBe(0);
  expect((await runCli(dbPath, ["t3", "team", "add", "omni", "--icon", "🚌", "--display-name", "Omni", "--projects", "acme"])).code).toBe(0);
  const install = (f: FakeT3) => {
    restoreSeam?.();
    restoreSeam = __setT3Seam(f.seam);
  };
  for (const [role, id] of Object.entries(roles)) {
    install(fakeT3([thread(id!)]));
    expect((await runCli(dbPath, ["t3", role, "omni", "--thread", id!])).code).toBe(0);
  }
  return { dbPath, fake: install };
}

function bodyFile(text: string): string {
  const p = join(process.env.TMPDIR ?? tmpdir(), `handoff-2257-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(p, text);
  return p;
}

describe("ob t3 team handoff (OB-2257 Done when 4)", () => {
  test("records a handoff from the bound thread and --show prints the latest", async () => {
    const { dbPath } = await seededTeam({ architect: "thr-a" });
    const none = await runCli(dbPath, ["t3", "team", "handoff", "omni", "--role", "architect", "--show"]);
    expect(none.code).toBe(1);
    expect(none.out).toContain("omni architect: no handoff recorded");
    const rec = await runCli(dbPath, ["t3", "team", "handoff", "omni", "--role", "architect", "--body-file", bodyFile("first\n")]);
    expect(rec.code).toBe(0);
    expect(rec.out).toContain("omni architect: handoff 1 recorded (5 characters) from thr-a");
    expect((await runCli(dbPath, ["t3", "team", "handoff", "omni", "--role", "architect", "--body-file", bodyFile("second: OB-1 in flight")])).code).toBe(0);
    const show = await runCli(dbPath, ["t3", "team", "handoff", "omni", "--role", "architect", "--show"]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("handoff 2  omni architect  from thr-a");
    expect(show.out).toContain("not yet seeded");
    expect(show.out).toContain("second: OB-1 in flight");
    expect((await runCli(dbPath, ["t3", "team", "handoff", "omni", "--role", "architect", "--show", "-q"])).out.trim()).toBe("second: OB-1 in flight");
  });

  test("refuses a bad role, an unknown team, an empty body, and a flag it does not read", async () => {
    const { dbPath } = await seededTeam({});
    const role = await runCli(dbPath, ["t3", "team", "handoff", "omni", "--role", "boss", "--body", "x"]);
    expect(role.code).toBe(2);
    expect(role.err).toContain("--role must be one of architect|sentinel|muse (got 'boss')");
    expect((await runCli(dbPath, ["t3", "team", "handoff", "nope", "--role", "architect", "--body", "x"])).err).toContain("no team 'nope'");
    expect((await runCli(dbPath, ["t3", "team", "handoff", "omni", "--role", "architect", "--body", "  "])).err).toContain("the handoff body is empty");
    // The body rides in the seed, and T3 takes a launch message of at most 120,000 characters.
    const big = await runCli(dbPath, ["t3", "team", "handoff", "omni", "--role", "architect", "--body", "x".repeat(64_001)]);
    expect(big.code).toBe(2);
    expect(big.err).toContain("the handoff body is 64001 characters; at most 64000");
    const unread = await runCli(dbPath, ["t3", "team", "handoff", "omni", "--role", "architect", "--force"]);
    expect(unread.code).toBe(2);
    expect((await runCli(dbPath, ["t3", "team", "restart", "omni", "--body", "x"])).code).toBe(2);
  });
});

describe("ob t3 team restart, local (OB-2257 Done when 1, 2, 5)", () => {
  test("replaces each bound role in order: ask, record, settle, unpin, open, pin, seed with the handoff", async () => {
    const { dbPath, fake } = await seededTeam({ architect: "thr-a", sentinel: "thr-s" });
    const db = openDb(dbPath);
    const f = fakeT3([thread("thr-a"), thread("thr-s")], async (id) => {
      const role = id === "thr-a" ? "architect" : "sentinel";
      await recordTeamHandoff(db, { team: "omni", role, body: `${role} carries on with OB-9` });
    });
    fake(f);
    const res = await runCli(dbPath, ["t3", "team", "restart", "omni"]);
    expect(res.code).toBe(0);
    expect(f.calls).toEqual([
      "send:thr-a",
      "settle:thr-a",
      "unpin:thr-a",
      "launch",
      "pin:new-1",
      "send:thr-s", // OB-2275: the sentinel is told the architect's new thread
      "send:thr-s",
      "settle:thr-s",
      "unpin:thr-s",
      "launch",
      "pin:new-2",
      "send:new-1", // and the new architect the sentinel's
    ]);
    expect(f.sends[0]!.mode).toBe("queue");
    expect(f.sends[0]!.message).toContain("ob t3 team handoff omni --role architect --body-file <file>");
    expect(f.sends[0]!.message).toContain("Only after that, delete your own scheduled tasks");
    const seed = f.launches[0]!;
    expect(seed.title).toBe("🚌 Omni · architect");
    expect(seed.message!.startsWith("/ob-architect\n")).toBe(true);
    expect(seed.message).toContain("Carry on from the handoff below");
    expect(seed.message).not.toContain("Orient only");
    expect(seed.message).toContain("architect carries on with OB-9");
    expect(f.launches[1]!.message).toContain("/ob-sentinel");
    expect(res.out).toContain("restarted omni architect: thr-a → new-1");
    expect(res.out).toContain("restarted omni sentinel: thr-s → new-2");
    expect(res.out).toContain("skipped   omni muse: no thread is bound");
    const shown = JSON.parse((await runCli(dbPath, ["t3", "team", "show", "omni", "--json"])).out);
    expect(shown.threads).toEqual([
      { role: "architect", agent_id: "architect-omni", thread_id: "new-1" },
      { role: "sentinel", agent_id: "sentinel-omni", thread_id: "new-2" },
    ]);
    const h = await latestTeamHandoff(db, "omni", "architect");
    expect(h).toMatchObject({ old_thread_id: "thr-a", new_thread_id: "new-1" });
    expect(h!.consumed_at).not.toBeNull();
    db.close();
  });

  test("--role limits it to the roles named", async () => {
    const { dbPath, fake } = await seededTeam({ architect: "thr-a", sentinel: "thr-s" });
    const db = openDb(dbPath);
    const f = fakeT3([thread("thr-a"), thread("thr-s")], async () => void (await recordTeamHandoff(db, { team: "omni", role: "sentinel", body: "s" })));
    fake(f);
    const res = await runCli(dbPath, ["t3", "team", "restart", "omni", "--role", "sentinel"]);
    expect(res.code).toBe(0);
    expect(f.calls.filter((c) => c.startsWith("send:"))).toEqual(["send:thr-s", "send:thr-a"]);
    expect(f.sends[1]!.message).toBe("omni sentinel moved to thread new-1 (was thr-s). Send to new-1 from now on.");
    expect(res.out).not.toContain("omni architect");
    expect((await runCli(dbPath, ["t3", "team", "restart", "omni", "--role", "boss"])).code).toBe(2);
    db.close();
  });

  test("--all restarts every team, one role at a time; a team and --all together is refused", async () => {
    const { dbPath, fake } = await seededTeam({ architect: "thr-a" });
    expect((await runCli(dbPath, ["project", "add", "pixelslash", "--kind", "side"])).code).toBe(0);
    expect((await runCli(dbPath, ["t3", "team", "add", "slash", "--projects", "pixelslash"])).code).toBe(0);
    fake(fakeT3([thread("thr-x")]));
    expect((await runCli(dbPath, ["t3", "architect", "slash", "--thread", "thr-x"])).code).toBe(0);
    const db = openDb(dbPath);
    const f = fakeT3([thread("thr-a"), thread("thr-x")], async (id) => {
      await recordTeamHandoff(db, { team: id === "thr-a" ? "omni" : "slash", role: "architect", body: `from ${id}` });
    });
    fake(f);
    const res = await runCli(dbPath, ["t3", "team", "restart", "--all", "--role", "architect"]);
    expect(res.code).toBe(0);
    // Teams go by name (omni, then slash), and each role finishes before the next one starts.
    expect(f.calls.filter((c) => c.startsWith("send:") || c === "launch")).toEqual(["send:thr-a", "launch", "send:thr-x", "launch"]);
    expect(f.launches[1]!.message).toContain("from thr-x");
    expect((await runCli(dbPath, ["t3", "team", "restart", "omni", "--all"])).code).toBe(2);
    expect((await runCli(dbPath, ["t3", "team", "restart"])).code).toBe(2);
    db.close();
  });
});

describe("a busy thread is skipped, and --force interrupts it (OB-2257 Done when 2)", () => {
  for (const [what, over, queued, why] of [
    ["a run in flight", { status: "running", activeRunId: "r1" }, 0, "it has a run in flight (running)"],
    ["a pending request", { pendingRequestCount: 1 }, 0, "it has 1 pending request(s) waiting on the owner"],
    ["queued messages", {}, 2, "it holds 2 queued message(s)"],
  ] as const) {
    test(`${what}: skipped with the reason, nothing sent; --force interrupts and goes on`, async () => {
      const { dbPath, fake } = await seededTeam({ architect: "thr-a" });
      const db = openDb(dbPath);
      const f = fakeT3([thread("thr-a", over)], async () => void (await recordTeamHandoff(db, { team: "omni", role: "architect", body: "b" })));
      f.queued["thr-a"] = queued;
      fake(f);
      const skipped = await runCli(dbPath, ["t3", "team", "restart", "omni"]);
      expect(skipped.code).toBe(1);
      expect(skipped.out).toContain(`skipped   omni architect: thread thr-a is busy: ${why}; re-run with --force`);
      expect(f.calls).toEqual([]);
      const forced = await runCli(dbPath, ["t3", "team", "restart", "omni", "--force"]);
      expect(forced.code).toBe(0);
      expect(f.calls.slice(0, 2)).toEqual(["interrupt:thr-a", "send:thr-a"]);
      expect(forced.out).toContain("restarted omni architect: thr-a → new-1");
      db.close();
    });
  }

  test("busyReason reads an idle thread with an empty queue as free, and an unreadable queue as busy", () => {
    expect(busyReason({ status: "idle", pendingRequestCount: 0, activeRunId: null }, 0)).toBeNull();
    expect(busyReason({ status: "completed", activeRunId: null }, 0)).toBeNull();
    expect(busyReason({ status: "idle", activeRunId: null }, null)).toContain("could not be read");
  });
});

describe("the caller's own thread is never restarted (OB-2257 review)", () => {
  test("skipped by name even under --force: no interrupt, nothing sent", async () => {
    const { dbPath } = await seededTeam({ architect: "thr-a" });
    const db = openDb(dbPath);
    const f = fakeT3([thread("thr-a", { status: "running", activeRunId: "r1" })]);
    const out = await restartTeamRole(backendOf(db), (await backendOf(db).show("omni"))!, "architect", { seam: f.seam, force: true, self: "thr-a", log: () => {} });
    expect(out.result).toBe("skipped");
    expect(out.reason).toContain("is the thread running this command");
    expect(f.calls).toEqual([]);
    db.close();
  });
});

describe("no handoff within --timeout (OB-2257 Done when 3)", () => {
  test("the role is skipped and stays bound, with a heartbeat line each minute while it waited", async () => {
    const { dbPath } = await seededTeam({ architect: "thr-a" });
    const db = openDb(dbPath);
    const f = fakeT3([thread("thr-a")]);
    let clock = Date.parse("2026-11-17T10:00:00.000Z");
    const lines: string[] = [];
    const team = (await backendOf(db).show("omni"))!;
    const out = await restartTeamRole(backendOf(db), team, "architect", {
      seam: f.seam,
      timeoutMs: 3 * 60_000,
      log: (l) => lines.push(l),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(out).toMatchObject({ result: "skipped", oldThreadId: "thr-a", newThreadId: null });
    expect(out.reason).toContain("no handoff from thr-a within 3m; it stays bound and pinned");
    const beats = lines.filter((l) => l.includes("waiting for the handoff"));
    expect(beats).toEqual([
      "omni architect: 2026-11-17T10:01:00.000Z waiting for the handoff from thr-a (1m of 3m)",
      "omni architect: 2026-11-17T10:02:00.000Z waiting for the handoff from thr-a (2m of 3m)",
    ]);
    expect(f.calls).toEqual(["send:thr-a"]);
    expect((await backendOf(db).show("omni"))!.threads[0]!.thread_id).toBe("thr-a");
    db.close();
  });
});

describe("a re-run resumes (OB-2257)", () => {
  test("an older handoff left unconsumed (recorded late) never passes for 'already replaced': the thread is asked again", async () => {
    const { dbPath } = await seededTeam({ architect: "thr-x" });
    const db = openDb(dbPath);
    // H1 from thr-x, recorded after its restart timed out; a later restart then seeded new-n from H2.
    await recordTeamHandoff(db, { team: "omni", role: "architect", body: "H1 late" });
    const h2 = await recordTeamHandoff(db, { team: "omni", role: "architect", body: "H2" });
    await consumeTeamHandoff(db, "omni", h2.id, "thr-n");
    const f = fakeT3([thread("thr-x"), thread("thr-n", { createdAt: "2099-01-01T00:00:00.000Z" })], async () => {
      await recordTeamHandoff(db, { team: "omni", role: "architect", body: "H3 fresh" });
    });
    const team = (await backendOf(db).show("omni"))!;
    // bind the role to thr-n, the replacement, as the earlier restart did
    await backendOf(db).registry.register({ id: "architect-omni", worktree: REPO, launcher: "t3", sessionId: "thr-n", ttlS: 3600 });
    const out = await restartTeamRole(backendOf(db), team, "architect", { seam: f.seam, log: () => {} });
    expect(out.result).toBe("restarted");
    expect(f.calls[0]).toBe("send:thr-n");
    expect(f.launches[0]!.message).toContain("H3 fresh");
    db.close();
  });

  test("an old thread settled after its handoff, with no replacement yet, is replaced from the held handoff without asking again", async () => {
    const { dbPath } = await seededTeam({ architect: "thr-a" });
    const db = openDb(dbPath);
    await recordTeamHandoff(db, { team: "omni", role: "architect", body: "held body" });
    const f = fakeT3([thread("thr-a", { settled: true })]);
    const team = (await backendOf(db).show("omni"))!;
    const out = await restartTeamRole(backendOf(db), team, "architect", { seam: f.seam, log: () => {} });
    expect(out).toMatchObject({ result: "restarted", newThreadId: "new-1" });
    expect(f.calls).toEqual(["unpin:thr-a", "launch", "pin:new-1"]);
    expect(f.launches[0]!.message).toContain("held body");
    expect((await latestTeamHandoff(db, "omni", "architect"))!.new_thread_id).toBe("new-1");
    db.close();
  });

  test("restartTeams with a settled thread and no handoff skips, naming the command that opens a new one", async () => {
    const { dbPath } = await seededTeam({ architect: "thr-a" });
    const db = openDb(dbPath);
    const f = fakeT3([thread("thr-a", { settled: true })]);
    const [out] = await restartTeams(backendOf(db), [(await backendOf(db).show("omni"))!], { seam: f.seam, roles: ["architect"], log: () => {} });
    expect(out!.result).toBe("skipped");
    expect(out!.reason).toContain("ob t3 architect omni");
    expect(f.calls).toEqual([]);
    db.close();
  });
});

// --- over the API -----------------------------------------------------------------------------------------

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

async function withApi(fn: (deps: { api: { base: string; token: string; transport: ApiTransport } }, store: Store) => Promise<void>): Promise<void> {
  const lease = await leaseRealPgDb();
  const store = await openStore({ kind: "postgres", connection: lease.options as unknown as Record<string, unknown> });
  const obApi = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const transport: ApiTransport = async (req) => {
    const res = await obApi(
      new Request(req.url.replace(BASE, "http://api-host.local"), {
        method: req.method,
        headers: req.headers,
        ...(req.body === undefined ? {} : { body: req.body }),
      }),
    );
    return { status: res.status, body: await res.text() };
  };
  try {
    await fn({ api: { base: BASE, token: TOKEN, transport } }, store);
  } finally {
    await store.close?.();
  }
}

describe("ob t3 team handoff and restart over the API (OB-2257 Done when 1, 4)", () => {
  test("record, show and restart through the server, with the handoff in Postgres", async () => {
    await withApi(async (deps, store) => {
      const run = (args: string[]) => runCli(freshDbPath(), args, deps);
      expect((await run(["project", "add", "acme", "--kind", "side"])).code).toBe(0);
      expect((await run(["t3", "team", "add", "omni", "--icon", "🚌", "--display-name", "Omni", "--projects", "acme"])).code).toBe(0);
      restoreSeam = __setT3Seam(fakeT3([thread("thr-a")]).seam);
      expect((await run(["t3", "architect", "omni", "--thread", "thr-a"])).code).toBe(0);

      const rec = await run(["t3", "team", "handoff", "omni", "--role", "architect", "--body-file", bodyFile("api body")]);
      expect(rec.code).toBe(0);
      expect(rec.out).toContain("omni architect: handoff 1 recorded (8 characters) from thr-a");
      expect((await run(["t3", "team", "handoff", "omni", "--role", "architect", "--show", "-q"])).out.trim()).toBe("api body");
      expect((await run(["t3", "team", "handoff", "nope", "--role", "architect", "--body", "x"])).code).toBe(1);
      expect((await run(["t3", "team", "handoff", "omni", "--role", "boss", "--body", "x"])).code).toBe(2);

      const f = fakeT3([thread("thr-a")], async () => void (await recordTeamHandoff(store, { team: "omni", role: "architect", body: "relayed over the api" })));
      restoreSeam();
      restoreSeam = __setT3Seam(f.seam);
      const res = await run(["t3", "team", "restart", "omni", "--role", "architect"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("restarted omni architect: thr-a → new-1");
      expect(f.launches[0]!.message).toContain("relayed over the api");
      const h = await latestTeamHandoff(store, "omni", "architect");
      expect(h).toMatchObject({ id: 2, old_thread_id: "thr-a", new_thread_id: "new-1" });
      expect(JSON.parse((await run(["t3", "team", "show", "omni", "--json"])).out).threads[0].thread_id).toBe("new-1");
    });
  });
});

// --- OB-2275: the team is told the new thread, and a replaced thread's late report is forwarded ----------------

/** A building spinoff row for `repo` whose builder thread is `threadId`. Fixture state, so plain SQL. */
function buildingRow(db: ReturnType<typeof openDb>, repo: string, threadId: string, status = "launched"): void {
  db.query(
    "INSERT INTO spinoff (ticket_ref, repo, branch, worktree, mode, brief, status, request_at, t3_thread_id) VALUES (?, ?, ?, ?, 'interactive', 'b', ?, '2026-11-17T00:00:00Z', ?)",
  ).run(`OB-${threadId}`, repo, `b-${threadId}`, `/wt/${threadId}`, status, threadId);
}

describe("after a restart the team is told the new thread (OB-2275 Done when 1)", () => {
  test("one queued moved line to each other live role thread and each building team spinoff, none to the caller, the replaced or a settled thread", async () => {
    const { dbPath, fake } = await seededTeam({ architect: "thr-a", sentinel: "thr-s", muse: "thr-m" });
    const db = openDb(dbPath);
    buildingRow(db, "acme", "thr-b1");
    buildingRow(db, "acme", "thr-b2");
    buildingRow(db, "acme", "thr-h", "ready-for-gate"); // handed off: not building
    buildingRow(db, "pixelslash", "thr-x"); // another team's project
    const f = fakeT3(
      [thread("thr-a"), thread("thr-s"), thread("thr-m", { settled: true }), thread("thr-b1"), thread("thr-b2"), thread("thr-h"), thread("thr-x"), thread("thr-me")],
      async () => void (await recordTeamHandoff(db, { team: "omni", role: "architect", body: "a" })),
    );
    fake(f);
    // The caller is the builder thr-b2: it is never told what it just did.
    process.env[T3_ENV] = "thr-b2";
    const res = await runCli(dbPath, ["t3", "team", "restart", "omni", "--role", "architect"]);
    expect(res.code).toBe(0);
    const moved = f.sends.filter((s) => s.message.includes("moved to thread"));
    expect(moved.map((s) => s.threadId)).toEqual(["thr-s", "thr-b1"]);
    for (const s of moved) {
      expect(s.mode).toBe("queue");
      expect(s.message).toBe("omni architect moved to thread new-1 (was thr-a). Send to new-1 from now on.");
      expect(s.clientRequestId).toBe(`ob-team-moved-omni-architect-new-1-${s.threadId}`);
    }
    expect(res.out).toContain("omni architect: told thr-s, thr-b1 the new thread");
    db.close();
  });

  test("a failed moved line is named in the outcome and never fails the restart", async () => {
    const { dbPath } = await seededTeam({ architect: "thr-a", sentinel: "thr-s" });
    const db = openDb(dbPath);
    const f = fakeT3([thread("thr-a"), thread("thr-s")], async () => void (await recordTeamHandoff(db, { team: "omni", role: "architect", body: "a" })));
    const send = f.seam.send;
    f.seam.send = async (input) => {
      if (input.message.includes("moved to thread")) throw new Error("t3 down");
      return send(input);
    };
    const out = await restartTeamRole(backendOf(db), (await backendOf(db).show("omni"))!, "architect", { seam: f.seam, self: null, log: () => {} });
    expect(out.result).toBe("restarted");
    expect(out.reason).toContain("not told: thr-s");
    db.close();
  });
});

describe("a handoff from a replaced thread is forwarded to the bound one (OB-2275 Done when 2, 3, 4)", () => {
  test("the row names its real writer, is queued to the bound thread, consumed with its id, and a later restart asks the live thread", async () => {
    const { dbPath, fake } = await seededTeam({ architect: "thr-new" });
    const f = fakeT3([thread("thr-new")], async () => {
      const db = openDb(dbPath);
      await recordTeamHandoff(db, { team: "omni", role: "architect", body: "fresh from thr-new" });
      db.close();
    });
    fake(f);
    process.env[T3_ENV] = "thr-old";
    const rec = await runCli(dbPath, ["t3", "team", "handoff", "omni", "--role", "architect", "--body", "sentinel report 4"]);
    expect(rec.code).toBe(0);
    expect(rec.out).toContain("handoff 1 recorded (17 characters) from thr-old");
    expect(rec.out).toContain("thr-old is no longer the architect: forwarded to thr-new and marked consumed");
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toMatchObject({ threadId: "thr-new", mode: "queue", clientRequestId: "ob-late-handoff-omni-1" });
    expect(f.sends[0]!.message).toBe("Late report from replaced thread thr-old, handoff 1:\n\nsentinel report 4");
    const db = openDb(dbPath);
    expect(await latestTeamHandoff(db, "omni", "architect")).toMatchObject({ id: 1, old_thread_id: "thr-old", new_thread_id: "thr-new" });
    expect((await latestTeamHandoff(db, "omni", "architect"))!.consumed_at).not.toBeNull();

    // The next restart asks thr-new and seeds from its fresh answer, not from the forwarded report.
    delete process.env[T3_ENV];
    const res = await runCli(dbPath, ["t3", "team", "restart", "omni"]);
    expect(res.code).toBe(0);
    expect(f.calls.slice(1, 2)).toEqual(["send:thr-new"]);
    expect(f.launches[0]!.message).toContain("fresh from thr-new");
    expect(f.launches[0]!.message).not.toContain("sentinel report 4");
    db.close();
  });

  test("the bound thread recording its own handoff (the restart ask) is kept, not forwarded", async () => {
    const { dbPath, fake } = await seededTeam({ architect: "thr-a" });
    const f = fakeT3([thread("thr-a")]);
    fake(f);
    process.env[T3_ENV] = "thr-a";
    const rec = await runCli(dbPath, ["t3", "team", "handoff", "omni", "--role", "architect", "--body", "mine"]);
    expect(rec.code).toBe(0);
    expect(rec.out).not.toContain("forwarded");
    expect(f.sends).toEqual([]);
    const db = openDb(dbPath);
    expect(await latestTeamHandoff(db, "omni", "architect")).toMatchObject({ old_thread_id: "thr-a", consumed_at: null });
    db.close();
  });

  test("a failed forward leaves the row unconsumed and exits 1", async () => {
    const { dbPath, fake } = await seededTeam({ architect: "thr-new" });
    const f = fakeT3([thread("thr-new")]);
    f.seam.send = async () => {
      throw new Error("t3 refused");
    };
    fake(f);
    process.env[T3_ENV] = "thr-old";
    const rec = await runCli(dbPath, ["t3", "team", "handoff", "omni", "--role", "architect", "--body", "late"]);
    expect(rec.code).toBe(1);
    expect(rec.err).toContain("handoff 1 was recorded but not forwarded to thr-new: t3 refused");
    const db = openDb(dbPath);
    expect(await latestTeamHandoff(db, "omni", "architect")).toMatchObject({ old_thread_id: "thr-old", consumed_at: null });
    db.close();
  });

  test("a restart never seeds from an unconsumed handoff another thread wrote", async () => {
    const { dbPath } = await seededTeam({ architect: "thr-new" });
    const db = openDb(dbPath);
    await recordTeamHandoff(db, { team: "omni", role: "architect", body: "stale late report", fromThreadId: "thr-old" });
    // Live bound thread: asked afresh. A late report written while it waits is not taken for its answer, and
    // one written just after its answer does not hide it.
    const f = fakeT3([thread("thr-new")], async () => {
      await recordTeamHandoff(db, { team: "omni", role: "architect", body: "another late one", fromThreadId: "thr-old" });
    });
    let polls = 0;
    const out = await restartTeamRole(backendOf(db), (await backendOf(db).show("omni"))!, "architect", {
      seam: f.seam,
      self: null,
      log: () => {},
      timeoutMs: 60_000,
      sleep: async () => {
        polls += 1;
        if (polls !== 1) return;
        await recordTeamHandoff(db, { team: "omni", role: "architect", body: "the real answer" });
        await recordTeamHandoff(db, { team: "omni", role: "architect", body: "a late one after it", fromThreadId: "thr-old" });
      },
    });
    expect(out.result).toBe("restarted");
    expect(f.launches[0]!.message).toContain("the real answer");
    expect(f.launches[0]!.message).not.toContain("late");

    // A re-run after the bound thread settled with its handoff held: a late report recorded since does not strand it.
    const { dbPath: p3 } = await seededTeam({ architect: "thr-new" });
    const db3 = openDb(p3);
    await recordTeamHandoff(db3, { team: "omni", role: "architect", body: "held answer" });
    const late = await recordTeamHandoff(db3, { team: "omni", role: "architect", body: "late", fromThreadId: "thr-old" });
    await consumeTeamHandoff(db3, "omni", late.id, "thr-new");
    const f3 = fakeT3([thread("thr-new", { settled: true })]);
    const out3 = await restartTeamRole(backendOf(db3), (await backendOf(db3).show("omni"))!, "architect", { seam: f3.seam, self: null, log: () => {} });
    expect(out3.result).toBe("restarted");
    expect(f3.launches[0]!.message).toContain("held answer");
    db3.close();

    // A re-run after the seed went out but its consume failed, with a late report from the replaced thread since:
    // the bound thread is still recognised as the replacement and the seeding handoff is marked, nothing relaunched.
    const { dbPath: p4 } = await seededTeam({ architect: "thr-n" });
    const db4 = openDb(p4);
    const h1 = await recordTeamHandoff(db4, { team: "omni", role: "architect", body: "seeded", fromThreadId: "thr-a" });
    const opened = new Date(Date.parse(h1.created_at) + 1000).toISOString();
    const h2 = await recordTeamHandoff(db4, { team: "omni", role: "architect", body: "late", fromThreadId: "thr-a" });
    await consumeTeamHandoff(db4, "omni", h2.id, "thr-n");
    // h2 is recorded after thr-n opened
    db4.query("UPDATE team_handoff SET created_at = ? WHERE id = ?").run(new Date(Date.parse(opened) + 1000).toISOString(), h2.id);
    const f4 = fakeT3([thread("thr-n", { createdAt: opened })]);
    const out4 = await restartTeamRole(backendOf(db4), (await backendOf(db4).show("omni"))!, "architect", { seam: f4.seam, self: null, log: () => {} });
    expect(out4).toMatchObject({ result: "restarted", newThreadId: "thr-n", handoffId: h1.id });
    expect(out4.reason).toContain("already replaced by thr-n");
    expect(f4.launches).toEqual([]);
    expect(f4.calls.filter((c) => c.startsWith("send:thr-n"))).toEqual([]);
    expect((await latestTeamHandoff(db4, "omni", "architect", { from: "thr-a", createdBefore: opened }))).toMatchObject({ id: h1.id, new_thread_id: "thr-n" });
    db4.close();

    // Settled bound thread whose only unconsumed handoff is someone else's: skipped, nothing seeded.
    const { dbPath: p2 } = await seededTeam({ architect: "thr-new" });
    const db2 = openDb(p2);
    await recordTeamHandoff(db2, { team: "omni", role: "architect", body: "stale", fromThreadId: "thr-old" });
    const f2 = fakeT3([thread("thr-new", { settled: true })]);
    const out2 = await restartTeamRole(backendOf(db2), (await backendOf(db2).show("omni"))!, "architect", { seam: f2.seam, self: null, log: () => {} });
    expect(out2.result).toBe("skipped");
    expect(f2.launches).toEqual([]);
    db.close();
    db2.close();
  });

  test("a second report the thread writes before it settles is the one seeded, and a later restart asks the new thread", async () => {
    const { dbPath } = await seededTeam({ architect: "thr-a" });
    const db = openDb(dbPath);
    const f = fakeT3([thread("thr-a")], async () => void (await recordTeamHandoff(db, { team: "omni", role: "architect", body: "H1 first" })));
    f.seam.wait = async () => {
      await recordTeamHandoff(db, { team: "omni", role: "architect", body: "H1 rewritten" });
      return { runId: null, status: "idle", timedOut: false };
    };
    const team = (await backendOf(db).show("omni"))!;
    const out = await restartTeamRole(backendOf(db), team, "architect", { seam: f.seam, self: null, log: () => {} });
    expect(out).toMatchObject({ result: "restarted", newThreadId: "new-1", handoffId: 2 });
    expect(f.launches[0]!.message).toContain("H1 rewritten");
    // The next restart asks new-1, not "already replaced".
    const f2 = fakeT3([...f.threads], async () => void (await recordTeamHandoff(db, { team: "omni", role: "architect", body: "from new-1" })));
    Object.assign(f2.threads.find((t) => t.threadId === "new-1")!, { status: "idle", activeRunId: null });
    const again = await restartTeamRole(backendOf(db), (await backendOf(db).show("omni"))!, "architect", { seam: f2.seam, self: null, log: () => {} });
    expect(again.reason).not.toContain("already replaced");
    expect(f2.calls[0]).toBe("send:new-1");
    db.close();
  });

  test("over the API the record keeps the sender the client sends", async () => {
    await withApi(async (deps, store) => {
      const run = (args: string[]) => runCli(freshDbPath(), args, deps);
      expect((await run(["project", "add", "acme", "--kind", "side"])).code).toBe(0);
      expect((await run(["t3", "team", "add", "omni", "--projects", "acme"])).code).toBe(0);
      const f = fakeT3([thread("thr-new")]);
      restoreSeam = __setT3Seam(f.seam);
      expect((await run(["t3", "architect", "omni", "--thread", "thr-new"])).code).toBe(0);
      process.env[T3_ENV] = "thr-old";
      const rec = await run(["t3", "team", "handoff", "omni", "--role", "architect", "--body", "over the wire"]);
      expect(rec.code).toBe(0);
      expect(rec.out).toContain("from thr-old");
      expect(rec.out).toContain("forwarded to thr-new");
      expect(await latestTeamHandoff(store, "omni", "architect")).toMatchObject({ old_thread_id: "thr-old", new_thread_id: "thr-new" });
      delete process.env[T3_ENV];
      expect((await run(["t3", "team", "handoff", "omni", "--role", "architect", "--body", "from a terminal"])).out).toContain("from thr-new");
    });
  });
});

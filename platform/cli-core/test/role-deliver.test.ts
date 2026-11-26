// OS-56: `ob send` delivers into the role's run. With no open run it starts one whose brief lists the inbox; with an
// open run on this machine's T3 it queues the message into that thread; with one on another machine's T3 it leaves
// the message stored and unread. `--no-deliver` only stores.
//
// Every case runs twice: locally against a throwaway SQLite store through `runCli`, and over the API, where the CLI's
// own requests go through `createObApi` on a real Postgres store (a local cluster, no network, no live database). T3 is
// the fake seam, which records every launch and send.
import { afterEach, describe, expect, test } from "bun:test";
import { freshDbPath, runCli, type CliResult } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3, type FakeT3Install } from "../../../apps/cli/test/fake-t3.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { __setT3Seam, storeAgentRegistry, t3Seam, worktreeRepoOf } from "../../../apps/cli/src/t3/dispatch.ts";
import { T3_BASE_URL_ENV } from "../../../apps/cli/src/t3/client.ts";
import { checkoutOf } from "../../../apps/cli/src/commands/t3-team.ts";
import { sendRoleMessage, type RoleMessage } from "../../../apps/cli/src/inbox.ts";
import { openRoleRuns, type RoleRun } from "../../../apps/cli/src/role-run.ts";
import { openStore, sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";

/** The checkout a role run opens in: the cwd's repo, as `ob role start` resolves it. */
const REPO = worktreeRepoOf(checkoutOf(process.cwd())) ?? checkoutOf(process.cwd());
const OTHER_HOST = "http://other-machine.test:3773";

let fake: FakeT3Install | null = null;
afterEach(() => {
  fake?.restore();
  fake = null;
});

interface Harness {
  run(args: string[]): Promise<CliResult>;
  store: Store;
}

async function local(): Promise<Harness> {
  const dbPath = freshDbPath();
  const db = openDb(dbPath, { create: true });
  const h: Harness = { run: (args) => runCli(dbPath, args), store: sqliteStoreFor(db) };
  expect((await h.run(["t3", "team", "add", "t"])).code).toBe(0);
  return h;
}

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

async function withApi(fn: (h: Harness) => Promise<void>): Promise<void> {
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
  const deps = { api: { base: BASE, token: TOKEN, transport } };
  const h: Harness = { run: (args) => runCli(freshDbPath(), args, deps), store };
  try {
    expect((await h.run(["t3", "team", "add", "t"])).code).toBe(0);
    await fn(h);
  } finally {
    await store.close?.();
  }
}

function t3(): FakeT3Install {
  fake = installFakeT3([REPO]);
  return fake;
}

async function withHost<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[T3_BASE_URL_ENV];
  process.env[T3_BASE_URL_ENV] = host;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[T3_BASE_URL_ENV];
    else process.env[T3_BASE_URL_ENV] = prev;
  }
}

async function messages(store: Store): Promise<RoleMessage[]> {
  const t = store.t.roleMessage;
  return (await store.q.select().from(t).orderBy(t.id)) as RoleMessage[];
}

async function runs(store: Store): Promise<RoleRun[]> {
  const t = store.t.roleRun;
  return (await store.q.select().from(t).orderBy(t.id)) as RoleRun[];
}


/** OS-82: a live thread `seat-1` in the fake T3, bound as the role's seat the way `ob t3 architect --thread` binds it. */
async function bindSeat(store: Store, f: FakeT3Install, role = "architect", threadId = "seat-1"): Promise<void> {
  f.threads.push({
    threadId,
    projectId: "proj-0",
    title: `t · ${role}`,
    status: "idle",
    worktreePath: null,
    branch: null,
    settled: false,
    archived: false,
    model: "claude-opus-5-5",
    providerInstanceId: "claudeAgent",
    activeRunId: null,
    latestRunId: null,
  });
  await storeAgentRegistry(store).register({ id: `${role}-t`, worktree: REPO, status: "planning", launcher: "t3", sessionId: threadId, ttlS: 3600 });
}

const CASES: Array<[string, (h: Harness) => Promise<void>]> = [
  [
    "OS-82: with a live seat and no run, send queues one message into the seat, marks it read by the seat, opens no run",
    async (h) => {
      const f = t3();
      await bindSeat(h.store, f);
      const res = await h.run(["send", "t", "architect", "x"]);
      expect(res.err).toBe("");
      expect(res.code).toBe(0);
      expect(res.out).toContain("t architect: message #1 stored; 1 message queued into seat thread seat-1");
      expect(f.launches).toHaveLength(0);
      expect(f.sends.map((s) => [s.threadId, s.mode, s.clientRequestId])).toEqual([["seat-1", "queue", "ob-role-msg-seat-1-1"]]);
      expect(f.sends[0]!.message).toBe("x\n\n(inbox #1 from owner, message; marked read by this seat)");
      expect((await messages(h.store))[0]).toMatchObject({ read_by: "seat:architect-t" });
      expect(await runs(h.store)).toEqual([]);
      expect((await storeAgentRegistry(h.store).read("architect-t"))?.session_id).toBe("seat-1");
    },
  ],
  [
    "send with no open run starts one run whose brief lists the message, and marks it read by the run",
    async (h) => {
      const f = t3();
      const res = await h.run(["send", "t", "architect", "x"]);
      expect(res.err).toBe("");
      expect(res.code).toBe(0);
      expect(res.out).toContain("t architect: message #1 stored; run 1 opened, thread t3-1, with 1 message in its start brief, marked read by role-run-1");
      expect(f.launches).toHaveLength(1);
      expect(f.launches[0]!.message).toContain("#1 from owner (message): x");
      expect(f.sends).toHaveLength(0);
      const [m] = await messages(h.store);
      expect(m).toMatchObject({ read_by: "role-run-1" });
      expect(m!.read_at).not.toBeNull();
      expect((await openRoleRuns(h.store, "t", "architect")).map((r) => r.thread_id)).toEqual(["t3-1"]);
    },
  ],
  [
    "with 12 unread messages, the started run marks all 12 read (the brief shows 10)",
    async (h) => {
      const f = t3();
      for (let i = 1; i <= 11; i++) await sendRoleMessage(h.store, { team: "t", role: "architect", from: "owner", kind: "message", body: `m${i}` });
      const res = await h.run(["send", "t", "architect", "m12"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("with 12 messages in its start brief");
      expect(f.launches[0]!.message).toContain("+2 more");
      const all = await messages(h.store);
      expect(all).toHaveLength(12);
      expect(all.every((m) => m.read_by === "role-run-1")).toBe(true);
      expect(f.sends).toHaveLength(0);
    },
  ],
  [
    "with an open live run on this host, send queues one T3 message, launches nothing, and marks it read",
    async (h) => {
      const f = t3();
      expect((await h.run(["role", "start", "t", "architect"])).code).toBe(0);
      const res = await h.run(["send", "t", "architect", "second", "--from", "sentinel-t"]);
      expect(res.err).toBe("");
      expect(res.code).toBe(0);
      expect(res.out).toContain("t architect: message #1 stored; 1 message queued into run 1, thread t3-1, marked read by role-run-1");
      expect(f.launches).toHaveLength(1);
      expect(f.sends.map((s) => [s.threadId, s.mode, s.clientRequestId])).toEqual([["t3-1", "queue", "ob-role-msg-t3-1-1"]]);
      expect(f.sends[0]!.message).toBe("second\n\n(inbox #1 from sentinel-t, message; marked read by this run)");
      expect((await messages(h.store))[0]).toMatchObject({ read_by: "role-run-1" });
    },
  ],
  [
    "with a run open on another machine's T3, send sends nothing, starts nothing, leaves the message unread and names the host",
    async (h) => {
      const f = t3();
      expect((await withHost(OTHER_HOST, () => h.run(["role", "start", "t", "architect"]))).code).toBe(0);
      expect(f.launches).toHaveLength(1);
      const res = await h.run(["send", "t", "architect", "x"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain(`t architect: message #1 stored; run 1 is open on ${OTHER_HOST}; message stored`);
      expect(f.launches).toHaveLength(1);
      expect(f.sends).toHaveLength(0);
      expect((await messages(h.store))[0]).toMatchObject({ read_at: null, read_by: null });
      expect((await runs(h.store)).map((r) => r.id)).toEqual([1]);
    },
  ],
  [
    "--no-deliver stores the message and makes no T3 call",
    async (h) => {
      const f = t3();
      const res = await h.run(["send", "t", "architect", "x", "--no-deliver", "--json"]);
      expect(res.err).toBe("");
      expect(res.code).toBe(0);
      expect(JSON.parse(res.out)).toMatchObject({ id: 1, body: "x", read_at: null, delivery: null });
      expect(f.launches).toHaveLength(0);
      expect(f.sends).toHaveLength(0);
      expect(await runs(h.store)).toEqual([]);
    },
  ],
  [
    "a run started by send whose auto-settle T3 would not turn off warns and exits 1, as role start does",
    async (h) => {
      const f = t3();
      const seam = await t3Seam();
      const restore = __setT3Seam({ ...seam, disableAutoSettle: async () => { throw new Error("no"); } });
      let res: CliResult;
      try {
        res = await h.run(["send", "t", "architect", "x"]);
      } finally {
        restore();
      }
      expect(res.code).toBe(1);
      expect(res.out).toContain("run 1 opened");
      expect(res.err).toContain("auto-settle is still ON for team thread t3-1");
      expect(f.launches).toHaveLength(1);
      expect((await messages(h.store))[0]).toMatchObject({ read_by: "role-run-1" });
    },
  ],
  [
    "a delivery T3 refuses leaves the message stored and unread, and exits 1 naming it",
    async (h) => {
      // No fake installed: the test preload's seam has no credential, so the launch never reaches a T3.
      const res = await h.run(["send", "t", "architect", "x"]);
      expect(res.code).toBe(1);
      expect(res.out).toContain("t architect: message #1 stored");
      expect(res.err).toContain("send: message #1 is stored and unread, but was not delivered (");
      expect((await messages(h.store))[0]).toMatchObject({ read_at: null });
    },
  ],
];

describe("ob send delivers into the role's run, locally", () => {
  for (const [name, body] of CASES) test(name, async () => body(await local()));
});

describe("ob send delivers into the role's run, over the API", () => {
  for (const [name, body] of CASES) test(name, () => withApi(body), 60_000);
});

describe("two stores share one T3 (OS-212)", () => {
  test("message 1 of each store is two deliveries: the request id names the thread, so T3's global dedup keeps both", async () => {
    const f = t3();
    // T3 dedups a request id across every thread: a repeat is taken as delivered and dropped.
    const seen = new Set<string>();
    const delivered: string[] = [];
    const send = __setT3Seam({
      ...(await t3Seam()),
      send: async (input) => {
        f.sends.push(input);
        if (input.clientRequestId && seen.has(input.clientRequestId)) return;
        if (input.clientRequestId) seen.add(input.clientRequestId);
        delivered.push(`${input.threadId}:${input.message.split("\n")[0]}`);
      },
    });
    try {
      const a = await local();
      const b = await local();
      await bindSeat(a.store, f, "architect", "seat-a");
      await bindSeat(b.store, f, "architect", "seat-b");
      expect((await a.run(["send", "t", "architect", "from store a"])).code).toBe(0);
      expect((await b.run(["send", "t", "architect", "from store b"])).code).toBe(0);
      expect(f.sends.map((s) => s.clientRequestId)).toEqual(["ob-role-msg-seat-a-1", "ob-role-msg-seat-b-1"]);
      expect(delivered).toEqual(["seat-a:from store a", "seat-b:from store b"]);
    } finally {
      send();
    }
  });
});

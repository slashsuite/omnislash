// `ob role start|status|end`: one run per team role, on a fake T3 seam that records every launch, pin and settle.
// Every case runs twice: locally against a throwaway SQLite store through `runCli`, and over the API, where the CLI's
// own requests go through `createObApi` on a real Postgres store (a local cluster, no network, no live database).
import { afterEach, describe, expect, test } from "bun:test";
import { freshDbPath, runCli, type CliResult } from "../../../apps/cli/test/helpers.ts";
import { installFakeT3, type FakeT3Install } from "../../../apps/cli/test/fake-t3.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { run as runOb } from "../../../apps/cli/src/cli.ts";
import { __setT3Seam, storeAgentRegistry, t3Seam, worktreeRepoOf } from "../../../apps/cli/src/t3/dispatch.ts";
import { t3BaseUrl, T3_BASE_URL_ENV } from "../../../apps/cli/src/t3/client.ts";
import { checkoutOf } from "../../../apps/cli/src/commands/t3-team.ts";
import { teamHandoffTarget } from "../../../apps/cli/src/team.ts";
import { openRoleRuns, type RoleRun } from "../../../apps/cli/src/role-run.ts";
import { openStore, sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { leaseStatus } from "../../cli-coord/src/lease.ts";
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
  /** Two invocations at once, with their output captured together. */
  runTwo(a: string[], b: string[]): Promise<{ codes: number[]; out: string; err: string }>;
  store: Store;
}

/** A local harness: a fresh SQLite store with team `t`. */
async function local(): Promise<Harness> {
  const dbPath = freshDbPath();
  const db = openDb(dbPath, { create: true });
  const h: Harness = {
    run: (args) => runCli(dbPath, args),
    runTwo: (a, b) => together(dbPath, a, b, {}),
    store: sqliteStoreFor(db),
  };
  expect((await h.run(["t3", "team", "add", "t"])).code).toBe(0);
  return h;
}

const BASE = "https://ob.example.test";
const TOKEN = "test-token-do-not-log";

/** An API harness: the CLI's own requests through the real server on a real Postgres store, with team `t`. */
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
  const h: Harness = {
    run: (args) => runCli(freshDbPath(), args, deps),
    runTwo: (a, b) => together(freshDbPath(), a, b, deps),
    store,
  };
  try {
    expect((await h.run(["t3", "team", "add", "t"])).code).toBe(0);
    await fn(h);
  } finally {
    await store.close?.();
  }
}

/** Run two `ob` invocations concurrently in this process, capturing their combined output once (as runCli does for one). */
async function together(dbPath: string, a: string[], b: string[], deps: Parameters<typeof runOb>[1]): Promise<{ codes: number[]; out: string; err: string }> {
  const prevDb = process.env.OMNISLASH_DB;
  process.env.OMNISLASH_DB = dbPath;
  const origLog = console.log;
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  console.log = (...x: unknown[]) => {
    out += x.join(" ") + "\n";
  };
  (process.stderr.write as unknown) = (chunk: string) => {
    err += chunk;
    return true;
  };
  try {
    const codes = await Promise.all([runOb(a, deps), runOb(b, deps)]);
    return { codes, out, err };
  } finally {
    console.log = origLog;
    (process.stderr.write as unknown) = origErr;
    if (prevDb === undefined) delete process.env.OMNISLASH_DB;
    else process.env.OMNISLASH_DB = prevDb;
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

async function runs(store: Store): Promise<RoleRun[]> {
  const t = store.t.roleRun;
  return (await store.q.select().from(t).orderBy(t.id)) as RoleRun[];
}

async function leaseHolder(store: Store, resource: string): Promise<string | null> {
  return (await leaseStatus(store)).find((l) => l.resource === resource)?.holder ?? null;
}

const CASES: Array<[string, (h: Harness) => Promise<void>]> = [
  [
    "start twice launches once and prints the same thread id both times",
    async (h) => {
      const f = t3();
      const first = await h.run(["role", "start", "t", "architect", "-q"]);
      expect(first.code).toBe(0);
      const second = await h.run(["role", "start", "t", "architect", "-q"]);
      expect(second.code).toBe(0);
      expect(f.launches).toHaveLength(1);
      expect(second.out.trim()).toBe(first.out.trim());
      expect(first.out.trim()).toBe("t3-1");
      expect((await h.run(["role", "start", "t", "architect"])).out).toContain("run 1 is open, thread t3-1; nothing launched");
    },
  ],
  [
    "two starts at once launch once, and the second reports the first run",
    async (h) => {
      const f = t3();
      const both = await h.runTwo(["role", "start", "t", "architect"], ["role", "start", "t", "architect"]);
      expect(f.launches).toHaveLength(1);
      expect(both.codes).toContain(0);
      expect(both.out).toContain("run 1 opened, thread t3-1");
      // The other start either read the run after its thread was recorded (reused) or while it was launching (refused).
      const reported = both.out.includes("run 1 is open, thread t3-1") || both.err.includes("run 1 for t architect has no thread yet");
      expect(reported).toBe(true);
      expect((await openRoleRuns(h.store, "t", "architect")).map((r) => r.id)).toEqual([1]);
    },
  ],
  [
    "a settled thread ends the old run as gone, re-takes the lease and launches a new one",
    async (h) => {
      const f = t3();
      expect((await h.run(["role", "start", "t", "architect"])).code).toBe(0);
      expect(await leaseHolder(h.store, "role:t:architect")).toBe("role-run-1");
      f.threads.find((t) => t.threadId === "t3-1")!.settled = true;
      const again = await h.run(["role", "start", "t", "architect"]);
      expect(again.code).toBe(0);
      expect(again.out).toContain("run 1 ended (gone)");
      expect(again.out).toContain("run 2 opened, thread t3-2");
      expect(f.launches).toHaveLength(2);
      const [old, fresh] = await runs(h.store);
      expect(old).toMatchObject({ id: 1, end_reason: "gone", thread_id: "t3-1" });
      expect(old!.ended_at).not.toBeNull();
      expect(fresh).toMatchObject({ id: 2, end_reason: null, ended_at: null, thread_id: "t3-2" });
      expect(await leaseHolder(h.store, "role:t:architect")).toBe("role-run-2");
    },
  ],
  [
    "the launch names claude-opus-5-5, sends no options, opens at the root and pins the thread",
    async (h) => {
      const f = t3();
      expect((await h.run(["role", "start", "t", "sentinel"])).code).toBe(0);
      const launch = f.launches[0]!;
      expect(launch.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
      expect("options" in launch.modelSelection).toBe(false);
      expect(launch.workspaceStrategy).toEqual({ type: "root" });
      expect(launch.message!.startsWith("/ob-sentinel")).toBe(true);
      expect(f.pinned).toEqual(["t3-1"]);
      expect(f.autoSettleOff).toEqual(["t3-1"]);
    },
  ],
  [
    "a T3 project with no default model still opens on claude-opus-5-5",
    async (h) => {
      const f = t3();
      const seam = await t3Seam();
      const restore = __setT3Seam({ ...seam, projects: async () => (await seam.projects()).map((p) => ({ ...p, defaultModelSelection: null })) });
      try {
        expect((await h.run(["role", "start", "t", "architect"])).code).toBe(0);
      } finally {
        restore();
      }
      expect(f.launches[0]!.modelSelection).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
    },
  ],
  [
    "end sets ended_at, settles the thread and releases the lease",
    async (h) => {
      const f = t3();
      expect((await h.run(["role", "start", "t", "architect"])).code).toBe(0);
      expect((await h.run(["lease", "status"])).out).toContain("role:t:architect");
      const ended = await h.run(["role", "end", "t", "architect"]);
      expect(ended.code).toBe(0);
      expect(ended.out).toContain("run 1 ended (manual), thread t3-1 settled; lease role:t:architect released");
      const [r] = await runs(h.store);
      expect(r!.ended_at).not.toBeNull();
      expect(r!.end_reason).toBe("manual");
      expect(f.threads[0]!.settled).toBe(true);
      expect((await h.run(["lease", "status"])).out).not.toContain("role:t:architect");
      expect((await h.run(["role", "end", "t", "architect"])).err).toContain("t architect has no open run");
    },
  ],
  [
    "after start, a handoff for the team resolves to the run's thread",
    async (h) => {
      t3();
      expect((await h.run(["role", "start", "t", "architect"])).code).toBe(0);
      const registry = storeAgentRegistry(h.store);
      const route = await teamHandoffTarget({ ticket: "X-1", projectOf: async () => "p", teamOf: async () => "t", registry });
      expect(route.kind).toBe("team");
      if (route.kind !== "team") return;
      expect(route.target.agentId).toBe("architect-t");
      expect((await registry.read(route.target.agentId))?.session_id).toBe("t3-1");
    },
  ],
  [
    "a run opened on another machine's T3 makes status and end refuse by name and stays open",
    async (h) => {
      t3();
      expect((await withHost(OTHER_HOST, () => h.run(["role", "start", "t", "muse"]))).code).toBe(0);
      const refusal = `run 1 was opened on ${OTHER_HOST}; this machine's T3 is ${t3BaseUrl()}`;
      const status = await h.run(["role", "status", "t", "muse"]);
      expect(status.code).toBe(1);
      expect(status.err).toContain(refusal);
      const end = await h.run(["role", "end", "t", "muse"]);
      expect(end.code).toBe(1);
      expect(end.err).toContain(refusal);
      const start = await h.run(["role", "start", "t", "muse"]);
      expect(start.code).toBe(1);
      expect(start.err).toContain(refusal);
      expect((await openRoleRuns(h.store, "t", "muse")).map((r) => r.id)).toEqual([1]);
      expect(fake!.launches).toHaveLength(1);
    },
  ],
  [
    "status refreshes the item count and last activity from the thread header",
    async (h) => {
      const f = t3();
      expect((await h.run(["role", "start", "t", "architect"])).code).toBe(0);
      Object.assign(f.threads[0]!, { itemCount: 42, updatedAt: "2026-11-18T10:00:00.000Z", status: "idle" });
      const status = await h.run(["role", "status", "t", "--json"]);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.out)).toMatchObject({
        team: "t",
        runs: [{ thread: "idle", run: { id: 1, role: "architect", item_count: 42, last_activity_at: "2026-11-18T10:00:00.000Z", context_tokens: null } }],
      });
    },
  ],
  [
    "refuses an unknown team or role before T3 is asked anything",
    async (h) => {
      const f = t3();
      const team = await h.run(["role", "start", "nope", "architect"]);
      expect(team.code).toBe(1);
      expect(team.err).toContain("no team 'nope'");
      const role = await h.run(["role", "start", "t", "builder"]);
      expect(role.code).toBe(2);
      expect(role.err).toContain("<role> must be one of architect|sentinel|muse");
      expect((await h.run(["role", "end", "t", "architect", "--reason", "bored"])).code).toBe(2);
      expect(f.launches).toHaveLength(0);
    },
  ],
];

describe("ob role, local", () => {
  for (const [name, body] of CASES) test(name, async () => body(await local()));
});

describe("ob role, over the API", () => {
  for (const [name, body] of CASES) test(name, () => withApi(body));
});

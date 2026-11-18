// `ob send <team> <role>` and `ob inbox <team> <role>`: a team role's inbox, kept on the server.
// Every case runs twice: locally against a throwaway SQLite store through `runCli`, and over the API, where the CLI's
// own requests go through `createObApi` on a real Postgres store (a local cluster, no network, no live database).
import { afterEach, describe, expect, test } from "bun:test";
import { freshDbPath, runCli, type CliResult } from "../../../apps/cli/test/helpers.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { __setT3Seam, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { sendRoleMessage, type RoleMessage } from "../../../apps/cli/src/inbox.ts";
import { openStore, sqliteStoreFor, type Store } from "../../../apps/cli/src/db/store.ts";
import { registerAgent } from "../../cli-coord/src/agent.ts";
import { leaseRealPgDb } from "../../../apps/cli/test/pg/real-schema.ts";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

interface Harness {
  run(args: string[]): Promise<CliResult>;
  store: Store;
}

/** Team `t`, with a sentinel thread bound (`sentinel-t`) and no muse. */
async function seedTeam(h: Harness): Promise<void> {
  expect((await h.run(["t3", "team", "add", "t"])).code).toBe(0);
  await registerAgent(h.store, { id: "sentinel-t", worktree: "/r", status: "planning", launcher: "t3", sessionId: "sentinel-thread", ttlS: 900 });
}

async function local(): Promise<Harness> {
  const dbPath = freshDbPath();
  const db = openDb(dbPath, { create: true });
  const h: Harness = { run: (args) => runCli(dbPath, args), store: sqliteStoreFor(db) };
  await seedTeam(h);
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
    await seedTeam(h);
    await fn(h);
  } finally {
    await store.close?.();
  }
}

async function rows(store: Store): Promise<RoleMessage[]> {
  const t = store.t.roleMessage;
  return (await store.q.select().from(t).orderBy(t.id)) as RoleMessage[];
}

async function inbox(h: Harness, args: string[] = []): Promise<RoleMessage[]> {
  const res = await h.run(["inbox", "t", "sentinel", "--json", ...args]);
  expect(res.err).toBe("");
  expect(res.code).toBe(0);
  return JSON.parse(res.out) as RoleMessage[];
}

/** A fake T3 that answers the close path's queue read with nothing held. */
function quietT3(): void {
  const seam = {
    queue: async () => ({ items: [], complete: true }),
    send: async () => {},
    settle: async () => {},
    wait: async () => ({ runId: null, status: "idle", timedOut: false }),
  } as unknown as T3Seam;
  restores.push(__setT3Seam(seam));
}

const CASES: Array<[string, (h: Harness) => Promise<void>]> = [
  [
    "send then inbox lists one unread message",
    async (h) => {
      const sent = await h.run(["send", "t", "sentinel", "x", "-q"]);
      expect(sent.code).toBe(0);
      const listed = await inbox(h);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: Number(sent.out.trim()), team: "t", role: "sentinel", kind: "message", body: "x", from_actor: "owner", read_at: null });
    },
  ],
  [
    "send to a role that is not bound (and is not the architect) is refused by name and stores nothing",
    async (h) => {
      const res = await h.run(["send", "t", "muse", "x"]);
      expect(res.code).not.toBe(0);
      expect(res.err).toContain("team 't' has no muse bound");
      expect(await rows(h.store)).toHaveLength(0);
      // The architect always receives, bound or not.
      expect((await h.run(["send", "t", "architect", "hello", "--from", "sentinel-t"])).code).toBe(0);
      expect((await rows(h.store)).map((m) => [m.role, m.from_actor])).toEqual([["architect", "sentinel-t"]]);
    },
  ],
  [
    "--read hides a message from the unread list, --all still shows it, and read_by is the reader",
    async (h) => {
      const id = (await h.run(["send", "t", "sentinel", "x", "-q"])).out.trim();
      const other = (await h.run(["send", "t", "sentinel", "y", "-q"])).out.trim();
      const read = await h.run(["inbox", "t", "sentinel", "--read", id, "--by", "r1"]);
      expect(read.code).toBe(0);
      expect((await inbox(h)).map((m) => String(m.id))).toEqual([other]);
      const all = await inbox(h, ["--all"]);
      expect(all.map((m) => String(m.id))).toEqual([id, other]);
      expect(all[0]).toMatchObject({ read_by: "r1" });
      expect(all[0]!.read_at).not.toBeNull();
      // An id that is not in this inbox marks nothing.
      const bad = await h.run(["inbox", "t", "sentinel", "--read", other, "999", "--by", "r2"]);
      expect(bad.code).not.toBe(0);
      expect(bad.err).toContain("no message 999");
      expect((await inbox(h)).map((m) => String(m.id))).toEqual([other]);
    },
  ],
  [
    "close withdraws the ticket's unread handoff, so inbox no longer lists it",
    async (h) => {
      quietT3();
      expect((await h.run(["project", "add", "p", "--kind", "side"])).code).toBe(0);
      const added = await h.run(["add", "a ticket", "--project", "p", "-q"]);
      expect(added.err).toBe("");
      expect(added.code).toBe(0);
      const ref = added.out.trim();
      await sendRoleMessage(h.store, { team: "t", role: "sentinel", from: "b1", kind: "handoff", ref, body: "ready", clientKey: "k1" });
      await sendRoleMessage(h.store, { team: "t", role: "sentinel", from: "b2", kind: "handoff", ref: "OTHER-1", body: "ready", clientKey: "k2" });
      expect(await inbox(h)).toHaveLength(2);
      const closed = await h.run(["close", ref]);
      expect(closed.code).toBe(0);
      expect((await inbox(h)).map((m) => m.ref)).toEqual(["OTHER-1"]);
      const withdrawn = (await rows(h.store)).find((m) => m.ref === ref)!;
      expect(withdrawn.withdrawn_at).not.toBeNull();
    },
  ],
];

describe("a team role's inbox, locally", () => {
  for (const [name, body] of CASES) test(name, async () => body(await local()));
});

describe("a team role's inbox, over the API", () => {
  for (const [name, body] of CASES) test(name, () => withApi(body), 60_000);
});

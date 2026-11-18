// OB-2192: a read from the first item of a long architect thread times out under load, so every ob caller that
// wants only the thread header reads from past the end. The plain `read` keeps its from-the-start default,
// which the probes, `activity()` and the token measurement rely on. Fake fetch and fake seam; no live T3.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDb } from "../../../apps/cli/test/helpers.ts";
import { PAST_THE_END, T3Client, T3Error, type FetchLike, type T3Thread } from "../../../apps/cli/src/t3/client.ts";
import { T3_LAUNCHER, ensureTeamThread, readThreadHeader, storeAgentRegistry, type T3Seam } from "../../../apps/cli/src/t3/dispatch.ts";
import { registerAgent } from "../src/agent.ts";

const BASE = "https://t3.example.test";
const CREDENTIAL = {
  version: 1 as const,
  baseUrl: BASE,
  accessToken: "t",
  tokenType: "Bearer",
  access: "full-access",
  scopes: [],
  issuedAt: "2026-10-18T00:00:00.000Z",
  expiresAt: "2027-10-18T00:00:00.000Z",
};

function thread(id: string, over: Partial<T3Thread> = {}): T3Thread {
  return {
    threadId: id,
    projectId: "p",
    title: "x · architect",
    status: "idle",
    worktreePath: null,
    branch: null,
    settled: false,
    archived: false,
    model: "claude-opus-5-5",
    providerInstanceId: "claudeAgent",
    activeRunId: null,
    latestRunId: null,
    itemCount: 6800,
    ...over,
  };
}

/** A fake T3 MCP endpoint that records every `t3_thread_read`'s arguments. */
function fakeClient() {
  const reads: Array<Record<string, unknown>> = [];
  const fetchImpl: FetchLike = async (_input, init) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}")) as {
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const json = (payload: unknown, headers: Record<string, string> = {}): Response =>
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (body.method === "initialize") return json({ jsonrpc: "2.0", id: 1, result: { serverInfo: { version: "0.1.0" } } }, { "mcp-session-id": "s-1" });
    if (body.method === "notifications/initialized") return json({});
    if (body.method === "tools/call" && body.params?.name === "t3_thread_read") {
      reads.push(body.params.arguments ?? {});
      return json({ jsonrpc: "2.0", id: 2, result: { structuredContent: { thread: thread("t-1"), recentRuns: [], items: [], nextPosition: 0, hasMore: false } } });
    }
    throw new Error(`unexpected MCP request: ${body.method} ${body.params?.name}`);
  };
  return { client: new T3Client({ baseUrl: BASE, credential: CREDENTIAL, fetchImpl }), reads };
}

/**
 * A seam over one long thread: a read with no position (from the first item) fails as the real one times out,
 * a read from past the end answers. `reads` records each call's options.
 */
function longThreadSeam(threads: Map<string, T3Thread>) {
  const reads: Array<{ afterPosition?: number; limit?: number } | undefined> = [];
  const seam = {
    read: async (id: string, opts?: { afterPosition?: number; limit?: number }) => {
      reads.push(opts);
      if (opts?.afterPosition === undefined) throw new T3Error("unreachable", "t3_thread_read: timed out");
      const t = threads.get(id);
      if (!t) throw new T3Error("refused", `thread ${id} not found`);
      return { thread: t, recentRuns: [], items: [], nextPosition: t.itemCount ?? 0, hasMore: false };
    },
    pin: async () => {},
    unpin: async () => {},
    rename: async () => {},
    disableAutoSettle: async () => {},
  } as unknown as T3Seam;
  return { seam, reads };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-2192-"));
  mkdirSync(join(dir, ".git"));
  dirs.push(dir);
  return dir;
}

describe("header-only T3 reads (OB-2192)", () => {
  test("T3Client.readHeader reads from past the end, one item", async () => {
    const { client, reads } = fakeClient();
    const t = await client.readHeader("t-1");
    expect(t.threadId).toBe("t-1");
    expect(reads).toEqual([{ threadId: "t-1", afterPosition: PAST_THE_END, limit: 1, runLimit: 5 }]);
  });

  test("a plain T3Client.read with no position still sends none: the default is unchanged", async () => {
    const { client, reads } = fakeClient();
    await client.read("t-1", { limit: 500 });
    expect(reads).toEqual([{ threadId: "t-1", limit: 500 }]);
    expect("afterPosition" in reads[0]!).toBe(false);
  });

  test("readThreadHeader asks the seam for past the end, one item", async () => {
    const { seam, reads } = longThreadSeam(new Map([["t-1", thread("t-1")]]));
    expect((await readThreadHeader(seam, "t-1")).threadId).toBe("t-1");
    expect(reads).toEqual([{ afterPosition: PAST_THE_END, limit: 1 }]);
  });

  test("ob t3 architect on a recorded long architect thread reads only its header", async () => {
    const db = freshDb();
    const repo = checkout();
    const team = { name: "acme", icon: null, display_name: null };
    const { seam, reads } = longThreadSeam(new Map([["plan-1", thread("plan-1", { title: "acme · architect" })]]));
    await registerAgent(db, { id: "architect-acme", worktree: repo, status: "planning", launcher: T3_LAUNCHER, sessionId: "plan-1", ttlS: 900 });
    const out = await ensureTeamThread(storeAgentRegistry(db), { team, role: "architect", members: ["acme"], repoPath: repo, seam });
    expect(out.created).toBe(false);
    expect(out.threadId).toBe("plan-1");
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r?.afterPosition).toBe(PAST_THE_END);
  });

  test("adopting a long thread as the architect reads only its header", async () => {
    const db = freshDb();
    const repo = checkout();
    const team = { name: "acme", icon: null, display_name: null };
    const { seam, reads } = longThreadSeam(new Map([["plan-2", thread("plan-2")]]));
    const out = await ensureTeamThread(storeAgentRegistry(db), { team, role: "architect", members: ["acme"], repoPath: repo, adoptThreadId: "plan-2", seam });
    expect(out.threadId).toBe("plan-2");
    for (const r of reads) expect(r?.afterPosition).toBe(PAST_THE_END);
  });

});

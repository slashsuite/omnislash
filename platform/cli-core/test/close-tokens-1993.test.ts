// OB-1993: lands record no tokens. Over the API, `ob close` is served by the host, which has no builder transcripts,
// so every land recorded `- tok`. The client now reads each landable row's tokens on its own machine and sends them
// with the close; the host records them. And a landed row with no count can be backfilled through a token-only write.
//
// Hermetic: the API is the real server over a temp sqlite store, called in-process as the client's transport. The
// transcripts are fixtures under a temp projects dir. No network, no live DB.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createObApi } from "../../../apps/cli/src/api/server.ts";
import type { ApiTransport } from "../../../apps/cli/src/api/client.ts";
import { openDb } from "../../../apps/cli/src/db.ts";
import { asStore, type Store } from "../../../apps/cli/src/db/store.ts";
import { orm } from "../../../apps/cli/src/db/orm.ts";
import { spinoff } from "../../../apps/cli/src/db/schema.ts";
import { createItem } from "../../../apps/cli/src/items.ts";
import { closeAndLand } from "../../../apps/cli/src/close.ts";
import { freshDbPath, runCli } from "../../../apps/cli/test/helpers.ts";
import {
  enqueueSpinoff,
  getSpinoffRow,
  recordSpinoffTokens,
} from "../../cli-coord/src/commands/spinoff.ts";
import { CLAUDE_PROJECTS_DIR_ENV, encodeCwd, type TokenUsage } from "../../cli-coord/src/spinoff-tokens.ts";

const BASE = "https://ob.example.test";
const TOKEN = "a-test-bearer-token-that-is-long-enough";

let dir: string;
let clientHome: string;
let serverHome: string;
let prevDir: string | undefined;
const projectsOf = (home: string) => join(home, ".claude", "projects");
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ob-1993-"));
  clientHome = join(dir, "client-home");
  serverHome = join(dir, "server-home");
  mkdirSync(clientHome, { recursive: true });
  mkdirSync(serverHome, { recursive: true });
  prevDir = process.env[CLAUDE_PROJECTS_DIR_ENV];
  process.env[CLAUDE_PROJECTS_DIR_ENV] = projectsOf(clientHome); // the client's reads see the fixture transcripts
});
afterEach(() => {
  if (prevDir === undefined) delete process.env[CLAUDE_PROJECTS_DIR_ENV];
  else process.env[CLAUDE_PROJECTS_DIR_ENV] = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

/** A Claude Code transcript for `worktree` under `home`, carrying one assistant usage block. */
function transcript(home: string, worktree: string, u: { input: number; output: number; create: number; read: number }): void {
  const projectDir = join(home, ".claude", "projects", encodeCwd(worktree));
  mkdirSync(projectDir, { recursive: true });
  const usage = { input_tokens: u.input, output_tokens: u.output, cache_creation_input_tokens: u.create, cache_read_input_tokens: u.read };
  writeFileSync(join(projectDir, "s1.jsonl"), JSON.stringify({ type: "assistant", message: { role: "assistant", usage } }) + "\n");
}

const usage = (total: number): TokenUsage => ({ inputTokens: total, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalTokens: total });

async function seed(status: "launched" | "ready-for-gate" | "merged" = "launched") {
  const db = openDb(freshDbPath());
  const store = asStore(db);
  const id = await createItem(db, { type: "task", title: "ship it" });
  const worktree = join(dir, `acme.ob-${id}`);
  const { row } = await enqueueSpinoff(db, { ticketRef: id, repo: "/r/acme", branch: `ob-${id}`, mode: "interactive", brief: "b", worktree });
  orm(db).update(spinoff).set({ status, agent_id: `ob-${id}`, worktree }).where(eq(spinoff.id, row.id)).run();
  return { db, store, id, rowId: row.id, worktree };
}

/**
 * The real API over `store`, as the client's transport. The server half reads an EMPTY projects dir,
 * the API host's view: it has none of this machine's transcripts.
 */
function serverTransport(store: Store): { transport: ApiTransport; bodies: Record<string, unknown>[] } {
  const app = createObApi({
    store: async () => store,
    token: () => ({ token: TOKEN, path: "/nowhere/.ob_api_token", reason: null, message: null }),
  });
  const bodies: Record<string, unknown>[] = [];
  const transport: ApiTransport = async (req) => {
    const path = req.url.slice(BASE.length);
    if (req.body) bodies.push({ path, ...(JSON.parse(req.body) as Record<string, unknown>) });
    const clientDir = process.env[CLAUDE_PROJECTS_DIR_ENV];
    process.env[CLAUDE_PROJECTS_DIR_ENV] = projectsOf(serverHome);
    try {
      const res = await app(
        new Request(`http://api-host.local${path}`, {
          method: req.method,
          headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
          body: req.body,
        }),
      );
      return { status: res.status, body: await res.text() };
    } finally {
      process.env[CLAUDE_PROJECTS_DIR_ENV] = clientDir;
    }
  };
  return { transport, bodies };
}

const apiDeps = (transport: ApiTransport) => ({ api: { base: BASE, token: TOKEN, transport } });

describe("ob close over the API records the tokens the client read (OB-1993)", () => {
  test("a handed-off row lands with the client's transcript count; the server's own (zero) read is not used", async () => {
    const { store, id, rowId, worktree } = await seed("ready-for-gate");
    transcript(clientHome, worktree, { input: 100, output: 20, create: 3, read: 1000 });
    const { transport, bodies } = serverTransport(store);
    const r = await runCli(freshDbPath(), ["close", id, "--no-github"], apiDeps(transport));
    expect(r.code).toBe(0);
    const close = bodies.find((b) => String(b.path).endsWith(`/items/${id}/close`))!;
    expect((close.tokensById as Record<string, TokenUsage>)[String(rowId)]!.totalTokens).toBe(1123);
    const row = (await getSpinoffRow(store, rowId))!;
    expect(row.status).toBe("merged");
    expect(row.total_tokens).toBe(1123);
    expect(row.input_tokens).toBe(100);
    expect(row.cache_read_tokens).toBe(1000);
  });

  test("an older host without the serving route still closes, and the land reads as before", async () => {
    const { store, id, rowId } = await seed("launched");
    const { transport } = serverTransport(store);
    const older: ApiTransport = async (req) =>
      req.url.includes("/spinoffs/serving")
        ? { status: 404, body: JSON.stringify({ error: { code: "unknown_endpoint", message: "no route" } }) }
        : transport(req);
    const r = await runCli(freshDbPath(), ["close", id, "--no-github"], apiDeps(older));
    expect(r.code).toBe(0);
    expect((await getSpinoffRow(store, rowId))!.status).toBe("merged");
  });
});

describe("local close and the land (OB-1993)", () => {
  test("local mode lands with the tokens read where it runs, exactly as before", async () => {
    const { store, id, rowId, worktree } = await seed("launched");
    transcript(clientHome, worktree, { input: 5, output: 6, create: 7, read: 8 });
    await closeAndLand(store, id);
    const row = (await getSpinoffRow(store, rowId))!;
    expect(row.status).toBe("merged");
    expect(row.total_tokens).toBe(26);
  });

  test("a zero read does not overwrite a row that already has tokens", async () => {
    const { db, store, id, rowId } = await seed("launched");
    orm(db).update(spinoff).set({ total_tokens: 4242, input_tokens: 4242 }).where(eq(spinoff.id, rowId)).run();
    await closeAndLand(store, id, {}, { [rowId]: usage(0) });
    const row = (await getSpinoffRow(store, rowId))!;
    expect(row.status).toBe("merged");
    expect(row.total_tokens).toBe(4242);
    expect(row.input_tokens).toBe(4242);
  });
});

describe("recordSpinoffTokens (OB-1993)", () => {
  test("writes tokens onto a landed row with none, and leaves its status alone", async () => {
    const { store, rowId } = await seed("merged");
    const row = await recordSpinoffTokens(store, rowId, usage(82_647_943));
    expect(row.total_tokens).toBe(82_647_943);
    expect(row.status).toBe("merged");
  });

  test("refuses a row that already has tokens, and keeps its count", async () => {
    const { db, store, rowId } = await seed("merged");
    orm(db).update(spinoff).set({ total_tokens: 10 }).where(eq(spinoff.id, rowId)).run();
    await expect(recordSpinoffTokens(store, rowId, usage(99))).rejects.toThrow("already records 10 tokens");
    expect((await getSpinoffRow(store, rowId))!.total_tokens).toBe(10);
  });

  test("refuses a row that has not landed, and never moves it", async () => {
    const { store, rowId } = await seed("ready-for-gate");
    await expect(recordSpinoffTokens(store, rowId, usage(99))).rejects.toThrow("not landed");
    const row = (await getSpinoffRow(store, rowId))!;
    expect(row.status).toBe("ready-for-gate");
    expect(row.total_tokens ?? 0).toBe(0);
  });
});

describe("ob spinoff tokens backfill (OB-1993)", () => {
  async function twoLanded() {
    const a = await seed("merged");
    // A second landed row in the same store, with no transcript anywhere: not recoverable.
    const otherWt = join(dir, "acme.gone");
    const { row } = await enqueueSpinoff(a.db, { ticketRef: "OB-7", repo: "/r/acme", branch: "ob-7", mode: "interactive", brief: "b", worktree: otherWt });
    orm(a.db).update(spinoff).set({ status: "merged", worktree: otherWt }).where(eq(spinoff.id, row.id)).run();
    transcript(clientHome, a.worktree, { input: 1, output: 2, create: 3, read: 4 });
    return { ...a, goneId: row.id };
  }

  test("--dry-run lists what it would record and what is not recoverable, and writes nothing", async () => {
    const { store, rowId, goneId } = await twoLanded();
    const { transport, bodies } = serverTransport(store);
    const r = await runCli(freshDbPath(), ["spinoff", "tokens", "backfill", "--dry-run"], apiDeps(transport));
    expect(r.code).toBe(0);
    expect(r.out).toContain(`#${rowId}`);
    expect(r.out).toContain("would record");
    expect(r.out).toContain(`#${goneId}`);
    expect(r.out).toContain("not recoverable");
    expect(bodies.some((b) => String(b.path).endsWith("/spinoffs/tokens"))).toBe(false);
    expect((await getSpinoffRow(store, rowId))!.total_tokens ?? 0).toBe(0);
  });

  test("without --dry-run it records the readable rows through the server, and names the rest", async () => {
    const { store, rowId, goneId } = await twoLanded();
    const { transport } = serverTransport(store);
    const r = await runCli(freshDbPath(), ["spinoff", "tokens", "backfill"], apiDeps(transport));
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 recorded");
    expect(r.out).toContain("1 not recoverable");
    expect((await getSpinoffRow(store, rowId))!.total_tokens).toBe(10);
    expect((await getSpinoffRow(store, goneId))!.total_tokens ?? 0).toBe(0);
  });

  test("a local `ob spinoff tokens backfill` runs against the local store", async () => {
    const path = freshDbPath();
    const db = openDb(path);
    const id = await createItem(db, { type: "task", title: "t" });
    const worktree = join(dir, "acme.local");
    const { row } = await enqueueSpinoff(db, { ticketRef: id, repo: "/r/acme", branch: `ob-${id}`, mode: "interactive", brief: "b", worktree });
    orm(db).update(spinoff).set({ status: "merged", worktree }).where(eq(spinoff.id, row.id)).run();
    transcript(clientHome, worktree, { input: 2, output: 2, create: 2, read: 2 });
    const r = await runCli(path, ["spinoff", "tokens", "backfill"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 recorded");
    expect((await getSpinoffRow(asStore(openDb(path)), row.id))!.total_tokens).toBe(8);
  });
});
